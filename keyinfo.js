/* Inturpreneur — extracción de información clave (sin IA, reglas + contexto).
 * Detecta en cada frase: nombres, SSN, tarjeta, cuenta, routing, teléfono, fecha de nacimiento y fechas,
 * montos, horas, ZIP, póliza / reclamo / miembro / caso, placa, dirección y correo.
 * - Convierte números dichos con palabras (EN/ES) a cifras: "five five five" → 555, "doscientos cincuenta" → 250.
 * - Usa el contexto: si alguien pregunta "what's your social security number?", los números de la(s)
 *   frase(s) siguientes se asignan a SSN, y se juntan si se dictan en partes.
 * - Valida la cantidad de dígitos y la fecha; si algo no cuadra lo marca para confirmar.
 * Todo vive en memoria; la app lo borra al terminar la llamada.
 */
(function (root) {
  "use strict";
  const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // ───────── Números dichos con palabras ─────────
  const UNITS = {
    zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    cero: 0, uno: 1, una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  };
  const TEENS = {
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
    veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
    veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  };
  const TENS = {
    twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  };
  const HUNDREDS = {
    cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
    quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700,
    ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
  };
  const MULT = { hundred: 100, thousand: 1000, mil: 1000, million: 1e6, millon: 1e6, millones: 1e6 };
  const ORD = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
    thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
    thirtieth: 30, primero: 1, primer: 1,
  };
  const isNumWord = (w) => w in UNITS || w in TEENS || w in TENS || w in HUNDREDS || w in MULT || w in ORD || /^\d+$/.test(w);

  /** Convierte una secuencia de palabras numéricas en "trozos" (chunks) con su valor.
   *  "five five five" → [5,5,5]; "twenty one" → [21]; "five fifty five" → [5,55];
   *  "mil novecientos ochenta y cinco" → [1985]; "two thousand twenty six" → [2026]. */
  function chunksOf(tokens) {
    const out = [];
    let cur = null; // { total, small, last }
    const val = (c) => c.total + c.small;
    const push = () => { if (cur) out.push({ val: val(cur), last: cur.last, ordinal: cur.ordinal }); cur = null; };
    const start = (v, last) => { push(); cur = { total: 0, small: v, last }; };
    for (const w of tokens) {
      if (/^\d+$/.test(w)) { push(); out.push({ val: +w, digits: w, last: "digits" }); continue; }
      if (w in ORD) {
        const o = ORD[w];
        if (cur && cur.last === "tens" && o < 10) { cur.small += o; cur.ordinal = true; push(); continue; }
        push(); out.push({ val: o, last: "unit", ordinal: true }); continue;
      }
      const canAddSmall = cur && (cur.last === "tens" || cur.last === "hund" || (cur.last === "mult" && cur.small === 0));
      if (w in UNITS) {
        if (canAddSmall && !(cur.last === "tens" && cur.small % 10 !== 0)) { cur.small += UNITS[w]; cur.last = "unit"; continue; }
        start(UNITS[w], "unit"); continue;
      }
      if (w in TEENS) {
        if (cur && (cur.last === "hund" || (cur.last === "mult" && cur.small === 0))) { cur.small += TEENS[w]; cur.last = "teen"; continue; }
        start(TEENS[w], "teen"); continue;
      }
      if (w in TENS) {
        if (cur && (cur.last === "hund" || (cur.last === "mult" && cur.small === 0))) { cur.small += TENS[w]; cur.last = "tens"; continue; }
        start(TENS[w], "tens"); continue;
      }
      if (w in HUNDREDS) {
        if (cur && cur.last === "mult" && cur.small === 0) { cur.small = HUNDREDS[w]; cur.last = "hund"; continue; }
        start(HUNDREDS[w], "hund"); continue;
      }
      if (w === "hundred") {
        if (cur && (cur.last === "unit" || cur.last === "teen") && cur.small < 20) { cur.small *= 100; cur.last = "hund"; continue; }
        start(100, "hund"); continue;
      }
      if (w in MULT) {
        const m = MULT[w];
        if (!cur) { cur = { total: m, small: 0, last: "mult" }; continue; }
        if (cur.last === "mult" && cur.small === 0) { cur.total *= m; continue; }   // "un millón"... raro
        cur.total += (cur.small || 1) * m; cur.small = 0; cur.last = "mult"; continue;
      }
    }
    push();
    return out;
  }

  /** ¿La palabra en la posición i es un número? (resuelve "o", "uno", "un", "una", "second"…) */
  function numericAt(toks, i) {
    const w = toks[i] && toks[i].w; if (!w || !isNumWord(w)) return false;
    const prev = toks[i - 1] && toks[i - 1].w, next = toks[i + 1] && toks[i + 1].w;
    const strong = (x) => x && isNumWord(x) && !["o", "un", "una", "uno", "one", "second", "first"].includes(x);
    if (w === "o") return strong(prev) && strong(next);
    if (w === "uno" || w === "one") return true;
    if (w === "un" || w === "una") return next in MULT || next === "hundred";
    if (w === "second" || w === "first") return !!(prev && (prev === "the" || prev in MONTHS)) || !!(next && next === "of");
    return true;
  }

  /** Tokeniza el texto normalizado en palabras con posiciones. */
  function tokenize(n) {
    const toks = []; const re = /[a-z0-9ñ]+(?:[.'][a-z0-9]+)*/g; let m;
    while ((m = re.exec(n))) toks.push({ w: m[0], a: m.index, b: m.index + m[0].length });
    return toks;
  }

  /** Encuentra grupos numéricos (palabras o cifras) en el texto normalizado.
   *  Devuelve [{a,b, raw, digits (concatenación de trozos), value (valor cardinal si es un solo trozo), chunks}] */
  function numberGroups(n) {
    const toks = tokenize(n);
    const groups = [];
    let i = 0;
    while (i < toks.length) {
      if (!numericAt(toks, i)) { i++; continue; }
      let j = i; const words = [];
      while (j < toks.length) {
        const w = toks[j].w;
        if (numericAt(toks, j) || (w === "o" && words.length && j + 1 < toks.length && isNumWord(toks[j + 1].w))) { words.push(w); j++; continue; }
        // conectores: "y" en español entre decenas y unidades, "and" en inglés (two hundred and five), guiones ya separados
        if ((w === "y" || w === "and") && j + 1 < toks.length && isNumWord(toks[j + 1].w) && words.length) {
          const prev = words[words.length - 1];
          if ((w === "y" && prev in TENS) || (w === "and" && (prev === "hundred" || prev in MULT))) { j++; continue; }
        }
        // separadores hablados entre bloques de dígitos: "dash", "guion"
        if ((w === "dash" || w === "guion") && words.length && j + 1 < toks.length && isNumWord(toks[j + 1].w)) { j++; continue; }
        break;
      }
      if (!words.length) { i++; continue; }
      const chunks = chunksOf(words);
      const digits = chunks.map((c) => (c.digits !== undefined ? c.digits : String(c.val))).join("");
      groups.push({ a: toks[i].a, b: toks[j - 1].b, raw: n.slice(toks[i].a, toks[j - 1].b), digits, value: chunks.length === 1 ? chunks[0].val : null, chunks, words });
      i = j;
    }
    // une grupos de cifras separados solo por espacios, guiones o puntos: "123 45 6789", "555-123-4567"
    const merged = [];
    for (const g of groups) {
      const last = merged[merged.length - 1];
      if (last && /^[\s\-–.]*$/.test(n.slice(last.b, g.a)) && n.slice(last.b, g.a).length <= 3 && /^\d+$/.test(last.raw.replace(/[\s\-–.]/g, "")) && /^\d+$/.test(g.raw)) {
        last.b = g.b; last.raw = n.slice(last.a, last.b); last.digits += g.digits; last.value = null; last.chunks = last.chunks.concat(g.chunks);
      } else merged.push({ ...g });
    }
    return merged;
  }

  // ───────── Fechas ─────────
  const MONTHS = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
    august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  };
  const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (x) => String(x).padStart(2, "0");

  /** Año a partir de trozos: [1985] | [19, 85] ("nineteen eighty five") | [2000, 26] | [85] → 1985 */
  function yearFrom(chunks) {
    if (!chunks || !chunks.length) return null;
    let y = null;
    if (chunks.length === 1) y = chunks[0].val;
    else if (chunks.length === 2 && chunks[0].val >= 19 && chunks[0].val <= 20 && chunks[1].val < 100) y = chunks[0].val * 100 + chunks[1].val;
    else if (chunks.length === 2 && chunks[0].val >= 1000) y = chunks[0].val + chunks[1].val;
    else if (chunks.length === 4 && chunks.every((c) => c.val < 10)) y = +chunks.map((c) => c.val).join("");
    if (y !== null && y < 100) y += y > 30 ? 1900 : 2000;
    return y !== null && y >= 1900 && y <= 2100 ? y : null;
  }

  function findDates(n, groups) {
    const out = [];
    // numérica: 12/15/2026, 15-12-1985, 3/4
    const re = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/g; let m;
    while ((m = re.exec(n))) {
      let mo = +m[1], d = +m[2], y = m[3] ? +m[3] : null;
      if (y !== null && y < 100) y += y > 30 ? 1900 : 2000;
      let ambiguous = false;
      if (mo > 12 && d <= 12) { [mo, d] = [d, mo]; } else if (mo <= 12 && d <= 12 && mo !== d) ambiguous = true;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push({ a: m.index, b: m.index + m[0].length, raw: m[0], mo, d, y, ambiguous });
    }
    // con nombre de mes: "march 12 1985", "12 de marzo de 1985", "the 12th of march", "marzo doce"
    const toks = tokenize(n);
    for (let i = 0; i < toks.length; i++) {
      const mo = MONTHS[toks[i].w];
      if (!mo || (toks[i].w === "may" && !/\d|first|second|third|th\b/.test(n.slice(toks[i].b, toks[i].b + 25)) && !/\d/.test(n.slice(Math.max(0, toks[i].a - 12), toks[i].a)))) continue;
      if (toks[i].w === "mar" || toks[i].w === "sep" || toks[i].w === "jan") { /* abreviaturas solo si hay número cerca */ if (!/\d/.test(n.slice(Math.max(0, toks[i].a - 6), toks[i].b + 8))) continue; }
      const before = groups.filter((g) => g.b <= toks[i].a && toks[i].a - g.b <= 8).pop();
      const after = groups.filter((g) => g.a >= toks[i].b && g.a - toks[i].b <= 6)[0];
      let d = null, y = null, a = toks[i].a, b = toks[i].b;
      const dayOf = (g) => { const c = g.chunks; if (c.length === 1 && c[0].val >= 1 && c[0].val <= 31) return c[0].val; return null; };
      if (before && dayOf(before)) { d = dayOf(before); a = before.a; }
      if (after) {
        if (!d && after.chunks.length >= 1 && after.chunks[0].val <= 31 && after.chunks[0].val >= 1) {
          d = after.chunks[0].val; b = after.b;
          const rest = after.chunks.slice(1); if (rest.length) { y = yearFrom(rest); }
          if (!y) { const nxt = groups.filter((g) => g.a > after.b && g.a - after.b <= 6)[0]; if (nxt) { y = yearFrom(nxt.chunks); if (y) b = nxt.b; } }
        } else { y = yearFrom(after.chunks); if (y) b = after.b; }
      }
      if (!y) { const nxt = groups.filter((g) => g.a > b && g.a - b <= 6)[0]; if (nxt) { const yy = yearFrom(nxt.chunks); if (yy) { y = yy; b = nxt.b; } } }
      if (d || y) out.push({ a, b, raw: n.slice(a, b), mo, d, y, ambiguous: false });
    }
    // quita solapados (se queda con el más largo)
    out.sort((x, y2) => x.a - y2.a || (y2.b - y2.a) - (x.b - x.a));
    const res = []; let last = -1;
    for (const d of out) if (d.a >= last) { res.push(d); last = d.b; }
    return res;
  }
  function fmtDate(d) {
    const s = `${d.d ? pad(d.d) + " " : ""}${MONTH_NAMES[d.mo]}${d.y ? " " + d.y : ""}`;
    const num = `${pad(d.mo)}/${d.d ? pad(d.d) : "??"}/${d.y || "????"}`;
    return { text: s, num };
  }

  // ───────── Campos ─────────
  const F = (o) => o;
  const FIELDS = [
    F({ type: "ssn", label: "SSN", kw: /\b(social security( number)?|seguro social|ssn|security number)\b/, len: [9, 4], sensitive: true, read: "social security number", readEs: "número de seguro social" }),
    F({ type: "card", label: "Card #", kw: /\b(card number|numero de (la )?tarjeta|credit card|debit card|tarjeta de (credito|debito)|(the|my|your) card|(la|mi|su) tarjeta|card ending( in)?|ending in|termina en)\b/, len: [16, 15, 4], sensitive: true, read: "card number", readEs: "número de tarjeta" }),
    F({ type: "cvv", label: "CVV", kw: /\b(cvv|cvc|security code|codigo de seguridad)\b/, len: [3, 4], sensitive: true, read: "security code", readEs: "código de seguridad" }),
    F({ type: "routing", label: "Routing #", kw: /\b(routing( number)?|numero de ruta)\b/, len: [9], read: "routing number", readEs: "número de ruta" }),
    F({ type: "account", label: "Account #", kw: /\b(account number|numero de (la )?cuenta|cuenta numero)\b/, minLen: 4, maxLen: 17, read: "account number", readEs: "número de cuenta" }),
    F({ type: "phone", label: "Phone", kw: /\b(phone( number)?|telephone|cell( phone)?|call(back| back| you back)|contact number|telefono|celular|numero de contacto)\b/, len: [10, 7], read: "phone number", readEs: "número de teléfono" }),
    F({ type: "zip", label: "ZIP", kw: /\b(zip( code)?|codigo postal)\b/, len: [5], read: "ZIP code", readEs: "código postal" }),
    F({ type: "policy", label: "Policy #", kw: /\b(policy( number)?|numero de (la )?poliza|poliza( numero)?)\b/, id: true, read: "policy number", readEs: "número de póliza" }),
    F({ type: "claim", label: "Claim #", kw: /\b(claim( number)?|numero de (reclamo|reclamacion)|reclamo( numero)?)\b/, id: true, read: "claim number", readEs: "número de reclamo" }),
    F({ type: "member", label: "Member ID", kw: /\b(member( id| number)|numero de (miembro|afiliado)|id de miembro)\b/, id: true, read: "member ID", readEs: "número de miembro" }),
    F({ type: "case", label: "Case #", kw: /\b(case number|numero de caso|confirmation number|numero de confirmacion|reference number|numero de referencia)\b/, id: true, read: "case number", readEs: "número de caso" }),
    F({ type: "plate", label: "Plate", kw: /\b(license plate|plate number|numero de placa|placas?)\b/, id: true, read: "license plate", readEs: "placa" }),
    F({ type: "dob", label: "Date of birth", kw: /\b(date of birth|birth ?date|born|dob|fecha de nacimiento|naci|cumpleanos)\b/, date: true, read: "date of birth", readEs: "fecha de nacimiento" }),
    F({ type: "name", label: "Name", kw: /\b(my name is|name is|full name|last name|first name|me llamo|mi nombre (completo )?es|se llama|nombre completo|apellido)\b/, name: true }),
    F({ type: "address", label: "Address", kw: /\b(address|i live (at|on|in)|vivo en|direccion( es)?|domicilio)\b/, address: true }),
    F({ type: "email", label: "Email", kw: /\b(e-?mail|correo( electronico)?)\b/, email: true }),
  ];
  const BY_TYPE = Object.fromEntries(FIELDS.map((f) => [f.type, f]));
  const NAME_STOP = new Set("is es and y the el la de del los las a my mi su your i yo it its im soy please por favor um uh eh este pues so ok okay bueno well and thank thanks gracias sir senor senora maam miss naci vivo tengo born live have was fue".split(" "));
  const NAME_FIELD = new Set("date birth number address phone social security card account email please por favor fecha nacimiento numero direccion telefono correo tarjeta cuenta".split(" "));
  const LETTER_WORDS = { ay: "a", bee: "b", see: "c", sea: "c", dee: "d", ee: "e", ef: "f", gee: "g", aitch: "h", jay: "j", kay: "k", el: "l", em: "m", en: "n", pee: "p", cue: "q", queue: "q", ar: "r", es: "s", tee: "t", you: "u", vee: "v", ex: "x", why: "y", zee: "z", zed: "z" };

  /** Junta letras deletreadas: "j o h n" / "j-o-h-n" → "john". */
  function spelled(n) {
    const toks = tokenize(n); const out = [];
    let i = 0;
    while (i < toks.length) {
      let j = i; let s = "";
      while (j < toks.length && /^[a-z]$/.test(toks[j].w)) { s += toks[j].w; j++; }
      if (j - i >= 3) { out.push({ a: toks[i].a, b: toks[j - 1].b, word: s }); i = j; } else i++;
    }
    return out;
  }

  const cap = (w) => w.split(/(\s+)/).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join("");

  /**
   * Analiza una frase. ctx = { expect: {type, until, digits, a?} | null, now }.
   * Devuelve { items: [...], spans: [{a,b,label}], expect: nuevoEsperado }
   * text: texto original; n: texto normalizado (sin acentos, minúsculas) con map de posiciones.
   */
  function extract(text, n, ctx) {
    const now = ctx.now || Date.now();
    // "3rd", "12th", "1st" → "3  ", "12  " (misma longitud para no mover posiciones)
    n = n.replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, (m, d, sfx) => d + " ".repeat(sfx.length));
    const items = []; const spans = [];
    const groups = numberGroups(n);
    const dates = findDates(n, groups);
    const used = new Array(groups.length).fill(false);
    // marca grupos usados por fechas
    for (const d of dates) groups.forEach((g, k) => { if (g.a >= d.a && g.b <= d.b) used[k] = true; });

    // campos mencionados en esta frase (en orden de aparición)
    const mentions = [];
    for (const f of FIELDS) { const r = new RegExp(f.kw.source, "g"); let m; while ((m = r.exec(n))) mentions.push({ f, a: m.index, b: m.index + m[0].length }); }
    mentions.sort((x, y) => x.a - y.a);

    let expect = ctx.expect && ctx.expect.until > now ? { ...ctx.expect } : null;
    const fieldAt = (pos) => { // campo vigente en esa posición: la última mención antes de pos, o el esperado por contexto
      let f = null; for (const m of mentions) if (m.b <= pos) f = m.f; return f || (expect ? BY_TYPE[expect.type] : null);
    };

    const add = (it) => { items.push(it); if (it.a !== undefined) spans.push({ a: it.a, b: it.b, label: it.label }); };

    // ── fechas
    for (const d of dates) {
      const f = fieldAt(d.a);
      const isDob = f && f.type === "dob";
      const fd = fmtDate(d);
      const check = !d.y || !d.d || d.ambiguous;
      add({ type: isDob ? "dob" : "date", label: isDob ? "Date of birth" : "Date", value: fd.text, alt: fd.num, raw: d.raw, a: d.a, b: d.b, check,
        note: d.ambiguous ? "Month/day could be swapped — confirm" : (!d.y ? "No year heard" : (!d.d ? "No day heard" : "")),
        read: isDob ? `${BY_TYPE.dob.read}: ${fd.text}` : fd.text });
      if (isDob) expect = null;
    }

    // zonas reservadas (dirección, correo, identificadores alfanuméricos) para que sus números no salgan sueltos
    const reserved = [];
    for (const m of mentions) {
      if (m.f.address) { const tail = n.slice(m.b); const zip = tail.search(/\b\d{5}\b/); reserved.push([m.b, m.b + (zip >= 0 && zip < 120 ? zip + 5 : Math.min(tail.length, 90))]); }
      if (m.f.email) reserved.push([m.b, m.b + 80]);
    }
    groups.forEach((g, k) => { if (reserved.some(([x, y]) => g.a >= x && g.b <= y)) used[k] = true; });

    // ── números
    groups.forEach((g, k) => {
      if (used[k]) return;
      const after = n.slice(g.b, g.b + 22), before = n.slice(Math.max(0, g.a - 6), g.a);
      // montos
      const cur = after.match(/^\s*(dollars?|dolares?|bucks|pesos|usd|cents?|centavos)\b/) || (before.match(/\$\s*$/) ? ["$"] : null);
      if (cur || /\$\s*$/.test(before)) {
        const isCents = cur && /cent/.test(cur[0]);
        const val = g.value !== null ? g.value : +g.digits;
        let b = g.b + (cur && cur[0] !== "$" ? cur[0].length : 0);
        let cents = null;
        const m2 = n.slice(b).match(/^\s*(and|y|con)\s+([a-z0-9 ]+?)\s+(cents?|centavos)\b/);
        if (m2) { const cg = numberGroups(m2[2]); if (cg.length === 1 && cg[0].value !== null && cg[0].value < 100) { cents = cg[0].value; b += m2[0].length; } }
        groups.forEach((g2, k2) => { if (k2 > k && g2.a < b) used[k2] = true; });
        const amount = isCents ? `$0.${pad(val)}` : `$${val.toLocaleString("en-US")}${cents !== null ? "." + pad(cents) : ""}`;
        const unit = cur && /peso/.test(cur[0]) ? " MXN" : "";
        add({ type: "amount", label: "Amount", value: amount.replace("$", unit ? "$" : "$") + unit, raw: n.slice(g.a, b), a: g.a, b, check: false, read: amount + unit });
        return;
      }
      // horas: "3:30", "at three thirty pm", "a las tres"
      if (/^\d{1,2}:\d{2}$/.test(g.raw) || /^\s*(a\.?\s?m\.?|p\.?\s?m\.?|o'?clock|de la (manana|tarde|noche))\b/.test(after) || /\b(a las|at)\s*$/.test(n.slice(Math.max(0, g.a - 7), g.a)) && g.value !== null && g.value <= 12 && !fieldAt(g.a)) {
        const ampm = (after.match(/^\s*(a\.?\s?m\.?|p\.?\s?m\.?|de la manana|de la tarde|de la noche)/) || [""])[0].trim();
        let t = g.raw.includes(":") ? g.raw : (g.chunks.length === 2 ? `${g.chunks[0].val}:${pad(g.chunks[1].val)}` : `${g.value}:00`);
        const ap = /p|tarde|noche/.test(ampm) ? " PM" : /a|manana/.test(ampm) ? " AM" : "";
        add({ type: "time", label: "Time", value: t + ap, raw: g.raw, a: g.a, b: g.b + (ampm ? after.indexOf(ampm) + ampm.length : 0), check: false, read: t + ap });
        return;
      }
      const f = fieldAt(g.a);
      let digits = g.digits;
      if (f && (f.len || f.minLen || f.id)) {
        // si se está dictando en partes, junta con lo anterior
        if (expect && expect.type === f.type && expect.digits && !mentions.some((m) => m.f === f && m.b <= g.a)) digits = expect.digits + digits;
        const L = digits.length;
        const lastFour = L === 4 && /\b(last (4|four)|ending|ends in|termina|ultimos (4|cuatro))\b/.test(n);
        let ok;
        if (f.len) ok = f.len.includes(L); else if (f.minLen) ok = L >= f.minLen && L <= f.maxLen; else ok = L >= 3;
        const expectedMax = f.len ? Math.max(...f.len) : (f.maxLen || 99);
        const partialOk = f.len && L < expectedMax && !ok;
        const fmt = formatDigits(f.type, digits);
        add({ type: f.type, label: f.label, value: fmt, raw: g.raw, a: g.a, b: g.b, digits, sensitive: !!f.sensitive, check: !ok || (L === 4 && !lastFour && f.len && Math.max(...f.len) > 4),
          note: lastFour ? "Last 4 digits" : ok ? (f.len && L === 4 && L < Math.max(...f.len) ? "4 digits — last four, or more coming?" : "") : (partialOk ? `${L} digits so far (expected ${f.len.join(" or ")})` : `${L} digits — confirm`),
          read: `${f.read}: ${spaced(digits)}`, readEs: `${f.readEs}: ${spaced(digits)}`, replaceKey: f.type });
        expect = lastFour || (ok && L >= expectedMax) ? null : { type: f.type, until: now + 20000, digits };
        return;
      }
      // número suelto (sin contexto)
      if (g.digits.length >= 3) {
        add({ type: "number", label: "Number", value: g.value !== null && g.chunks.length === 1 && g.chunks[0].digits === undefined ? g.value.toLocaleString("en-US") : (g.chunks.length === 1 ? g.digits : spaced(g.digits)), raw: g.raw, a: g.a, b: g.b, check: false, read: spaced(g.digits) });
      }
    });

    // ── identificadores alfanuméricos dictados (póliza ABC123, placa 7XYZ123) y letras deletreadas
    for (const m of mentions) {
      if (!m.f.id) continue;
      const tail = n.slice(m.b, m.b + 60);
      const mm = tail.match(/^\s*(?:is|es|number|numero|:)?\s*((?:[a-z]{1,4}[\s-]?)?\d(?:[\d-]|\s(?=\d))*\d(?:[a-z]{1,3}\b)?)/);
      if (mm && !items.some((it) => it.replaceKey === m.f.type)) {
        const id = mm[1].replace(/[\s-]/g, "").toUpperCase();
        if (/\d/.test(id) && id.length >= 4) {
          const a = m.b + tail.indexOf(mm[1]);
          add({ type: m.f.type, label: m.f.label, value: id, raw: mm[1], a, b: a + mm[1].length, check: false, read: `${m.f.read}: ${spaced(id)}`, readEs: `${m.f.readEs}: ${spaced(id)}`, replaceKey: m.f.type });
          expect = null;
        }
      }
    }

    // ── nombres (solo en respuestas, no en preguntas como "can I have your full name and date of birth?")
    const isQuestion = /\?/.test(n) || /^\s*(can|could|may|what|whats|what's|please|cual|como|me (puede|podria) dar|puede darme)\b/.test(n);
    for (const m of mentions) {
      if (!m.f.name || isQuestion) continue;
      const toks = tokenize(n.slice(m.b, m.b + 60));
      const ws = [];
      const tailN = n.slice(m.b, m.b + 60);
      for (const t of toks) {
        if (ws.length && /[,.;:!?]/.test(tailN.slice(ws[ws.length - 1].b, t.a))) break;
        if (!ws.length && /^(and|y|or|o|number|numero|date|fecha|address|direccion|phone|telefono)$/.test(t.w)) break;
        if (NAME_FIELD.has(t.w)) break;
        if (NAME_STOP.has(t.w) && !ws.length) continue;
        if (NAME_STOP.has(t.w) || isNumWord(t.w) || t.w.length < 2) break;
        ws.push(t); if (ws.length >= 3) break;
      }
      if (ws.length) {
        const a = m.b + ws[0].a, b = m.b + ws[ws.length - 1].b;
        add({ type: "name", label: "Name", value: cap(text.slice(ctx.map ? ctx.map[a] : a, ctx.map ? ctx.map[b] : b)), raw: n.slice(a, b), a, b, check: false, read: cap(n.slice(a, b)), note: "Ask to spell if unsure" });
        expect = { type: "name", until: now + 15000 };
      }
    }
    // letras deletreadas → nombre (si se esperaba) o identificador
    for (const sp of spelled(n)) {
      const t = expect && expect.type === "name" ? "name" : (expect && BY_TYPE[expect.type] && BY_TYPE[expect.type].id ? expect.type : "spelled");
      add({ type: t, label: t === "spelled" ? "Spelled" : BY_TYPE[t].label, value: t === "name" ? cap(sp.word) : sp.word.toUpperCase(), raw: n.slice(sp.a, sp.b), a: sp.a, b: sp.b, check: false, read: sp.word.toUpperCase().split("").join("-"), note: "Spelled out" });
    }

    // ── dirección
    for (const m of mentions) {
      if (!m.f.address) continue;
      const tail = n.slice(m.b).replace(/^\s*(is|es|:)?\s*/, "");
      const off = n.length - tail.length;
      const words = tokenize(tail).slice(0, 12);
      if (words.length >= 2 && words.some((w) => isNumWord(w.w))) {
        let endTok = words.length - 1;
        const zipIdx = words.findIndex((w) => /^\d{5}$/.test(w.w)); if (zipIdx >= 0) endTok = zipIdx;
        const a = off + words[0].a, b = off + words[endTok].b;
        // reemplaza números en palabras por cifras
        let val = n.slice(a, b);
        for (const g of numberGroups(val).reverse()) val = val.slice(0, g.a) + (g.value !== null && g.chunks.length === 1 ? g.value : g.digits) + val.slice(g.b);
        add({ type: "address", label: "Address", value: cap(val), raw: n.slice(a, b), a, b, check: true, note: "Confirm spelling of street and city", read: cap(val) });
      }
    }

    // ── correo
    for (const m of mentions) {
      if (!m.f.email) continue;
      let tail = n.slice(m.b, m.b + 80);
      const direct = tail.match(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/);
      let val = null;
      if (direct) val = direct[0];
      else {
        const t2 = tail.replace(/\b(arroba| at )\b/g, " @ ").replace(/\b(punto|dot)\b/g, " . ").replace(/\b(guion bajo|underscore)\b/g, " _ ").replace(/\b(guion|dash)\b/g, " - ");
        const mm = t2.match(/(?:is|es)?\s*([a-z0-9 ._-]+?)\s*@\s*([a-z0-9 .-]+?\.\s*(?:com|net|org|edu|gov|mx|es|us))\b/);
        if (mm) val = (mm[1].replace(/\s+/g, "") + "@" + mm[2].replace(/\s+/g, "")).replace(/^(is|es)/, "");
      }
      if (val) add({ type: "email", label: "Email", value: val, raw: val, check: !direct, note: direct ? "" : "Built from spoken words — confirm", read: val });
    }

    // si se mencionó un campo y no llegó su dato, se espera en las siguientes frases
    const lastMention = mentions.filter((m) => !items.some((it) => it.type === m.f.type)).pop();
    if (lastMention && !lastMention.f.address && !lastMention.f.email) expect = { type: lastMention.f.type, until: now + 20000, digits: "" };

    return { items, spans, expect };
  }

  function spaced(d) { return String(d).split("").join(" "); }
  function formatDigits(type, d) {
    const L = d.length;
    if (type === "ssn" && L === 9) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
    if (type === "phone" && L === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    if (type === "phone" && L === 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
    if (type === "card" && L >= 13) return d.replace(/(\d{4})(?=\d)/g, "$1 ");
    if (L === 4 && (type === "ssn" || type === "card" || type === "account")) return `•••• ${d}`;
    return d.replace(/(\d{4})(?=\d{3})/g, "$1 ");
  }
  function mask(type, value) {
    const d = value.replace(/\D/g, "");
    if (d.length <= 4) return value;
    return value.replace(/\d(?=(?:\D*\d){4})/g, "•");
  }

  root.KeyInfo = { extract, numberGroups, findDates, fmtDate, mask, FIELDS };
})(typeof window !== "undefined" ? window : globalThis);
