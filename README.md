# Inturpreneur

Asistente web para intérpretes y agentes telefónicos. Escucha la llamada, transcribe en vivo y, **sin IA ni API keys**:

- clasifica cada frase como **Médico / Legal / Bancario** y marca las **dudas**,
- resalta la **terminología** de tu glosario, con traducción y definición breve,
- propone **sugerencias de respuesta** (ES/EN) según lo que se dijo,
- muestra **tarjetas** listas para usar (introducción, aclaración, espera, cierre, médico, legal, bancario),
- detecta números, montos, fechas y horas para pasarlos a las **notas** con un clic.

Botones **Iniciar**, **Pausar/Reanudar** y **Terminar**. Atajos: `Alt+S`, `Alt+P`, `Alt+E`, `Alt+L` (cambiar ES ⇄ EN).

## Idioma y traducción

- **Auto (ES + EN):** escucha los dos idiomas a la vez y detecta el de cada frase (etiqueta ES/EN). No hay que cambiar nada a mano durante la llamada. Usa el motor local con los dos modelos cargados.
- **Traducción en vivo:** cada frase se traduce al otro idioma, y también mientras la persona sigue hablando. Usa el **traductor integrado de Google Chrome 138 o más reciente** (escritorio), que corre en tu equipo, sin internet ni API keys. La primera vez Chrome descarga su modelo de traducción. Se puede apagar en ⚙ Ajustes. En otros navegadores no hay traducción, pero las sugerencias y tarjetas siguen siendo bilingües.
- **ES ⇄ EN** (`Alt+L`) cambia entre Español → Inglés → Auto.

## Motores de voz

| Motor | Ventajas | Notas |
|---|---|---|
| **Local (sin internet)** *(predeterminado)* | El audio nunca sale de tu equipo. Escucha **cualquier fuente**: micrófono, una pestaña (YouTube, Zoom web, softphone) o toda la pantalla con audio. Permite el modo Auto ES + EN. | Usa [Vosk](https://alphacephei.com/vosk/) (WebAssembly, Apache-2.0). La primera vez descarga ~40 MB por idioma y luego queda guardado en el navegador. Cierra cada frase tras ~0.5 s de silencio. Es menos preciso que el de Google y escribe los números con letra. |
| **Navegador (en línea)** | Muy preciso, con puntuación. | Solo Chrome o Edge, y envía el audio a Google o Microsoft. **Si da error de red o no puede oír la fuente, la app cambia sola al motor local** sin detener la llamada. |

Los modelos del motor local los descarga la acción **"Modelos de voz"** (`.github/workflows/modelos.yml`) en `models/`.

## Tarjetas, disclosures y sugerencias por caso

- La pestaña **Disclosures** trae avisos de grabación, confidencialidad, "todo se interpreta", sin opiniones, sin asesoría legal, HIPAA, Mini-Miranda de cobranza, declaración grabada, autorización de tercero, verificación de identidad, 911 y tercero que se une.
- Las tarjetas pueden tener **palabras clave**. Cuando se escuchan en la llamada, la tarjeta aparece sola en **Sugerencias** (los disclosures, primero).
- **+ Tarjeta** agrega tus propias tarjetas (categoría, título, español, inglés, palabras clave), una por una o varias a la vez en CSV:
  `categoría;título;español;inglés;clave1|clave2`. Se guardan solo en tu navegador y se borran con la ×.
- Para que sean de todos los usuarios, agrégalas en `data/tarjetas.js`.

## Fuente de audio

- **Micrófono predeterminado:** tu micrófono.
- **Pestaña / audio del sistema:** al compartir, elige la pestaña (por ejemplo YouTube) y activa **"Compartir audio de la pestaña"**. En Windows también puedes elegir "Toda la pantalla" con "Compartir audio del sistema". En Mac solo se comparte el audio de pestañas.
- **Micrófono + sistema:** tu voz y la de la otra persona, mezcladas.

## Privacidad

- La transcripción y las notas viven **solo en memoria**. Se borran al presionar **Terminar** o al cerrar o recargar la pestaña.
- La política de seguridad de la página (`connect-src 'self'`) **le impide enviar datos a cualquier otro servidor**. Solo puede descargar archivos de su propio sitio (el modelo de voz).
- En el navegador solo se guardan tus preferencias, el glosario que importes y el modelo de voz, nunca contenido de llamadas.

## Navegador

Chrome o Edge de escritorio son los recomendados. Con el motor local también funciona en Firefox para micrófono y pestañas.

## Tu vocabulario

En **⚙ Ajustes → Glosario** puedes importar un CSV (o pegar las filas):

```
termino;traduccion;definicion;dominio
copago;copay;Monto fijo que paga el paciente;medico
fianza;bail;Garantía para obtener libertad;legal
```

Acepta coma, punto y coma o tabulador, con o sin encabezado. También puedes editar directamente `data/glosario.js`, `data/tarjetas.js` y `data/reglas.js`.

## Probar sin audio

Escribe una frase en la caja de abajo de la transcripción y presiona Enter.

## Publicar en GitHub Pages

1. Sube estos archivos a la rama `main` del repositorio.
2. En **Settings → Pages**, elige *Deploy from a branch*, rama `main`, carpeta `/ (root)`.
3. La app queda en `https://yayogz31.github.io/Intutprenuer/`. GitHub Pages usa HTTPS, que es necesario para el micrófono.

Para usarla en local: `python3 -m http.server` en esta carpeta y abre `http://localhost:8000`.
