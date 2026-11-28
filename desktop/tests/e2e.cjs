// Prueba de punta a punta (SOLO PRUEBAS): interfaz real + núcleo real a través del puente de prueba.
// Flujo: Start → texto inmediato → corrección → traducción → End/wipe. Vigila la red y mide memoria.
// Uso: node e2e.cjs <escenario> [carpeta_capturas]
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const name = process.argv[2] || "en_seguros";
const shots = process.argv[3] || path.join(__dirname, "..", "..", "..", "out");
const root = path.join(__dirname, "..");
const PORT = 8787 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { escenario: name, checks: {} };
const check = (k, ok, info) => { results.checks[k] = { ok: !!ok, ...(info !== undefined ? { info } : {}) }; console.log(`${ok ? "✔" : "✘"} ${k}${info !== undefined ? " — " + (typeof info === "string" ? info : JSON.stringify(info)) : ""}`); };

(async () => {
  const bridge = spawn(path.join(root, "target/release/inturp-bridge"), [String(PORT), path.join(root, "tests/audio", name + ".wav")], { env: { ...process.env, INTURP_HOME: process.env.INTURP_HOME || "/home/user/inthome" }, stdio: ["ignore", "ignore", "pipe"] });
  await sleep(800);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const requests = [];
  ctx.on("request", (r) => requests.push(r.url()));
  await ctx.addInitScript(() => {
    const call = (cmd, args) => fetch("/invoke/" + cmd, { method: "POST", body: JSON.stringify(args || {}) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.result; });
    window.__TAURI__ = { core: { invoke: call }, event: { listen: (n, cb) => { let next = 0; const loop = async () => { for (;;) { try { const r = await (await fetch("/poll?after=" + next)).json(); next = r.next; for (const ev of r.events) cb({ payload: ev }); } catch { await new Promise((z) => setTimeout(z, 300)); } } }; loop(); return Promise.resolve(() => {}); } } };
    window.__INTURP_BOOT = { cfg: {}, modelsBase: "/models/", version: "test" };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(BASE + "/");
  await page.waitForSelector("#btnStart:not([disabled])");
  await page.click("#btnStart");
  // texto inmediato: aparece mientras se habla
  const tFirst = Date.now();
  await page.waitForFunction(() => document.querySelector("#interim.on") || document.querySelector("#transcript .trow"), null, { timeout: 30000 }).catch(() => {});
  check("texto inmediato aparece mientras se habla", await page.$("#interim.on, #transcript .trow"), `${Date.now() - tFirst} ms desde Start`);
  const audioS = fs.statSync(path.join(root, "tests/audio", name + ".wav")).size / 32000;
  // espera el final del audio y las correcciones
  await sleep(audioS * 1000 + 2000);
  const rssCall = await page.evaluate(() => window.__TAURI__.core.invoke("test_rss"));
  await page.waitForFunction(() => !document.querySelector("#transcript .trow.refining"), null, { timeout: 120000 }).catch(() => {});
  await sleep(2500);
  const rows = await page.$$eval("#transcript .trow:not(.interim)", (rs) => rs.map((r) => ({ lang: r.querySelector(".lang") && r.querySelector(".lang").textContent, orig: (r.querySelector(".cell.orig") || r.querySelector(".unclear-text") || {}).textContent, xl: (r.querySelector(".cell.xl") || {}).textContent, refined: !!r.querySelector(".cell.orig.refined") })));
  results.rows = rows;
  check("filas en la transcripción", rows.length > 0, rows.length);
  check("todas las filas traducidas", rows.length && rows.every((r) => r.xl && r.xl.trim().length > 0), rows.map((r) => r.xl).join(" | "));
  check("alguna corrección del modelo preciso aplicada (✓)", rows.some((r) => r.refined), rows.filter((r) => r.refined).length + " filas");
  const allOrig = rows.map((r) => r.orig).join(" "), allXl = rows.map((r) => r.xl).join(" ");
  if (name === "en_seguros") {
    check("término preferido: adjuster → perito de seguros", /perito de seguros/i.test(allXl), allXl.match(/.{0,30}perit.{0,30}/i)?.[0]);
    check("término preferido: comprehensive insurance → seguro contra todo riesgo", /seguro contra todo riesgo/i.test(allXl));
    const keys = await page.$eval("#keys", (k) => k.textContent);
    check("datos clave: póliza 4578921 en Key info", /4578921|457\s?892\s?1/.test(keys.replace(/[•\s-]/g, "")) || /4578921/.test(keys.replace(/\D/g, "")), keys.slice(0, 200));
  }
  if (name === "mixto_banco") {
    check("columna original muestra el español en español", rows.some((r) => r.lang === "ES" && /reconozco|tarjeta|claro/i.test(r.orig)), rows.map((r) => r.lang + ":" + r.orig).join(" | "));
    check("inglés y español detectados", rows.some((r) => r.lang === "EN") && rows.some((r) => r.lang === "ES"));
  }
  await page.screenshot({ path: path.join(shots, `e2e_${name}_1440.png`) });
  // anchos de pantalla: sin desbordes horizontales
  for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(300);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`sin desborde horizontal a ${w}px`, over <= 1, `${over}px`);
    if (w === 390 || w === 1920) await page.screenshot({ path: path.join(shots, `e2e_${name}_${w}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // escribe una nota y termina: todo se borra
  await page.fill("#notes", "nota de prueba 123");
  page.once("dialog", (d) => d.accept());
  await page.click("#btnStop");
  await sleep(3000);
  const after = await page.evaluate(async () => ({
    rows: document.querySelectorAll("#transcript .trow").length,
    notes: document.querySelector("#notes").value,
    keys: document.querySelector("#keys").textContent,
    ls: localStorage.length, ss: sessionStorage.length,
    idb: indexedDB.databases ? (await indexedDB.databases()).length : 0,
    caches: self.caches ? (await caches.keys()).length : 0,
  }));
  check("End: transcripción, notas y datos clave borrados", after.rows === 0 && after.notes === "" && !/4578921/.test(after.keys), after);
  check("End: nada en localStorage / sessionStorage / IndexedDB / caché", after.ls === 0 && after.ss === 0 && after.idb === 0 && after.caches === 0);
  const saved = await page.evaluate(() => window.__TAURI__.core.invoke("test_saved_config"));
  const savedKeys = Object.keys(JSON.parse(saved || "{}"));
  const leaked = rows.some((r) => r.orig && r.orig.length > 12 && saved.includes(r.orig.slice(0, 12)));
  check("config.json solo con preferencias (sin texto de la llamada)", savedKeys.every((k) => /^inturp\.(cfg|fixes|myterms|cards|cardOverrides|gloss|lastEs)$/.test(k)) && !leaked, savedKeys);
  const rssEnd = await page.evaluate(() => window.__TAURI__.core.invoke("test_rss"));
  results.ram = { nucleo_durante_llamada_mb: rssCall, nucleo_tras_end_mb: rssEnd };
  check("memoria del núcleo tras End", rssEnd < 200, `${rssCall} MB en llamada → ${rssEnd} MB tras End`);
  const external = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith("data:") && !u.startsWith("blob:"));
  check("sin conexiones fuera de la app durante la llamada", external.length === 0, external.slice(0, 5));
  check("sin errores de JavaScript", errors.length === 0, errors.slice(0, 5));
  fs.writeFileSync(path.join(shots, `e2e_${name}.json`), JSON.stringify(results, null, 1));
  await browser.close();
  bridge.kill();
  const failed = Object.entries(results.checks).filter(([, v]) => !v.ok).map(([k]) => k);
  console.log(failed.length ? `FALLARON: ${failed.join("; ")}` : "TODO OK");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
