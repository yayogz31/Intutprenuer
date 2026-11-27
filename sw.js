/* Service worker mínimo: agrega los encabezados de "aislamiento de origen" (COOP/COEP) que GitHub Pages no envía.
 * Con ellos el navegador permite usar varios núcleos del procesador (SharedArrayBuffer), y el modelo de
 * transcripción precisa corre 2–4 veces más rápido. No guarda ni intercepta datos: solo reenvía las peticiones
 * de este mismo sitio añadiendo esos encabezados. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
  e.respondWith(fetch(req).then((res) => {
    if (!res || res.status === 0 || res.type === "opaque") return res;
    const h = new Headers(res.headers);
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    h.set("Cross-Origin-Embedder-Policy", "require-corp");
    h.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch(() => fetch(req)));
});
