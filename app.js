/* Inturpreneur — asistente de interpretación en vivo.
 * Todo corre en el navegador. Nada del texto de la llamada se guarda (ni localStorage, ni red):
 * vive solo en memoria y en pantalla, y se borra al presionar "Terminar" o cerrar la pestaña.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const DOMS = ["medico", "legal", "bancario"];
  const DOM_LABEL = { medico: "Médico", legal: "Legal", bancario: "Bancario", duda: "Duda", general: "General" };
  const TAB_FOR_DOM = { medico: "Médico", legal: "Legal", bancario: "Bancario" };

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
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 1300);
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
  const cfg = Object.assign({ name: "", id: "", local: false, lang: "es-MX", source: "mic" }, store.get("inturp.cfg", {}));
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
    return "general";
  }
  function loadGlossary() {
    const extra = store.get("inturp.gloss", null);
    const base = (window.GLOSARIO_BASE || []).map((e) => ({ ...e, dom: normDom(e.dom) }));
    glossary = extra ? (extra.replace ? extra.items : base.concat(extra.items)) : base;
    buildIndex();
  }
  function buildIndex() {
    termIndex = new Map();
    for (const e of glossary) {
      for (const k of [e.t, e.tr]) {
        if (!k) continue;
        const key = strip(k).trim();
        if (key.length >= 2 && !termIndex.has(key)) termIndex.set(key, e);
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
    const score = { medico: 0, legal: 0, bancario: 0 };
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
    return out.slice(0, 6);
  }

  // ───────────────── Estado de la sesión (solo memoria) ─────────────────
  let session = null;
  const freshSession = () => ({
    acc: { medico: 0, legal: 0, bancario: 0 },
    termsSeen: new Map(),   // entrada → contador
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
        <span class="src tag ${s.dom}">${DOM_LABEL[s.dom] || s.dom}</span>
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

  /** Procesa una frase final. */
  function handleFinal(text) {
    text = text.trim();
    if (!text || !session) return;
    const a = analyze(text);
    session.count++;
    for (const d of DOMS) session.acc[d] = session.acc[d] * 0.8 + a.score[d];
    const now = Date.now();
    for (const e of a.terms) { const v = session.termsSeen.get(e) || { n: 0, t: 0 }; v.n++; v.t = now; session.termsSeen.set(e, v); }
    for (const v of a.nums) { session.nums.delete(v); session.nums.add(v); }

    const tr = $("transcript");
    if (session.count === 1) tr.innerHTML = "";
    const p = document.createElement("div");
    const tags = [...a.doms, ...(a.question ? ["duda"] : [])];
    p.className = "phrase " + (a.doms[0] || "");
    p.innerHTML = `<span class="time">${fmtTime(elapsed())}</span><span class="tags">${tags.map((t) => `<span class="tag ${t}">${DOM_LABEL[t]}</span>`).join("")}</span>${a.html}`;
    tr.appendChild(p);
    while (tr.children.length > 300) tr.firstChild.remove();
    tr.scrollTop = tr.scrollHeight;

    renderSuggestions(suggestionsFor(a));
    renderMeter(); renderTerms(); renderChips();
  }

  let interimT;
  function handleInterim(text) {
    const box = $("interim");
    if (!text) { box.textContent = ""; return; }
    clearTimeout(interimT);
    interimT = setTimeout(() => {
      const a = analyze(text);
      box.innerHTML = a.html + " …";
      const s = suggestionsFor(a);
      if (a.terms.length || s.length > 1 || a.question) renderSuggestions(s);   // respuesta inmediata mientras hablan
    }, 60);
  }

  // ───────────────── Tarjetas ─────────────────
  let activeCat = "Introducción";
  const fill = (s) => s.replace(/\{nombre\}/g, cfg.name || "___").replace(/\{id\}/g, cfg.id || "___");
  function renderCards() {
    const cats = [...new Set((window.TARJETAS || []).map((c) => c.cat))];
    $("cardTabs").innerHTML = cats.map((c) => `<button type="button" data-cat="${esc(c)}" class="${c === activeCat ? "on" : ""}">${esc(c)}</button>`).join("");
    $("cards").innerHTML = (window.TARJETAS || []).filter((c) => c.cat === activeCat).map((c) => `
      <div class="card"><div class="title">${esc(c.titulo)}</div>
        <div class="es" data-copy="${esc(fill(c.es))}">${esc(fill(c.es))}</div>
        <div class="en" data-copy="${esc(fill(c.en))}">${esc(fill(c.en))}</div></div>`).join("");
    if (session) renderMeter();
  }

  // ───────────────── Captura de audio y reconocimiento ─────────────────
  let state = "idle";        // idle | running | paused
  let rec = null, streams = [], audioCtx = null, track = null, trackSupported = true;
  let t0 = 0, pausedMs = 0, pauseAt = 0, tick = null, errStreak = 0;
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
  }

  async function getAudioTrack(source) {
    if (source === "mic") return null; // el reconocimiento usa el micrófono predeterminado directamente
    const disp = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include", selfBrowserSurface: "exclude", preferCurrentTab: false,
    });
    streams.push(disp);
    const sysTrack = disp.getAudioTracks()[0];
    if (!sysTrack) throw new Error("NO_SYSTEM_AUDIO");
    sysTrack.addEventListener("ended", () => { if (state !== "idle") { pause(); notice("Se dejó de compartir el audio del sistema. Presiona Terminar e Inicia de nuevo para volver a compartir."); } });
    if (source === "system") return sysTrack;
    // mezcla micrófono + sistema
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    streams.push(mic);
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    audioCtx.createMediaStreamSource(new MediaStream([sysTrack])).connect(dest);
    audioCtx.createMediaStreamSource(mic).connect(dest);
    return dest.stream.getAudioTracks()[0];
  }

  async function prepareLocal(lang) {
    if (!cfg.local) return false;
    try {
      if (typeof SR.available === "function") {
        const st = await SR.available({ langs: [lang], processLocally: true });
        if (st === "available") return true;
        if ((st === "downloadable" || st === "downloading") && typeof SR.install === "function") {
          notice("Descargando el modelo de voz local (solo la primera vez)…");
          const ok = await SR.install({ langs: [lang], processLocally: true });
          notice("");
          return !!ok;
        }
      }
    } catch { /* no soportado */ }
    notice("Tu navegador no ofrece reconocimiento en el dispositivo para este idioma; se usa el motor estándar del navegador.");
    return false;
  }

  function makeRec(local) {
    const r = new SR();
    r.lang = cfg.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    if (local && "processLocally" in r) r.processLocally = true;
    r.onresult = (e) => {
      errStreak = 0;
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
        "service-not-allowed": "El navegador bloqueó el servicio de voz. Usa Google Chrome o Microsoft Edge.",
        "audio-capture": "No se encontró un dispositivo de audio.",
        "language-not-supported": "Idioma no soportado por el motor de voz." }[e.error];
      if (fatal) { notice(fatal, true); stopRecognition(); setState("paused"); pauseAt = Date.now(); return; }
      errStreak++;
      if (e.error === "network") notice("Problema de red con el motor de voz del navegador; reintentando…", true);
    };
    r.onend = () => {
      if (rec !== r) return;
      if (state === "running") setTimeout(() => state === "running" && startRecognition(), errStreak > 3 ? 1000 : 0);
    };
    return r;
  }

  let localOK = false;
  function startRecognition() {
    rec = makeRec(localOK);
    try {
      if (track && trackSupported) {
        try { rec.start(track); }
        catch (err) {
          trackSupported = false;
          rec = makeRec(localOK); rec.start();
          notice("Tu navegador no permite reconocer audio del sistema directamente; se está usando el micrófono predeterminado. Actualiza Chrome/Edge o usa un cable de audio virtual (ver README).", true);
        }
      } else rec.start();
    } catch (err) { /* ya iniciado */ }
  }
  function stopRecognition() {
    const r = rec; rec = null;
    if (r) { try { r.onend = null; r.abort(); } catch { /* */ } }
    handleInterim("");
  }

  async function start() {
    if (!SR) { notice("Este navegador no soporta reconocimiento de voz. Usa Google Chrome o Microsoft Edge (escritorio).", true); return; }
    if (state !== "idle") return;
    notice("");
    session = freshSession();
    trackSupported = true;
    try {
      track = await getAudioTrack(cfg.source);
    } catch (err) {
      cleanupAudio();
      session = null;
      notice(err && err.message === "NO_SYSTEM_AUDIO"
        ? "No se recibió audio del sistema: al compartir, elige una pestaña o 'Toda la pantalla' y activa «Compartir audio»."
        : "No se pudo acceder al audio: " + (err && err.name === "NotAllowedError" ? "permiso denegado." : (err && err.message) || err), true);
      return;
    }
    localOK = await prepareLocal(cfg.lang);
    $("transcript").innerHTML = `<p class="empty">Escuchando…</p>`;
    t0 = Date.now(); pausedMs = 0;
    setState("running");
    startRecognition();
    tick = setInterval(() => ($("timer").textContent = fmtTime(elapsed())), 500);
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
    cfg.lang = cfg.lang.startsWith("es") ? "en-US" : (store.get("inturp.lastEs", "es-MX"));
    $("selLang").value = cfg.lang; saveCfg();
    toast(cfg.lang.startsWith("es") ? "Escuchando: Español" : "Listening: English");
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
    $("cfgName").value = cfg.name; $("cfgId").value = cfg.id; $("cfgLocal").checked = cfg.local;
    $("localInfo").textContent = SR && (typeof SR.available === "function" || "processLocally" in SR.prototype)
      ? "Tu navegador parece soportarlo: el audio no saldría del equipo."
      : "No disponible en este navegador: Chrome/Edge usan su servicio de voz en línea (no guarda ni comparte el texto con esta app).";

    $("btnStart").onclick = start;
    $("btnPause").onclick = pause;
    $("btnStop").onclick = () => stop(false);
    $("btnSwap").onclick = swapLang;
    $("selLang").onchange = (e) => {
      cfg.lang = e.target.value; if (cfg.lang.startsWith("es")) store.set("inturp.lastEs", cfg.lang); saveCfg();
      if (state === "running") { stopRecognition(); startRecognition(); }
    };
    $("selSource").onchange = (e) => { cfg.source = e.target.value; saveCfg(); };
    $("btnSettings").onclick = () => $("dlgSettings").showModal();
    $("cfgName").oninput = (e) => { cfg.name = e.target.value; saveCfg(); renderCards(); };
    $("cfgId").oninput = (e) => { cfg.id = e.target.value; saveCfg(); renderCards(); };
    $("cfgLocal").onchange = (e) => { cfg.local = e.target.checked; saveCfg(); };

    $("suggestions").onclick = (e) => {
      const el = e.target.closest(".sugg"); if (!el) return;
      copy(e.target.closest(".en") ? el.dataset.en : el.dataset.es);
    };
    $("cardTabs").onclick = (e) => { const b = e.target.closest("button"); if (b) { activeCat = b.dataset.cat; renderCards(); } };
    $("cards").onclick = (e) => { const el = e.target.closest("[data-copy]") || e.target.closest(".card")?.querySelector(".es"); if (el) copy(el.dataset.copy); };
    $("quickData").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const n = $("notes"); n.value += (n.value && !n.value.endsWith("\n") ? "\n" : "") + b.dataset.v + " "; n.focus();
    };
    $("btnCopyNotes").onclick = () => $("notes").value.trim() && copy($("notes").value);

    $("simForm").onsubmit = (e) => {
      e.preventDefault();
      const v = $("simInput").value; if (!v.trim()) return;
      if (!session) { session = freshSession(); if (!t0) { t0 = Date.now(); pausedMs = 0; } }
      handleFinal(v); $("simInput").value = "";
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
