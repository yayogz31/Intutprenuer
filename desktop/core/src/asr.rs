//! Envoltura de whisper.cpp: carga en GPU (Vulkan) o CPU, detección de idioma EN/ES y transcripción
//! con confianza por palabra.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

pub const SR: usize = 16_000;

static LOG_HOOK: Once = Once::new();

/// Silencia los mensajes de whisper.cpp (no se escriben logs a ningún lado).
pub fn quiet() {
    LOG_HOOK.call_once(whisper_rs::install_logging_hooks);
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Word {
    pub word: String,
    pub conf: f32,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Transcript {
    pub text: String,
    /// Confianza media de los tokens de texto (0–1).
    pub conf: f32,
    pub words: Vec<Word>,
    /// Probabilidad de "no hay voz" del primer segmento.
    pub no_speech: f32,
}

/// Información de la GPU (para el diagnóstico y la elección de modelo).
#[derive(Debug, Clone, serde::Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub vram_total_mb: u64,
    pub vram_free_mb: u64,
}

/// GPUs que whisper.cpp puede usar. Se consulta el registro de dispositivos de ggml (que atrapa los
/// errores de Vulkan): en un equipo sin driver de video simplemente no hay GPU y se usa el procesador.
/// (No se usa `whisper_rs::vulkan::list_devices`: llama a Vulkan sin protección y cierra la app si no hay driver.)
pub fn gpus() -> Vec<GpuInfo> {
    use whisper_rs::whisper_rs_sys as sys;
    let mut out = Vec::new();
    unsafe {
        let n = sys::ggml_backend_dev_count();
        for i in 0..n {
            let dev = sys::ggml_backend_dev_get(i);
            if dev.is_null() {
                continue;
            }
            let t = sys::ggml_backend_dev_type(dev);
            if t != sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU && t != sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU {
                continue;
            }
            let d = sys::ggml_backend_dev_description(dev);
            let name = if d.is_null() { "GPU".to_string() } else { std::ffi::CStr::from_ptr(d).to_string_lossy().into_owned() };
            let (mut free, mut total) = (0usize, 0usize);
            sys::ggml_backend_dev_memory(dev, &mut free, &mut total);
            out.push((t, GpuInfo { name, vram_total_mb: (total / 1_048_576) as u64, vram_free_mb: (free / 1_048_576) as u64 }));
        }
    }
    // tarjetas dedicadas primero
    out.sort_by_key(|(t, _)| if *t == sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU { 0 } else { 1 });
    out.into_iter().map(|(_, g)| g).collect()
}

/// Memoria de GPU libre del dispositivo 0 (para medir cuánta VRAM usa el modelo).
pub fn gpu_free_mb() -> Option<u64> {
    gpus().first().map(|g| g.vram_free_mb)
}

unsafe extern "C" fn abort_trampoline(user: *mut std::ffi::c_void) -> bool {
    // `user` apunta al AtomicBool de un Arc que sigue vivo mientras dura `full()`
    (*(user as *const AtomicBool)).load(Ordering::Relaxed)
}

pub struct Model {
    // el estado guarda un puntero al contexto: se declara primero para liberarse antes
    state: WhisperState,
    #[allow(dead_code)]
    ctx: WhisperContext,
    pub gpu: bool,
    pub threads: usize,
    pub name: String,
}

pub struct Options<'a> {
    pub lang: &'a str,
    pub prompt: &'a str,
    /// Recorta el codificador al largo del audio (mucho más rápido; para el texto inmediato).
    pub short_ctx: bool,
    pub beam: bool,
    pub abort: Option<Arc<AtomicBool>>,
}

impl Model {
    pub fn load(path: &std::path::Path, gpu: bool, threads: usize, name: &str) -> Result<Model, String> {
        quiet();
        let mut cp = WhisperContextParameters::default();
        cp.use_gpu(gpu);
        cp.flash_attn(true); // menos memoria (VRAM en la GPU, RAM en el procesador)
        let p = path.to_str().ok_or("invalid model path")?;
        let ctx = WhisperContext::new_with_params(p, cp).map_err(|e| format!("could not load the model: {e:?}"))?;
        let state = ctx.create_state().map_err(|e| format!("could not start the model: {e:?}"))?;
        Ok(Model { state, ctx, gpu, threads: threads.max(1), name: name.to_string() })
    }

    /// Diferencia de log-probabilidad inglés − español (positivo = inglés).
    pub fn detect_en_es(&mut self, audio: &[f32]) -> Result<f32, String> {
        self.state.pcm_to_mel(audio, self.threads).map_err(|e| format!("{e:?}"))?;
        let (_, probs) = self.state.lang_detect(0, self.threads).map_err(|e| format!("{e:?}"))?;
        let en = whisper_rs::get_lang_id("en").unwrap_or(0) as usize;
        let es = whisper_rs::get_lang_id("es").unwrap_or(2) as usize;
        let (pe, ps) = (probs.get(en).copied().unwrap_or(0.0), probs.get(es).copied().unwrap_or(0.0));
        Ok(pe.max(1e-9).ln() - ps.max(1e-9).ln())
    }

    pub fn transcribe(&mut self, audio: &[f32], o: &Options) -> Result<Transcript, String> {
        if audio.len() < SR / 4 {
            return Ok(Transcript::default());
        }
        // Whisper funciona mejor con al menos ~1 s: se rellena con silencio
        let mut padded;
        let mut data = audio;
        if audio.len() < SR {
            padded = audio.to_vec();
            padded.resize(SR + SR / 10, 0.0);
            data = &padded;
        }
        // máximo 30 s (ventana de Whisper)
        if data.len() > SR * 30 {
            padded = data[data.len() - SR * 30..].to_vec();
            data = &padded;
        }
        let strategy = if o.beam { SamplingStrategy::BeamSearch { beam_size: 3, patience: -1.0 } } else { SamplingStrategy::Greedy { best_of: 1 } };
        let mut p = FullParams::new(strategy);
        p.set_n_threads(self.threads as i32);
        p.set_language(Some(o.lang));
        p.set_translate(false);
        p.set_no_context(true);
        p.set_no_timestamps(true);
        p.set_single_segment(false);
        p.set_print_special(false);
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_print_timestamps(false);
        p.set_suppress_blank(true);
        p.set_suppress_nst(true);
        p.set_temperature(0.0);
        p.set_temperature_inc(0.2);
        // tokens máximos según la duración (evita bucles largos inventados)
        let secs = data.len() as f32 / SR as f32;
        p.set_max_tokens(((secs * 8.0) as i32 + 16).min(220));
        if o.short_ctx {
            // el codificador procesa ~50 posiciones por segundo de audio
            let ctx = ((secs * 50.0) as i32 + 128).min(1500);
            p.set_audio_ctx(ctx);
        }
        if !o.prompt.is_empty() {
            p.set_initial_prompt(o.prompt);
        }
        // cancelación (End / Free GPU). No se usa `set_abort_callback_safe` de whisper-rs 0.16:
        // su trampolín interpreta mal el puntero y cancela al azar (error -6 "failed to encode").
        let abort_ptr = o.abort.as_ref().map(|a| Arc::as_ptr(a) as *mut std::ffi::c_void);
        if let Some(ptr) = abort_ptr {
            unsafe {
                p.set_abort_callback(Some(abort_trampoline));
                p.set_abort_callback_user_data(ptr);
            }
        }
        self.state.full(p, data).map_err(|e| format!("{e:?}"))?;
        let eot = self.ctx.token_eot();
        let mut text = String::new();
        let mut words: Vec<Word> = Vec::new();
        let (mut psum, mut pn) = (0.0f32, 0usize);
        let mut no_speech = 0.0;
        let n = self.state.full_n_segments();
        for i in 0..n {
            let Some(seg) = self.state.get_segment(i) else { continue };
            if i == 0 {
                no_speech = seg.no_speech_probability();
            }
            text.push_str(&seg.to_str_lossy().map(|s| s.into_owned()).unwrap_or_default());
            for j in 0..seg.n_tokens() {
                let Some(tok) = seg.get_token(j) else { continue };
                if tok.token_id() >= eot {
                    continue; // tokens especiales
                }
                let s = tok.to_str_lossy().map(|s| s.into_owned()).unwrap_or_default();
                let pr = tok.token_probability();
                psum += pr;
                pn += 1;
                if s.starts_with(' ') || words.is_empty() {
                    let w = s.trim();
                    if !w.is_empty() {
                        words.push(Word { word: w.to_string(), conf: pr });
                    }
                } else if let Some(last) = words.last_mut() {
                    last.word.push_str(&s);
                    last.conf = last.conf.min(pr);
                }
            }
        }
        Ok(Transcript { text: text.trim().to_string(), conf: if pn > 0 { psum / pn as f32 } else { 0.0 }, words, no_speech })
    }
}
