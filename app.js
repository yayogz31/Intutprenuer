/* Inturpreneur — asistente de interpretación en vivo.
 * Todo corre en el navegador. Nada del texto de la llamada se guarda (ni localStorage, ni red):
 * vive solo en memoria y en pantalla, y se borra al presionar "Terminar" o cerrar la pestaña.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const DOMS = ["medico", "legal", "bancario", "seguros"];
  const DOM_LABEL = { medico: "Médico", legal: "Legal", bancario: "Bancario", seguros: "Seguros", duda: "Duda", general: "General", aviso: "Disclosure", tarjeta: "Tarjeta" };
  const TAB_FOR_DOM = { medico: "Médico", legal: "Legal", bancario: "Bancario", seguros: "Seguros" };

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
    toast("Copiado");
  }

  // ───────────────── Configuración (solo preferencias, nunca texto de llamadas) ─────────────────
  const cfg = Object.assign({ name: "", id: "", local: false, lang: "es-MX", source: "mic", engine: "vosk", translate: true }, store.get("inturp.cfg", {}));
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
  function loadGlossary() {
    const extra = store.get("inturp.gloss", null);
    const base = (window.GLOSARIO_BASE || []).map((e) => ({ ...e, dom: normDom(e.dom) }));
    glossary = extra ? (extra.replace ? extra.items : base.concat(extra.items)) : base;
    buildIndex();
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
    $("glossInfo").textContent = `Glosario activo: ${glossary.length} entradas.`;
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

    // HTML resaltado (sin solapamientos)
    spans.sort((x, y) => x.a - y.a || y.b - x.b);
    let html = "", pos = 0, last = -1;
    for (const s of spans) {
      if (s.a < last) continue;
      const oa = map[s.a], ob = map[s.b];
      html += esc(text.slice(pos, oa));
      const frag = esc(text.slice(oa, ob));
      html += s.kind === "term"
        ? `<mark class="hl-term" title="${esc(`${s.e.t} = ${s.e.tr} · ${s.e.d}`)}">${frag}</mark>`
        : `<mark class="num">${frag}</mark>`;
      pos = ob; last = s.b;
    }
    html += esc(text.slice(pos));
    return { n, terms, nums, score, doms, question, html };
  }

  function suggestionsFor(a) {
    const out = []; const seen = new Set();
    const push = (s, dom) => { const k = s.es; if (!seen.has(k)) { seen.add(k); out.push({ ...s, dom }); } };
    const rules = (window.REGLAS || []).slice().sort((x, y) => (y.prio || 0) - (x.prio || 0));
    for (const r of rules) {
      r.re.lastIndex = 0;
      if (r.re.test(a.n)) for (const s of r.s) push(s, r.dom);
    }
    for (const c of allCards()) {
      if (c._re && (c._re.lastIndex = 0, c._re.test(a.n))) push({ es: fill(c.es), en: fill(c.en), titulo: c.titulo }, c.cat === "Disclosures" ? "aviso" : "tarjeta");
    }
    if (a.nums.length) {
      const v = a.nums[a.nums.length - 1];
      push({ es: `Para confirmar, ¿dijo ${v}?`, en: `Just to confirm, did you say ${v}?` }, "duda");
    }
    if (a.question && !out.some((s) => s.dom === "duda"))
      push({ es: "Buena pregunta, permítame verificarlo.", en: "Good question, let me check that for you." }, "duda");
    if (!out.length) {
      const lead = leadDomain();
      for (const s of (window.SUGERENCIAS_DEFECTO || {})[lead || "general"] || []) push(s, lead || "general");
    }
    // los avisos (disclosures) siempre primero
    out.sort((x, y) => (y.dom === "aviso") - (x.dom === "aviso"));
    return out.slice(0, 7);
  }

  // ───────────────── Estado de la sesión (solo memoria) ─────────────────
  let session = null;
  const freshSession = () => ({
    acc: { medico: 0, legal: 0, bancario: 0, seguros: 0 },
    termsSeen: new Map(),   // entrada → contador
    liveTerms: new Set(),   // términos ya contados en la frase en curso
    nums: new Set(),
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
    box.innerHTML = list.map((s) => `
      <div class="sugg" data-es="${esc(s.es)}" data-en="${esc(s.en)}">
        <span class="src tag ${s.dom}">${esc(s.titulo && s.dom === "tarjeta" ? s.titulo : (DOM_LABEL[s.dom] || s.dom))}</span>
        <div class="es">${esc(s.es)}</div><div class="en">${esc(s.en)}</div>
      </div>`).join("");
  }

  function renderMeter() {
    const total = DOMS.reduce((t, d) => t + session.acc[d], 0) || 1;
    const lead = leadDomain();
    for (const el of $("domainMeter").children) {
      const d = el.dataset.dom;
      el.querySelector("b").textContent = Math.round((session.acc[d] / total) * 100) + "%";
      el.classList.toggle("lead", d === lead);
    }
    for (const b of $("cardTabs").children) b.textContent = b.dataset.cat + (TAB_FOR_DOM[lead] === b.dataset.cat ? " ●" : "");
  }

  function termHTML(e, n) {
    return `<div class="term ${e.dom}">${n ? `<span class="n">×${n}</span>` : ""}
      <span class="w">${esc(e.t)}</span> → <span class="tr">${esc(e.tr || "")}</span>
      <div class="d">${esc(e.d || "")}</div></div>`;
  }
  function renderTerms() {
    const arr = [...session.termsSeen.entries()].sort((a, b) => b[1].t - a[1].t);
    $("termCount").textContent = arr.length;
    $("terms").innerHTML = arr.length ? arr.map(([e, v]) => termHTML(e, v.n)).join("") : `<p class="empty">Los términos de tu glosario aparecerán aquí al escucharse.</p>`;
  }
  function renderChips() {
    $("quickData").innerHTML = [...session.nums].slice(-12).map((v) => `<button type="button" data-v="${esc(v)}">${esc(v)}</button>`).join("");
  }

  // ───────────────── Traducción (traductor integrado del navegador, en el dispositivo) ─────────────────
  // Usa la API "Translator" de Chrome (138+): corre localmente, sin internet ni API keys, y es muy rápida.
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
          monitor(m) { m.addEventListener("downloadprogress", (e) => { if (e.loaded < 1) notice(`Preparando el traductor (${from.toUpperCase()}→${to.toUpperCase()}) por única vez… ${Math.round(e.loaded * 100)}%`); else notice(""); }); },
        });
      })().catch(() => { setTimeout(() => delete translators[k], 15000); return null; });
    }
    return translators[k];
  }
  /** Debe llamarse dentro de un clic: la primera vez el navegador descarga el modelo de traducción. */
  function prepareTranslators() {
    if (!cfg.translate || !hasTranslator()) return;
    getTranslator("es", "en"); getTranslator("en", "es");
  }
  async function translate(text, from) {
    if (!cfg.translate || !hasTranslator() || !text) return null;
    const t = await getTranslator(from, from === "es" ? "en" : "es");
    if (!t) return null;
    try { return await t.translate(text); } catch { return null; }
  }
  const langOf = () => (cfg.lang.startsWith("en") ? "en" : "es");

  /** Procesa una frase final. lang = "es" | "en" (idioma en que se dijo). */
  function handleFinal(text, lang) {
    text = text.trim();
    if (!text || !session) return;
    lang = lang || langOf();
    const a = analyze(text);
    session.count++;
    for (const d of DOMS) session.acc[d] = session.acc[d] * 0.8 + a.score[d];
    const now = Date.now();
    for (const e of a.terms) {
      const v = session.termsSeen.get(e) || { n: 0, t: 0 };
      if (!session.liveTerms.has(e)) v.n++;   // ya contado mientras se hablaba
      v.t = now; session.termsSeen.set(e, v);
    }
    session.liveTerms.clear();
    for (const v of a.nums) { session.nums.delete(v); session.nums.add(v); }

    const tr = $("transcript");
    if (session.count === 1) tr.innerHTML = "";
    const p = document.createElement("div");
    const tags = [...a.doms, ...(a.question ? ["duda"] : [])];
    p.className = "phrase " + (a.doms[0] || "");
    p.innerHTML = `<span class="time">${fmtTime(elapsed())}</span><span class="lang">${lang.toUpperCase()}</span><span class="tags">${tags.map((t) => `<span class="tag ${t}">${DOM_LABEL[t]}</span>`).join("")}</span>${a.html}`;
    tr.appendChild(p);
    while (tr.children.length > 300) tr.firstChild.remove();
    tr.scrollTop = tr.scrollHeight;
    $("interimTr").textContent = "";

    if (cfg.translate && hasTranslator()) {
      translate(text, lang).then((t) => {
        if (!t || !p.isConnected) return;
        const x = document.createElement("div"); x.className = "xl"; x.textContent = t; p.appendChild(x);
        const near = tr.scrollHeight - tr.scrollTop - tr.clientHeight < 120;
        if (near) tr.scrollTop = tr.scrollHeight;
      });
    }

    renderSuggestions(suggestionsFor(a));
    renderMeter(); renderTerms(); renderChips();
  }

  let interimT, interimTrT, interimSeq = 0;
  function handleInterim(text, lang) {
    const box = $("interim");
    if (!text) { box.textContent = ""; clearTimeout(interimTrT); return; }
    lang = lang || langOf();
    clearTimeout(interimT);
    interimT = setTimeout(() => {
      if (!session) return;
      const a = analyze(text);
      box.innerHTML = `<span class="lang">${lang.toUpperCase()}</span>` + a.html + " …";
      // términos y sugerencias en vivo, sin esperar a que termine la frase
      let changed = false; const now = Date.now();
      for (const e of a.terms) if (!session.liveTerms.has(e)) {
        session.liveTerms.add(e); changed = true;
        const v = session.termsSeen.get(e) || { n: 0, t: 0 }; v.n++; v.t = now; session.termsSeen.set(e, v);
      }
      if (changed) renderTerms();
      const s = suggestionsFor(a);
      if (a.terms.length || s.length > 1 || a.question) renderSuggestions(s);
    }, 40);
    if (cfg.translate && hasTranslator()) {
      clearTimeout(interimTrT);
      const seq = ++interimSeq;
      interimTrT = setTimeout(() => translate(text, lang).then((t) => { if (t && seq === interimSeq && $("interim").textContent) $("interimTr").textContent = t; }), 250);
    }
  }

  // ───────────────── Tarjetas ─────────────────
  // Tarjetas base (data/tarjetas.js) + tarjetas propias (guardadas solo en este navegador).
  // "claves": palabras que, al escucharse, muestran la tarjeta como sugerencia.
  let activeCat = "Introducción";
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
  function renderCards() {
    const cards = allCards();
    const cats = [...new Set(cards.map((c) => c.cat))];
    if (!cats.includes(activeCat)) activeCat = cats[0];
    $("cardTabs").innerHTML = cats.map((c) => `<button type="button" data-cat="${esc(c)}" class="${c === activeCat ? "on" : ""}">${esc(c)}</button>`).join("");
    $("cards").innerHTML = cards.filter((c) => c.cat === activeCat).map((c) => `
      <div class="card">${c._custom !== undefined ? `<button type="button" class="del" data-del="${c._custom}" title="Eliminar tarjeta">×</button>` : ""}
        <div class="title">${esc(c.titulo)}${c.claves ? ` <span class="keys" title="Aparece como sugerencia al escuchar: ${esc(c.claves)}">⚡</span>` : ""}</div>
        <div class="es" data-copy="${esc(fill(c.es))}">${esc(fill(c.es))}</div>
        ${c.en ? `<div class="en" data-copy="${esc(fill(c.en))}">${esc(fill(c.en))}</div>` : ""}</div>`).join("");
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
    if (/^(categ|cat$|category)/.test(strip(rows[0][0] || ""))) rows.shift();
    return rows.filter((r) => r[0] && r[2]).map((r) => ({ cat: r[0], titulo: r[1] || r[2].slice(0, 30), es: r[2], en: r[3] || "", claves: (r[4] || "").replace(/\|/g, ",") }));
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
    st.textContent = { idle: "Inactivo", running: "Escuchando", paused: "En pausa" }[s];
    $("btnStart").disabled = s !== "idle";
    $("btnPause").disabled = s === "idle";
    $("btnStop").disabled = s === "idle";
    $("btnPause").textContent = s === "paused" ? "▶ Reanudar" : "❚❚ Pausar";
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
    sysTrack.addEventListener("ended", () => { if (state !== "idle") forcePause("Se dejó de compartir el audio. Presiona Terminar e Inicia de nuevo para volver a compartir."); });
    if (source === "system") return sysTrack;
    // mezcla micrófono + sistema
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    streams.push(mic);
    audioCtx = makeCtx();
    const dest = audioCtx.createMediaStreamDestination();
    audioCtx.createMediaStreamSource(new MediaStream([sysTrack])).connect(dest);
    audioCtx.createMediaStreamSource(mic).connect(dest);
    return dest.stream.getAudioTracks()[0];
  }

  // ── Motor local (Vosk) ──
  const voskModels = {};
  let vosk = null, voskGen = 0;
  function makeCtx() {
    try { return new AudioContext({ sampleRate: 16000, latencyHint: "interactive" }); } catch { return new AudioContext(); }
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      const el = document.createElement("script");
      el.src = src; el.onload = res; el.onerror = () => rej(new Error("no se pudo cargar " + src));
      document.head.appendChild(el);
    });
  }
  async function getVoskModel(k) {
    if (!window.Vosk) await loadScript("vendor/vosk.js");
    if (!voskModels[k]) {
      const url = new URL(`models/${k}.tar.gz`, location.href).href;
      voskModels[k] = (async () => {
        const head = await fetch(url, { method: "HEAD" }).catch(() => null);
        if (head && !head.ok) throw new Error(`falta el archivo models/${k}.tar.gz`);
        const m = new window.Vosk.Model(url, -1);
        await new Promise((res, rej) => {
          const to = setTimeout(() => rej(new Error("tiempo de espera agotado al cargar el modelo")), 240000);
          m.on("load", (e) => { clearTimeout(to); e.result ? res() : rej(new Error("modelo inválido")); });
          m.on("error", (e) => { clearTimeout(to); rej(new Error(e.error || "modelo inválido")); });
        });
        return m;
      })().catch((e) => { delete voskModels[k]; throw e; });
    }
    return voskModels[k];
  }

  // Cierre de frase rápido: si hay 0.55 s de silencio (o el texto parcial no cambia en 1.1 s) se cierra la frase,
  // en lugar de esperar los 1–2 s que usa el modelo por defecto.
  const SILENCE_MS = 550, STABLE_MS = 1100;
  let lastLang = "es";

  async function startVosk() {
    const gen = ++voskGen;
    const auto = cfg.lang === "auto";
    const langs = auto ? ["es", "en"] : [langOf()];
    const slow = setTimeout(() => notice(`Cargando el motor de voz local${auto ? " (español + inglés)" : ""}… la primera vez descarga ~40 MB por idioma; después queda guardado.`), 300);
    let models;
    try { models = await Promise.all(langs.map(getVoskModel)); }
    catch (e) {
      clearTimeout(slow);
      if (gen === voskGen) forcePause(`No se pudo cargar el motor local (${(e && e.message) || e}). Revisa que la acción «Modelos de voz» de GitHub haya terminado, o cambia el motor a «Navegador».`);
      return;
    }
    clearTimeout(slow);
    if (gen !== voskGen || state !== "running") return;
    notice("");
    if (!audioCtx) audioCtx = makeCtx();
    if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch { /* */ } }
    const rate = audioCtx.sampleRate;

    const v = { recs: [], partial: {}, partialAt: 0, partialText: "", seg: null, speaking: false, silentSince: 0, floor: 0.004 };
    // Modo auto: ambos modelos escuchan; en cada frase gana el que tenga más confianza.
    const decide = () => {
      const seg = v.seg; v.seg = null;
      if (!seg || gen !== voskGen) return;
      let best = null, bestScore = -1;
      for (const lg of langs) {
        const w = seg[lg] || [];
        if (!w.length) continue;
        const avg = w.reduce((t, x) => t + (x.conf || 0), 0) / w.length;
        const score = avg + (lg === lastLang ? 0.03 : 0) + Math.min(w.length, 4) * 0.005;
        if (score > bestScore) { bestScore = score; best = lg; }
      }
      if (!best) return;
      lastLang = best;
      handleInterim("");
      handleFinal(seg[best].map((x) => x.word).join(" "), best);
    };
    for (let i = 0; i < models.length; i++) {
      const lg = langs[i];
      const r = new models[i].KaldiRecognizer(rate);
      if (auto) r.setWords(true);
      r.on("result", (m) => {
        if (gen !== voskGen) return;
        v.partial[lg] = "";
        const res = m.result || {};
        if (!res.text) return;
        if (!auto) { handleInterim(""); handleFinal(res.text, lg); return; }
        if (!v.seg) { v.seg = { es: [], en: [] }; setTimeout(decide, 450); }
        v.seg[lg].push(...(res.result || res.text.split(" ").map((w) => ({ word: w, conf: 0.5 }))));
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
    const flush = () => { v.recs.forEach((r) => r.retrieveFinalResult()); v.partialText = ""; v.partialAt = 0; };
    const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
    const proc = audioCtx.createScriptProcessor(rate <= 16000 ? 1024 : 2048, 1, 1);
    proc.onaudioprocess = (e) => {
      if (state !== "running" || gen !== voskGen) return;
      const data = e.inputBuffer.getChannelData(0);
      for (const r of v.recs) { try { r.acceptWaveformFloat(data, rate); } catch { /* */ } }
      // detector de voz por energía con piso de ruido adaptativo
      let sum = 0; for (let i = 0; i < data.length; i += 4) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / (data.length / 4));
      const now = performance.now();
      const speech = rms > Math.max(0.008, v.floor * 3);
      if (!speech) v.floor = v.floor * 0.95 + rms * 0.05;
      if (speech) { v.speaking = true; v.silentSince = 0; }
      else if (v.speaking) {
        if (!v.silentSince) v.silentSince = now;
        else if (now - v.silentSince > SILENCE_MS) { v.speaking = false; v.silentSince = 0; if (v.partialText) flush(); }
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
    } catch (e) { forcePause("No se pudo abrir el micrófono para el motor local."); return; }
    toast(`${reason} Se cambió al motor local (sin internet).`, 6000);
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
          notice("Descargando el modelo de voz del navegador (solo la primera vez)…");
          const ok = await SR.install({ langs: [lang], processLocally: true });
          notice("");
          return !!ok;
        }
      }
    } catch { /* no soportado */ }
    notice("Tu navegador no ofrece reconocimiento en el dispositivo para este idioma; se usa su servicio en línea.");
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
      const fatal = { "not-allowed": "Permiso de micrófono denegado. Actívalo en el candado de la barra de direcciones.",
        "service-not-allowed": null,
        "audio-capture": "No se encontró un dispositivo de audio.",
        "language-not-supported": "Idioma no soportado por el motor de voz del navegador." }[e.error];
      if (fatal) { forcePause(fatal); return; }
      if (e.error === "service-not-allowed") { fallbackToLocal("Este navegador bloquea su servicio de voz en línea."); return; }
      errStreak++;
      if (e.error === "network" && ++netErr >= 2) fallbackToLocal("El servicio de voz en línea del navegador no responde (error de red).");
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
          fallbackToLocal("El motor del navegador no puede escuchar esa fuente de audio.");
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
    if (cfg.engine === "browser" && (!SR || cfg.lang === "auto")) { cfg.engine = "vosk"; $("selEngine").value = "vosk"; saveCfg(); }
    if (cfg.engine === "vosk" && (!window.WebAssembly || !window.AudioContext)) { notice("Este navegador no soporta el motor local. Usa Chrome, Edge o Firefox actualizados.", true); return; }
    notice("");
    session = freshSession();
    trackSupported = true; netErr = 0; errStreak = 0;
    try {
      track = await getAudioTrack(cfg.source);
    } catch (err) {
      cleanupAudio();
      session = null;
      notice(err && err.message === "NO_SYSTEM_AUDIO"
        ? "No se recibió audio: al compartir, elige la pestaña (p. ej. YouTube) o 'Toda la pantalla' y activa «Compartir audio»."
        : "No se pudo acceder al audio: " + (err && err.name === "NotAllowedError" ? "permiso denegado." : (err && err.message) || err), true);
      return;
    }
    if (cfg.engine === "browser") localOK = await prepareLocal(cfg.lang);
    if (cfg.translate && !hasTranslator() && !store.get("inturp.trWarned", false)) {
      notice("Para ver la traducción en vivo usa Google Chrome 138 o más reciente (escritorio): trae un traductor integrado que funciona sin internet. Las sugerencias y tarjetas siguen siendo bilingües.");
      store.set("inturp.trWarned", true);
    }
    $("transcript").innerHTML = `<p class="empty">Escuchando…</p>`;
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
    if (!skipConfirm && $("notes").value.trim() && !confirm("Al terminar se borrarán la transcripción y tus notas. ¿Terminar la llamada?")) return;
    stopRecognition();
    cleanupAudio();
    clearInterval(tick); tick = null;
    wipe();
    setState("idle");
    toast("Llamada terminada · todo borrado");
  }

  function wipe() {
    session = null; t0 = 0; pausedMs = 0;
    $("transcript").innerHTML = `<p class="empty">Llamada terminada. Todo el contenido fue eliminado.</p>`;
    $("interim").textContent = "";
    $("interimTr").textContent = "";
    $("suggestions").innerHTML = `<p class="empty">Aparecerán aquí según lo que se diga.</p>`;
    $("terms").innerHTML = `<p class="empty">Los términos de tu glosario aparecerán aquí al escucharse.</p>`;
    $("termCount").textContent = "0";
    $("quickData").innerHTML = "";
    $("notes").value = "";
    $("simInput").value = "";
    $("timer").textContent = "00:00";
    for (const el of $("domainMeter").children) { el.querySelector("b").textContent = "0%"; el.classList.remove("lead"); }
    renderCards();
  }

  function swapLang() {
    cfg.lang = cfg.lang.startsWith("es") ? "en-US" : cfg.lang.startsWith("en") ? "auto" : store.get("inturp.lastEs", "es-MX");
    applyLang();
  }
  function applyLang() {
    $("selLang").value = cfg.lang; saveCfg();
    if (cfg.lang.startsWith("es")) store.set("inturp.lastEs", cfg.lang);
    toast(cfg.lang === "auto" ? "Idioma: automático (ES + EN)" : cfg.lang.startsWith("es") ? "Escuchando: Español" : "Listening: English");
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
      ? "Tu navegador parece soportarlo: el audio no saldría del equipo."
      : "No disponible en este navegador: Chrome/Edge usan su servicio de voz en línea (no guarda ni comparte el texto con esta app).";

    $("btnStart").onclick = start;
    $("btnPause").onclick = pause;
    $("btnStop").onclick = () => stop(false);
    $("btnSwap").onclick = swapLang;
    $("selLang").onchange = (e) => { cfg.lang = e.target.value; applyLang(); };
    $("cfgTranslate").checked = cfg.translate;
    $("cfgTranslate").onchange = (e) => { cfg.translate = e.target.checked; saveCfg(); if (cfg.translate) prepareTranslators(); };
    $("trInfo").textContent = hasTranslator()
      ? "Tu navegador tiene traductor integrado: la traducción se hace en tu equipo, sin internet."
      : "Tu navegador no tiene traductor integrado. Usa Google Chrome 138 o más reciente (escritorio).";

    // tarjetas propias
    $("btnAddCard").onclick = () => { $("cardForm").reset(); $("cardCat").value = activeCat; $("cardInfo").textContent = ""; $("dlgCard").showModal(); };
    $("btnSaveCard").onclick = () => {
      const c = { cat: $("cardCat").value.trim() || "Mis tarjetas", titulo: $("cardTitle").value.trim(), es: $("cardEs").value.trim(), en: $("cardEn").value.trim(), claves: $("cardKeys").value.trim() };
      const bulk = $("cardBulk").value.trim();
      const items = bulk ? parseCardsCSV(bulk) : (c.es ? [{ ...c, titulo: c.titulo || c.es.slice(0, 30) }] : []);
      if (!items.length) { $("cardInfo").textContent = "Escribe al menos el texto en español (o pega filas CSV)."; return; }
      customCards = customCards.concat(items);
      activeCat = items[items.length - 1].cat;
      saveCustomCards();
      $("dlgCard").close();
      toast(items.length > 1 ? `${items.length} tarjetas agregadas` : "Tarjeta agregada");
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
      copy(e.target.closest(".en") ? el.dataset.en : el.dataset.es);
    };
    $("cardTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) { activeCat = b.dataset.cat; renderCards(); } };
    $("cards").onclick = (e) => {
      const del = e.target.closest("[data-del]");
      if (del) { if (confirm("¿Eliminar esta tarjeta?")) { customCards.splice(+del.dataset.del, 1); saveCustomCards(); } return; }
      const el = e.target.closest("[data-copy]") || e.target.closest(".card")?.querySelector(".es"); if (el) copy(el.dataset.copy);
    };
    $("quickData").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const n = $("notes"); n.value += (n.value && !n.value.endsWith("\n") ? "\n" : "") + b.dataset.v + " "; n.focus();
    };
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
      $("glossResults").innerHTML = glossary.filter((g) => strip(`${g.t} ${g.tr} ${g.d}`).includes(q)).slice(0, 30).map((g) => termHTML(g)).join("") || `<p class="empty">Sin resultados.</p>`;
    };

    $("fileGloss").onchange = async (e) => { const f = e.target.files[0]; if (f) $("pasteGloss").value = await f.text(); };
    $("btnImport").onclick = () => {
      try {
        const items = parseGlossary($("pasteGloss").value);
        if (!items.length) { $("glossInfo").textContent = "No se encontraron filas válidas."; return; }
        const prev = store.get("inturp.gloss", null);
        const replace = $("cfgReplace").checked;
        const merged = replace ? items : (prev ? prev.items : []).concat(items);
        store.set("inturp.gloss", { replace: replace || !!(prev && prev.replace), items: merged });
        loadGlossary();
        $("glossInfo").textContent = `Importadas ${items.length} entradas · glosario activo: ${glossary.length}.`;
        $("pasteGloss").value = ""; $("fileGloss").value = "";
      } catch (err) { $("glossInfo").textContent = "Error al leer: " + err.message; }
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

  loadGlossary();
  bind();
  renderCards();
  setState("idle");
  // Gancho mínimo para pruebas automáticas (no expone datos de llamadas).
  window.__inturp = { analyze, suggestionsFor, parseGlossary, handleFinal: (t) => { if (!session) session = freshSession(); handleFinal(t); }, wipe: () => { stop(true); wipe(); } };
})();
