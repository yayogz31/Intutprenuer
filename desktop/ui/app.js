/* Inturpreneur — asistente de interpretación en vivo (aplicación de escritorio).
 * La interfaz es la de la página, empaquetada dentro de la app. El audio y el reconocimiento los hace el
 * núcleo nativo (whisper.cpp) y llegan por el IPC interno (native.js). Nada del texto de la llamada se guarda:
 * vive solo en memoria y en pantalla, y se borra al presionar End o cerrar la app.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const DOMS = ["medico", "legal", "bancario", "seguros"];
  const DOM_LABEL = { medico: "Medical", legal: "Legal", bancario: "Banking", seguros: "Insurance", duda: "Question", general: "General", aviso: "Disclosure", tarjeta: "Card", confirm: "Read back", verify: "Verify", policy: "Not allowed", interp: "To interpreter" };
  const TAB_FOR_DOM = { medico: "Medical", legal: "Legal", bancario: "Banking", seguros: "Insurance" };

  // ───────────────── Utilidades ─────────────────
  const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** Normaliza conservando un mapa de posiciones normalizado→original (para resaltar). */
  function normMap(s) {
    let out = ""; const map = [];
    for (let i = 0; i < s.length; i++) {
      const n = strip(s[i]);
      for (let k = 0; k < n.length; k++) { out += n[k]; map.push(i); }
    }
    map.push(s.length);
    return { out, map };
  }
  // Preferencias, vocabulario y tarjetas: un solo archivo de configuración en la carpeta de la app.
  const store = window.Native.store;
  let toastT;
  function toast(msg, ms) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms || 1300);
  }
  function notice(msg, isErr) {
    const n = $("notice");
    if (!msg) { n.hidden = true; n.textContent = ""; return; }
    n.textContent = msg; n.className = "notice" + (isErr ? " err" : ""); n.hidden = false;
  }
  async function copy(text) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch {
      // dentro de una ventana abierta (diálogo) el resto de la página está bloqueada: el texto se pone en la ventana
      const host = document.querySelector("dialog[open]") || document.body;
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      host.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    toast(ok ? "Copied" : "Could not copy automatically — select the text and press Ctrl+C");
    return ok;
  }

  // ───────────────── Configuración (solo preferencias, nunca texto de llamadas) ─────────────────
  const cfg = Object.assign({ name: "", id: "", local: false, lang: "auto", source: "system", light: false, translate: true, audience: "provider", precise: true, mask: true, fontSize: 15, collapsed: {}, perf: "auto", whisperSmall: true, cols: "orig" }, store.get("inturp.cfg", {}));

  // ───────────────── Perfil de rendimiento (se adapta a cada dispositivo) ─────────────────
  // Lite: sin Whisper, menos trabajo en vivo (equipos modestos).  Balanced: Whisper solo corrige frases dudosas.
  // Max: Whisper corrige todas las frases. "auto" elige según núcleos y memoria del equipo.
  const PERF = {
    lite:     { label: "Lite",     whisper: "off", interimMs: 150, interimTrMs: 1200, threads: 1 },
    balanced: { label: "Balanced", whisper: "low", interimMs: 80,  interimTrMs: 550,  threads: 3 },
    max:      { label: "Max",      whisper: "all", interimMs: 40,  interimTrMs: 250,  threads: 4 },
  };
  function detectPerf() {
    const c = navigator.hardwareConcurrency || 4, m = navigator.deviceMemory || 8;
    if (c <= 2 || m <= 4) return "lite";
    if (c >= 8 && m >= 8) return "max";
    return "balanced";
  }
  const perfKey = () => (PERF[cfg.perf] ? cfg.perf : detectPerf());
  const P = () => PERF[perfKey()];
  const LOW_CONF = 0.85, UNCLEAR_CONF = 0.55;
  const saveCfg = () => store.set("inturp.cfg", cfg);

  // ───────────────── Glosario e índice de términos ─────────────────
  let glossary = [];
  let termIndex = new Map();   // clave normalizada → entrada
  let termRe = null;
  const kwRe = {};

  function normDom(d) {
    d = strip(String(d || "")).trim();
    if (/^(med|salud|health|clin)/.test(d)) return "medico";
    if (/^(leg|jur|law|court)/.test(d)) return "legal";
    if (/^(ban|fin|bank|money|credit)/.test(d)) return "bancario";
    if (/^(seg|ins|auto|car|veh|tran)/.test(d)) return "seguros";
    return "general";
  }
  // "My terms": palabras propias con su traducción preferida (tienen prioridad y se aplican a la traducción automática)
  let myTerms = store.get("inturp.myterms", []);
  // Correcciones de transcripción aprendidas ("carrot her" → "character"): se aplican a todo texto nuevo
  let fixes = store.get("inturp.fixes", []);
  let fixRes = [];
  function buildFixes() {
    fixRes = fixes.filter((f) => f.heard && f.correct).map((f) => ({ re: new RegExp(`(?<![\\p{L}\\p{N}])${reEsc(f.heard.trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu"), to: f.correct.trim() }));
  }
  function applyFixes(t) { for (const f of fixRes) t = t.replace(f.re, f.to); return t; }
  function loadGlossary() {
    const extra = store.get("inturp.gloss", null);
    const base = (window.GLOSARIO_BASE || []).map((e) => ({ ...e, dom: normDom(e.dom) }));
    const mine = myTerms.map((m) => ({ t: m.en, tr: m.es, d: m.note || (m.acronym ? "Your acronym" : "Your preferred translation"), dom: normDom(m.dom), mine: true }));
    glossary = mine.concat(extra ? (extra.replace ? extra.items : base.concat(extra.items)) : base);
    buildIndex();
    mtCache.clear(); prefCache = null;
  }
  /** Cómo traduce la máquina un término suelto (para luego cambiarlo por tu traducción preferida). */
  const mtCache = new Map();
  function mtRendering(term, from) {
    const k = from + ":" + term;
    if (!mtCache.has(k)) mtCache.set(k, translateRaw(term, from).then((t) => (t || "").replace(/[.!?¡¿"]/g, "").trim()).catch(() => ""));
    return mtCache.get(k);
  }
  /** Traducciones que se deben respetar: tus términos (Vocabulary), las integradas y los términos de varias
   *  palabras de tu glosario. Variantes alineadas por posición (inglés "a / b" ↔ español "A, B"). */
  let prefCache = null;
  function prefCandidates(from) {
    if (!prefCache) {
      const list = []; const seen = new Set();
      const add = (en, es, src) => {
        const enV = String(en).split(" / ").map((x) => x.replace(/\(.*?\)/g, "").trim()).filter((x) => x.length > 1);
        const esV = String(es).split(/[,/]/).map((x) => x.trim()).filter((x) => x.length > 1);
        if (!enV.length || !esV.length || seen.has(strip(enV[0]))) return;
        seen.add(strip(enV[0])); list.push({ enV, esV, src });
      };
      myTerms.forEach((m) => add(m.en, m.es, "mine"));
      (window.TRADUCCIONES_PREFERIDAS || []).forEach((b) => add(b.en, b.es, "builtin"));
      for (const g of window.GLOSARIO_BASE || []) if (g.dom !== "general") add(g.t, g.tr, "gloss");
      prefCache = list;
    }
    const cands = [];
    for (const e of prefCache) {
      const srcV = from === "en" ? e.enV : e.esV, dstV = from === "en" ? e.esV : e.enV;
      srcV.forEach((v, i) => {
        // del glosario solo se fuerzan términos de 2+ palabras (las palabras sueltas el traductor ya las resuelve bien)
        if (e.src === "gloss" && v.split(/\s+/).length < 2) return;
        let want = dstV[i] || dstV[0];
        if (e.src === "gloss" && from === "es" && !/^[A-Z]{2,}$/.test(want)) want = want.charAt(0).toLowerCase() + want.slice(1);
        cands.push({ v, want, src: e.src });
      });
    }
    return cands.sort((a, b) => b.v.length - a.v.length);   // los más largos primero ("comprehensive insurance" antes que "insurance")
  }
  async function enforceMyTerms(src, out, from) {
    const cands = prefCandidates(from);
    if (!cands.length || !out) return out;
    const n = strip(src);
    const done = new Set(), used = [];
    for (const c of cands) {
      if (!looseRe(c.v).test(src) || done.has(strip(c.want))) continue;
      // "medication" no se aplica si ya se aplicó "brand name medication"
      if (used.some((u) => looseRe(c.v).test(u))) continue;
      done.add(strip(c.want)); used.push(c.v);
      const srcTerm = c.v, want = c.want;
      if (strip(out).includes(strip(want))) continue;
      const mt = await mtRendering(srcTerm, from);
      if (mt && mt.length > 1) {
        const re = new RegExp(`(?<![\\p{L}])${reEsc(mt)}(?![\\p{L}])`, "iu");
        if (re.test(out)) { out = out.replace(re, want); continue; }
      }
      // los traductores suelen dejar acrónimos y nombres sin traducir: si el término aparece tal cual, se cambia
      const same = new RegExp(`(?<![\\p{L}])${reEsc(srcTerm).replace(/\s+/g, "[\\s.]*")}(?![\\p{L}])`, "iu");
      if (same.test(out)) out = out.replace(same, want);
    }
    return from === "en" ? fixArticles(out, cands) : out;
  }
  /** Concordancia de género en español: si el término preferido es femenino ("medicación") y el traductor
   *  dejó "el/un/del/al/este" delante, se corrige ("la medicación"), y al revés para los masculinos. */
  function nounGender(w) {
    const x = strip(w.split(/\s+/)[0]);
    if (/^(problema|sistema|programa|dia|mapa|idioma|tema|clima)s?$/.test(x)) return "m";
    if (/(cion|sion|dad|tad|tud|umbre|ez|a)s?$/.test(x)) return "f";
    if (/(o|or|ento|aje|an)s?$/.test(x)) return "m";
    return "";
  }
  // determinantes por forma: [masc. sing., fem. sing., masc. pl., fem. pl.]
  const DETS = [["el", "la", "los", "las"], ["un", "una", "unos", "unas"], ["del", "de la", "de los", "de las"], ["al", "a la", "a los", "a las"],
    ["este", "esta", "estos", "estas"], ["ese", "esa", "esos", "esas"], ["aquel", "aquella", "aquellos", "aquellas"], ["su", "su", "sus", "sus"],
    ["mi", "mi", "mis", "mis"], ["tu", "tu", "tus", "tus"], ["nuestro", "nuestra", "nuestros", "nuestras"], ["todo", "toda", "todos", "todas"],
    ["otro", "otra", "otros", "otras"], ["nuevo", "nueva", "nuevos", "nuevas"], ["mismo", "misma", "mismos", "mismas"], ["mucho", "mucha", "muchos", "muchas"],
    ["poco", "poca", "pocos", "pocas"], ["primer", "primera", "primeros", "primeras"], ["cualquier", "cualquier", "cualesquiera", "cualesquiera"]];
  const DET_OF = new Map(); DETS.forEach((row) => row.forEach((f) => { if (!DET_OF.has(f)) DET_OF.set(f, row); }));
  const DET_RE = [...DET_OF.keys()].sort((a, b) => b.length - a.length).map(reEsc).join("|");
  function fixArticles(out, cands) {
    if (!out) return out;
    const wants = [...new Set(cands.map((c) => c.want))].filter((w) => /^[a-záéíóúñü]/i.test(w) && !/^[A-Z]{2,}/.test(w) && out.toLowerCase().includes(w.toLowerCase()));
    for (const w of wants) {
      const g = nounGender(w); if (!g) continue;
      const plural = /s$/i.test(strip(w.split(/\s+/)[0]));
      const k = (g === "f" ? 1 : 0) + (plural ? 2 : 0);
      // hasta dos determinantes seguidos delante del término ("todos sus medicamentos")
      const re = new RegExp(`(?<![\\p{L}])((?:(?:${DET_RE})\\s+){1,2})(${reEsc(w)})(?![\\p{L}])`, "giu");
      out = out.replace(re, (m, dets, term) => dets.replace(new RegExp(`(?<![\\p{L}])(${DET_RE})(?![\\p{L}])`, "giu"), (d) => {
        const row = DET_OF.get(d.toLowerCase()); if (!row) return d;
        let r = row[k];
        if (d[0] !== d[0].toLowerCase()) r = r.charAt(0).toUpperCase() + r.slice(1);
        return r;
      }) + term);
    }
    return out;
  }
  /** Saca las formas buscables de un texto: "ATM (Automated Teller Machine)" → atm, automated teller machine;
   *  "copago, pago compartido / co-pay" → cada variante; "beneficiario(a)" → beneficiario; "to renew" → renew. */
  function keyVariants(text) {
    const out = [];
    const add = (v) => {
      v = strip(v).replace(/^\s*(to|the|el|la|los|las|un|una)\s+/, "").replace(/[“”"']/g, "").replace(/\s+/g, " ").trim();
      v = v.replace(/-/g, " ").replace(/\s+/g, " ").trim();   // "no-fault" = "no fault"
      if (v.length < 2) return;
      out.push(v);
      if (v.includes(".")) { const d = v.replace(/\./g, "").replace(/\s+/g, " ").trim(); if (d.length >= 2) out.push(d); }
    };
    for (const part of String(text).split(/[,;/]/)) {
      const ac = part.trim().replace(/[()]/g, "");
      if (/^[A-Z]{2,6}$/.test(ac)) { const l = ac.toLowerCase().split(""); out.push(l.join(" "), l.join(".") + ".", l.join(". ") + "."); }
      const inner = [...part.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
      add(part.replace(/\([^)]*\)/g, " "));
      for (const i of inner) if (i.trim().split(/\s+/).length >= 2 || /^[a-z]{4,}$/i.test(i.trim())) add(i);
    }
    return out;
  }
  function buildIndex() {
    termIndex = new Map();
    const ignore = new Set((window.GLOSARIO_IGNORAR || []).map((w) => strip(w)));
    for (const e of glossary) {
      for (const k of [e.t, e.tr]) {
        if (!k) continue;
        for (const key of keyVariants(k)) {
          if (ignore.has(key) || (key.length < 3 && !/^[a-z]{2}$/.test(key) )) continue;
          if (!termIndex.has(key)) termIndex.set(key, e);
        }
      }
    }
    const keys = [...termIndex.keys()].sort((a, b) => b.length - a.length).map(reEsc);
    termRe = keys.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${keys.join("|")})(?:es|s)?(?![\\p{L}\\p{N}])`, "gu") : null;
    const KW = window.KEYWORDS || {};
    for (const d of DOMS) {
      const list = (KW[d] || []).map((w) => reEsc(strip(w)));
      kwRe[d] = list.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${list.join("|")})(?:es|s)?(?![\\p{L}\\p{N}])`, "gu") : null;
    }
    $("glossInfo").textContent = `Active glossary: ${glossary.length} entries.`;
  }

  // ───────────────── Análisis de frase (sin IA, reglas + diccionario) ─────────────────
  const QUESTION_RE = /(\?|^(que|como|cuando|donde|por que|porque|cual|cuales|quien|cuanto|cuanta|cuantos|puedo|puede|podria|tengo que|debo|necesito saber|what|how|when|where|why|which|who|can|could|does|did|will|would|should|may i)\b|\b(no entiendo|no entendi|tengo una (duda|pregunta)|una pregunta|i don'?t understand|i have a question)\b)/;
  const NUM_RE = /\$\s?\d[\d,.]*|\d+(?:[.,:/-]\d+)*(?:\s?(?:dolares|dollars|pesos|usd|%|por ciento|percent|am|pm|a\. ?m\.|p\. ?m\.))?/g;

  function analyze(text) {
    const { out: n, map } = normMap(text);
    const terms = []; const spans = [];
    if (termRe) {
      termRe.lastIndex = 0; let m;
      const nT = n.replace(/-/g, " ");
      while ((m = termRe.exec(nT))) {
        const e = termIndex.get(m[1]);
        if (e) { terms.push(e); spans.push({ a: m.index, b: m.index + m[0].length, kind: "term", e }); }
      }
    }
    const nums = []; NUM_RE.lastIndex = 0; let m2;
    while ((m2 = NUM_RE.exec(n))) {
      const raw = text.slice(map[m2.index], map[m2.index + m2[0].length]).trim();
      if (/\d{2,}|\$|%|[:/]/.test(raw) || /dolar|dollar|peso|usd|ciento|percent/i.test(raw)) nums.push(raw);
      spans.push({ a: m2.index, b: m2.index + m2[0].length, kind: "num" });
    }
    const score = { medico: 0, legal: 0, bancario: 0, seguros: 0 };
    for (const d of DOMS) { if (kwRe[d]) score[d] += (n.match(kwRe[d]) || []).length; }
    for (const e of terms) if (score[e.dom] !== undefined) score[e.dom] += 2;
    const max = Math.max(...Object.values(score));
    const doms = max > 0 ? DOMS.filter((d) => score[d] > 0 && score[d] >= max * 0.5) : [];
    const question = QUESTION_RE.test(n.trim());

    return { text, n, map, spans, terms, nums, score, doms, question, html: renderHtml(text, map, spans) };
  }
  /** HTML resaltado (sin solapamientos; la información clave tiene prioridad). */
  function renderHtml(text, map, spans) {
    const pri = { key: 0, term: 1, num: 2 };
    const sorted = spans.slice().sort((x, y) => x.a - y.a || (pri[x.kind] - pri[y.kind]) || y.b - x.b);
    let html = "", pos = 0, last = -1;
    for (const s of sorted) {
      if (s.a < last) continue;
      const oa = map[s.a], ob = map[s.b];
      html += esc(text.slice(pos, oa));
      const frag = esc(text.slice(oa, ob));
      html += s.kind === "term" ? `<mark class="hl-term" title="${esc(`${s.e.t} = ${s.e.tr} · ${s.e.d}`)}">${frag}</mark>`
        : s.kind === "key" ? `<mark class="hl-key" data-k="${esc(s.label)}" title="${esc(s.label)}">${frag}</mark>`
        : `<mark class="num">${frag}</mark>`;
      pos = ob; last = s.b;
    }
    return html + esc(text.slice(pos));
  }

  // El hablante en inglés pide datos personales → recordatorio de política para el intérprete
  const PII_REQ = /\b((can|could|may) i (have|get|confirm|verify)|what('s| is| are)|please (provide|give|confirm|verify|spell)|i (need|will need)|tell me|give me|confirm)\b[^.?!]{0,40}\b(your|ur|the patient'?s|his|her|their|the caller'?s)\b[^.?!]{0,25}\b(full name|last name|first name|name|address|phone|number|date of birth|birthday|dob|social|ssn|e-?mail|card|account|routing|policy|member|zip|location|pin|password)\b|\bwhere (are you|do you live|are you calling from)\b|\binterpreter,? (what is|what's|can i have) your\b/;
  function suggestionsFor(a) {
    const out = []; const seen = new Set();
    const push = (s, dom) => { const k = s.es; if (!seen.has(k)) { seen.add(k); out.push({ ...s, dom }); } };
    if (a.lang === "en" && PII_REQ.test(a.n)) push({
      en: "Personal information request — interpret the question to the LEP. As the interpreter, you are not allowed to provide or confirm personal information yourself.",
      es: "Solicitud de datos personales: interprete la pregunta al LEP. Como intérprete, no tiene permitido proporcionar ni confirmar datos personales.",
      titulo: "Not allowed" }, "policy");
    const rules = (window.REGLAS || []).slice().sort((x, y) => (y.prio || 0) - (x.prio || 0));
    for (const r of rules) {
      r.re.lastIndex = 0;
      if (r.re.test(a.n)) for (const s of r.s) push({ es: fill(s.es), en: fill(s.en) }, r.dom);
    }
    for (const c of allCards()) {
      if (c._re && (c._re.lastIndex = 0, c._re.test(a.n))) push({ es: fill(c.es), en: fill(c.en), titulo: c.titulo }, c.cat === "Disclosures" ? "aviso" : "tarjeta");
    }
    for (const it of (a.keyItems || [])) {
      if (!it.read || it.type === "number" && !it.check) continue;
      const v = it.read.includes(": ") ? it.read.split(": ").slice(1).join(": ") : it.read;
      const vEs = it.readEs ? it.readEs : null;
      push({ en: `Just to confirm, your ${it.read.includes(": ") ? it.read.replace(": ", " is ") : "information is " + v}?`,
             es: vEs ? `Para confirmar, su ${vEs.replace(": ", " es ")}, ¿correcto?` : `Para confirmar: ${v}, ¿correcto?`, titulo: "Read back" }, it.check ? "verify" : "confirm");
      if (it.check && /digits/.test(it.note || "")) push({ en: "Could you please repeat the number slowly, digit by digit?", es: "¿Podría repetir el número despacio, dígito por dígito?" }, "verify");
    }
    if (a.question && !out.some((s) => s.dom === "duda"))
      push({ es: "Buena pregunta, permítame verificarlo.", en: "Good question, let me check that for you." }, "duda");
    if (!out.length) {
      const lead = leadDomain();
      for (const s of (window.SUGERENCIAS_DEFECTO || {})[lead || "general"] || []) push(s, lead || "general");
    }
    // primero: verificar datos, luego avisos (disclosures)
    const rank = (d) => (d === "policy" ? 5 : d === "interp" ? 4 : d === "verify" ? 3 : d === "aviso" ? 2 : d === "confirm" ? 1 : 0);
    // el intérprete SÍ puede dar su nombre e ID: en ese caso no aplica la alerta de datos personales
    if (out.some((x) => x.dom === "interp" && /^My name is/.test(x.en || ""))) for (let i = out.length - 1; i >= 0; i--) if (out[i].dom === "policy") out.splice(i, 1);
    // si hay una sugerencia específica para el intérprete, la genérica sobra
    const spec = out.filter((x) => x.dom === "interp" && !/^\(Addressed/.test(x.en || ""));
    if (spec.length) for (let i = out.length - 1; i >= 0; i--) if (out[i].dom === "interp" && /^\(Addressed/.test(out[i].en || "")) out.splice(i, 1);
    out.sort((x, y) => rank(y.dom) - rank(x.dom));
    return out.slice(0, 7);
  }

  // ───────────────── Estado de la sesión (solo memoria) ─────────────────
  let session = null;
  const freshSession = () => ({
    acc: { medico: 0, legal: 0, bancario: 0, seguros: 0 },
    termsSeen: new Map(),   // entrada → contador
    recent: [],             // últimas frases (contexto para sugerencias)
    keys: [], keySeq: 0, rowSeq: 0, partSeq: 0, expect: null,   // información clave (solo memoria)
    liveTerms: new Set(),   // términos ya contados en la frase en curso
    count: 0,
  });
  const leadDomain = () => {
    if (!session) return null;
    const best = DOMS.reduce((a, b) => (session.acc[a] >= session.acc[b] ? a : b));
    return session.acc[best] > 0 ? best : null;
  };

  // ───────────────── Render ─────────────────
  const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

  function renderSuggestions(list) {
    const box = $("suggestions");
    if (!list.length) return;
    const [p1, p2] = primaryOrder();
    box.innerHTML = list.map((s) => `
      <div class="sugg${s.older ? " older" : ""}${s.dom === "policy" ? " policy-s" : s.dom === "interp" ? " interp-s" : ""}" data-${p1}="${esc(s[p1] || "")}" data-${p2}="${esc(s[p2] || "")}">
        <span class="src tag ${s.dom}">${esc(s.titulo && s.dom === "tarjeta" ? s.titulo : (DOM_LABEL[s.dom] || s.dom))}</span>
        <div class="pri" data-l="${p1}">${esc(s[p1] || s[p2])}</div>${s[p2] && s[p1] ? `<div class="sec" data-l="${p2}">${esc(s[p2])}</div>` : ""}
      </div>`).join("");
  }

  function renderMeter() {
    const total = DOMS.reduce((t, d) => t + session.acc[d], 0) || 1;
    const lead = leadDomain();
    for (const el of $("domainMeter").children) {
      const d = el.dataset.dom;
      const pct = Math.round((session.acc[d] / total) * 100);
      el.querySelector("b").textContent = pct + "%";
      el.classList.toggle("lead", d === lead);
      el.hidden = pct === 0;
    }
    for (const b of $("cardTabs").children) b.textContent = b.dataset.cat + (TAB_FOR_DOM[lead] === b.dataset.cat ? " ●" : "");
  }

  function termHTML(e, n) {
    return `<div class="term ${e.dom}">${n ? `<span class="n">×${n}</span>` : ""}
      <span class="w">${e.mine ? `<span class="mine" title="Your term">★</span> ` : ""}${esc(String(e.t).split(" / ")[0])}</span> → <span class="tr">${esc(e.tr || "")}</span>
      <div class="d">${esc(e.d || "")}</div></div>`;
  }
  function renderTerms() {
    const arr = [...session.termsSeen.entries()].sort((a, b) => b[1].t - a[1].t);
    $("termCount").textContent = arr.length;
    $("terms").innerHTML = arr.length ? arr.map(([e, v]) => termHTML(e, v.n)).join("") : `<p class="empty">Glossary terms will appear here when they are heard.</p>`;
  }
  // ───────────────── Información clave ─────────────────
  const KEY_ICON = {};   // diseño sobrio: sin íconos
  /** Guarda los datos de una frase: si llega el resto de un número dictado en partes, actualiza el mismo dato. */
  function storeKeys(items, rowId) {
    const now = Date.now();
    for (const it of items) {
      const prev = session.keys.find((k) => k.type === it.type && k.digits && it.digits && it.digits.startsWith(k.digits) && it.digits !== k.digits && now - k.t < 30000)
        || session.keys.find((k) => k.type === it.type && k.value === it.value);
      if (prev) { Object.assign(prev, it, { id: prev.id, t: now, rows: [...new Set([...(prev.rows || []), rowId])] }); continue; }
      session.keys.push({ ...it, id: ++session.keySeq, t: now, rows: [rowId], time: fmtTime(elapsed()) });
    }
  }
  function keyValueShown(k) { return cfg.mask && k.sensitive && !k.revealed ? KeyInfo.mask(k.type, k.value) : k.value; }
  function keyLine(k) { return `${k.label}: ${k.value}`; }
  let seenKeys = 0;
  function renderKeys() {
    const box = $("keys");
    const list = session ? session.keys.filter((k) => !k.hidden) : [];
    $("keyCount").textContent = list.length;
    // en pantallas medianas, aviso en la pestaña cuando hay datos nuevos sin ver
    const hiddenSide = $("grid").classList.contains("t-assist") && getComputedStyle($("sideTabs")).display !== "none";
    if (!hiddenSide) seenKeys = list.length;
    $("keysDot").textContent = hiddenSide && list.length > seenKeys ? String(list.length - seenKeys) : "";
    if (!list.length) { box.innerHTML = `<p class="empty">Names, numbers, dates, amounts and IDs will appear here, organized by what was asked.</p>`; return; }
    // los datos con contexto (SSN, teléfono…) primero; números sueltos al final
    const order = (k) => (k.type === "number" ? 1 : 0);
    box.innerHTML = list.slice().sort((x, y) => order(x) - order(y) || y.t - x.t).map((k) => `
      <div class="key ${k.check ? "check" : ""} ${k.confirmed ? "ok" : ""} ${k.type}" data-id="${k.id}">
        <div class="key-top">
          <span class="key-label">${esc(k.label)}</span>
          <span class="key-acts">
            ${k.sensitive && cfg.mask ? `<button type="button" data-act="reveal" title="Show / hide">${k.revealed ? "Hide" : "Show"}</button>` : ""}
            <button type="button" data-act="copy" title="Copy">Copy</button>
            <button type="button" data-act="note" title="Add to notes">Note</button>
            <button type="button" data-act="ok" title="Mark as confirmed">✓</button>
            <button type="button" data-act="del" title="Discard">×</button>
          </span>
        </div>
        <div class="key-val">${esc(keyValueShown(k))}${k.alt ? ` <small>${esc(k.alt)}</small>` : ""}</div>
        ${k.note ? `<div class="key-note">${k.check ? "⚠ " : ""}${esc(k.note)}</div>` : ""}
        <div class="key-heard" title="What was heard">${k.time} · “${esc(k.raw || "")}”</div>
      </div>`).join("");
  }
  function addToNotes(line) {
    const n = $("notes");
    n.value += (n.value && !n.value.endsWith("\n") ? "\n" : "") + line + "\n";
    n.scrollTop = n.scrollHeight;
  }
  /** Extrae la información clave de una frase final y la integra (resaltado + panel + sugerencias). */
  function extractKeys(a, rowId, ctxExpect) {
    if (!window.KeyInfo) return [];
    const r = KeyInfo.extract(a.text, a.n, { expect: ctxExpect, now: Date.now(), map: a.map });
    a.keyItems = r.items;
    if (r.spans.length) a.html = renderHtml(a.text, a.map, a.spans.concat(r.spans.map((x) => ({ ...x, kind: "key" }))));
    return r;
  }


  // ───────────────── Traducción (todo en el dispositivo, sin internet ni API keys) ─────────────────
  // 1) Traductor integrado de Chrome 138+ (el más rápido).  2) Respaldo en cualquier navegador: Bergamot
  //    (el motor de traducción offline de Firefox, WebAssembly) con modelos servidos desde este sitio.
  const translators = {};
  const hasTranslator = () => false;   // en la app solo se usa Bergamot (100 % local)
  function getTranslator(from, to) {
    const k = from + ">" + to;
    if (!translators[k]) {
      translators[k] = (async () => {
        const av = await Promise.race([
          self.Translator.availability({ sourceLanguage: from, targetLanguage: to }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
        ]);
        if (av === "unavailable") return null;
        return self.Translator.create({
          sourceLanguage: from, targetLanguage: to,
          monitor(m) { m.addEventListener("downloadprogress", (e) => { if (e.loaded < 1) notice(`Setting up the translator (${from.toUpperCase()}→${to.toUpperCase()}), one time only… ${Math.round(e.loaded * 100)}%`); else notice(""); }); },
        });
      })().catch(() => null);
    }
    return translators[k];
  }
  let bergamot = null;
  function getBergamot() {
    if (!bergamot) {
      const url = window.Native.modelUrl("bergamot/registry.json");
      bergamot = fetch(url, { method: "HEAD" }).then((r) => { if (!r.ok) throw new Error("no bergamot models"); return import("./vendor/bergamot/translator.js"); })
        .then((m) => {
          const t = new m.BatchTranslator({ workers: 1, batchSize: 1, pivotLanguage: null, downloadTimeout: 0, registryUrl: url });
          if (t.backing && t.backing.registry) t.backing.registry.catch(() => {});
          return t;
        }).catch((e) => { setTimeout(() => { bergamot = null; }, 30000); throw e; });
    }
    return bergamot;
  }
  /** Debe llamarse dentro de un clic: la primera vez Chrome descarga su modelo de traducción. */
  function prepareTranslators() {
    if (!cfg.translate) return;
    if (hasTranslator()) { getTranslator("es", "en"); getTranslator("en", "es"); return; }
    getBergamot().then((b) => { // precarga los modelos de respaldo en segundo plano
      b.translate({ from: "es", to: "en", text: "hola", html: false }).catch(() => {});
      b.translate({ from: "en", to: "es", text: "hello", html: false }).catch(() => {});
    }).catch(() => {});
  }
  /** Regex que encuentra un término sin importar acentos ni mayúsculas ("cobertura" = "cobertúra"). */
  function looseRe(term) {
    const map = { a: "[aáàä]", e: "[eéèë]", i: "[iíìï]", o: "[oóòö]", u: "[uúùü]", n: "[nñ]" };
    const body = strip(term).trim().split("").map((ch) => (/\s/.test(ch) ? "[\\s-]+" : map[ch] || reEsc(ch))).join("").replace(/(\[\\s-\]\+)+/g, "[\\s-]+");
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
  }
  /** Traducción con tus términos preferidos: antes de traducir, cada término se cambia por una marca (ZX1, ZX2…)
   *  que el traductor deja intacta; después la marca se reemplaza por tu traducción. Si se perdiera una marca,
   *  se traduce normal y se corrige con el método anterior. */
  async function translate(text, from) {
    if (!cfg.translate || !text) return null;
    const holders = []; let src = text;
    for (const c of prefCandidates(from)) {
      if (holders.length >= 6) break;
      if (looseRe(c.v).test(src)) { const tok = "ZX" + (holders.length + 1); src = src.replace(looseRe(c.v), tok); holders.push({ tok, want: c.want }); }
    }
    if (holders.length) {
      let out = await translateRaw(src, from);
      if (out && holders.every((h) => new RegExp(`\\b${h.tok}\\b`, "i").test(out))) {
        for (const h of holders) out = out.replace(new RegExp(`\\b${h.tok}\\b`, "gi"), h.want);
        if (from === "es") out = out.replace(/\b([Aa]) (?=[aeiouAEIOU])/g, "$1n ");   // "a adjuster" → "an adjuster"
        else out = fixArticles(out, holders);
        return out;
      }
    }
    const out = await translateRaw(text, from);
    return out ? enforceMyTerms(text, out, from) : out;
  }
  async function translateRaw(text, from) {
    const to = from === "es" ? "en" : "es";
    if (hasTranslator()) {
      const t = await getTranslator(from, to);
      if (t) { try { return await t.translate(text); } catch { /* respaldo */ } }
    }
    try { const b = await getBergamot(); const r = await b.translate({ from, to, text, html: false }); return r.target.text; }
    catch { return null; }
  }
  const langOf = () => (cfg.lang.startsWith("en") ? "en" : "es");

  // ───────────────── Motor nativo (whisper.cpp dentro de la app) ─────────────────
  // El núcleo escribe el texto al instante (modelo rápido) y luego cada frase la corrige el modelo preciso
  // (GPU, o procesador si no hay). Aquí solo se recibe el resultado.
  let aiReady = false, aiMode = "", engineInfo = null;
  function setEngineChip(text, kind) { const c = $("engineChip"); c.textContent = text; c.className = "engine-chip " + (kind || ""); c.hidden = !text; }
  function renderEngineInfo() {
    const d = engineInfo;
    if (!d || (!d.fast && !d.accurate)) { $("engineInfo").textContent = "The speech engine starts when you press Start."; setEngineChip("", ""); return; }
    const gpu = /GPU/.test(d.accurate || "");
    $("engineInfo").textContent = `Fast engine: ${d.fast || "—"} · Accuracy engine: ${d.accurate || (state === "idle" ? "off" : "loading…")}`
      + (d.gpu ? ` · Graphics card: ${d.gpu}` : " · No compatible graphics card found") + (d.vram_mb ? ` · Using ${d.vram_mb} MB of video memory` : "");
    setEngineChip(d.accurate ? (gpu ? "Accuracy: GPU" : "Accuracy: CPU") : "", gpu ? "best" : "");
    $("btnFreeGpu").disabled = !gpu;
  }
  const aiJobs = new Map();   // seg → frase en pantalla que espera su corrección
  function onAiMessage(e) {
    const m = e.data || {};
    if (m.type === "asr" || m.type === "error") {
      const job = aiJobs.get(m.id); aiJobs.delete(m.id);
      if (!job) return;
      job.row.classList.remove("refining", "langcheck");
      // si el texto del motor rápido es claramente de un idioma, Whisper no puede cambiarlo (evita que "traduzca" el español al inglés)
      const fastLang = job.part ? detectTextLang(job.part.text) : null;
      if (m.lang && m.lang !== job.lang && !job.unclear && job.row._lang === job.lang) {
        const w = (job.part && job.part.vwords) || [];
        const fastConf = w.length ? w.reduce((t, x) => t + (x.conf || 0), 0) / w.length : 0.5;
        // se respeta el idioma del motor rápido si su texto es claro y tenía buena confianza, salvo que Whisper esté MUY seguro
        // hacia español: se acepta (el worker ya exigió margen); hacia inglés: solo si el texto no era claramente español
        if (m.lang === "en" && (fastLang === "es" || (fastLang === job.lang && fastConf >= 0.8 && (m.margin || 0) < 5))) { job.keepLang = true; }
        else { flipRowLang(job.row, true); job.lang = m.lang; job.forced = true; }
      }
      if (job.unclear) {
        if (m.text && session && job.row.isConnected) { session.count--; handleFinal(m.text, m.lang || job.lang, null, 1, { replace: job.row, refined: true }); }
        else if (job.row.isConnected) { const tg = job.row.querySelector(".unclear-tag"); if (tg) tg.textContent = "Unclear audio"; }
        return;
      }
      if (m.text) applyRefinement(job, m.text);
    }
  }
  const words = (t) => strip(t).replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
  /** Idioma de un texto por palabras frecuentes (para detectar cuando Whisper "oyó" el otro idioma). */
  const ES_W = new Set("el la los las de del que y en un una es por con para mi su no se lo me le al pero como muy tambien tengo esta estoy fue hay porque cuando donde usted senor senora gracias hola si ya mas yo nos les sus este esto eso ella".split(" "));
  const EN_W = new Set("the and to of a in is it you i my that for on with have was this are be your me we he she they not do did can will would what when where there here hello thank thanks yes no please an at as but so if or from just".split(" "));
  function detectTextLang(t) {
    let es = 0, en = 0;
    for (const w of strip(t).replace(/[^\p{L}\s']/gu, " ").split(/\s+/)) { if (ES_W.has(w)) es++; if (EN_W.has(w)) en++; }
    if (es + en < 2) return null;
    if (en >= es * 2 + 1) return "en";
    if (es >= en * 2 + 1) return "es";
    return null;
  }
  /** ¿La corrección del modelo preciso es segura? En la app el modelo preciso (large-v3-turbo) es mucho mejor que el
   *  rápido, así que puede completar palabras que el rápido no oyó. Se rechaza solo si: sale vacía, crece de forma absurda
   *  (alucinación; el núcleo ya filtra bucles y frases inventadas), deja fuera muchas palabras que el rápido oyó con
   *  seguridad, o pierde/cambia dígitos. Agregar dígitos que el rápido no oyó sí se acepta (en orden, sin cambiar los demás). */
  function safeRefinement(part, newText) {
    const W = (t) => strip(t).replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
    const digitsOf = (t) => (window.KeyInfo ? KeyInfo.numberGroups(strip(t).replace(/(\d)(st|nd|rd|th)\b/g, "$1")).map((g) => g.digits).join("") : (t.match(/\d/g) || []).join(""));
    const wo = W(part.text), wn = W(newText);
    if (!wn.length || wn.length > wo.length * 3 + 12) return false;             // alucinación
    const isNum = (w) => window.KeyInfo && KeyInfo.numberGroups(w).length > 0;
    const sure = (part.vwords ? part.vwords.filter((x) => (x.conf || 0) >= 0.9).map((x) => strip(x.word).replace(/[^\p{L}\p{N}']/gu, "")) : wo).filter((w) => !isNum(w) && w.length > 1);
    const have = new Set(wn);
    // palabra conservada, o cambiada por otra que suena parecido (corrección por contexto: "proxy" → "project")
    const near = (w) => have.has(w) || wn.some((x) => (w.length >= 4 && Math.abs(x.length - w.length) <= 2 && lev(x, w) <= 2) || (w.length >= 3 && x.length >= 3 && x.slice(0, 3) === w.slice(0, 3)));
    const missing = sure.filter((w) => !near(w)).length;
    if (missing > Math.max(2, Math.round(sure.length * 0.5))) return false;    // dejó fuera demasiadas palabras seguras
    const dOld = digitsOf(part.text), dNew = digitsOf(newText);
    const subseq = (a, b) => { let i = 0; for (const c of b) if (c === a[i]) i++; return i === a.length; };
    if (dOld.length >= 1 && !subseq(dOld, dNew)) return false;                 // perdió o cambió un dígito
    // dígitos que el rápido sí escribió aunque en forma rara ("3.3.71") cuentan como oídos, no como agregados
    const heard = Math.max(dOld.length, (part.text.match(/\d/g) || []).length);
    if (dOld.length >= 1 && dNew.length - heard > Math.max(3, Math.ceil(heard * 0.5))) return false;
    return true;
  }
  function lev(a, b) {
    const m = a.length, n = b.length; if (Math.abs(m - n) > 2) return 3;
    const d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function applyRefinement(job, text) {
    if (!session || !job.row.isConnected || !job.part) return;
    const row = job.row, part = job.part;
    const det = detectTextLang(text);
    const fastLang = detectTextLang(part.text);
    if (det && det !== job.lang) {
      // Whisper devolvió el otro idioma: si el motor rápido era claramente de su idioma, Whisper tradujo → se descarta
      if (job.keepLang || (fastLang === job.lang && !job.forced)) return;
      if (row._lang === job.lang && row._parts.length === 1) { flipRowLang(row, true); job.lang = det; job.forced = true; }
    }
    text = applyFixes(text);
    if (words(text).join(" ") === words(part.text).join(" ")) return;
    if (!job.forced && !safeRefinement(part, text)) return;
    const a = analyze(text);
    const now = Date.now();
    for (const e of a.terms) if (!job.terms.has(e)) {
      job.terms.add(e);
      const v = session.termsSeen.get(e) || { n: 0, t: 0 }; v.n++; v.t = now; session.termsSeen.set(e, v);
    }
    part.text = text;
    // vuelve a extraer los datos de esta parte con el texto corregido
    const kr = extractKeys(a, +row.dataset.rid, part.ctx);
    if (kr.items && kr.items.length) {
      session.keys = session.keys.filter((k) => !(k.part === part.id && !k.confirmed));
      storeKeys(kr.items.map((k) => ({ ...k, part: part.id })), +row.dataset.rid); renderKeys(); renderStrip();
    }
    part.html = a.html;
    const orig = row.querySelector(".cell.orig");
    withStableScroll(() => { renderRow(row); orig.classList.add("refined", "flash"); });
    setTimeout(() => orig.classList.remove("flash"), 900);
    orig.title = "Corrected by the high-accuracy engine";
    fillTranslation(row, row._text, row._lang);
    renderTerms();
    if (row === $("transcript").lastElementChild) renderSuggestions(suggestionsFor(a));
  }

  /** Corrección de una fila completa: la frase se pausó a la mitad y el núcleo transcribió todas sus partes
   *  juntas (con el contexto completo, p. ej. un número dictado en partes). Reemplaza las partes de la fila. */
  function applyRowRefinement(segs, text, lang) {
    let row;
    // solo si la fila tiene exactamente esas frases (si la interfaz no las unió, cada una ya tiene su propia corrección)
    row = [...$("transcript").querySelectorAll(".trow")].find((r) => r._segs && r._segs.length === segs.length && segs.every((sg) => r._segs.includes(sg))) || null;
    if (!row || !session || !row.isConnected || !row._parts) return;
    row.classList.remove("refining", "langcheck");
    if (!text || lang !== row._lang) return;
    text = applyFixes(text);
    if (words(text).join(" ") === words(row._text).join(" ")) return;
    const vw = row._parts.flatMap((p) => p.vwords || []);
    if (!safeRefinement({ text: row._text, vwords: vw.length ? vw : null }, text)) return;
    const a = analyze(text);
    const now = Date.now();
    for (const e of a.terms) { const v = session.termsSeen.get(e) || { n: 0, t: 0 }; if (!row._parts.some((p) => p.terms && p.terms.has(e))) v.n++; v.t = now; session.termsSeen.set(e, v); }
    const ids = new Set(row._parts.map((p) => p.id));
    const part = { id: ++session.partSeq, text, vwords: null, terms: new Set(a.terms), ctx: row._parts[0].ctx, question: a.question };
    const kr = extractKeys(a, +row.dataset.rid, part.ctx);
    session.keys = session.keys.filter((k) => !(ids.has(k.part) && !k.confirmed));
    storeKeys((kr.items || []).map((k) => ({ ...k, part: part.id })), +row.dataset.rid);
    part.html = a.html;
    row._parts = [part];
    const orig = row.querySelector(".cell.orig");
    withStableScroll(() => { renderRow(row); orig.classList.add("refined", "flash"); });
    setTimeout(() => orig.classList.remove("flash"), 900);
    orig.title = "Corrected by the high-accuracy engine";
    fillTranslation(row, row._text, row._lang);
    renderTerms(); renderKeys(); renderStrip();
  }

  // ───────────────── Scroll estable de la transcripción ─────────────────
  // Solo se baja sola si estás al final. Si subiste a leer, se queda quieta aunque lleguen frases nuevas
  // o se corrijan/traduzcan otras (se "ancla" a la fila que estás viendo), y aparece "↓ Live".
  let pinned = true, unseenRows = 0;
  function isAtBottom() { const t = $("transcript"); return t.scrollHeight - t.scrollTop - t.clientHeight < 48; }
  function updateJump() {
    const j = $("jumpLive");
    j.hidden = pinned;
    j.textContent = unseenRows ? `↓ ${unseenRows} new` : "↓ Live";
  }
  function withStableScroll(fn) {
    const t = $("transcript");
    if (pinned) { fn(); t.scrollTop = t.scrollHeight; return; }
    let anchor = null, off = 0;
    for (const r of t.children) { if (r.offsetTop + r.offsetHeight > t.scrollTop) { anchor = r; off = r.offsetTop - t.scrollTop; break; } }
    fn();
    if (anchor && anchor.isConnected) t.scrollTop = anchor.offsetTop - off;
  }

  /** Corrige el idioma de una frase: la mueve de columna, la vuelve a traducir y (si hay audio) Whisper la re-transcribe. */
  function flipRowLang(row, quiet) {
    if (!session || !row._lang) return;
    const lang = row._lang === "es" ? "en" : "es";
    row._lang = lang; lastLang = lang;
    const orig = row.querySelector(".cell.orig"), xl = row.querySelector(".cell.xl");
    withStableScroll(() => {
      row.querySelector(".lang").textContent = lang.toUpperCase();
      orig.setAttribute("lang", lang); xl.setAttribute("lang", lang === "es" ? "en" : "es");
      if (lang === "en") row.insertBefore(orig, xl); else row.insertBefore(xl, orig);
      xl.textContent = "";
    });
    if (quiet) { lastLang = lang; return; }
    fillTranslation(row, row._text, lang);
    if (row._seg && row._parts && row._parts.length === 1 && cfg.precise && aiReady) {
      const seg = row._seg;
      aiJobs.set(seg, { row, part: row._parts[0], lang, terms: new Set(), forced: true });
      row.classList.add("refining");
      window.Native.invoke("retranscribe", { seg, lang }).then((ok) => { if (!ok) { aiJobs.delete(seg); row.classList.remove("refining"); } }).catch(() => row.classList.remove("refining"));
    }
    toast(`Moved to ${lang === "en" ? "English" : "Español"}`);
  }

  // ───────────────── Transcripción a dos columnas: English | Español ─────────────────
  function fillTranslation(row, text, lang) {
    const cell = row.querySelector(".cell.xl");
    if (!cfg.translate) { cell.textContent = ""; return; }
    cell.classList.add("pending");
    const seq = (row._trSeq = (row._trSeq || 0) + 1);
    setTimeout(() => { if (seq === row._trSeq) cell.classList.remove("pending"); }, 10000);
    translate(text, lang).then((t) => {
      if (seq !== row._trSeq || !row.isConnected) return;
      cell.classList.remove("pending");
      withStableScroll(() => { cell.textContent = t || ""; });
    });
  }

  /** Procesa una frase final. lang = "es" | "en" (idioma en que se dijo). audio = Float32Array 16 kHz (opcional). */
  /** Arreglos comunes del motor rápido: "three d" → "3D", "two d" → "2D". */
  // Confusiones típicas del motor rápido que se corrigen según el contexto de la llamada
  const INS_CTX = /\b(insurance|policy|claim|accident|car|vehicle|adjuster|coverage|deductible|damage|tow|crash|agent|seguro|poliza|reclamo)\b/i;
  function contextFixes(text, lang) {
    if (lang !== "en") return text;
    const ins = INS_CTX.test(text) || (session && leadDomain() === "seguros");
    if (ins) {
      text = text.replace(/\b(file|filed|filing|open|opened|submit|submitted|my|the|a|your|new|this|that|same|insurance)\s+games?\b/gi, (m, w) => `${w} claim`)
                 .replace(/\bgames?\s+(number|status|adjuster|department|form|representative|process)\b/gi, (m, w) => `claim ${w}`);
    }
    return text.replace(/\baccessors?\b/gi, (m) => (m.endsWith("s") ? "assessors" : "assessor"));
  }
  function tidy(text, lang) {
    text = contextFixes(applyFixes(text), lang);
    if (lang === "en") text = text.replace(/\b(two|three|four)[\s-]+d\b/gi, (m, w) => ({ two: "2", three: "3", four: "4" })[w.toLowerCase()] + "D");
    else text = text.replace(/\b(dos|tres)[\s-]+de\b(?=\s*(?:$|[.,]|impres|anima|modelo|película|pelicula))/gi, (m, w) => (w.toLowerCase() === "dos" ? "2D" : "3D"));
    return text;
  }
  const TO_INTERP = /\b(interpreter|interprete|tell (her|him|them|the patient)|ask (her|him|them|the patient)|digale|preguntele|dile|preguntale)\b/;
  const MERGE_MS = 2600;   // pedazos de una misma oración separados por pausas cortas se juntan en una fila
  function handleFinal(text, lang, audio, conf, opts) {
    opts = opts || {};
    text = tidy(text.trim(), lang || langOf());
    if (!text || !session) return;
    lang = lang || langOf();
    // audio poco claro (el motor rápido no está seguro): se muestra atenuado y Whisper lo revisa primero
    const nWords = text.split(/\s+/).length;
    if (conf !== undefined && conf !== null && conf < UNCLEAR_CONF && !opts.replace && !numericMostly(text)) {
      if (nWords < 2 && conf < 0.3) return;   // ruido
      return addUnclearRow(text, lang, opts.seg, conf);
    }
    const a = analyze(text);
    a.lang = lang;
    session.count++;
    for (const d of DOMS) session.acc[d] = session.acc[d] * 0.8 + a.score[d];
    const now = Date.now();
    for (const e of a.terms) {
      const v = session.termsSeen.get(e) || { n: 0, t: 0 };
      if (!session.liveTerms.has(e)) v.n++;   // ya contado mientras se hablaba
      v.t = now; session.termsSeen.set(e, v);
    }
    session.liveTerms.clear();

    const tr = $("transcript");
    if (!tr.querySelector(".trow")) tr.innerHTML = "";
    const last = tr.lastElementChild;
    // no se junta si lo anterior era una pregunta o si esto empieza como respuesta (otro turno de la conversación)
    const prevPart = last && last._parts && last._parts[last._parts.length - 1];
    const newTurn = /^(yes|yeah|yep|no|nope|okay|ok|sure|right|correct|exactly|hello|hi|thank|thanks|si|sí|claro|correcto|exacto|bueno|hola|gracias|perfecto|de acuerdo)\b/i.test(text) || a.question;
    // el núcleo marca con el mismo "group" la frase que continúa la anterior tras una pausa corta
    const sameGroup = opts.group != null ? last && last._group === opts.group : now - last._t < MERGE_MS && !/[.?!…]\s*$/.test(last._text);
    const merge = !opts.replace && last && last._parts && !last.classList.contains("unclear") && last._lang === lang
      && sameGroup && last._parts.length < 8 && !(prevPart && prevPart.question) && !newTurn;
    if (merge && prevPart && /[^.]\.$/.test(prevPart.text)) {
      // "The case number is 2024." + "3371." → una sola oración
      prevPart.text = prevPart.text.slice(0, -1); prevPart.html = analyze(prevPart.text).html;
      const fw = text.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñ']+)\b/);
      if (fw && (EN_W.has(strip(fw[1])) || ES_W.has(strip(fw[1]))) && fw[1] !== "I") text = fw[1].toLowerCase() + text.slice(fw[1].length);
    }
    const rowId = merge ? +last.dataset.rid : ++session.rowSeq;
    const ctxExpect = session.expect;
    const part = { id: ++session.partSeq, text, vwords: opts.words || null, terms: new Set(a.terms), ctx: ctxExpect, question: a.question };
    const kr = extractKeys(a, rowId, ctxExpect);
    part.html = a.html;
    session.expect = kr.expect || null;
    storeKeys((kr.items || []).map((k) => ({ ...k, part: part.id })), rowId);

    let row;
    const tags = [...a.doms, ...(a.question ? ["duda"] : []), ...(TO_INTERP.test(a.n) ? ["interp"] : [])];
    if (merge) {
      row = last;
      withStableScroll(() => {
        row._parts.push(part);
        tags.forEach((t) => row._tags.add(t));
        renderRow(row);
      });
    } else {
      row = document.createElement("div");
      row.dataset.rid = rowId;
      row._lang = lang; row._parts = [part]; row._tags = new Set(tags); row._time = fmtTime(elapsed()); row._group = opts.group;
      row.className = "trow " + (a.doms[0] || "");
      row.innerHTML = `<div class="meta"></div><div class="cell orig" lang="${lang}"></div><div class="cell xl" lang="${lang === "es" ? "en" : "es"}"></div>`;
      if (lang !== "en") row.insertBefore(row.querySelector(".cell.xl"), row.querySelector(".cell.orig"));
      renderRow(row);
      withStableScroll(() => {
        if (opts.replace && opts.replace.isConnected) opts.replace.replaceWith(row);
        else tr.appendChild(row);
        while (tr.children.length > 400) tr.firstChild.remove();
      });
      if (!pinned && !opts.replace) { unseenRows++; updateJump(); }
    }
    row._t = now;
    if (opts.seg) row._segs = (row._segs || []).concat(opts.seg);
    if (opts.refined) { const o = row.querySelector(".cell.orig"); o.classList.add("refined", "flash"); setTimeout(() => o.classList.remove("flash"), 900); }
    clearInterim();
    fillTranslation(row, row._text, lang);   // se traduce la oración completa (no pedazos)

    // el núcleo ya está corrigiendo esta frase con el modelo preciso: se marca y se espera el resultado
    if (opts.seg && cfg.precise) {
      aiJobs.set(opts.seg, { row, part, lang, terms: part.terms });
      row.classList.add("refining");
      row._seg = row._parts.length === 1 ? opts.seg : null;
      if (opts.auto && row._parts.length === 1) row.classList.add("langcheck");
    }
    if (a.doms.length) sendHints();

    session.recent.push(a); if (session.recent.length > 3) session.recent.shift();
    updatePriority(a, kr.items || []);   // Routine / Important / Urgent
    renderSuggestions(contextSuggestions(a));
    renderMeter(); renderTerms(); renderKeys(); renderStrip();
  }
  /** Dibuja una fila a partir de sus partes. */
  function renderRow(row) {
    row._text = row._parts.map((p) => p.text).join(" ");
    const meta = row.querySelector(".meta");
    meta.innerHTML = `<span class="time">${row._time}</span><button type="button" class="lang" title="Wrong language? Click to switch EN ⇄ ES">${row._lang.toUpperCase()}</button><button type="button" class="fix" title="Select a misheard word, then click to correct it from now on">Fix</button>${[...row._tags].map((t) => `<span class="tag ${t}">${DOM_LABEL[t]}</span>`).join("")}`;
    row.querySelector(".cell.orig").innerHTML = row._parts.map((p) => p.html).join(" ");
  }
  /** Aplica las correcciones a las frases ya mostradas (y las vuelve a traducir). */
  function reapplyFixes() {
    if (!session) return;
    for (const row of [...$("transcript").querySelectorAll(".trow")].slice(-60)) {
      if (!row._parts) continue;
      let changed = false;
      for (const p of row._parts) {
        const t = applyFixes(p.text);
        if (t !== p.text) { p.text = t; const a = analyze(t); p.html = a.html; changed = true; }
      }
      if (changed) { withStableScroll(() => renderRow(row)); fillTranslation(row, row._text, row._lang); }
    }
  }
  /** Frases que son casi solo números: el motor rápido dicta dígitos mejor que Whisper; no se corrigen. */
  function numericMostly(t) {
    const w = strip(t).split(/\s+/).filter(Boolean);
    if (!w.length || !window.KeyInfo) return false;
    const nums = KeyInfo.numberGroups(strip(t)).reduce((n, g) => n + g.raw.split(/\s+/).length, 0);
    return nums / w.length >= 0.6;
  }
  // ───────────────── Importancia de la llamada ─────────────────
  const PRIORITY = [
    { lvl: 3, re: /\b(911|emergenc\w*|chest pain|dolor (de|en el) pecho|can'?t breathe|not breathing|no (puedo|puede) respirar|unconscious|inconsciente|bleeding|sangrando|overdose|sobredosis|suicid\w*|kill (myself|himself|herself)|quitarme la vida|dutch act|stroke|derrame|heart attack|infarto|ataque al corazon|gas leak|fuga de gas|huele a gas|fire|incendio|assault\w*|abus\w*|threat\w*|amenaz\w*|weapon|arma|pass(ed)? out|desmay\w*|seizure|convulsi\w*)\b/, why: "Possible emergency" },
    { lvl: 2, re: /\b(fraud|fraude|unauthori[sz]ed|no reconozco|stolen|robad\w*|identity theft|robo de identidad|accident\w*|choque|chocaron|injur\w*|lesionad\w*|herid\w*|arrest\w*|detenid\w*|court|corte|hearing|audiencia|lawsuit|demanda|deadline|fecha limite|eviction|desalojo|foreclosure|embargo|collections|cobranza|denied|denegad\w*|cancel\w*|complaint|queja|supervisor|pain|dolor|pregnan\w*|embarazad\w*|medication|medicamento|deportation|deportacion|custody|custodia)\b/, why: "Important matter" },
  ];
  function updatePriority(a, keyItems) {
    const p = session.priority || (session.priority = { lvl: 1, reasons: new Map() });
    for (const r of PRIORITY) {
      const m = a.n.match(r.re);
      if (m) { p.lvl = Math.max(p.lvl, r.lvl); p.reasons.set(m[0], r.lvl); }
    }
    if (keyItems.some((k) => k.sensitive)) { p.lvl = Math.max(p.lvl, 2); p.reasons.set("sensitive data", 2); }
    renderPriority();
  }
  function renderPriority() {
    const el = $("prio");
    const p = session && session.priority;
    const lvl = p ? p.lvl : 0;
    el.className = "prio " + (["", "routine", "important", "urgent"][lvl] || "");
    el.textContent = ["", "Routine", "Important", "Urgent"][lvl] || "";
    el.hidden = !lvl;
    el.title = p && p.reasons.size ? "Why: " + [...p.reasons.keys()].slice(-6).join(", ") : "No urgent signals so far";
  }

  /** Fila atenuada para audio poco claro. Si Whisper la entiende, se reemplaza por una frase normal. */
  function addUnclearRow(text, lang, seg, conf) {
    const tr = $("transcript");
    if (session.count === 0) tr.innerHTML = "";
    session.count++;
    const row = document.createElement("div");
    row.className = "trow unclear";
    row._lang = lang; row._text = text;
    const canCheck = !!seg && cfg.precise && aiReady;
    row.innerHTML = `<div class="meta"><span class="time">${fmtTime(elapsed())}</span><span class="tag unclear-tag">${canCheck ? "Unclear audio · checking" : "Unclear audio"}</span></div>`
      + `<div class="cell unclear-text" title="Low confidence (${Math.round(conf * 100)}%) — the audio may be noisy, music, or another language">${esc(text)}</div>`;
    withStableScroll(() => { tr.appendChild(row); while (tr.children.length > 400) tr.firstChild.remove(); });
    clearInterim();
    if (canCheck) aiJobs.set(seg, { row, text, lang, terms: new Set(), unclear: true });
  }

  /** Sugerencias de la última frase primero, completadas con el contexto de las 2 anteriores. */
  function contextSuggestions(a) {
    const out = suggestionsFor(a);
    const seen = new Set(out.map((x) => x.es));
    for (const prev of session.recent.slice(0, -1).reverse()) {
      for (const s2 of suggestionsFor({ ...prev, keyItems: [] })) {
        if (out.length >= 7) break;
        if (!seen.has(s2.es) && s2.dom !== "general") { seen.add(s2.es); out.push({ ...s2, older: true }); }
      }
    }
    return out;
  }
  /** Franja de contexto bajo la transcripción (estilo subtítulos en vivo): datos clave y términos recientes. */
  function renderStrip() {
    const box = $("ctxStrip");
    if (!session) { box.innerHTML = ""; return; }
    const keys = session.keys.filter((k) => !k.hidden && k.type !== "number").map((k) => ({ t: k.t, html: `<button type="button" class="chip key-chip ${k.check ? "check" : ""}" data-copy="${esc(k.value)}" title="${esc(k.label)} — click to copy"><b>${esc(k.label)}</b> ${esc(keyValueShown(k))}</button>` }));
    const terms = [...session.termsSeen.entries()].map(([e, v]) => ({ t: v.t, html: `<button type="button" class="chip term-chip ${e.dom}" data-copy="${esc(e.tr)}" title="${esc(e.d || "")}"><b>${esc(String(e.t).split(" / ")[0])}</b> ${esc(String(e.tr || "").split(",")[0])}</button>` }));
    const all = keys.concat(terms).sort((x, y) => y.t - x.t).slice(0, 14);
    box.innerHTML = all.map((x) => x.html).join("");
    box.scrollLeft = 0;
  }

  function clearInterim() {
    const box = $("interim");
    box.querySelectorAll(".cell").forEach((c) => { c.innerHTML = ""; c.classList.remove("orig", "xl"); });
    box.classList.remove("on");
    interimSeq++;
  }
  let interimT, interimTrBusy = false, interimPending = null, interimSeq = 0;
  function handleInterim(text, lang) {
    if (!text) { clearInterim(); clearTimeout(interimT); return; }
    lang = lang || langOf();
    clearTimeout(interimT);
    interimT = setTimeout(() => {
      if (!session) return;
      text = applyFixes(text);
      const a = analyze(text);
      const box = $("interim"); box.classList.add("on");
      const o = box.querySelector(`.cell[data-l="${lang}"]`), x = box.querySelector(`.cell[data-l="${lang === "es" ? "en" : "es"}"]`);
      o.classList.add("orig"); o.classList.remove("xl"); x.classList.add("xl"); x.classList.remove("orig");
      o.setAttribute("lang", lang); x.setAttribute("lang", lang === "es" ? "en" : "es");
      o.innerHTML = a.html + " …";
      // términos y sugerencias en vivo, sin esperar a que termine la frase
      let changed = false; const now = Date.now();
      for (const e of a.terms) if (!session.liveTerms.has(e)) {
        session.liveTerms.add(e); changed = true;
        const v = session.termsSeen.get(e) || { n: 0, t: 0 }; v.n++; v.t = now; session.termsSeen.set(e, v);
      }
      if (changed) { renderTerms(); renderStrip(); }
      const s = suggestionsFor(a);
      if (a.terms.length || s.length > 1 || a.question) renderSuggestions(s);
      // traducción en vivo: una a la vez, siempre con el texto más reciente
      if (cfg.translate) { interimPending = { text, lang, seq: interimSeq }; pumpInterimTr(); }
    }, P().interimMs);
  }
  let lastInterimTr = 0, interimTrTimer = null;
  async function pumpInterimTr() {
    if (interimTrBusy || !interimPending) return;
    const wait = P().interimTrMs - (performance.now() - lastInterimTr);   // límite de traducciones en vivo por segundo
    if (wait > 0) { clearTimeout(interimTrTimer); interimTrTimer = setTimeout(pumpInterimTr, wait); return; }
    lastInterimTr = performance.now();
    interimTrBusy = true;
    const job = interimPending; interimPending = null;
    const t = await translate(job.text, job.lang);
    interimTrBusy = false;
    if (t && job.seq === interimSeq) {
      const x = $("interim").querySelector(`.cell[data-l="${job.lang === "es" ? "en" : "es"}"]`);
      if (x) x.textContent = t + " …";
    }
    pumpInterimTr();
  }

  // ───────────────── Tarjetas ─────────────────
  // Tarjetas base (data/tarjetas.js) + tarjetas propias (guardadas solo en este navegador).
  // "claves": palabras que, al escucharse, muestran la tarjeta como sugerencia.
  let activeCat = "Introduction", cardQuery = "";
  let customCards = store.get("inturp.cards", []);
  let cardsCache = null;
  const fill = (s) => String(s || "").replace(/\{nombre\}/g, cfg.name || "___").replace(/\{id\}/g, cfg.id || "___");
  function compileKeys(c) {
    const keys = String(c.claves || "").split(/[,;|]/).map((k) => strip(k).trim()).filter((k) => k.length >= 2);
    c._re = keys.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${keys.map(reEsc).join("|")})(?![\\p{L}\\p{N}])`, "u") : null;
    return c;
  }
  // ediciones de tarjetas base (o tarjetas base ocultas), guardadas solo en este navegador
  let cardOverrides = store.get("inturp.cardOverrides", {});
  const baseKey = (c) => c.cat + "|" + c.titulo;
  function allCards() {
    if (!cardsCache) {
      const base = [];
      for (const c of window.TARJETAS || []) {
        const k = baseKey(c), o = cardOverrides[k];
        if (o && o.hidden) continue;
        base.push(compileKeys({ ...c, ...(o || {}), _base: k, _edited: !!o }));
      }
      cardsCache = base.concat(customCards.map((c, i) => compileKeys({ ...c, _custom: i })));
    }
    return cardsCache;
  }
  function saveCustomCards() { store.set("inturp.cards", customCards); store.set("inturp.cardOverrides", cardOverrides); cardsCache = null; renderCards(); }
  /** To Provider: inglés principal, español como traducción. To LEP: español principal. */
  const primaryOrder = () => (cfg.audience === "lep" ? ["es", "en"] : ["en", "es"]);
  function renderCards() {
    const cards = allCards();
    const [p1, p2] = primaryOrder();
    for (const b of $("audience").children) b.classList.toggle("on", b.dataset.aud === cfg.audience);
    const cats = [...new Set(cards.map((c) => c.cat))];
    if (!cats.includes(activeCat)) activeCat = cats[0];
    const count = (c) => cards.filter((x) => x.cat === c).length;
    $("cardTabs").innerHTML = cats.map((c) => `<button type="button" data-cat="${esc(c)}" class="${c === activeCat && !cardQuery ? "on" : ""}">${esc(c)} <i>${count(c)}</i></button>`).join("");
    const q = strip(cardQuery);
    const shown = q ? cards.filter((c) => strip(`${c.titulo} ${c.en || ""} ${c.es || ""} ${c.cat}`).includes(q)) : cards.filter((c) => c.cat === activeCat);
    $("cards").innerHTML = shown.length ? shown.map((c) => `
      <div class="card" tabindex="0" data-custom="${c._custom !== undefined ? c._custom : ""}" data-base="${c._base ? esc(c._base) : ""}">
        <span class="card-acts"><button type="button" data-cact="edit" title="Edit this card">Edit</button><button type="button" data-cact="del" title="${c._custom !== undefined ? "Delete card" : "Hide card"}">×</button></span>
        <div class="title">${q ? `<span class="cat">${esc(c.cat)}</span> ` : ""}${esc(c.titulo)}${c.claves ? ` <span class="keys" title="Shows up as a suggestion when heard: ${esc(c.claves)}">auto</span>` : ""}</div>
        <div class="pri" data-copy="${esc(fill(c[p1] || c[p2]))}">${esc(fill(c[p1] || c[p2]))}</div>
        ${c[p1] && c[p2] ? `<div class="sec" data-copy="${esc(fill(c[p2]))}">${esc(fill(c[p2]))}</div>` : ""}</div>`).join("") : `<p class="empty">No cards match “${esc(cardQuery)}”.</p>`;
    $("cardCats").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
    if (session) renderMeter();
  }
  function parseCardsCSV(text) {
    const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const first = lines[0];
    const sep = [["\t", (first.match(/\t/g) || []).length], [";", (first.match(/;/g) || []).length], [",", (first.match(/,/g) || []).length]].sort((x, y) => y[1] - x[1])[0][0];
    const rows = lines.map((l) => {
      const out = []; let cur = "", q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (c === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
        else if (c === sep && !q) { out.push(cur.trim()); cur = ""; } else cur += c;
      }
      out.push(cur.trim()); return out;
    });
    if (/^(categ|cat$)/.test(strip(rows[0][0] || ""))) rows.shift();
    // category;title;English;Spanish;keywords
    return rows.filter((r) => r[0] && (r[2] || r[3])).map((r) => ({ cat: r[0], titulo: r[1] || (r[2] || r[3]).slice(0, 30), en: r[2] || "", es: r[3] || "", claves: (r[4] || "").replace(/\|/g, ",") }));
  }

  // ───────────────── Estado de la llamada ─────────────────
  let state = "idle";        // idle | running | paused
  let t0 = 0, pausedMs = 0, pauseAt = 0, tick = null;
  const elapsed = () => (t0 ? (state === "paused" ? pauseAt : Date.now()) - t0 - pausedMs : 0);

  function setState(s) {
    state = s;
    const st = $("status");
    st.className = "status " + ({ idle: "idle", running: "run", paused: "paused" }[s]);
    st.textContent = { idle: "Idle", running: "Listening", paused: "Paused" }[s];
    $("btnStart").disabled = s !== "idle";
    $("btnPause").disabled = s === "idle";
    $("btnStop").disabled = s === "idle";
    $("btnPause").innerHTML = s === "paused"
      ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg><span>Resume</span>'
      : '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg><span>Pause</span>';
    $("selSource").disabled = s !== "idle";
  }

  // ───────────────── Audio y reconocimiento: núcleo nativo ─────────────────
  // Micrófono y audio del sistema (WASAPI loopback) los captura la app; no hace falta compartir pantalla.
  let lastLang = "es";
  function stopRecognition() { handleInterim(""); }
  function cleanupAudio() { /* el audio lo maneja el núcleo */ }
  const nativeLang = () => (cfg.lang === "auto" ? "auto" : cfg.lang.startsWith("en") ? "en" : "es");
  const ERRORS = {
    MIC_NOT_FOUND: "Microphone not found — connect one or choose “System audio” as the source.",
    MIC_FAILED: "The microphone could not be opened — check Windows privacy settings (Microphone access) and try again.",
    OUTPUT_NOT_FOUND: "No speakers or headphones found — the app listens to the audio that plays on them.",
    LOOPBACK_FAILED: "System audio could not be captured — choose “Microphone” as the source, or restart the app.",
    AUDIO_DEVICE_LOST: "The audio device stopped responding — press Pause and Resume.",
  };
  function friendly(err) {
    const msg = String((err && err.message) || err || "");
    const code = msg.split(":")[0].trim();
    if (ERRORS[code]) return ERRORS[code];
    if (/download|internet|network|connect/i.test(msg)) return "Could not download the speech engine — check your internet connection and press Start again.";
    return "Could not start — " + msg.slice(0, 120);
  }
  /** Términos que ayudan al modelo preciso a reconocer la terminología de esta llamada (no salen de la app). */
  let hintsKey = "";
  function sendHints() {
    const dom = session ? leadDomain() : null;
    const out = [];
    const add = (t) => { t = String(t || "").split(" / ")[0].trim(); if (t && t.length <= 40 && !out.includes(t)) out.push(t); };
    for (const m of myTerms) add(m.en);
    if (session) for (const [e] of [...session.termsSeen.entries()].sort((x, y) => y[1].t - x[1].t).slice(0, 12)) add(e.t);
    if (dom) for (const g of glossary) { if (out.length >= 40) break; if (g.dom === dom) add(g.t); }
    const key = out.join("|");
    if (key === hintsKey) return;
    hintsKey = key;
    window.Native.invoke("set_hints", { terms: out }).catch(() => {});
  }
  function onCore(ev) {
    switch (ev.type) {
      case "partial":
        if (session && state === "running") { lastLang = ev.lang; handleInterim(ev.text, ev.lang); }
        break;
      case "final":
        if (session) { lastLang = ev.lang; handleFinal(ev.text, ev.lang, null, ev.conf, { seg: ev.seg, group: ev.group, words: ev.words, auto: cfg.lang === "auto" }); }
        break;
      case "refined":
        if (ev.group_segs && ev.group_segs.length > 1) { applyRowRefinement(ev.group_segs, ev.skipped ? "" : ev.text, ev.lang); break; }
        onAiMessage({ data: { type: "asr", id: ev.seg, text: ev.skipped ? "" : ev.text, lang: ev.lang, margin: Math.abs(ev.margin || 0) } });
        break;
      case "engine":
        engineInfo = ev; aiReady = !!ev.accurate; aiMode = /GPU/.test(ev.accurate || "") ? "gpu" : "cpu"; renderEngineInfo();
        break;
      case "progress":
        if (ev.pct < 100) notice(`Downloading ${ev.label} — one time only (${ev.total_mb} MB)… ${ev.pct}%`);
        else notice("");
        break;
      case "notice":
        if (ev.level === "error") notice(ERRORS[ev.code] || ev.message, true);
        else { toast(ev.message, 6000); }
        break;
      case "state":
        if (ev.state === "loading") { $("status").textContent = "Starting…"; }
        break;
    }
  }
  window.Native.listen(onCore);

  async function start() {
    if (state !== "idle") return;
    prepareTranslators();
    notice("");
    session = freshSession();
    hintsKey = "";
    $("transcript").innerHTML = `<p class="empty">Starting…</p>`;
    setState("running");
    $("status").textContent = "Starting…";
    try {
      sendHints();
      await window.Native.invoke("start", { opts: { source: cfg.source, lang: nativeLang(), light: !!cfg.light } });
    } catch (err) {
      session = null; setState("idle");
      $("transcript").innerHTML = `<p class="empty">Press <b>Start</b> to begin. Nothing is saved: everything is erased when the call ends.</p>`;
      notice(friendly(err), true);
      return;
    }
    if (!session) return;   // se presionó End mientras arrancaba
    setState("running");
    $("transcript").innerHTML = `<p class="empty">Listening…</p>`;
    t0 = Date.now(); pausedMs = 0;
    tick = setInterval(() => ($("timer").textContent = fmtTime(elapsed())), 500);
  }

  async function pause() {
    if (state === "running") {
      setState("paused"); pauseAt = Date.now();
      stopRecognition();
      window.Native.invoke("pause").catch(() => {});
    } else if (state === "paused") {
      try { await window.Native.invoke("resume", { source: cfg.source }); }
      catch (err) { notice(friendly(err), true); return; }
      pausedMs += Date.now() - pauseAt;
      notice("");
      setState("running");
    }
  }

  /** Termina la llamada y BORRA todo lo relacionado con ella. */
  function stop(skipConfirm) {
    if (state === "idle" && !session) return;
    if (!skipConfirm && $("notes").value.trim() && !confirm("Ending the call will erase the transcript and your notes. End the call?")) return;
    stopRecognition();
    window.Native.invoke("end").catch(() => {});   // el núcleo borra audio y texto y libera la GPU
    clearInterval(tick); tick = null;
    wipe();
    setState("idle");
    toast("Call ended · everything erased");
  }

  function wipe() {
    $("ctxStrip").innerHTML = ""; $("prio").hidden = true;
    pinned = true; unseenRows = 0; updateJump();
    session = null; t0 = 0; pausedMs = 0;
    $("transcript").innerHTML = `<p class="empty">Call ended. All content was erased.</p>`;
    clearInterim();
    aiJobs.clear(); hintsKey = "";
    $("suggestions").innerHTML = `<p class="empty">Suggestions will appear here based on what is said.</p>`;
    $("terms").innerHTML = `<p class="empty">Glossary terms will appear here when they are heard.</p>`;
    $("termCount").textContent = "0";
    renderKeys(); seenKeys = 0; $("keysDot").textContent = "";
    $("notes").value = "";
    $("simInput").value = "";
    $("timer").textContent = "00:00";
    for (const el of $("domainMeter").children) { el.querySelector("b").textContent = "0%"; el.classList.remove("lead"); el.hidden = true; }
    renderCards();
  }

  function swapLang() {
    cfg.lang = cfg.lang.startsWith("es") ? "en-US" : cfg.lang.startsWith("en") ? "auto" : store.get("inturp.lastEs", "es-MX");
    applyLang();
  }
  function applyLang() {
    $("selLang").value = cfg.lang; saveCfg();
    if (cfg.lang.startsWith("es")) store.set("inturp.lastEs", cfg.lang);
    toast(cfg.lang === "auto" ? "Language: automatic (EN + ES)" : cfg.lang.startsWith("es") ? "Listening: Spanish" : "Listening: English");
    prepareTranslators();
    if (state !== "idle") window.Native.invoke("set_lang", { lang: nativeLang() }).catch(() => {});
  }

  async function renderStorage() {
    try {
      const st = await window.Native.invoke("storage");
      const mb = (b) => (b >= 1e9 ? (b / 1073741824).toFixed(1) + " GB" : Math.max(0, Math.round(b / 1048576)) + " MB");
      $("storageInfo").textContent = `App ${mb(st.app)} · Speech and translation models ${mb(st.models)} · Your settings ${Math.max(1, Math.round(st.config / 1024))} KB · Window cache ${mb(st.webview)} — folder: ${st.folder}`;
    } catch { $("storageInfo").textContent = ""; }
  }

  // ───────────────── Importación de glosario ─────────────────
  function parseGlossary(text) {
    text = text.trim();
    if (!text) return [];
    if (text[0] === "[" || text[0] === "{") {
      let j = JSON.parse(text); if (!Array.isArray(j)) j = j.items || [];
      return j.map((o) => ({ t: o.t || o.term || o.termino || o["término"], tr: o.tr || o.translation || o.traduccion || "", d: o.d || o.definition || o.definicion || "", dom: normDom(o.dom || o.domain || o.dominio) })).filter((e) => e.t);
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const first = lines[0];
    const sep = [["\t", (first.match(/\t/g) || []).length], [";", (first.match(/;/g) || []).length], [",", (first.match(/,/g) || []).length]].sort((a, b) => b[1] - a[1])[0][0];
    const splitLine = (l) => {
      const out = []; let cur = "", q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (c === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
        else if (c === sep && !q) { out.push(cur.trim()); cur = ""; }
        else cur += c;
      }
      out.push(cur.trim()); return out;
    };
    const rows = lines.map(splitLine);
    if (/^(term|termino|palabra|word|es|spanish|espanol)/.test(strip(rows[0][0] || ""))) rows.shift();
    return rows.filter((r) => r[0]).map((r) => ({ t: r[0], tr: r[1] || "", d: r[2] || "", dom: normDom(r[3]) }));
  }

  // ───────────────── Eventos ─────────────────
  function bind() {
    $("selLang").value = cfg.lang; $("selSource").value = cfg.source;
    if (!["mic", "system", "mix"].includes(cfg.source)) cfg.source = "system";
    $("selSource").value = cfg.source;
    $("cfgName").value = cfg.name; $("cfgId").value = cfg.id;

    $("btnStart").onclick = start;
    $("btnPause").onclick = pause;
    $("btnStop").onclick = () => stop(false);
    $("btnSwap").onclick = swapLang;
    $("selLang").onchange = (e) => { cfg.lang = e.target.value; applyLang(); };
    $("cfgPrecise").checked = cfg.precise;
    $("cfgPrecise").onchange = (e) => { cfg.precise = e.target.checked; saveCfg(); };
    $("cfgTranslate").checked = cfg.translate;
    $("cfgTranslate").onchange = (e) => { cfg.translate = e.target.checked; saveCfg(); if (cfg.translate) prepareTranslators(); };
    $("trInfo").textContent = "Offline translator (Bergamot) running on this computer.";

    $("audience").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      cfg.audience = b.dataset.aud; saveCfg(); renderCards();
      if (session && $("suggestions").querySelector(".sugg")) $("suggestions").querySelectorAll(".sugg").forEach((el) => {
        const [p1, p2] = primaryOrder(); const pri = el.querySelector(".pri"), sec = el.querySelector(".sec");
        if (pri && sec) { pri.textContent = el.dataset[p1]; pri.dataset.l = p1; sec.textContent = el.dataset[p2]; sec.dataset.l = p2; }
      });
    };
    // tarjetas propias
    const renderMyTerms = () => {
      const row = (m, i) => `<div class="myterm"><span><b>${esc(String(m.en).split(" / ")[0])}</b>${m.acronym ? ` <small>(${esc(String(m.en).split(" / ").slice(1).join(" / "))})</small>` : ""} → ${esc(m.es)}</span><button type="button" data-i="${i}" title="Delete">×</button></div>`;
      $("myTermsList").innerHTML = myTerms.some((m) => !m.acronym) ? myTerms.map((m, i) => (m.acronym ? "" : row(m, i))).join("") : `<p class="hint">No terms yet.</p>`;
      $("acroList").innerHTML = myTerms.some((m) => m.acronym) ? myTerms.map((m, i) => (m.acronym ? row(m, i) : "")).join("") : `<p class="hint">No acronyms yet.</p>`;
    };
    const renderFixes = () => {
      $("fixList").innerHTML = fixes.length ? fixes.map((f, i) => `<div class="myterm"><span>${esc(f.heard)} → <b>${esc(f.correct)}</b></span><button type="button" data-i="${i}" title="Delete">×</button></div>`).join("") : `<p class="hint">No corrections yet.</p>`;
    };
    const showVocabTab = (t) => {
      for (const b of $("vocabTabs").children) b.classList.toggle("on", b.dataset.vt === t);
      $("vtFix").hidden = t !== "fix"; $("vtTr").hidden = t !== "tr"; $("vtAcro").hidden = t !== "acro";
    };
    $("btnSaveAcro").onclick = () => {
      const ac = $("acroAc").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""), full = $("acroFull").value.trim(), es = $("acroEs").value.trim();
      if (!ac || !es) { $("acroInfo").textContent = "Write the acronym and how it should appear in Spanish."; return; }
      const en = full ? `${ac} / ${full}` : ac;
      myTerms = myTerms.filter((m) => strip(String(m.en).split(" / ")[0]) !== strip(ac)).concat([{ en, es, note: $("acroMeaning").value.trim() || full, dom: $("acroDom").value, acronym: true }]);
      store.set("inturp.myterms", myTerms); loadGlossary(); renderMyTerms();
      $("acroAc").value = ""; $("acroFull").value = ""; $("acroEs").value = ""; $("acroMeaning").value = "";
      $("acroInfo").textContent = `Saved: ${ac}${full ? " (" + full + ")" : ""} → ${es}`;
    };
    $("acroList").onclick = (e) => {
      const b = e.target.closest("button[data-i]"); if (!b) return;
      myTerms.splice(+b.dataset.i, 1); store.set("inturp.myterms", myTerms); loadGlossary(); renderMyTerms();
    };
    const openVocab = (tab, heard) => {
      $("termForm").reset(); $("termInfo").textContent = ""; $("fixInfo").textContent = "";
      renderMyTerms(); renderFixes(); showVocabTab(tab || "fix");
      if (heard) { $("fixHeard").value = heard; $("termEn").value = heard; }
      $("dlgTerm").showModal();
      setTimeout(() => (heard ? $("fixCorrect") : $("fixHeard")).focus(), 30);
    };
    $("btnAddTerm").onclick = () => openVocab("fix");
    $("btnVocab").onclick = () => openVocab("fix");
    $("vocabTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) showVocabTab(b.dataset.vt); };
    $("btnSaveFix").onclick = () => {
      const heard = $("fixHeard").value.trim(), correct = $("fixCorrect").value.trim();
      if (!heard || !correct) { $("fixInfo").textContent = "Write what was heard and what it should be."; return; }
      fixes = fixes.filter((f) => strip(f.heard) !== strip(heard)).concat([{ heard, correct }]);
      store.set("inturp.fixes", fixes); buildFixes(); renderFixes(); reapplyFixes();
      $("fixHeard").value = ""; $("fixCorrect").value = ""; $("fixInfo").textContent = `Saved: “${heard}” → “${correct}”`;
    };
    $("fixList").onclick = (e) => {
      const b = e.target.closest("button[data-i]"); if (!b) return;
      fixes.splice(+b.dataset.i, 1); store.set("inturp.fixes", fixes); buildFixes(); renderFixes();
    };
    // botón Fix de cada fila: usa lo que tengas seleccionado en esa fila
    $("transcript").addEventListener("click", (e) => {
      const b = e.target.closest(".trow .fix"); if (!b) return;
      const row = b.closest(".trow");
      const sel = String(window.getSelection ? window.getSelection() : "").trim();
      const inRow = sel && row.contains(window.getSelection().anchorNode);
      openVocab("fix", inRow ? sel : "");
    });
    $("btnSaveTerm").onclick = () => {
      const en = $("termEn").value.trim(), es = $("termEs").value.trim();
      if (!en || !es) { $("termInfo").textContent = "Write the English term and your preferred Spanish translation."; return; }
      myTerms = myTerms.filter((m) => strip(m.en) !== strip(en)).concat([{ en, es, note: $("termNote").value.trim(), dom: $("termDom").value }]);
      store.set("inturp.myterms", myTerms); loadGlossary(); renderMyTerms();
      $("termForm").reset(); $("termInfo").textContent = `Saved: ${en} → ${es}`;
    };
    $("myTermsList").onclick = (e) => {
      const b = e.target.closest("button[data-i]"); if (!b) return;
      myTerms.splice(+b.dataset.i, 1); store.set("inturp.myterms", myTerms); loadGlossary(); renderMyTerms();
    };
    let editingCard = null;   // { custom: index } | { base: key } | null (nueva)
    const openCardDialog = (card) => {
      $("cardForm").reset(); $("cardInfo").textContent = "";
      editingCard = card ? (card._custom !== undefined ? { custom: card._custom } : { base: card._base }) : null;
      $("cardDlgTitle").textContent = card ? "Edit card" : "New card";
      $("cardBulkBox").hidden = !!card;
      $("btnResetCard").hidden = !(card && card._edited);
      if (card) { $("cardCat").value = card.cat; $("cardTitle").value = card.titulo || ""; $("cardEn").value = card.en || ""; $("cardEs").value = card.es || ""; $("cardKeys").value = card.claves || ""; }
      else $("cardCat").value = activeCat;
      $("dlgCard").showModal();
    };
    $("btnAddCard").onclick = () => openCardDialog(null);
    $("btnResetCard").onclick = () => {
      if (editingCard && editingCard.base) { delete cardOverrides[editingCard.base]; saveCustomCards(); $("dlgCard").close(); toast("Card restored to the original"); }
    };
    $("btnSaveCard").onclick = () => {
      const c = { cat: $("cardCat").value.trim() || "My cards", titulo: $("cardTitle").value.trim(), es: $("cardEs").value.trim(), en: $("cardEn").value.trim(), claves: $("cardKeys").value.trim() };
      if (editingCard) {
        if (!c.es && !c.en) { $("cardInfo").textContent = "Write at least the English or Spanish text."; return; }
        if (!c.titulo) c.titulo = (c.en || c.es).slice(0, 30);
        if (editingCard.custom !== undefined) customCards[editingCard.custom] = c;
        else cardOverrides[editingCard.base] = c;
        activeCat = c.cat; saveCustomCards(); $("dlgCard").close(); toast("Card updated"); editingCard = null;
        return;
      }
      const bulk = $("cardBulk").value.trim();
      const items = bulk ? parseCardsCSV(bulk) : (c.es || c.en ? [{ ...c, titulo: c.titulo || (c.en || c.es).slice(0, 30) }] : []);
      if (!items.length) { $("cardInfo").textContent = "Write at least the English or Spanish text (or paste CSV rows)."; return; }
      customCards = customCards.concat(items);
      activeCat = items[items.length - 1].cat;
      saveCustomCards();
      $("dlgCard").close();
      toast(items.length > 1 ? `${items.length} cards added` : "Card added");
    };
    $("selSource").onchange = (e) => { cfg.source = e.target.value; saveCfg(); };
    $("btnSettings").onclick = () => { renderEngineInfo(); renderStorage(); $("dlgSettings").showModal(); };
    $("cfgName").oninput = (e) => { cfg.name = e.target.value; saveCfg(); renderCards(); };
    $("cfgId").oninput = (e) => { cfg.id = e.target.value; saveCfg(); renderCards(); };

    $("suggestions").onclick = (e) => {
      const el = e.target.closest(".sugg"); if (!el) return;
      const l = (e.target.closest("[data-l]") || el.querySelector(".pri")).dataset.l;
      copy(el.dataset[l]);
    };
    $("cardTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) { activeCat = b.dataset.cat; cardQuery = ""; $("cardFilter").value = ""; renderCards(); $("cards").scrollTop = 0; } };
    $("cards").onclick = (e) => {
      const act = e.target.closest("[data-cact]");
      if (act) {
        const el = act.closest(".card");
        const card = allCards().find((c) => (el.dataset.custom !== "" && c._custom === +el.dataset.custom) || (el.dataset.base && c._base === el.dataset.base));
        if (!card) return;
        if (act.dataset.cact === "edit") { openCardDialog(card); return; }
        if (card._custom !== undefined) { if (confirm("Delete this card?")) { customCards.splice(card._custom, 1); saveCustomCards(); } }
        else if (confirm("Hide this card? (You can restore all cards in Settings.)")) { cardOverrides[card._base] = { hidden: true }; saveCustomCards(); }
        return;
      }
      const el = e.target.closest("[data-copy]") || e.target.closest(".card")?.querySelector(".pri"); if (el) copy(el.dataset.copy);
    };
    $("transcript").addEventListener("scroll", () => {
      const was = pinned; pinned = isAtBottom();
      if (pinned) unseenRows = 0;
      if (was !== pinned || pinned) updateJump();
    }, { passive: true });
    $("transcript").addEventListener("click", (e) => { const b = e.target.closest(".trow .lang"); if (b) flipRowLang(b.closest(".trow")); });
    $("jumpLive").onclick = () => { const t = $("transcript"); pinned = true; unseenRows = 0; t.scrollTop = t.scrollHeight; updateJump(); };
    // columnas: "orig" = izquierda lo que se dijo (cualquier idioma), derecha la traducción; "lang" = English | Español
    const applyCols = () => {
      const orig = cfg.cols !== "lang";
      $("trPanel").classList.toggle("layout-orig", orig); $("trPanel").classList.toggle("layout-lang", !orig);
      $("colLeft").textContent = orig ? "Original" : "English"; $("colRight").textContent = orig ? "Translation" : "Español";
      for (const b of $("colsMode").children) b.classList.toggle("on", b.dataset.cols === (orig ? "orig" : "lang"));
    };
    applyCols();
    $("colsMode").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; cfg.cols = b.dataset.cols; saveCfg(); applyCols(); };
    // tamaño de letra de la transcripción (accesibilidad)
    const applyFont = () => { document.documentElement.style.setProperty("--tsize", cfg.fontSize + "px"); };
    applyFont();
    $("btnFontDown").onclick = () => { cfg.fontSize = Math.max(12, cfg.fontSize - 1); saveCfg(); applyFont(); };
    $("btnFontUp").onclick = () => { cfg.fontSize = Math.min(28, cfg.fontSize + 1); saveCfg(); applyFont(); };
    // secciones plegables (se recuerda cuáles cerraste)
    for (const box of document.querySelectorAll(".box[data-box]")) {
      const id = box.dataset.box;
      box.classList.toggle("collapsed", !!cfg.collapsed[id]);
      box.querySelector(".collapse").onclick = () => {
        cfg.collapsed[id] = !cfg.collapsed[id]; saveCfg();
        box.classList.toggle("collapsed", cfg.collapsed[id]);
      };
    }
    $("cardFilter").oninput = (e) => { cardQuery = e.target.value.trim(); renderCards(); };
    $("ctxStrip").onclick = (e) => { const b = e.target.closest("[data-copy]"); if (b) copy(b.dataset.copy); };
    $("sideTabs").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const g = $("grid"); g.classList.toggle("t-assist", b.dataset.t === "assist"); g.classList.toggle("t-side", b.dataset.t === "side");
      for (const x of $("sideTabs").children) x.classList.toggle("on", x === b);
      if (b.dataset.t === "side") { seenKeys = session ? session.keys.length : 0; $("keysDot").textContent = ""; }
    };
    $("keys").onclick = (e) => {
      const btn = e.target.closest("button[data-act]"); if (!btn || !session) return;
      const k = session.keys.find((x) => x.id === +btn.closest(".key").dataset.id); if (!k) return;
      const act = btn.dataset.act;
      if (act === "copy") copy(k.value);
      else if (act === "note") { addToNotes(keyLine(k)); toast("Added to notes"); }
      else if (act === "reveal") { k.revealed = !k.revealed; renderKeys(); renderStrip(); }
      else if (act === "ok") { k.check = false; k.confirmed = true; k.note = "Confirmed"; renderKeys(); }
      else if (act === "del") { k.hidden = true; renderKeys(); renderStrip(); }
    };
    $("btnKeysToNotes").onclick = () => {
      if (!session) return;
      const list = session.keys.filter((k) => !k.hidden && k.type !== "number");
      if (!list.length) return;
      addToNotes(list.map(keyLine).join("\n")); toast("Key information added to notes");
    };
    $("btnResetCards").onclick = () => { if (confirm("Restore all built-in cards to their original text (your own cards are kept)?")) { cardOverrides = {}; saveCustomCards(); toast("Built-in cards restored"); } };
    // diagnóstico: solo datos técnicos (modelos, tiempos, memoria); nunca texto de la llamada
    $("btnCopyDiag").onclick = async () => {
      let core = "";
      try { core = await window.Native.invoke("diagnostics"); } catch (e) { core = "core: " + e; }
      const info = [`Window: ${innerWidth}×${innerHeight} · ${navigator.userAgent}`, $("engineInfo").textContent, core].join("\n");
      const box = $("diagText"); box.hidden = false; box.value = info;
      box.focus(); box.select();
      copy(info);
    };
    $("cfgLight").checked = !!cfg.light;
    $("cfgLight").onchange = (e) => { cfg.light = e.target.checked; saveCfg(); toast(cfg.light ? "Light mode: applies from the next call" : "Full accuracy: applies from the next call", 3500); };
    $("btnFreeGpu").onclick = () => { window.Native.invoke("free_gpu").then(() => toast("Graphics card released — the call continues with the fast engine", 4000)).catch(() => {}); };
    $("btnCleanup").onclick = async () => {
      try { const r = await window.Native.invoke("cleanup"); toast(r.freed_mb ? `Cleaned up ${r.freed_mb} MB` : "Nothing to clean up", 3000); } catch { /* */ }
      renderStorage();
    };
    $("cfgMask").checked = cfg.mask;
    $("cfgMask").onchange = (e) => { cfg.mask = e.target.checked; saveCfg(); if (session) renderKeys(); };
    $("btnCopyNotes").onclick = () => $("notes").value.trim() && copy($("notes").value);

    $("simForm").onsubmit = (e) => {
      e.preventDefault();
      const v = $("simInput").value; if (!v.trim()) return;
      if (!session) { session = freshSession(); if (!t0) { t0 = Date.now(); pausedMs = 0; } }
      if (state === "idle") $("btnStop").disabled = false;
      handleFinal(v, cfg.lang === "auto" ? (/\b(the|and|my|is|you|i|to|of)\b/i.test(v) ? "en" : "es") : langOf()); $("simInput").value = "";
      $("btnStop").disabled = false;
    };

    // Buscador: cualquier palabra (aunque no se haya mencionado), tolera errores ("mortgag"), y si no está en el
    // glosario la traduce con el traductor offline y permite guardarla en tus términos.
    let searchT, searchSeq = 0;
    $("glossSearch").oninput = (e) => {
      clearTimeout(searchT);
      const raw = e.target.value.trim(), q = strip(raw);
      const box = $("glossResults");
      if (q.length < 2) { box.innerHTML = ""; return; }
      const qw = q.split(/\s+/).filter((w) => w.length >= 2);
      const scoreOf = (g) => {
        const words = strip(`${g.t} ${g.tr}`).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
        let sc = 0;
        for (const w of qw) {
          if (words.includes(w)) sc += 3;
          else if (words.some((x) => x.startsWith(w))) sc += 2;
          else if (w.length >= 5 && words.some((x) => Math.abs(x.length - w.length) <= 2 && lev(x, w) <= 2)) sc += 1;
          else if (strip(g.d || "").includes(w)) sc += 0.5;
          else return 0;
        }
        if (strip(String(g.t).split(" / ")[0]).startsWith(q) || strip(String(g.tr).split(",")[0]).startsWith(q)) sc += 2;
        return sc;
      };
      const res = glossary.map((g) => [g, scoreOf(g)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 20).map((x) => x[0]);
      // si está en el glosario, se muestra su ficha; si no, se traduce con el traductor offline
      const lookup = !res.length && cfg.translate;
      box.innerHTML = res.map((g) => termHTML(g)).join("") + (lookup ? `<div id="lookupRow" class="lookup"><span class="empty">Not in the glossary — translating “${esc(raw)}”…</span></div>` : (res.length ? "" : `<p class="empty">No results.</p>`));
      if (!lookup) return;
      const seq = ++searchSeq;
      searchT = setTimeout(async () => {
        const from = /[ñáéíóú¿¡]/i.test(raw) || detectTextLang(raw + " ") === "es" ? "es" : "en";
        const t = await translate(raw, from);
        const row = $("lookupRow");
        if (seq !== searchSeq || !row) return;
        if (!t || strip(t) === q) { row.innerHTML = res.length ? "" : `<p class="empty">No results.</p>`; return; }
        row.innerHTML = `<span class="lk-l">${from === "en" ? "EN → ES" : "ES → EN"}</span> <b>${esc(raw)}</b> → <span class="tr">${esc(t)}</span> <button type="button" class="btn ghost tiny" data-add="1" title="Save it with this (or your own) translation">+ My terms</button>`;
        row.querySelector("[data-add]").onclick = () => {
          openVocab("tr");
          $("termEn").value = from === "en" ? raw : t; $("termEs").value = from === "en" ? t : raw; $("termEs").focus();
        };
      }, 350);
    };

    $("fileGloss").onchange = async (e) => { const f = e.target.files[0]; if (f) $("pasteGloss").value = await f.text(); };
    $("btnImport").onclick = () => {
      try {
        const items = parseGlossary($("pasteGloss").value);
        if (!items.length) { $("glossInfo").textContent = "No valid rows found."; return; }
        const prev = store.get("inturp.gloss", null);
        const replace = $("cfgReplace").checked;
        const merged = replace ? items : (prev ? prev.items : []).concat(items);
        store.set("inturp.gloss", { replace: replace || !!(prev && prev.replace), items: merged });
        loadGlossary();
        $("glossInfo").textContent = `Imported ${items.length} entries · active glossary: ${glossary.length}.`;
        $("pasteGloss").value = ""; $("fileGloss").value = "";
      } catch (err) { $("glossInfo").textContent = "Read error: " + err.message; }
    };
    $("btnResetGloss").onclick = () => { store.del("inturp.gloss"); loadGlossary(); };

    document.addEventListener("keydown", (e) => {
      if (!e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "s") { e.preventDefault(); start(); }
      else if (k === "p") { e.preventDefault(); pause(); }
      else if (k === "e") { e.preventDefault(); stop(false); }
      else if (k === "l") { e.preventDefault(); swapLang(); }
    });
    // Si se cierra o recarga la pestaña, todo se descarta.
    window.addEventListener("pagehide", () => { stopRecognition(); session = null; $("notes").value = ""; });
  }

  buildFixes();
  loadGlossary();
  bind();
  renderCards();
  setState("idle");
  // Primer uso: descarga una sola vez los modelos de voz y traducción (con progreso). Después todo funciona sin internet.
  window.Native.invoke("models_ready").then((ok) => {
    if (ok) return;
    notice("Setting up for first use — downloading the speech and translation engines (one time only)…");
    window.Native.invoke("prepare_models", { light: !!cfg.light })
      .then(() => { notice(""); toast("Ready — from now on everything works offline", 5000); })
      .catch(() => notice("Could not finish the one-time download — check your internet connection and restart the app.", true));
  }).catch(() => {});
  // Gancho mínimo para pruebas automáticas (no expone datos de llamadas).
  window.__inturp = { analyze, suggestionsFor, parseGlossary, translate, getBergamot, handleFinalRaw: (t, l, c) => { if (!session) session = freshSession(); handleFinal(t, l, null, c); }, handleFinal: (t) => { if (!session) session = freshSession(); handleFinal(t); }, wipe: () => { stop(true); wipe(); } };
})();
