/**
 * Estrategia nutricional semanal — Nutrition Engine v4, PR3. Transforma
 * datos y preferencias YA RESUELTOS (TDEE ya estimado, objetivo,
 * prioridad, composición corporal si existe) en una estrategia semanal
 * consumible por PR2B (`planWeek`) — presupuesto energético, proteína y
 * grasa por día, y política de distribución. Sigue INERTE: no se conecta
 * a apps/web, no persiste nada, no toca Supabase, no sustituye v3.1.
 *
 * Frontera exacta (diseño consolidado v1→v4):
 * - NO calcula TMB/TDEE — los recibe ya resueltos (`tdeeKcal`).
 * - NO reimplementa el clasificador de evidencia de PR1 — lo consume tal
 *   cual (`classifyHelmsProteinEvidence`), nunca cambia sus umbrales.
 * - NO reparte los 7 días ni calcula carbohidratos — construye una
 *   petición real y llama a `planWeek` (PR2B), que a su vez usa
 *   `allocateDailyMacros` (PR2A) — PR3 nunca importa PR2A directamente.
 * - NO estima gasto de entrenamiento, no hace eat-back, no infiere
 *   actividad de pasos/reloj — las labels de día son declaraciones del
 *   caller, nunca un cálculo de PR3.
 * - NO diagnostica ninguna condición clínica (RED-S u otra) — solo enruta
 *   hacia estados no ejecutables cuando corresponde.
 *
 * Decisiones cerradas de diseño (v1→v4, no reabrir sin una razón nueva):
 * - La prioridad del usuario (5 niveles) NUNCA modifica la cifra de
 *   proteína — solo la tabla energética. La proteína es una función fija
 *   de (contexto con/sin déficit × tipo de base FFM/peso), nunca de la
 *   prioridad ni de la confirmación de adherencia real.
 * - Confirmar adherencia (`energyRestrictionStatus:"confirmed_current"`)
 *   cambia `policy`/`evidence`/explicación — NUNCA los gramos.
 * - Grasa es plana por semana (gramos idénticos los 7 días) — el ciclado
 *   energético recae enteramente en los carbohidratos vía PR2A. Ningún
 *   valor de energía ni de macro se redondea dentro de este paquete: el
 *   único redondeo por macro ocurre una vez, dentro de `allocateDailyMacros`.
 * - `weeklyKcalTarget` viaja a PR2B como DECIMAL sin redondear — PR2B es
 *   la única autoridad de ese redondeo.
 * - Embarazo/lactancia y cualquier preocupación de salud autoinformada
 *   bloquean ANTES de calcular nada, para cualquier objetivo — PR3 no
 *   tiene un motor perinatal.
 * - Los veredictos `invalid_input`/`infeasible` de PR2B se propagan
 *   íntegros, nunca se reinterpretan como el otro.
 */

// Nota sobre imports circulares: este archivo se reexporta desde
// "./index" (igual que nutrition-evidence.ts y nutrition-weekly-plan.ts),
// así que los tipos definidos directamente en el índice principal
// (Sex, BodyFatSource, ExperienceLevel) se referencian con
// `import("./index").X` inline en vez de un `import type` de nivel
// superior — mismo patrón ya establecido en
// HelmsProteinEvidenceProfile de nutrition-evidence.ts. Los tipos que
// SÍ viven en un archivo hermano concreto se importan directamente de
// ese hermano, nunca a través del barrel.
import type {
  EnergyRestrictionStatus,
  EvidenceApplicabilityAssessment,
  ProteinPolicy,
  StrengthTrainingCurrentStatus,
  StrengthTrainingExperience,
} from "./nutrition-evidence";
import type {
  DayLabel,
  WeeklyDistributionPolicy,
  WeeklyPlanInfeasible,
  WeeklyPlanInvalidInput,
  WeeklyPlanOk,
} from "./nutrition-weekly-plan";

// ─── Prioridad y objetivo ───────────────────────────────────────────────

/** Cinco niveles semánticos estables — nunca un decimal libre. Ver el
    comentario de cabecera: la prioridad nunca entra en la fórmula de
    proteína, solo en la tabla energética. */
export type UserPriorityLevel = "fat_loss_max" | "fat_loss_lean" | "balanced" | "muscle_gain_lean" | "muscle_gain_max";

/** Categoría usada para (a) elegir la fila de proteína/grasa y (b) exponer
    la elección al caller de forma explícita. `fat_loss_max`/`fat_loss_lean`
    comparten `objective:"fat_loss"` (misma categoría de proteína, distinta
    tabla energética); `muscle_gain_lean`/`muscle_gain_max` comparten
    `objective:"muscle_gain"` por el mismo motivo. */
export type WeeklyStrategyObjective = "fat_loss" | "recomp" | "muscle_gain" | "maintain";

/** Unión discriminada: `maintain` nunca lleva `priority` (no hay eje
    pérdida↔ganancia que priorizar); `priority_driven` siempre la exige —
    combinación incoherente imposible de construir por tipos. */
export type WeeklyStrategyGoalInput =
  | { goalIntent: "maintain" }
  | { goalIntent: "priority_driven"; priority: UserPriorityLevel };

// ─── Entrada ────────────────────────────────────────────────────────────

export type SelfReportedConcern =
  | "missed_periods"
  | "persistent_fatigue"
  | "disordered_eating_history"
  | "medical_condition_affecting_nutrition";

export interface WeeklyStrategyDayInput {
  dateKey: string;
  label: DayLabel;
}

/**
 * Requisitos granulares — solo `weightKg`/`heightCm`/`tdeeKcal`/`goal`/
 * `days` bloquean el resultado completo si faltan. El resto degrada
 * confianza (proteína) o activa guardarraíles, nunca bloquea por sí solo.
 */
export interface WeeklyStrategyInput {
  weightKg: number;
  heightCm: number;
  /** TDEE ya estimado por la capa de TMB/TDEE — PR3 nunca lo calcula. */
  tdeeKcal: number;
  goal: WeeklyStrategyGoalInput;
  /** Exactamente 7 — PR3 no decide fechas ni labels, las recibe. */
  days: readonly WeeklyStrategyDayInput[];

  // Opcionales — alimentan EXCLUSIVAMENTE el clasificador de evidencia de
  // PR1 (nunca la tabla energética):
  age?: number | null;
  sex?: import("./index").Sex | null;
  bodyFatPct?: number | null;
  bodyFatSource?: import("./index").BodyFatSource | null;
  strengthTrainingCurrentStatus?: StrengthTrainingCurrentStatus;
  strengthTrainingExperience?: StrengthTrainingExperience;
  /** Override explícito de una fuente EXTERNA (p. ej. un futuro Adaptive
      Coordinator con adherencia real confirmada). Si se omite, PR3 lo
      deriva del presupuesto ya calculado — nunca "confirmed_current" por
      defecto. Ver validación de coherencia en el kernel. */
  energyRestrictionStatus?: EnergyRestrictionStatus;

  /** Alimenta EXCLUSIVAMENTE la tabla energética (gating de
      `muscle_gain_max`) — nunca se pasa al clasificador de evidencia de
      PR1, que usa `strengthTrainingExperience` (meses confirmados) para
      esa pregunta, una señal distinta. */
  experienceLevel?: import("./index").ExperienceLevel | null;

  // Guardarraíles — ausencia = "sin señal", nunca "todo bien":
  isPregnantOrBreastfeeding?: boolean;
  selfReportedConcerns?: readonly SelfReportedConcern[];
}

// ─── unresolved_input / invalid_input ──────────────────────────────────

export type WeeklyStrategyUnresolvedReason =
  | "weight_not_resolved"
  | "height_not_resolved"
  | "tdee_not_resolved"
  | "goal_not_resolved"
  | "days_not_resolved";
export type NonEmptyWeeklyStrategyUnresolvedReasons = [WeeklyStrategyUnresolvedReason, ...WeeklyStrategyUnresolvedReason[]];

export type WeeklyStrategyInvalidReason =
  | "input_object_invalid"
  | "weight_invalid"
  | "height_invalid"
  | "tdee_invalid"
  | "goal_invalid"
  | "days_invalid"
  | "optional_context_signal_invalid"
  | "self_reported_concerns_invalid"
  | "pregnancy_flag_invalid"
  | "energy_restriction_override_contradicts_computed_deficit"
  | "energy_restriction_override_contradicts_computed_surplus_or_maintenance"
  | "experience_signals_contradict_each_other"
  | "propagated_from_weekly_plan"
  | "internal_construction_produced_unresolved_planweek_input";
export type NonEmptyWeeklyStrategyInvalidReasons = [WeeklyStrategyInvalidReason, ...WeeklyStrategyInvalidReason[]];

export interface WeeklyStrategyUnresolvedInput {
  status: "unresolved_input";
  reasons: NonEmptyWeeklyStrategyUnresolvedReasons;
}

export interface WeeklyStrategyInvalidInput {
  status: "invalid_input";
  reasons: NonEmptyWeeklyStrategyInvalidReasons;
  /** Presente únicamente cuando el invalid_input se originó propagando un
      veredicto real de `planWeek` — nunca reconstruido ni reinterpretado. */
  weeklyPlanVerdict?: WeeklyPlanInvalidInput;
}

// ─── infeasible ─────────────────────────────────────────────────────────

/** PR3 no tiene ninguna vía propia para decidir inviabilidad — el único
    origen posible es el veredicto real de `planWeek`. */
export type WeeklyStrategyInfeasibleReason = "propagated_from_weekly_plan";
export type NonEmptyWeeklyStrategyInfeasibleReasons = [WeeklyStrategyInfeasibleReason, ...WeeklyStrategyInfeasibleReason[]];

export interface WeeklyStrategyInfeasible {
  status: "infeasible";
  reasons: NonEmptyWeeklyStrategyInfeasibleReasons;
  weeklyPlanVerdict: WeeklyPlanInfeasible;
}

// ─── Estados de seguridad no ejecutables ────────────────────────────────

/** Cada umbral que se cruce se conserva — el estado exterior lo decide el
    más restrictivo (ver precedencia en el kernel), pero ningún código
    detectado se descarta. */
export type SafetyThresholdReason =
  | "very_low_energy_diet_day_present"
  | "low_energy_diet_day_present"
  // "weekly_average_below_70pct_tdee": el 70% es una heurística conservadora
  // de producto (umbral de alerta interno), no un umbral diagnóstico ni un
  // criterio clínico — no proviene de NICE NG246/NG247 ni de ninguna otra
  // fuente citada en este contrato.
  | "weekly_average_below_70pct_tdee";
export type NonEmptySafetyThresholdReasons = [SafetyThresholdReason, ...SafetyThresholdReason[]];

/** Auditoría de seguridad — NUNCA una petición ejecutable: sin
    `energyPolicy`, sin `days`, sin macros. Sirve para que una capa externa
    (o un profesional) entienda qué se detectó, no para seguir el plan. */
export interface WeeklyStrategySafetyAudit {
  minKcalDetected: number;
  maxKcalDetected: number;
  reasons: NonEmptySafetyThresholdReasons;
}

/** NICE NG246: 800-1200 kcal/día en algún día — dieta de baja energía,
    requiere estrategia multicomponente y soporte especializado. NO es un
    estado que un "confirmo" genérico resuelva — una capa externa que PR3
    v1 no implementa debe aportar autorización/procedencia profesional
    antes de que esto pueda convertirse en un plan ejecutable. */
export interface WeeklyStrategySpecialistReviewRequired {
  status: "specialist_review_required";
  audit: WeeklyStrategySafetyAudit;
}

/** NICE NG246: algún día <800 kcal — solo apropiado en servicios
    especializados con necesidad clínica evaluada. */
export interface WeeklyStrategyUnsupportedPlan {
  status: "unsupported_plan";
  audit: WeeklyStrategySafetyAudit;
}

export type UnsupportedPopulationReason =
  | "pregnant_or_breastfeeding"
  | "self_reported_missed_periods"
  | "self_reported_persistent_fatigue"
  | "self_reported_disordered_eating_history"
  | "self_reported_medical_condition";
export type NonEmptyUnsupportedPopulationReasons = [UnsupportedPopulationReason, ...UnsupportedPopulationReason[]];

/** Bloqueo por CONTEXTO de la persona (embarazo/lactancia, autoinforme de
    salud) — nunca por extremidad del plan (eso es `unsupported_plan`).
    `diagnostic` es SIEMPRE null: ni siquiera un rango estimado — como
    máximo, información general no prescriptiva fuera de este tipo. */
export interface WeeklyStrategyUnsupportedPopulation {
  status: "unsupported_population";
  reasons: NonEmptyUnsupportedPopulationReasons;
  diagnostic: null;
}

// ─── ok ─────────────────────────────────────────────────────────────────

export type ProteinBaseKind = "actual_weight" | "adjusted_weight" | "fat_free_mass";

/** Distingue "el dato existe" de "el dato es suficientemente fiable para
    prescribir": una fuente parcial (báscula/plicómetro) nunca se usa como
    base de prescripción, aunque el número exista. */
export type FfmBasis = "measured_reliable" | "measured_unreliable_not_used" | "unavailable";

/**
 * Cifra fija por (contexto con/sin déficit × tipo de base) — NUNCA varía
 * con `policy`/`evidence`/prioridad/confirmación de adherencia. Dos
 * llamadas con el mismo perfil y presupuesto pero distinto
 * `energyRestrictionStatus` producen el mismo `targetGPerDay`, distinta
 * `policy`.
 */
export interface ProteinPrescription {
  /** Decimal, sin redondear — PR2A redondea una vez, más adelante. */
  targetGPerDay: number;
  base: ProteinBaseKind;
  baseKg: number;
  ffmBasis: FfmBasis;
  evidence: EvidenceApplicabilityAssessment;
  policy: ProteinPolicy;
  noteText: string;
}

export type CyclingWeightDefaultReason =
  | "cardio_day_weight_defaulted_to_rest_factor"
  | "mixed_day_weight_defaulted_to_rest_factor"
  | "unclassified_day_weight_defaulted_to_rest_factor";

export interface WeeklyStrategyEnergyAudit {
  /** Suma decimal de factor×tdeeKcal sobre los 7 días reales — el valor
      que PR3 envía a PR2B sin redondear. */
  requestedWeeklyKcal: number;
  /** Math.round(requestedWeeklyKcal) — solo para auditoría/validación
      interna de PR3; PR2B redondea el mismo valor de forma autoritativa
      por su cuenta, con su propia comprobación de entero seguro. */
  roundedWeeklyKcalTarget: number;
  /** roundedWeeklyKcalTarget - requestedWeeklyKcal. */
  deltaKcal: number;
  /** Banda para EVALUAR tendencia real más adelante (Adaptive
      Coordinator) — nunca una promesa de que este ajuste vaya a producir
      ese ritmo. */
  desiredObservedRateBandPctPerWeek: { minPct: number; maxPct: number };
  /** Vacío si ningún día usa cardio/mixed/unclassified esa semana. */
  cyclingWeightDefaults: readonly CyclingWeightDefaultReason[];
}

/** Subtipos ESTRECHOS de los de `nutrition-weekly-plan.ts`: garantizan por
    tipo que `energyPolicy.status==="resolved"` y que los 7 días tienen
    `macros.status==="resolved"` — nunca una política o macros pendientes.
    Asignables a `WeeklyPlanRequest`/`WeeklyEnergyPolicy`/
    `WeeklyPlanDayInput` (estructuralmente compatibles), nunca al revés. */
export interface ResolvedWeeklyEnergyPolicy {
  status: "resolved";
  weeklyKcalTarget: number;
  distribution: WeeklyDistributionPolicy;
}

export interface ResolvedWeeklyPlanDayInput {
  dateKey: string;
  label: DayLabel;
  macros: { status: "resolved"; proteinTargetG: number; fatTargetG: number };
}

export type ResolvedWeeklyPlanDays = [
  ResolvedWeeklyPlanDayInput,
  ResolvedWeeklyPlanDayInput,
  ResolvedWeeklyPlanDayInput,
  ResolvedWeeklyPlanDayInput,
  ResolvedWeeklyPlanDayInput,
  ResolvedWeeklyPlanDayInput,
  ResolvedWeeklyPlanDayInput,
];

export interface ResolvedWeeklyPlanRequest {
  energyPolicy: ResolvedWeeklyEnergyPolicy;
  days: ResolvedWeeklyPlanDays;
}

export interface WeeklyStrategyOk {
  status: "ok";
  objective: WeeklyStrategyObjective;
  priority: UserPriorityLevel | null;
  /** Ejecutable tal cual: `planWeek(result.planRequest)` sin reinterpretar
      ningún campo. */
  planRequest: ResolvedWeeklyPlanRequest;
  /** El veredicto real de `planWeek(result.planRequest)` — se conserva
      íntegro, nunca se reconstruye. */
  weeklyPlan: WeeklyPlanOk;
  protein: ProteinPrescription;
  /** Decimal, idéntico los 7 días — sin redondear. */
  fatTargetGPerDay: number;
  audit: WeeklyStrategyEnergyAudit;
}

export type WeeklyStrategyResult =
  | WeeklyStrategyOk
  | WeeklyStrategySpecialistReviewRequired
  | WeeklyStrategyUnsupportedPlan
  | WeeklyStrategyUnsupportedPopulation
  | WeeklyStrategyUnresolvedInput
  | WeeklyStrategyInvalidInput
  | WeeklyStrategyInfeasible;
