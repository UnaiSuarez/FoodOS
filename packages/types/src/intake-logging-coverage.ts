// Nutrition Engine v4, PR5A — cobertura del REGISTRO de ingesta. Mide qué
// parte de una ventana explícita tiene registros y cuántos superan una
// heurística de plausibilidad heredada. No mide la exactitud de lo
// registrado: `intakeAccuracy` es siempre "unknown", también con cobertura
// completa.
//
// La ventana es explícita e inclusiva (`startDateKey` / `endDateKey`); los
// días de calendario sin registro cuentan como no registrados. El kernel no
// codifica ninguna longitud de ventana.

// ─── Entrada ────────────────────────────────────────────────────────────

export interface LoggedIntakeRecord {
  /** YYYY-MM-DD estricto, año 0001–9999, calendario gregoriano proléptico. */
  dateKey: string;
  /** kcal registradas ese día: finitas y >= 0 (un día registrado con 0 es
      un registro válido). */
  loggedKcal: number;
  /** Objetivo de ese día concreto; null si no hay objetivo. Si no es null:
      finito y estrictamente positivo. */
  targetKcalForDay: number | null;
}

export interface IntakeLoggingCoverageInput {
  startDateKey: string;
  /** Inclusive. */
  endDateKey: string;
  /** A lo sumo un registro por dateKey dentro de la ventana. */
  records: readonly LoggedIntakeRecord[];
}

// ─── invalid_input ──────────────────────────────────────────────────────

/** El orden de declaración es el orden canónico de `reasons`. */
export type IntakeLoggingCoverageInvalidReason =
  | "input_object_invalid"
  | "start_date_key_invalid"
  | "end_date_key_invalid"
  | "date_window_order_invalid"
  | "records_not_array"
  | "record_object_invalid"
  | "record_date_key_invalid"
  | "record_logged_kcal_invalid"
  | "record_target_kcal_invalid"
  | "record_date_key_duplicate"
  | "derived_numeric_result_invalid";
export type NonEmptyIntakeLoggingCoverageInvalidReasons = [
  IntakeLoggingCoverageInvalidReason,
  ...IntakeLoggingCoverageInvalidReason[],
];

export interface IntakeLoggingCoverageInvalidInput {
  status: "invalid_input";
  /** Deduplicadas y en orden canónico, nunca en orden de descubrimiento. */
  reasons: NonEmptyIntakeLoggingCoverageInvalidReasons;
}

// ─── evaluated ──────────────────────────────────────────────────────────

/** Heurística heredada de producto, no evidencia científica. Ambas
    comparaciones son inclusivas y el criterio relativo se evalúa como
    `loggedKcal >= targetKcalForDay * minFractionOfDayTarget`. */
export interface IntakeLoggingPlausibilityHeuristic {
  minLoggedKcal: number;
  minFractionOfDayTarget: number;
  comparison: "inclusive";
  provenance: "heuristic_inherited_from_v3_1";
}

/** Sin estado insufficient_data: las fracciones están definidas también con
    cero días plausibles. Invariante: 0 <= plausibleDays <= loggedDays <=
    eligibleCalendarDays. */
export interface IntakeLoggingCoverageEvaluated {
  status: "evaluated";
  windowStartDateKey: string;
  windowEndDateKey: string;
  /** Días de calendario de la ventana, ambos extremos incluidos. */
  eligibleCalendarDays: number;
  /** Días de la ventana con algún registro, incluidos los de 0 kcal. */
  loggedDays: number;
  /** Días registrados que superan la heurística de plausibilidad. */
  plausibleDays: number;
  /** Registros de la ventana con objetivo (criterio relativo aplicable). */
  recordsWithTargetCount: number;
  /** loggedDays / eligibleCalendarDays. Presencia de registro. */
  loggingPresenceFraction: number;
  /** plausibleDays / eligibleCalendarDays. */
  plausibleCoverageFraction: number;
  /** Suma de loggedKcal de los días plausibles, en orden cronológico
      ascendente por dateKey. */
  plausibleLoggedKcalTotal: number;
  /** plausibleLoggedKcalTotal / plausibleDays; null si plausibleDays es 0. */
  averagePlausibleLoggedKcal: number | null;
  plausibilityHeuristic: IntakeLoggingPlausibilityHeuristic;
  /** Literal fijo: la cobertura no dice nada sobre la exactitud. */
  intakeAccuracy: "unknown";
}

export type IntakeLoggingCoverageResult = IntakeLoggingCoverageInvalidInput | IntakeLoggingCoverageEvaluated;
