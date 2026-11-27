/* Inturpreneur — worker de transcripción precisa (Whisper, 100 % local).
 * Recibe el audio de cada frase ya cerrada (16 kHz) y devuelve una transcripción más precisa.
 * Corre en un hilo aparte para no trabar la página. No envía nada a internet: los modelos
 * se sirven desde este mismo sitio (carpeta models/hf).
 */
import { pipeline, env } from "./vendor/tf/transformers.min.js";

const BASE = new URL("./", self.location.href).href;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = BASE + "models/hf/";
env.useBrowserCache = true;                    // el modelo queda guardado en el navegador tras la 1.ª descarga
env.backends.onnx.wasm.wasmPaths = BASE + "vendor/tf/";
env.backends.onnx.wasm.proxy = false;
// con aislamiento de origen (sw.js) se usan varios núcleos; si no, uno solo
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, ((navigator.hardwareConcurrency || 2) / 2) | 0)) : 1;

const MODEL = "onnx-community/whisper-base";
let asrPromise = null;
const queue = [];
let busy = false;

function getAsr() {
  if (!asrPromise) {
    const files = {};
    asrPromise = pipeline("automatic-speech-recognition", MODEL, {
      device: "wasm",
      dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
      progress_callback: (p) => {
        if (p.status === "progress" && p.total) {
          files[p.file] = [p.loaded, p.total];
          let l = 0, t = 0; for (const [a, b] of Object.values(files)) { l += a; t += b; }
          self.postMessage({ type: "progress", pct: Math.round((l / t) * 100), mb: Math.round(t / 1e6) });
        }
      },
    }).catch((e) => { asrPromise = null; throw e; });
  }
  return asrPromise;
}

// Frases que Whisper a veces "inventa" con ruido o silencio
const HALLUCINATIONS = /(gracias por ver|suscr[ií]bete|subt[ií]tulos|amara\.org|thank you for watching|thanks for watching|please subscribe|like and subscribe)/i;

/** true si el texto repite la misma secuencia muchas veces (señal de alucinación). */
function isRepetitive(text) {
  const w = text.toLowerCase().split(/\s+/);
  if (w.length < 12) return false;
  const seen = new Map();
  for (let i = 0; i + 3 <= w.length; i++) { const k = w.slice(i, i + 3).join(" "); seen.set(k, (seen.get(k) || 0) + 1); }
  return Math.max(...seen.values()) >= 4;
}

async function run(job) {
  const asr = await getAsr();
  const t0 = performance.now();
  const secs = job.audio.length / 16000;
  const out = await asr(job.audio, {
    task: "transcribe",
    language: job.lang === "en" ? "english" : "spanish",   // el idioma lo decide la app (Whisper en el navegador no lo detecta)
    max_new_tokens: Math.min(220, Math.ceil(secs * 7) + 12),
  });
  let text = (out && out.text ? out.text : "").replace(/\s+/g, " ").trim();
  // "otro, otro, otro" → "otro" (palabras repetidas sin sentido)
  text = text.replace(/\b([\p{L}']+)(?:[,.\s]+\1\b){2,}/giu, "$1");
  if (HALLUCINATIONS.test(text) || isRepetitive(text)) text = "";
  self.postMessage({ type: "asr", id: job.id, text, ms: Math.round(performance.now() - t0) });
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    // si se acumulan frases, se procesan las más recientes primero y se descartan las muy viejas
    while (queue.length > 3) { const old = queue.shift(); self.postMessage({ type: "asr", id: old.id, text: "", skipped: true }); }
    const job = queue.shift();
    try { await run(job); }
    catch (e) { self.postMessage({ type: "error", id: job.id, error: String((e && e.message) || e) }); }
  }
  busy = false;
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === "load") {
    getAsr().then(() => self.postMessage({ type: "ready" }), (err) => self.postMessage({ type: "error", error: String((err && err.message) || err) }));
  } else if (m.type === "asr") {
    queue.push(m);
    pump();
  } else if (m.type === "clear") {
    queue.length = 0;
  }
};
