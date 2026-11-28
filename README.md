# Inturpreneur

Asistente web para intérpretes y agentes telefónicos. Escucha la llamada, transcribe en vivo y, **sin IA ni API keys**:

- clasifica cada frase como **Médico / Legal / Bancario** y marca las **dudas**,
- resalta la **terminología** de tu glosario, con traducción y definición breve,
- propone **sugerencias de respuesta** (ES/EN) según lo que se dijo,
- muestra **tarjetas** listas para usar (introducción, aclaración, espera, cierre, médico, legal, bancario),
- detecta números, montos, fechas y horas para pasarlos a las **notas** con un clic.

Botones **Iniciar**, **Pausar/Reanudar** y **Terminar**. Atajos: `Alt+S`, `Alt+P`, `Alt+E`, `Alt+L` (cambiar ES ⇄ EN).

## Interfaz en inglés y tarjetas para Provider / LEP

- La página está en **inglés**. Las tarjetas y sugerencias muestran el **inglés como texto principal** y el **español debajo**, como traducción.
- El selector **To Provider · EN / To LEP · ES** cambia el idioma principal de las tarjetas y sugerencias:
  - **To Provider:** inglés grande, español abajo (para lo que le dices al proveedor o agente).
  - **To LEP:** español grande, inglés abajo (las mismas tarjetas, dirigidas a la persona LEP).

## Preguntas frecuentes

**¿Se descarga algo en mi laptop?** No como un archivo en "Descargas". Los modelos (~250 MB) los guarda el **navegador** en su almacenamiento para este sitio, para funcionar sin internet. Se borran desde el candado de la barra de direcciones → *Configuración del sitio* → *Borrar datos*. Las llamadas nunca se guardan.

**¿Funciona igual en cualquier equipo?** La app elige sola un **perfil de rendimiento** (⚙ → *Performance*):

| Perfil | Para | Qué hace |
|---|---|---|
| **Lite** | equipos modestos (≤2 núcleos o ≤4 GB) | Solo el motor rápido + traducción; sin Whisper. Lo más ligero. |
| **Balanced** | la mayoría | Whisper solo revisa las frases dudosas (baja confianza o idioma dudoso). |
| **Max** | equipos potentes (≥8 núcleos) | Whisper revisa todas las frases y confirma el idioma en modo Auto. |

Si hay tarjeta de video compatible, Whisper la usa; si es débil, usa el procesador.

## Tarjetas editables

Pasa el cursor sobre cualquier tarjeta: **Edit** para cambiar su texto (también las que vienen con la app) y **×** para borrarla (las tuyas) u ocultarla (las de la app). En ⚙ → *Restore built-in cards* vuelves a las originales.

## El español ya no se convierte en inglés

Si el texto del motor rápido es claramente español (o inglés) y tenía buena confianza, Whisper no puede cambiarle el idioma. Si Whisper devuelve la frase en el otro idioma (es decir, la "tradujo"), esa corrección se descarta. Whisper solo corrige el idioma cuando está muy seguro o cuando el motor rápido tenía poca confianza.

## Vocabulary: la app aprende tus palabras

Botón **Vocabulary** (arriba, o en *Terminology*). Todo se guarda solo en tu navegador y se aplica automáticamente:

- **Fix transcription:** si la app oye mal una palabra, enséñale cómo es (*carrot her → character*, *three d → 3D*). Se corrige en las frases nuevas, en la corrección de Whisper y en las frases que ya están en pantalla. Atajo: selecciona la palabra mal escrita en la transcripción y pulsa **Fix** en esa fila.
- **Translate as:** tus traducciones preferidas (*adjuster → perito de seguros*), aplicadas a la traducción automática en ambos sentidos.

> ¿Se puede "entrenar" el modelo? Reentrenar los modelos de voz dentro del navegador no es viable. En su lugar, la app aprende de tus correcciones (Fix transcription) y de tus traducciones preferidas, que se aplican al instante y para siempre en ese navegador.

## Cuando le hablan al intérprete

Si la frase va dirigida al intérprete, se marca **To interpreter** y aparece primero la respuesta adecuada:

| Lo que dicen | Sugerencia |
|---|---|
| "Interpreter, what is your name / ID?" | *My name is {tu nombre}, interpreter ID {tu ID}.* (usa los datos de ⚙) |
| "Interpreter, are you there? / can you hear me?" | *Yes, the interpreter is on the line.* |
| "Tell her… / ask him… / dígale… / pregúntele…" | Recordatorio: hablar directamente con la persona, en primera persona |
| "What did she say?" | *The interpreter will repeat the last rendition.* |
| "Interpreter, can you explain…?" | No puede explicar ni opinar; interpreta la explicación |
| "Interpreter, please hold" | *The interpreter will remain on the line.* |
| "Thank you, interpreter" | Despedida del intérprete |

## Respuesta más rápida

La frase se cierra tras **0.45 s** de silencio (antes 0.7 s). Como los pedazos de una misma oración se unen solos, cerrar antes no corta las oraciones.

## Columnas: Original → Translation

Por defecto, **la columna izquierda muestra lo que se dijo** (en inglés o en español) y **la derecha su traducción**, sin importar la dirección. La columna de la traducción indica el idioma de destino (EN/ES). Con el selector **EN | ES** del encabezado puedes volver al modo de columnas fijas (inglés a la izquierda, español a la derecha).

## Whisper small en equipos con GPU

Si tu tarjeta de video es compatible (WebGPU con fp16) y pasa una prueba de velocidad, la corrección usa **Whisper small**, bastante más preciso que el estándar (sobre todo en español y en palabras comunes). Ejemplo con la misma grabación:

- Estándar: *"There are a driver crashed into my fender and I need a total truck."*
- Small: *"The other driver crashed into my fender, and I need a tow truck."*

La primera vez descarga ~330 MB (luego queda guardado). Si la GPU no es suficientemente rápida, se usa el modelo estándar automáticamente. Se puede desactivar en ⚙. Sus archivos se publican divididos en partes de menos de 100 MB (límite de GitHub) y el navegador los vuelve a unir.

## Pausas y precisión

- **Las pausas ya no cortan la información:** los pedazos de una misma oración separados por pausas cortas se unen en una sola fila, y la traducción se hace sobre la oración completa. No se unen si lo anterior era una pregunta o si lo nuevo empieza como respuesta ("yes", "no", "sí"…), para respetar los turnos.
- **No se descartan respuestas cortas** como "yes", "sí" o un número suelto.
- **Whisper ya no puede borrar información:** solo reemplaza una frase si conserva las palabras que el motor rápido entendió con seguridad y todos los dígitos. Las frases que son casi solo números (SSN, teléfono…) las deja al motor rápido, que dicta mejor los dígitos.
- **Control automático de volumen:** el audio bajo (por ejemplo, de una pestaña) se sube a un nivel estable antes de reconocerlo.
- **Con tarjeta de video**, Whisper revisa todas las frases.

## Novedades

- **Audio poco claro:** si el motor rápido no está seguro (ruido, música, otro idioma), la frase aparece atenuada como *Unclear audio* en lugar de mostrar texto sin sentido. Whisper la revisa y, si la entiende, la reemplaza por la frase correcta.
- **Idioma confirmado por Whisper:** en modo Auto, si el idioma es dudoso, Whisper detecta el idioma real de la frase y la mueve a la columna correcta.
- **My terms:** en *Terminology → + My term* agrega palabras con tu traducción preferida (p. ej. *adjuster → perito de seguros*). Se resaltan en la transcripción y **se aplican a la traducción automática** en ambos sentidos.
- **Alerta de datos personales:** si quien habla en inglés pide datos personales, aparece en rojo *Not allowed*: interpreta la pregunta al LEP; como intérprete no debes proporcionar ni confirmar datos personales.
- **Importancia de la llamada:** junto a *Live transcript* aparece **Routine / Important / Urgent**, según lo que se escucha (emergencias, fraude, accidentes, corte, datos sensibles…). Pasa el cursor para ver el motivo.

## Uso rápido

- **Transcripción estable:** si subes a leer, la transcripción no se mueve aunque sigan llegando frases o se corrijan otras. El botón **↓ Live** (o "↓ 5 new") te regresa al final.
- **Franja de contexto:** justo debajo de la línea en vivo aparecen los datos clave y términos más recientes, como subtítulos. Clic para copiar.
- **A− / A+:** tamaño de letra de la transcripción.
- **Secciones plegables:** clic en el título de cualquier sección (▾) para cerrarla o abrirla; el espacio libre se reparte entre las demás. La app recuerda cuáles cerraste.
- **Tarjetas:** categorías en una línea, con el número de tarjetas, y **Filter cards…** para buscar en todas.
- **¿Idioma equivocado?** Clic en la etiqueta **EN/ES** de una frase: se mueve de columna, se vuelve a traducir y Whisper la re-transcribe en el idioma correcto.
- **Corrección más rápida:** si tu computadora tiene una tarjeta de video compatible (WebGPU), Whisper la usa automáticamente (suele ser varias veces más rápido). Si no, o si la GPU resulta lenta, usa el procesador. Con mucho trabajo pendiente, se salta las frases que el motor rápido ya entendió con seguridad.

## Información clave (para tomar notas)

El panel **Key information** organiza automáticamente lo importante que se escucha. No reemplaza al intérprete; le facilita las notas:

- **Qué detecta:** nombre (y letras deletreadas), SSN, número de tarjeta (o últimos 4), CVV, cuenta, routing, teléfono, fecha de nacimiento y fechas, horas, montos, ZIP, póliza, reclamo, miembro, caso, placa, dirección y correo.
- **Entiende el contexto:** si alguien pregunta *"what's your social security number?"*, los números que se dicten después se guardan como SSN, aunque se dicten en partes ("one two three four five"… "six seven eight nine").
- **Números y fechas dichos con palabras** en inglés y español: "nine one seven five five five oh one two three" → (917) 555-0123; "doce de marzo de mil novecientos ochenta y cinco" → 12 Mar 1985.
- **Cuidado con números y fechas:** valida la cantidad de dígitos (SSN 9, teléfono 10, routing 9, tarjeta 15–16, ZIP 5) y las fechas. Si algo no cuadra, el dato se marca en rojo (⚠) y aparece la sugerencia de pedir que lo repitan. Cada dato muestra lo que se escuchó tal cual, para compararlo.
- **Read back:** para cada dato aparece una sugerencia lista para confirmarlo ("Just to confirm, your social security number is 1 2 3…?").
- En la transcripción, los datos clave se resaltan en amarillo.
- Botones por dato: 👁 mostrar (SSN y tarjeta van ocultos en pantalla), ⧉ copiar, ✎ a notas, ✓ confirmado, ✕ descartar. **→ Notes** pasa todo a las notas.
- Todo vive en memoria y se borra al presionar **End**.

## ¿Por qué depende de la velocidad de mi computadora?

La página se descarga de GitHub Pages, pero **todo el trabajo lo hace tu navegador, en tu computadora**: reconocer la voz (Vosk y Whisper), traducir (Bergamot) y analizar el texto. Nada se envía a un servidor. Por eso:

- **Más núcleos de procesador y un procesador más nuevo** = Whisper corrige las frases más rápido (usa hasta 4 núcleos).
- **8 GB de RAM o más** recomendados; los modelos ocupan unos 600 MB en memoria.
- Conecta la laptop a la corriente: el modo ahorro de batería frena el procesador.
- Chrome o Edge actualizados dan el mejor rendimiento.
- La transcripción rápida (Vosk) es ligera y funciona bien incluso en equipos modestos.

## Transcripción a dos columnas

La transcripción muestra **English a la izquierda y Español a la derecha**. Cada frase aparece en su columna y su traducción en la otra, en azul.

## Precisión: dos motores locales trabajando juntos

1. **Vosk (rápido):** muestra el texto al instante mientras se habla.
2. **Whisper base (preciso):** al cerrarse cada frase, la vuelve a transcribir y la corrige un momento después (marca ✓), con puntuación y mayúsculas. Corre en un hilo aparte y usa varios núcleos del procesador gracias a `sw.js`. La primera vez descarga unos 100 MB y luego queda guardado. Se puede apagar en ⚙.

Todo corre en tu equipo: sin API keys, sin tokens y sin enviar audio a ningún servidor.

## Traducción offline en cualquier navegador

- **Chrome 138+:** usa el traductor integrado de Chrome.
- **Cualquier otro navegador (Firefox, Safari, Edge, Brave…):** usa **Bergamot**, el motor de traducción offline de Firefox, incluido en la página (unos 42 MB la primera vez; unos 30 ms por frase después).

## Navegadores compatibles

| Función | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Transcripción rápida (Vosk) | ✅ | ✅ | ✅ (micrófono) |
| Transcripción precisa (Whisper) | ✅ | ✅ | ✅ |
| Audio de pestaña o sistema | ✅ | ✅ pestañas | ❌ (usa cable virtual) |
| Traducción en vivo | ✅ | ✅ (Bergamot) | ✅ (Bergamot) |

Modelos y librerías incluidos: Vosk (Apache-2.0), Whisper base vía transformers.js (MIT / Apache-2.0), Bergamot (MPL-2.0). La acción **"Modelos de voz"** los descarga a `models/`.

## Idioma y traducción

- **Auto (ES + EN):** escucha los dos idiomas a la vez y detecta el de cada frase (etiqueta ES/EN). No hay que cambiar nada a mano durante la llamada. Usa el motor local con los dos modelos cargados.
- **Traducción en vivo:** cada frase se traduce al otro idioma, y también mientras la persona sigue hablando. Se puede apagar en ⚙ Settings.
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
