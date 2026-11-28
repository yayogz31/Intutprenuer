//! Captura de audio: micrófono y audio del sistema (WASAPI loopback en Windows: sin "Stereo Mix" ni
//! cables virtuales). Todo se convierte a 16 kHz mono y se entrega en bloques de 20 ms con un reloj
//! propio: el loopback de Windows no manda nada cuando no suena nada, y el detector de voz necesita
//! ver ese silencio para cerrar las frases.

use crate::asr::SR;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Mic,
    System,
    Mix,
}

pub const BLOCK: usize = SR / 50; // 20 ms

/// Filtro paso bajo + remuestreo lineal a 16 kHz (suficiente para voz).
struct Resampler {
    ratio: f64,
    pos: f64,
    taps: Vec<f32>,
    hist: VecDeque<f32>,
    prev: f32,
}

impl Resampler {
    fn new(rate: u32) -> Self {
        let ratio = rate as f64 / SR as f64;
        // FIR windowed-sinc, corte a 7.2 kHz
        let n = if ratio > 1.01 { 31 } else { 1 };
        let fc = 7_200.0 / rate as f64;
        let mut taps: Vec<f32> = (0..n)
            .map(|i| {
                if n == 1 {
                    return 1.0;
                }
                let m = i as f64 - (n - 1) as f64 / 2.0;
                let sinc = if m == 0.0 { 2.0 * fc } else { (2.0 * std::f64::consts::PI * fc * m).sin() / (std::f64::consts::PI * m) };
                let w = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * i as f64 / (n - 1) as f64).cos();
                (sinc * w) as f32
            })
            .collect();
        let s: f32 = taps.iter().sum();
        taps.iter_mut().for_each(|t| *t /= s);
        Resampler { ratio, pos: 0.0, hist: VecDeque::from(vec![0.0; taps.len()]), taps, prev: 0.0 }
    }
    fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &x in input {
            self.hist.pop_front();
            self.hist.push_back(x);
            let y: f32 = self.hist.iter().zip(&self.taps).map(|(a, b)| a * b).sum();
            // interpolación lineal entre la muestra filtrada anterior y la actual
            while self.pos < 1.0 {
                out.push(self.prev + (y - self.prev) * self.pos as f32);
                self.pos += self.ratio;
            }
            self.pos -= 1.0;
            self.prev = y;
        }
    }
}

type Queue = Arc<Mutex<VecDeque<f32>>>;

pub struct Capture {
    _streams: Vec<cpal::Stream>,
    stop: Arc<AtomicBool>,
    pub description: String,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Devices {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub default_input: Option<String>,
    pub default_output: Option<String>,
}

fn dev_name(d: &cpal::Device) -> String {
    d.description().map(|x| x.name().to_string()).unwrap_or_else(|_| "Unknown device".into())
}

pub fn list_devices() -> Devices {
    let host = cpal::default_host();
    let names = |it: Option<Vec<cpal::Device>>| it.unwrap_or_default().iter().map(dev_name).collect();
    Devices {
        inputs: names(host.input_devices().ok().map(|i| i.collect())),
        outputs: names(host.output_devices().ok().map(|i| i.collect())),
        default_input: host.default_input_device().map(|d| dev_name(&d)),
        default_output: host.default_output_device().map(|d| dev_name(&d)),
    }
}

/// Abre un flujo de entrada. En Windows, si `dev` es un dispositivo de salida, cpal usa loopback.
fn open(dev: &cpal::Device, loopback: bool, q: Queue, err_flag: Arc<AtomicBool>) -> Result<cpal::Stream, String> {
    let cfg = if loopback { dev.default_output_config() } else { dev.default_input_config() }.map_err(|e| e.to_string())?;
    let ch = cfg.channels() as usize;
    let rate = cfg.sample_rate();
    let fmt = cfg.sample_format();
    let scfg: cpal::StreamConfig = cfg.into();
    let rs = Arc::new(Mutex::new(Resampler::new(rate)));
    let err_cb = move |_e: cpal::Error| err_flag.store(true, Ordering::Relaxed);
    macro_rules! build {
        ($t:ty, $conv:expr) => {{
            let q = q.clone();
            let rs = rs.clone();
            let mut mono: Vec<f32> = Vec::new();
            let mut out: Vec<f32> = Vec::new();
            dev.build_input_stream(
                scfg.clone(),
                move |data: &[$t], _: &cpal::InputCallbackInfo| {
                    mono.clear();
                    for fr in data.chunks(ch) {
                        let s: f32 = fr.iter().map(|&x| $conv(x)).sum::<f32>() / ch as f32;
                        mono.push(s);
                    }
                    out.clear();
                    if let Ok(mut r) = rs.lock() {
                        r.push(&mono, &mut out);
                    }
                    if let Ok(mut qq) = q.lock() {
                        qq.extend(out.iter().copied());
                        // nunca más de 2 s acumulados (si el procesamiento se atrasa)
                        let max = SR * 2;
                        if qq.len() > max {
                            let n = qq.len() - max;
                            qq.drain(..n);
                        }
                    }
                },
                err_cb,
                None,
            )
            .map_err(|e| e.to_string())?
        }};
    }
    let stream = match fmt {
        cpal::SampleFormat::F32 => build!(f32, |x: f32| x),
        cpal::SampleFormat::I16 => build!(i16, |x: i16| x as f32 / 32768.0),
        cpal::SampleFormat::I32 => build!(i32, |x: i32| x as f32 / 2_147_483_648.0),
        cpal::SampleFormat::U16 => build!(u16, |x: u16| (x as f32 - 32768.0) / 32768.0),
        other => return Err(format!("unsupported audio format {other:?}")),
    };
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

/// Empieza a capturar. `sink` recibe bloques de 20 ms a 16 kHz desde un hilo propio.
pub fn start(source: Source, sink: Box<dyn FnMut(&[f32]) + Send>, on_error: Box<dyn Fn(String) + Send>) -> Result<Capture, String> {
    let host = cpal::default_host();
    let mut streams = Vec::new();
    let mut queues: Vec<Queue> = Vec::new();
    let mut desc = Vec::new();
    let err_flag = Arc::new(AtomicBool::new(false));
    if matches!(source, Source::Mic | Source::Mix) {
        let dev = host.default_input_device().ok_or("MIC_NOT_FOUND")?;
        let q: Queue = Arc::new(Mutex::new(VecDeque::new()));
        streams.push(open(&dev, false, q.clone(), err_flag.clone()).map_err(|e| format!("MIC_FAILED: {e}"))?);
        desc.push(format!("Microphone: {}", dev_name(&dev)));
        queues.push(q);
    }
    if matches!(source, Source::System | Source::Mix) {
        let dev = host.default_output_device().ok_or("OUTPUT_NOT_FOUND")?;
        let q: Queue = Arc::new(Mutex::new(VecDeque::new()));
        streams.push(open(&dev, true, q.clone(), err_flag.clone()).map_err(|e| format!("LOOPBACK_FAILED: {e}"))?);
        desc.push(format!("System audio: {}", dev_name(&dev)));
        queues.push(q);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let mut sink = sink;
    std::thread::Builder::new()
        .name("audio-clock".into())
        .spawn(move || {
            let t0 = Instant::now();
            let mut sent: u64 = 0;
            let mut block = vec![0f32; BLOCK];
            // 60 ms de margen para absorber el jitter de los dispositivos
            let lag = (SR as u64 * 60) / 1000;
            let mut reported = false;
            while !stop2.load(Ordering::Relaxed) {
                if err_flag.load(Ordering::Relaxed) && !reported {
                    reported = true;
                    on_error("AUDIO_DEVICE_LOST".into());
                }
                let due = (t0.elapsed().as_secs_f64() * SR as f64) as u64;
                while sent + BLOCK as u64 + lag <= due {
                    block.iter_mut().for_each(|x| *x = 0.0);
                    for q in &queues {
                        if let Ok(mut qq) = q.lock() {
                            let n = qq.len().min(BLOCK);
                            for (i, s) in qq.drain(..n).enumerate() {
                                block[i] += s;
                            }
                        }
                    }
                    if queues.len() > 1 {
                        block.iter_mut().for_each(|x| *x = x.clamp(-1.0, 1.0));
                    }
                    sink(&block);
                    sent += BLOCK as u64;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Capture { _streams: streams, stop, description: desc.join(" + ") })
}

/// Fuente de prueba: reproduce un WAV en tiempo real (o lo más rápido posible) como si fuera audio en vivo.
pub fn start_file(path: &std::path::Path, realtime: bool, sink: Box<dyn FnMut(&[f32]) + Send>, on_end: Box<dyn FnOnce() + Send>) -> Result<Capture, String> {
    let samples = read_wav_16k(path)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let mut sink = sink;
    std::thread::Builder::new()
        .name("audio-file".into())
        .spawn(move || {
            let t0 = Instant::now();
            // 1.5 s de silencio al final para que la última frase se cierre
            let tail = vec![0f32; SR * 3 / 2];
            let all: Vec<f32> = samples.into_iter().chain(tail).collect();
            for (i, ch) in all.chunks(BLOCK).enumerate() {
                if stop2.load(Ordering::Relaxed) {
                    return;
                }
                if realtime {
                    let due = Duration::from_secs_f64((i * BLOCK) as f64 / SR as f64);
                    let el = t0.elapsed();
                    if due > el {
                        std::thread::sleep(due - el);
                    }
                }
                sink(ch);
            }
            on_end();
        })
        .map_err(|e| e.to_string())?;
    Ok(Capture { _streams: Vec::new(), stop, description: format!("Test file: {}", path.display()) })
}

pub fn read_wav_16k(path: &std::path::Path) -> Result<Vec<f32>, String> {
    let mut r = hound::WavReader::open(path).map_err(|e| format!("cannot open WAV: {e}"))?;
    let spec = r.spec();
    let ch = spec.channels as usize;
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().filter_map(Result::ok).collect(),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().filter_map(Result::ok).map(|x| x as f32 / scale).collect()
        }
    };
    let mono: Vec<f32> = raw.chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect();
    if spec.sample_rate as usize == SR {
        return Ok(mono);
    }
    let mut rs = Resampler::new(spec.sample_rate);
    let mut out = Vec::with_capacity(mono.len() * SR / spec.sample_rate as usize + 16);
    rs.push(&mono, &mut out);
    Ok(out)
}
