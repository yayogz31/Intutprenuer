/*
 * GLOSARIO BASE — reemplázalo o amplíalo con tu lista de vocabulario.
 * Formato de cada entrada:
 *   t   = término (idioma A, p. ej. español)
 *   tr  = traducción / equivalente (idioma B, p. ej. inglés)
 *   d   = definición breve
 *   dom = dominio: "medico" | "legal" | "bancario" | "general"
 * También puedes importar un CSV desde la app (⚙ Ajustes) sin tocar este archivo.
 */
window.GLOSARIO_BASE = [
  // ───────── MÉDICO ─────────
  { t: "presión arterial", tr: "blood pressure", d: "Fuerza que ejerce la sangre contra las paredes de las arterias.", dom: "medico" },
  { t: "hipertensión", tr: "hypertension", d: "Presión arterial alta de forma persistente.", dom: "medico" },
  { t: "diabetes", tr: "diabetes", d: "Enfermedad en la que el nivel de azúcar (glucosa) en sangre está elevado.", dom: "medico" },
  { t: "glucosa", tr: "glucose", d: "Azúcar en la sangre; principal fuente de energía del cuerpo.", dom: "medico" },
  { t: "receta médica", tr: "prescription", d: "Orden escrita del médico para surtir un medicamento.", dom: "medico" },
  { t: "dosis", tr: "dose", d: "Cantidad de medicamento que se toma en una sola vez.", dom: "medico" },
  { t: "efectos secundarios", tr: "side effects", d: "Reacciones no deseadas causadas por un medicamento.", dom: "medico" },
  { t: "alergia", tr: "allergy", d: "Reacción del sistema inmune a una sustancia (alimento, medicamento, polen).", dom: "medico" },
  { t: "análisis de sangre", tr: "blood test", d: "Estudio de laboratorio de una muestra de sangre.", dom: "medico" },
  { t: "radiografía", tr: "x-ray", d: "Imagen del interior del cuerpo obtenida con rayos X.", dom: "medico" },
  { t: "resonancia magnética", tr: "mri", d: "Estudio de imagen con campos magnéticos (MRI).", dom: "medico" },
  { t: "tomografía", tr: "ct scan", d: "Estudio de imagen por cortes con rayos X (CT/TAC).", dom: "medico" },
  { t: "sala de emergencias", tr: "emergency room", d: "Área del hospital para atención urgente (ER).", dom: "medico" },
  { t: "médico de cabecera", tr: "primary care physician", d: "Médico general que da seguimiento habitual al paciente (PCP).", dom: "medico" },
  { t: "especialista", tr: "specialist", d: "Médico con formación en un área específica.", dom: "medico" },
  { t: "referido", tr: "referral", d: "Autorización/envío de un médico a otro especialista.", dom: "medico" },
  { t: "copago", tr: "copay", d: "Cantidad fija que paga el paciente por un servicio cubierto.", dom: "medico" },
  { t: "deducible", tr: "deductible", d: "Monto que el asegurado paga antes de que el seguro empiece a cubrir.", dom: "medico" },
  { t: "historial médico", tr: "medical history", d: "Registro de enfermedades, tratamientos y antecedentes del paciente.", dom: "medico" },
  { t: "síntomas", tr: "symptoms", d: "Lo que el paciente siente o nota (dolor, fiebre, mareo…).", dom: "medico" },
  { t: "fiebre", tr: "fever", d: "Temperatura corporal por encima de lo normal.", dom: "medico" },
  { t: "mareo", tr: "dizziness", d: "Sensación de inestabilidad o de que todo gira.", dom: "medico" },
  { t: "náuseas", tr: "nausea", d: "Sensación de ganas de vomitar.", dom: "medico" },
  { t: "falta de aire", tr: "shortness of breath", d: "Dificultad para respirar.", dom: "medico" },
  { t: "consentimiento informado", tr: "informed consent", d: "Autorización del paciente tras recibir explicación de un procedimiento.", dom: "medico" },
  { t: "cirugía", tr: "surgery", d: "Procedimiento quirúrgico.", dom: "medico" },
  { t: "anestesia", tr: "anesthesia", d: "Medicamento que elimina el dolor o la conciencia durante un procedimiento.", dom: "medico" },
  { t: "farmacia", tr: "pharmacy", d: "Lugar donde se surten medicamentos.", dom: "medico" },
  { t: "cita", tr: "appointment", d: "Fecha y hora reservada para una consulta.", dom: "general" },
  { t: "embarazo", tr: "pregnancy", d: "Estado de gestación.", dom: "medico" },
  { t: "inflamación", tr: "swelling", d: "Aumento de volumen de una zona del cuerpo.", dom: "medico" },

  // ───────── LEGAL ─────────
  { t: "abogado", tr: "attorney", d: "Profesional que representa y asesora legalmente.", dom: "legal" },
  { t: "demanda", tr: "lawsuit", d: "Acción legal presentada ante un tribunal.", dom: "legal" },
  { t: "demandante", tr: "plaintiff", d: "Persona que presenta la demanda.", dom: "legal" },
  { t: "demandado", tr: "defendant", d: "Persona contra quien se presenta la demanda o acusación.", dom: "legal" },
  { t: "audiencia", tr: "hearing", d: "Sesión ante un juez para tratar un caso.", dom: "legal" },
  { t: "juez", tr: "judge", d: "Autoridad que dirige el proceso y dicta resoluciones.", dom: "legal" },
  { t: "tribunal", tr: "court", d: "Órgano judicial donde se resuelven los casos.", dom: "legal" },
  { t: "fianza", tr: "bail", d: "Dinero o garantía para obtener libertad mientras sigue el proceso.", dom: "legal" },
  { t: "declaración jurada", tr: "affidavit", d: "Declaración por escrito hecha bajo juramento.", dom: "legal" },
  { t: "testigo", tr: "witness", d: "Persona que declara sobre hechos que conoce.", dom: "legal" },
  { t: "citatorio", tr: "subpoena", d: "Orden para comparecer o entregar documentos.", dom: "legal" },
  { t: "orden de restricción", tr: "restraining order", d: "Orden judicial que prohíbe acercarse o contactar a alguien.", dom: "legal" },
  { t: "custodia", tr: "custody", d: "Responsabilidad legal sobre un menor.", dom: "legal" },
  { t: "manutención", tr: "child support", d: "Pago para cubrir gastos de los hijos.", dom: "legal" },
  { t: "divorcio", tr: "divorce", d: "Disolución legal del matrimonio.", dom: "legal" },
  { t: "contrato", tr: "contract", d: "Acuerdo legal entre partes con obligaciones.", dom: "legal" },
  { t: "poder notarial", tr: "power of attorney", d: "Documento que autoriza a alguien a actuar en nombre de otro.", dom: "legal" },
  { t: "declararse culpable", tr: "plead guilty", d: "Aceptar formalmente la responsabilidad de un cargo.", dom: "legal" },
  { t: "inocente", tr: "not guilty", d: "Declaración de no culpabilidad.", dom: "legal" },
  { t: "libertad condicional", tr: "probation", d: "Cumplimiento de condena en libertad bajo condiciones.", dom: "legal" },
  { t: "sentencia", tr: "sentence", d: "Resolución del juez que pone fin al caso o fija la pena.", dom: "legal" },
  { t: "acuerdo", tr: "settlement", d: "Arreglo entre las partes para terminar un litigio.", dom: "legal" },
  { t: "asilo", tr: "asylum", d: "Protección otorgada a quien huye de persecución.", dom: "legal" },
  { t: "inmigración", tr: "immigration", d: "Trámites y leyes sobre ingreso y estancia en un país.", dom: "legal" },
  { t: "cargos", tr: "charges", d: "Acusaciones formales contra una persona.", dom: "legal" },
  { t: "arresto", tr: "arrest", d: "Detención por parte de la autoridad.", dom: "legal" },
  { t: "comparecer", tr: "appear in court", d: "Presentarse ante el tribunal.", dom: "legal" },

  // ───────── BANCARIO ─────────
  { t: "cuenta de cheques", tr: "checking account", d: "Cuenta para uso diario con tarjeta de débito y cheques.", dom: "bancario" },
  { t: "cuenta de ahorros", tr: "savings account", d: "Cuenta que genera intereses, para guardar dinero.", dom: "bancario" },
  { t: "saldo", tr: "balance", d: "Cantidad de dinero disponible o adeudada en una cuenta.", dom: "bancario" },
  { t: "estado de cuenta", tr: "statement", d: "Resumen periódico de movimientos de la cuenta.", dom: "bancario" },
  { t: "transferencia", tr: "wire transfer", d: "Envío de dinero de una cuenta a otra.", dom: "bancario" },
  { t: "depósito", tr: "deposit", d: "Ingreso de dinero a una cuenta.", dom: "bancario" },
  { t: "retiro", tr: "withdrawal", d: "Salida de dinero de una cuenta.", dom: "bancario" },
  { t: "sobregiro", tr: "overdraft", d: "Gastar más de lo disponible en la cuenta.", dom: "bancario" },
  { t: "tarjeta de crédito", tr: "credit card", d: "Tarjeta que permite comprar con dinero prestado por el banco.", dom: "bancario" },
  { t: "tarjeta de débito", tr: "debit card", d: "Tarjeta que usa el dinero de tu cuenta directamente.", dom: "bancario" },
  { t: "cargo no reconocido", tr: "unauthorized charge", d: "Cobro que el titular no realizó ni autorizó.", dom: "bancario" },
  { t: "fraude", tr: "fraud", d: "Uso engañoso o no autorizado de la cuenta o tarjeta.", dom: "bancario" },
  { t: "disputa", tr: "dispute", d: "Reclamación formal de un cargo.", dom: "bancario" },
  { t: "tasa de interés", tr: "interest rate", d: "Porcentaje que se cobra o paga por el dinero prestado/ahorrado.", dom: "bancario" },
  { t: "préstamo", tr: "loan", d: "Dinero prestado que se devuelve con intereses.", dom: "bancario" },
  { t: "hipoteca", tr: "mortgage", d: "Préstamo para comprar una propiedad, con la propiedad como garantía.", dom: "bancario" },
  { t: "pago mínimo", tr: "minimum payment", d: "Cantidad mínima a pagar para mantener la cuenta al corriente.", dom: "bancario" },
  { t: "fecha de corte", tr: "statement closing date", d: "Día en que cierra el periodo de facturación.", dom: "bancario" },
  { t: "fecha límite de pago", tr: "due date", d: "Último día para pagar sin recargos.", dom: "bancario" },
  { t: "comisión", tr: "fee", d: "Cargo cobrado por un servicio bancario.", dom: "bancario" },
  { t: "número de ruta", tr: "routing number", d: "Número de 9 dígitos que identifica al banco (EE. UU.).", dom: "bancario" },
  { t: "número de cuenta", tr: "account number", d: "Número que identifica tu cuenta.", dom: "bancario" },
  { t: "titular", tr: "account holder", d: "Persona dueña de la cuenta.", dom: "bancario" },
  { t: "historial crediticio", tr: "credit history", d: "Registro de cómo has manejado tus créditos.", dom: "bancario" },
  { t: "puntaje de crédito", tr: "credit score", d: "Número que resume tu historial crediticio.", dom: "bancario" },
  { t: "reembolso", tr: "refund", d: "Devolución de dinero.", dom: "bancario" },
  { t: "bloquear la tarjeta", tr: "freeze the card", d: "Suspender temporalmente el uso de la tarjeta.", dom: "bancario" },
  { t: "cajero automático", tr: "atm", d: "Máquina para retirar efectivo y hacer operaciones.", dom: "bancario" },
  { t: "depósito directo", tr: "direct deposit", d: "Pago (p. ej. nómina) que llega automáticamente a la cuenta.", dom: "bancario" },

  // ───────── GENERAL / SEGUROS ─────────
  { t: "fecha de nacimiento", tr: "date of birth", d: "Dato común de verificación de identidad (DOB).", dom: "general" },
  { t: "número de seguro social", tr: "social security number", d: "Número de identificación en EE. UU. (SSN). Dato sensible.", dom: "general" },
  { t: "póliza", tr: "policy", d: "Contrato de seguro y sus condiciones.", dom: "general" },
  { t: "reclamación", tr: "claim", d: "Solicitud de pago o cobertura a una aseguradora o empresa.", dom: "general" },
];

/* Palabras clave EXTRA para clasificar cada frase (además de los términos del glosario).
   Escribe sin acentos y en minúsculas; se comparan sin acentos. */
window.KEYWORDS = {
  medico: [
    "doctor", "doctora", "medico", "enfermera", "nurse", "hospital", "clinica", "clinic", "paciente", "patient",
    "dolor", "pain", "medicina", "medicamento", "medication", "pastilla", "pill", "tratamiento", "treatment",
    "sintoma", "symptom", "consulta", "laboratorio", "lab", "vacuna", "vaccine", "sangre", "blood", "corazon", "heart",
    "pecho", "chest", "cabeza", "headache", "estomago", "stomach", "infeccion", "infection", "seguro medico",
    "insurance", "medicaid", "medicare", "presion", "azucar", "sugar", "inyeccion", "injection", "terapia", "therapy",
    "diagnostico", "diagnosis", "urgencias", "emergency", "ambulancia", "ambulance", "pharmacy", "prescription"
  ],
  legal: [
    "corte", "court", "juez", "judge", "abogado", "abogada", "lawyer", "attorney", "caso", "ley", "law",
    "derecho", "rights", "policia", "police", "multa", "ticket", "delito", "crime", "carcel", "jail",
    "prision", "prison", "firma", "signature", "firmar", "documento legal", "notario", "notary", "juicio",
    "trial", "evidencia", "evidence", "jurado", "jury", "fiscal", "prosecutor", "visa", "residencia", "green card",
    "deportacion", "deportation", "orden", "warrant", "apelacion", "appeal", "custody", "lawsuit"
  ],
  bancario: [
    "banco", "bank", "cuenta", "account", "tarjeta", "card", "pago", "payment", "pagar", "pay", "dinero", "money",
    "dolares", "dollars", "pesos", "cargo", "charge", "cobro", "credito", "credit", "debito", "debit", "interes",
    "interest", "prestamo", "loan", "transaccion", "transaction", "cheque", "efectivo", "cash", "deuda",
    "debt", "factura", "bill", "pin", "contrasena", "password", "transferir", "transfer", "zelle", "atm",
    "balance", "saldo", "fraud", "fraude", "statement"
  ]
};
