import type {
  IntakeLoggingCoverageEvaluated,
  IntakeLoggingCoverageInput,
  IntakeLoggingCoverageInvalidInput,
  IntakeLoggingCoverageInvalidReason,
  IntakeLoggingCoverageResult,
} from "@foodos/types";

// Heurística de plausibilidad heredada de v3.1: producto, no evidencia.
const MIN_LOGGED_KCAL = 500;
const MIN_FRACTION_OF_DAY_TARGET = 0.6;

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
  "records_not_array",
  "record_object_invalid",
  "record_date_key_invalid",
  "record_logged_kcal_invalid",
  "record_target_kcal_invalid",
  "record_date_key_duplicate",
  "derived_numeric_result_invalid",
] as const satisfies readonly IntakeLoggingCoverageInvalidReason[];

// Exhaustividad comprobada por el compilador. `satisfies` impide que la tabla
// contenga algo ajeno a la unión; `MustBeNever` impide que le falte una variante:
// si la unión gana una razón que la tabla no ordena, esta línea deja de compilar y
// el error nombra la razón que falta.
type MustBeNever<T extends never> = T;
type _EveryReasonIsOrdered = MustBeNever<
  Exclude<IntakeLoggingCoverageInvalidReason, (typeof INVALID_REASON_ORDER)[number]>
>;

function invalidInput(reasons: Iterable<IntakeLoggingCoverageInvalidReason>): IntakeLoggingCoverageInvalidInput {
  const pending = new Set(reasons);
  const ordered: IntakeLoggingCoverageInvalidReason[] = [];
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
// Sentinela interno: nunca escapa de calculateIntakeLoggingCoverage.

class NonFiniteDerivedValueError extends Error {}

function assertFinite(value: number): number {
  if (!Number.isFinite(value)) throw new NonFiniteDerivedValueError();
  return value;
}

// ─── Validación por fases (1 a 5) ───────────────────────────────────────

interface WindowedRecord {
  readonly dateKey: string;
  readonly loggedKcal: number;
  readonly targetKcalForDay: number | null;
}

interface ValidatedRequest {
  readonly startDateKey: string;
  readonly endDateKey: string;
  readonly records: readonly WindowedRecord[];
}

function validateRequest(input: unknown): IntakeLoggingCoverageInvalidInput | ValidatedRequest {
  // Fase 1: forma superior y ventana.
  if (!isRecordObject(input)) return invalidInput(["input_object_invalid"]);
  const topLevelReasons: IntakeLoggingCoverageInvalidReason[] = [];
  const startOk = isValidCalendarDateKey(input.startDateKey);
  if (!startOk) topLevelReasons.push("start_date_key_invalid");
  const endOk = isValidCalendarDateKey(input.endDateKey);
  if (!endOk) topLevelReasons.push("end_date_key_invalid");
  if (startOk && endOk && compareDateKeys(input.startDateKey as string, input.endDateKey as string) > 0) {
    topLevelReasons.push("date_window_order_invalid");
  }
  if (!Array.isArray(input.records)) topLevelReasons.push("records_not_array");
  if (topLevelReasons.length > 0) return invalidInput(topLevelReasons);

  const startDateKey = input.startDateKey as string;
  const endDateKey = input.endDateKey as string;
  const rawRecords = input.records as unknown[];

  // Fase 2: cada fila, entera, es un objeto con dateKey real. Una fecha
  // inválida invalida siempre: sin ella no se puede decidir si la fila cae
  // dentro de la ventana, y el resto de sus campos no se evalúa.
  const shallowReasons = new Set<IntakeLoggingCoverageInvalidReason>();
  const shallowRows: Array<{ raw: Record<string, unknown>; dateKey: string }> = [];
  for (const rawRow of rawRecords) {
    if (!isRecordObject(rawRow)) {
      shallowReasons.add("record_object_invalid");
      continue;
    }
    if (!isValidCalendarDateKey(rawRow.dateKey)) {
      shallowReasons.add("record_date_key_invalid");
      continue;
    }
    shallowRows.push({ raw: rawRow, dateKey: rawRow.dateKey });
  }
  if (shallowReasons.size > 0) return invalidInput(shallowReasons);

  // Fase 3: selección por ventana. Lo que queda fuera no se examina más.
  const inWindow = shallowRows.filter(
    (row) => compareDateKeys(row.dateKey, startDateKey) >= 0 && compareDateKeys(row.dateKey, endDateKey) <= 0,
  );

  // Fases 4 y 5: valores, objetivo y duplicados, solo dentro de la ventana.
  const deepReasons = new Set<IntakeLoggingCoverageInvalidReason>();
  const seenDateKeys = new Set<string>();
  const records: WindowedRecord[] = [];
  for (const row of inWindow) {
    const loggedKcal = row.raw.loggedKcal;
    const target = row.raw.targetKcalForDay;
    const loggedOk = typeof loggedKcal === "number" && Number.isFinite(loggedKcal) && loggedKcal >= 0;
    const targetOk = target === null || (typeof target === "number" && Number.isFinite(target) && target > 0);
    if (!loggedOk) deepReasons.add("record_logged_kcal_invalid");
    if (!targetOk) deepReasons.add("record_target_kcal_invalid");
    if (loggedOk && targetOk) {
      records.push({ dateKey: row.dateKey, loggedKcal, targetKcalForDay: target });
    }
    if (seenDateKeys.has(row.dateKey)) deepReasons.add("record_date_key_duplicate");
    seenDateKeys.add(row.dateKey);
  }
  if (deepReasons.size > 0) return invalidInput(deepReasons);

  return { startDateKey, endDateKey, records };
}

// ─── Fases 6 y 7: cálculo con verificación de rango seguro ──────────────

function isPlausible(record: WindowedRecord): boolean {
  return (
    record.loggedKcal >= MIN_LOGGED_KCAL &&
    (record.targetKcalForDay === null || record.loggedKcal >= record.targetKcalForDay * MIN_FRACTION_OF_DAY_TARGET)
  );
}

function computeEvaluated(request: ValidatedRequest): IntakeLoggingCoverageEvaluated {
  // Días de calendario de la ventana: una resta, sin enumerar fechas.
  const eligibleCalendarDays = dayNumber(request.endDateKey) - dayNumber(request.startDateKey) + 1;

  // La suma sigue el orden cronológico ascendente, no el orden recibido.
  const chronological = [...request.records].sort((a, b) => compareDateKeys(a.dateKey, b.dateKey));
  let loggedDays = 0;
  let plausibleDays = 0;
  let recordsWithTargetCount = 0;
  let plausibleLoggedKcalTotal = 0;
  for (const record of chronological) {
    loggedDays += 1;
    if (record.targetKcalForDay !== null) recordsWithTargetCount += 1;
    if (isPlausible(record)) {
      plausibleDays += 1;
      plausibleLoggedKcalTotal = assertFinite(plausibleLoggedKcalTotal + record.loggedKcal);
    }
  }

  return {
    status: "evaluated",
    windowStartDateKey: request.startDateKey,
    windowEndDateKey: request.endDateKey,
    eligibleCalendarDays,
    loggedDays,
    plausibleDays,
    recordsWithTargetCount,
    loggingPresenceFraction: assertFinite(loggedDays / eligibleCalendarDays),
    plausibleCoverageFraction: assertFinite(plausibleDays / eligibleCalendarDays),
    plausibleLoggedKcalTotal,
    averagePlausibleLoggedKcal: plausibleDays > 0 ? assertFinite(plausibleLoggedKcalTotal / plausibleDays) : null,
    plausibilityHeuristic: {
      minLoggedKcal: MIN_LOGGED_KCAL,
      minFractionOfDayTarget: MIN_FRACTION_OF_DAY_TARGET,
      comparison: "inclusive",
      provenance: "heuristic_inherited_from_v3_1",
    },
    intakeAccuracy: "unknown",
  };
}

// ─── API pública ─────────────────────────────────────────────────────────

/** Cobertura del REGISTRO de ingesta en una ventana explícita: presencia y
    plausibilidad de los registros. No mide la exactitud de lo registrado. */
export function calculateIntakeLoggingCoverage(input: IntakeLoggingCoverageInput): IntakeLoggingCoverageResult {
  const validated = validateRequest(input);
  if ("status" in validated) return validated;

  try {
    return computeEvaluated(validated);
  } catch (error) {
    if (error instanceof NonFiniteDerivedValueError) return invalidInput(["derived_numeric_result_invalid"]);
    throw error;
  }
}
