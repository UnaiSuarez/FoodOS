import {
  buildProteinEvidenceNote,
  classifyHelmsProteinEvidence,
  combineApplicability,
  deriveProteinPolicy,
} from "./nutrition-evidence-classifier";
import { planWeek } from "./weekly-plan-kernel";
import type {
  BodyFatSource,
  CyclingWeightDefaultReason,
  DayLabel,
  EnergyRestrictionStatus,
  ExperienceLevel,
  FfmBasis,
  HelmsProteinEvidenceProfile,
  NonEmptySafetyThresholdReasons,
  NonEmptyUnsupportedPopulationReasons,
  NonEmptyWeeklyStrategyInfeasibleReasons,
  NonEmptyWeeklyStrategyInvalidReasons,
  NonEmptyWeeklyStrategyUnresolvedReasons,
  ProteinBaseKind,
  ResolvedWeeklyEnergyPolicy,
  ResolvedWeeklyPlanDayInput,
  ResolvedWeeklyPlanDays,
  ResolvedWeeklyPlanRequest,
  SafetyThresholdReason,
  Sex,
  StrengthTrainingCurrentStatus,
  StrengthTrainingExperience,
  UnsupportedPopulationReason,
  UserPriorityLevel,
  WeeklyDistributionPolicy,
  WeeklyStrategyDayInput,
  WeeklyStrategyGoalInput,
  WeeklyStrategyInfeasible,
  WeeklyStrategyInput,
  WeeklyStrategyInvalidInput,
  WeeklyStrategyInvalidReason,
  WeeklyStrategyObjective,
  WeeklyStrategyOk,
  WeeklyStrategyResult,
  WeeklyStrategySpecialistReviewRequired,
  WeeklyStrategyUnresolvedInput,
  WeeklyStrategyUnresolvedReason,
  WeeklyStrategyUnsupportedPlan,
  WeeklyStrategyUnsupportedPopulation,
} from "@foodos/types";

/*
 * Núcleo matemático puro de estrategia semanal — PR3. Transforma
 * TDEE/objetivo/prioridad ya resueltos en una petición consumible por
 * PR2B (`planWeek`). Ver el comentario de cabecera de
 * nutrition-weekly-strategy.ts para el contrato completo y las decisiones
 * cerradas de diseño (v1→v4). Sigue inerte.
 *
 * Dependencias reales, deliberadas: PR1 (clasificador de evidencia,
 * `nutrition-evidence-classifier.ts`) y PR2B (`planWeek`,
 * `weekly-plan-kernel.ts`) — NUNCA `allocateDailyMacros` (PR2A)
 * directamente; PR2B ya lo llama, y PR3 nunca duplica ni el reparto
 * semanal ni el cálculo diario.
 *
 * Precedencia de seguridad (orden estricto, ver planWeeklyStrategy):
 * 1) unsupported_population — se evalúa ANTES de calcular nada, gana siempre.
 * 2) errores/unresolved de la propia entrada de PR3.
 * 3) veredicto real de PR2B: invalid_input/infeasible se propagan íntegros.
 * 4) algún día <800 kcal (veredicto real de PR2B) -> unsupported_plan.
 * 5) en ausencia de lo anterior, algún día [800,1200) o promedio <70% TDEE
 *    -> specialist_review_required.
 * 6) solo entonces -> ok.
 */

// ─── Utilidades genéricas ────────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Nutrition Engine v4 — rama inalcanzable: ${JSON.stringify(value)}`);
}

function isUsablePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100;
}

// ─── Vocabularios conocidos y orden canónico ───────────────────────────

const KNOWN_PRIORITIES: ReadonlySet<string> = new Set([
  "fat_loss_max",
  "fat_loss_lean",
  "balanced",
  "muscle_gain_lean",
  "muscle_gain_max",
]);
const KNOWN_DAY_LABELS: ReadonlySet<string> = new Set(["strength", "rest", "cardio", "mixed", "unclassified"]);
const KNOWN_SEX: ReadonlySet<string> = new Set(["male", "female"]);
const KNOWN_BODY_FAT_SOURCE: ReadonlySet<string> = new Set([
  "dxa",
  "bia_professional",
  "smart_scale",
  "skinfold",
  "visual_estimate",
  "other",
]);
const KNOWN_STRENGTH_CURRENT: ReadonlySet<string> = new Set([
  "confirmed_current",
  "explicitly_planned",
  "not_training",
  "unknown",
]);
const KNOWN_STRENGTH_EXPERIENCE: ReadonlySet<string> = new Set(["confirmed_over_six_months", "under_six_months", "unknown"]);
const KNOWN_ENERGY_RESTRICTION: ReadonlySet<string> = new Set([
  "confirmed_current",
  "explicitly_planned",
  "not_restricted",
  "unknown",
]);
const KNOWN_EXPERIENCE_LEVEL: ReadonlySet<string> = new Set(["beginner", "intermediate", "advanced"]);
const KNOWN_SELF_REPORTED_CONCERNS: ReadonlySet<string> = new Set([
  "missed_periods",
  "persistent_fatigue",
  "disordered_eating_history",
  "medical_condition_affecting_nutrition",
]);

const UNRESOLVED_REASON_ORDER: readonly WeeklyStrategyUnresolvedReason[] = [
  "weight_not_resolved",
  "height_not_resolved",
  "tdee_not_resolved",
  "goal_not_resolved",
  "days_not_resolved",
];

const INVALID_REASON_ORDER: readonly WeeklyStrategyInvalidReason[] = [
  "input_object_invalid",
  "weight_invalid",
  "height_invalid",
  "tdee_invalid",
  "energy_adjustment_invalid",
  "goal_invalid",
  "days_invalid",
  "optional_context_signal_invalid",
  "self_reported_concerns_invalid",
  "pregnancy_flag_invalid",
  "energy_restriction_override_contradicts_computed_deficit",
  "energy_restriction_override_contradicts_computed_surplus_or_maintenance",
  "experience_signals_contradict_each_other",
  "propagated_from_weekly_plan",
  "internal_construction_produced_unresolved_planweek_input",
];

const SAFETY_REASON_ORDER: readonly SafetyThresholdReason[] = [
  "very_low_energy_diet_day_present",
  "low_energy_diet_day_present",
  "weekly_average_below_70pct_tdee",
];

const POPULATION_REASON_ORDER: readonly UnsupportedPopulationReason[] = [
  "pregnant_or_breastfeeding",
  "self_reported_missed_periods",
  "self_reported_persistent_fatigue",
  "self_reported_disordered_eating_history",
  "self_reported_medical_condition",
];

function canonicalizeUnresolvedReasons(reasons: readonly WeeklyStrategyUnresolvedReason[]): NonEmptyWeeklyStrategyUnresolvedReasons {
  const present = new Set(reasons);
  return UNRESOLVED_REASON_ORDER.filter((r) => present.has(r)) as NonEmptyWeeklyStrategyUnresolvedReasons;
}
function canonicalizeInvalidReasons(reasons: readonly WeeklyStrategyInvalidReason[]): NonEmptyWeeklyStrategyInvalidReasons {
  const present = new Set(reasons);
  return INVALID_REASON_ORDER.filter((r) => present.has(r)) as NonEmptyWeeklyStrategyInvalidReasons;
}
function canonicalizeSafetyReasons(reasons: readonly SafetyThresholdReason[]): NonEmptySafetyThresholdReasons {
  const present = new Set(reasons);
  return SAFETY_REASON_ORDER.filter((r) => present.has(r)) as NonEmptySafetyThresholdReasons;
}
function canonicalizePopulationReasons(reasons: readonly UnsupportedPopulationReason[]): NonEmptyUnsupportedPopulationReasons {
  const present = new Set(reasons);
  return POPULATION_REASON_ORDER.filter((r) => present.has(r)) as NonEmptyUnsupportedPopulationReasons;
}

function invalidInput(reasons: WeeklyStrategyInvalidReason[]): WeeklyStrategyInvalidInput {
  return { status: "invalid_input", reasons: canonicalizeInvalidReasons(reasons) };
}
function unresolvedInput(reasons: WeeklyStrategyUnresolvedReason[]): WeeklyStrategyUnresolvedInput {
  return { status: "unresolved_input", reasons: canonicalizeUnresolvedReasons(reasons) };
}

// ─── Validación estructural (función total sobre `unknown`) ──────────

type RequiredNumberOutcome = "unresolved" | "invalid" | number;
function validateRequiredNumber(raw: unknown): RequiredNumberOutcome {
  if (raw === undefined) return "unresolved";
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return "invalid";
  return raw;
}

type GoalOutcome = { kind: "unresolved" } | { kind: "invalid" } | { kind: "ok"; goal: WeeklyStrategyGoalInput };
function validateGoal(rawGoal: unknown): GoalOutcome {
  if (rawGoal === undefined) return { kind: "unresolved" };
  if (!isPlainRecord(rawGoal)) return { kind: "invalid" };
  const goalIntent = rawGoal.goalIntent;
  if (goalIntent === "maintain") return { kind: "ok", goal: { goalIntent: "maintain" } };
  if (goalIntent === "priority_driven") {
    const priority = rawGoal.priority;
    if (typeof priority === "string" && KNOWN_PRIORITIES.has(priority)) {
      return { kind: "ok", goal: { goalIntent: "priority_driven", priority: priority as UserPriorityLevel } };
    }
    return { kind: "invalid" };
  }
  return { kind: "invalid" };
}

type DaysOutcome = { kind: "unresolved" } | { kind: "invalid" } | { kind: "ok"; days: WeeklyStrategyDayInput[] };
function validateDays(rawDays: unknown): DaysOutcome {
  if (rawDays === undefined) return { kind: "unresolved" };
  if (!Array.isArray(rawDays) || rawDays.length !== 7) return { kind: "invalid" };
  const parsed: WeeklyStrategyDayInput[] = [];
  for (const rawDay of rawDays) {
    if (!isPlainRecord(rawDay)) return { kind: "invalid" };
    const dateKey = rawDay.dateKey;
    const label = rawDay.label;
    if (typeof dateKey !== "string") return { kind: "invalid" };
    if (typeof label !== "string" || !KNOWN_DAY_LABELS.has(label)) return { kind: "invalid" };
    parsed.push({ dateKey, label: label as DayLabel });
  }
  return { kind: "ok", days: parsed };
}

/** Ausente/null siempre es válido (= "sin señal") — solo un tipo incorrecto
    cuenta como malformado. Nunca valida el VALOR semántico de negocio (eso
    lo hace cada comprobación específica más abajo), solo la forma. */
function isOptionalKnownString(value: unknown, known: ReadonlySet<string>): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && known.has(value);
}

// ─── IMC y bandas (reimplementación local — PR3 no importa apps/web) ──

type ImcBand = "A" | "B" | "C";
function calcImc(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}
function imcBand(imc: number): ImcBand {
  if (imc < 27) return "A";
  if (imc < 30) return "B";
  return "C";
}

// ─── Tabla energética (verificada monótona no decreciente por banda) ──

interface DayTypeFactor {
  trainFactor: number;
  restFactor: number;
}

const ENERGY_FACTOR_TABLE: Record<
  Exclude<UserPriorityLevel, "muscle_gain_max">,
  Record<ImcBand, DayTypeFactor>
> = {
  fat_loss_max: {
    A: { trainFactor: 0.8, restFactor: 0.8 },
    B: { trainFactor: 0.8, restFactor: 0.8 },
    C: { trainFactor: 0.8, restFactor: 0.8 },
  },
  fat_loss_lean: {
    A: { trainFactor: 0.85, restFactor: 0.82 },
    B: { trainFactor: 0.85, restFactor: 0.82 },
    C: { trainFactor: 0.8, restFactor: 0.8 }, // meseta honesta con fat_loss_max — sin margen defendible
  },
  balanced: {
    A: { trainFactor: 0.9, restFactor: 0.83 },
    B: { trainFactor: 0.9, restFactor: 0.83 },
    C: { trainFactor: 0.83, restFactor: 0.8 },
  },
  muscle_gain_lean: {
    A: { trainFactor: 1.05, restFactor: 1.05 },
    B: { trainFactor: 1.0, restFactor: 1.0 },
    C: { trainFactor: 1.0, restFactor: 1.0 },
  },
};

/** `muscle_gain_max` (extremo bajo del rango 10-20% de Iraki et al. 2019
    para volumen fuera de temporada) SOLO se aplica con experiencia
    explícitamente resuelta como principiante/intermedia. Avanzada ->
    meseta con `muscle_gain_lean` (Iraki recomienda más prudencia en
    avanzados). Ausente/desconocida/cualquier otro valor -> la MISMA
    meseta conservadora — nunca 1,10 por asumir "no avanzado". */
function muscleGainMaxFactor(band: ImcBand, experienceLevel: ExperienceLevel | null | undefined): DayTypeFactor {
  if (band !== "A") return { trainFactor: 1.0, restFactor: 1.0 }; // mismo guardarraíl de IMC que lean
  if (experienceLevel === "beginner" || experienceLevel === "intermediate") {
    return { trainFactor: 1.1, restFactor: 1.1 };
  }
  return { trainFactor: 1.05, restFactor: 1.05 }; // "advanced", ausente, o cualquier valor no reconocido
}

function resolveEnergyFactor(
  priority: UserPriorityLevel,
  band: ImcBand,
  experienceLevel: ExperienceLevel | null | undefined,
): DayTypeFactor {
  if (priority === "muscle_gain_max") return muscleGainMaxFactor(band, experienceLevel);
  return ENERGY_FACTOR_TABLE[priority][band];
}

const RATE_BAND_PCT_PER_WEEK: Record<WeeklyStrategyObjective, { minPct: number; maxPct: number }> = {
  fat_loss: { minPct: -1.0, maxPct: -0.5 },
  recomp: { minPct: -0.5, maxPct: 0.0 },
  muscle_gain: { minPct: 0.25, maxPct: 0.5 },
  maintain: { minPct: -0.25, maxPct: 0.25 },
};

function objectiveFromGoal(goal: WeeklyStrategyGoalInput): WeeklyStrategyObjective {
  if (goal.goalIntent === "maintain") return "maintain";
  switch (goal.priority) {
    case "fat_loss_max":
    case "fat_loss_lean":
      return "fat_loss";
    case "balanced":
      return "recomp";
    case "muscle_gain_lean":
    case "muscle_gain_max":
      return "muscle_gain";
    default:
      return assertNever(goal.priority);
  }
}

/** Pesos por label para `weighted_by_date` — cardio/mixed/unclassified
    usan PROVISIONALMENTE el mismo peso que "rest" (el TDEE de entrada YA
    incluye su gasto; el ciclado calórico es solo sobre cuándo enfatizar
    recuperación de fuerza) — nunca se afirma que "son" descanso, se
    registra la razón estructurada de que es un valor por defecto. */
function cyclingWeightForLabel(
  label: DayLabel,
  factor: DayTypeFactor,
): { weight: number; defaultReason: CyclingWeightDefaultReason | null } {
  switch (label) {
    case "strength":
      return { weight: factor.trainFactor, defaultReason: null };
    case "rest":
      return { weight: factor.restFactor, defaultReason: null };
    case "cardio":
      return { weight: factor.restFactor, defaultReason: "cardio_day_weight_defaulted_to_rest_factor" };
    case "mixed":
      return { weight: factor.restFactor, defaultReason: "mixed_day_weight_defaulted_to_rest_factor" };
    case "unclassified":
      return { weight: factor.restFactor, defaultReason: "unclassified_day_weight_defaulted_to_rest_factor" };
    default:
      return assertNever(label);
  }
}

/** `uniform` si los 7 pesos resultan idénticos (objetivo plano, o una
    semana que — sin que PR3 lo decida — no distingue tipos de día esa
    semana concreta); `weighted_by_date` en cualquier otro caso. Nunca
    `weighted_by_label`: esa política de PR2B rechaza `"unclassified"` por
    contrato, y las labels declaradas por el caller nunca se reescriben. */
function buildDistribution(dateKeys: readonly string[], weights: readonly number[]): WeeklyDistributionPolicy {
  const allEqual = weights.every((w) => w === weights[0]);
  if (allEqual) return { kind: "uniform" };
  const weightsByDate: Record<string, number> = {};
  dateKeys.forEach((dateKey, i) => {
    weightsByDate[dateKey] = weights[i];
  });
  return { kind: "weighted_by_date", weights: weightsByDate };
}

// ─── Proteína — cifra fija, nunca depende de prioridad ni de confianza ─

const PROTEIN_G_PER_KG: Record<WeeklyStrategyObjective, { fatFreeMass: number; actualOrAdjusted: number }> = {
  fat_loss: { fatFreeMass: 2.6, actualOrAdjusted: 2.0 },
  recomp: { fatFreeMass: 2.4, actualOrAdjusted: 2.0 },
  muscle_gain: { fatFreeMass: 2.0, actualOrAdjusted: 1.8 },
  maintain: { fatFreeMass: 2.0, actualOrAdjusted: 1.8 },
};

/** Heredado de v3.1 (GOAL_CONFIG.fatPct) — releído literalmente, nunca el
    rango EFSA genérico. Objetivo "maintain"=0,28; el resto=0,25. */
const FAT_PCT: Record<WeeklyStrategyObjective, number> = {
  fat_loss: 0.25,
  recomp: 0.25,
  muscle_gain: 0.25,
  maintain: 0.28,
};

const BODY_FAT_DATA_SUFFICIENCY: Record<BodyFatSource, "sufficient" | "partial" | "insufficient"> = {
  dxa: "sufficient",
  bia_professional: "partial",
  smart_scale: "partial",
  skinfold: "partial",
  visual_estimate: "insufficient",
  other: "insufficient",
};

interface ProteinBaseResolution {
  kind: ProteinBaseKind;
  kg: number;
  ffmBasis: FfmBasis;
}

/** Peso real/ajustado (ESPEN) — reimplementación local de la fórmula de
    v3.1 (idealWeight = 25×alturaM², ajuste 0,33 sobre el exceso) — PR3 no
    puede importar apps/web, así que porta la fórmula citada, no el código. */
function actualOrAdjustedWeightBase(weightKg: number, heightCm: number): { kind: ProteinBaseKind; kg: number } {
  const heightM = heightCm / 100;
  const idealWeight = 25 * heightM * heightM;
  if (weightKg > idealWeight * 1.25) {
    return { kind: "adjusted_weight", kg: idealWeight + (weightKg - idealWeight) * 0.33 };
  }
  return { kind: "actual_weight", kg: weightKg };
}

/** Distingue "el dato existe" de "el dato es fiable para prescribir": una
    fuente parcial (báscula/plicómetro) NUNCA se usa como base de
    prescripción aunque el número exista — cae al fallback de peso
    real/ajustado, pero se expone por qué (`ffmBasis`). */
function resolveProteinBase(weightKg: number, heightCm: number, rawBodyFatPct: unknown, rawBodyFatSource: unknown): ProteinBaseResolution {
  const usablePct = isUsablePercent(rawBodyFatPct) ? rawBodyFatPct : null;
  if (usablePct === null) {
    return { ...actualOrAdjustedWeightBase(weightKg, heightCm), ffmBasis: "unavailable" };
  }
  const sufficiency =
    typeof rawBodyFatSource === "string" && rawBodyFatSource in BODY_FAT_DATA_SUFFICIENCY
      ? BODY_FAT_DATA_SUFFICIENCY[rawBodyFatSource as BodyFatSource]
      : "partial"; // fuente ausente: dato existe, procedencia no registrada — mismo criterio que PR1
  if (sufficiency === "sufficient") {
    return { kind: "fat_free_mass", kg: weightKg * (1 - usablePct / 100), ffmBasis: "measured_reliable" };
  }
  return {
    ...actualOrAdjustedWeightBase(weightKg, heightCm),
    ffmBasis: sufficiency === "partial" ? "measured_unreliable_not_used" : "unavailable",
  };
}

function buildHelmsProfile(
  weightKg: number,
  heightCm: number,
  age: unknown,
  sex: unknown,
  bodyFatPct: unknown,
  bodyFatSource: unknown,
  strengthTrainingCurrentStatus: StrengthTrainingCurrentStatus | undefined,
  strengthTrainingExperience: StrengthTrainingExperience | undefined,
  energyRestrictionStatus: EnergyRestrictionStatus,
): HelmsProteinEvidenceProfile {
  return {
    age: typeof age === "number" && Number.isFinite(age) ? age : null,
    sex: (sex as Sex | null | undefined) ?? null,
    heightCm,
    weightKg,
    bodyFatPct: isUsablePercent(bodyFatPct) ? bodyFatPct : null,
    bodyFatSource: (bodyFatSource as BodyFatSource | null | undefined) ?? null,
    energyRestrictionStatus,
    strengthTrainingCurrentStatus: strengthTrainingCurrentStatus ?? "unknown",
    strengthTrainingExperience: strengthTrainingExperience ?? "unknown",
  };
}

// ─── Punto de entrada ───────────────────────────────────────────────

/** Punto de entrada del kernel de estrategia semanal. Ver
    nutrition-weekly-strategy.ts para el contrato completo. Validación
    runtime COMPLETA sobre `input` tratado como `unknown` — igual
    disciplina que allocateDailyMacros/planWeek. */
export function planWeeklyStrategy(input: WeeklyStrategyInput): WeeklyStrategyResult {
  const raw: unknown = input;
  if (!isPlainRecord(raw) || Array.isArray(raw)) {
    return invalidInput(["input_object_invalid"]);
  }
  const record = raw as Record<string, unknown>;

  // ─── Fase 1: bloqueos de población — SIEMPRE antes de calcular nada.
  const rawPregnant = record.isPregnantOrBreastfeeding;
  if (rawPregnant !== undefined && typeof rawPregnant !== "boolean") {
    return invalidInput(["pregnancy_flag_invalid"]);
  }
  const rawConcerns = record.selfReportedConcerns;
  let concerns: string[] = [];
  if (rawConcerns !== undefined) {
    if (!Array.isArray(rawConcerns) || rawConcerns.some((c) => typeof c !== "string" || !KNOWN_SELF_REPORTED_CONCERNS.has(c))) {
      return invalidInput(["self_reported_concerns_invalid"]);
    }
    concerns = rawConcerns as string[];
  }

  const populationReasons: UnsupportedPopulationReason[] = [];
  if (rawPregnant === true) populationReasons.push("pregnant_or_breastfeeding");
  if (concerns.includes("missed_periods")) populationReasons.push("self_reported_missed_periods");
  if (concerns.includes("persistent_fatigue")) populationReasons.push("self_reported_persistent_fatigue");
  if (concerns.includes("disordered_eating_history")) populationReasons.push("self_reported_disordered_eating_history");
  if (concerns.includes("medical_condition_affecting_nutrition")) populationReasons.push("self_reported_medical_condition");
  if (populationReasons.length > 0) {
    const result: WeeklyStrategyUnsupportedPopulation = {
      status: "unsupported_population",
      reasons: canonicalizePopulationReasons(populationReasons),
      diagnostic: null,
    };
    return result;
  }

  // ─── Fase 2: validación estructural — acumula TODAS las razones antes
  // de decidir; invalid siempre gana sobre unresolved (mismo criterio que
  // PR2A/PR2B).
  const unresolvedReasons: WeeklyStrategyUnresolvedReason[] = [];
  const invalidReasons: WeeklyStrategyInvalidReason[] = [];

  const weightOutcome = validateRequiredNumber(record.weightKg);
  if (weightOutcome === "unresolved") unresolvedReasons.push("weight_not_resolved");
  else if (weightOutcome === "invalid") invalidReasons.push("weight_invalid");

  const heightOutcome = validateRequiredNumber(record.heightCm);
  if (heightOutcome === "unresolved") unresolvedReasons.push("height_not_resolved");
  else if (heightOutcome === "invalid") invalidReasons.push("height_invalid");

  const tdeeOutcome = validateRequiredNumber(record.tdeeKcal);
  if (tdeeOutcome === "unresolved") unresolvedReasons.push("tdee_not_resolved");
  else if (tdeeOutcome === "invalid") invalidReasons.push("tdee_invalid");

  // Ausencia = "sin señal" (ajuste cero), nunca "todavía no lo sé": a
  // diferencia de weight/height/tdee/goal/days, este campo NUNCA contribuye
  // a unresolvedReasons — su ausencia tiene una semántica propia y
  // completa (cero), igual criterio que age/bodyFatPct/etc. Solo un valor
  // PRESENTE y malformado (no numérico, no finito, no entero seguro)
  // invalida la entrada.
  const rawEnergyAdjustment = record.currentAverageDailyEnergyAdjustmentKcal;
  let currentAverageDailyEnergyAdjustmentKcal = 0;
  if (rawEnergyAdjustment !== undefined) {
    if (
      typeof rawEnergyAdjustment !== "number" ||
      !Number.isFinite(rawEnergyAdjustment) ||
      !Number.isSafeInteger(rawEnergyAdjustment)
    ) {
      invalidReasons.push("energy_adjustment_invalid");
    } else {
      // -0 es cero válido semánticamente (nunca dispara energy_adjustment_invalid)
      // pero se normaliza aquí para que ningún resultado público (audit)
      // distinga -0 de 0 — puramente representacional: la aritmética de más
      // abajo ya es indiferente al signo del cero (-0 + x === x en IEEE754
      // para cualquier x != 0).
      currentAverageDailyEnergyAdjustmentKcal = Object.is(rawEnergyAdjustment, -0) ? 0 : rawEnergyAdjustment;
    }
  }

  const goalOutcome = validateGoal(record.goal);
  if (goalOutcome.kind === "unresolved") unresolvedReasons.push("goal_not_resolved");
  else if (goalOutcome.kind === "invalid") invalidReasons.push("goal_invalid");

  const daysOutcome = validateDays(record.days);
  if (daysOutcome.kind === "unresolved") unresolvedReasons.push("days_not_resolved");
  else if (daysOutcome.kind === "invalid") invalidReasons.push("days_invalid");

  if (
    !isOptionalKnownString(record.sex, KNOWN_SEX) ||
    !isOptionalKnownString(record.bodyFatSource, KNOWN_BODY_FAT_SOURCE) ||
    !isOptionalKnownString(record.strengthTrainingCurrentStatus, KNOWN_STRENGTH_CURRENT) ||
    !isOptionalKnownString(record.strengthTrainingExperience, KNOWN_STRENGTH_EXPERIENCE) ||
    !isOptionalKnownString(record.energyRestrictionStatus, KNOWN_ENERGY_RESTRICTION) ||
    !isOptionalKnownString(record.experienceLevel, KNOWN_EXPERIENCE_LEVEL) ||
    (record.age !== undefined && record.age !== null && typeof record.age !== "number") ||
    (record.bodyFatPct !== undefined && record.bodyFatPct !== null && typeof record.bodyFatPct !== "number")
  ) {
    invalidReasons.push("optional_context_signal_invalid");
  }

  if (invalidReasons.length > 0) return invalidInput(invalidReasons);
  if (unresolvedReasons.length > 0) return unresolvedInput(unresolvedReasons);

  const weightKg = weightOutcome as number;
  const heightCm = heightOutcome as number;
  const tdeeKcal = tdeeOutcome as number;
  const goal = (goalOutcome as { kind: "ok"; goal: WeeklyStrategyGoalInput }).goal;
  const days = (daysOutcome as { kind: "ok"; days: WeeklyStrategyDayInput[] }).days;

  // ─── Fase 3: tabla energética -> requestedWeeklyKcal DECIMAL.
  const objective = objectiveFromGoal(goal);
  const imc = calcImc(weightKg, heightCm);
  const band = imcBand(imc);
  const experienceLevel = (record.experienceLevel as ExperienceLevel | null | undefined) ?? null;

  const weights: number[] = [];
  const cyclingDefaults = new Set<CyclingWeightDefaultReason>();
  if (goal.goalIntent === "maintain") {
    for (const _day of days) weights.push(1);
  } else {
    const factor = resolveEnergyFactor(goal.priority, band, experienceLevel);
    for (const day of days) {
      const { weight, defaultReason } = cyclingWeightForLabel(day.label, factor);
      weights.push(weight);
      if (defaultReason) cyclingDefaults.add(defaultReason);
    }
  }
  const perDayKcal = goal.goalIntent === "maintain" ? days.map(() => tdeeKcal) : weights.map((w) => w * tdeeKcal);
  const baseWeeklyKcal = perDayKcal.reduce((total, k) => total + k, 0);
  const roundedBaseWeeklyKcal = Math.round(baseWeeklyKcal);
  if (!Number.isSafeInteger(roundedBaseWeeklyKcal) || roundedBaseWeeklyKcal <= 0) {
    // Defensivo sobre la TABLA energética SIN ajuste — inalcanzable con
    // tdeeKcal ya validado finito/positivo y factores acotados en
    // [0.80, 1.10]. Sin relación con currentAverageDailyEnergyAdjustmentKcal:
    // ese se valida por separado arriba (energy_adjustment_invalid) y puede
    // legítimamente volver el objetivo YA AJUSTADO no positivo o inseguro —
    // ver más abajo, PR2B lo rechaza por su cuenta
    // (weekly_kcal_target_invalid/_rounds_to_zero/_unsafe, propagado en la
    // fase 9) sin que PR3 duplique ese guardarraíl.
    return invalidInput(["tdee_invalid"]);
  }
  // Punto único de inyección del ajuste vigente: todo lo que sigue (fase 4
  // en adelante) lee requestedWeeklyKcal, nunca baseWeeklyKcal — el ajuste
  // ya está incorporado antes de computedIsDeficit, antes de la grasa y
  // antes de construir la petición a PR2B. La proteína (fase 6) es la
  // única magnitud que NUNCA lee requestedWeeklyKcal/baseWeeklyKcal.
  const requestedWeeklyKcal = baseWeeklyKcal + 7 * currentAverageDailyEnergyAdjustmentKcal;
  const roundedWeeklyKcalTarget = Math.round(requestedWeeklyKcal);

  // ─── Fase 4: coherencia del override de energyRestrictionStatus.
  const computedIsDeficit = requestedWeeklyKcal < tdeeKcal * 7;
  const computedRestriction: EnergyRestrictionStatus = computedIsDeficit ? "explicitly_planned" : "not_restricted";
  const overrideRestriction = record.energyRestrictionStatus as EnergyRestrictionStatus | undefined;
  let effectiveRestriction: EnergyRestrictionStatus = computedRestriction;
  if (overrideRestriction !== undefined) {
    if (computedIsDeficit && overrideRestriction === "not_restricted") {
      return invalidInput(["energy_restriction_override_contradicts_computed_deficit"]);
    }
    if (!computedIsDeficit && (overrideRestriction === "confirmed_current" || overrideRestriction === "explicitly_planned")) {
      return invalidInput(["energy_restriction_override_contradicts_computed_surplus_or_maintenance"]);
    }
    effectiveRestriction = overrideRestriction;
  }

  // ─── Fase 5: coherencia de experiencia (experienceLevel alimenta SOLO
  // la tabla energética; strengthTrainingExperience alimenta SOLO PR1 —
  // ambas señales conviven, pero "avanzado" + "confirmado <6 meses" es una
  // contradicción real, nunca silenciada).
  const strengthTrainingExperience = record.strengthTrainingExperience as StrengthTrainingExperience | undefined;
  if (experienceLevel === "advanced" && strengthTrainingExperience === "under_six_months") {
    return invalidInput(["experience_signals_contradict_each_other"]);
  }

  // ─── Fase 6: proteína — cifra FIJA por (objetivo × base), nunca por
  // prioridad ni por confianza/confirmación.
  const proteinBase = resolveProteinBase(weightKg, heightCm, record.bodyFatPct, record.bodyFatSource);
  const gPerKgRow = PROTEIN_G_PER_KG[objective];
  const gPerKg = proteinBase.kind === "fat_free_mass" ? gPerKgRow.fatFreeMass : gPerKgRow.actualOrAdjusted;
  const targetGPerDay = proteinBase.kg * gPerKg; // decimal, nunca redondeado

  const helmsProfile = buildHelmsProfile(
    weightKg,
    heightCm,
    record.age,
    record.sex,
    record.bodyFatPct,
    record.bodyFatSource,
    record.strengthTrainingCurrentStatus as StrengthTrainingCurrentStatus | undefined,
    strengthTrainingExperience,
    effectiveRestriction,
  );
  const evidence = classifyHelmsProteinEvidence(helmsProfile);
  const combined = combineApplicability({
    population: evidence.populationApplicability,
    interventionContext: evidence.interventionContextApplicability,
  });
  const policy = deriveProteinPolicy(combined, evidence.dataSufficiency);
  const noteText = buildProteinEvidenceNote(evidence, policy);

  // ─── Fase 7: grasa plana decimal — desde requestedWeeklyKcal/7, sin que
  // PR3 redondee energía para alterar el porcentaje.
  const fatTargetGPerDay = ((requestedWeeklyKcal / 7) * FAT_PCT[objective]) / 9;

  // ─── Fase 8: construir la petición REAL (siete días, política resuelta)
  // y llamar a planWeek — PR2B es la única autoridad de reparto/redondeo.
  const resolvedDays = days.map(
    (day): ResolvedWeeklyPlanDayInput => ({
      dateKey: day.dateKey,
      label: day.label,
      macros: { status: "resolved", proteinTargetG: targetGPerDay, fatTargetG: fatTargetGPerDay },
    }),
  );
  // Longitud 7 ya garantizada por validateDays — cast justificado y local.
  const resolvedDays7 = resolvedDays as ResolvedWeeklyPlanDays;
  const dateKeys = days.map((d) => d.dateKey);
  const distribution = buildDistribution(dateKeys, weights.length === 7 ? weights : days.map(() => 1));
  const energyPolicy: ResolvedWeeklyEnergyPolicy = {
    status: "resolved",
    weeklyKcalTarget: requestedWeeklyKcal, // DECIMAL — PR2B redondea de forma autoritativa
    distribution,
  };
  const planRequest: ResolvedWeeklyPlanRequest = { energyPolicy, days: resolvedDays7 };

  const verdict = planWeek(planRequest);

  // ─── Fase 9: propagación exhaustiva y fiel del veredicto de PR2B.
  switch (verdict.status) {
    case "invalid_input": {
      const result: WeeklyStrategyInvalidInput = {
        status: "invalid_input",
        reasons: ["propagated_from_weekly_plan"] as NonEmptyWeeklyStrategyInvalidReasons,
        weeklyPlanVerdict: verdict,
      };
      return result;
    }
    case "infeasible": {
      const result: WeeklyStrategyInfeasible = {
        status: "infeasible",
        reasons: ["propagated_from_weekly_plan"] as NonEmptyWeeklyStrategyInfeasibleReasons,
        weeklyPlanVerdict: verdict,
      };
      return result;
    }
    case "unresolved_input": {
      // Defensivo: PR3 siempre construye energyPolicy/días ya resueltos —
      // esta rama no debería alcanzarse nunca. Nunca se ignora en
      // silencio ni se confunde con una inviabilidad nutricional.
      return invalidInput(["internal_construction_produced_unresolved_planweek_input"]);
    }
    case "ok":
      break;
    default:
      return assertNever(verdict);
  }

  // ─── Fase 10: guardarraíles de seguridad sobre las CUOTAS REALES que
  // devolvió PR2B — nunca solo el promedio.
  const dailyKcals = verdict.days.map((d) => d.distributedKcalTarget);
  const minKcalDetected = Math.min(...dailyKcals);
  const maxKcalDetected = Math.max(...dailyKcals);
  const weeklyAverage = dailyKcals.reduce((total, k) => total + k, 0) / 7;

  const safetyReasons: SafetyThresholdReason[] = [];
  if (minKcalDetected < 800) safetyReasons.push("very_low_energy_diet_day_present");
  if (dailyKcals.some((k) => k >= 800 && k < 1200)) safetyReasons.push("low_energy_diet_day_present");
  // 0.7 es una heurística conservadora de producto (umbral de alerta interno),
  // no un umbral diagnóstico ni un criterio clínico validado — no está tomado
  // de NICE NG246/NG247 ni de ninguna otra fuente citada en este kernel.
  if (weeklyAverage < tdeeKcal * 0.7) safetyReasons.push("weekly_average_below_70pct_tdee");

  if (safetyReasons.includes("very_low_energy_diet_day_present")) {
    const result: WeeklyStrategyUnsupportedPlan = {
      status: "unsupported_plan",
      audit: { minKcalDetected, maxKcalDetected, reasons: canonicalizeSafetyReasons(safetyReasons) },
    };
    return result;
  }
  if (safetyReasons.length > 0) {
    const result: WeeklyStrategySpecialistReviewRequired = {
      status: "specialist_review_required",
      audit: { minKcalDetected, maxKcalDetected, reasons: canonicalizeSafetyReasons(safetyReasons) },
    };
    return result;
  }

  // ─── Fase 11: ok.
  const result: WeeklyStrategyOk = {
    status: "ok",
    objective,
    priority: goal.goalIntent === "priority_driven" ? goal.priority : null,
    planRequest,
    weeklyPlan: verdict,
    protein: {
      targetGPerDay,
      base: proteinBase.kind,
      baseKg: proteinBase.kg,
      ffmBasis: proteinBase.ffmBasis,
      evidence,
      policy,
      noteText,
    },
    fatTargetGPerDay,
    audit: {
      baseWeeklyKcal,
      currentAverageDailyEnergyAdjustmentKcal,
      requestedWeeklyKcal,
      roundedWeeklyKcalTarget,
      deltaKcal: roundedWeeklyKcalTarget - requestedWeeklyKcal,
      desiredObservedRateBandPctPerWeek: RATE_BAND_PCT_PER_WEEK[objective],
      cyclingWeightDefaults: [...cyclingDefaults],
    },
  };
  return result;
}
