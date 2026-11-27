/*
 * REGLAS DE SUGERENCIAS (sin IA): si la frase coincide con "re", se muestran sus sugerencias.
 * Las expresiones se evalúan sobre el texto en minúsculas y SIN acentos.
 * dom: "medico" | "legal" | "bancario" | "duda" | "general"
 */
window.REGLAS = [
  // ── Dudas / no entiende ──
  { dom: "duda", re: /\b(no entiendo|no entendi|no le entiendo|que significa|que quiere decir|i don'?t understand|what does .* mean|what do you mean)\b/,
    s: [{ es: "Con gusto se lo explico de otra manera.", en: "Let me explain that in a different way." },
        { es: "El intérprete solicita una aclaración del término.", en: "The interpreter requests clarification of the term." }] },
  { dom: "duda", re: /\b(puede repetir|podria repetir|repita|otra vez|can you repeat|could you repeat|say that again|pardon)\b/,
    s: [{ es: "Claro, lo repito.", en: "Of course, I'll repeat that." }] },
  { dom: "duda", re: /\b(tengo una (duda|pregunta)|una pregunta|i have a question|quick question)\b/,
    s: [{ es: "Claro, adelante con su pregunta.", en: "Sure, go ahead with your question." }] },

  // ── Médico ──
  { dom: "medico", re: /\b(dolor|duele|pain|hurts?|ache)\b/,
    s: [{ es: "¿Desde cuándo tiene el dolor y dónde lo siente exactamente?", en: "Since when have you had the pain, and where exactly do you feel it?" },
        { es: "Del 1 al 10, ¿qué tan fuerte es el dolor?", en: "From 1 to 10, how strong is the pain?" }] },
  { dom: "medico", re: /\b(medicamento|medicina|pastilla|receta|medication|medicine|pills?|prescription|refill)\b/,
    s: [{ es: "¿Cuál es el nombre del medicamento y la dosis?", en: "What is the name of the medication and the dose?" },
        { es: "¿Con qué frecuencia lo toma?", en: "How often do you take it?" }] },
  { dom: "medico", re: /\b(cita|appointment|agendar|programar|schedule|reschedule)\b/,
    s: [{ es: "¿Qué día y horario le queda mejor?", en: "What day and time works best for you?" }] },
  { dom: "medico", re: /\b(alergi\w*|allerg\w*)\b/,
    s: [{ es: "¿Qué tipo de reacción tuvo?", en: "What kind of reaction did you have?" }] },
  { dom: "medico", prio: 2, re: /\b(no puedo respirar|falta de aire|dolor de pecho|chest pain|can'?t breathe|desmay\w*|sangrado|bleeding)\b/,
    s: [{ es: "Esto puede ser una emergencia: llame al 911 de inmediato.", en: "This may be an emergency: call 911 immediately." }] },
  { dom: "medico", re: /\b(seguro|insurance|medicaid|medicare|copago|copay|deducible|deductible)\b/,
    s: [{ es: "¿Me puede dar el nombre de su aseguradora y el número de miembro?", en: "Can you give me your insurance name and member ID?" }] },

  // ── Legal ──
  { dom: "legal", re: /\b(audiencia|corte|tribunal|hearing|court)\b/,
    s: [{ es: "¿Tiene la fecha y el número de caso a la mano?", en: "Do you have the date and case number handy?" }] },
  { dom: "legal", re: /\b(abogad\w*|lawyer|attorney)\b/,
    s: [{ es: "¿Ya cuenta con un abogado o necesita información para conseguir uno?", en: "Do you already have an attorney, or do you need information to find one?" }] },
  { dom: "legal", re: /\b(firm\w*|sign\w*|documento|document|contrato|contract)\b/,
    s: [{ es: "Antes de firmar, ¿le gustaría que se le lea o explique el documento?", en: "Before signing, would you like the document read or explained to you?" }] },
  { dom: "legal", re: /\b(arrest\w*|detenid\w*|policia|police|cargos|charges)\b/,
    s: [{ es: "Usted tiene derecho a guardar silencio y a un abogado.", en: "You have the right to remain silent and to an attorney." }] },

  // ── Bancario ──
  { dom: "bancario", prio: 1, re: /\b(no reconozco|cargo no reconocido|fraude|fraud|unauthorized|no hice (esa|ese) (compra|cargo)|didn'?t make)\b/,
    s: [{ es: "Lamento la situación. ¿Me confirma la fecha, monto y comercio del cargo?", en: "I'm sorry about that. Can you confirm the date, amount and merchant of the charge?" },
        { es: "Por seguridad, ¿desea que bloqueemos la tarjeta ahora?", en: "For security, would you like us to block the card now?" }] },
  { dom: "bancario", re: /\b(perdi|robaron|extravi\w*|lost|stolen)\b.*\b(tarjeta|card|cartera|wallet)\b/,
    s: [{ es: "Bloquearemos la tarjeta de inmediato y le enviaremos una nueva.", en: "We'll block the card right away and send you a new one." }] },
  { dom: "bancario", re: /\b(saldo|balance|cuanto debo|how much do i owe)\b/,
    s: [{ es: "Con gusto le confirmo su saldo. ¿Me verifica los últimos 4 dígitos de la cuenta?", en: "I'll gladly confirm your balance. Can you verify the last 4 digits of the account?" }] },
  { dom: "bancario", re: /\b(pago|pagar|payment|pay|due)\b/,
    s: [{ es: "¿Desea hacer el pago ahora o programarlo para otra fecha?", en: "Would you like to make the payment now or schedule it for another date?" }] },
  { dom: "bancario", re: /\b(comision|cobraron|fee|charged)\b/,
    s: [{ es: "Déjeme revisar el motivo de la comisión y si es posible un reembolso.", en: "Let me review the reason for the fee and whether a refund is possible." }] },
  { dom: "bancario", re: /\b(prestamo|credito|loan|hipoteca|mortgage)\b/,
    s: [{ es: "¿Para qué monto y plazo le interesa el préstamo?", en: "What amount and term are you interested in for the loan?" }] },

  // ── General ──
  { dom: "general", re: /\b(gracias|thank you|thanks)\b/,
    s: [{ es: "Con mucho gusto. ¿Hay algo más en lo que le pueda ayudar?", en: "You're very welcome. Is there anything else I can help you with?" }] },
  { dom: "general", re: /\b(queja|molest\w*|enojad\w*|complaint|upset|angry|frustrat\w*)\b/,
    s: [{ es: "Entiendo su frustración y lamento lo ocurrido. Vamos a resolverlo.", en: "I understand your frustration and I'm sorry. Let's get this resolved." }] },
  { dom: "general", re: /\b(supervisor|gerente|manager)\b/,
    s: [{ es: "Entiendo. Permítame comunicarle con un supervisor.", en: "I understand. Let me connect you with a supervisor." }] },
  { dom: "general", re: /\b(adios|hasta luego|bye|goodbye)\b/,
    s: [{ es: "Gracias por su llamada, que tenga un excelente día.", en: "Thank you for your call, have a great day." }] },
];

/* Sugerencias por defecto cuando no hay coincidencias, según el dominio dominante de la llamada. */
window.SUGERENCIAS_DEFECTO = {
  general: [{ es: "¿Me puede dar un poco más de detalle?", en: "Could you give me a bit more detail?" }],
  medico: [{ es: "¿Tiene algún otro síntoma?", en: "Do you have any other symptoms?" }],
  legal: [{ es: "¿Tiene algún documento o número de caso relacionado?", en: "Do you have any related document or case number?" }],
  bancario: [{ es: "¿Me confirma los últimos 4 dígitos de la cuenta o tarjeta?", en: "Can you confirm the last 4 digits of the account or card?" }],
};
