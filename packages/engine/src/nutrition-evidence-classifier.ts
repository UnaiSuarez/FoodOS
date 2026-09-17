import type {
  ApplicabilityLevel,
  ApplicabilityReason,
  BodyFatSource,
  DataSufficiency,
  EnergyRestrictionStatus,
  EvidenceApplicabilityAssessment,
  EvidenceConfidence,
  EvidenceSourceId,
  HelmsProteinEvidenceProfile,
  InterventionContextApplicability,
  PopulationApplicability,
  ProteinPolicy,
  Sex,
  StrengthTrainingCurrentStatus,
  StrengthTrainingExperience,
} from "@foodos/types";

/*
 * NOTA sobre el aislamiento de apps/web (corrección de revisión): al ser
 * packages/engine un workspace de npm, `npm install` crea
 * node_modules/@foodos/engine en cuanto se instala el monorepo — nada a
 * nivel de Node/TypeScript impide TÉCNICAMENTE que apps/web lo resuelva,
 * con o sin que aparezca en apps/web/package.json. La garantía de PR1 es
 * una REGLA ARQUITECTÓNICA/DECLARATIVA (packages/engine no está conectado a
 * ningún flujo real), no una imposibilidad técnica de importación. El test
 * de este paquete que verifica la ausencia de imports desde apps/web
 * confirma el ESTADO ACTUAL del repositorio (ver
 * nutrition-evidence-classifier.test.ts para el alcance exacto de qué
 * archivos/configs revisa), no una frontera infalible.
 */

const HELMS_SOURCE_ID: EvidenceSourceId = "helms_2014";

/** Texto de cita legible por fuente — vive aquí (implementación), no en
    @foodos/types (que solo define la forma cerrada del identificador). */
const SOURCE_CITATION: Record<EvidenceSourceId, string> = {
  helms_2014: "Helms et al. 2014 (IJSNEM 24:127-138)",
};

const HELMS_BODY_FAT_CRITERION: Record<Sex, number> = { male: 23, female: 35 };
const OBESITY_IMC_PROXY_THRESHOLD = 30;
const MINIMUM_ADULT_AGE = 18;

/** Ver el comentario de DataSufficiency en nutrition-evidence.ts:
    "sufficient" significa "suficiente para ESTE clasificador", no "medición
    clínicamente perfecta" — hoy solo DXA cumple ese listón porque es el
    único método de los que este contrato registra cuya fiabilidad no
    depende fuertemente de protocolo/operador/dispositivo. */
const BODY_FAT_MEASUREMENT_SUFFICIENCY: Record<BodyFatSource, "sufficient" | "partial" | "insufficient"> = {
  dxa: "sufficient",
  bia_professional: "partial",
  smart_scale: "partial",
  skinfold: "partial",
  visual_estimate: "insufficient",
  other: "insufficient",
};

const REASON_ORDER: readonly ApplicabilityReason[] = [
  // población
  "body_composition_outside_studied_population",
  "body_composition_unknown",
  "bmi_obesity_range_without_body_fat_measurement",
  "sex_unknown",
  "age_unknown_or_minor",
  // suficiencia de datos
  "reliable_ffm_missing",
  // contexto de intervención
  "strength_training_status_unknown",
  "not_currently_strength_training",
  "strength_training_planned_not_confirmed",
  "training_experience_unknown",
  "training_experience_insufficient",
  "energy_restriction_unknown",
  "energy_restriction_planned_not_active",
  "energy_restriction_absent",
];

export function dedupeAndOrderReasons(reasons: readonly ApplicabilityReason[]): ApplicabilityReason[] {
  const present = new Set(reasons);
  return REASON_ORDER.filter((reason) => present.has(reason));
}

function isUsablePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100; // dominio abierto — 0 y 100 se rechazan por invalidez matemática, no por un límite clínico inventado
}

function usableImcOrNull(weightKg: unknown, heightCm: unknown): number | null {
  if (typeof weightKg !== "number" || !Number.isFinite(weightKg) || weightKg <= 0) return null;
  if (typeof heightCm !== "number" || !Number.isFinite(heightCm) || heightCm <= 0) return null;
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

function isKnownSex(value: unknown): value is Sex {
  return value === "male" || value === "female";
}

function isConfirmedAdultAge(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= MINIMUM_ADULT_AGE;
}

export function assessDataSufficiency(
  input: Pick<HelmsProteinEvidenceProfile, "bodyFatPct" | "bodyFatSource">,
): { dataSufficiency: DataSufficiency; reasons: ApplicabilityReason[] } {
  if (!isUsablePercent(input.bodyFatPct)) {
    return { dataSufficiency: "insufficient", reasons: dedupeAndOrderReasons(["reliable_ffm_missing"]) };
  }
  if (input.bodyFatSource == null) {
    return { dataSufficiency: "partial", reasons: [] };
  }
  const sufficiency = BODY_FAT_MEASUREMENT_SUFFICIENCY[input.bodyFatSource];
  if (sufficiency === "sufficient") return { dataSufficiency: "sufficient", reasons: [] };
  if (sufficiency === "partial") return { dataSufficiency: "partial", reasons: [] };
  return { dataSufficiency: "insufficient", reasons: dedupeAndOrderReasons(["reliable_ffm_missing"]) };
}

/** SOLO composición corporal — nunca decide por IMC solo (ver el comentario
    de PopulationApplicability). La razón de IMC solo puede aparecer cuando
    NO hay medición utilizable; en cuanto hay una medición válida, esta
    función ignora el IMC por completo. */
function evaluateBodyComposition(
  input: Pick<HelmsProteinEvidenceProfile, "bodyFatPct" | "weightKg" | "heightCm" | "sex">,
): { outcome: "match" | "mismatch" | "unknown"; reasons: ApplicabilityReason[] } {
  if (isUsablePercent(input.bodyFatPct)) {
    if (!isKnownSex(input.sex)) {
      return { outcome: "unknown", reasons: ["sex_unknown"] };
    }
    const criterion = HELMS_BODY_FAT_CRITERION[input.sex];
    if (input.bodyFatPct > criterion) {
      return { outcome: "mismatch", reasons: ["body_composition_outside_studied_population"] };
    }
    return { outcome: "match", reasons: [] };
  }
  const imc = usableImcOrNull(input.weightKg, input.heightCm);
  const reasons: ApplicabilityReason[] = ["body_composition_unknown"];
  if (imc != null && imc >= OBESITY_IMC_PROXY_THRESHOLD) {
    reasons.push("bmi_obesity_range_without_body_fat_measurement");
  }
  return { outcome: "unknown", reasons };
}

/** Eje de POBLACIÓN — composición corporal, sexo, edad. Nunca entrenamiento
    ni restricción energética (ver classifyInterventionContextApplicability). */
export function classifyPopulationApplicability(
  input: Pick<HelmsProteinEvidenceProfile, "bodyFatPct" | "weightKg" | "heightCm" | "sex" | "age">,
): { populationApplicability: PopulationApplicability; reasons: ApplicabilityReason[] } {
  const bodyComposition = evaluateBodyComposition(input);
  const secondary: ApplicabilityReason[] = [];
  if (!isConfirmedAdultAge(input.age)) secondary.push("age_unknown_or_minor");

  const allReasons = dedupeAndOrderReasons([...bodyComposition.reasons, ...secondary]);
  if (bodyComposition.outcome === "mismatch") {
    return { populationApplicability: "mismatched", reasons: allReasons };
  }
  if (bodyComposition.outcome === "match") {
    return { populationApplicability: secondary.length > 0 ? "partially_matched" : "matched", reasons: allReasons };
  }
  return { populationApplicability: secondary.length === 0 ? "partially_matched" : "unknown", reasons: allReasons };
}

/** Eje de CONTEXTO DE INTERVENCIÓN — entrenamiento de fuerza actual
    (StrengthTrainingCurrentStatus, NUNCA inferido de `trainingActivity`),
    experiencia confirmada, restricción energética confirmada. Modelo de
    "cubos": cualquier discrepancia CONFIRMADA (no solo desconocida) manda a
    "mismatched"; si no hay discrepancias confirmadas pero sí algo
    desconocido, "unknown"; si todo lo conocido apunta a coincidencia salvo
    algo "planificado pero no confirmado", "partially_matched"; sin ningún
    motivo, "matched". */
export function classifyInterventionContextApplicability(
  input: Pick<
    HelmsProteinEvidenceProfile,
    "strengthTrainingCurrentStatus" | "energyRestrictionStatus" | "strengthTrainingExperience"
  >,
): { interventionContextApplicability: InterventionContextApplicability; reasons: ApplicabilityReason[] } {
  const reasons: ApplicabilityReason[] = [];
  let hasConfirmedDiscrepancy = false;
  let hasUnknown = false;

  switch (input.strengthTrainingCurrentStatus) {
    case "confirmed_current":
      break;
    case "explicitly_planned":
      reasons.push("strength_training_planned_not_confirmed");
      break;
    case "not_training":
      reasons.push("not_currently_strength_training");
      hasConfirmedDiscrepancy = true;
      break;
    case "unknown":
      reasons.push("strength_training_status_unknown");
      hasUnknown = true;
      break;
    default:
      return assertNeverStrengthTrainingCurrentStatus(input.strengthTrainingCurrentStatus);
  }

  switch (input.strengthTrainingExperience) {
    case "confirmed_over_six_months":
      break;
    case "under_six_months":
      reasons.push("training_experience_insufficient");
      hasConfirmedDiscrepancy = true;
      break;
    case "unknown":
      reasons.push("training_experience_unknown");
      hasUnknown = true;
      break;
    default:
      return assertNeverStrengthTrainingExperience(input.strengthTrainingExperience);
  }

  switch (input.energyRestrictionStatus) {
    case "confirmed_current":
      break;
    case "explicitly_planned":
      reasons.push("energy_restriction_planned_not_active");
      break;
    case "not_restricted":
      reasons.push("energy_restriction_absent");
      hasConfirmedDiscrepancy = true;
      break;
    case "unknown":
      reasons.push("energy_restriction_unknown");
      hasUnknown = true;
      break;
    default:
      return assertNeverEnergyRestrictionStatus(input.energyRestrictionStatus);
  }

  const orderedReasons = dedupeAndOrderReasons(reasons);
  if (hasConfirmedDiscrepancy) {
    return { interventionContextApplicability: "mismatched", reasons: orderedReasons };
  }
  if (hasUnknown) {
    return { interventionContextApplicability: "unknown", reasons: orderedReasons };
  }
  if (orderedReasons.length === 0) {
    return { interventionContextApplicability: "matched", reasons: orderedReasons };
  }
  return { interventionContextApplicability: "partially_matched", reasons: orderedReasons };
}

const APPLICABILITY_SEVERITY: Record<ApplicabilityLevel, number> = {
  matched: 0,
  partially_matched: 1,
  unknown: 2,
  mismatched: 3,
};

/** Combina población + contexto de intervención en un único nivel para
    alimentar deriveEvidenceConfidence/deriveProteinPolicy — SIEMPRE el peor
    de los dos (nunca promedia ni prioriza uno sobre otro), para que una
    discrepancia real de cualquiera de los dos ejes nunca quede oculta. Los
    dos ejes originales se conservan sin cambios en
    EvidenceApplicabilityAssessment — combinar aquí no es "mezclar
    silenciosamente": es un paso explícito, documentado y probado por
    separado (ver el test de exhaustividad de combineApplicability).

    Recibe un objeto con propiedades NOMBRADAS, no dos parámetros
    posicionales: PopulationApplicability e InterventionContextApplicability
    son alias idénticos de ApplicabilityLevel (misma escala, dos preguntas
    distintas — ver nutrition-evidence.ts), así que dos parámetros
    posicionales del mismo tipo permitirían intercambiarlos por error sin
    que TypeScript lo detecte. La función sigue siendo conmutativa (el
    resultado no cambia si se intercambian), pero un error de LECTURA en la
    llamada (p. ej. loguear "por qué falló el eje de población" cuando en
    realidad la razón viene del eje de intervención) queda descartado por
    construcción al exigir nombres explícitos en cada llamada. */
export function combineApplicability(input: {
  population: PopulationApplicability;
  interventionContext: InterventionContextApplicability;
}): ApplicabilityLevel {
  return APPLICABILITY_SEVERITY[input.population] >= APPLICABILITY_SEVERITY[input.interventionContext]
    ? input.population
    : input.interventionContext;
}

function assertNeverApplicabilityLevel(value: never): never {
  throw new Error(`ApplicabilityLevel sin manejar: ${JSON.stringify(value)}`);
}
function assertNeverDataSufficiency(value: never): never {
  throw new Error(`DataSufficiency sin manejar: ${JSON.stringify(value)}`);
}
function assertNeverProteinPolicy(value: never): never {
  throw new Error(`ProteinPolicy sin manejar: ${JSON.stringify(value)}`);
}
function assertNeverEnergyRestrictionStatus(value: never): never {
  throw new Error(`EnergyRestrictionStatus sin manejar: ${JSON.stringify(value)}`);
}
function assertNeverStrengthTrainingExperience(value: never): never {
  throw new Error(`StrengthTrainingExperience sin manejar: ${JSON.stringify(value)}`);
}
function assertNeverStrengthTrainingCurrentStatus(value: never): never {
  throw new Error(`StrengthTrainingCurrentStatus sin manejar: ${JSON.stringify(value)}`);
}

/** Recibe el nivel de aplicabilidad YA COMBINADO (ver combineApplicability)
    — nunca población o contexto de intervención por separado, para no
    perder ninguna discrepancia real de ninguno de los dos ejes. */
export function deriveEvidenceConfidence(
  applicability: ApplicabilityLevel,
  dataSufficiency: DataSufficiency,
): EvidenceConfidence {
  switch (dataSufficiency) {
    case "insufficient":
    case "partial":
      return "low";
    case "sufficient":
      switch (applicability) {
        case "matched":
          return "moderate";
        case "partially_matched":
        case "mismatched":
        case "unknown":
          return "low";
        default:
          return assertNeverApplicabilityLevel(applicability);
      }
    default:
      return assertNeverDataSufficiency(dataSufficiency);
  }
}

/** Ver deriveEvidenceConfidence — mismo contrato de entrada. */
export function deriveProteinPolicy(applicability: ApplicabilityLevel, dataSufficiency: DataSufficiency): ProteinPolicy {
  switch (dataSufficiency) {
    case "insufficient":
      return "unresolved";
    case "partial":
      return "provisional";
    case "sufficient":
      switch (applicability) {
        case "matched":
          return "evidence_supported";
        case "partially_matched":
        case "mismatched":
        case "unknown":
          return "provisional";
        default:
          return assertNeverApplicabilityLevel(applicability);
      }
    default:
      return assertNeverDataSufficiency(dataSufficiency);
  }
}

/** Punto de entrada del clasificador. "evidence_supported" SÍ es alcanzable
    con una entrada real — ver el fixture FULLY_MATCHED_REACHABLE en el
    archivo de test: composición corporal medida por DXA dentro del
    criterio, sexo y edad adulta confirmados, entrenamiento de fuerza
    CONFIRMADO como actual, más de 6 meses de experiencia confirmados, y
    restricción energética confirmada como activa produce reasons=[],
    populationApplicability="matched",
    interventionContextApplicability="matched", dataSufficiency="sufficient",
    evidenceConfidence="moderate", y deriveProteinPolicy(...)="evidence_supported". */
export function classifyHelmsProteinEvidence(profile: HelmsProteinEvidenceProfile): EvidenceApplicabilityAssessment {
  const population = classifyPopulationApplicability(profile);
  const intervention = classifyInterventionContextApplicability(profile);
  const data = assessDataSufficiency(profile);
  const reasons = dedupeAndOrderReasons([...population.reasons, ...intervention.reasons, ...data.reasons]);
  const combined = combineApplicability({
    population: population.populationApplicability,
    interventionContext: intervention.interventionContextApplicability,
  });
  const evidenceConfidence = deriveEvidenceConfidence(combined, data.dataSufficiency);
  return {
    appliedSource: HELMS_SOURCE_ID,
    populationApplicability: population.populationApplicability,
    interventionContextApplicability: intervention.interventionContextApplicability,
    dataSufficiency: data.dataSufficiency,
    evidenceConfidence,
    reasons,
  };
}

export function buildProteinEvidenceNote(assessment: EvidenceApplicabilityAssessment, policy: ProteinPolicy): string {
  const citation = SOURCE_CITATION[assessment.appliedSource];
  switch (policy) {
    case "evidence_supported":
      return `Basado en investigación (${citation}) en personas con una composición corporal y un contexto de entrenamiento razonablemente parecidos a los tuyos.`;
    case "provisional":
      return `Aproximación basada en ${citation} — tu perfil no coincide del todo con la población que ese estudio revisó, así que esta cifra tiene menos respaldo directo de lo habitual.`;
    case "unresolved":
      return `No hay datos suficientemente fiables sobre tu composición corporal para aplicar ${citation} con confianza — esta cifra es una aproximación heredada, no una recomendación validada.`;
    default:
      return assertNeverProteinPolicy(policy);
  }
}
