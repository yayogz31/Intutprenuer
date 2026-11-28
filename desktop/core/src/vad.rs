//! Detector de voz por energía con piso de ruido adaptativo (el mismo principio que la página),
//! con control automático de volumen para audio bajo. Trabaja por bloques de 20 ms.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadEvent {
    None,
    /// Empezó a hablar (incluye ~300 ms previos para no perder el inicio).
    Start,
    /// Terminó la frase por silencio.
    End,
}

pub struct Vad {
    floor: f32,
    pub speaking: bool,
    silent_ms: u32,
    voiced_ms: u32,
    pub gain: f32,
    /// Silencio que cierra una frase.
    pub end_ms: u32,
}

impl Default for Vad {
    fn default() -> Self {
        Vad { floor: 0.004, speaking: false, silent_ms: 0, voiced_ms: 0, gain: 1.0, end_ms: 600 }
    }
}

pub fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

impl Vad {
    /// Procesa un bloque (modifica el audio aplicando la ganancia). Devuelve el evento.
    pub fn push(&mut self, block: &mut [f32]) -> VadEvent {
        let ms = (block.len() * 1000 / crate::asr::SR) as u32;
        let lvl = rms(block);
        // ganancia lenta: solo sube el audio bajo, nunca baja el que ya está bien
        if lvl > 0.006 {
            let want = (0.05 / lvl).clamp(1.0, 6.0);
            let k = if want < self.gain { 0.25 } else { 0.015 };
            self.gain += (want - self.gain) * k;
        }
        for v in block.iter_mut() {
            *v = (*v * self.gain).clamp(-0.98, 0.98);
        }
        let speech = lvl > (self.floor * 3.0).max(0.008);
        if !speech {
            self.floor = self.floor * 0.95 + lvl * 0.05;
        }
        if speech {
            self.silent_ms = 0;
            self.voiced_ms += ms;
            // 60 ms seguidos de voz para empezar (evita clics)
            if !self.speaking && self.voiced_ms >= 60 {
                self.speaking = true;
                return VadEvent::Start;
            }
        } else {
            if !self.speaking {
                self.voiced_ms = 0;
            }
            if self.speaking {
                self.silent_ms += ms;
                if self.silent_ms >= self.end_ms {
                    self.speaking = false;
                    self.voiced_ms = 0;
                    self.silent_ms = 0;
                    return VadEvent::End;
                }
            }
        }
        VadEvent::None
    }

    pub fn reset(&mut self) {
        let g = self.gain;
        let f = self.floor;
        *self = Vad { gain: g, floor: f, ..Default::default() };
    }
}
