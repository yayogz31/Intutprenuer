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
let asrPromise = null, mode = "cpu", forceCpu = false;
const queue = [];
let busy = false;

/** Si la computadora tiene GPU compatible (WebGPU), el codificador de Whisper (la parte pesada) corre ahí:
 *  suele ser 3–10 veces más rápido. El decodificador sigue en el procesador. Si algo falla, se usa solo el procesador. */
async function gpuConfig() {
  try {
    if (forceCpu || !self.navigator || !navigator.gpu) return null;
    const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!ad) return null;
    // los adaptadores "de software" (sin tarjeta de video real) son mucho más lentos que el procesador
    if (ad.isFallbackAdapter || (ad.info && ad.info.isFallbackAdapter) || /swiftshader|llvmpipe|software|basic render/i.test(((ad.info && (ad.info.description + " " + ad.info.architecture + " " + ad.info.vendor)) || ""))) return null;
    const f16 = ad.features.has("shader-f16");
    const file = f16 ? "encoder_model_fp16.onnx" : "encoder_model.onnx";
    const r = await fetch(env.localModelPath + MODEL + "/onnx/" + file, { method: "HEAD" });
    if (!r.ok) return null;
    return { device: { encoder_model: "webgpu", decoder_model_merged: "wasm" }, dtype: { encoder_model: f16 ? "fp16" : "fp32", decoder_model_merged: "q8" }, mode: f16 ? "gpu-fp16" : "gpu" };
  } catch { return null; }
}

function getAsr() {
  if (!asrPromise) {
    const files = {};
    const progress_callback = (p) => {
      if (p.status === "progress" && p.total) {
        files[p.file] = [p.loaded, p.total];
        let l = 0, t = 0; for (const [a, b] of Object.values(files)) { l += a; t += b; }
        self.postMessage({ type: "progress", pct: Math.round((l / t) * 100), mb: Math.round(t / 1e6) });
      }
    };
    asrPromise = (async () => {
      const gpu = await gpuConfig();
      if (gpu) {
        let p = null;
        try {
          p = await pipeline("automatic-speech-recognition", MODEL, { device: gpu.device, dtype: gpu.dtype, progress_callback });
          const probe = { language: "english", task: "transcribe", max_new_tokens: 4 };
          await p(new Float32Array(16000), probe);            // 1.ª vez: compila
          const t0 = performance.now();
          await p(new Float32Array(16000), probe);            // 2.ª vez: mide la velocidad real
          if (performance.now() - t0 > 1500) throw new Error("GPU slower than expected");  // GPU débil → procesador
          mode = gpu.mode;
          return p;
        } catch (e) { forceCpu = true; try { if (p && p.dispose) await p.dispose(); } catch { /* */ } }
      }
      mode = "cpu";
      return pipeline("automatic-speech-recognition", MODEL, { device: "wasm", dtype: { encoder_model: "q8", decoder_model_merged: "q8" }, progress_callback });
    })().catch((e) => { asrPromise = null; throw e; });
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

async function run(job, retry) {
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
  self.postMessage({ type: "asr", id: job.id, text, ms: Math.round(performance.now() - t0), mode });
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    // si se acumulan frases, se procesan las más recientes primero y se descartan las muy viejas
    while (queue.length > 3) { const old = queue.shift(); self.postMessage({ type: "asr", id: old.id, text: "", skipped: true }); }
    const job = queue.shift();
    // con trabajo pendiente, las frases que el motor rápido ya entendió con mucha seguridad se saltan
    if (queue.length && job.conf >= 0.9) { self.postMessage({ type: "asr", id: job.id, text: "", skipped: true }); continue; }
    try { await run(job); }
    catch (e) {
      if (mode !== "cpu") { forceCpu = true; asrPromise = null; try { await run(job); continue; } catch { /* */ } }
      self.postMessage({ type: "error", id: job.id, error: String((e && e.message) || e) });
    }
  }
  busy = false;
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === "load") {
    getAsr().then(() => self.postMessage({ type: "ready", mode }), (err) => self.postMessage({ type: "error", error: String((err && err.message) || err) }));
  } else if (m.type === "asr") {
    queue.push(m);
    pump();
  } else if (m.type === "clear") {
    queue.length = 0;
  }
};
