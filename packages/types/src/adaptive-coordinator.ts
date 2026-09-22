// Nutrition Engine v4, PR5B — Adaptive Coordinator: contrato de entrada
// normalizado propio y una única salida discriminada de seis estados. El
// coordinador combina, sin aplicar nada por sí solo, la estrategia semanal
// de PR3, las señales de trayectoria de PR5A y el contexto (no decisional)
// de rendimiento de PR4 en, como mucho, una propuesta preliminar de ajuste.
//
// Diseño cerrado en docs/NUTRITION_V4_EXERCISE_V2_ROADMAP.md — ver ahí el
// diagnóstico de v3.1, la matriz de decisión y las decisiones abiertas.
//
// Nombres con prefijo `Adaptive` a propósito: v3.1 ya exporta desde este
// mismo barrel `AdaptiveTdee*`, `AdaptiveDiagnostics`, `AdjustmentDecision`,
// `AdjustmentProposal*`, `AdjustmentProfileFingerprint` y
// `WeightTrajectoryAssessment` — una redeclaración local con esos nombres
// taparía en silencio cualquier `export *` homónimo. Una prueba de tipos lo
// vigila (ver adaptive-coordinator-kernel.test.ts).
//
// El coordinador es puro, inerte y NO llama a ningún otro motor: recibe ya
// resueltos WeeklyStrategyResult (PR3), WeightTrendEstimateResult e
// IntakeLoggingCoverageResult (PR5A) y, opcionalmente,
// ExercisePerformanceResult (PR4). No conoce React, Supabase, sesiones,
// almacenamiento, reloj de sistema, red ni repositorios concretos — todo
// dato temporal entra como DateKey (`YYYY-MM-DD`) ya normalizado por el
// futuro adaptador, nunca como timestamp.
//
// PR5B NO administra ningún acumulado de ajustes: solo compara el objetivo
// semanal vigente (`baseline.weeklyKcalTargetInForce`) contra el que la
// propia `strategy` recién resuelta declara, y propone como mucho un paso
// fijo de ±100 kcal/día sobre ese objetivo. Tampoco verifica que una
// propuesta siga siendo aplicable tras un replan real de PR3 — eso es,
// deliberadamente, un PR posterior (ver la secuencia cerrada en el
// roadmap: PR5B → canal de ajuste en PR3 → verificación de
// aplicabilidad/replan → integración).

import type {
  SelfReportedConcern,
  UnsupportedPopulationReason,
  UserPriorityLevel,
  WeeklyStrategyObjective,
  WeeklyStrategyResult,
  WeeklyStrategySafetyAudit,
} from "./nutrition-weekly-strategy";
import type { WeightTrendEstimateResult, WeightTrendQualityLevel } from "./weight-trend";
import type { IntakeLoggingCoverageResult } from "./intake-logging-coverage";
import type { ExercisePerformanceResult } from "./exercise-performance";

export type AdaptivePolicyVersion = "adaptive-coordinator-v1";

// ─── Entrada ────────────────────────────────────────────────────────────

/**
 * Objetivo semanal vigente y las identidades opacas necesarias para que un
 * futuro paso de verificación (posterior a PR5B) detecte una propuesta
 * obsoleta. Deliberadamente SIN acumulado de ajustes ni TDEE: el
 * coordinador no administra ningún offset — solo compara
 * `weeklyKcalTargetInForce` contra el resultado de `strategy` que se le
 * pasa como base de esta revisión (ver `baseline_target_mismatch`).
 */
export interface AdaptiveCurrentPlanBaseline {
  /** Entero seguro > 0. Cuando `strategy.status === "ok"`, debe coincidir
   *  exactamente con `strategy.weeklyPlan.energy.roundedWeeklyKcalTarget`
   *  o el resultado es `deferred` — el coordinador nunca asume cuál de
   *  los dos es "el correcto", solo exige que coincidan. */
  weeklyKcalTargetInForce: number;
  /** Identificador/versión opaco del objetivo vigente — solo igualdad
   *  estricta de cadenas, nunca interpretado por el coordinador. */
  targetVersionId: string;
  /** Identificador/versión opaco de la estrategia que produjo ese
   *  objetivo — un token que el futuro adaptador genera y compara, nunca
   *  una huella que el coordinador calcule o verifique. Distinto de
   *  `targetVersionId` porque una misma estrategia puede materializarse
   *  en más de un objetivo persistido (deuda para el futuro paso de
   *  verificación, no resuelta aquí). */
  strategyVersionId: string;
  calibrationBaselineDateKey: string | null;
}

export interface AdaptiveReviewHistory {
  /** Última vez que se ACEPTÓ o RECHAZÓ una propuesta — paridad con v3.1
   *  (`ADJUSTMENT_COOLDOWN_DAYS`: ambas decisiones inician el intervalo). */
  lastResolvedOnDateKey: string | null;
  pendingProposalId: string | null;
}

/** Ausencia (`undefined`) = "sin señal", nunca "todo bien". Si el campo
 *  está presente, cada elemento de `concerns` debe pertenecer a
 *  `SelfReportedConcern`. */
export interface AdaptiveSelfReport {
  concerns?: readonly SelfReportedConcern[];
  isPregnantOrBreastfeeding?: boolean;
}

export interface AdaptiveReviewInput {
  referenceDateKey: string;
  baseline: AdaptiveCurrentPlanBaseline;
  /** PR3 real — trae el PR2B real ya resuelto dentro de `weeklyPlan`
   *  cuando `status === "ok"`. El coordinador nunca llama a
   *  `planWeeklyStrategy`. */
  strategy: WeeklyStrategyResult;
  /** PR5A, ventana de 29 fechas terminada en `referenceDateKey`. */
  weightTrend: WeightTrendEstimateResult;
  /** PR5A, ventana de 28 fechas terminada en `referenceDateKey`. Cada
   *  registro debe traer `targetKcalForDay` — ver
   *  `intake_records_missing_daily_targets`. */
  intakeCoverage: IntakeLoggingCoverageResult;
  /** PR4 — contexto NO decisional. Ausente (`undefined`/`null`) si el
   *  llamador no tiene datos de entrenamiento; distinto de que PR4
   *  evaluara y no encontrara nada. */
  exercisePerformance?: ExercisePerformanceResult | null;
  reviewHistory: AdaptiveReviewHistory;
  selfReport?: AdaptiveSelfReport;
}

// ─── invalid_input ──────────────────────────────────────────────────────
// El orden de declaración es el orden canónico de `reasons`.
//
// `derived_numeric_result_invalid` es la ÚNICA excepción a "todo
// invalid_input se conoce antes que deferred": es un error TARDÍO,
// alcanzable solo en la fase de construcción de una propuesta (después de
// A-E), porque depende de la dirección del ajuste, que a su vez depende de
// haber superado limpiamente las fases anteriores. Cuando aparece,
// `reasons` tiene longitud 1 por construcción: si el flujo llegó hasta
// ahí, las otras 13 razones ya se descartaron.
export type AdaptiveReviewInvalidReason =
  | "input_object_invalid"
  | "reference_date_key_invalid"
  | "baseline_invalid"
  | "baseline_calibration_date_invalid"
  | "strategy_result_malformed"
  | "weight_trend_result_malformed"
  | "intake_coverage_result_malformed"
  | "exercise_performance_result_malformed"
  | "review_history_invalid"
  | "review_history_last_resolved_date_invalid"
  | "self_report_invalid"
  | "weight_window_not_policy"
  | "intake_window_not_policy"
  | "derived_numeric_result_invalid";
export type NonEmptyAdaptiveReviewInvalidReasons = [AdaptiveReviewInvalidReason, ...AdaptiveReviewInvalidReason[]];

export interface AdaptiveReviewInvalidInput {
  status: "invalid_input";
  /** Deduplicadas y en orden canónico, nunca en orden de descubrimiento. */
  reasons: NonEmptyAdaptiveReviewInvalidReasons;
}

// ─── stop_and_recommend_review ──────────────────────────────────────────
// Solo dos fuentes válidas: un autoinforme VÁLIDO con al menos una
// preocupación reconocida, o un resultado VÁLIDO de PR3 que ya sea
// specialist_review_required/unsupported_plan/unsupported_population. Un
// autoinforme malformado NUNCA produce stop; produce self_report_invalid
// (salvo que la propia estrategia ya dispare un stop válido, en cuyo caso
// ese stop válido prevalece sobre el error no relacionado del autoinforme).
export type AdaptiveStopReason =
  | UnsupportedPopulationReason // reutiliza los 5 literales de PR3 tal cual
  | "strategy_specialist_review_required"
  | "strategy_unsupported_plan";
export type NonEmptyAdaptiveStopReasons = [AdaptiveStopReason, ...AdaptiveStopReason[]];

export interface AdaptiveReviewStopAndRecommendReview {
  status: "stop_and_recommend_review";
  reasons: NonEmptyAdaptiveStopReasons;
  /** Presente solo si el disparo vino (también) de PR3; se propaga tal
   *  cual, sin reinterpretar. `null` si el único disparo fue el
   *  autoinforme. */
  strategySafetyAudit: WeeklyStrategySafetyAudit | null;
}

// ─── deferred ───────────────────────────────────────────────────────────
export type AdaptiveDeferralReason =
  | "strategy_unresolved_input"
  | "strategy_invalid_input"
  | "strategy_infeasible"
  | "baseline_target_mismatch"
  | "proposal_pending_decision"
  | "review_interval_active";
export type NonEmptyAdaptiveDeferralReasons = [AdaptiveDeferralReason, ...AdaptiveDeferralReason[]];

export interface AdaptiveReviewDeferred {
  status: "deferred";
  reasons: NonEmptyAdaptiveDeferralReasons;
  /** No nulo únicamente cuando `review_interval_active` está entre las
   *  razones. */
  reviewIntervalDaysRemaining: number | null;
  /** Mantiene la visibilidad diagnóstica que v3.1 ya ofrecía bajo cooldown
   *  (`getAdaptiveDiagnostics` sigue calculando trayectoria/delta aunque
   *  bloquee) — pero SIN `classifiedRatePctPerWeek`, SIN
   *  `rateBandPosition`, SIN delta: eso insinuaría qué ajuste
   *  correspondería. `deferred` explica por qué todavía no toca revisar,
   *  nunca qué se revisaría. */
  evidence: AdaptiveEvidenceSummary;
}

// ─── insufficient_evidence ──────────────────────────────────────────────
// Paridad inicial con v3.1: nivel "high", >= 21 MEDICIONES (recuento, no
// amplitud de calendario — la calidad temporal ya forma parte del score de
// tendencia), cobertura plausible >= 0.85. Guardarraíl nuevo y
// conservador de v4: todo registro logueado debe traer `targetKcalForDay`,
// o `insufficient_evidence` con razón específica (cierra la política de
// "objetivo por fecha, no objetivo de hoy" de v3 §2.3 dentro del propio
// contrato del coordinador).
export type AdaptiveInsufficiencyReason =
  | "weight_trend_unavailable" // weightTrend.status === "invalid_input"
  | "weight_trend_insufficient_data" // weightTrend.status === "insufficient_data"
  | "weight_trend_quality_not_high"
  | "weight_measurements_below_minimum"
  | "intake_coverage_unavailable" // intakeCoverage.status === "invalid_input"
  | "intake_records_missing_daily_targets" // recordsWithTargetCount < loggedDays
  | "intake_plausible_coverage_below_minimum";
export type NonEmptyAdaptiveInsufficiencyReasons = [AdaptiveInsufficiencyReason, ...AdaptiveInsufficiencyReason[]];

// ─── Evidencia y contexto — compartidos entre insufficient_evidence,
// keep_targets, adjustment_proposal y deferred ─────────────────────────

export type AdaptiveWeightEvidence =
  | {
      status: "evaluated";
      windowStartDateKey: string;
      windowEndDateKey: string;
      measurementsInWindow: number;
      measurementSpanDays: number;
      trendQualityLevel: WeightTrendQualityLevel;
      /** Sin redondear — ver `classifiedRatePctPerWeek` (en keep_targets /
       *  adjustment_proposal) para el valor efectivamente usado en la
       *  clasificación. */
      weeklyChangePercent: number;
    }
  | { status: "insufficient_data"; windowStartDateKey: string; windowEndDateKey: string; measurementsInWindow: number }
  | { status: "invalid_input" };

export type AdaptiveIntakeEvidence =
  | {
      status: "evaluated";
      windowStartDateKey: string;
      windowEndDateKey: string;
      eligibleCalendarDays: number;
      loggedDays: number;
      plausibleDays: number;
      /** Debe igualar `loggedDays` para que la cobertura sea decisional —
       *  ver `intake_records_missing_daily_targets`. Días sin registro NO
       *  necesitan objetivo: se cuentan como ausencia mediante el
       *  denominador completo (`eligibleCalendarDays`), nunca mediante
       *  esta igualdad. */
      recordsWithTargetCount: number;
      plausibleCoverageFraction: number;
      averagePlausibleLoggedKcal: number | null;
      intakeAccuracy: "unknown";
    }
  | { status: "invalid_input" };

export interface AdaptiveEvidenceSummary {
  weight: AdaptiveWeightEvidence;
  intake: AdaptiveIntakeEvidence;
}

// Rendimiento — exclusivamente contexto, nunca decide (P7 del diseño): no
// cambia estado, delta ni confianza; no bloquea; no intensifica una
// propuesta. Se reutiliza directamente `windowSessionCount`, la única
// señal de PR4 ya expresiva a coste cero — sin ninguna interpretación
// nueva (agrupar observaciones de e1RM por identidad para "comparar
// progreso" se evaluó y se descartó: infla el contrato y los tests de
// PR5B para un campo que, por diseño, nunca puede influir en nada; un
// futuro consumidor puede leer `ExercisePerformanceResult` directamente).
export type AdaptivePerformanceContext =
  | { status: "not_provided"; influenceOnDecision: "none" }
  | { status: "unavailable"; influenceOnDecision: "none" } // exercisePerformance.status === "invalid_input"
  | { status: "observed"; influenceOnDecision: "none"; windowSessionCount: number };

export interface AdaptiveReviewContext {
  /** Puramente informativo: el coordinador NO puede verificar que el
   *  filtrado por calibración se aplicó de verdad a los registros crudos
   *  de peso/ingesta — esa obligación es del futuro adaptador. */
  calibrationBaselineDateKey: string | null;
  performance: AdaptivePerformanceContext;
}

export interface AdaptiveReviewInsufficientEvidence {
  status: "insufficient_evidence";
  reasons: NonEmptyAdaptiveInsufficiencyReasons;
  evidence: AdaptiveEvidenceSummary;
  context: AdaptiveReviewContext;
  policy: AdaptivePolicySnapshot;
}

// ─── keep_targets ───────────────────────────────────────────────────────
// Sin etiqueta de confianza: podría leerse como certeza de mantenimiento.
// Basta con evidencia y motivo tipado.
export interface AdaptiveReviewKeepTargets {
  status: "keep_targets";
  reasons: ["rate_within_expected_band"];
  /** Ritmo YA redondeado a 1 decimal y normalizado (nunca `-0`) — el
   *  mismo valor que decidió la banda. El valor sin redondear vive en
   *  `evidence.weight.weeklyChangePercent`. */
  classifiedRatePctPerWeek: number;
  desiredBandPctPerWeek: { minPct: number; maxPct: number };
  evidence: AdaptiveEvidenceSummary;
  context: AdaptiveReviewContext;
  policy: AdaptivePolicySnapshot;
}

// ─── adjustment_proposal ────────────────────────────────────────────────
// Sin acumulado: proposedWeeklyKcalTarget = weeklyKcalTargetInForce +
// 7 * deltaKcalPerDay, con deltaKcalPerDay limitado al literal -100 | 100.
// Preliminar: requiresNutritionReplan siempre true, nunca se aplica sola,
// y NO se comprueba contra PR3 — esa verificación es, deliberadamente, un
// PR posterior (ver cabecera del archivo).
export interface AdaptiveProposalBasis {
  policyVersion: AdaptivePolicyVersion;
  referenceDateKey: string;
  targetVersionId: string;
  weeklyKcalTargetInForce: number;
  strategyObjective: WeeklyStrategyObjective;
  strategyPriority: UserPriorityLevel | null;
  strategyVersionId: string;
  calibrationBaselineDateKey: string | null;
  lastResolvedOnDateKey: string | null;
  /** SIEMPRE `null` en una `adjustment_proposal` real — por construcción
   *  nunca puede ser otra cosa: si hubiera una propuesta pendiente,
   *  `proposal_pending_decision` ya habría desviado el resultado a
   *  `deferred` antes de llegar aquí. Se conserva explícitamente (tipo
   *  `null`, no `string | null`) para que el futuro paso de verificación
   *  tenga un HECHO observado y registrado de que, en el momento de
   *  generar esta propuesta, no había ninguna otra pendiente — no una
   *  inferencia posterior sobre datos ausentes.
   *
   *  Cada campo de esta interfaz es un HECHO observado en el momento de
   *  generar la propuesta — nunca una afirmación de que la propuesta
   *  sigue siendo aplicable más tarde. La aplicabilidad real la decide el
   *  futuro paso de verificación, comparando estos hechos contra el
   *  estado en el momento de aceptar. */
  pendingProposalIdObserved: null;
}

export interface AdaptiveReviewAdjustmentProposal {
  status: "adjustment_proposal";
  rateBandPosition: "below_band" | "above_band";
  classifiedRatePctPerWeek: number;
  desiredBandPctPerWeek: { minPct: number; maxPct: number };
  deltaKcalPerDay: -100 | 100;
  deltaKcalPerWeek: -700 | 700;
  currentWeeklyKcalTarget: number;
  proposedWeeklyKcalTarget: number;
  /** Sin redondear (weeklyKcalTarget / 7) — el redondeo es presentación,
   *  igual criterio que PR5A. */
  currentDailyAverageKcal: number;
  proposedDailyAverageKcal: number;
  /** Constante en PR5B — "moderate" significa exactamente: todas las
   *  puertas heurísticas mínimas de v3.1 (nivel "high" de tendencia,
   *  >=21 mediciones, cobertura plausible >=0.85) se cumplieron para
   *  esta revisión. NO significa certeza clínica, NO significa que la
   *  ingesta registrada sea exacta (`intakeAccuracy` sigue siendo
   *  "unknown"), y NO valida que el ajuste siga siendo aplicable tras un
   *  replan real de PR3. Nunca "high" — nota explícita del roadmap para
   *  PR5B. */
  confidence: "moderate";
  evidence: AdaptiveEvidenceSummary;
  context: AdaptiveReviewContext;
  policy: AdaptivePolicySnapshot;
  basis: AdaptiveProposalBasis;
  requiresNutritionReplan: true;
  requiresExplicitUserAcceptance: true;
}

// ─── Política aplicada — autodescriptiva, procedencia POR REGLA ────────
// No toda cifra de esta política se hereda igual de v3.1: la unión sirve
// de vocabulario general, pero cada campo de `provenance` tiene su propio
// literal exacto (no la unión genérica) para que el propio compilador
// impida asignar una procedencia incorrecta a una regla.
export type AdaptivePolicyRuleProvenance =
  | "heuristic_inherited_from_v3_1" // la CIFRA viene de v3.1 sin cambios
  | "window_length_observed_parity_with_v3_1" // 29/28: paridad OBSERVADA, no un campo de v3.1
  | "v4_conservative_safeguard" // nuevo en v4, más estricto que v3.1 a propósito
  | "v4_architectural_decision"; // decisión de arquitectura de v4, no una cifra heredada

export interface AdaptivePolicyProvenance {
  requiredWeightTrendQualityLevel: "heuristic_inherited_from_v3_1";
  minWeightMeasurementsForProposal: "heuristic_inherited_from_v3_1";
  minIntakePlausibleCoverageFraction: "heuristic_inherited_from_v3_1";
  stepKcalPerDay: "heuristic_inherited_from_v3_1";
  reviewIntervalDays: "heuristic_inherited_from_v3_1";
  rateClassificationResolutionPctPerWeek: "heuristic_inherited_from_v3_1";
  weightWindowCalendarDays: "window_length_observed_parity_with_v3_1";
  intakeWindowCalendarDays: "window_length_observed_parity_with_v3_1";
  intakeRecordsRequireDailyTarget: "v4_conservative_safeguard";
  performanceIsNonDecisional: "v4_architectural_decision";
}

export interface AdaptivePolicySnapshot {
  version: AdaptivePolicyVersion;
  weightWindowCalendarDays: 29;
  intakeWindowCalendarDays: 28;
  requiredWeightTrendQualityLevel: "high";
  minWeightMeasurementsForProposal: 21;
  minIntakePlausibleCoverageFraction: 0.85;
  stepKcalPerDay: 100;
  reviewIntervalDays: 14;
  /** Heurística heredada que evita reaccionar a diferencias de gramos por
   *  semana — no es precisión científica. */
  rateClassificationResolutionPctPerWeek: 0.1;
  intakeRecordsRequireDailyTarget: true;
  performanceIsNonDecisional: true;
  provenance: AdaptivePolicyProvenance;
}

export type AdaptiveReviewResult =
  | AdaptiveReviewInvalidInput
  | AdaptiveReviewStopAndRecommendReview
  | AdaptiveReviewDeferred
  | AdaptiveReviewInsufficientEvidence
  | AdaptiveReviewKeepTargets
  | AdaptiveReviewAdjustmentProposal;
