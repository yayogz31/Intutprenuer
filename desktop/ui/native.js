/* Inturpreneur — puente con el núcleo nativo de la app (Tauri).
 * Todo pasa por el IPC interno de la ventana: no se abre ningún puerto ni se conecta a internet.
 * - Native.invoke(cmd, args): llama al núcleo (start, pause, end, …).
 * - Native.listen(fn): recibe los eventos del núcleo (texto inmediato, final, corrección, estado…).
 * - Configuración del usuario: se guarda en un solo archivo (config.json) dentro de la carpeta de la app.
 *   Nunca contiene texto de llamadas: solo preferencias, vocabulario y tarjetas.
 */
(function () {
  "use strict";
  const T = window.__TAURI__;
  const boot = window.__INTURP_BOOT || {};
  const cfg = Object.assign({}, boot.cfg || {});
  // solo estas claves se pueden guardar (preferencias, vocabulario y tarjetas)
  const ALLOWED = /^inturp\.(cfg|fixes|myterms|cards|cardOverrides|gloss|lastEs)$/;
  let saveT = null;
  function flush() {
    saveT = null;
    invoke("save_config", { data: JSON.stringify(cfg) }).catch(() => {});
  }
  function invoke(cmd, args) {
    if (!T || !T.core) return Promise.reject(new Error("NO_NATIVE"));
    return T.core.invoke(cmd, args || {});
  }
  window.Native = {
    available: !!(T && T.core),
    version: boot.version || "",
    invoke,
    listen(fn) {
      if (T && T.event) T.event.listen("core", (e) => fn(e.payload));
    },
    /** URL de un archivo de la carpeta de modelos (solo lectura, servido por la app). */
    modelUrl(path) {
      return (boot.modelsBase || "models://localhost/") + path;
    },
    store: {
      get(k, d) {
        const v = cfg[k];
        return v === undefined ? d : JSON.parse(JSON.stringify(v));
      },
      set(k, v) {
        if (!ALLOWED.test(k)) return;
        cfg[k] = JSON.parse(JSON.stringify(v));
        clearTimeout(saveT);
        saveT = setTimeout(flush, 400);
      },
      del(k) {
        if (!(k in cfg)) return;
        delete cfg[k];
        clearTimeout(saveT);
        saveT = setTimeout(flush, 400);
      },
    },
  };
  window.addEventListener("beforeunload", () => { if (saveT) { clearTimeout(saveT); flush(); } });
})();
