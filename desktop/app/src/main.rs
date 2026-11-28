//! Inturpreneur — aplicación de escritorio.
//! Ventana nativa (WebView2) con la interfaz empaquetada + núcleo en Rust (audio, whisper.cpp).
//! La interfaz habla con el núcleo solo por el IPC interno: no se abren puertos de red.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use inturp_core::audio::Source;
use inturp_core::models::{self, ModelId};
use inturp_core::{paths, Engine, Event, LangMode, StartOptions};
use std::borrow::Cow;
use std::sync::Arc;
use tauri::http::{Response, StatusCode};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

struct AppState {
    engine: Arc<Engine>,
}

type Res<T> = Result<T, String>;

// ───────────── Comandos (IPC) ─────────────

#[tauri::command]
async fn start(state: tauri::State<'_, AppState>, opts: StartOptions) -> Res<()> {
    let e = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || e.start(opts)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn pause(state: tauri::State<'_, AppState>) {
    state.engine.pause();
}

#[tauri::command]
async fn resume(state: tauri::State<'_, AppState>, source: Source) -> Res<()> {
    let e = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || e.resume(source)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn end(state: tauri::State<'_, AppState>) {
    state.engine.end();
}

#[tauri::command]
fn free_gpu(state: tauri::State<'_, AppState>) {
    state.engine.free_gpu();
}

#[tauri::command]
fn set_lang(state: tauri::State<'_, AppState>, lang: LangMode) {
    state.engine.set_lang(lang);
}

#[tauri::command]
fn set_hints(state: tauri::State<'_, AppState>, terms: Vec<String>) {
    state.engine.set_hints(terms);
}

#[tauri::command]
fn retranscribe(state: tauri::State<'_, AppState>, seg: u64, lang: LangMode) -> bool {
    state.engine.retranscribe(seg, lang)
}

#[tauri::command]
fn diagnostics(state: tauri::State<'_, AppState>) -> String {
    state.engine.diagnostics()
}

/// Descarga los modelos que falten (una sola vez). Se usa al abrir la app por primera vez.
#[tauri::command]
async fn prepare_models(state: tauri::State<'_, AppState>, light: bool) -> Res<()> {
    let e = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut ids = vec![ModelId::Base, ModelId::Bergamot];
        let gpu = inturp_core::asr::gpus().first().map(|g| g.vram_total_mb >= 3000).unwrap_or(false);
        ids.push(if gpu && !light { ModelId::Turbo } else { ModelId::Small });
        for id in ids {
            if !models::is_present(id) {
                e.download(id)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn models_ready() -> bool {
    models::is_present(ModelId::Base) && models::is_present(ModelId::Bergamot)
}

#[derive(serde::Serialize)]
struct Storage {
    app: u64,
    models: u64,
    config: u64,
    webview: u64,
    folder: String,
}

#[tauri::command]
fn storage() -> Storage {
    let home = paths::home();
    let models = paths::dir_size(&paths::models_dir());
    let webview = paths::dir_size(&paths::webview_dir());
    let config = std::fs::metadata(paths::config_file()).map(|m| m.len()).unwrap_or(0);
    let total = paths::dir_size(&home);
    Storage { app: total.saturating_sub(models + webview + config), models, config, webview, folder: home.display().to_string() }
}

#[derive(serde::Serialize)]
struct Cleaned {
    freed_mb: u64,
}

#[tauri::command]
fn cleanup() -> Cleaned {
    let freed = models::cleanup() + clean_webview_cache();
    Cleaned { freed_mb: freed / 1_048_576 }
}

#[tauri::command]
fn save_config(data: String) -> Res<()> {
    write_config(&data, None)
}

// ───────────── Configuración (un solo archivo) ─────────────

const CONFIG_KEYS: &[&str] = &["inturp.cfg", "inturp.fixes", "inturp.myterms", "inturp.cards", "inturp.cardOverrides", "inturp.gloss", "inturp.lastEs"];

fn read_config() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(paths::config_file())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Guarda preferencias, vocabulario y tarjetas (y el tamaño de la ventana). Nunca texto de llamadas:
/// solo se aceptan las claves conocidas.
fn write_config(ui_json: &str, window: Option<serde_json::Value>) -> Res<()> {
    if ui_json.len() > 4 * 1024 * 1024 {
        return Err("settings too large".into());
    }
    let mut cur = read_config();
    if !ui_json.is_empty() {
        let v: serde_json::Value = serde_json::from_str(ui_json).map_err(|e| e.to_string())?;
        let obj = v.as_object().ok_or("invalid settings")?;
        for k in CONFIG_KEYS {
            match obj.get(*k) {
                Some(x) => {
                    cur.insert(k.to_string(), x.clone());
                }
                None => {
                    cur.remove(*k);
                }
            }
        }
    }
    if let Some(w) = window {
        cur.insert("_window".into(), w);
    }
    let path = paths::config_file();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&cur).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Caché de WebView2: se borra al abrir y al cerrar (nunca contiene datos de llamadas).
fn clean_webview_cache() -> u64 {
    let base = paths::webview_dir().join("Default");
    let mut freed = 0;
    for d in ["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker", "blob_storage", "Session Storage", "Local Storage", "IndexedDB", "WebStorage", "Crashpad"] {
        let p = base.join(d);
        if p.exists() {
            freed += paths::dir_size(&p);
            let _ = std::fs::remove_dir_all(&p);
        }
    }
    for d in ["GrShaderCache", "ShaderCache", "Crashpad", "component_crx_cache", "extensions_crx_cache"] {
        let p = paths::webview_dir().join(d);
        if p.exists() {
            freed += paths::dir_size(&p);
            let _ = std::fs::remove_dir_all(&p);
        }
    }
    freed
}

/// Protocolo `models://` — sirve, solo para lectura, los modelos de traducción de la carpeta de la app.
fn serve_model(req: &tauri::http::Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let not_found = || Response::builder().status(StatusCode::NOT_FOUND).body(Cow::Borrowed(&b""[..])).unwrap();
    let path = req.uri().path().trim_start_matches('/');
    // solo archivos de traducción, sin ".." ni rutas absolutas
    if !path.starts_with("bergamot/") || path.contains("..") || path.contains('\\') {
        return not_found();
    }
    if path == "bergamot/registry.json" {
        // registro con direcciones absolutas de este mismo protocolo
        let origin = format!("{}://{}/", req.uri().scheme_str().unwrap_or("models"), req.uri().host().unwrap_or("localhost"));
        let mut reg = serde_json::Map::new();
        let spec = models::spec(ModelId::Bergamot);
        for pair in ["esen", "enes"] {
            let mut files = serde_json::Map::new();
            for f in spec.files.iter().filter(|f| f.rel.starts_with(&format!("bergamot/{pair}/"))) {
                let part = if f.rel.contains("vocab") { "vocab" } else if f.rel.contains("lex") { "lex" } else { "model" };
                files.insert(part.into(), serde_json::json!({ "name": format!("{origin}{}", f.rel), "size": f.size, "expectedSha256Hash": f.sha256 }));
            }
            reg.insert(pair.into(), serde_json::Value::Object(files));
        }
        return Response::builder()
            .header("Content-Type", "application/json")
            .header("Access-Control-Allow-Origin", "*")
            .body(Cow::Owned(serde_json::to_vec(&reg).unwrap()))
            .unwrap();
    }
    match std::fs::read(paths::models_dir().join(path)) {
        Ok(bytes) => Response::builder()
            .header("Content-Type", "application/octet-stream")
            .header("Access-Control-Allow-Origin", "*")
            .body(Cow::Owned(bytes))
            .unwrap(),
        Err(_) => not_found(),
    }
}

/// Prueba de humo sin ventana (CI de Windows): arranca el núcleo, transcribe un WAV y termina.
/// Uso: Inturpreneur.exe --smoke <archivo.wav> <resultado.json>
fn smoke(wav: &str, out: &str) -> i32 {
    use std::sync::Mutex;
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let ev2 = events.clone();
    let t0 = std::time::Instant::now();
    let eng = Engine::new(Arc::new(move |e: Event| {
        let mut v = serde_json::to_value(&e).unwrap();
        v["t"] = serde_json::json!(t0.elapsed().as_millis() as u64);
        ev2.lock().unwrap().push(v);
    }), Some(wav.into()), false);
    let r = eng.start(StartOptions { source: Source::Mic, lang: LangMode::Auto, light: false });
    let ok_start = r.is_ok();
    if ok_start {
        std::thread::sleep(std::time::Duration::from_secs(2));
        eng.wait_idle(std::time::Duration::from_secs(600));
        std::thread::sleep(std::time::Duration::from_secs(2));
        eng.wait_idle(std::time::Duration::from_secs(600));
    }
    let rss_call = inturp_core::mem::rss_mb();
    eng.end();
    std::thread::sleep(std::time::Duration::from_secs(3));
    let rss_end = inturp_core::mem::rss_mb();
    let evs = events.lock().unwrap().clone();
    let finals = evs.iter().filter(|e| e["type"] == "final").count();
    let report = serde_json::json!({
        "start": r.err(),
        "finals": finals,
        "rss_call_mb": rss_call,
        "rss_after_end_mb": rss_end,
        "seconds": t0.elapsed().as_secs_f64(),
        "diagnostics": eng.diagnostics(),
        "events": evs,
    });
    let _ = std::fs::write(out, serde_json::to_vec_pretty(&report).unwrap());
    eng.shutdown();
    if ok_start && finals > 0 {
        0
    } else {
        1
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--smoke" {
        std::process::exit(smoke(&args[2], &args[3]));
    }
    let _ = std::fs::create_dir_all(paths::home());
    clean_webview_cache();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .register_uri_scheme_protocol("models", |_ctx, req| serve_model(&req))
        .invoke_handler(tauri::generate_handler![
            start, pause, resume, end, free_gpu, set_lang, set_hints, retranscribe, diagnostics, prepare_models, models_ready, storage, cleanup, save_config
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let engine = Engine::new(Arc::new(move |e: Event| {
                let _ = handle.emit("core", e);
            }), std::env::var_os("INTURP_TEST_WAV").map(Into::into), true);
            app.manage(AppState { engine });

            let mut cfg = read_config();
            let win = cfg.remove("_window");
            let models_base = if cfg!(windows) { "http://models.localhost/" } else { "models://localhost/" };
            let boot = serde_json::json!({ "cfg": cfg, "modelsBase": models_base, "version": env!("CARGO_PKG_VERSION") });
            let init = format!("window.__INTURP_BOOT = {};", boot);

            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Inturpreneur")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // WebView2 crea su perfil "EBWebView" dentro de la carpeta de la app
                .data_directory(paths::home())
                .initialization_script(&init)
                .visible(false);
            #[cfg(windows)]
            {
                // caché de disco mínima; sin SmartScreen ni funciones en línea del navegador
                b = b.additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,AutofillServerCommunication,OptimizationHints --disk-cache-size=1 --no-pings --disable-background-networking --disable-component-update --disable-domain-reliability");
            }
            if let Some(w) = win {
                if let (Some(wd), Some(ht)) = (w["w"].as_f64(), w["h"].as_f64()) {
                    b = b.inner_size(wd.max(900.0), ht.max(600.0));
                }
                if let (Some(x), Some(y)) = (w["x"].as_f64(), w["y"].as_f64()) {
                    b = b.position(x, y);
                }
                if w["max"].as_bool() == Some(true) {
                    b = b.maximized(true);
                }
            }
            let window = b.build()?;
            let _ = window.show();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // recuerda tamaño y posición de la ventana
                let sf = window.scale_factor().unwrap_or(1.0);
                let max = window.is_maximized().unwrap_or(false);
                if let (Ok(p), Ok(s)) = (window.outer_position(), window.inner_size()) {
                    let p = p.to_logical::<f64>(sf);
                    let s = s.to_logical::<f64>(sf);
                    let _ = write_config("", Some(serde_json::json!({ "x": p.x, "y": p.y, "w": s.width, "h": s.height, "max": max })));
                }
                // termina la llamada: borra todo y libera la GPU
                if let Some(st) = window.app_handle().try_state::<AppState>() {
                    st.engine.shutdown();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Inturpreneur could not start")
        .run(|_app, ev| {
            if let tauri::RunEvent::Exit = ev {
                clean_webview_cache();
            }
        });
}
