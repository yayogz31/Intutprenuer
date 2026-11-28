# Inturpreneur — aplicación de escritorio (Windows)

La app reemplaza a la página: misma interfaz, pero el audio y el reconocimiento de voz corren dentro de la app,
con la tarjeta gráfica. **Nada de la llamada sale de tu computadora** y al presionar **End** se borra todo.

## Instalar

1. Entra a la sección **Releases** del repositorio y descarga `Inturpreneur_x.y.z_x64-setup.exe`.
2. Ábrelo. Windows puede mostrar **"Windows protegió su PC"** (SmartScreen) porque el instalador todavía no
   está firmado: haz clic en **Más información → Ejecutar de todas formas**.
3. El instalador propone la carpeta `C:\Users\<tú>\AppData\Local\Inturpreneur`. Puedes elegir otra
   (por ejemplo `D:\Inturpreneur`). **Todo** queda en esa carpeta: la app, los modelos, tu configuración
   y la caché de la ventana.

## Primer uso

- Al abrir por primera vez, la app descarga **una sola vez** los motores de voz y traducción
  (~700 MB con GPU; ~300 MB sin GPU). Verás el progreso arriba. Después funciona sin internet.
- Elige la fuente de audio:
  - **System audio (what you hear)** — escucha lo que suena en tus audífonos o bocinas
    (la llamada). No necesitas "Stereo Mix" ni cables virtuales.
  - **Microphone** — solo tu micrófono.
  - **System audio + microphone** — ambos.
- **Start** (Alt+S) · **Pause / Resume** (Alt+P) · **End** (Alt+E, borra todo) · cambiar idioma (Alt+L).

## La tarjeta gráfica (GPU)

- Solo se usa mientras alguien habla durante una llamada; en silencio queda en ~0 %.
- Se libera al presionar **End**, o tras 3 minutos en **Pause**.
- **Settings → Free GPU now**: la libera al instante (la llamada sigue con el motor rápido).
- **Settings → Light mode**: usa un motor más pequeño en el procesador, para trabajar con Blender o Unity abiertos.

## Si algo falla

- **Settings → Copy diagnostics** copia un reporte técnico (modelos, tiempos, memoria, GPU).
  **No incluye nada de lo que se dijo en la llamada.** Pégalo en el chat para revisarlo juntos.
- **Settings → Storage** muestra cuánto ocupa cada cosa y tiene **Clean up**.

## Desinstalar

Desde **Configuración de Windows → Aplicaciones → Inturpreneur → Desinstalar**. Se borra todo
(app, modelos, caché). Solo te pregunta si quieres conservar tu vocabulario, tarjetas y preferencias.

---

## Para desarrollo

| Carpeta | Qué es |
|---|---|
| `core/` | Núcleo en Rust: audio (WASAPI loopback y micrófono), detector de voz, whisper.cpp (Vulkan / CPU), descarga de modelos con SHA-256. |
| `app/` | App Tauri 2: ventana, IPC sin puertos de red, protocolo `models://` de solo lectura, configuración en `config.json`. |
| `ui/` | Copia de la página adaptada al núcleo nativo (la página publicada no cambia). |
| `tests/` | Audios de prueba, `evaluar.mjs` (WER y dígitos), `e2e.cjs` (Playwright) y `bridge/` (puente **solo de prueba**). |

Pruebas en Linux (CPU):

```bash
cargo build --release -p inturp-core --example run_wav -p inturp-bridge
INTURP_HOME=<carpeta con models/> ./target/release/examples/run_wav tests/audio/en_seguros.wav auto > salida.jsonl
node tests/evaluar.mjs en_seguros salida.jsonl
node tests/e2e.cjs en_seguros
```

El build de Windows lo hace GitHub Actions (`.github/workflows/desktop.yml`): compila, instala con el
instalador real, transcribe un WAV, desinstala y revisa que no quede basura.
