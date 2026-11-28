# CLAUDE.md — Inturpreneur

Asistente para intérpretes telefónicos (inglés ⇄ español). Transcribe en vivo, traduce *meaning for meaning*, resalta datos clave, sugiere respuestas y muestra tarjetas y terminología.
Hoy es una página en GitHub Pages (`yayogz31/Intutprenuer`). La siguiente etapa es una **aplicación de escritorio para Windows, interna y local, que reemplaza a la página**. El código de la página se reutiliza como interfaz, pero va **dentro** de la app.

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
5. **La app reemplaza a la página.** La app no carga nada de internet para funcionar: la interfaz va empaquetada dentro.
   - La única conexión permitida es la descarga única de los modelos y la búsqueda de actualizaciones, que se revisa al abrir la app o con "Check for updates" y siempre la instala el usuario.
   - Ninguna de las dos envía datos del usuario.
   - Cuando la app funcione bien, se retira la página de GitHub Pages, por decisión del usuario.
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

- **La app va en su propia carpeta `desktop/`, dentro de este mismo repositorio.**
  - La interfaz de la app es una **copia** de los archivos de la página, dentro de `desktop/ui/`, que se adapta ahí.
  - **No modificar la página publicada** (los archivos de la raíz, `data/`, `vendor/` y `models/`) mientras se hace la app, salvo que el usuario lo pida. Así la página sigue funcionando igual hasta que se retire.

- **Interfaz.** El código de la página (HTML, JS y CSS), **empaquetado dentro de la app** y mostrado en una ventana nativa (WebView2, que ya viene en Windows 11).
  - No se carga nada desde GitHub Pages ni desde otro sitio.
  - Sin service worker ni COOP/COEP: Tauri sirve los archivos localmente.
- **Núcleo nativo** pequeño, en Rust con **Tauri 2**:
  - Captura el **audio del sistema** con WASAPI loopback (sin "Stereo Mix" ni cables virtuales) y también el micrófono.
  - Reconocimiento con **whisper.cpp** (`whisper-rs`) con backend **Vulkan**, que funciona en la GTX 1650 Ti sin instalar CUDA. Respaldo en CPU.
    - Modelo principal: `ggml-large-v3-turbo-q5_0` (~550 MB) en GPU.
    - Modelo rápido para el texto inmediato: `ggml-base` o `small` q5.
    - Ambos se descargan una vez desde Hugging Face y se verifican con SHA-256.
  - Se comunica con la interfaz por el IPC interno de Tauri (eventos y comandos). **No abre puertos de red**, ni siquiera en localhost.
  - Los motores del navegador (Vosk WASM y Whisper con transformers.js) se quitan cuando el motor nativo los supere. No se mantienen dos caminos.
- **Traducción.**
  - Primero Bergamot dentro de la página, como hoy.
  - Opcional después: un modelo más grande que corra local, como CTranslate2 o un opus-mt mejor. Solo si se mantiene ligero y gratuito.
- **Actualizaciones.** Toda la app es una sola instalación y nunca hay "versiones" paralelas.
  - **Al abrir la app**, revisa una vez si hay una actualización en GitHub Releases. Esto solo descarga información; no envía datos del usuario.
    - Si hay una, muestra un aviso discreto: **"Update available — Update now / Later"**.
    - Nunca se actualiza sola ni durante una llamada; solo cuando el usuario acepta.
    - También existe el botón **Check for updates** en Settings.
  - El updater de Tauri, firmado, reemplaza la app en su mismo lugar.
  - Solo se baja la app, que es pequeña. Los modelos, el vocabulario, las tarjetas y la configuración se conservan.
  - Nunca se vuelven a descargar modelos.
  - No revisa en segundo plano: solo al abrir la app o con el botón.
- **Build.** GitHub Actions con `windows-latest` genera el instalador (NSIS o MSI) y lo publica en Releases. El usuario no compila nada.

### Cero basura en el disco (el usuario lo pidió)

- **Todo en una sola carpeta visible: `%LOCALAPPDATA%\Inturpreneur`.**
  - Ahí van la app, los modelos, la configuración y el perfil de WebView2 (`EBWebView`), dentro de esa misma carpeta.
  - Nada en `%APPDATA%` (Roaming), `ProgramData`, Documentos ni carpetas ocultas aparte.
  - Del sistema, solo la entrada de desinstalación de Windows y el acceso directo, que es lo normal.
- Lo único que queda en la laptop:
  1. La app instalada (~20–30 MB).
  2. Los modelos en `%LOCALAPPDATA%\Inturpreneur\models`.
  3. La configuración del usuario (vocabulario, tarjetas, preferencias), en un solo archivo pequeño.
- **Actualizaciones:** el instalador descargado va a una carpeta temporal y se **borra** al terminar.
  - Al arrancar, la app limpia cualquier resto de una actualización anterior. No quedan copias de versiones viejas.
  - **Prioridad principal del usuario: ninguna actualización deja archivos innecesarios.**
  - Verificarlo en cada build: en el runner de Windows, instalar la versión N, actualizar a N+1 y comparar las carpetas de la app, `%LOCALAPPDATA%` y `%TEMP%` antes y después. Solo puede cambiar la app misma.
  - Los modelos que dejen de usarse en una versión nueva se borran automáticamente.
- **Caché de WebView2:** desactivarla o limitarla al mínimo y borrarla al cerrar la app. Nunca contiene datos de llamadas.
- **Sin logs en disco.** El diagnóstico existe solo en memoria y el usuario lo copia si quiere.
- **Settings → Storage:** muestra cuánto ocupa cada cosa (app, modelos, configuración) y tiene un botón **Clean up**.
- **Desinstalar** borra todo, incluidos modelos, caché y configuración. Preguntar solo si conservar el vocabulario y las tarjetas.

### Recursos del equipo del usuario

Windows 11, GTX 1650 Ti (4 GB VRAM), i5 y 32 GB de RAM.
- **Meta de VRAM: ~1 GB, máximo 1.5 GB.** El usuario lo pidió explícitamente.
  - Modelo cuantizado (q5_0, o q4 si alcanza la precisión) y flash attention.
  - Un solo modelo cargado en la GPU; el modelo rápido va en CPU.
  - Contexto y lote mínimos.
  - Medirlo y reportar la cifra real.
- **Meta de RAM: < 1 GB en total durante la llamada**, sin contar la VRAM. Al presionar End, la memoria vuelve a cerca de 150 MB.
  - Ventana con WebView2: ~150 MB.
  - Modelo rápido en CPU: ~300 MB.
  - Traductor: ~200 MB.
  - Medirlo y reportar la cifra real.
- Procesar por frases con VAD; nunca correr el modelo en bucle sobre silencio.
- Modo de bajo consumo cuando no hay voz.
- **La GPU es del usuario fuera de las llamadas.** Practica con Blender y Unity en sus descansos.
  - La GPU solo trabaja mientras alguien habla durante una llamada activa; en silencio, ~0%.
  - Con **End**, o tras unos minutos en **Pause**, el modelo se descarga de la VRAM y la memoria queda libre por completo.
    - Al dar Start de nuevo se vuelve a cargar desde el disco, en unos segundos y sin internet.
  - Botón o menú **"Free GPU now"** para liberarla al instante.
  - Opción **"Light mode"**: modelo más pequeño o CPU, para usar la app mientras Blender o Unity está abierto.
  - Nada de procesos en segundo plano que usen la GPU cuando la app no está en llamada.
  - Prioridad de proceso normal o baja; nunca acaparar el equipo.

### Sesiones planeadas (meta: 2 o 3)

1. **Núcleo funcional.** Tauri, la interfaz empaquetada, captura loopback, whisper.cpp con Vulkan e IPC. Builds en Actions y pruebas automáticas (§6).
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
2. Probar la interfaz real conectada al núcleo y verificar el flujo completo: Start → texto → corrección → traducción → End/wipe. Para esta prueba, servir la interfaz con un puente de prueba temporal en el contenedor y manejarla con Playwright. Ese puente no forma parte de la app.
   - Además, confirmar con un monitor de red que la app no hace ninguna conexión durante una llamada.
3. Compilar en GitHub Actions para Windows y correr una prueba de humo en CPU, porque el runner no tiene GPU: arranque, carga del modelo, transcripción de un WAV y cierre.
4. Solo después, el usuario prueba en su laptop con GPU. Analizamos juntos el resultado y su diagnóstico ("Copy diagnostics" en Settings) y decidimos qué mejorar.

Lo que no se pueda probar aquí (GPU real, loopback real de Windows) se le dice claramente al usuario como pendiente de su prueba.
