# Inturpreneur

Asistente web para intérpretes y agentes telefónicos. Escucha la llamada, transcribe en vivo y, **sin IA ni API keys**:

- clasifica cada frase como **Médico / Legal / Bancario** y marca las **dudas**,
- resalta la **terminología** de tu glosario, con traducción y definición breve,
- propone **sugerencias de respuesta** (ES/EN) según lo que se dijo,
- muestra **tarjetas** listas para usar (introducción, aclaración, espera, cierre, médico, legal, bancario),
- detecta números, montos, fechas y horas para pasarlos a las **notas** con un clic.

Botones **Iniciar**, **Pausar/Reanudar** y **Terminar**. Atajos: `Alt+S`, `Alt+P`, `Alt+E`, `Alt+L` (cambiar ES ⇄ EN).

## Privacidad

- La transcripción y las notas viven **solo en memoria**. Al presionar **Terminar**, al cerrar o al recargar la pestaña se borran.
- La página tiene una política de seguridad (`connect-src 'none'`) que **le impide enviar datos a cualquier servidor**.
- Solo se guardan en el navegador tus preferencias (nombre, ID, idioma) y el glosario que importes, nunca contenido de llamadas.
- Nota honesta: el reconocimiento de voz lo hace el motor del navegador. En Chrome/Edge ese motor procesa el audio en los servidores de Google/Microsoft (es gratis y sin API key, pero no es 100 % local). Si tu Chrome es reciente, activa **⚙ → Reconocimiento en el dispositivo** para que el audio no salga del equipo.

## Navegador

Usa **Google Chrome o Microsoft Edge de escritorio**. Firefox no tiene reconocimiento de voz, y Safari/Brave funcionan de forma limitada.

## Fuente de audio

| Opción | Qué escucha | Notas |
|---|---|---|
| Micrófono predeterminado | El micrófono del sistema | Funciona en cualquier Chrome/Edge. |
| Audio del sistema / pestaña | Lo que suena en una pestaña o en toda la pantalla | Al compartir, marca **«Compartir audio»**. En Windows se puede capturar toda la pantalla con audio; en Mac solo audio de pestañas. Requiere un Chrome que acepte una pista de audio en el reconocimiento de voz. Si el tuyo no lo hace, la app te avisa y usa el micrófono. |
| Micrófono + sistema | Tu voz y la de la otra persona | Mezcla ambas fuentes. |

**Alternativa que siempre funciona para el audio del sistema:** instala un cable de audio virtual (por ejemplo VB-Audio Virtual Cable en Windows o BlackHole en Mac), envía el audio de la llamada ahí y elígelo como **micrófono predeterminado** del sistema. En Windows también sirve activar «Mezcla estéreo» y ponerla como dispositivo de entrada.

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
