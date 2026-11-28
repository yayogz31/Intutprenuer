// SOLO PRUEBAS: reproduce en la interfaz real una secuencia de eventos grabada del núcleo (JSONL de run_wav),
// sin audio ni tiempos: sirve para depurar la lógica de filas, correcciones y datos clave.
// Uso: node replay.cjs <eventos.jsonl>
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ui = path.join(__dirname, "..", "ui");
const events = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((e) => ["final", "refined", "partial", "engine"].includes(e.type));
const srv = http.createServer((q, r) => { const f = path.join(ui, q.url === "/" ? "index.html" : q.url.split("?")[0]); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "Content-Type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html" }); r.end(b); }); }).listen(0, async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.addInitScript(() => { window.__cb = null; window.__TAURI__ = { core: { invoke: async (c) => (c === "models_ready" ? true : null) }, event: { listen: (n, cb) => { window.__cb = cb; return Promise.resolve(() => {}); } } }; window.__INTURP_BOOT = { cfg: { "inturp.cfg": { translate: false } } }; });
  await p.goto(`http://127.0.0.1:${srv.address().port}/`);
  await p.click("#btnStart"); await p.waitForTimeout(300);
  for (const e of events) await p.evaluate((ev) => window.__cb({ payload: ev }), e);
  await p.waitForTimeout(500);
  const rows = await p.$$eval("#transcript .trow", (rs) => rs.map((r) => (r.querySelector(".cell.orig") || r).textContent));
  const keys = await p.$$eval("#keys .key", (ks) => ks.map((k) => k.textContent.replace(/\s+/g, " ").trim()));
  console.log(JSON.stringify({ rows, keys, errs }, null, 1));
  await b.close(); srv.close();
});
