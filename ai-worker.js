/* Inturpreneur — worker de transcripción precisa (Whisper, 100 % local).
 * Recibe el audio de cada frase ya cerrada (16 kHz) y devuelve una transcripción más precisa.
 * Corre en un hilo aparte para no trabar la página. No envía nada a internet: los modelos
 * se sirven desde este mismo sitio (carpeta models/hf).
 */
import { pipeline, env, Tensor } from "./vendor/tf/transformers.min.js";

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
const MODEL_SMALL = "onnx-community/whisper-small";   // más preciso; solo en equipos con GPU rápida (fp16)
let asrPromise = null, mode = "cpu", forceCpu = false, allowSmall = true;
const queue = [];
let busy = false;

// Los archivos de más de 100 MB se publican divididos en partes (GitHub no acepta archivos mayores).
// Aquí se interceptan las descargas de esos archivos y se arman de nuevo a partir de sus partes.
const nativeFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  if (url.includes("/" + MODEL_SMALL + "/onnx/") && url.endsWith(".onnx") && !(init && init.method === "HEAD")) {
    const man = await nativeFetch(url + ".parts.json").catch(() => null);
    if (man && man.ok) {
      const { parts, size } = await man.json();
      const bufs = [];
      for (let i = 0; i < parts; i++) {
        const r = await nativeFetch(`${url}.part${i}`);
        if (!r.ok) throw new Error(`missing part ${i} of ${url}`);
        bufs.push(await r.arrayBuffer());
      }
      return new Response(new Blob(bufs), { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) } });
    }
  }
  return nativeFetch(input, init);
};
const exists = async (path) => { try { const r = await nativeFetch(env.localModelPath + path, { method: "HEAD" }); return r.ok; } catch { return false; } };

/** GPU real disponible (no adaptadores "de software") y si soporta fp16. */
async function gpuInfo() {
  try {
    if (forceCpu || !self.navigator || !navigator.gpu) return null;
    const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!ad) return null;
    if (ad.isFallbackAdapter || (ad.info && ad.info.isFallbackAdapter) || /swiftshader|llvmpipe|software|basic render/i.test(((ad.info && (ad.info.description + " " + ad.info.architecture + " " + ad.info.vendor)) || ""))) return null;
    return { f16: ad.features.has("shader-f16") };
  } catch { return null; }
}

/** Carga un modelo en la GPU y mide su velocidad real; si es lento, lo descarta. */
async function tryGpu(model, dtypeEnc, progress_callback, limitMs) {
  let p = null;
  try {
    p = await pipeline("automatic-speech-recognition", model, { device: { encoder_model: "webgpu", decoder_model_merged: "wasm" }, dtype: { encoder_model: dtypeEnc, decoder_model_merged: "q8" }, progress_callback });
    const probe = { language: "english", task: "transcribe", max_new_tokens: 4 };
    await p(new Float32Array(16000), probe);            // 1.ª vez: compila
    const t0 = performance.now();
    await p(new Float32Array(16000), probe);            // 2.ª vez: mide la velocidad real
    if (performance.now() - t0 > limitMs) throw new Error("GPU slower than expected");
    return p;
  } catch (e) { try { if (p && p.dispose) await p.dispose(); } catch { /* */ } return null; }
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
      const gpu = await gpuInfo();
      if (gpu) {
        // 1) Whisper small en GPU (el más preciso) — solo con fp16 y si los archivos están publicados
        if (allowSmall && gpu.f16 && await exists(MODEL_SMALL + "/onnx/encoder_model_fp16.onnx.parts.json")) {
          const p = await tryGpu(MODEL_SMALL, "fp16", progress_callback, 1800);
          if (p) { mode = "gpu-small"; return p; }
        }
        // 2) Whisper base en GPU
        if (await exists(MODEL + "/onnx/" + (gpu.f16 ? "encoder_model_fp16.onnx" : "encoder_model.onnx"))) {
          const p = await tryGpu(MODEL, gpu.f16 ? "fp16" : "fp32", progress_callback, 1500);
          if (p) { mode = gpu.f16 ? "gpu-fp16" : "gpu"; return p; }
        }
        forceCpu = true;
      }
      // 3) Whisper base en el procesador
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

/** Detector de idioma de Whisper: probabilidad del token <|en|> frente a <|es|> en el primer paso del decodificador. */
async function detectLang(asr, audio) {
  const gc = asr.model.generation_config || {};
  const l2i = gc.lang_to_id || {};
  const sot = gc.decoder_start_token_id ?? 50258, en = l2i["<|en|>"] ?? 50259, es = l2i["<|es|>"] ?? 50262;
  const { input_features } = await asr.processor(audio);
  const r = await asr.model({ input_features, decoder_input_ids: new Tensor("int64", BigInt64Array.from([BigInt(sot)]), [1, 1]) });
  const d = r.logits.data, off = d.length - r.logits.dims.at(-1);
  const diff = d[off + en] - d[off + es];
  return { lang: diff > 0 ? "en" : "es", margin: Math.abs(diff) };
}

async function run(job, retry) {
  const asr = await getAsr();
  const t0 = performance.now();
  const secs = job.audio.length / 16000;
  // modo Auto: si el idioma es dudoso y la frase es suficientemente larga, Whisper confirma el idioma real
  if (job.detect && secs >= 2.5) {
    try { const d = await detectLang(asr, job.audio); if (d.margin > 1 && d.lang !== job.lang) job.lang = d.lang; } catch { /* sigue con el idioma dado */ }
  }
  const out = await asr(job.audio, {
    task: "transcribe",
    language: job.lang === "en" ? "english" : "spanish",   // el idioma lo decide la app (Whisper en el navegador no lo detecta)
    max_new_tokens: Math.min(220, Math.ceil(secs * 7) + 12),
  });
  let text = (out && out.text ? out.text : "").replace(/\s+/g, " ").trim();
  // listas de dígitos que Whisper escribe como ordinales: "6th, 7th, 8th" → "6 7 8"
  text = text.replace(/\b\d{1,2}(?:st|nd|rd|th)(?:,?\s+\d{1,2}(?:st|nd|rd|th))+\b/gi, (m) => m.replace(/(st|nd|rd|th)/gi, "").replace(/,/g, ""));
  // "otro, otro, otro" → "otro" (palabras repetidas sin sentido)
  text = text.replace(/\b([\p{L}']+)(?:[,.\s]+\1\b){2,}/giu, "$1");
  if (HALLUCINATIONS.test(text) || isRepetitive(text)) text = "";
  self.postMessage({ type: "asr", id: job.id, text, lang: job.lang, ms: Math.round(performance.now() - t0), mode });
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    // si se acumulan frases, se procesan las más recientes primero y se descartan las muy viejas
    while (queue.length > 3) { const old = queue.shift(); self.postMessage({ type: "asr", id: old.id, text: "", skipped: true }); }
    const job = queue.shift();
    // con trabajo pendiente, las frases que el motor rápido ya entendió con mucha seguridad se saltan
    if (queue.length && job.conf >= 0.9 && !job.detect) { self.postMessage({ type: "asr", id: job.id, text: "", skipped: true }); continue; }
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
    if (m.allowSmall === false) allowSmall = false;
    if (m.threads) env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(m.threads, navigator.hardwareConcurrency || 2)) : 1;
    getAsr().then(() => self.postMessage({ type: "ready", mode }), (err) => self.postMessage({ type: "error", error: String((err && err.message) || err) }));
  } else if (m.type === "asr") {
    queue.push(m);
    pump();
  } else if (m.type === "clear") {
    queue.length = 0;
  }
};
