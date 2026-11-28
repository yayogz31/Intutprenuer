//! Prueba del núcleo: pasa un WAV por el motor como si fuera una llamada y escribe los eventos (JSONL).
//! Uso: run_wav <archivo.wav> [auto|en|es] [--fast] [--light]
//!   --fast: sin esperar el tiempo real (más rápido que la llamada real; útil para medir precisión)
use inturp_core::{Engine, Event, LangMode, StartOptions};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wav = std::path::PathBuf::from(&args[1]);
    let lang = match args.get(2).map(|s| s.as_str()) { Some("en") => LangMode::En, Some("es") => LangMode::Es, _ => LangMode::Auto };
    let realtime = !args.iter().any(|a| a == "--fast");
    let light = args.iter().any(|a| a == "--light");
    let t0 = Instant::now();
    let finals = Arc::new(Mutex::new(0usize));
    let f2 = finals.clone();
    let peak = Arc::new(Mutex::new(0u64));
    let p2 = peak.clone();
    let emit = Arc::new(move |e: Event| {
        if let Some(m) = inturp_core::mem::rss_mb() { let mut p = p2.lock().unwrap(); if m > *p { *p = m; } }
        if matches!(e, Event::Final { .. }) { *f2.lock().unwrap() += 1; }
        let mut v = serde_json::to_value(&e).unwrap();
        v["t"] = serde_json::json!(t0.elapsed().as_millis() as u64);
        println!("{}", v);
    });
    let eng = Engine::new(emit, Some(wav.clone()), realtime);
    let secs = inturp_core::audio::read_wav_16k(&wav).unwrap().len() as f64 / 16000.0;
    eng.set_hints(vec!["claim".into(), "adjuster".into(), "deductible".into(), "comprehensive insurance".into(), "metformina".into(), "Social Security".into()]);
    let r0 = inturp_core::mem::rss_mb().unwrap_or(0);
    eng.start(StartOptions { source: inturp_core::audio::Source::Mic, lang, light }).expect("start");
    // espera a que termine el archivo y el trabajo pendiente
    let wait = if realtime { secs + 2.0 } else { 1.0 };
    std::thread::sleep(Duration::from_secs_f64(wait));
    while !eng.wait_idle(Duration::from_secs(1)) {}
    std::thread::sleep(Duration::from_millis(1500));
    while !eng.wait_idle(Duration::from_secs(1)) {}
    let during = inturp_core::mem::rss_mb().unwrap_or(0);
    eng.end();
    std::thread::sleep(Duration::from_millis(2500));
    let after = inturp_core::mem::rss_mb().unwrap_or(0);
    eprintln!("{}", eng.diagnostics());
    println!("{}", serde_json::json!({"type": "summary", "audio_s": secs, "wall_s": t0.elapsed().as_secs_f64(), "finals": *finals.lock().unwrap(), "rss_start_mb": r0, "rss_peak_mb": *peak.lock().unwrap(), "rss_call_mb": during, "rss_after_end_mb": after}));
}
