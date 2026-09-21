import type {
  WeightTrendEstimateEvaluated,
  WeightTrendEstimateInput,
  WeightTrendEstimateInsufficientData,
  WeightTrendEstimateInvalidInput,
  WeightTrendEstimateInvalidReason,
  WeightTrendEstimateResult,
  WeightTrendQualityLevel,
  WeightTrendWindowCoverage,
} from "@foodos/types";

// Constantes heredadas de v3.1: heurísticas de producto, no evidencia.
const MINIMUM_MEASUREMENTS = 3;
// Ventana centrada de la mediana móvil: tamaño impar. Es la única fuente del 3: de
// aquí salen los límites de cada ventana y el valor que se informa en `smoothing`.
const MEDIAN_WINDOW_SIZE = 3;
const MEDIAN_HALF_WIDTH = (MEDIAN_WINDOW_SIZE - 1) / 2;
const EWMA_ALPHA = 0.2;
const QUANTITY_TARGET_COUNT = 14;
const SPAN_TARGET_DAYS = 21;
const HIGH_MIN_COMBINED_SCORE = 0.85;
const MODERATE_MIN_COMBINED_SCORE = 0.65;
const FLAT_SERIES_EPSILON_KG_SQUARED = 1e-6;
const DAYS_PER_WEEK = 7;

// ─── Guardas de forma ───────────────────────────────────────────────────

/** Objeto no nulo y no array. No comprueba el prototipo: instancias de clase u
    objetos de otro realm también valen, porque este contrato solo necesita leer
    propiedades. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Fechas: YYYY-MM-DD estricto, año 0001–9999, sin Date ───────────────

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidCalendarDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1) return false;
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

/** Días desde 1970-01-01 en el calendario gregoriano proléptico, con
    aritmética entera (days_from_civil de Hinnant). Sobre el dominio
    0001-01-01…9999-12-31 el resultado va de -719162 a 2932896, así que
    ninguna resta de dos días puede salirse del rango de enteros seguros. */
function dayNumber(dateKey: string): number {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const shiftedMonth = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Comparación ordinal explícita; para dateKey válidas equivale al orden
    cronológico. */
function compareDateKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── Canonicalización de razones inválidas ──────────────────────────────

/** Orden canónico de `reasons`; coincide con el orden de declaración de la unión. */
const INVALID_REASON_ORDER = [
  "input_object_invalid",
  "start_date_key_invalid",
  "end_date_key_invalid",
  "date_window_order_invalid",
  "measurements_not_array",
  "measurement_object_invalid",
  "measurement_date_key_invalid",
  "measurement_weight_invalid",
  "measurement_date_key_duplicate",
  "derived_numeric_result_invalid",
] as const satisfies readonly WeightTrendEstimateInvalidReason[];

// Exhaustividad comprobada por el compilador. `satisfies` impide que la tabla
// contenga algo ajeno a la unión; `MustBeNever` impide que le falte una variante:
// si la unión gana una razón que la tabla no ordena, esta línea deja de compilar y
// el error nombra la razón que falta.
type MustBeNever<T extends never> = T;
type _EveryReasonIsOrdered = MustBeNever<
  Exclude<WeightTrendEstimateInvalidReason, (typeof INVALID_REASON_ORDER)[number]>
>;

function invalidInput(reasons: Iterable<WeightTrendEstimateInvalidReason>): WeightTrendEstimateInvalidInput {
  const pending = new Set(reasons);
  const ordered: WeightTrendEstimateInvalidReason[] = [];
  for (const reason of INVALID_REASON_ORDER) {
    // `delete` devuelve true solo la primera vez: cada razón sale una vez, en orden canónico.
    if (pending.delete(reason)) ordered.push(reason);
  }
  const [first, ...rest] = ordered;
  // Invariante interna, inalcanzable por la API pública: todos los llamadores aportan
  // al menos una razón de la unión. Si dejara de cumplirse (p. ej. una razón nueva que
  // la tabla no ordena) falla aquí a la vista, en lugar de devolver `reasons: []`.
  if (first === undefined) throw new Error("invalidInput requiere al menos una razón ordenable");
  return { status: "invalid_input", reasons: [first, ...rest] };
}

// ─── Desbordamiento de valores derivados ────────────────────────────────
// Sentinela interno: nunca escapa de calculateWeightTrend.

class NonFiniteDerivedValueError extends Error {}

function assertFinite(value: number): number {
  if (!Number.isFinite(value)) throw new NonFiniteDerivedValueError();
  return value;
}

// ─── Validación por fases (1 a 5) ───────────────────────────────────────

interface WindowedMeasurement {
  readonly dateKey: string;
  readonly kg: number;
}

interface ValidatedRequest {
  readonly startDateKey: string;
  readonly endDateKey: string;
  readonly measurements: readonly WindowedMeasurement[];
}

function validateRequest(input: unknown): WeightTrendEstimateInvalidInput | ValidatedRequest {
  // Fase 1: forma superior y ventana.
  if (!isRecordObject(input)) return invalidInput(["input_object_invalid"]);
  const topLevelReasons: WeightTrendEstimateInvalidReason[] = [];
  const startOk = isValidCalendarDateKey(input.startDateKey);
  if (!startOk) topLevelReasons.push("start_date_key_invalid");
  const endOk = isValidCalendarDateKey(input.endDateKey);
  if (!endOk) topLevelReasons.push("end_date_key_invalid");
  if (startOk && endOk && compareDateKeys(input.startDateKey as string, input.endDateKey as string) > 0) {
    topLevelReasons.push("date_window_order_invalid");
  }
  if (!Array.isArray(input.measurements)) topLevelReasons.push("measurements_not_array");
  if (topLevelReasons.length > 0) return invalidInput(topLevelReasons);

  const startDateKey = input.startDateKey as string;
  const endDateKey = input.endDateKey as string;
  const rawMeasurements = input.measurements as unknown[];

  // Fase 2: cada fila, entera, es un objeto con dateKey real. Una fecha
  // inválida invalida siempre: sin ella no se puede decidir si la fila cae
  // dentro de la ventana, y el resto de sus campos no se evalúa.
  const shallowReasons = new Set<WeightTrendEstimateInvalidReason>();
  const shallowRows: Array<{ raw: Record<string, unknown>; dateKey: string }> = [];
  for (const rawRow of rawMeasurements) {
    if (!isRecordObject(rawRow)) {
      shallowReasons.add("measurement_object_invalid");
      continue;
    }
    if (!isValidCalendarDateKey(rawRow.dateKey)) {
      shallowReasons.add("measurement_date_key_invalid");
      continue;
    }
    shallowRows.push({ raw: rawRow, dateKey: rawRow.dateKey });
  }
  if (shallowReasons.size > 0) return invalidInput(shallowReasons);

  // Fase 3: selección por ventana. Lo que queda fuera no se examina más.
  const inWindow = shallowRows.filter(
    (row) => compareDateKeys(row.dateKey, startDateKey) >= 0 && compareDateKeys(row.dateKey, endDateKey) <= 0,
  );

  // Fases 4 y 5: valores y duplicados, solo dentro de la ventana.
  const deepReasons = new Set<WeightTrendEstimateInvalidReason>();
  const seenDateKeys = new Set<string>();
  const measurements: WindowedMeasurement[] = [];
  for (const row of inWindow) {
    const kg = row.raw.kg;
    if (typeof kg !== "number" || !Number.isFinite(kg) || kg <= 0) {
      deepReasons.add("measurement_weight_invalid");
    } else {
      measurements.push({ dateKey: row.dateKey, kg });
    }
    if (seenDateKeys.has(row.dateKey)) deepReasons.add("measurement_date_key_duplicate");
    seenDateKeys.add(row.dateKey);
  }
  if (deepReasons.size > 0) return invalidInput(deepReasons);

  return { startDateKey, endDateKey, measurements };
}

// ─── Fases 6 y 7: cálculo con verificación de rango seguro ──────────────

function medianOfWindow(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function sumInOrder(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return assertFinite(total);
}

function qualityLevelOf(combinedScore: number): WeightTrendQualityLevel {
  if (combinedScore >= HIGH_MIN_COMBINED_SCORE) return "high";
  if (combinedScore >= MODERATE_MIN_COMBINED_SCORE) return "moderate";
  return "low";
}

function computeEvaluated(
  sorted: readonly WindowedMeasurement[],
  coverage: WeightTrendWindowCoverage,
): WeightTrendEstimateEvaluated {
  const count = sorted.length;

  // Mediana móvil centrada de MEDIAN_WINDOW_SIZE valores, recortada en los extremos
  // (con tamaño 3 hay solo 2 valores en la primera y la última medición).
  const medians = sorted.map((_row, index) => {
    const windowStart = Math.max(0, index - MEDIAN_HALF_WIDTH);
    const windowEnd = Math.min(count, index + MEDIAN_HALF_WIDTH + 1);
    const windowValues = sorted.slice(windowStart, windowEnd).map((row) => row.kg);
    return assertFinite(medianOfWindow(windowValues));
  });

  // EWMA, inicializada con el primer punto ya suavizado por la mediana.
  const ewma: number[] = [medians[0]];
  let current = medians[0];
  for (let index = 1; index < count; index++) {
    current = assertFinite(EWMA_ALPHA * medians[index] + (1 - EWMA_ALPHA) * current);
    ewma.push(current);
  }

  // Regresión por mínimos cuadrados sobre días de calendario reales.
  const firstDay = dayNumber(sorted[0].dateKey);
  const days = sorted.map((row) => dayNumber(row.dateKey) - firstDay);
  const dayMean = assertFinite(sumInOrder(days) / count);
  const ewmaMean = assertFinite(sumInOrder(ewma) / count);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index++) {
    numerator += (days[index] - dayMean) * (ewma[index] - ewmaMean);
    denominator += (days[index] - dayMean) ** 2;
  }
  assertFinite(numerator);
  assertFinite(denominator);
  // Con fechas distintas y count >= 3, denominator >= 2: nunca es cero.
  const slopeKgPerDay = assertFinite(numerator / denominator);

  const trendWeightKg = ewma[count - 1];
  const weeklyChangeKg = assertFinite(slopeKgPerDay * DAYS_PER_WEEK);
  const weeklyChangePercent = assertFinite((weeklyChangeKg / trendWeightKg) * 100);

  // Componentes de calidad.
  const spanDays = days[count - 1];
  const quantityScore = Math.min(1, count / QUANTITY_TARGET_COUNT);
  const temporalCoverageScore = Math.min(1, spanDays / SPAN_TARGET_DAYS);

  // Con fechas distintas, meanGap >= 1: nunca es cero.
  const meanGap = spanDays / (count - 1);
  let gapSquares = 0;
  for (let index = 1; index < count; index++) {
    gapSquares += (days[index] - days[index - 1] - meanGap) ** 2;
  }
  const gapVariance = assertFinite(gapSquares / (count - 1));
  const regularityScore = assertFinite(Math.max(0, 1 - Math.sqrt(gapVariance) / meanGap));

  let totalSquares = 0;
  for (const value of ewma) totalSquares += (value - ewmaMean) ** 2;
  assertFinite(totalSquares);
  let fitScore = 1;
  if (totalSquares > FLAT_SERIES_EPSILON_KG_SQUARED) {
    let residualSquares = 0;
    for (let index = 0; index < count; index++) {
      const predicted = ewmaMean + slopeKgPerDay * (days[index] - dayMean);
      residualSquares += (ewma[index] - predicted) ** 2;
    }
    assertFinite(residualSquares);
    fitScore = assertFinite(Math.max(0, Math.min(1, 1 - residualSquares / totalSquares)));
  }

  const combinedScore = assertFinite((quantityScore + temporalCoverageScore + regularityScore + fitScore) / 4);

  return {
    status: "evaluated",
    coverage,
    measurementSpanDays: spanDays,
    latestWeightKg: sorted[count - 1].kg,
    trendWeightKg,
    slopeKgPerDay,
    weeklyChangeKg,
    weeklyChangePercent,
    qualityComponents: { quantityScore, temporalCoverageScore, regularityScore, fitScore, combinedScore },
    trendQualityLevel: qualityLevelOf(combinedScore),
    qualityModel: {
      quantityTargetCount: QUANTITY_TARGET_COUNT,
      spanTargetDays: SPAN_TARGET_DAYS,
      highMinCombinedScore: HIGH_MIN_COMBINED_SCORE,
      moderateMinCombinedScore: MODERATE_MIN_COMBINED_SCORE,
      flatSeriesEpsilonKgSquared: FLAT_SERIES_EPSILON_KG_SQUARED,
      provenance: "heuristic_inherited_from_v3_1",
    },
    smoothing: {
      medianWindowSize: MEDIAN_WINDOW_SIZE,
      ewmaAlpha: EWMA_ALPHA,
      provenance: "heuristic_inherited_from_v3_1",
    },
  };
}

// ─── API pública ─────────────────────────────────────────────────────────

/** Tendencia de peso ESTIMADA (mediana móvil, EWMA y regresión heredadas de
    v3.1) sobre una ventana explícita. No es una medición del peso real. */
export function calculateWeightTrend(input: WeightTrendEstimateInput): WeightTrendEstimateResult {
  const validated = validateRequest(input);
  if ("status" in validated) return validated;

  const sorted = [...validated.measurements].sort((a, b) => compareDateKeys(a.dateKey, b.dateKey));
  // Fase 8 (ensamblado): la cobertura no depende del cálculo.
  const coverage: WeightTrendWindowCoverage = {
    windowStartDateKey: validated.startDateKey,
    windowEndDateKey: validated.endDateKey,
    windowCalendarDays: dayNumber(validated.endDateKey) - dayNumber(validated.startDateKey) + 1,
    measurementsInWindow: sorted.length,
    minimumMeasurementsRequired: MINIMUM_MEASUREMENTS,
  };

  if (sorted.length < MINIMUM_MEASUREMENTS) {
    const insufficient: WeightTrendEstimateInsufficientData = {
      status: "insufficient_data",
      coverage,
      reasons: ["fewer_than_minimum_measurements_in_window"],
    };
    return insufficient;
  }

  try {
    return computeEvaluated(sorted, coverage);
  } catch (error) {
    if (error instanceof NonFiniteDerivedValueError) return invalidInput(["derived_numeric_result_invalid"]);
    throw error;
  }
}
