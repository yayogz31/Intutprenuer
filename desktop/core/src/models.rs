//! Catálogo de modelos y descarga única con verificación SHA-256.
//! Los modelos nunca van dentro del ejecutable: se bajan la primera vez a `<carpeta>/models`.
//! La descarga solo pide el archivo; no envía ningún dato del usuario.

use crate::paths;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelId {
    /// Modelo rápido (texto inmediato), en CPU.
    Base,
    /// Modelo preciso para GPU.
    Turbo,
    /// Modelo preciso sin GPU, o "Light mode".
    Small,
    /// Traducción ES→EN y EN→ES (Bergamot).
    Bergamot,
}

pub struct FileSpec {
    pub rel: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

pub struct ModelSpec {
    pub id: ModelId,
    pub label: &'static str,
    pub files: &'static [FileSpec],
}

macro_rules! hf {
    ($f:literal) => {
        concat!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/", $f)
    };
}
// Modelos de traducción: los mismos que usa la página (Mozilla, MPL-2.0), publicados en la
// sección Releases de este repositorio para que la app no dependa de la página.
macro_rules! gh {
    ($f:literal) => {
        concat!("https://github.com/yayogz31/Intutprenuer/releases/download/models-v1/", $f)
    };
}

pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: ModelId::Base,
        label: "Fast engine (Whisper base)",
        files: &[FileSpec {
            rel: "ggml-base-q5_1.bin",
            url: hf!("ggml-base-q5_1.bin"),
            sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
            size: 59_707_625,
        }],
    },
    ModelSpec {
        id: ModelId::Turbo,
        label: "Accuracy engine (Whisper large-v3-turbo)",
        files: &[FileSpec {
            rel: "ggml-large-v3-turbo-q5_0.bin",
            url: hf!("ggml-large-v3-turbo-q5_0.bin"),
            sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
            size: 574_041_195,
        }],
    },
    ModelSpec {
        id: ModelId::Small,
        label: "Light accuracy engine (Whisper small)",
        files: &[FileSpec {
            rel: "ggml-small-q5_1.bin",
            url: hf!("ggml-small-q5_1.bin"),
            sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
            size: 190_085_487,
        }],
    },
    ModelSpec {
        id: ModelId::Bergamot,
        label: "Translation (Spanish ⇄ English)",
        files: &[
            FileSpec { rel: "bergamot/esen/vocab.esen.spm", url: gh!("vocab.esen.spm"), sha256: "909b1eea1face0d7f90a474fe29a8c0fef8d104b6e41e65616f864c964ba8845", size: 825_463 },
            FileSpec { rel: "bergamot/esen/lex.50.50.esen.s2t.bin", url: gh!("lex.50.50.esen.s2t.bin"), sha256: "f11a2c23ef85ab1fee1c412b908d69bc20d66fd59faa8f7da5a5f0347eddf969", size: 3_860_888 },
            FileSpec { rel: "bergamot/esen/model.esen.intgemm.alphas.bin", url: gh!("model.esen.intgemm.alphas.bin"), sha256: "4b6b7f451094aaa447d012658af158ffc708fc8842dde2f871a58404f5457fe0", size: 17_140_755 },
            FileSpec { rel: "bergamot/enes/vocab.esen.spm", url: gh!("vocab.esen.spm"), sha256: "909b1eea1face0d7f90a474fe29a8c0fef8d104b6e41e65616f864c964ba8845", size: 825_463 },
            FileSpec { rel: "bergamot/enes/lex.50.50.enes.s2t.bin", url: gh!("lex.50.50.enes.s2t.bin"), sha256: "3a113d713dec3cf1d12bba5b138ae616e28bba4bbc7fe7fd39ba145e26b86d7f", size: 3_347_104 },
            FileSpec { rel: "bergamot/enes/model.enes.intgemm.alphas.bin", url: gh!("model.enes.intgemm.alphas.bin"), sha256: "fa7460037a3163e03fe1d23602f964bff2331da6ee813637e092ddf37156ef53", size: 17_140_755 },
        ],
    },
];

pub fn spec(id: ModelId) -> &'static ModelSpec {
    CATALOG.iter().find(|m| m.id == id).expect("modelo en el catálogo")
}

pub fn path_of(f: &FileSpec) -> PathBuf {
    paths::models_dir().join(f.rel)
}

/// Ruta del archivo principal de un modelo de Whisper.
pub fn main_file(id: ModelId) -> PathBuf {
    path_of(&spec(id).files[0])
}

/// ¿Está completo? (existe y con el tamaño exacto; el hash se comprobó al descargar)
pub fn is_present(id: ModelId) -> bool {
    spec(id).files.iter().all(|f| std::fs::metadata(path_of(f)).map(|m| m.len() == f.size).unwrap_or(false))
}

pub fn total_size(id: ModelId) -> u64 {
    spec(id).files.iter().map(|f| f.size).sum()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Progress {
    pub model: ModelId,
    pub label: &'static str,
    pub done: u64,
    pub total: u64,
    pub pct: u32,
}

/// Descarga lo que falte de un modelo. Escribe en `tmp/` y solo mueve el archivo a su lugar
/// cuando el SHA-256 coincide. Si se cancela o falla, borra lo descargado a medias.
pub fn ensure(id: ModelId, cancel: &Arc<AtomicBool>, on_progress: &dyn Fn(Progress)) -> Result<(), String> {
    // una descarga a la vez (el arranque y la preparación inicial pueden pedir el mismo modelo)
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let s = spec(id);
    let total = total_size(id);
    let mut done: u64 = s.files.iter().filter(|f| std::fs::metadata(path_of(f)).map(|m| m.len() == f.size).unwrap_or(false)).map(|f| f.size).sum();
    if done == total {
        return Ok(());
    }
    let tmp = paths::tmp_dir();
    std::fs::create_dir_all(&tmp).map_err(|e| format!("cannot create folder: {e}"))?;
    let mut last_pct = u32::MAX;
    let mut report = |done: u64| {
        let pct = ((done as f64 / total.max(1) as f64) * 100.0) as u32;
        if pct != last_pct {
            last_pct = pct;
            on_progress(Progress { model: id, label: s.label, done, total, pct });
        }
    };
    report(done);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(std::time::Duration::from_secs(20)))
        .user_agent("Inturpreneur")
        .build()
        .into();
    for f in s.files {
        let dest = path_of(f);
        if std::fs::metadata(&dest).map(|m| m.len() == f.size).unwrap_or(false) {
            continue;
        }
        let part = tmp.join(format!("{}.part", f.rel.replace(['/', '\\'], "_")));
        let res = (|| -> Result<(), String> {
            let resp = agent.get(f.url).call().map_err(|e| format!("download failed: {e}"))?;
            let mut body = resp.into_body();
            let mut rd = body.as_reader();
            let mut out = std::fs::File::create(&part).map_err(|e| format!("cannot write: {e}"))?;
            let mut h = Sha256::new();
            let mut buf = vec![0u8; 1 << 16];
            let mut got: u64 = 0;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
                let n = rd.read(&mut buf).map_err(|e| format!("download interrupted: {e}"))?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n]).map_err(|e| format!("cannot write: {e}"))?;
                h.update(&buf[..n]);
                got += n as u64;
                report(done + got);
            }
            out.sync_all().ok();
            drop(out);
            let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
            if got != f.size || hex != f.sha256 {
                return Err("the downloaded file is damaged (checksum mismatch)".into());
            }
            if let Some(d) = dest.parent() {
                std::fs::create_dir_all(d).map_err(|e| format!("cannot create folder: {e}"))?;
            }
            std::fs::rename(&part, &dest).map_err(|e| format!("cannot save: {e}"))?;
            done += f.size;
            Ok(())
        })();
        if let Err(e) = res {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_dir(&tmp);
            return Err(e);
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    report(total);
    Ok(())
}

/// Limpieza al arrancar: restos de descargas a medias y modelos que ya no están en el catálogo.
pub fn cleanup() -> u64 {
    let mut freed = 0;
    let tmp = paths::tmp_dir();
    if tmp.exists() {
        freed += paths::dir_size(&tmp);
        let _ = std::fs::remove_dir_all(&tmp);
    }
    let dir = paths::models_dir();
    let known: std::collections::HashSet<PathBuf> = CATALOG.iter().flat_map(|m| m.files.iter().map(path_of)).collect();
    fn walk(p: &std::path::Path, known: &std::collections::HashSet<PathBuf>, freed: &mut u64) {
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    walk(&path, known, freed);
                    let _ = std::fs::remove_dir(&path); // solo si quedó vacía
                } else if !known.contains(&path) {
                    *freed += e.metadata().map(|m| m.len()).unwrap_or(0);
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
    walk(&dir, &known, &mut freed);
    freed
}
