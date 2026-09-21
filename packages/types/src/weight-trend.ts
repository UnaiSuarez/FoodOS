// Nutrition Engine v4, PR5A — tendencia de peso estimada. Contrato de
// entrada normalizado propio y salida discriminada. Los nombres llevan el
// prefijo `WeightTrendEstimate` a propósito: el barrel ya exporta
// `WeightTrendResult` (v3.1) y una redeclaración local taparía en silencio
// cualquier `export *` homónimo.
//
// El kernel recibe una ventana explícita e inclusiva (`startDateKey` /
// `endDateKey`) y solo evalúa ese intervalo. Quién construye la ventana, y
// con qué criterio, queda fuera de este contrato.
//
// Suavizado y calidad son heurísticas heredadas de producto, no evidencia
// científica. `trendQualityLevel` describe la calidad de la serie de
// mediciones, nunca una confianza global en la estimación.

// ─── Entrada ────────────────────────────────────────────────────────────

export interface WeightTrendMeasurement {
  /** YYYY-MM-DD estricto, año 0001–9999, calendario gregoriano proléptico. */
  dateKey: string;
  /** Peso corporal en kg: finito y estrictamente positivo. */
  kg: number;
}

export interface WeightTrendEstimateInput {
  startDateKey: string;
  /** Inclusive. */
  endDateKey: string;
  measurements: readonly WeightTrendMeasurement[];
}

// ─── invalid_input ──────────────────────────────────────────────────────

/** El orden de declaración es el orden canónico de `reasons`. */
export type WeightTrendEstimateInvalidReason =
  | "input_object_invalid"
  | "start_date_key_invalid"
  | "end_date_key_invalid"
  | "date_window_order_invalid"
  | "measurements_not_array"
  | "measurement_object_invalid"
  | "measurement_date_key_invalid"
  | "measurement_weight_invalid"
  | "measurement_date_key_duplicate"
  | "derived_numeric_result_invalid";
export type NonEmptyWeightTrendEstimateInvalidReasons = [
  WeightTrendEstimateInvalidReason,
  ...WeightTrendEstimateInvalidReason[],
];

export interface WeightTrendEstimateInvalidInput {
  status: "invalid_input";
  /** Deduplicadas y en orden canónico, nunca en orden de descubrimiento. */
  reasons: NonEmptyWeightTrendEstimateInvalidReasons;
}

// ─── insufficient_data ──────────────────────────────────────────────────

export interface WeightTrendWindowCoverage {
  windowStartDateKey: string;
  windowEndDateKey: string;
  /** Días de calendario de la ventana, ambos extremos incluidos. */
  windowCalendarDays: number;
  /** Mediciones válidas dentro de la ventana; en `evaluated`, son las
      utilizadas por el cálculo. */
  measurementsInWindow: number;
  /** Mínimo heredado para calcular una tendencia (heurística de producto). */
  minimumMeasurementsRequired: number;
}

export type WeightTrendInsufficiencyReason = "fewer_than_minimum_measurements_in_window";

export interface WeightTrendEstimateInsufficientData {
  status: "insufficient_data";
  coverage: WeightTrendWindowCoverage;
  reasons: [WeightTrendInsufficiencyReason];
}

// ─── evaluated ──────────────────────────────────────────────────────────

export type WeightTrendQualityLevel = "low" | "moderate" | "high";

/** Cada componente está en [0, 1]. `combinedScore` es el promedio simple de
    los cuatro, sumados de izquierda a derecha en este orden. */
export interface WeightTrendQualityComponents {
  quantityScore: number;
  temporalCoverageScore: number;
  regularityScore: number;
  fitScore: number;
  combinedScore: number;
}

/** Constantes aplicadas, para que el resultado sea autodescriptivo. */
export interface WeightTrendQualityModel {
  quantityTargetCount: number;
  spanTargetDays: number;
  highMinCombinedScore: number;
  moderateMinCombinedScore: number;
  flatSeriesEpsilonKgSquared: number;
  provenance: "heuristic_inherited_from_v3_1";
}

export interface WeightTrendSmoothingModel {
  medianWindowSize: number;
  ewmaAlpha: number;
  provenance: "heuristic_inherited_from_v3_1";
}

/** Ningún valor está redondeado. Siempre trae una tendencia completa. */
export interface WeightTrendEstimateEvaluated {
  status: "evaluated";
  coverage: WeightTrendWindowCoverage;
  /** Días de calendario entre la primera y la última medición utilizadas. */
  measurementSpanDays: number;
  /** Peso crudo de la medición más reciente. */
  latestWeightKg: number;
  /** EWMA de la mediana móvil, en la medición más reciente. */
  trendWeightKg: number;
  slopeKgPerDay: number;
  /** slopeKgPerDay * 7. */
  weeklyChangeKg: number;
  /** (weeklyChangeKg / trendWeightKg) * 100, con trendWeightKg sin redondear. */
  weeklyChangePercent: number;
  qualityComponents: WeightTrendQualityComponents;
  trendQualityLevel: WeightTrendQualityLevel;
  qualityModel: WeightTrendQualityModel;
  smoothing: WeightTrendSmoothingModel;
}

export type WeightTrendEstimateResult =
  | WeightTrendEstimateInvalidInput
  | WeightTrendEstimateInsufficientData
  | WeightTrendEstimateEvaluated;
