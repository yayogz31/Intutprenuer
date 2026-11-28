# CLAUDE.md — Inturpreneur

Asistente para intérpretes telefónicos (inglés ⇄ español). Transcribe en vivo, traduce *meaning for meaning*, resalta datos clave, sugiere respuestas y muestra tarjetas y terminología.
Hoy es una página en GitHub Pages (`yayogz31/Intutprenuer`). La siguiente etapa es una **aplicación de escritorio para Windows** que reutiliza esta misma página como interfaz.

Responde siempre al usuario **en español**, claro y sin tecnicismos innecesarios. El usuario prueba en Windows 11 con Opera y no programa: explícale qué probar y cómo, paso a paso.

---

## 1. Reglas que no se negocian

Si una tarea parece pedir romper alguna de estas reglas, detente y pregunta.

1. **Privacidad total.** Ningún texto, audio ni dato de una llamada sale de la computadora del usuario: nada a servidores, bases de datos, analítica ni telemetría.
   - Al presionar **End**, todo el contenido de la llamada (transcripción, notas y datos clave) se borra por completo de la memoria. Nunca se guarda en `localStorage`, archivos, logs ni caché.
   - Solo se puede guardar la configuración del usuario: su vocabulario, sus tarjetas y sus preferencias.
2. **Gratis e ilimitado.** No uses API keys, servicios de pago ni nubes de IA. Todo corre local con modelos abiertos y con licencia que permita su uso gratuito.
3. **Una sola aplicación.** No crees versiones paralelas, "lite", demos ni proyectos de relleno.
   - Cada mejora corrige el código de la misma app.
   - El usuario no debe reinstalar ni volver a descargar modelos para recibir arreglos (ver §4).
4. **Ligera.** El instalador y el ejecutable deben pesar poco (meta: < 30 MB).
   - Los modelos se descargan **una sola vez** en el primer uso, con barra de progreso, y quedan en `%LOCALAPPDATA%\Inturpreneur\models`.
   - Nunca se meten los modelos dentro del ejecutable.
5. **La página sigue funcionando sola.** La app de escritorio se suma a la página; no la reemplaza. Lo que se mejore en la interfaz debe servir en ambas.
6. **Verificar antes de entregar.** Nada se entrega sin probarlo primero (ver §6). Reporta los resultados con honestidad, incluido lo que falló o no se pudo probar.

## 2. Preferencias del usuario sobre el resultado

- **Interfaz base en inglés.**
  - Columnas **Original → Translation**: a la izquierda lo dicho en cualquier idioma, a la derecha su traducción. Un selector permite volver a columnas fijas EN | ES.
  - Tarjetas en inglés con el español debajo, y vista "LEP · ES".
  - El español detectado se muestra como español: nunca "traducido" a inglés en la columna original.
- **Diseño inspirado en las aplicaciones de Google (Material 3).**
  - Limpio, mucho espacio en blanco, esquinas redondeadas, jerarquía clara y colores sobrios con un solo acento.
  - Íconos Material Symbols (Apache-2.0), incluidos en el repositorio y no por CDN.
  - Fuente Roboto o Inter incluida en el repositorio, o la fuente del sistema. Google Sans no tiene licencia libre: no la uses.
  - Modo claro y oscuro.
  - Debe verse **profesional y elegante**, nunca "chistosa". Todo comprensible a la primera.
- **Respuesta inmediata**, como Windows Live Captions: el texto aparece mientras se habla y las correcciones no deben romper el scroll ni recortar texto.
- **Su vocabulario manda** (`data/glosario.js`, lista del usuario en `GLOSARIO_RAW`). Ejemplos obligatorios:
  - comprehensive insurance ↔ seguro contra todo riesgo
  - adjuster ↔ perito de seguros
  - LEP se queda como "LEP"
  - project ≠ proxy
  - claim ≠ game
  - assessor ≠ accessor
  - Acrónimos como DMV o STD se reconocen aunque vengan deletreados.
- **Cuidado extremo con números, fechas, SSN, tarjetas, pólizas y nombres.** Nunca se pierden ni se inventan dígitos.
- **Alertas de prioridad:**
  - Sugerencia en rojo si el hablante en inglés pide datos personales al intérprete.
  - Detección de frases dirigidas al intérprete.
  - Prioridad de la llamada: Routine / Important / Urgent.

## 3. Estado actual (la página)

Archivos estáticos sin build. Hay que revisarlos antes de cambiar nada:

| Archivo | Qué hace |
|---|---|
| `index.html` | Estructura, diálogos (Settings, Card, Vocabulary) y CSP en meta. |
| `app.js` | Lógica principal: audio, VAD, Vosk, Auto EN/ES, refinamiento con Whisper, traducción, sugerencias, tarjetas, terminología, notas y wipe. |
| `ai-worker.js` | Whisper con transformers.js 3.8.1 (base q8 en CPU; small en GPU por WebGPU), LID propio y filtros de alucinación. |
| `keyinfo.js` | Números hablados EN/ES, fechas, SSN, last-4, read-backs, nombres. |
| `data/glosario.js` | `GLOSARIO_RAW` (lista del usuario, **no tocar sin permiso**), `GLOSARIO_EXTRA` y `TRADUCCIONES_PREFERIDAS`. |
| `data/reglas.js` | Reglas de sugerencias y frases dirigidas al intérprete. |
| `data/tarjetas.js` | Tarjetas: introducción, cierre, disclosures, etc. |
| `styles.css` | Tema actual, que se va a rediseñar a Material 3. |
| `sw.js`, `coi.js` | Service worker con COOP/COEP para WASM multihilo. |
| `vendor/` | vosk-browser 0.0.8, transformers.js y bergamot-translator 0.4.9. |
| `.github/workflows/modelos.yml` | Descarga modelos (Vosk small es/en, Whisper base/small, Bergamot esen/enes) y los guarda en `models/`. |

Claves de `localStorage`: `inturp.cfg`, `inturp.fixes`, `inturp.myterms`, `inturp.cards`, `inturp.cardOverrides`, `inturp.gloss` y `inturp.lastEs`.

**Límite conocido.** En el equipo del usuario Opera no expone WebGPU, así que Whisper corre como "base · CPU" y la precisión ronda el 85–87%. Ese techo del navegador es justamente lo que resuelve la app de escritorio.

**Conceptos que la app debe conservar.** Ya están probados y no hay que reinventarlos:
- Escritura inmediata con un modelo rápido y corrección posterior con uno preciso.
- `safeRefinement`: protege dígitos y palabras seguras y solo acepta corrección fonéticamente parecida.
- Reglas asimétricas de idioma.
- Unión de pedazos dentro de una misma fila.
- Scroll anclado.
- Marcas ZX para respetar los términos preferidos al traducir.
- Buscador tolerante a errores ("mortgag loan" → Mortgage loan).

## 4. Plan de la aplicación de escritorio

### Arquitectura

- **Interfaz.** La misma página, cargada en una ventana nativa (WebView2, que ya viene en Windows 11).
  - Carga la versión publicada en GitHub Pages, así **los arreglos de interfaz llegan solos** sin reinstalar.
  - Guarda una copia local de respaldo para funcionar sin internet.
  - Bajar el código de la página no envía ningún dato del usuario.
- **Núcleo nativo** pequeño, en Rust con **Tauri 2**:
  - Captura el **audio del sistema** con WASAPI loopback (sin "Stereo Mix" ni cables virtuales) y también el micrófono.
  - Reconocimiento con **whisper.cpp** (`whisper-rs`) con backend **Vulkan**, que funciona en la GTX 1650 Ti sin instalar CUDA. Respaldo en CPU.
    - Modelo principal: `ggml-large-v3-turbo-q5_0` (~550 MB) en GPU.
    - Modelo rápido para el texto inmediato: `ggml-base` o `small` q5.
    - Ambos se descargan una vez desde Hugging Face y se verifican con SHA-256.
  - Se comunica con la página por un WebSocket en `127.0.0.1` con un token aleatorio por arranque.
    - Así la misma página también usa el motor de escritorio desde Opera: opción de motor "Desktop app" en Settings.
    - Hay que agregar `ws://127.0.0.1:*` a `connect-src` de la CSP.
    - Nunca abrir puertos fuera de localhost.
- **Traducción.**
  - Primero Bergamot dentro de la página, como hoy.
  - Opcional después: un modelo más grande que corra local, como CTranslate2 o un opus-mt mejor. Solo si se mantiene ligero y gratuito.
- **Actualizaciones.** Toda la app es una sola instalación.
  - La interfaz se actualiza sola desde Pages.
  - El núcleo nativo, que casi no cambia, se actualiza en su lugar con el updater de Tauri, firmado y publicado en GitHub Releases.
  - Los modelos y la configuración se conservan. Nunca se piden descargas repetidas.
- **Build.** GitHub Actions con `windows-latest` genera el instalador (NSIS o MSI) y lo publica en Releases. El usuario no compila nada.

### Recursos del equipo del usuario

Windows 11, GTX 1650 Ti (4 GB VRAM), i5 y 32 GB de RAM.
- Mantener el uso de VRAM por debajo de unos 2.5 GB.
- Procesar por frases con VAD; nunca correr el modelo en bucle sobre silencio.
- Modo de bajo consumo cuando no hay voz.

### Sesiones planeadas (meta: 2 o 3)

1. **Núcleo funcional.** Tauri, captura loopback, whisper.cpp Vulkan, WebSocket y la opción "Desktop app" en la página. Builds en Actions y pruebas automáticas (§6).
2. **Ajustes reales.** Arreglos tras la prueba del usuario, mejor traducción y descarga de modelos pulida.
3. **Pulido.** Rediseño Material 3 completo, instalador, updater y textos.

## 5. Forma de trabajar

- Antes de construir algo grande, explica el plan en pocas líneas. Confirma con el usuario solo las decisiones que de verdad son suyas.
- No dejes cambios a medias. Cada ronda termina en un commit en `main` y un despliegue verificado de Pages (o un build de Actions en verde).
- Revisa la sintaxis de cada JS modificado antes de publicar. Para `ai-worker.js`, el truco es `node -e "import('./ai-worker.js')"`: el error "self is not defined" significa que el archivo está bien.
- Actualiza `README.md` (en español) cuando cambie algo que el usuario use.
- Junta muchos arreglos en una sola ronda. Pídele al usuario que reporte varios errores a la vez.
- Nunca borres ni reescribas la lista de vocabulario del usuario. Los términos nuevos van en `GLOSARIO_EXTRA`.
- Mensajes de commit en español, describiendo el cambio.

## 6. Verificación obligatoria antes de entregar

**Página.** Playwright con Chromium, incluido en el contenedor:
- Audio de prueba en inglés, en español y mezclado, con frases de seguros, banco, médico y legal, números, SSN, fechas y pausas largas.
- Medir WER y revisar que no se pierdan dígitos.
- Comprobar que la traducción respete los términos preferidos.
- Revisar la interfaz en 1280, 1440, 1920 y en un ancho de teléfono: sin desbordes y con el scroll estable.
- Confirmar que el wipe de **End** no deje nada en `localStorage`, IndexedDB ni en memoria accesible.

**Núcleo de escritorio**, antes de darle algo al usuario:
1. Compilar y probar el núcleo en Linux (CPU) dentro del contenedor, con los mismos audios y midiendo WER y latencia.
2. Conectar la página real por WebSocket con Playwright y verificar el flujo completo: Start → texto → corrección → traducción → End/wipe.
3. Compilar en GitHub Actions para Windows y correr una prueba de humo en CPU, porque el runner no tiene GPU: arranque, carga del modelo, transcripción de un WAV y cierre.
4. Solo después, el usuario prueba en su laptop con GPU. Analizamos juntos el resultado y su diagnóstico ("Copy diagnostics" en Settings) y decidimos qué mejorar.

Lo que no se pueda probar aquí (GPU real, loopback real de Windows) se le dice claramente al usuario como pendiente de su prueba.
