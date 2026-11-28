//! Carpeta única de la app. Todo (modelos, configuración, perfil de WebView2) vive en la carpeta
//! donde está instalado el ejecutable — por defecto `%LOCALAPPDATA%\Inturpreneur`, o la que el usuario
//! eligió al instalar (p. ej. `D:\Inturpreneur`). Nunca se usan rutas fijas.

use std::path::PathBuf;

/// Carpeta base. `INTURP_HOME` la reemplaza (solo para pruebas).
pub fn home() -> PathBuf {
    if let Ok(h) = std::env::var("INTURP_HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn models_dir() -> PathBuf {
    home().join("models")
}

/// Archivo único de configuración del usuario (preferencias, vocabulario, tarjetas).
pub fn config_file() -> PathBuf {
    home().join("config.json")
}

/// Perfil de WebView2 dentro de la misma carpeta (no en `%LOCALAPPDATA%\<id>` aparte).
pub fn webview_dir() -> PathBuf {
    home().join("EBWebView")
}

/// Carpeta temporal propia para descargas a medias; se borra al terminar y al arrancar.
pub fn tmp_dir() -> PathBuf {
    home().join("tmp")
}

/// Tamaño total de una carpeta en bytes.
pub fn dir_size(p: &std::path::Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            match e.metadata() {
                Ok(m) if m.is_dir() => total += dir_size(&e.path()),
                Ok(m) => total += m.len(),
                Err(_) => {}
            }
        }
    }
    total
}
