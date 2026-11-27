/* Inturpreneur — asistente de interpretación en vivo.
 * Todo corre en el navegador. Nada del texto de la llamada se guarda (ni localStorage, ni red):
 * vive solo en memoria y en pantalla, y se borra al presionar "Terminar" o cerrar la pestaña.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
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
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
  };
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
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove();
    }
    toast("Copied");
  }

  // ───────────────── Configuración (solo preferencias, nunca texto de llamadas) ─────────────────
  const cfg = Object.assign({ name: "", id: "", local: false, lang: "auto", source: "mic", engine: "vosk", translate: true, audience: "provider", precise: true, mask: true, fontSize: 15, collapsed: {}, perf: "auto", whisperSmall: true, cols: "orig" }, store.get("inturp.cfg", {}));

  // ───────────────── Perfil de rendimiento (se adapta a cada dispositivo) ─────────────────
  // Lite: sin Whisper, menos trabajo en vivo (equipos modestos).  Balanced: Whisper solo corrige frases dudosas.
  // Max: Whisper corrige todas las frases. "auto" elige según núcleos y memoria del equipo.
  const PERF = {
    lite:     { label: "Lite",     whisper: "off", interimMs: 150, interimTrMs: 1200, threads: 1 },
    balanced: { label: "Balanced", whisper: "low", interimMs: 80,  interimTrMs: 550,  threads: 2 },
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
    const mine = myTerms.map((m) => ({ t: m.en, tr: m.es, d: m.note || "Your preferred translation", dom: normDom(m.dom), mine: true }));
    glossary = mine.concat(extra ? (extra.replace ? extra.items : base.concat(extra.items)) : base);
    buildIndex();
    mtCache.clear();
  }
  /** Cómo traduce la máquina un término suelto (para luego cambiarlo por tu traducción preferida). */
  const mtCache = new Map();
  function mtRendering(term, from) {
    const k = from + ":" + term;
    if (!mtCache.has(k)) mtCache.set(k, translateRaw(term, from).then((t) => (t || "").replace(/[.!?¡¿"]/g, "").trim()).catch(() => ""));
    return mtCache.get(k);
  }
  async function enforceMyTerms(src, out, from) {
    if (!myTerms.length || !out) return out;
    const n = strip(src);
    for (const m of myTerms) {
      const srcTerm = from === "en" ? m.en : m.es.split(/[,/]/)[0].trim();
      const want = from === "en" ? m.es.split(/[,/]/)[0].trim() : m.en;
      if (!srcTerm || !want || !new RegExp(`(?<![\\p{L}])${reEsc(strip(srcTerm))}(?![\\p{L}])`, "u").test(n)) continue;
      if (strip(out).includes(strip(want))) continue;
      const mt = await mtRendering(srcTerm, from);
      if (mt && mt.length > 1) {
        const re = new RegExp(`(?<![\\p{L}])${reEsc(mt)}(?![\\p{L}])`, "iu");
        if (re.test(out)) { out = out.replace(re, want); continue; }
      }
    }
    return out;
  }
  /** Saca las formas buscables de un texto: "ATM (Automated Teller Machine)" → atm, automated teller machine;
   *  "copago, pago compartido / co-pay" → cada variante; "beneficiario(a)" → beneficiario; "to renew" → renew. */
  function keyVariants(text) {
    const out = [];
    const add = (v) => {
      v = strip(v).replace(/^\s*(to|the|el|la|los|las|un|una)\s+/, "").replace(/[“”"']/g, "").replace(/\s+/g, " ").trim();
      if (v.length < 2) return;
      out.push(v);
      if (v.includes(".")) { const d = v.replace(/\./g, "").replace(/\s+/g, " ").trim(); if (d.length >= 2) out.push(d); }
    };
    for (const part of String(text).split(/[,;/]/)) {
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
      while ((m = termRe.exec(n))) {
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
      <span class="w">${e.mine ? `<span class="mine" title="Your term">★</span> ` : ""}${esc(e.t)}</span> → <span class="tr">${esc(e.tr || "")}</span>
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
  const hasTranslator = () => "Translator" in self;
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
      const url = new URL("models/bergamot/registry.json", location.href).href;
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
  async function translate(text, from) {
    if (!cfg.translate || !text) return null;
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

  // ───────────────── Transcripción precisa (Whisper local, en un worker) ─────────────────
  // Vosk muestra el texto al instante; Whisper vuelve a transcribir cada frase cerrada y la corrige.
  let ai = null, aiReady = false, aiFailed = false, aiSeq = 0, aiMode = "";
  const aiJobs = new Map();
  function getAi() {
    if (!cfg.precise || aiFailed || P().whisper === "off" || typeof Worker === "undefined") return null;
    if (!ai) {
      try { ai = new Worker("ai-worker.js", { type: "module" }); } catch { aiFailed = true; return null; }
      ai.onmessage = onAiMessage;
      ai.onerror = () => { aiFailed = true; ai = null; };
      ai.postMessage({ type: "load", threads: P().threads, allowSmall: cfg.whisperSmall !== false });
    }
    return ai;
  }
  function onAiMessage(e) {
    const m = e.data || {};
    if (m.type === "progress") { if (m.pct < 100) notice(`Downloading the high-accuracy model (one time only, ~${m.mb} MB)… ${m.pct}%`); }
    else if (m.type === "ready") { aiReady = true; aiMode = m.mode || ""; notice(""); toast(`High-accuracy mode ready${m.mode === "gpu-small" ? " · Whisper small on GPU" : /gpu/.test(m.mode) ? " · using GPU" : ""}`, 3000); }
    else if (m.type === "error" && !m.id) { aiFailed = true; notice("High-accuracy mode is not available in this browser; using the fast transcript only."); setTimeout(() => notice(""), 6000); }
    else if (m.type === "asr" || m.type === "error") {
      const job = aiJobs.get(m.id); aiJobs.delete(m.id);
      if (!job) return;
      job.row.classList.remove("refining");
      if (m.lang && m.lang !== job.lang && !job.unclear && job.row._lang === job.lang) { flipRowLang(job.row, true); job.lang = m.lang; job.forced = true; }
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
  /** ¿La corrección de Whisper es segura? Debe conservar las palabras que el motor rápido entendió con seguridad
   *  y todos los dígitos; si no, se queda la versión original (evita perder información). */
  function safeRefinement(part, newText) {
    const W = (t) => strip(t).replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
    const digitsOf = (t) => (window.KeyInfo ? KeyInfo.numberGroups(strip(t).replace(/(\d)(st|nd|rd|th)\b/g, "$1")).map((g) => g.digits).join("") : (t.match(/\d/g) || []).join(""));
    const wo = W(part.text), wn = W(newText);
    if (!wn.length || wn.length > wo.length * 2 + 4) return false;              // alucinación
    const isNum = (w) => window.KeyInfo && KeyInfo.numberGroups(w).length > 0;
    const sure = (part.vwords ? part.vwords.filter((x) => (x.conf || 0) >= 0.9).map((x) => strip(x.word)) : wo).filter((w) => !isNum(w) && w.length > 1);
    const have = new Set(wn);
    const near = (w) => have.has(w) || (w.length >= 4 && wn.some((x) => Math.abs(x.length - w.length) <= 1 && lev(x, w) <= 1));
    if (sure.length >= 2 && sure.filter(near).length / sure.length < 0.75) return false;   // dejó fuera palabras seguras
    if (!part.vwords && wn.length < wo.length * 0.7) return false;
    const dOld = digitsOf(part.text), dNew = digitsOf(newText);
    if (dOld.length >= 2 && !dNew.includes(dOld)) return false;                // perdió o cambió números
    return true;
  }
  function lev(a, b) {
    const m = a.length, n = b.length; if (Math.abs(m - n) > 1) return 2;
    const d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function applyRefinement(job, text) {
    if (!session || !job.row.isConnected || !job.part) return;
    const row = job.row, part = job.part;
    const det = detectTextLang(text);
    if (det && det !== job.lang && row._lang === job.lang && row._parts.length === 1) {
      flipRowLang(row, true);   // mueve de columna sin volver a pedir Whisper
      job.lang = det; job.forced = true;
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
    if (row._audio && row._parts && row._parts.length === 1 && cfg.precise && aiReady && getAi()) {
      const id = ++aiSeq, audio = row._audio.slice();
      aiJobs.set(id, { row, part: row._parts && row._parts[0], lang, terms: new Set(), forced: true });
      row.classList.add("refining");
      ai.postMessage({ type: "asr", id, lang, audio, conf: 0 }, [audio.buffer]);
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
  function tidy(text, lang) {
    text = applyFixes(text);
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
      return addUnclearRow(text, lang, audio, conf);
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
    const merge = !opts.replace && last && last._parts && !last.classList.contains("unclear") && last._lang === lang
      && now - last._t < MERGE_MS && !/[.?!…]\s*$/.test(last._text) && last._parts.length < 8
      && !(prevPart && prevPart.question) && !newTurn;
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
      row._lang = lang; row._parts = [part]; row._tags = new Set(tags); row._time = fmtTime(elapsed());
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
    if (opts.refined) { const o = row.querySelector(".cell.orig"); o.classList.add("refined", "flash"); setTimeout(() => o.classList.remove("flash"), 900); }
    clearInterim();
    fillTranslation(row, row._text, lang);   // se traduce la oración completa (no pedazos)

    // corrección con Whisper: en Max todas las frases; en Balanced solo las que el motor rápido no entendió bien
    const gpuFast = /gpu/.test(aiMode);
    const needs = P().whisper === "all" || gpuFast || (P().whisper === "low" && (conf === undefined || conf === null || conf < LOW_CONF || opts.ambiguous));
    if (needs && audio && audio.length > 8000 && cfg.precise && aiReady && getAi() && !numericMostly(text)) {
      const id = ++aiSeq;
      aiJobs.set(id, { row, part, lang, terms: part.terms });
      row.classList.add("refining");
      if (row._parts.length === 1) {
        row._audio = audio.slice();   // copia (últimas 30 frases) para poder re-transcribir si se corrige el idioma
        const withAudio = [...tr.querySelectorAll(".trow")].filter((r) => r._audio);
        while (withAudio.length > 30) withAudio.shift()._audio = null;
      } else row._audio = null;
      // en modo Auto, Whisper confirma el idioma si la decisión fue dudosa (o siempre, en perfil Max)
      const detect = !!opts.auto && row._parts.length === 1 && (opts.ambiguous || P().whisper === "all" || gpuFast);
      ai.postMessage({ type: "asr", id, lang, audio, conf: conf || 0, detect }, [audio.buffer]);
    }

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
  function addUnclearRow(text, lang, audio, conf) {
    const tr = $("transcript");
    if (session.count === 0) tr.innerHTML = "";
    session.count++;
    const row = document.createElement("div");
    row.className = "trow unclear";
    row._lang = lang; row._text = text;
    const canCheck = audio && audio.length > 8000 && cfg.precise && aiReady && getAi();
    row.innerHTML = `<div class="meta"><span class="time">${fmtTime(elapsed())}</span><span class="tag unclear-tag">${canCheck ? "Unclear audio · checking" : "Unclear audio"}</span></div>`
      + `<div class="cell unclear-text" title="Low confidence (${Math.round(conf * 100)}%) — the audio may be noisy, music, or another language">${esc(text)}</div>`;
    withStableScroll(() => { tr.appendChild(row); while (tr.children.length > 400) tr.firstChild.remove(); });
    clearInterim();
    if (canCheck) {
      const id = ++aiSeq;
      aiJobs.set(id, { row, text, lang, terms: new Set(), unclear: true });
      row._audio = audio.slice();
      ai.postMessage({ type: "asr", id, lang, audio, conf: 0, detect: cfg.lang === "auto" }, [audio.buffer]);
    }
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
    const terms = [...session.termsSeen.entries()].map(([e, v]) => ({ t: v.t, html: `<button type="button" class="chip term-chip ${e.dom}" data-copy="${esc(e.tr)}" title="${esc(e.d || "")}"><b>${esc(e.t)}</b> ${esc(String(e.tr || "").split(",")[0])}</button>` }));
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
  function allCards() {
    if (!cardsCache) cardsCache = (window.TARJETAS || []).map((c) => compileKeys({ ...c })).concat(customCards.map((c, i) => compileKeys({ ...c, _custom: i })));
    return cardsCache;
  }
  function saveCustomCards() { store.set("inturp.cards", customCards); cardsCache = null; renderCards(); }
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
      <div class="card" tabindex="0">${c._custom !== undefined ? `<button type="button" class="del" data-del="${c._custom}" title="Delete card">×</button>` : ""}
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

  // ───────────────── Captura de audio y reconocimiento ─────────────────
  // Dos motores:
  //  • "vosk": 100 % local (WebAssembly). Escucha cualquier fuente (micrófono, pestaña, sistema). Sin internet.
  //  • "browser": Web Speech API de Chrome/Edge (usa el servicio en línea del navegador).
  let state = "idle";        // idle | running | paused
  let rec = null, streams = [], audioCtx = null, track = null, trackSupported = true;
  let t0 = 0, pausedMs = 0, pauseAt = 0, tick = null, errStreak = 0, netErr = 0;
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
    $("selEngine").disabled = s !== "idle";
  }
  function forcePause(msg) {
    notice(msg, true);
    stopRecognition();
    if (state === "running") { setState("paused"); pauseAt = Date.now(); }
  }

  async function getAudioTrack(source) {
    if (source === "mic") {
      if (cfg.engine === "browser") return null; // Web Speech usa el micrófono predeterminado directamente
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streams.push(mic);
      return mic.getAudioTracks()[0];
    }
    const disp = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include", selfBrowserSurface: "exclude", preferCurrentTab: false,
    });
    streams.push(disp);
    const sysTrack = disp.getAudioTracks()[0];
    if (!sysTrack) throw new Error("NO_SYSTEM_AUDIO");
    sysTrack.addEventListener("ended", () => { if (state !== "idle") forcePause("Audio sharing stopped. Press End and then Start again to share it again."); });
    if (source === "system") return sysTrack;
    // mezcla micrófono + sistema
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    streams.push(mic);
    const mixInto = (ctx) => {
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(new MediaStream([sysTrack])).connect(dest);
      ctx.createMediaStreamSource(mic).connect(dest);
      return dest;
    };
    let dest;
    audioCtx = makeCtx();
    try { dest = mixInto(audioCtx); }
    catch { try { audioCtx.close(); } catch { /* */ } audioCtx = new AudioContext(); dest = mixInto(audioCtx); }
    return dest.stream.getAudioTracks()[0];
  }

  // ── Motor local (Vosk) ──
  const voskModels = {};
  let vosk = null, voskGen = 0;
  function resampleTo16k(x, rate) {
    if (rate === 16000) return x;
    const ratio = rate / 16000, n = Math.floor(x.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio, j = Math.floor(p), f = p - j;
      out[i] = x[j] * (1 - f) + (x[j + 1] || 0) * f;
    }
    return out;
  }
  function makeCtx() {
    try { return new AudioContext({ sampleRate: 16000, latencyHint: "interactive" }); } catch { return new AudioContext(); }
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      const el = document.createElement("script");
      el.src = src; el.onload = res; el.onerror = () => rej(new Error("could not load " + src));
      document.head.appendChild(el);
    });
  }
  async function getVoskModel(k) {
    if (!window.Vosk) await loadScript("vendor/vosk.js");
    if (!voskModels[k]) {
      const url = new URL(`models/${k}.tar.gz`, location.href).href;
      voskModels[k] = (async () => {
        const head = await fetch(url, { method: "HEAD" }).catch(() => null);
        if (head && !head.ok) throw new Error(`missing file models/${k}.tar.gz`);
        const m = new window.Vosk.Model(url, -1);
        await new Promise((res, rej) => {
          const to = setTimeout(() => rej(new Error("timed out loading the model")), 240000);
          m.on("load", (e) => { clearTimeout(to); e.result ? res() : rej(new Error("invalid model")); });
          m.on("error", (e) => { clearTimeout(to); rej(new Error(e.error || "invalid model")); });
        });
        return m;
      })().catch((e) => { delete voskModels[k]; throw e; });
    }
    return voskModels[k];
  }

  // Cierre de frase rápido: si hay 0.55 s de silencio (o el texto parcial no cambia en 1.1 s) se cierra la frase,
  // en lugar de esperar los 1–2 s que usa el modelo por defecto.
  const SILENCE_MS = 450, STABLE_MS = 1100;   // cierre rápido: los pedazos de una misma oración se unen después (MERGE_MS)
  let lastLang = "es";

  async function startVosk() {
    const gen = ++voskGen;
    const auto = cfg.lang === "auto";
    const langs = auto ? ["es", "en"] : [langOf()];
    const slow = setTimeout(() => notice(`Loading the local speech engine${auto ? " (Spanish + English)" : ""}… the first time it downloads ~40 MB per language; after that it stays saved.`), 300);
    let models;
    try { models = await Promise.all(langs.map(getVoskModel)); }
    catch (e) {
      clearTimeout(slow);
      if (gen === voskGen) forcePause(`Could not load the local engine (${(e && e.message) || e}). Check that the GitHub action "Modelos de voz" finished, or switch the engine to "Browser".`);
      return;
    }
    clearTimeout(slow);
    if (gen !== voskGen || state !== "running") return;
    notice("");
    setTimeout(getAi, 1500);  // Whisper carga cuando Vosk ya está escuchando (arranque más rápido)
    if (!audioCtx) audioCtx = makeCtx();
    let src;
    try { src = audioCtx.createMediaStreamSource(new MediaStream([track])); }
    catch {
      // Firefox no permite mezclar frecuencias de muestreo: se usa la frecuencia nativa y Vosk remuestrea
      try { await audioCtx.close(); } catch { /* */ }
      audioCtx = new AudioContext();
      src = audioCtx.createMediaStreamSource(new MediaStream([track]));
    }
    if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch { /* */ } }
    const rate = audioCtx.sampleRate;

    const v = { recs: [], partial: {}, partialAt: 0, partialText: "", seg: null, speaking: false, silentSince: 0, floor: 0.004, chunks: [], samples: 0, pre: [], gain: 1 };
    // audio de la frase en curso (para que Whisper la vuelva a transcribir con más precisión)
    const takeAudio = () => {
      const chunks = v.chunks, overflow = v.overflow; v.chunks = []; const n = v.samples; v.samples = 0; v.overflow = false;
      // sin Whisper listo, frase muy corta, o frase más larga que la ventana de Whisper → no se corrige
      if (!cfg.precise || !aiReady || overflow || n < rate * 0.5) return null;
      const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      return resampleTo16k(all, rate);
    };
    // Modo auto: ambos modelos escuchan; en cada frase gana el que tenga más confianza.
    const decide = () => {
      clearTimeout(v.decideTimer); v.awaiting = null;
      const seg = v.seg; v.seg = null;
      if (!seg || gen !== voskGen || (!seg.es.length && !seg.en.length)) return;
      let best = null, bestScore = -1; const scores = {};
      for (const lg of langs) {
        const w = seg[lg] || [];
        if (!w.length) { scores[lg] = 0; continue; }
        const avg = w.reduce((t, x) => t + (x.conf || 0), 0) / w.length;
        const score = avg + (lg === lastLang ? 0.03 : 0) + Math.min(w.length, 4) * 0.005;
        scores[lg] = score;
        if (score > bestScore) { bestScore = score; best = lg; }
      }
      const ambiguous = langs.length > 1 && Math.abs((scores.es || 0) - (scores.en || 0)) < 0.15;
      if (!best) return;
      // fragmentos muy cortos: se mantiene el último idioma salvo que el otro sea claramente mejor
      if (best !== lastLang && (seg[lastLang] || []).length && seg[best].length <= 3) {
        const avgOf = (w) => w.reduce((t, x) => t + (x.conf || 0), 0) / w.length;
        if (avgOf(seg[best]) - avgOf(seg[lastLang]) < 0.12) best = lastLang;
      }
      // descarta ruido: 1–2 palabras con baja confianza
      const bw = seg[best], bavg = bw.reduce((t, x) => t + (x.conf || 0), 0) / bw.length;
      if (bw.length === 1 && /^(uh|um|eh|ah|mm|hmm|huh|the|a|el|la|e|y|o)$/.test(bw[0].word)) return;   // muletilla suelta
      if (bavg < 0.3 && bw.length < 4) return;   // ruido o música en ambos idiomas
      lastLang = best;
      handleInterim("");
      handleFinal(seg[best].map((x) => x.word).join(" "), best, takeAudio(), bavg, { ambiguous, auto: true, words: seg[best] });
    };
    for (let i = 0; i < models.length; i++) {
      const lg = langs[i];
      const r = new models[i].KaldiRecognizer(rate);
      r.setWords(true);   // confianza por palabra: decide idioma y si hace falta que Whisper corrija
      r.on("result", (m) => {
        if (gen !== voskGen) return;
        v.partial[lg] = "";
        const res = m.result || {};
        if (!res.text) {
          if (!auto && !v.partialText) { v.chunks = []; v.samples = 0; }
          if (auto && v.awaiting) { v.awaiting.delete(lg); if (!v.awaiting.size) decide(); }
          return;
        }
        if (!auto) {
          const w = res.result || [];
          const conf = w.length ? w.reduce((t, x) => t + (x.conf || 0), 0) / w.length : 0;
          handleInterim(""); handleFinal(res.text, lg, takeAudio(), conf, { words: w }); return;
        }
        if (!v.seg) v.seg = { es: [], en: [] };
        v.seg[lg].push(...(res.result || res.text.split(" ").map((w) => ({ word: w, conf: 0.5 }))));
        if (v.awaiting) { v.awaiting.delete(lg); if (!v.awaiting.size) decide(); }
        else { clearTimeout(v.decideTimer); v.decideTimer = setTimeout(() => { if (!v.awaiting) flush(); }, 1200); }  // cierre propio de un modelo: pide al otro que cierre también
      });
      r.on("partialresult", (m) => {
        if (gen !== voskGen) return;
        const t = (m.result && m.result.partial) || "";
        v.partial[lg] = t;
        // en modo auto se muestra el parcial del último idioma detectado
        const show = auto ? (v.partial[lastLang] || v.partial[lg]) : t;
        const showLang = auto ? (v.partial[lastLang] ? lastLang : lg) : lg;
        if (show !== v.partialText) { v.partialText = show; v.partialAt = performance.now(); handleInterim(show, showLang); }
      });
      v.recs.push(r);
    }
    const flush = () => {
      if (auto) {
        if (v.awaiting) return;   // ya se pidió el cierre; esperando a ambos modelos
        v.awaiting = new Set(langs);
        clearTimeout(v.decideTimer);
        v.decideTimer = setTimeout(decide, 2500);   // por si un modelo no responde
      }
      v.recs.forEach((r) => r.retrieveFinalResult()); v.partialText = ""; v.partialAt = 0;
    };
    const proc = audioCtx.createScriptProcessor(rate <= 16000 ? 1024 : 2048, 1, 1);
    proc.onaudioprocess = (e) => {
      if (state !== "running" || gen !== voskGen) return;
      const raw = e.inputBuffer.getChannelData(0);
      // control automático de volumen (AGC): sube el audio bajo (p. ej. de una pestaña) a un nivel estable
      let sq = 0; for (let i = 0; i < raw.length; i += 2) sq += raw[i] * raw[i];
      const lvl = Math.sqrt(sq / (raw.length / 2));
      // lento (no cambia dentro de una palabra) y solo sube el audio bajo; nunca baja el que ya está bien
      if (lvl > 0.006) { const want = Math.min(6, Math.max(1, 0.05 / lvl)); v.gain += (want - v.gain) * (want < v.gain ? 0.25 : 0.015); }
      const data = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) { const x = raw[i] * v.gain; data[i] = x > 0.98 ? 0.98 : x < -0.98 ? -0.98 : x; }
      for (const r of v.recs) { try { r.acceptWaveformFloat(data, rate); } catch { /* */ } }
      // se guarda el audio de la frase en curso desde el inicio (aunque Whisper siga cargando)
      if (cfg.precise && !aiFailed && (v.speaking || v.partialText || v.samples)) {
        if (!v.samples && v.pre.length) { for (const c of v.pre) { v.chunks.push(c); v.samples += c.length; } v.pre = []; }   // incluye el inicio de la frase
        v.chunks.push(data); v.samples += data.length;
        while (v.samples > rate * 28) { v.samples -= v.chunks.shift().length; v.overflow = true; }  // Whisper procesa hasta 30 s
      } else { v.pre.push(data); let n = 0; for (const c of v.pre) n += c.length; while (n > rate * 0.45) n -= v.pre.shift().length; }
      // detector de voz por energía con piso de ruido adaptativo
      const rms = lvl;   // el detector de voz mide el audio original (sin amplificar)
      const now = performance.now();
      const speech = rms > Math.max(0.008, v.floor * 3);
      if (!speech) v.floor = v.floor * 0.95 + rms * 0.05;
      if (speech) { v.speaking = true; v.silentSince = 0; }
      else if (v.speaking) {
        if (!v.silentSince) v.silentSince = now;
        else if (now - v.silentSince > SILENCE_MS) { v.speaking = false; v.silentSince = 0; if (v.partialText || (v.seg && (v.seg.es.length || v.seg.en.length))) flush(); }
      }
      if (v.partialText && v.partialAt && now - v.partialAt > STABLE_MS) flush();
    };
    src.connect(proc); proc.connect(audioCtx.destination);
    v.src = src; v.proc = proc;
    vosk = v;
  }
  function stopVosk() {
    voskGen++;
    if (!vosk) return;
    try { vosk.proc.onaudioprocess = null; vosk.proc.disconnect(); vosk.src.disconnect(); vosk.recs.forEach((r) => r.remove()); } catch { /* */ }
    vosk = null;
  }

  /** Si el motor en línea falla, se pasa solo al motor local sin detener la llamada. */
  async function fallbackToLocal(reason) {
    stopRecognition();
    cfg.engine = "vosk"; saveCfg(); $("selEngine").value = "vosk";
    try {
      if (!track) { track = await getAudioTrack(cfg.source === "mic" ? "mic" : cfg.source); }
    } catch (e) { forcePause("Could not open the microphone for the local engine."); return; }
    toast(`${reason} Switched to the local engine (offline).`, 6000);
    if (state === "running") startVosk();
  }

  // ── Motor del navegador (Web Speech API) ──
  async function prepareLocal(lang) {
    if (!cfg.local) return false;
    try {
      if (typeof SR.available === "function") {
        const st = await SR.available({ langs: [lang], processLocally: true });
        if (st === "available") return true;
        if ((st === "downloadable" || st === "downloading") && typeof SR.install === "function") {
          notice("Downloading the browser speech model (first time only)…");
          const ok = await SR.install({ langs: [lang], processLocally: true });
          notice("");
          return !!ok;
        }
      }
    } catch { /* no soportado */ }
    notice("Your browser has no on-device recognition for this language; using its online service.");
    return false;
  }

  function makeRec(local) {
    const r = new SR();
    r.lang = cfg.lang === "auto" ? "es-MX" : cfg.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    if (local && "processLocally" in r) r.processLocally = true;
    r.onresult = (e) => {
      errStreak = 0; netErr = 0;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) handleFinal(res[0].transcript);
        else interim += res[0].transcript;
      }
      handleInterim(interim);
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      const fatal = { "not-allowed": "Microphone permission denied. Allow it from the lock icon in the address bar.",
        "service-not-allowed": null,
        "audio-capture": "No audio device found.",
        "language-not-supported": "Language not supported by the browser speech engine." }[e.error];
      if (fatal) { forcePause(fatal); return; }
      if (e.error === "service-not-allowed") { fallbackToLocal("This browser blocks its online speech service."); return; }
      errStreak++;
      if (e.error === "network" && ++netErr >= 2) fallbackToLocal("The browser online speech service is not responding (network error).");
    };
    r.onend = () => {
      if (rec !== r) return;
      if (state === "running") setTimeout(() => state === "running" && cfg.engine === "browser" && startBrowser(), errStreak > 0 ? 800 : 0);
    };
    return r;
  }

  let localOK = false;
  function startBrowser() {
    rec = makeRec(localOK);
    try {
      if (track && trackSupported) {
        try { rec.start(track); }
        catch (err) {
          trackSupported = false;
          rec = makeRec(localOK); rec.start();
          fallbackToLocal("The browser engine cannot listen to that audio source.");
          return;
        }
      } else rec.start();
    } catch (err) { /* ya iniciado */ }
  }

  function startRecognition() { return cfg.engine === "vosk" || cfg.lang === "auto" ? startVosk() : startBrowser(); }
  function stopRecognition() {
    stopVosk();
    const r = rec; rec = null;
    if (r) { try { r.onend = null; r.abort(); } catch { /* */ } }
    handleInterim("");
  }

  async function start() {
    if (state !== "idle") return;
    prepareTranslators();   // dentro del clic: el navegador puede necesitar descargar el traductor
    if (cfg.engine === "browser") setTimeout(getAi, 3000);  // el modelo preciso carga después, para no frenar el arranque
    if (cfg.engine === "browser" && (!SR || cfg.lang === "auto")) { cfg.engine = "vosk"; $("selEngine").value = "vosk"; saveCfg(); }
    if (cfg.engine === "vosk" && (!window.WebAssembly || !window.AudioContext)) { notice("This browser does not support the local engine. Use an up-to-date Chrome, Edge, Firefox or Safari.", true); return; }
    notice("");
    session = freshSession();
    trackSupported = true; netErr = 0; errStreak = 0;
    try {
      track = await getAudioTrack(cfg.source);
    } catch (err) {
      cleanupAudio();
      session = null;
      notice(err && err.message === "NO_SYSTEM_AUDIO"
        ? "No audio received: when sharing, pick the tab (e.g. YouTube) or 'Entire screen' and turn on \"Share audio\"."
        : "Could not access audio: " + (err && err.name === "NotAllowedError" ? "permission denied." : (err && err.message) || err), true);
      return;
    }
    if (cfg.engine === "browser") localOK = await prepareLocal(cfg.lang);
    $("transcript").innerHTML = `<p class="empty">Listening…</p>`;
    t0 = Date.now(); pausedMs = 0;
    setState("running");
    tick = setInterval(() => ($("timer").textContent = fmtTime(elapsed())), 500);
    startRecognition();
  }

  function pause() {
    if (state === "running") {
      setState("paused"); pauseAt = Date.now();
      stopRecognition();
      streams.forEach((s) => s.getAudioTracks().forEach((t) => (t.enabled = false)));
    } else if (state === "paused") {
      pausedMs += Date.now() - pauseAt;
      streams.forEach((s) => s.getAudioTracks().forEach((t) => (t.enabled = true)));
      notice("");
      setState("running");
      startRecognition();
    }
  }

  function cleanupAudio() {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams = []; track = null;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  }

  /** Termina la llamada y BORRA todo lo relacionado con ella. */
  function stop(skipConfirm) {
    if (state === "idle" && !session) return;
    if (!skipConfirm && $("notes").value.trim() && !confirm("Ending the call will erase the transcript and your notes. End the call?")) return;
    stopRecognition();
    cleanupAudio();
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
    aiJobs.clear(); if (ai) ai.postMessage({ type: "clear" });
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
    if (state === "running") { stopRecognition(); startRecognition(); }
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
    $("cfgLocal").disabled = false;
    $("cfgName").value = cfg.name; $("cfgId").value = cfg.id; $("cfgLocal").checked = cfg.local;
    $("localInfo").textContent = SR && (typeof SR.available === "function" || "processLocally" in SR.prototype)
      ? "Your browser seems to support it: audio would stay on your device."
      : "Not available in this browser: Chrome/Edge use their online speech service.";

    $("btnStart").onclick = start;
    $("btnPause").onclick = pause;
    $("btnStop").onclick = () => stop(false);
    $("btnSwap").onclick = swapLang;
    $("selLang").onchange = (e) => { cfg.lang = e.target.value; applyLang(); };
    $("cfgPrecise").checked = cfg.precise;
    $("cfgPrecise").onchange = (e) => { cfg.precise = e.target.checked; saveCfg(); if (cfg.precise) getAi(); };
    $("cfgTranslate").checked = cfg.translate;
    $("cfgTranslate").onchange = (e) => { cfg.translate = e.target.checked; saveCfg(); if (cfg.translate) prepareTranslators(); };
    $("trInfo").textContent = hasTranslator()
      ? "Uses Chrome's built-in translator (on your device, offline)."
      : "Uses the offline translator included in the page (Bergamot, ~35 MB one-time download). Works in any browser.";

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
      $("myTermsList").innerHTML = myTerms.length ? myTerms.map((m, i) => `<div class="myterm"><span><b>${esc(m.en)}</b> → ${esc(m.es)}</span><button type="button" data-i="${i}" title="Delete">×</button></div>`).join("") : `<p class="hint">No terms yet.</p>`;
    };
    const renderFixes = () => {
      $("fixList").innerHTML = fixes.length ? fixes.map((f, i) => `<div class="myterm"><span>${esc(f.heard)} → <b>${esc(f.correct)}</b></span><button type="button" data-i="${i}" title="Delete">×</button></div>`).join("") : `<p class="hint">No corrections yet.</p>`;
    };
    const showVocabTab = (t) => {
      for (const b of $("vocabTabs").children) b.classList.toggle("on", b.dataset.vt === t);
      $("vtFix").hidden = t !== "fix"; $("vtTr").hidden = t !== "tr";
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
    $("btnAddCard").onclick = () => { $("cardForm").reset(); $("cardCat").value = activeCat; $("cardInfo").textContent = ""; $("dlgCard").showModal(); };
    $("btnSaveCard").onclick = () => {
      const c = { cat: $("cardCat").value.trim() || "My cards", titulo: $("cardTitle").value.trim(), es: $("cardEs").value.trim(), en: $("cardEn").value.trim(), claves: $("cardKeys").value.trim() };
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
    $("selEngine").value = cfg.engine;
    $("selEngine").onchange = (e) => { cfg.engine = e.target.value; saveCfg(); notice(""); };
    $("btnSettings").onclick = () => $("dlgSettings").showModal();
    $("cfgName").oninput = (e) => { cfg.name = e.target.value; saveCfg(); renderCards(); };
    $("cfgId").oninput = (e) => { cfg.id = e.target.value; saveCfg(); renderCards(); };
    $("cfgLocal").onchange = (e) => { cfg.local = e.target.checked; saveCfg(); };

    $("suggestions").onclick = (e) => {
      const el = e.target.closest(".sugg"); if (!el) return;
      const l = (e.target.closest("[data-l]") || el.querySelector(".pri")).dataset.l;
      copy(el.dataset[l]);
    };
    $("cardTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) { activeCat = b.dataset.cat; cardQuery = ""; $("cardFilter").value = ""; renderCards(); $("cards").scrollTop = 0; } };
    $("cards").onclick = (e) => {
      const del = e.target.closest("[data-del]");
      if (del) { if (confirm("Delete this card?")) { customCards.splice(+del.dataset.del, 1); saveCustomCards(); } return; }
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
    const perfText = () => { const d = detectPerf(); $("perfInfo").textContent = `This device: ${navigator.hardwareConcurrency || "?"} CPU cores${navigator.deviceMemory ? ", ~" + navigator.deviceMemory + " GB RAM" : ""} → ${cfg.perf === "auto" ? "using " + PERF[d].label : PERF[perfKey()].label + " (manual)"}. Lite skips the high-accuracy engine; Balanced only checks unclear sentences.`; };
    $("cfgPerf").value = PERF[cfg.perf] ? cfg.perf : "auto"; perfText();
    $("cfgPerf").onchange = (e) => { cfg.perf = e.target.value; saveCfg(); perfText(); if (P().whisper !== "off" && cfg.precise && state !== "idle") getAi(); };
    $("cfgSmall").checked = cfg.whisperSmall !== false;
    $("cfgSmall").onchange = (e) => { cfg.whisperSmall = e.target.checked; saveCfg(); toast("Applies the next time the high-accuracy engine loads (reload the page)", 3500); };
    $("cfgMask").checked = cfg.mask;
    $("cfgMask").onchange = (e) => { cfg.mask = e.target.checked; saveCfg(); if (session) renderKeys(); };
    $("btnCopyNotes").onclick = () => $("notes").value.trim() && copy($("notes").value);

    $("simForm").onsubmit = (e) => {
      e.preventDefault();
      const v = $("simInput").value; if (!v.trim()) return;
      if (!session) { session = freshSession(); if (!t0) { t0 = Date.now(); pausedMs = 0; } }
      handleFinal(v, cfg.lang === "auto" ? (/\b(the|and|my|is|you|i|to|of)\b/i.test(v) ? "en" : "es") : langOf()); $("simInput").value = "";
      $("btnStop").disabled = false;
    };

    $("glossSearch").oninput = (e) => {
      const q = strip(e.target.value.trim());
      if (q.length < 2) { $("glossResults").innerHTML = ""; return; }
      $("glossResults").innerHTML = glossary.filter((g) => strip(`${g.t} ${g.tr} ${g.d}`).includes(q)).slice(0, 30).map((g) => termHTML(g)).join("") || `<p class="empty">No results.</p>`;
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
    window.addEventListener("pagehide", () => { stopRecognition(); cleanupAudio(); session = null; $("notes").value = ""; });
  }

  buildFixes();
  loadGlossary();
  bind();
  renderCards();
  setState("idle");
  // Gancho mínimo para pruebas automáticas (no expone datos de llamadas).
  window.__inturp = { analyze, suggestionsFor, parseGlossary, translate, getBergamot, handleFinalRaw: (t, l, c) => { if (!session) session = freshSession(); handleFinal(t, l, null, c); }, handleFinal: (t) => { if (!session) session = freshSession(); handleFinal(t); }, wipe: () => { stop(true); wipe(); } };
})();
