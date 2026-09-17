/**
 * Aplicabilidad de evidencia científica a un perfil concreto — diseño v4
 * §Nutrition Engine. Nace de un caso real: v3.1 aplica el multiplicador de
 * proteína de Helms et al. 2014 (2.3-3.1 g/kg de masa libre de grasa) a
 * cualquier perfil con % de grasa conocido, sin comprobar si esa persona se
 * parece a la población que el estudio revisó — un criterio de INCLUSIÓN de
 * los estudios que Helms revisó, nunca un umbral biológico o clínico. Estos
 * tipos hacen esa comprobación explícita.
 *
 * TRES preguntas ORTOGONALES, deliberadamente separadas en tres campos en
 * vez de una sola unión discriminada (ronda de revisión: la versión anterior
 * solo separaba dos — población y suficiencia de datos — pero mezclaba
 * dentro de "población" dos cosas distintas: cómo ES el cuerpo de la
 * persona, y qué está HACIENDO — entrenamiento, restricción energética. Un
 * IMC alto con % de grasa medido bajo demostró el problema: el resultado
 * agregado bajaba a "partially_matched" por un motivo de restricción
 * energética, y esa bajada parecía (incorrectamente) una propiedad de la
 * composición corporal):
 * - PopulationApplicability: ¿el CUERPO de esta persona (sexo, edad adulta,
 *   composición corporal) se parece al de la población que la fuente
 *   reclutó? NUNCA incluye entrenamiento ni restricción energética.
 * - InterventionContextApplicability: ¿lo que esta persona está HACIENDO
 *   AHORA MISMO (entrenamiento de fuerza actual, experiencia acumulada,
 *   restricción energética) se parece a lo que hacía la población
 *   estudiada? Independiente de cómo sea su cuerpo. Las tres señales de
 *   este eje son EXPLÍCITAS y nunca se infieren de otro dato: ni de
 *   `goal` (una intención declarada no confirma restricción real), ni de
 *   una planificación semanal de entrenamiento (un plan de 4 días no
 *   confirma que la persona esté entrenando ahora — ver
 *   StrengthTrainingCurrentStatus).
 * - DataSufficiency: ¿el dato de entrada (aquí, % de grasa corporal) es en
 *   sí mismo fiable?
 * Son independientes: una persona con obesidad y sin % de grasa conocido es
 * A LA VEZ "unknown"/"partially_matched" en población (nunca "mismatched"
 * por IMC solo — ver la nota sobre IMC más abajo) Y puede tener CUALQUIER
 * valor de InterventionContextApplicability Y CUALQUIER DataSufficiency —
 * tres preguntas distintas, ninguna decidiendo a las otras.
 *
 * Ningún tipo de este archivo cambia el número de proteína calculado. Son
 * metadatos que describen cuánto confiar en ese número — nunca lo alteran.
 */

/**
 * Nivel compartido por PopulationApplicability e
 * InterventionContextApplicability — misma escala, dos preguntas distintas.
 * Ver el comentario de cada uno para su semántica concreta. Orden de
 * severidad (de mejor a peor), usado por `combineApplicability`: "matched"
 * &lt; "partially_matched" &lt; "unknown" &lt; "mismatched".
 */
export type ApplicabilityLevel = "matched" | "partially_matched" | "mismatched" | "unknown";

/**
 * ¿El CUERPO de esta persona encaja en la población que el estudio citado
 * reclutó? Exclusivamente: sexo, edad adulta, composición corporal. Nunca
 * entrenamiento ni restricción energética — ver InterventionContextApplicability.
 * - "matched": el criterio DEFINITORIO de la fuente (% de grasa medido)
 *   coincide, y sexo/edad también coinciden.
 * - "partially_matched": el criterio definitorio coincide (o es desconocido
 *   pero sexo/edad sí coinciden — ver nota de IMC), pero algún criterio
 *   secundario de población no coincide o se desconoce.
 * - "mismatched": el % de grasa MEDIDO supera el corte publicado. Nunca se
 *   llega aquí solo por una señal indirecta (IMC) — ver
 *   "bmi_obesity_range_without_body_fat_measurement".
 * - "unknown": no hay % de grasa medido, y además hay demasiadas otras
 *   dimensiones de población sin confirmar como para inclinarse hacia
 *   "partially_matched".
 *
 * Nota sobre IMC: un IMC≥30 SIN % de grasa medido es una señal indirecta,
 * nunca una medición — una persona muy musculada puede tener IMC≥30 con un
 * % de grasa bajo. Por eso el IMC nunca produce "mismatched" por sí solo, y
 * la razón "bmi_obesity_range_without_body_fat_measurement" SOLO puede
 * aparecer cuando NO existe una medición de composición corporal utilizable
 * — en cuanto hay una medición válida (de cualquier valor), esa razón nunca
 * se añade y la medición manda por completo sobre el IMC.
 */
export type PopulationApplicability = ApplicabilityLevel;

/**
 * ¿Lo que esta persona está HACIENDO se parece a lo que hacía la población
 * que el estudio citado reclutó? Exclusivamente tres señales EXPLÍCITAS:
 * estado actual de entrenamiento de fuerza (StrengthTrainingCurrentStatus),
 * experiencia acumulada (StrengthTrainingExperience), y restricción
 * energética (EnergyRestrictionStatus). Nunca características corporales —
 * ver PopulationApplicability.
 * - "matched": entrenamiento de fuerza CONFIRMADO como actual, experiencia
 *   &gt;6 meses confirmada, y restricción energética CONFIRMADA como activa
 *   ahora mismo.
 * - "partially_matched": ninguna de las tres condiciones está en
 *   discrepancia CONOCIDA ni es desconocida, pero al menos una está en un
 *   estado intermedio (p. ej. restricción o entrenamiento explícitamente
 *   planificados pero no confirmados como activos ahora mismo).
 * - "mismatched": al menos una condición tiene una discrepancia CONOCIDA y
 *   confirmada — confirmado que no entrena fuerza ahora, confirmado menos
 *   de 6 meses entrenando, o declara explícitamente que NO está en
 *   restricción energética.
 * - "unknown": al menos una condición no tiene ninguna señal (y ninguna
 *   tiene una discrepancia confirmada).
 */
export type InterventionContextApplicability = ApplicabilityLevel;

/**
 * ¿El dato de entrada necesario (aquí, % de grasa corporal) es en sí mismo
 * suficientemente fiable para calcular masa libre de grasa? Independiente
 * de si, de ser fiable, coincidiría o no con la población estudiada.
 * - "sufficient": SUFICIENTE PARA ESTE CLASIFICADOR — no implica una
 *   medición clínicamente perfecta, solo que su procedencia es de un método
 *   cuya tecnología es razonablemente estándar independientemente del
 *   operador (hoy, solo DXA cumple ese listón con la información que este
 *   contrato registra). Si en el futuro el contrato añade calidad/fecha del
 *   dato, esta clasificación puede volverse menos conservadora sin cambiar
 *   este tipo.
 * - "partial": el dato numérico existe y es matemáticamente válido, pero o
 *   bien no hay procedencia registrada, o la procedencia es un método real
 *   (bioimpedancia profesional, báscula inteligente, plicómetro) cuya
 *   fiabilidad depende mucho de protocolo/operador/dispositivo — datos que
 *   este contrato no registra hoy, así que no se puede asumir el mejor caso.
 * - "insufficient": el dato no existe, no es matemáticamente válido, o su
 *   procedencia es una estimación sin instrumento (visual) o no
 *   especificada.
 */
export type DataSufficiency = "sufficient" | "partial" | "insufficient";

/**
 * Estado de restricción energética — señal EXPLÍCITA que este contrato
 * exige como dato de entrada propio; NUNCA se deriva de `goal`.
 * `goal: "fat_loss"` en PhysicalProfile es una INTENCIÓN declarada, no una
 * confirmación de que exista un déficit real — Helms et al. exigían
 * restricción efectiva, no solo un objetivo marcado en la app.
 * - "confirmed_current": la persona está EN restricción energética ahora
 *   mismo (p. ej. confirmado por el propio motor de nutrición mediante
 *   seguimiento real, o declarado explícitamente como activo) — satisface
 *   el criterio de Helms sin reservas.
 * - "explicitly_planned": hay un plan de restricción pero no una
 *   confirmación de que esté activo ahora mismo — cuenta como contexto
 *   planificado, nunca como coincidencia completa.
 * - "not_restricted": la persona declara explícitamente que NO está
 *   restringiendo energía — una discrepancia real y confirmada con la
 *   población estudiada.
 * - "unknown": no hay ninguna señal — nunca decide por sí sola, pero impide
 *   la coincidencia completa.
 */
export type EnergyRestrictionStatus =
  | "confirmed_current"
  | "explicitly_planned"
  | "not_restricted"
  | "unknown";

/**
 * Estado ACTUAL de entrenamiento de fuerza — señal EXPLÍCITA, paralela a
 * EnergyRestrictionStatus; NUNCA se infiere de una planificación semanal
 * (`TrainingActivityProfile.strengthDaysPerWeek`). Un plan de 4 días/semana
 * es información COMPLEMENTARIA sobre lo que la persona pretende hacer,
 * nunca una confirmación de que lo esté haciendo ahora mismo — mismo tipo
 * de error que inferir restricción energética desde `goal`.
 * - "confirmed_current": confirmado que la persona entrena fuerza
 *   actualmente — satisface el criterio de Helms sin reservas.
 * - "explicitly_planned": hay un plan de entrenamiento de fuerza (p. ej.
 *   `trainingActivity` con días/semana &gt; 0) pero sin confirmación de que
 *   esté activo ahora mismo — cuenta como contexto planificado, nunca como
 *   coincidencia completa.
 * - "not_training": confirmado que la persona NO entrena fuerza
 *   actualmente — una discrepancia real y confirmada con la población
 *   estudiada.
 * - "unknown": no hay ninguna señal — nunca decide por sí sola, pero impide
 *   la coincidencia completa.
 */
export type StrengthTrainingCurrentStatus =
  | "confirmed_current"
  | "explicitly_planned"
  | "not_training"
  | "unknown";

/**
 * Duración confirmada de entrenamiento de fuerza — señal EXPLÍCITA de los
 * "más de 6 meses" que Helms exigía como criterio de inclusión. Independiente
 * de StrengthTrainingCurrentStatus: una persona puede llevar años entrenando
 * (experiencia confirmada) y sin embargo no estar entrenando ahora mismo
 * (p. ej. una pausa), o al revés — ambas señales se evalúan por separado.
 * `ExperienceLevel` ("beginner"/"intermediate"/"advanced") NO es un proxy
 * válido para esto: una persona autodeclarada "beginner" podría llevar 7
 * meses entrenando, y una "intermediate" podría llevar solo 4 — la etiqueta
 * mide percepción de nivel, no meses transcurridos. Este tipo nunca se
 * deriva de ExperienceLevel.
 * - "confirmed_over_six_months": más de 6 meses de entrenamiento de fuerza
 *   confirmados.
 * - "under_six_months": confirmado que lleva 6 meses o menos — una
 *   discrepancia real y confirmada con el criterio de Helms.
 * - "unknown": no hay ninguna señal sobre la duración.
 */
export type StrengthTrainingExperience = "confirmed_over_six_months" | "under_six_months" | "unknown";

/**
 * Nivel de confianza derivado del nivel de aplicabilidad COMBINADO
 * (población + contexto de intervención, ver `combineApplicability`) y de
 * DataSufficiency — nunca un campo independiente que alguien pueda fijar a
 * mano. "high" deliberadamente no existe en esta unión: ningún estimador
 * estático de este motor alcanza confianza alta (mismo criterio que
 * estimateTdeeUncertainty en nutrition.ts, que tampoco llega nunca a
 * "high") — esa categoría queda reservada al motor adaptativo con datos de
 * seguimiento reales.
 *
 * ACLARACIÓN IMPORTANTE: esta es una clasificación INTERNA de FoodOS sobre
 * cuánto se parece un perfil a la población/contexto que una fuente citada
 * estudió — NUNCA una calificación GRADE, una nota de calidad metodológica
 * del estudio en sí, ni una afirmación clínica universal. "moderate"
 * significa "este perfil concreto encaja razonablemente con el estudio
 * citado según los criterios que este motor puede verificar", no "el
 * estudio es de calidad moderada" ni "esto está clínicamente confirmado".
 * Cualquier texto visible para el usuario que derive de este valor debe
 * mantener esa distinción (ver buildProteinEvidenceNote).
 */
export type EvidenceConfidence = "moderate" | "low";

/**
 * Motivos de duda — SIEMPRE la ausencia de algo esperado, nunca una
 * confirmación positiva. La lista vacía significa "sin motivos de duda
 * conocidos" (y es exactamente lo que produce el caso totalmente
 * alcanzable: ver classifyHelmsProteinEvidence). Orden canónico: el de esta
 * declaración (ver `dedupeAndOrderReasons` en el clasificador). Cada razón
 * pertenece a UN SOLO eje — población, contexto de intervención, o
 * suficiencia de datos — nunca mezcla dos ejes en un mismo motivo.
 */
export type ApplicabilityReason =
  // ─── Eje: población (características corporales) ────────────────────
  /** % de grasa MEDIDO por encima del corte que la fuente publicó. */
  | "body_composition_outside_studied_population"
  /** Sin % de grasa medido, y sin ninguna señal indirecta utilizable. */
  | "body_composition_unknown"
  /** IMC≥30 sin % de grasa medido — señal indirecta que NUNCA decide la
      clasificación por sí sola, y que NUNCA aparece si existe una medición
      de composición corporal utilizable (ver PopulationApplicability). */
  | "bmi_obesity_range_without_body_fat_measurement"
  /** El sexo declarado no es uno de los dos que Helms diferenció — no se
      usa silenciosamente el corte de ningún grupo. */
  | "sex_unknown"
  /** Edad ausente, no numérica, o por debajo de 18 años — la evidencia
      citada estudió población adulta. */
  | "age_unknown_or_minor"
  // ─── Eje: suficiencia de datos ───────────────────────────────────────
  /** Sin % de grasa suficientemente fiable con el que calcular masa libre
      de grasa (ver DataSufficiency). */
  | "reliable_ffm_missing"
  // ─── Eje: contexto de intervención (qué está haciendo la persona) ────
  /** StrengthTrainingCurrentStatus = "unknown" — sin ninguna señal sobre si
      la persona entrena fuerza actualmente. */
  | "strength_training_status_unknown"
  /** StrengthTrainingCurrentStatus = "not_training" — confirmado que la
      persona NO entrena fuerza actualmente. Discrepancia confirmada, no una
      duda; NUNCA se infiere de una planificación semanal en 0 días — eso
      sería el mismo error que "goal: fat_loss" confirmando restricción. */
  | "not_currently_strength_training"
  /** StrengthTrainingCurrentStatus = "explicitly_planned" — hay un plan de
      entrenamiento de fuerza, pero sin confirmación de que esté activo
      ahora mismo. */
  | "strength_training_planned_not_confirmed"
  /** StrengthTrainingExperience no declarada. */
  | "training_experience_unknown"
  /** StrengthTrainingExperience = "under_six_months" — discrepancia
      confirmada con el criterio de Helms (&gt;6 meses), no una duda. */
  | "training_experience_insufficient"
  /** EnergyRestrictionStatus no declarado. */
  | "energy_restriction_unknown"
  /** EnergyRestrictionStatus = "explicitly_planned" — hay un plan, pero no
      está confirmado como activo ahora mismo. */
  | "energy_restriction_planned_not_active"
  /** EnergyRestrictionStatus = "not_restricted" — discrepancia confirmada:
      la persona declara explícitamente que no está en déficit. */
  | "energy_restriction_absent";

/**
 * Postura del motor ante una cifra de proteína dada su aplicabilidad —
 * NUNCA implica que la cifra esté validada para el individuo, ni siquiera
 * en el caso más favorable:
 * - "evidence_supported": la evidencia citada respalda esta cifra para una
 *   población y un contexto de intervención razonablemente coincidentes
 *   con este perfil — un respaldo poblacional, no un veredicto individual.
 *   SÍ es alcanzable con una entrada real (ver
 *   classifyHelmsProteinEvidence): requiere composición corporal medida
 *   por DXA dentro del criterio, sexo y edad adulta confirmados,
 *   entrenamiento de fuerza actual, más de 6 meses de experiencia
 *   confirmados, y restricción energética confirmada como activa.
 * - "provisional": se ofrece una cifra (heredada de v3.1 o de la fórmula
 *   vigente) pero con aplicabilidad reducida.
 * - "unresolved": el dato de entrada no es fiable — cualquier cifra que se
 *   muestre es un cálculo heredado por compatibilidad, no una
 *   recomendación de este motor.
 */
export type ProteinPolicy = "evidence_supported" | "provisional" | "unresolved";

/**
 * Identificador CERRADO de una fuente de evidencia citada — nunca un string
 * libre. El clasificador de Helms solo puede devolver "helms_2014"; jamás
 * un texto arbitrario que pudiera dar la impresión de admitir cualquier
 * fuente sin control. Convención de nombres: `<primer_autor>_<año>`. Añadir
 * una fuente nueva exige ampliar esta unión conscientemente (y, si hace
 * falta, escribir un clasificador nuevo específico para ella) — nunca
 * ampliarla implícitamente devolviendo un string sin tipar. El texto de cita
 * legible ("Helms et al. 2014 (IJSNEM 24:127-138)") vive en el motor
 * (packages/engine), no aquí — este archivo solo define la forma del dato,
 * nunca su presentación.
 */
export type EvidenceSourceId = "helms_2014";

/** Resultado completo de evaluar la aplicabilidad de una fuente de
    evidencia citada a un perfil concreto. Puramente informativo — ningún
    campo de esta interfaz debe usarse para calcular gramos, kcal, ni
    ningún otro número del motor. Los tres ejes (población, contexto de
    intervención, suficiencia de datos) se exponen POR SEPARADO — nunca
    colapsados en un único campo — precisamente para que una discrepancia
    de un eje no se confunda con una discrepancia de otro (p. ej.: un IMC
    alto con % de grasa medido bajo no debe hacer parecer que el "contexto
    de intervención" es el problema, ni al revés). */
export interface EvidenceApplicabilityAssessment {
  /** Identificador cerrado de la fuente evaluada — ver EvidenceSourceId. */
  appliedSource: EvidenceSourceId;
  populationApplicability: PopulationApplicability;
  interventionContextApplicability: InterventionContextApplicability;
  dataSufficiency: DataSufficiency;
  evidenceConfidence: EvidenceConfidence;
  /** Sin duplicados, en el orden canónico de ApplicabilityReason. */
  reasons: ApplicabilityReason[];
}

/**
 * Entrada completa de `classifyHelmsProteinEvidence` — el subconjunto de
 * PhysicalProfile que hace falta, MÁS las tres señales explícitas que ese
 * contrato todavía no puede representar (EnergyRestrictionStatus,
 * StrengthTrainingCurrentStatus, StrengthTrainingExperience).
 * Deliberadamente NO incluye `goal` ni `experienceLevel`: el primero nunca
 * confirmaba restricción energética real, y el segundo nunca confirmaba los
 * "más de 6 meses" de Helms — el tipo los excluye por completo en vez de
 * arriesgarse a que alguien los vuelva a usar como proxy.
 *
 * `age`, `sex`, `heightCm` y `weightKg` son `| null` a propósito: el
 * clasificador promete degradar con seguridad cuando esta información no
 * existe (edad desconocida, sexo no declarado, etc.), y el tipo debe
 * permitir CONSTRUIR ese estado legítimamente — sin `null` aquí, la única
 * forma de representar "ausente" habría sido un valor inventado (p. ej.
 * `NaN` para "sin edad") o un cast inseguro, exactamente lo que este
 * contrato existe para evitar en el resto del motor.
 *
 * `packages/engine` sigue sin modificar PhysicalProfile — este paquete
 * sigue inerte, no conectado a ningún flujo real. Una futura PR de
 * integración decide cómo poblar `energyRestrictionStatus`,
 * `strengthTrainingCurrentStatus` y `strengthTrainingExperience` (nueva
 * pregunta de onboarding, columna en BD, cálculo desde el histórico del
 * diario, etc.) y cómo conciliarlos con PhysicalProfile si hiciera falta.
 */
export interface HelmsProteinEvidenceProfile {
  age: number | null;
  sex: import("./index").Sex | null;
  heightCm: number | null;
  weightKg: number | null;
  bodyFatPct: number | null;
  bodyFatSource?: import("./index").BodyFatSource | null;
  /** Planificación semanal declarada — información COMPLEMENTARIA sobre lo
      que la persona pretende hacer. El clasificador de contexto de
      intervención NUNCA la lee para decidir si la persona entrena
      actualmente: eso es responsabilidad exclusiva de
      `strengthTrainingCurrentStatus`. Se conserva en el tipo por si un
      futuro refinamiento quiere mostrarla junto al resultado, no porque la
      lógica de clasificación la necesite hoy. */
  trainingActivity?: import("./index").TrainingActivityProfile;
  energyRestrictionStatus: EnergyRestrictionStatus;
  strengthTrainingCurrentStatus: StrengthTrainingCurrentStatus;
  strengthTrainingExperience: StrengthTrainingExperience;
}
