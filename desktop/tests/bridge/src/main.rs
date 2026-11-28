//! SOLO PRUEBAS (no forma parte de la app ni del instalador).
//! Sirve `desktop/ui` y emula el IPC de Tauri por HTTP local para que Playwright maneje la interfaz real
//! conectada al núcleo real, con un WAV como si fuera el audio de la llamada.
//! Uso: inturp-bridge <puerto> <archivo.wav>
use inturp_core::{audio::Source, Engine, Event, LangMode, StartOptions};
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Response, Server};

fn h(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port: u16 = args[1].parse().unwrap();
    let wav = std::path::PathBuf::from(&args[2]);
    let ui = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui");
    // eventos del núcleo en memoria; la página los pide con /poll?after=N
    let log: Arc<(Mutex<Vec<String>>, std::sync::Condvar)> = Arc::new((Mutex::new(Vec::new()), std::sync::Condvar::new()));
    let l2 = log.clone();
    let engine = Engine::new(Arc::new(move |e: Event| {
        let s = serde_json::to_string(&e).unwrap();
        l2.0.lock().unwrap().push(s);
        l2.1.notify_all();
    }), Some(wav), true);
    let saved = Arc::new(Mutex::new(String::from("{}")));
    let server = Server::http(("127.0.0.1", port)).unwrap();
    eprintln!("bridge on http://127.0.0.1:{port}");
    for mut req in server.incoming_requests() {
        let url = req.url().to_string();
        let path = url.split('?').next().unwrap_or("/").to_string();
        if path == "/poll" {
            let after: usize = url.split("after=").nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
            let log = log.clone();
            std::thread::spawn(move || {
                let (m, cv) = &*log;
                let mut g = m.lock().unwrap();
                if g.len() <= after {
                    g = cv.wait_timeout(g, std::time::Duration::from_millis(1000)).unwrap().0;
                }
                let items: Vec<String> = g.iter().skip(after).cloned().collect();
                let body = format!("{{\"next\":{},\"events\":[{}]}}", g.len(), items.join(","));
                drop(g);
                let _ = req.respond(Response::from_string(body).with_header(h("Content-Type", "application/json")));
            });
            continue;
        }
        if let Some(cmd) = path.strip_prefix("/invoke/") {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let a: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
            let eng = engine.clone();
            let saved = saved.clone();
            let cmd = cmd.to_string();
            std::thread::spawn(move || {
                let lang = |v: &serde_json::Value| match v.as_str() { Some("en") => LangMode::En, Some("es") => LangMode::Es, _ => LangMode::Auto };
                let r: Result<serde_json::Value, String> = match cmd.as_str() {
                    "start" => {
                        let o = &a["opts"];
                        eng.start(StartOptions { source: Source::Mic, lang: lang(&o["lang"]), light: o["light"].as_bool().unwrap_or(false) }).map(|_| serde_json::Value::Null)
                    }
                    "pause" => { eng.pause(); Ok(serde_json::Value::Null) }
                    "resume" => eng.resume(Source::Mic).map(|_| serde_json::Value::Null),
                    "end" => { eng.end(); Ok(serde_json::Value::Null) }
                    "free_gpu" => { eng.free_gpu(); Ok(serde_json::Value::Null) }
                    "set_lang" => { eng.set_lang(lang(&a["lang"])); Ok(serde_json::Value::Null) }
                    "set_hints" => {
                        let t: Vec<String> = a["terms"].as_array().map(|x| x.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
                        eng.set_hints(t);
                        Ok(serde_json::Value::Null)
                    }
                    "retranscribe" => Ok(serde_json::json!(eng.retranscribe(a["seg"].as_u64().unwrap_or(0), lang(&a["lang"])))),
                    "diagnostics" => Ok(serde_json::json!(eng.diagnostics())),
                    "models_ready" => Ok(serde_json::json!(true)),
                    "prepare_models" => Ok(serde_json::Value::Null),
                    "storage" => Ok(serde_json::json!({"app": 20_000_000, "models": 700_000_000, "config": 2048, "webview": 0, "folder": "(test)"})),
                    "cleanup" => Ok(serde_json::json!({"freed_mb": 0})),
                    "save_config" => { *saved.lock().unwrap() = a["data"].as_str().unwrap_or("{}").to_string(); Ok(serde_json::Value::Null) }
                    "test_saved_config" => Ok(serde_json::json!(*saved.lock().unwrap())),
                    "test_rss" => Ok(serde_json::json!(inturp_core::mem::rss_mb())),
                    _ => Err(format!("unknown command {cmd}")),
                };
                let (code, body) = match r {
                    Ok(v) => (200, serde_json::json!({"result": v})),
                    Err(e) => (500, serde_json::json!({"error": e})),
                };
                let _ = req.respond(Response::from_string(body.to_string()).with_status_code(code).with_header(h("Content-Type", "application/json")));
            });
            continue;
        }
        // modelos de traducción (los mismos archivos que la app sirve con su protocolo models://)
        if let Some(rest) = path.strip_prefix("/models/") {
            let home = inturp_core::paths::models_dir();
            let resp = if rest == "bergamot/registry.json" {
                // mismo registro que arma la app (direcciones de este mismo servidor)
                let mut reg = serde_json::Map::new();
                let spec = inturp_core::models::spec(inturp_core::models::ModelId::Bergamot);
                for pair in ["esen", "enes"] {
                    let mut files = serde_json::Map::new();
                    for f in spec.files.iter().filter(|f| f.rel.starts_with(&format!("bergamot/{pair}/"))) {
                        let part = if f.rel.contains("vocab") { "vocab" } else if f.rel.contains("lex") { "lex" } else { "model" };
                        files.insert(part.into(), serde_json::json!({ "name": format!("/models/{}", f.rel), "size": f.size, "expectedSha256Hash": f.sha256 }));
                    }
                    reg.insert(pair.into(), serde_json::Value::Object(files));
                }
                Response::from_string(serde_json::Value::Object(reg).to_string()).with_header(h("Content-Type", "application/json"))
            } else {
                match std::fs::read(home.join(rest)) {
                    Ok(b) if !rest.contains("..") => Response::from_data(b),
                    _ => Response::from_string("").with_status_code(404),
                }
            };
            let _ = req.respond(resp);
            continue;
        }
        let rel = if path == "/" { "index.html".to_string() } else { path.trim_start_matches('/').to_string() };
        let file = ui.join(&rel);
        let ct = match file.extension().and_then(|e| e.to_str()) {
            Some("html") => "text/html; charset=utf-8",
            Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
            Some("css") => "text/css; charset=utf-8",
            Some("wasm") => "application/wasm",
            Some("png") => "image/png",
            _ => "application/octet-stream",
        };
        // misma política de seguridad que la app (tauri.conf.json), con 'self' en lugar del IPC
        let csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'";
        match std::fs::read(&file) {
            Ok(b) if !rel.contains("..") => { let _ = req.respond(Response::from_data(b).with_header(h("Content-Type", ct)).with_header(h("Content-Security-Policy", csp))); }
            _ => { let _ = req.respond(Response::from_string("not found").with_status_code(404)); }
        }
    }
}
