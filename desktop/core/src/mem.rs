//! Memoria usada por el proceso (para el diagnóstico y las pruebas de consumo).

pub fn rss_mb() -> Option<u64> {
    memory_stats::memory_stats().map(|m| (m.physical_mem / 1_048_576) as u64)
}
