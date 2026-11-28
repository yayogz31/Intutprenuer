//! Motor de la llamada.
//!
//! Flujo: audio (20 ms) → detector de voz → frase en curso.
//!  * Mientras se habla, el modelo rápido (CPU) transcribe la frase cada ~0.5 s → `partial`.
//!  * Al cerrar la frase, el modelo rápido da el texto final al instante → `final`.
//!  * Después el modelo preciso (GPU, o CPU si no hay) la vuelve a transcribir con contexto → `refined`.
//!  * Frases separadas por pausas cortas comparten `group`: la interfaz las une en la misma fila.
//!
//! Privacidad: el texto y el audio viven solo en memoria. `end()` los borra y descarga los modelos.
//! El diagnóstico nunca incluye texto de la llamada.

use crate::asr::{self, Model, Options, Word, SR};
use crate::audio::{self, Capture, Source, BLOCK};
use crate::models::{self, ModelId};
use crate::text;
use crate::vad::{Vad, VadEvent};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LangMode {
    Auto,
    En,
    Es,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct StartOptions {
    pub source: Source,
    pub lang: LangMode,
    #[serde(default)]
    pub light: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    State { state: &'static str },
    Partial { seg: u64, lang: &'static str, text: String },
    Final { seg: u64, group: u64, lang: &'static str, text: String, conf: f32, words: Vec<Word>, margin: f32, lat_ms: u64 },
    Refined { seg: u64, lang: &'static str, text: String, margin: f32, ms: u64, lat_ms: u64, model: String, forced: bool, skipped: bool, group_segs: Vec<u64> },
    Engine { fast: String, accurate: String, gpu: Option<String>, vram_mb: Option<u64> },
    Progress { label: String, pct: u32, done_mb: u64, total_mb: u64 },
    Notice { level: &'static str, code: String, message: String },
    Ended,
}

pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;

fn lang_str(en: bool) -> &'static str {
    if en {
        "en"
    } else {
        "es"
    }
}

// ───────────── Parámetros ─────────────
const PRE_ROLL: usize = SR * 3 / 10; // 300 ms antes del inicio de la voz
const PARTIAL_EVERY: usize = SR / 2; // texto inmediato cada 0.5 s de audio nuevo
const MAX_PHRASE: usize = SR * 12; // una frase de más de 12 s se corta en la pausa más baja
const JOIN_GAP: u64 = (SR as u64 * 16) / 10; // pausas < 1.6 s: misma fila
const HISTORY: usize = 30; // audio de las últimas 30 frases (para corregir idioma)
const PAUSE_UNLOAD: Duration = Duration::from_secs(180); // en Pausa, libera la GPU tras 3 min

// ───────────── Estado compartido ─────────────
struct Pipeline {
    vad: Vad,
    pre: VecDeque<f32>,
    cur: Vec<f32>,
    cur_start: u64,
    clock: u64,
    since_partial: usize,
    seg: u64,
    group: u64,
    group_parts: u32,
    group_len: usize,
    group_segs: Vec<u64>,
    last_end: u64,
    last_question: bool,
    last_text: String,
    last_lang_en: Option<bool>,
    mode: LangMode,
    /// Último idioma decidido (pegajoso en modo Auto).
    sticky_en: bool,
    /// Idioma estimado de la frase en curso (para el texto inmediato).
    guess_en: Option<bool>,
    /// Duración del audio con que se estimó `guess_en`.
    guess_secs: f32,
    history: VecDeque<(u64, Arc<Vec<f32>>)>,
    recent: VecDeque<(String, String)>,
    hints: Vec<String>,
    /// Último texto inmediato de cada frase (respaldo si el final sale vacío).
    last_partial: Option<(u64, String, bool)>,
    phrase_end_at: Vec<(u64, Instant)>,
}

impl Pipeline {
    fn new(mode: LangMode) -> Self {
        Pipeline {
            vad: Vad::default(),
            pre: VecDeque::with_capacity(PRE_ROLL + BLOCK),
            cur: Vec::new(),
            cur_start: 0,
            clock: 0,
            since_partial: 0,
            seg: 0,
            group: 0,
            group_parts: 0,
            group_len: 0,
            group_segs: Vec::new(),
            last_end: 0,
            last_question: false,
            last_text: String::new(),
            last_lang_en: None,
            mode,
            sticky_en: mode == LangMode::En,
            guess_en: None,
            guess_secs: 0.0,
            history: VecDeque::new(),
            recent: VecDeque::new(),
            hints: Vec::new(),
            last_partial: None,
            phrase_end_at: Vec::new(),
        }
    }
}

struct FastJob {
    seg: u64,
    group: u64,
    audio: Arc<Vec<f32>>,
    is_final: bool,
}

struct FastQ {
    finals: VecDeque<FastJob>,
    partial: Option<FastJob>,
}

struct AccJob {
    seg: u64,
    audio: Arc<Vec<f32>>,
    en: bool,
    margin: f32,
    forced: bool,
    prompt: String,
    ended_at: Option<Instant>,
    /// Si no está vacío: el audio es la fila completa (estas frases unidas) y el texto reemplaza la fila.
    group_segs: Vec<u64>,
}

#[derive(Default)]
struct AccQ {
    jobs: VecDeque<AccJob>,
    want_loaded: bool,
}

struct Shared {
    emit: Emit,
    pipe: Mutex<Pipeline>,
    fastq: Mutex<FastQ>,
    fast_cv: Condvar,
    accq: Mutex<AccQ>,
    acc_cv: Condvar,
    /// Generación de la llamada: todo trabajo de una llamada anterior se descarta.
    gen: AtomicU64,
    abort: Arc<AtomicBool>,
    running: AtomicBool,
    light: AtomicBool,
    gpu_released: AtomicBool,
    fast_loaded: AtomicBool,
    /// La llamada terminó (End): los modelos se descargan.
    ended: AtomicBool,
    acc_name: Mutex<String>,
    fast_name: Mutex<String>,
    diag: Mutex<VecDeque<String>>,
    shutdown: AtomicBool,
    cancel_dl: Arc<AtomicBool>,
    t0: Instant,
}

impl Shared {
    fn log(&self, s: impl Into<String>) {
        let line = format!("[{:>7.1}s] {}", self.t0.elapsed().as_secs_f32(), s.into());
        let mut d = self.diag.lock().unwrap();
        d.push_back(line);
        while d.len() > 400 {
            d.pop_front();
        }
    }
    fn notice(&self, level: &'static str, code: &str, msg: &str) {
        self.log(format!("notice {level} {code}"));
        (self.emit)(Event::Notice { level, code: code.into(), message: msg.into() });
    }
}

pub struct Engine {
    sh: Arc<Shared>,
    capture: Mutex<Option<Capture>>,
    paused_at: Mutex<Option<Instant>>,
    test_wav: Option<PathBuf>,
    realtime: bool,
}

impl Engine {
    /// `test_wav`: solo para pruebas — reemplaza la captura por un archivo WAV.
    pub fn new(emit: Emit, test_wav: Option<PathBuf>, realtime: bool) -> Arc<Engine> {
        let sh = Arc::new(Shared {
            emit,
            pipe: Mutex::new(Pipeline::new(LangMode::Auto)),
            fastq: Mutex::new(FastQ { finals: VecDeque::new(), partial: None }),
            fast_cv: Condvar::new(),
            accq: Mutex::new(AccQ::default()),
            acc_cv: Condvar::new(),
            gen: AtomicU64::new(0),
            abort: Arc::new(AtomicBool::new(false)),
            running: AtomicBool::new(false),
            light: AtomicBool::new(false),
            gpu_released: AtomicBool::new(false),
            fast_loaded: AtomicBool::new(false),
            ended: AtomicBool::new(true),
            acc_name: Mutex::new(String::new()),
            fast_name: Mutex::new(String::new()),
            diag: Mutex::new(VecDeque::new()),
            shutdown: AtomicBool::new(false),
            cancel_dl: Arc::new(AtomicBool::new(false)),
            t0: Instant::now(),
        });
        let removed = models::cleanup();
        if removed > 0 {
            sh.log(format!("cleanup: freed {} MB of leftovers", removed / 1_048_576));
        }
        let s1 = sh.clone();
        std::thread::Builder::new().name("asr-fast".into()).spawn(move || fast_worker(s1)).expect("hilo");
        let s2 = sh.clone();
        std::thread::Builder::new().name("asr-accurate".into()).spawn(move || acc_worker(s2)).expect("hilo");
        let eng = Arc::new(Engine { sh, capture: Mutex::new(None), paused_at: Mutex::new(None), test_wav, realtime });
        // libera la GPU tras unos minutos en Pausa
        let weak = Arc::downgrade(&eng);
        std::thread::Builder::new()
            .name("pause-timer".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                let Some(e) = weak.upgrade() else { return };
                let at = *e.paused_at.lock().unwrap();
                if let Some(t) = at {
                    if t.elapsed() > PAUSE_UNLOAD {
                        let mut q = e.sh.accq.lock().unwrap();
                        if q.want_loaded {
                            q.want_loaded = false;
                            e.sh.log("pause: GPU released after 3 minutes");
                            e.sh.acc_cv.notify_all();
                        }
                    }
                }
            })
            .expect("hilo");
        eng
    }

    pub fn diagnostics(&self) -> String {
        let d = self.sh.diag.lock().unwrap();
        let mut s = String::new();
        s.push_str(&format!("Inturpreneur {} · {} {}\n", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH));
        s.push_str(&format!("Folder: {}\n", crate::paths::home().display()));
        let g = asr::gpus();
        if g.is_empty() {
            s.push_str("GPU: none detected (Vulkan)\n");
        }
        for x in g {
            s.push_str(&format!("GPU: {} · VRAM {} MB total, {} MB free\n", x.name, x.vram_total_mb, x.vram_free_mb));
        }
        s.push_str(&format!("System: {}\n", whisper_rs::print_system_info()));
        if let Some(m) = crate::mem::rss_mb() {
            s.push_str(&format!("Memory (this process): {m} MB\n"));
        }
        s.push_str(&format!("Fast engine: {}\nAccuracy engine: {}\n", self.sh.fast_name.lock().unwrap(), self.sh.acc_name.lock().unwrap()));
        for p in PANICS.lock().map(|p| p.clone()).unwrap_or_default() {
            s.push_str(&p);
            s.push('\n');
        }
        for l in d.iter() {
            s.push_str(l);
            s.push('\n');
        }
        s
    }

    pub fn is_running(&self) -> bool {
        self.sh.running.load(Ordering::Relaxed)
    }

    /// Términos de la llamada (glosario, medicamentos, vocabulario del usuario) para el `initial_prompt`.
    pub fn set_hints(&self, terms: Vec<String>) {
        let mut p = self.sh.pipe.lock().unwrap();
        p.hints = terms.into_iter().filter(|t| !t.trim().is_empty()).take(40).collect();
    }

    pub fn set_lang(&self, lang: LangMode) {
        let mut p = self.sh.pipe.lock().unwrap();
        p.mode = lang;
        match lang {
            LangMode::En => p.sticky_en = true,
            LangMode::Es => p.sticky_en = false,
            LangMode::Auto => {}
        }
    }

    pub fn start(self: &Arc<Self>, o: StartOptions) -> Result<(), String> {
        if self.sh.running.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.sh.gen.fetch_add(1, Ordering::SeqCst);
        self.sh.abort.store(false, Ordering::Relaxed);
        self.sh.light.store(o.light, Ordering::Relaxed);
        self.sh.gpu_released.store(false, Ordering::Relaxed);
        self.sh.ended.store(false, Ordering::Relaxed);
        {
            let mut p = self.sh.pipe.lock().unwrap();
            let hints = std::mem::take(&mut p.hints);
            *p = Pipeline::new(o.lang);
            p.hints = hints;
        }
        (self.sh.emit)(Event::State { state: "loading" });
        self.sh.log(format!("start: source={:?} lang={:?} light={}", o.source, o.lang, o.light));
        // el modelo rápido es imprescindible: se descarga (una sola vez) antes de empezar
        if !models::is_present(ModelId::Base) {
            self.download(ModelId::Base)?;
        }
        {
            let mut q = self.sh.accq.lock().unwrap();
            q.want_loaded = true;
        }
        self.sh.acc_cv.notify_all();
        self.sh.running.store(true, Ordering::Relaxed);
        self.sh.fast_cv.notify_all();
        self.open_capture(o.source)?;
        *self.paused_at.lock().unwrap() = None;
        (self.sh.emit)(Event::State { state: "running" });
        Ok(())
    }

    fn open_capture(self: &Arc<Self>, source: Source) -> Result<(), String> {
        let sh = self.sh.clone();
        let gen = sh.gen.load(Ordering::SeqCst);
        let sink: Box<dyn FnMut(&[f32]) + Send> = Box::new(move |b: &[f32]| on_audio(&sh, gen, b));
        let cap = if let Some(w) = &self.test_wav {
            let sh2 = self.sh.clone();
            audio::start_file(w, self.realtime, sink, Box::new(move || sh2.log("test file finished")))?
        } else {
            let sh2 = self.sh.clone();
            audio::start(source, sink, Box::new(move |e| sh2.notice("error", &e, "The audio device stopped responding. Press Pause and Resume, or End and Start again.")))
                .map_err(|e| {
                    self.sh.running.store(false, Ordering::Relaxed);
                    (self.sh.emit)(Event::State { state: "idle" });
                    e
                })?
        };
        self.sh.log(format!("capture: {}", cap.description));
        *self.capture.lock().unwrap() = Some(cap);
        Ok(())
    }

    pub fn pause(self: &Arc<Self>) {
        if !self.sh.running.swap(false, Ordering::Relaxed) {
            return;
        }
        *self.capture.lock().unwrap() = None;
        flush_phrase(&self.sh);
        *self.paused_at.lock().unwrap() = Some(Instant::now());
        self.sh.log("pause");
        (self.sh.emit)(Event::State { state: "paused" });
    }

    pub fn resume(self: &Arc<Self>, source: Source) -> Result<(), String> {
        if self.sh.running.load(Ordering::Relaxed) {
            return Ok(());
        }
        *self.paused_at.lock().unwrap() = None;
        {
            let mut q = self.sh.accq.lock().unwrap();
            if !self.sh.gpu_released.load(Ordering::Relaxed) {
                q.want_loaded = true;
            }
        }
        self.sh.acc_cv.notify_all();
        self.sh.running.store(true, Ordering::Relaxed);
        self.sh.fast_cv.notify_all();
        self.open_capture(source)?;
        self.sh.log("resume");
        (self.sh.emit)(Event::State { state: "running" });
        Ok(())
    }

    /// Termina la llamada: detiene el audio, BORRA texto y audio de la memoria y descarga los modelos
    /// (la VRAM y la RAM quedan libres).
    pub fn end(&self) {
        self.sh.running.store(false, Ordering::Relaxed);
        self.sh.ended.store(true, Ordering::Relaxed);
        self.sh.gen.fetch_add(1, Ordering::SeqCst);
        self.sh.abort.store(true, Ordering::Relaxed);
        *self.capture.lock().unwrap() = None;
        *self.paused_at.lock().unwrap() = None;
        {
            let mut p = self.sh.pipe.lock().unwrap();
            *p = Pipeline::new(LangMode::Auto); // borra frases, audio e historial
        }
        {
            let mut q = self.sh.fastq.lock().unwrap();
            q.finals.clear();
            q.partial = None;
        }
        {
            let mut q = self.sh.accq.lock().unwrap();
            q.jobs.clear();
            q.want_loaded = false;
        }
        self.sh.fast_cv.notify_all();
        self.sh.acc_cv.notify_all();
        self.sh.log("end: call content erased, models unloaded");
        (self.sh.emit)(Event::Ended);
        (self.sh.emit)(Event::State { state: "idle" });
    }

    /// "Free GPU now": descarga el modelo preciso; la llamada sigue con el modelo rápido.
    pub fn free_gpu(&self) {
        self.sh.gpu_released.store(true, Ordering::Relaxed);
        let mut q = self.sh.accq.lock().unwrap();
        q.want_loaded = false;
        for j in q.jobs.drain(..) {
            (self.sh.emit)(Event::Refined { seg: j.seg, lang: lang_str(j.en), text: String::new(), margin: 0.0, ms: 0, lat_ms: 0, model: String::new(), forced: j.forced, skipped: true, group_segs: Vec::new() });
        }
        drop(q);
        self.sh.abort.store(true, Ordering::Relaxed);
        self.sh.acc_cv.notify_all();
        self.sh.log("free gpu");
    }

    /// Vuelve a transcribir una frase en el idioma indicado (cuando el usuario corrige el idioma).
    pub fn retranscribe(&self, seg: u64, lang: LangMode) -> bool {
        let audio = {
            let p = self.sh.pipe.lock().unwrap();
            p.history.iter().find(|(s, _)| *s == seg).map(|(_, a)| a.clone())
        };
        let Some(audio) = audio else { return false };
        let en = lang == LangMode::En;
        let prompt = {
            let p = self.sh.pipe.lock().unwrap();
            let r: Vec<(String, String)> = p.recent.iter().cloned().collect();
            text::build_prompt(lang_str(en), &p.hints, &r)
        };
        let mut q = self.sh.accq.lock().unwrap();
        q.jobs.push_front(AccJob { seg, audio, en, margin: 0.0, forced: true, prompt, ended_at: None, group_segs: Vec::new() });
        drop(q);
        self.sh.acc_cv.notify_all();
        true
    }

    /// Descarga un modelo con progreso (bloquea hasta terminar).
    pub fn download(&self, id: ModelId) -> Result<(), String> {
        download_with_progress(&self.sh, id)
    }

    pub fn cancel_downloads(&self) {
        self.sh.cancel_dl.store(true, Ordering::Relaxed);
    }

    pub fn shutdown(&self) {
        self.end();
        self.sh.shutdown.store(true, Ordering::Relaxed);
        self.sh.fast_cv.notify_all();
        self.sh.acc_cv.notify_all();
    }

    /// Espera a que no quede trabajo pendiente (pruebas).
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let t = Instant::now();
        while t.elapsed() < timeout {
            let f = { let q = self.sh.fastq.lock().unwrap(); q.finals.is_empty() && q.partial.is_none() };
            let a = { let q = self.sh.accq.lock().unwrap(); q.jobs.is_empty() };
            let busy = BUSY.load(Ordering::SeqCst);
            if f && a && busy == 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

/// Solo pruebas en el contenedor: muestra en la consola el texto descartado (nunca en la app).
fn debug_text() -> bool {
    static D: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *D.get_or_init(|| std::env::var("INTURP_DEBUG_TEXT").is_ok())
}

/// Solo pruebas de precisión: no saltar frases aunque se acumule trabajo.
fn no_skip() -> bool {
    std::env::var("INTURP_TEST_NO_SKIP").is_ok()
}

/// Errores internos (panics) para el diagnóstico en memoria.
static PANICS: Mutex<Vec<String>> = Mutex::new(Vec::new());
pub fn record_panic(msg: &str) {
    if let Ok(mut p) = PANICS.lock() {
        p.push(msg.chars().take(500).collect());
    }
}

static BUSY: AtomicU64 = AtomicU64::new(0);

fn download_with_progress(sh: &Arc<Shared>, id: ModelId) -> Result<(), String> {
    sh.cancel_dl.store(false, Ordering::Relaxed);
    let label = models::spec(id).label.to_string();
    sh.log(format!("download: {label}"));
    let emit = sh.emit.clone();
    let r = models::ensure(id, &sh.cancel_dl, &|p| {
        emit(Event::Progress { label: label.clone(), pct: p.pct, done_mb: p.done / 1_048_576, total_mb: p.total / 1_048_576 });
    });
    if let Err(e) = &r {
        sh.log(format!("download failed: {e}"));
    }
    r
}

// ───────────── Audio → frases ─────────────
fn on_audio(sh: &Arc<Shared>, gen: u64, block: &[f32]) {
    if gen != sh.gen.load(Ordering::Relaxed) || !sh.running.load(Ordering::Relaxed) {
        return;
    }
    let mut b = block.to_vec();
    let mut p = sh.pipe.lock().unwrap();
    let ev = p.vad.push(&mut b);
    p.clock += b.len() as u64;
    match ev {
        VadEvent::Start => {
            let pre: Vec<f32> = p.pre.drain(..).collect();
            p.cur_start = p.clock - (b.len() + pre.len()) as u64;
            p.cur = pre;
            p.cur.extend_from_slice(&b);
            p.since_partial = 0;
            p.guess_en = None;
            p.guess_secs = 0.0;
        }
        VadEvent::End => {
            p.cur.extend_from_slice(&b);
            drop(p);
            close_phrase(sh, None);
            return;
        }
        VadEvent::None => {
            if p.vad.speaking {
                p.cur.extend_from_slice(&b);
                p.since_partial += b.len();
            } else {
                p.pre.extend(b.iter().copied());
                while p.pre.len() > PRE_ROLL {
                    p.pre.pop_front();
                }
            }
        }
    }
    if p.vad.speaking {
        if p.cur.len() >= MAX_PHRASE {
            // frase muy larga: se corta en el punto más bajo de los últimos 3 s
            let cut = quietest_cut(&p.cur);
            drop(p);
            close_phrase(sh, Some(cut));
            return;
        }
        if p.since_partial >= PARTIAL_EVERY && p.cur.len() >= SR * 7 / 10 {
            p.since_partial = 0;
            let job = FastJob { seg: p.seg + 1, group: 0, audio: Arc::new(p.cur.clone()), is_final: false };
            drop(p);
            let mut q = sh.fastq.lock().unwrap();
            q.partial = Some(job); // reemplaza la anterior: siempre el texto más reciente
            drop(q);
            sh.fast_cv.notify_all();
        }
    }
}

/// ¿La frase anterior quedó incompleta? (sin punto final, o termina en número, coma o palabra de enlace)
fn continues(prev: &str) -> bool {
    let t = prev.trim_end();
    if t.is_empty() || t.ends_with('?') || t.ends_with('!') {
        return false;
    }
    if !t.ends_with('.') || t.ends_with("...") || t.ends_with('…') {
        return true; // sin punto final, o con puntos suspensivos: la frase quedó incompleta
    }
    let body = t.trim_end_matches(['.', '…']);
    let last = body.rsplit(|c: char| c.is_whitespace()).next().unwrap_or("").to_lowercase();
    let last = last.trim_matches(|c: char| !c.is_alphanumeric());
    const LINK: &[&str] = &["and", "or", "but", "the", "a", "an", "my", "your", "is", "are", "was", "of", "to", "for", "with", "number", "at", "in", "on", "that",
        "y", "o", "pero", "el", "la", "los", "las", "un", "una", "mi", "su", "es", "son", "de", "del", "a", "en", "con", "para", "que", "número", "numero", "por"];
    last.chars().last().map(|c| c.is_ascii_digit()).unwrap_or(false) || LINK.contains(&last)
}

/// ¿La frase empieza otro turno de la conversación? (respuesta o pregunta: nunca se une con la anterior)
/// Misma regla que la interfaz (app.js → newTurn).
fn new_turn(t: &str) -> bool {
    let t = t.trim();
    if t.ends_with('?') || t.starts_with('¿') {
        return true;
    }
    let first = t.split(|c: char| !c.is_alphanumeric() && c != 'í').next().unwrap_or("").to_lowercase();
    const W: &[&str] = &["yes", "yeah", "yep", "no", "nope", "okay", "ok", "sure", "right", "correct", "exactly", "hello", "hi", "thank", "thanks",
        "si", "sí", "claro", "correcto", "exacto", "bueno", "hola", "gracias", "perfecto"];
    W.contains(&first.as_str())
}

fn quietest_cut(x: &[f32]) -> usize {
    let win = SR / 10;
    let from = x.len().saturating_sub(SR * 3);
    let mut best = (f32::MAX, x.len());
    let mut i = from;
    while i + win <= x.len() {
        let r = crate::vad::rms(&x[i..i + win]);
        if r < best.0 {
            best = (r, i + win / 2);
        }
        i += win / 2;
    }
    best.1
}

/// Cierra la frase en curso (por silencio, por largo o por Pausa).
fn close_phrase(sh: &Arc<Shared>, cut: Option<usize>) {
    let mut p = sh.pipe.lock().unwrap();
    let mut audio = std::mem::take(&mut p.cur);
    if let Some(c) = cut {
        let rest = audio.split_off(c.min(audio.len()));
        p.cur = rest;
    }
    p.since_partial = 0;
    if audio.len() < SR * 3 / 10 {
        return; // ruido corto
    }
    let start = p.cur_start;
    let end = start + audio.len() as u64;
    if cut.is_some() {
        p.cur_start = end;
    }
    let gap = start.saturating_sub(p.last_end);
    // candidata a unirse con la frase anterior (pausa corta); el modelo rápido decide con el texto
    let near = p.seg > 0 && (gap < JOIN_GAP || cut.is_some());
    p.seg += 1;
    p.last_end = end;
    let seg = p.seg;
    let group = if near { 1 } else { 0 };
    let audio = Arc::new(audio);
    p.history.push_back((seg, audio.clone()));
    while p.history.len() > HISTORY {
        p.history.pop_front();
    }
    p.phrase_end_at.push((seg, Instant::now()));
    if p.phrase_end_at.len() > 8 {
        p.phrase_end_at.remove(0);
    }
    drop(p);
    let mut q = sh.fastq.lock().unwrap();
    q.partial = None;
    q.finals.push_back(FastJob { seg, group, audio, is_final: true });
    drop(q);
    sh.fast_cv.notify_all();
}

fn flush_phrase(sh: &Arc<Shared>) {
    let speaking = { sh.pipe.lock().unwrap().vad.speaking };
    if speaking {
        close_phrase(sh, None);
        sh.pipe.lock().unwrap().vad.reset();
    }
}

// ───────────── Modelo rápido (CPU) ─────────────
fn threads_fast() -> usize {
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (n / 2).clamp(2, 4)
}

fn fast_worker(sh: Arc<Shared>) {
    let mut model: Option<Model> = None;
    loop {
        let job = {
            let mut q = sh.fastq.lock().unwrap();
            loop {
                if sh.shutdown.load(Ordering::Relaxed) {
                    return;
                }
                if sh.ended.load(Ordering::Relaxed) && q.finals.is_empty() && model.is_some() {
                    // llamada terminada: libera la RAM del modelo rápido
                    drop(q);
                    model = None;
                    sh.fast_loaded.store(false, Ordering::Relaxed);
                    sh.log("fast engine unloaded");
                    q = sh.fastq.lock().unwrap();
                    continue;
                }
                if let Some(j) = q.finals.pop_front() {
                    break j;
                }
                if let Some(j) = q.partial.take() {
                    break j;
                }
                if sh.running.load(Ordering::Relaxed) && model.is_none() {
                    break FastJob { seg: 0, group: 0, audio: Arc::new(Vec::new()), is_final: false }; // precarga
                }
                q = sh.fast_cv.wait_timeout(q, Duration::from_millis(500)).unwrap().0;
            }
        };
        let gen = sh.gen.load(Ordering::SeqCst);
        if model.is_none() {
            let t = Instant::now();
            match Model::load(&models::main_file(ModelId::Base), false, threads_fast(), "Whisper base · CPU") {
                Ok(m) => {
                    sh.log(format!("fast engine loaded in {} ms ({} threads)", t.elapsed().as_millis(), m.threads));
                    *sh.fast_name.lock().unwrap() = m.name.clone();
                    model = Some(m);
                    sh.fast_loaded.store(true, Ordering::Relaxed);
                    emit_engine(&sh);
                }
                Err(e) => {
                    sh.notice("error", "FAST_MODEL_FAILED", "The speech engine could not start. Open Settings → Storage and press Repair.");
                    sh.log(format!("fast load error: {e}"));
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
            }
        }
        if job.audio.is_empty() {
            continue;
        }
        BUSY.fetch_add(1, Ordering::SeqCst);
        let m = model.as_mut().unwrap();
        if job.is_final {
            run_fast_final(&sh, m, job, gen);
        } else {
            run_partial(&sh, m, job, gen);
        }
        BUSY.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Decide EN/ES con reglas asimétricas: pasar a español es fácil, pasar a inglés exige más seguridad
/// (Whisper tiende a "traducir" el español al inglés). Frases cortas conservan el idioma anterior.
fn decide_lang(prev_en: bool, margin: f32, secs: f32) -> bool {
    let (to_es, to_en) = if secs < 1.2 { (3.0, 5.0) } else { (1.0, 2.5) };
    if prev_en {
        !(margin < -to_es)
    } else {
        margin > to_en
    }
}

fn run_partial(sh: &Arc<Shared>, m: &mut Model, job: FastJob, gen: u64) {
    let (mode, sticky, guess, gsecs) = {
        let p = sh.pipe.lock().unwrap();
        (p.mode, p.sticky_en, p.guess_en, p.guess_secs)
    };
    let secs = job.audio.len() as f32 / SR as f32;
    let en = match mode {
        LangMode::En => true,
        LangMode::Es => false,
        // se estima al primer texto inmediato y una vez más cuando hay 2.5 s de audio
        LangMode::Auto => match guess {
            Some(g) if !(gsecs < 2.5 && secs >= 2.5) => g,
            _ => {
                let g = m.detect_en_es(&job.audio).map(|mg| decide_lang(sticky, mg, secs)).unwrap_or(sticky);
                let mut p = sh.pipe.lock().unwrap();
                p.guess_en = Some(g);
                p.guess_secs = secs;
                g
            }
        },
    };
    let r = m.transcribe(&job.audio, &Options { lang: lang_str(en), prompt: "", short_ctx: true, beam: false, abort: None });
    if gen != sh.gen.load(Ordering::SeqCst) {
        return;
    }
    // si la frase ya se cerró, el parcial ya no sirve
    let still = { let p = sh.pipe.lock().unwrap(); p.seg + 1 == job.seg && p.vad.speaking };
    if let (Ok(t), true) = (r, still) {
        let text = text::clean(&t.text);
        if !text.is_empty() {
            sh.pipe.lock().unwrap().last_partial = Some((job.seg, text.clone(), en));
            (sh.emit)(Event::Partial { seg: job.seg, lang: lang_str(en), text });
        }
    }
}

fn run_fast_final(sh: &Arc<Shared>, m: &mut Model, job: FastJob, gen: u64) {
    let (mode, sticky, guess) = {
        let p = sh.pipe.lock().unwrap();
        (p.mode, p.sticky_en, p.guess_en)
    };
    let secs = job.audio.len() as f32 / SR as f32;
    let mut margin = 0.0;
    let en = match mode {
        LangMode::En => true,
        LangMode::Es => false,
        LangMode::Auto => match m.detect_en_es(&job.audio) {
            Ok(mg) => {
                margin = mg;
                decide_lang(guess.unwrap_or(sticky), mg, secs)
            }
            Err(_) => sticky,
        },
    };
    let t = Instant::now();
    let r = m.transcribe(&job.audio, &Options { lang: lang_str(en), prompt: "", short_ctx: true, beam: false, abort: None });
    if gen != sh.gen.load(Ordering::SeqCst) {
        return;
    }
    let tr = match r {
        Ok(t) => t,
        Err(e) => {
            sh.log(format!("fast error: {e}"));
            return;
        }
    };
    let mut text = text::clean(&tr.text);
    // silencio o ruido que Whisper interpretó como palabras
    if tr.no_speech > 0.6 && tr.conf < 0.5 {
        text.clear();
    }
    if debug_text() && text.is_empty() {
        eprintln!("[debug] seg {} fast dropped: {:?} (no_speech {:.2}, conf {:.2})", job.seg, tr.text, tr.no_speech, tr.conf);
    }
    let mut conf = tr.conf;
    let mut words = tr.words;
    if text.is_empty() {
        // el final salió vacío pero mientras se hablaba sí hubo texto: se conserva ese texto
        let lp = sh.pipe.lock().unwrap().last_partial.take();
        if let Some((s, t, pen)) = lp {
            if s == job.seg && pen == en {
                text = t;
                conf = 0.5;
                words = Vec::new();
            }
        }
    }
    let group;
    let ended_at = {
        let mut p = sh.pipe.lock().unwrap();
        if !text.is_empty() {
            p.sticky_en = en;
            p.last_question = text.trim_end().ends_with('?') || text.trim_start().starts_with('¿');
            p.recent.push_back((lang_str(en).to_string(), text.clone()));
            while p.recent.len() > 4 {
                p.recent.pop_front();
            }
        }
        if !text.is_empty() {
            // ¿continúa la frase anterior? (pausa corta + la anterior quedó incompleta)
            let join = job.group == 1 && p.group > 0 && p.group_parts < 6 && p.group_len + job.audio.len() < SR * 25
                && p.last_lang_en == Some(en) && continues(&p.last_text) && !new_turn(&text);
            if join {
                p.group_parts += 1;
                p.group_len += job.audio.len();
                p.group_segs.push(job.seg);
            } else {
                p.group = job.seg;
                p.group_parts = 1;
                p.group_len = job.audio.len();
                p.group_segs = vec![job.seg];
            }
            p.last_text = text.clone();
            p.last_lang_en = Some(en);
        }
        group = p.group;
        p.phrase_end_at.iter().find(|(s, _)| *s == job.seg).map(|(_, t)| *t)
    };
    let lat = ended_at.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
    sh.log(format!("seg {} final: {:.1}s audio, {} ms (fast), lang {} margin {:.1}", job.seg, secs, t.elapsed().as_millis(), lang_str(en), margin));
    // sin texto en el rápido: el preciso igual lo revisa (puede ser voz poco clara)
    if !text.is_empty() {
        (sh.emit)(Event::Final { seg: job.seg, group, lang: lang_str(en), text: text.clone(), conf, words, margin, lat_ms: lat });
    }
    if text.is_empty() && tr.no_speech > 0.8 {
        return;
    }
    if text.is_empty() {
        return; // nada que corregir en pantalla
    }
    // Frase que continúa la anterior (pausa a la mitad): el modelo preciso transcribe la fila completa,
    // con todo su audio junto, para no perder el contexto (p. ej. un número dictado en partes).
    let (prompt, audio, group_segs) = {
        let p = sh.pipe.lock().unwrap();
        let segs = if p.group_segs.len() > 1 && p.group_segs.last() == Some(&job.seg) { p.group_segs.clone() } else { Vec::new() };
        let mut audio = job.audio.clone();
        if !segs.is_empty() {
            let mut all: Vec<f32> = Vec::new();
            let mut ok = true;
            for s in &segs {
                match p.history.iter().find(|(x, _)| x == s) {
                    Some((_, a)) => {
                        if !all.is_empty() {
                            all.extend(std::iter::repeat(0.0).take(SR * 3 / 10)); // pausa corta entre partes
                        }
                        all.extend_from_slice(a);
                    }
                    None => ok = false,
                }
            }
            if ok && all.len() <= SR * 28 {
                audio = Arc::new(all);
            }
        }
        let segs = if Arc::ptr_eq(&audio, &job.audio) { Vec::new() } else { segs };
        // el contexto son las frases anteriores a esta fila
        let skip = segs.len().max(1);
        let r: Vec<(String, String)> = p.recent.iter().take(p.recent.len().saturating_sub(skip)).cloned().collect();
        (text::build_prompt(lang_str(en), &p.hints, &r), audio, segs)
    };
    let mut q = sh.accq.lock().unwrap();
    if !group_segs.is_empty() {
        // además de la fila completa, esta frase se corrige sola (por si la interfaz no la unió)
        q.jobs.push_back(AccJob { seg: job.seg, audio: job.audio.clone(), en, margin, forced: false, prompt: prompt.clone(), ended_at, group_segs: Vec::new() });
    }
    // si se acumula trabajo, las frases más viejas se saltan (queda el texto del modelo rápido)
    while q.jobs.len() > 3 && !no_skip() {
        if let Some(old) = q.jobs.pop_front() {
            (sh.emit)(Event::Refined { seg: old.seg, lang: lang_str(old.en), text: String::new(), margin: 0.0, ms: 0, lat_ms: 0, model: String::new(), forced: false, skipped: true, group_segs: Vec::new() });
        }
    }
    q.jobs.push_back(AccJob { seg: job.seg, audio, en, margin, forced: false, prompt, ended_at, group_segs });
    drop(q);
    sh.acc_cv.notify_all();
}

fn emit_engine(sh: &Arc<Shared>) {
    let g = asr::gpus();
    (sh.emit)(Event::Engine {
        fast: sh.fast_name.lock().unwrap().clone(),
        accurate: sh.acc_name.lock().unwrap().clone(),
        gpu: g.first().map(|x| x.name.clone()),
        vram_mb: None,
    });
}

// ───────────── Modelo preciso (GPU / CPU) ─────────────
fn acc_worker(sh: Arc<Shared>) {
    let mut model: Option<Model> = None;
    let mut gpu_failed = false;
    loop {
        let job = {
            let mut q = sh.accq.lock().unwrap();
            loop {
                if sh.shutdown.load(Ordering::Relaxed) {
                    return;
                }
                if !q.want_loaded && model.is_some() {
                    drop(q);
                    let before = asr::gpu_free_mb();
                    model = None; // libera VRAM / RAM
                    let after = asr::gpu_free_mb();
                    sh.log(format!("accuracy engine unloaded (VRAM free {:?} → {:?} MB)", before, after));
                    *sh.acc_name.lock().unwrap() = String::new();
                    emit_engine(&sh);
                    q = sh.accq.lock().unwrap();
                    continue;
                }
                if q.want_loaded && model.is_none() {
                    break None; // cargar
                }
                if q.want_loaded {
                    if let Some(j) = q.jobs.pop_front() {
                        break Some(j);
                    }
                } else if let Some(j) = q.jobs.pop_front() {
                    // sin modelo preciso: se responde "sin corrección"
                    (sh.emit)(Event::Refined { seg: j.seg, lang: lang_str(j.en), text: String::new(), margin: 0.0, ms: 0, lat_ms: 0, model: String::new(), forced: j.forced, skipped: true, group_segs: Vec::new() });
                    continue;
                }
                q = sh.acc_cv.wait_timeout(q, Duration::from_millis(500)).unwrap().0;
            }
        };
        match job {
            None => {
                // deja arrancar primero la captura y el modelo rápido (el texto inmediato tiene prioridad)
                std::thread::sleep(Duration::from_millis(1500));
                model = load_accurate(&sh, &mut gpu_failed);
                if model.is_none() {
                    // no se pudo: la llamada sigue con el modelo rápido
                    let mut q = sh.accq.lock().unwrap();
                    q.want_loaded = false;
                    for j in q.jobs.drain(..) {
                        (sh.emit)(Event::Refined { seg: j.seg, lang: lang_str(j.en), text: String::new(), margin: 0.0, ms: 0, lat_ms: 0, model: String::new(), forced: j.forced, skipped: true, group_segs: Vec::new() });
                    }
                }
            }
            Some(j) => {
                BUSY.fetch_add(1, Ordering::SeqCst);
                let gen = sh.gen.load(Ordering::SeqCst);
                sh.abort.store(false, Ordering::Relaxed);
                let m = model.as_mut().unwrap();
                let r = run_accurate(&sh, m, &j);
                if gen == sh.gen.load(Ordering::SeqCst) {
                    match r {
                        Ok(ev) => (sh.emit)(ev),
                        Err(e) => {
                            sh.log(format!("accuracy error: {e}"));
                            if m.gpu && !sh.abort.load(Ordering::Relaxed) {
                                // falla en GPU: se pasa al procesador sin cortar la llamada
                                gpu_failed = true;
                                model = None;
                                sh.notice("warn", "GPU_FAILED", "The graphics card stopped responding. Switched to the processor (a bit slower).");
                            }
                            (sh.emit)(Event::Refined { seg: j.seg, lang: lang_str(j.en), text: String::new(), margin: 0.0, ms: 0, lat_ms: 0, model: String::new(), forced: j.forced, skipped: true, group_segs: Vec::new() });
                        }
                    }
                }
                BUSY.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }
}

fn load_accurate(sh: &Arc<Shared>, gpu_failed: &mut bool) -> Option<Model> {
    let light = sh.light.load(Ordering::Relaxed);
    let gpus = asr::gpus();
    // GPU con al menos 3 GB: large-v3-turbo; si no, small en el procesador
    let use_gpu = !light && !*gpu_failed && gpus.first().map(|g| g.vram_total_mb >= 3000).unwrap_or(false);
    // solo pruebas: INTURP_TEST_ACCURATE=turbo usa large-v3-turbo aunque no haya GPU
    let force_turbo = std::env::var("INTURP_TEST_ACCURATE").map(|v| v == "turbo").unwrap_or(false);
    let id = if use_gpu || force_turbo { ModelId::Turbo } else { ModelId::Small };
    if !models::is_present(id) {
        if let Err(e) = download_with_progress(sh, id) {
            sh.notice("warn", "MODEL_DOWNLOAD_FAILED", "Could not download the accuracy engine. The fast engine keeps working; check your internet and press Start again.");
            sh.log(format!("accuracy download error: {e}"));
            return None;
        }
    }
    if !sh.accq.lock().unwrap().want_loaded {
        return None;
    }
    let before = asr::gpu_free_mb();
    let t = Instant::now();
    let threads = if use_gpu { 2 } else { threads_fast() };
    let name = if use_gpu { format!("Whisper large-v3-turbo · GPU ({})", gpus[0].name) } else if force_turbo { "Whisper large-v3-turbo · CPU (test)".to_string() } else if light { "Whisper small · CPU (Light mode)".to_string() } else { "Whisper small · CPU".to_string() };
    let r = Model::load(&models::main_file(id), use_gpu, threads, &name);
    let m = match r {
        Ok(m) if !m.gpu => Some(m),
        Ok(mut m) => {
            // prueba en GPU: 1 s de silencio (compila los shaders y comprueba que la tarjeta responde)
            let probe = vec![0f32; SR];
            match m.transcribe(&probe, &Options { lang: "en", prompt: "", short_ctx: false, beam: false, abort: None }) {
                Ok(_) => Some(m),
                Err(e) => {
                    sh.log(format!("accuracy probe failed: {e}"));
                    None
                }
            }
        }
        Err(e) => {
            sh.log(format!("accuracy load error: {e}"));
            None
        }
    };
    match m {
        Some(m) => {
            let after = asr::gpu_free_mb();
            let vram = match (before, after) {
                (Some(b), Some(a)) if m.gpu && b > a => Some(b - a),
                _ => None,
            };
            sh.log(format!("accuracy engine: {} loaded in {} ms; VRAM used {:?} MB; RAM {:?} MB", m.name, t.elapsed().as_millis(), vram, crate::mem::rss_mb()));
            *sh.acc_name.lock().unwrap() = m.name.clone();
            let g = asr::gpus();
            (sh.emit)(Event::Engine { fast: sh.fast_name.lock().unwrap().clone(), accurate: m.name.clone(), gpu: g.first().map(|x| x.name.clone()), vram_mb: vram });
            Some(m)
        }
        None if use_gpu => {
            *gpu_failed = true;
            sh.notice("warn", "GPU_UNAVAILABLE", "The graphics card could not be used. Using the processor instead (a bit slower).");
            load_accurate(sh, gpu_failed)
        }
        None => {
            sh.notice("warn", "ACCURACY_UNAVAILABLE", "The accuracy engine could not start. The fast engine keeps working.");
            None
        }
    }
}

fn run_accurate(sh: &Arc<Shared>, m: &mut Model, j: &AccJob) -> Result<Event, String> {
    let t = Instant::now();
    let secs = j.audio.len() as f32 / SR as f32;
    let mode = sh.pipe.lock().unwrap().mode;
    let mut en = j.en;
    let mut margin = j.margin;
    // segunda opinión del idioma solo si el modelo rápido dudó
    if mode == LangMode::Auto && !j.forced && j.margin.abs() < 4.0 && secs >= 1.5 {
        if let Ok(mg) = m.detect_en_es(&j.audio) {
            margin = mg;
            // reglas asimétricas, como en la página: a español con margen > 1.5; a inglés con > 4
            if en && mg < -1.5 {
                en = false;
            } else if !en && mg > 4.0 {
                en = true;
            }
        }
    }
    let prompt = if en == j.en { j.prompt.clone() } else { String::new() };
    let tr = m.transcribe(&j.audio, &Options { lang: lang_str(en), prompt: &prompt, short_ctx: !m.gpu && !no_skip(), beam: m.gpu, abort: Some(sh.abort.clone()) })?;
    let mut text = text::clean(&tr.text);
    if text::echoes_prompt(&text, &prompt) || (tr.no_speech > 0.6 && tr.conf < 0.5) {
        text.clear();
    }
    let ms = t.elapsed().as_millis() as u64;
    let lat = j.ended_at.map(|x| x.elapsed().as_millis() as u64).unwrap_or(0);
    sh.log(format!("seg {} refined: {:.1}s audio, {} ms ({}), lang {}", j.seg, secs, ms, m.name, lang_str(en)));
    Ok(Event::Refined { seg: j.seg, lang: lang_str(en), text, margin, ms, lat_ms: lat, model: m.name.clone(), forced: j.forced, skipped: false, group_segs: j.group_segs.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frases_incompletas() {
        assert!(continues("The case number is 2024,"));
        assert!(continues("The case number is 2 0 2 4."));
        assert!(continues("Mi número de seguros sociales..."));
        assert!(continues("Mi número de seguro social es."));
        assert!(!continues("Can you ask the patient?"));
        assert!(!continues("I had an accident yesterday."));
        assert!(new_turn("Can you ask the patient if she filed a police report?"));
        assert!(new_turn("Sí, claro."));
        assert!(!new_turn("3371."));
    }
}
