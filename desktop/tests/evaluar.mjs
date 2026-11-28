// Evalúa la salida de run_wav (JSONL) contra escenarios.json: WER de palabras y dígitos (nunca perder ni inventar).
// Uso: node evaluar.mjs <escenario> <salida.jsonl>
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
await import(path.join(here, "../ui/keyinfo.js")).catch(() => import(path.join(here, "../../keyinfo.js")));
const [name, file] = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(path.join(here, "escenarios.json"), "utf8"))[name];
const ev = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s) => strip(s).replace(/[$,]/g, " ").replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter((w) => w && !/\d/.test(w));
const digits = (s) => KeyInfo.numberGroups(strip(s).replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/(\d),(\d{3})/g, "$1$2")).map((g) => g.digits).join("");
function wer(ref, hyp) {
  const r = words(ref), h = words(hyp); const d = Array.from({ length: r.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { err: d[r.length][h.length], n: r.length };
}
const segs = new Map();
for (const e of ev) {
  if (e.type === "final") segs.set(e.seg, { fast: e.text, words: e.words, lang: e.lang, group: e.group, lat: e.lat_ms, ref: null });
  if (e.type === "refined" && segs.has(e.seg) && !e.skipped && e.text) {
    if (e.group_segs && e.group_segs.length > 1) {
      // corrección de la fila completa: igual que la interfaz, reemplaza todas sus partes
      const parts = e.group_segs.map((g) => segs.get(g)).filter(Boolean);
      const whole = { text: parts.map((p) => p.fast).join(" "), words: parts.flatMap((p) => p.words || []) };
      const first = parts[0];
      first.rowfix = { text: e.text, whole };
      for (const p of parts.slice(1)) p.covered = first;
      Object.assign(segs.get(e.seg), { rlat: e.lat_ms });
    } else Object.assign(segs.get(e.seg), { refined: e.text, rlang: e.lang, rlat: e.lat_ms, rms: e.ms });
  }
}
// misma regla que la interfaz (app.js → safeRefinement): la corrección solo se acepta si conserva
// todos los dígitos y casi todas las palabras seguras; si no, queda el texto del modelo rápido.
const W = (t) => strip(t).replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
function lev(a, b) { const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 3; const d = Array.from({ length: m + 1 }, (_, i) => [i]); for (let j = 1; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
function safe(part, newText) {
  const wo = W(part.text), wn = W(newText);
  if (!wn.length || wn.length > wo.length * 3 + 12) return false;
  const isNum = (w) => KeyInfo.numberGroups(w).length > 0;
  const sure = (part.vwords ? part.vwords.filter((x) => (x.conf || 0) >= 0.9).map((x) => strip(x.word).replace(/[^\p{L}\p{N}']/gu, "")) : wo).filter((w) => !isNum(w) && w.length > 1);
  const have = new Set(wn);
  const near = (w) => have.has(w) || wn.some((x) => (w.length >= 4 && Math.abs(x.length - w.length) <= 2 && lev(x, w) <= 2) || (w.length >= 3 && x.length >= 3 && x.slice(0, 3) === w.slice(0, 3)));
  const missing = sure.filter((w) => !near(w)).length;
  if (missing > Math.max(2, Math.round(sure.length * 0.5))) return false;
  const dOld = digits(part.text), dNew = digits(newText);
  const subseq = (a, b) => { let i = 0; for (const c of b) if (c === a[i]) i++; return i === a.length; };
  if (dOld.length >= 1 && !subseq(dOld, dNew)) return false;
  const heard = Math.max(dOld.length, (part.text.match(/\d/g) || []).length);
  if (dOld.length >= 1 && dNew.length - heard > Math.max(3, Math.ceil(heard * 0.5))) return false;
  return true;
}
for (const s of segs.values()) s.ui = s.refined && safe({ text: s.fast, vwords: s.words }, s.refined) ? s.refined : s.fast;
for (const s of segs.values()) if (s.rowfix) {
  const parts = [...segs.values()].filter((x) => x === s || x.covered === s);
  const shown = parts.map((x) => x.ui).join(" ");
  if (safe({ text: shown, vwords: s.rowfix.whole.words }, s.rowfix.text)) { s.ui = s.rowfix.text; s.refined = s.rowfix.text; for (const x of parts) if (x !== s) { x.ui = ""; x.refined = ""; } }
}
const S = [...segs.values()];
const ref = sc.parts.map((p) => p.ref).join(" ");
const fast = S.map((s) => s.fast).join(" "), raw = S.map((s) => (s.refined === "" ? "" : s.refined || s.fast)).filter(Boolean).join(" "), best = S.map((s) => s.ui).filter(Boolean).join(" ");
const wf = wer(ref, fast), wb = wer(ref, best), wr = wer(ref, raw);
const dRef = sc.digits || digits(ref), dFast = digits(fast), dBest = digits(best);
const langs = S.map((s) => (s.rlang || s.lang)).join(",");
const groups = new Set(S.map((s) => s.group)).size;
const lat = S.map((s) => s.lat).filter((x) => x != null), rlat = S.map((s) => s.rlat).filter((x) => x != null);
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const summary = ev.find((e) => e.type === "summary") || {};
const out = {
  escenario: name, frases: S.length, filas: groups, idiomas: langs,
  wer_rapido: +(wf.err / wf.n * 100).toFixed(1), wer_preciso_sin_filtro: +(wr.err / wr.n * 100).toFixed(1), wer_final: +(wb.err / wb.n * 100).toFixed(1), correcciones_aceptadas: S.filter((s) => s.refined && s.ui === s.refined).length + "/" + S.filter((s) => s.refined).length,
  digitos_ok: dBest === dRef, digitos_ref: dRef, digitos_final: dBest, digitos_rapido: dFast,
  latencia_texto_ms: avg(lat), latencia_correccion_ms: avg(rlat),
  ram_llamada_mb: summary.rss_call_mb, ram_pico_mb: summary.rss_peak_mb, ram_tras_end_mb: summary.rss_after_end_mb,
  texto: best,
};
console.log(JSON.stringify(out, null, 1));
