import type {
  AdaptiveCurrentPlanBaseline,
  AdaptiveDeferralReason,
  AdaptiveEvidenceSummary,
  AdaptiveInsufficiencyReason,
  AdaptivePerformanceContext,
  AdaptivePolicySnapshot,
  AdaptiveReviewContext,
  AdaptiveReviewHistory,
  AdaptiveReviewInput,
  AdaptiveReviewInvalidInput,
  AdaptiveReviewInvalidReason,
  AdaptiveReviewResult,
  AdaptiveStopReason,
  AdaptiveWeightEvidence,
  AdaptiveIntakeEvidence,
  NonEmptyAdaptiveDeferralReasons,
  NonEmptyAdaptiveInsufficiencyReasons,
  NonEmptyAdaptiveReviewInvalidReasons,
  NonEmptyAdaptiveStopReasons,
  SelfReportedConcern,
  UserPriorityLevel,
  WeeklyStrategyObjective,
  WeeklyStrategySafetyAudit,
  WeightTrendQualityLevel,
} from "@foodos/types";

/*
 * Nutrition Engine v4, PR5B — Adaptive Coordinator. Núcleo matemático puro:
 * combina la estrategia semanal de PR3, las señales de trayectoria de PR5A
 * y el contexto (no decisional) de rendimiento de PR4 en, como mucho, una
 * propuesta preliminar de ajuste. Ver el comentario de cabecera de
 * adaptive-coordinator.ts para el contrato completo y
 * docs/NUTRITION_V4_EXERCISE_V2_ROADMAP.md para el diseño cerrado.
 *
 * Validación runtime COMPLETA sobre `input` tratado como `unknown`, igual
 * criterio que PR1-PR5A: TypeScript garantiza la forma en código bien
 * tipado, pero un caller no-TS, JSON, o un simple `as` puede colar
 * cualquier cosa. Un resultado con `status` reconocido pero relaciones
 * internas imposibles (p. ej. más mediciones que días de ventana) NUNCA se
 * convierte en evidencia ni en contexto aparentemente válido — cae en el
 * mismo cubo invalid_input que una forma desconocida.
 *
 * Precedencia: stop_and_recommend_review > invalid_input > deferred >
 * insufficient_evidence > keep_targets | adjustment_proposal.
 * `derived_numeric_result_invalid` es la única excepción: es un error
 * TARDÍO, solo alcanzable al construir una propuesta (fase F), después de
 * conocer la dirección del ajuste.
 */

// ─── Guardas genéricas sobre datos JSON-like ────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

/** `-0` es un `number` finito perfectamente válido (`Number.isFinite(-0)`
 *  es `true`, `-0 >= 0` es `true`), así que puede colar sin problema
 *  cualquiera de las guardas numéricas de este archivo si un kernel
 *  upstream llega a emitirlo (p. ej. una pendiente de regresión exactamente
 *  en cero con signo negativo por cómo se propaga en coma flotante). Se
 *  normaliza a `0` en los valores que este kernel se limita a REENVIAR
 *  (nunca calcula) para que ningún resultado público de PR5B distinga
 *  `-0` de `0` — puramente representacional, no cambia ninguna decisión:
 *  toda comparación numérica de este archivo (`>=`, `<=`, `<`, `>`) ya
 *  trata `-0` y `0` de forma idéntica.
 *
 *  Política aplicada a CADA número reenviado desde upstream (auditoría
 *  explícita, no solo los que "se ven" al escribir el kernel):
 *  - `weeklyChangePercent`, ambos límites de `desiredObservedRateBandPctPerWeek`,
 *    `averagePlausibleLoggedKcal`, `measurementsInWindow` (ambas variantes),
 *    `measurementSpanDays`, `loggedDays`, `plausibleDays`,
 *    `recordsWithTargetCount`, `plausibleCoverageFraction` y
 *    `windowSessionCount` -> NORMALIZADOS: `0` es un valor de dominio
 *    perfectamente válido para todos ellos (cero cambio, banda que empieza
 *    en cero, cero mediciones/días/sesiones, 0% de cobertura...) y ninguno
 *    se contrasta por igualdad estricta contra un valor recalculado —un
 *    -0 declarado los atravesaría sin más control que `>=`/`<=`, que no
 *    distinguen el signo del cero.
 *  - `eligibleCalendarDays`/`windowCalendarDays` -> NUNCA necesitan
 *    normalizarse: se contrastan por igualdad estricta (`!==`) contra la
 *    diferencia ordinal inclusiva real entre `windowStartDateKey` y
 *    `windowEndDateKey` (siempre >= 1, jamás `0` ni `-0`, por construcción
 *    aritmética) — un `-0` declarado aquí falla esa igualdad y cae en
 *    `*_result_malformed` sin ayuda de este helper. Cero NO es un valor de
 *    dominio válido para el tamaño de una ventana. */
function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

// ─── Fechas — YYYY-MM-DD estricto, año 0001-9999, sin Date ──────────────
// Duplicado a propósito (deuda registrada en el roadmap, P9): cada kernel
// de este repositorio valida sus propias fechas de forma independiente —
// PR5B no crea ninguna utilidad compartida con PR2B/PR4/PR5A.

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

/** days_from_civil (Hinnant) — sin Date, sin reloj. Mismo algoritmo que
 *  PR2B/PR4/PR5A. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function parseValidDateKey(dateKey: string): { year: number; month: number; day: number } {
  // Ya validado por isValidDateKey en todos los llamadores — el `as` es
  // sobre un resultado de regex que ya se sabe no-null.
  const match = DATE_KEY_PATTERN.exec(dateKey) as RegExpExecArray;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Diferencia en días de calendario (toDateKey - fromDateKey). Ambas
 *  fechas deben haber pasado ya por `isValidDateKey`. */
function daysBetweenDateKeys(fromDateKey: string, toDateKey: string): number {
  const from = parseValidDateKey(fromDateKey);
  const to = parseValidDateKey(toDateKey);
  return daysFromCivil(to.year, to.month, to.day) - daysFromCivil(from.year, from.month, from.day);
}

// ─── Vocabularios conocidos ──────────────────────────────────────────────

const KNOWN_OBJECTIVES: ReadonlySet<string> = new Set<WeeklyStrategyObjective>([
  "fat_loss",
  "recomp",
  "muscle_gain",
  "maintain",
]);
const KNOWN_PRIORITIES: ReadonlySet<string> = new Set<UserPriorityLevel>([
  "fat_loss_max",
  "fat_loss_lean",
  "balanced",
  "muscle_gain_lean",
  "muscle_gain_max",
]);
const KNOWN_UNSUPPORTED_POPULATION_REASONS: ReadonlySet<string> = new Set<AdaptiveStopReason>([
  "pregnant_or_breastfeeding",
  "self_reported_missed_periods",
  "self_reported_persistent_fatigue",
  "self_reported_disordered_eating_history",
  "self_reported_medical_condition",
]);
const KNOWN_WEIGHT_TREND_QUALITY_LEVELS: ReadonlySet<string> = new Set(["low", "moderate", "high"]);

/** Record<SelfReportedConcern, ...> obliga al compilador a exigir los 4
 *  literales de SelfReportedConcern como claves — añadir un 5º concern al
 *  tipo importado sin actualizar este mapa es un error de compilación, no
 *  un olvido silencioso. */
const SELF_REPORTED_CONCERN_TO_STOP_REASON: Record<SelfReportedConcern, AdaptiveStopReason> = {
  missed_periods: "self_reported_missed_periods",
  persistent_fatigue: "self_reported_persistent_fatigue",
  disordered_eating_history: "self_reported_disordered_eating_history",
  medical_condition_affecting_nutrition: "self_reported_medical_condition",
};
const KNOWN_SELF_REPORTED_CONCERNS: ReadonlySet<string> = new Set<SelfReportedConcern>(
  Object.keys(SELF_REPORTED_CONCERN_TO_STOP_REASON) as SelfReportedConcern[],
);

// ─── Política aplicada — constante, autodescriptiva ─────────────────────

const POLICY_SNAPSHOT: AdaptivePolicySnapshot = {
  version: "adaptive-coordinator-v1",
  weightWindowCalendarDays: 29,
  intakeWindowCalendarDays: 28,
  requiredWeightTrendQualityLevel: "high",
  minWeightMeasurementsForProposal: 21,
  minIntakePlausibleCoverageFraction: 0.85,
  stepKcalPerDay: 100,
  reviewIntervalDays: 14,
  rateClassificationResolutionPctPerWeek: 0.1,
  intakeRecordsRequireDailyTarget: true,
  performanceIsNonDecisional: true,
  provenance: {
    requiredWeightTrendQualityLevel: "heuristic_inherited_from_v3_1",
    minWeightMeasurementsForProposal: "heuristic_inherited_from_v3_1",
    minIntakePlausibleCoverageFraction: "heuristic_inherited_from_v3_1",
    stepKcalPerDay: "heuristic_inherited_from_v3_1",
    reviewIntervalDays: "heuristic_inherited_from_v3_1",
    rateClassificationResolutionPctPerWeek: "heuristic_inherited_from_v3_1",
    weightWindowCalendarDays: "window_length_observed_parity_with_v3_1",
    intakeWindowCalendarDays: "window_length_observed_parity_with_v3_1",
    intakeRecordsRequireDailyTarget: "v4_conservative_safeguard",
    performanceIsNonDecisional: "v4_architectural_decision",
  },
};

// ─── Canonicalización — orden fijo + exhaustividad comprobada por tipos ──
// Patrón de PR5A: `as const satisfies readonly Reason[]` +
// `MustBeNever<Exclude<Reason, (typeof TABLE)[number]>>`. Si algún día se
// añade un literal a una de las 4 uniones de razones sin añadirlo también
// a su tabla de orden, `tsc --noEmit` falla aquí, no en runtime.

type MustBeNever<T extends never> = T;

const INVALID_REASON_ORDER = [
  "input_object_invalid",
  "reference_date_key_invalid",
  "baseline_invalid",
  "baseline_calibration_date_invalid",
  "strategy_result_malformed",
  "weight_trend_result_malformed",
  "intake_coverage_result_malformed",
  "exercise_performance_result_malformed",
  "review_history_invalid",
  "review_history_last_resolved_date_invalid",
  "self_report_invalid",
  "weight_window_not_policy",
  "intake_window_not_policy",
  "derived_numeric_result_invalid",
] as const satisfies readonly AdaptiveReviewInvalidReason[];
type _EveryInvalidReasonIsOrdered = MustBeNever<Exclude<AdaptiveReviewInvalidReason, (typeof INVALID_REASON_ORDER)[number]>>;

const STOP_REASON_ORDER = [
  "pregnant_or_breastfeeding",
  "self_reported_missed_periods",
  "self_reported_persistent_fatigue",
  "self_reported_disordered_eating_history",
  "self_reported_medical_condition",
  "strategy_specialist_review_required",
  "strategy_unsupported_plan",
] as const satisfies readonly AdaptiveStopReason[];
type _EveryStopReasonIsOrdered = MustBeNever<Exclude<AdaptiveStopReason, (typeof STOP_REASON_ORDER)[number]>>;

const DEFERRAL_REASON_ORDER = [
  "strategy_unresolved_input",
  "strategy_invalid_input",
  "strategy_infeasible",
  "baseline_target_mismatch",
  "proposal_pending_decision",
  "review_interval_active",
] as const satisfies readonly AdaptiveDeferralReason[];
type _EveryDeferralReasonIsOrdered = MustBeNever<Exclude<AdaptiveDeferralReason, (typeof DEFERRAL_REASON_ORDER)[number]>>;

const INSUFFICIENCY_REASON_ORDER = [
  "weight_trend_unavailable",
  "weight_trend_insufficient_data",
  "weight_trend_quality_not_high",
  "weight_measurements_below_minimum",
  "intake_coverage_unavailable",
  "intake_records_missing_daily_targets",
  "intake_plausible_coverage_below_minimum",
] as const satisfies readonly AdaptiveInsufficiencyReason[];
type _EveryInsufficiencyReasonIsOrdered = MustBeNever<
  Exclude<AdaptiveInsufficiencyReason, (typeof INSUFFICIENCY_REASON_ORDER)[number]>
>;

/** Detalle interno — SIN `export`, igual que en los kernels de PR1-PR5A:
 *  con `export`, un consumidor podría hacer un deep import saltándose el
 *  barrel. Lanza solo ante un error de programación interno (llamarla con
 *  un iterable vacío), nunca alcanzable desde una entrada externa. */
function canonicalizeInvalid(reasons: Iterable<AdaptiveReviewInvalidReason>): NonEmptyAdaptiveReviewInvalidReasons {
  const present = new Set(reasons);
  const ordered = INVALID_REASON_ORDER.filter((r) => present.has(r));
  if (ordered.length === 0) {
    throw new Error("Adaptive Coordinator — invariante interno: invalid_input sin ninguna razón");
  }
  return ordered as NonEmptyAdaptiveReviewInvalidReasons;
}

function canonicalizeStop(reasons: Iterable<AdaptiveStopReason>): NonEmptyAdaptiveStopReasons {
  const present = new Set(reasons);
  const ordered = STOP_REASON_ORDER.filter((r) => present.has(r));
  if (ordered.length === 0) {
    throw new Error("Adaptive Coordinator — invariante interno: stop_and_recommend_review sin ninguna razón");
  }
  return ordered as NonEmptyAdaptiveStopReasons;
}

function canonicalizeDeferral(reasons: Iterable<AdaptiveDeferralReason>): NonEmptyAdaptiveDeferralReasons {
  const present = new Set(reasons);
  const ordered = DEFERRAL_REASON_ORDER.filter((r) => present.has(r));
  if (ordered.length === 0) {
    throw new Error("Adaptive Coordinator — invariante interno: deferred sin ninguna razón");
  }
  return ordered as NonEmptyAdaptiveDeferralReasons;
}

function canonicalizeInsufficiency(reasons: Iterable<AdaptiveInsufficiencyReason>): NonEmptyAdaptiveInsufficiencyReasons {
  const present = new Set(reasons);
  const ordered = INSUFFICIENCY_REASON_ORDER.filter((r) => present.has(r));
  if (ordered.length === 0) {
    throw new Error("Adaptive Coordinator — invariante interno: insufficient_evidence sin ninguna razón");
  }
  return ordered as NonEmptyAdaptiveInsufficiencyReasons;
}

function invalidInput(reasons: Iterable<AdaptiveReviewInvalidReason>): AdaptiveReviewInvalidInput {
  return { status: "invalid_input", reasons: canonicalizeInvalid(reasons) };
}

// ─── Clasificación semántica de `strategy` (WeeklyStrategyResult) ───────
// Una sola pasada de validación reutilizada por las fases A (seguridad),
// B (forma/relaciones) y C/D/E (aplazamiento/evidencia/clasificación) —
// mismo principio que "fuente única" ya aplicado en v3.1
// (evaluateAdaptiveState). Nivel 1 (forma) y Nivel 2 (relaciones internas
// imposibles) caen juntos en "malformed": un WeeklyStrategyOk con
// distributionRoundingDeltaKcal != 0, por ejemplo, es tan inválido para
// el coordinador como uno sin `weeklyPlan` en absoluto — PR2B garantiza
// esa relación siempre en un "ok" real, así que violarla es una
// contradicción, no un estado insuficiente.

type StrategyClassification =
  | { kind: "malformed" }
  | { kind: "stop"; reasons: AdaptiveStopReason[]; safetyAudit: WeeklyStrategySafetyAudit | null }
  | { kind: "not_ok"; reason: Extract<AdaptiveDeferralReason, "strategy_unresolved_input" | "strategy_invalid_input" | "strategy_infeasible"> }
  | { kind: "ok"; weeklyKcalTargetInForce: number; objective: WeeklyStrategyObjective; priority: UserPriorityLevel | null; band: { minPct: number; maxPct: number } };

function isValidSafetyAudit(raw: unknown): raw is WeeklyStrategySafetyAudit {
  if (!isPlainRecord(raw)) return false;
  if (!isFiniteNumber(raw.minKcalDetected) || !isFiniteNumber(raw.maxKcalDetected)) return false;
  if (raw.minKcalDetected > raw.maxKcalDetected) return false;
  return isNonEmptyStringArray(raw.reasons);
}

function classifyStrategy(raw: unknown): StrategyClassification {
  if (!isPlainRecord(raw)) return { kind: "malformed" };
  const status = raw.status;
  switch (status) {
    // Forma mínima exigida incluso para estados que el coordinador no lee
    // en detalle: un objeto con status conocido pero sin `reasons` (o con
    // un array vacío, imposible en el contrato real de PR3) no es una
    // instancia legítima de WeeklyStrategyUnresolvedInput/InvalidInput/
    // Infeasible — es tan malformado como un status desconocido, nunca un
    // "not_ok" silencioso. Mismo criterio que ya se aplica a invalid_input
    // de weightTrend/intakeCoverage/exercisePerformance más abajo.
    case "unresolved_input":
      if (!isNonEmptyStringArray(raw.reasons)) return { kind: "malformed" };
      return { kind: "not_ok", reason: "strategy_unresolved_input" };
    case "invalid_input":
      if (!isNonEmptyStringArray(raw.reasons)) return { kind: "malformed" };
      return { kind: "not_ok", reason: "strategy_invalid_input" };
    case "infeasible":
      if (!isNonEmptyStringArray(raw.reasons)) return { kind: "malformed" };
      return { kind: "not_ok", reason: "strategy_infeasible" };
    case "unsupported_population": {
      if (!isNonEmptyStringArray(raw.reasons)) return { kind: "malformed" };
      if (raw.reasons.some((r) => !KNOWN_UNSUPPORTED_POPULATION_REASONS.has(r))) return { kind: "malformed" };
      if (raw.diagnostic !== null) return { kind: "malformed" };
      return { kind: "stop", reasons: raw.reasons as AdaptiveStopReason[], safetyAudit: null };
    }
    case "specialist_review_required":
    case "unsupported_plan": {
      if (!isValidSafetyAudit(raw.audit)) return { kind: "malformed" };
      const reason: AdaptiveStopReason = status === "specialist_review_required" ? "strategy_specialist_review_required" : "strategy_unsupported_plan";
      return { kind: "stop", reasons: [reason], safetyAudit: raw.audit };
    }
    case "ok": {
      if (!isPlainRecord(raw.weeklyPlan) || raw.weeklyPlan.status !== "ok") return { kind: "malformed" };
      if (!isPlainRecord(raw.weeklyPlan.energy)) return { kind: "malformed" };
      const { roundedWeeklyKcalTarget, distributionRoundingDeltaKcal } = raw.weeklyPlan.energy;
      if (!isSafeInteger(roundedWeeklyKcalTarget) || roundedWeeklyKcalTarget <= 0) return { kind: "malformed" };
      // Invariante que PR2B garantiza SIEMPRE en un "ok" real (su propio
      // comentario de tipo: "SIEMPRE 0 en un ok") — violarla es una
      // relación interna imposible, no un dato ausente.
      if (distributionRoundingDeltaKcal !== 0) return { kind: "malformed" };
      if (!isPlainRecord(raw.audit)) return { kind: "malformed" };
      const band = raw.audit.desiredObservedRateBandPctPerWeek;
      if (!isPlainRecord(band) || !isFiniteNumber(band.minPct) || !isFiniteNumber(band.maxPct) || band.minPct > band.maxPct) {
        return { kind: "malformed" };
      }
      const bandMinPct = normalizeZero(band.minPct);
      const bandMaxPct = normalizeZero(band.maxPct);
      const objective = raw.objective;
      if (typeof objective !== "string" || !KNOWN_OBJECTIVES.has(objective)) return { kind: "malformed" };
      const priority = raw.priority;
      if (priority !== null && (typeof priority !== "string" || !KNOWN_PRIORITIES.has(priority))) return { kind: "malformed" };
      // Coherencia miembro-de-unión: WeeklyStrategyOk no liga
      // estructuralmente objective y priority (son dos campos sueltos),
      // así que esta coherencia no la garantiza el compilador de PR3 — el
      // coordinador la verifica en runtime.
      if ((objective === "maintain") !== (priority === null)) return { kind: "malformed" };
      return {
        kind: "ok",
        weeklyKcalTargetInForce: roundedWeeklyKcalTarget,
        objective: objective as WeeklyStrategyObjective,
        priority: priority as UserPriorityLevel | null,
        band: { minPct: bandMinPct, maxPct: bandMaxPct },
      };
    }
    default:
      return { kind: "malformed" };
  }
}

// ─── Clasificación semántica de weightTrend/intakeCoverage/exercise ─────
// Nivel 1 (forma) + Nivel 2 (relaciones internas) -> "malformed". Nivel 3
// (política de ventana: fin === referenceDateKey, longitud exacta 29/28,
// verificada con aritmética propia, nunca solo con el contador declarado)
// -> "window_off_policy", solo si referenceDateKey ya es válida (si no,
// se homologa a "ok" a nivel de forma/relaciones — el resultado global
// seguirá siendo invalid_input por reference_date_key_invalid de todos
// modos).

type WeightTrendClassification =
  | { kind: "malformed" }
  | { kind: "window_off_policy" }
  | { kind: "ok"; evidence: AdaptiveWeightEvidence };

function classifyWeightTrend(raw: unknown, referenceDateKey: string | null): WeightTrendClassification {
  if (!isPlainRecord(raw)) return { kind: "malformed" };
  if (raw.status === "invalid_input") {
    if (!isNonEmptyStringArray(raw.reasons)) return { kind: "malformed" };
    return { kind: "ok", evidence: { status: "invalid_input" } };
  }
  if (raw.status !== "insufficient_data" && raw.status !== "evaluated") return { kind: "malformed" };

  const coverage = raw.coverage;
  if (!isPlainRecord(coverage)) return { kind: "malformed" };
  const { windowStartDateKey, windowEndDateKey, windowCalendarDays, measurementsInWindow, minimumMeasurementsRequired } = coverage;
  if (!isValidDateKey(windowStartDateKey) || !isValidDateKey(windowEndDateKey)) return { kind: "malformed" };
  if (windowStartDateKey > windowEndDateKey) return { kind: "malformed" };
  if (!isSafeInteger(windowCalendarDays) || windowCalendarDays < 0) return { kind: "malformed" };
  if (!isSafeInteger(measurementsInWindow) || measurementsInWindow < 0) return { kind: "malformed" };

  // Nivel 2 — no confiar solo en el contador declarado: recalcular la
  // diferencia ordinal inclusiva real entre las fechas propias.
  const inclusiveDays = daysBetweenDateKeys(windowStartDateKey, windowEndDateKey) + 1;
  if (inclusiveDays !== windowCalendarDays) return { kind: "malformed" };
  // PR5A rechaza duplicados de fecha: nunca puede haber más mediciones que
  // días de ventana.
  if (measurementsInWindow > windowCalendarDays) return { kind: "malformed" };

  if (raw.status === "insufficient_data") {
    if (!isSafeInteger(minimumMeasurementsRequired) || minimumMeasurementsRequired < 0) return { kind: "malformed" };
    // El propio estado "insuficiente" sería una contradicción si el
    // recuento real ya alcanzara el mínimo declarado.
    if (measurementsInWindow >= minimumMeasurementsRequired) return { kind: "malformed" };

    if (referenceDateKey !== null && !(windowEndDateKey === referenceDateKey && windowCalendarDays === POLICY_SNAPSHOT.weightWindowCalendarDays)) {
      return { kind: "window_off_policy" };
    }
    return {
      kind: "ok",
      evidence: { status: "insufficient_data", windowStartDateKey, windowEndDateKey, measurementsInWindow: normalizeZero(measurementsInWindow) },
    };
  }

  // status === "evaluated"
  const { measurementSpanDays, trendQualityLevel, weeklyChangePercent } = raw;
  if (!isSafeInteger(measurementSpanDays) || measurementSpanDays < 0) return { kind: "malformed" };
  if (measurementSpanDays > windowCalendarDays - 1) return { kind: "malformed" };
  if (typeof trendQualityLevel !== "string" || !KNOWN_WEIGHT_TREND_QUALITY_LEVELS.has(trendQualityLevel)) return { kind: "malformed" };
  if (!isFiniteNumber(weeklyChangePercent)) return { kind: "malformed" };

  if (referenceDateKey !== null && !(windowEndDateKey === referenceDateKey && windowCalendarDays === POLICY_SNAPSHOT.weightWindowCalendarDays)) {
    return { kind: "window_off_policy" };
  }
  return {
    kind: "ok",
    evidence: {
      status: "evaluated",
      windowStartDateKey,
      windowEndDateKey,
      measurementsInWindow: normalizeZero(measurementsInWindow),
      measurementSpanDays: normalizeZero(measurementSpanDays),
      trendQualityLevel: trendQualityLevel as WeightTrendQualityLevel,
      weeklyChangePercent: normalizeZero(weeklyChangePercent),
    },
  };
}

type IntakeCoverageClassification =
  | { kind: "malformed" }
  | { kind: "window_off_policy" }
  | { kind: "ok"; evidence: AdaptiveIntakeEvidence };

function classifyIntakeCoverage(raw: unknown, referenceDateKey: string | null): IntakeCoverageClassification {
  if (!isPlainRecord(raw)) return { kind: "malformed" };
  if (raw.status === "invalid_input") {
    if (!isNonEmptyStringArray(raw.reasons)) return { kind: "malformed" };
    return { kind: "ok", evidence: { status: "invalid_input" } };
  }
  if (raw.status !== "evaluated") return { kind: "malformed" };

  const {
    windowStartDateKey,
    windowEndDateKey,
    eligibleCalendarDays,
    loggedDays,
    plausibleDays,
    recordsWithTargetCount,
    plausibleCoverageFraction,
    averagePlausibleLoggedKcal,
    intakeAccuracy,
  } = raw;
  if (!isValidDateKey(windowStartDateKey) || !isValidDateKey(windowEndDateKey)) return { kind: "malformed" };
  if (windowStartDateKey > windowEndDateKey) return { kind: "malformed" };
  if (!isSafeInteger(eligibleCalendarDays) || eligibleCalendarDays < 0) return { kind: "malformed" };

  // Nivel 2 — misma disciplina que en weightTrend: recalcular, no confiar.
  const inclusiveDays = daysBetweenDateKeys(windowStartDateKey, windowEndDateKey) + 1;
  if (inclusiveDays !== eligibleCalendarDays) return { kind: "malformed" };

  if (!isSafeInteger(loggedDays) || loggedDays < 0) return { kind: "malformed" };
  if (!isSafeInteger(plausibleDays) || plausibleDays < 0) return { kind: "malformed" };
  if (!isSafeInteger(recordsWithTargetCount) || recordsWithTargetCount < 0) return { kind: "malformed" };
  if (!(plausibleDays <= loggedDays && loggedDays <= eligibleCalendarDays)) return { kind: "malformed" };
  if (recordsWithTargetCount > loggedDays) return { kind: "malformed" };
  if (!isFiniteNumber(plausibleCoverageFraction) || plausibleCoverageFraction < 0 || plausibleCoverageFraction > 1) return { kind: "malformed" };

  // Tolerancia absoluta 1e-9 — mismo criterio que los tests de PR2A/PR5A
  // (toBeCloseTo(x, 9)) para comparar un decimal recalculado contra el
  // valor devuelto: es una división exacta de dos enteros pequeños, así
  // que recalcularla y compararla es fiable sin falsos positivos.
  const recomputedFraction = plausibleDays / eligibleCalendarDays;
  if (Math.abs(plausibleCoverageFraction - recomputedFraction) > 1e-9) return { kind: "malformed" };

  if (plausibleDays === 0) {
    if (averagePlausibleLoggedKcal !== null) return { kind: "malformed" };
  } else {
    if (!isFiniteNumber(averagePlausibleLoggedKcal) || averagePlausibleLoggedKcal < 0) return { kind: "malformed" };
  }
  if (intakeAccuracy !== "unknown") return { kind: "malformed" };

  if (referenceDateKey !== null && !(windowEndDateKey === referenceDateKey && eligibleCalendarDays === POLICY_SNAPSHOT.intakeWindowCalendarDays)) {
    return { kind: "window_off_policy" };
  }
  return {
    kind: "ok",
    evidence: {
      status: "evaluated",
      windowStartDateKey,
      windowEndDateKey,
      eligibleCalendarDays,
      loggedDays: normalizeZero(loggedDays),
      plausibleDays: normalizeZero(plausibleDays),
      recordsWithTargetCount: normalizeZero(recordsWithTargetCount),
      plausibleCoverageFraction: normalizeZero(plausibleCoverageFraction),
      averagePlausibleLoggedKcal: averagePlausibleLoggedKcal === null ? null : normalizeZero(averagePlausibleLoggedKcal as number),
      intakeAccuracy: "unknown",
    },
  };
}

type ExerciseClassification =
  | { kind: "not_provided" }
  | { kind: "malformed" }
  | { kind: "unavailable" }
  | { kind: "observed"; windowSessionCount: number };

function classifyExercisePerformance(raw: unknown): ExerciseClassification {
  if (raw === undefined || raw === null) return { kind: "not_provided" };
  if (!isPlainRecord(raw)) return { kind: "malformed" };
  if (raw.status === "invalid_input") {
    if (!isNonEmptyStringArray(raw.reasons)) return { kind: "malformed" };
    return { kind: "unavailable" };
  }
  if (raw.status !== "evaluated") return { kind: "malformed" };
  if (!isSafeInteger(raw.windowSessionCount) || raw.windowSessionCount < 0) return { kind: "malformed" };
  return { kind: "observed", windowSessionCount: normalizeZero(raw.windowSessionCount) };
}

function exerciseContextFrom(classification: Exclude<ExerciseClassification, { kind: "malformed" }>): AdaptivePerformanceContext {
  switch (classification.kind) {
    case "not_provided":
      return { status: "not_provided", influenceOnDecision: "none" };
    case "unavailable":
      return { status: "unavailable", influenceOnDecision: "none" };
    case "observed":
      return { status: "observed", influenceOnDecision: "none", windowSessionCount: classification.windowSessionCount };
    default:
      // Inalcanzable: el llamador ya excluyó "malformed" antes de invocar
      // esta función — mismo patrón defensivo que PR2B para un estado que
      // el compilador ya probó inalcanzable.
      throw new Error("Adaptive Coordinator — invariante interno: contexto de ejercicio en estado inesperado");
  }
}

// ─── Autoinforme ─────────────────────────────────────────────────────────

type SelfReportClassification = { valid: true; stopReasons: AdaptiveStopReason[] } | { valid: false };

function classifySelfReport(raw: unknown): SelfReportClassification {
  if (raw === undefined) return { valid: true, stopReasons: [] };
  if (!isPlainRecord(raw)) return { valid: false };
  const stopReasons: AdaptiveStopReason[] = [];

  if ("concerns" in raw && raw.concerns !== undefined) {
    if (!Array.isArray(raw.concerns)) return { valid: false };
    for (const concern of raw.concerns) {
      if (typeof concern !== "string" || !KNOWN_SELF_REPORTED_CONCERNS.has(concern)) return { valid: false };
      stopReasons.push(SELF_REPORTED_CONCERN_TO_STOP_REASON[concern as SelfReportedConcern]);
    }
  }
  if ("isPregnantOrBreastfeeding" in raw && raw.isPregnantOrBreastfeeding !== undefined) {
    if (typeof raw.isPregnantOrBreastfeeding !== "boolean") return { valid: false };
    if (raw.isPregnantOrBreastfeeding) stopReasons.push("pregnant_or_breastfeeding");
  }
  return { valid: true, stopReasons };
}

// ─── Baseline / historial de revisiones ─────────────────────────────────
// Cada infracción tiene su propia razón canónica, nunca oculta dentro de
// un genérico ambiguo: baseline_invalid cubre los 3 campos no-fecha;
// baseline_calibration_date_invalid cubre exclusivamente la fecha de
// calibración (mal formada O posterior a referenceDateKey); igual criterio
// para review_history_invalid/review_history_last_resolved_date_invalid.

interface ParsedBaseline {
  weeklyKcalTargetInForce: number;
  targetVersionId: string;
  strategyVersionId: string;
  calibrationBaselineDateKey: string | null;
}

function validateBaseline(raw: unknown, referenceDateKey: string | null, reasons: Set<AdaptiveReviewInvalidReason>): ParsedBaseline | null {
  if (!isPlainRecord(raw)) {
    reasons.add("baseline_invalid");
    return null;
  }
  let ok = true;
  if (!isSafeInteger(raw.weeklyKcalTargetInForce) || raw.weeklyKcalTargetInForce <= 0) {
    reasons.add("baseline_invalid");
    ok = false;
  }
  if (!isNonEmptyString(raw.targetVersionId)) {
    reasons.add("baseline_invalid");
    ok = false;
  }
  if (!isNonEmptyString(raw.strategyVersionId)) {
    reasons.add("baseline_invalid");
    ok = false;
  }
  const calibrationBaselineDateKey = raw.calibrationBaselineDateKey;
  if (calibrationBaselineDateKey !== null) {
    if (!isValidDateKey(calibrationBaselineDateKey)) {
      reasons.add("baseline_calibration_date_invalid");
      ok = false;
    } else if (referenceDateKey !== null && calibrationBaselineDateKey > referenceDateKey) {
      reasons.add("baseline_calibration_date_invalid");
      ok = false;
    }
  }
  if (!ok) return null;
  return {
    weeklyKcalTargetInForce: raw.weeklyKcalTargetInForce as number,
    targetVersionId: raw.targetVersionId as string,
    strategyVersionId: raw.strategyVersionId as string,
    calibrationBaselineDateKey: calibrationBaselineDateKey as string | null,
  };
}

interface ParsedReviewHistory {
  lastResolvedOnDateKey: string | null;
  pendingProposalId: string | null;
}

function validateReviewHistory(raw: unknown, referenceDateKey: string | null, reasons: Set<AdaptiveReviewInvalidReason>): ParsedReviewHistory | null {
  if (!isPlainRecord(raw)) {
    reasons.add("review_history_invalid");
    return null;
  }
  let ok = true;
  const pendingProposalId = raw.pendingProposalId;
  if (pendingProposalId !== null && !isNonEmptyString(pendingProposalId)) {
    reasons.add("review_history_invalid");
    ok = false;
  }
  const lastResolvedOnDateKey = raw.lastResolvedOnDateKey;
  if (lastResolvedOnDateKey !== null) {
    if (!isValidDateKey(lastResolvedOnDateKey)) {
      reasons.add("review_history_last_resolved_date_invalid");
      ok = false;
    } else if (referenceDateKey !== null && lastResolvedOnDateKey > referenceDateKey) {
      reasons.add("review_history_last_resolved_date_invalid");
      ok = false;
    }
  }
  if (!ok) return null;
  return {
    lastResolvedOnDateKey: lastResolvedOnDateKey as string | null,
    pendingProposalId: pendingProposalId as string | null,
  };
}

// ─── Normalización numérica (cero negativo) ─────────────────────────────

/** Clasificación heredada por redondeo a 1 decimal (`Math.round(x*10)/10`)
 *  — heurística que evita reaccionar a diferencias de gramos por semana,
 *  no precisión científica. `Math.round` puede producir `-0` para un
 *  valor negativo pequeño (p. ej. -0.02 -> -0). Se normaliza
 *  explícitamente a `0`: ningún resultado público de este kernel contiene
 *  `-0`. No cambia la resolución ni la paridad de clasificación frente a
 *  v3.1 — es puramente representacional. */
function classifyRatePctPerWeek(weeklyChangePercent: number): number {
  const rounded = Math.round(weeklyChangePercent * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function evidenceSummaryFrom(weight: AdaptiveWeightEvidence, intake: AdaptiveIntakeEvidence): AdaptiveEvidenceSummary {
  return { weight, intake };
}

// ─── Punto de entrada ────────────────────────────────────────────────────

export function evaluateAdaptiveReview(input: AdaptiveReviewInput): AdaptiveReviewResult {
  const raw: unknown = input;
  if (!isPlainRecord(raw)) {
    return invalidInput(["input_object_invalid"]);
  }

  // ─── Fase A — SEGURIDAD ───────────────────────────────────────────────
  // Única fase que puede ganar sin validar el resto: una señal de
  // seguridad VÁLIDA prevalece sobre cualquier error no relacionado en
  // otra parte de la entrada. Un autoinforme malformado NUNCA participa
  // aquí — solo contribuye a invalid_input más abajo, si nada más gana.
  const selfReportClassification = classifySelfReport(raw.selfReport);
  const strategyClassification = classifyStrategy(raw.strategy);

  const stopReasons: AdaptiveStopReason[] = [];
  if (selfReportClassification.valid) stopReasons.push(...selfReportClassification.stopReasons);
  const strategyIsStop = strategyClassification.kind === "stop";
  if (strategyIsStop) stopReasons.push(...strategyClassification.reasons);

  if (stopReasons.length > 0) {
    return {
      status: "stop_and_recommend_review",
      reasons: canonicalizeStop(stopReasons),
      strategySafetyAudit: strategyIsStop ? strategyClassification.safetyAudit : null,
    };
  }

  // ─── Fase B — FORMA + RELACIONES INTERNAS + POLÍTICA DE VENTANA ──────
  const invalidReasons = new Set<AdaptiveReviewInvalidReason>();

  const referenceDateKeyRaw = raw.referenceDateKey;
  const referenceDateKeyValid = isValidDateKey(referenceDateKeyRaw);
  if (!referenceDateKeyValid) invalidReasons.add("reference_date_key_invalid");
  const referenceDateKey: string | null = referenceDateKeyValid ? referenceDateKeyRaw : null;

  const baseline = validateBaseline(raw.baseline, referenceDateKey, invalidReasons);
  const reviewHistory = validateReviewHistory(raw.reviewHistory, referenceDateKey, invalidReasons);

  if (!selfReportClassification.valid) invalidReasons.add("self_report_invalid");
  if (strategyClassification.kind === "malformed") invalidReasons.add("strategy_result_malformed");

  const weightClassification = classifyWeightTrend(raw.weightTrend, referenceDateKey);
  if (weightClassification.kind === "malformed") invalidReasons.add("weight_trend_result_malformed");
  if (weightClassification.kind === "window_off_policy") invalidReasons.add("weight_window_not_policy");

  const intakeClassification = classifyIntakeCoverage(raw.intakeCoverage, referenceDateKey);
  if (intakeClassification.kind === "malformed") invalidReasons.add("intake_coverage_result_malformed");
  if (intakeClassification.kind === "window_off_policy") invalidReasons.add("intake_window_not_policy");

  const exerciseClassification = classifyExercisePerformance(raw.exercisePerformance);
  if (exerciseClassification.kind === "malformed") invalidReasons.add("exercise_performance_result_malformed");

  if (invalidReasons.size > 0) {
    return invalidInput(invalidReasons);
  }

  // A partir de aquí: referenceDateKey, baseline y reviewHistory son
  // no-nulos (si alguno hubiera fallado, ya se habría añadido una razón
  // arriba); weightClassification/intakeClassification tienen
  // kind==="ok"; exerciseClassification no es "malformed".
  if (referenceDateKey === null || baseline === null || reviewHistory === null || weightClassification.kind !== "ok" || intakeClassification.kind !== "ok" || exerciseClassification.kind === "malformed") {
    throw new Error("Adaptive Coordinator — invariante interno: datos inválidos sobrevivieron a la Fase B");
  }

  const weightEvidence = weightClassification.evidence;
  const intakeEvidence = intakeClassification.evidence;
  const context: AdaptiveReviewContext = {
    calibrationBaselineDateKey: baseline.calibrationBaselineDateKey,
    performance: exerciseContextFrom(exerciseClassification),
  };

  // ─── Fase C — APLAZAMIENTO ────────────────────────────────────────────
  const deferralReasons = new Set<AdaptiveDeferralReason>();
  let strategyOk: Extract<typeof strategyClassification, { kind: "ok" }> | null = null;

  if (strategyClassification.kind === "not_ok") {
    deferralReasons.add(strategyClassification.reason);
  } else if (strategyClassification.kind === "ok") {
    strategyOk = strategyClassification;
    if (baseline.weeklyKcalTargetInForce !== strategyClassification.weeklyKcalTargetInForce) {
      deferralReasons.add("baseline_target_mismatch");
    }
  }
  if (reviewHistory.pendingProposalId !== null) {
    deferralReasons.add("proposal_pending_decision");
  }
  let reviewIntervalDaysRemaining: number | null = null;
  if (reviewHistory.lastResolvedOnDateKey !== null) {
    const diff = daysBetweenDateKeys(reviewHistory.lastResolvedOnDateKey, referenceDateKey);
    if (diff < POLICY_SNAPSHOT.reviewIntervalDays) {
      deferralReasons.add("review_interval_active");
      reviewIntervalDaysRemaining = POLICY_SNAPSHOT.reviewIntervalDays - diff;
    }
  }

  if (deferralReasons.size > 0) {
    return {
      status: "deferred",
      reasons: canonicalizeDeferral(deferralReasons),
      reviewIntervalDaysRemaining,
      evidence: evidenceSummaryFrom(weightEvidence, intakeEvidence),
    };
  }

  // Si strategyClassification.kind fuera "not_ok" ya habría producido
  // deferred arriba (siempre añade una razón) — llegar aquí garantiza
  // "ok".
  if (!strategyOk) {
    throw new Error("Adaptive Coordinator — invariante interno: se esperaba strategy 'ok' tras superar la Fase C");
  }

  // ─── Fase D — EVIDENCIA ───────────────────────────────────────────────
  const insufficiencyReasons = new Set<AdaptiveInsufficiencyReason>();

  if (weightEvidence.status === "invalid_input") {
    insufficiencyReasons.add("weight_trend_unavailable");
  } else if (weightEvidence.status === "insufficient_data") {
    insufficiencyReasons.add("weight_trend_insufficient_data");
  } else {
    if (weightEvidence.trendQualityLevel !== POLICY_SNAPSHOT.requiredWeightTrendQualityLevel) {
      insufficiencyReasons.add("weight_trend_quality_not_high");
    }
    if (weightEvidence.measurementsInWindow < POLICY_SNAPSHOT.minWeightMeasurementsForProposal) {
      insufficiencyReasons.add("weight_measurements_below_minimum");
    }
  }

  if (intakeEvidence.status === "invalid_input") {
    insufficiencyReasons.add("intake_coverage_unavailable");
  } else {
    if (intakeEvidence.recordsWithTargetCount !== intakeEvidence.loggedDays) {
      insufficiencyReasons.add("intake_records_missing_daily_targets");
    }
    if (intakeEvidence.plausibleCoverageFraction < POLICY_SNAPSHOT.minIntakePlausibleCoverageFraction) {
      insufficiencyReasons.add("intake_plausible_coverage_below_minimum");
    }
  }

  if (insufficiencyReasons.size > 0) {
    return {
      status: "insufficient_evidence",
      reasons: canonicalizeInsufficiency(insufficiencyReasons),
      evidence: evidenceSummaryFrom(weightEvidence, intakeEvidence),
      context,
      policy: POLICY_SNAPSHOT,
    };
  }

  // ─── Fase E — CLASIFICACIÓN ───────────────────────────────────────────
  // weightEvidence.status === "evaluated" garantizado: si no lo fuera, ya
  // habría producido insufficient_evidence arriba.
  if (weightEvidence.status !== "evaluated") {
    throw new Error("Adaptive Coordinator — invariante interno: se esperaba weightTrend evaluado tras superar la Fase D");
  }
  const classifiedRatePctPerWeek = classifyRatePctPerWeek(weightEvidence.weeklyChangePercent);
  const band = strategyOk.band;

  if (classifiedRatePctPerWeek >= band.minPct && classifiedRatePctPerWeek <= band.maxPct) {
    return {
      status: "keep_targets",
      reasons: ["rate_within_expected_band"],
      classifiedRatePctPerWeek,
      desiredBandPctPerWeek: band,
      evidence: evidenceSummaryFrom(weightEvidence, intakeEvidence),
      context,
      policy: POLICY_SNAPSHOT,
    };
  }

  // ─── Fase F — CONSTRUCCIÓN DE LA PROPUESTA ────────────────────────────
  // Único lugar donde puede aparecer derived_numeric_result_invalid: es un
  // error TARDÍO que depende de la dirección ya conocida del ajuste.
  // weeklyKcalTargetInForce NO se acota artificialmente a > stepKcalPerDay
  // en la Fase B — PR2B admite objetivos semanales pequeños como entrada
  // real (su propia prueba "caso 4" usa 10/4 kcal semanales); el suelo
  // positivo se descubre aquí, cuando ya se conoce la dirección real.
  const rateBandPosition: "below_band" | "above_band" = classifiedRatePctPerWeek < band.minPct ? "below_band" : "above_band";
  // POLICY_SNAPSHOT.stepKcalPerDay es la misma constante 100 — se repite
  // aquí como literal porque el signo (+/-) de un paso fijo no puede
  // derivarse de una propiedad de tipo `100` sin ensanchar a `number`.
  const deltaKcalPerDay: -100 | 100 = rateBandPosition === "below_band" ? 100 : -100;
  const deltaKcalPerWeek: -700 | 700 = deltaKcalPerDay === 100 ? 700 : -700;
  const proposedWeeklyKcalTarget = baseline.weeklyKcalTargetInForce + deltaKcalPerWeek;

  if (!Number.isFinite(proposedWeeklyKcalTarget) || !Number.isSafeInteger(proposedWeeklyKcalTarget) || proposedWeeklyKcalTarget <= 0) {
    return invalidInput(["derived_numeric_result_invalid"]);
  }

  return {
    status: "adjustment_proposal",
    rateBandPosition,
    classifiedRatePctPerWeek,
    desiredBandPctPerWeek: band,
    deltaKcalPerDay,
    deltaKcalPerWeek,
    currentWeeklyKcalTarget: baseline.weeklyKcalTargetInForce,
    proposedWeeklyKcalTarget,
    currentDailyAverageKcal: baseline.weeklyKcalTargetInForce / 7,
    proposedDailyAverageKcal: proposedWeeklyKcalTarget / 7,
    confidence: "moderate",
    evidence: evidenceSummaryFrom(weightEvidence, intakeEvidence),
    context,
    policy: POLICY_SNAPSHOT,
    basis: {
      policyVersion: POLICY_SNAPSHOT.version,
      referenceDateKey,
      targetVersionId: baseline.targetVersionId,
      weeklyKcalTargetInForce: baseline.weeklyKcalTargetInForce,
      strategyObjective: strategyOk.objective,
      strategyPriority: strategyOk.priority,
      strategyVersionId: baseline.strategyVersionId,
      calibrationBaselineDateKey: baseline.calibrationBaselineDateKey,
      lastResolvedOnDateKey: reviewHistory.lastResolvedOnDateKey,
      pendingProposalIdObserved: null,
    },
    requiresNutritionReplan: true,
    requiresExplicitUserAcceptance: true,
  };
}
