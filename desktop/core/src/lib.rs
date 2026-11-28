//! Núcleo nativo de Inturpreneur (sin red durante la llamada; sin archivos de registro).
pub mod asr;
pub mod audio;
pub mod engine;
pub mod mem;
pub mod models;
pub mod paths;
pub mod text;
pub mod vad;

pub use engine::{Engine, Event, LangMode, StartOptions};
