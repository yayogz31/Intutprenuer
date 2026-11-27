/* Activa el aislamiento de origen (ver sw.js) para que el motor preciso use varios núcleos. Se recarga una sola vez. */
(() => {
  if (self.crossOriginIsolated || !("serviceWorker" in navigator) || !window.isSecureContext) return;
  let tried = false; try { tried = sessionStorage.getItem("coi-reload") === "1"; } catch { /* */ }
  navigator.serviceWorker.register("sw.js").then((reg) => {
    const reload = () => { if (tried) return; try { sessionStorage.setItem("coi-reload", "1"); } catch { /* */ } location.reload(); };
    if (navigator.serviceWorker.controller) reload();
    else navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
  }).catch(() => {});
})();
