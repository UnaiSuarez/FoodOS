import type {
  DailyIntegrityEvaluated,
  DailyIntegrityInvalidInput,
  DailyIntegrityInvalidReason,
  DailyIntegrityResult,
  DailyIntegrityWindowInput,
  EnergyConsistency,
  FoodStateConfidence,
  NutrientCoverageResult,
  NutrientKey,
  NutrientValue,
} from "@foodos/types";

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

// ─── Nutrientes: claves y valores ────────────────────────────────────────

const NUTRIENT_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sugars", "salt"] as const satisfies readonly NutrientKey[];

function isValidNutrientKey(value: string): value is NutrientKey {
  return (NUTRIENT_KEYS as readonly string[]).includes(value);
}

/** Invariantes de `NutrientValue`: `value` es `null` si y solo si
    `status === "unknown"`; exactamente 0 para "known_zero"; estrictamente
    positivo para "known_nonzero"; finito y no negativo para el resto de
    estados con valor. */
function isValidNutrientValue(value: unknown): value is NutrientValue {
  if (!isRecordObject(value)) return false;
  const status = value.status;
  const raw = value.value;
  switch (status) {
    case "unknown":
      return raw === null;
    case "known_zero":
      return raw === 0;
    case "known_nonzero":
      return typeof raw === "number" && Number.isFinite(raw) && raw > 0;
    case "estimated":
    case "recipe_derived":
    case "imputed":
    case "legacy_unlabeled":
      return typeof raw === "number" && Number.isFinite(raw) && raw >= 0;
    default:
      return false;
  }
}

function isValidNutrientsMap(value: unknown): value is Partial<Record<NutrientKey, NutrientValue>> {
  if (!isRecordObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!isValidNutrientKey(key)) return false;
    if (!isValidNutrientValue(value[key])) return false;
  }
  return true;
}

function isValidQuantityConfidence(value: unknown): value is "high" | "low" {
  return value === "high" || value === "low";
}

function isValidFoodStateConfidence(value: unknown): value is FoodStateConfidence {
  return value === "confirmed" || value === "unknown" || value === "incompatible" || value === "not_applicable";
}

function isValidEnergyConsistency(value: unknown): value is EnergyConsistency {
  return value === "match" || value === "mismatch" || value === "not_evaluable";
}

function isValidUnitFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

// ─── Canonicalización de razones inválidas ──────────────────────────────

/** Orden canónico de `reasons`; coincide con el orden de declaración de la unión. */
const INVALID_REASON_ORDER = [
  "input_object_invalid",
  "start_date_key_invalid",
  "end_date_key_invalid",
  "date_window_order_invalid",
  "daily_reliability_threshold_invalid",
  "provisional_kcal_fraction_threshold_invalid",
  "entries_not_array",
  "entry_object_invalid",
  "entry_date_key_invalid",
  "entry_nutrients_invalid",
  "entry_quantity_confidence_invalid",
  "entry_food_state_confidence_invalid",
  "entry_energy_consistency_invalid",
  "derived_numeric_result_invalid",
] as const satisfies readonly DailyIntegrityInvalidReason[];

// Exhaustividad comprobada por el compilador. `satisfies` impide que la tabla
// contenga algo ajeno a la unión; `MustBeNever` impide que le falte una variante:
// si la unión gana una razón que la tabla no ordena, esta línea deja de compilar y
// el error nombra la razón que falta.
type MustBeNever<T extends never> = T;
type _EveryReasonIsOrdered = MustBeNever<Exclude<DailyIntegrityInvalidReason, (typeof INVALID_REASON_ORDER)[number]>>;

function invalidInput(reasons: Iterable<DailyIntegrityInvalidReason>): DailyIntegrityInvalidInput {
  const pending = new Set(reasons);
  const ordered: DailyIntegrityInvalidReason[] = [];
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
// Sentinela interno: nunca escapa de evaluateNutrientCoverage.

class NonFiniteDerivedValueError extends Error {}

function assertFinite(value: number): number {
  if (!Number.isFinite(value)) throw new NonFiniteDerivedValueError();
  return value;
}

// ─── Validación por fases ────────────────────────────────────────────────

interface ValidatedEntry {
  readonly dateKey: string;
  readonly nutrients: Partial<Record<NutrientKey, NutrientValue>>;
  readonly quantityConfidence: "high" | "low";
  readonly foodStateConfidence: FoodStateConfidence;
  readonly energyConsistency: EnergyConsistency;
}

interface ValidatedRequest {
  readonly startDateKey: string;
  readonly endDateKey: string;
  readonly entries: readonly ValidatedEntry[];
  readonly dailyReliabilityThreshold: number;
  readonly provisionalKcalFractionThreshold: number;
}

function validateRequest(input: unknown): DailyIntegrityInvalidInput | ValidatedRequest {
  // Fase 1: forma superior, ventana y umbrales.
  if (!isRecordObject(input)) return invalidInput(["input_object_invalid"]);
  const topLevelReasons: DailyIntegrityInvalidReason[] = [];
  const startOk = isValidCalendarDateKey(input.startDateKey);
  if (!startOk) topLevelReasons.push("start_date_key_invalid");
  const endOk = isValidCalendarDateKey(input.endDateKey);
  if (!endOk) topLevelReasons.push("end_date_key_invalid");
  if (startOk && endOk && compareDateKeys(input.startDateKey as string, input.endDateKey as string) > 0) {
    topLevelReasons.push("date_window_order_invalid");
  }
  const dailyReliabilityThresholdOk = isValidUnitFraction(input.dailyReliabilityThreshold);
  if (!dailyReliabilityThresholdOk) topLevelReasons.push("daily_reliability_threshold_invalid");
  const provisionalKcalFractionThresholdOk = isValidUnitFraction(input.provisionalKcalFractionThreshold);
  if (!provisionalKcalFractionThresholdOk) topLevelReasons.push("provisional_kcal_fraction_threshold_invalid");
  if (!Array.isArray(input.entries)) topLevelReasons.push("entries_not_array");
  if (topLevelReasons.length > 0) return invalidInput(topLevelReasons);

  const startDateKey = input.startDateKey as string;
  const endDateKey = input.endDateKey as string;
  const rawEntries = input.entries as unknown[];

  // Fase 2: cada fila, entera, es un objeto con dateKey real. Una fecha
  // inválida invalida siempre: sin ella no se puede decidir si la fila cae
  // dentro de la ventana, y el resto de sus campos no se evalúa todavía.
  const shallowReasons = new Set<DailyIntegrityInvalidReason>();
  const shallowRows: Array<{ raw: Record<string, unknown>; dateKey: string }> = [];
  for (const rawRow of rawEntries) {
    if (!isRecordObject(rawRow)) {
      shallowReasons.add("entry_object_invalid");
      continue;
    }
    if (!isValidCalendarDateKey(rawRow.dateKey)) {
      shallowReasons.add("entry_date_key_invalid");
      continue;
    }
    shallowRows.push({ raw: rawRow, dateKey: rawRow.dateKey });
  }
  if (shallowReasons.size > 0) return invalidInput(shallowReasons);

  // Fase 3: selección por ventana. Lo que queda fuera no se examina más —
  // mismo criterio que IntakeLoggingCoverageInput (PR5A).
  const inWindow = shallowRows.filter(
    (row) => compareDateKeys(row.dateKey, startDateKey) >= 0 && compareDateKeys(row.dateKey, endDateKey) <= 0,
  );

  // Fase 4: campos profundos, solo dentro de la ventana.
  const deepReasons = new Set<DailyIntegrityInvalidReason>();
  const entries: ValidatedEntry[] = [];
  for (const row of inWindow) {
    const nutrients = row.raw.nutrients;
    const quantityConfidence = row.raw.quantityConfidence;
    const foodStateConfidence = row.raw.foodStateConfidence;
    const energyConsistency = row.raw.energyConsistency;
    const nutrientsOk = isValidNutrientsMap(nutrients);
    const quantityOk = isValidQuantityConfidence(quantityConfidence);
    const foodStateOk = isValidFoodStateConfidence(foodStateConfidence);
    const energyOk = isValidEnergyConsistency(energyConsistency);
    if (!nutrientsOk) deepReasons.add("entry_nutrients_invalid");
    if (!quantityOk) deepReasons.add("entry_quantity_confidence_invalid");
    if (!foodStateOk) deepReasons.add("entry_food_state_confidence_invalid");
    if (!energyOk) deepReasons.add("entry_energy_consistency_invalid");
    if (nutrientsOk && quantityOk && foodStateOk && energyOk) {
      entries.push({ dateKey: row.dateKey, nutrients, quantityConfidence, foodStateConfidence, energyConsistency });
    }
  }
  if (deepReasons.size > 0) return invalidInput(deepReasons);

  return {
    startDateKey,
    endDateKey,
    entries,
    dailyReliabilityThreshold: input.dailyReliabilityThreshold as number,
    provisionalKcalFractionThreshold: input.provisionalKcalFractionThreshold as number,
  };
}

// ─── Cálculo ──────────────────────────────────────────────────────────────

/** Un kcal cuya MAGNITUD no está verificada — ausente, "unknown", o
    "legacy_unlabeled" (existe un número, pero nada garantiza que
    represente una medición real: puede venir de un "?? 0" de una fuente
    externa o de datos anteriores al etiquetado de procedencia) — nunca se
    usa como peso. Tener un número no hace fiable su magnitud. */
function isWeighableKcal(value: NutrientValue | undefined): boolean {
  return value != null && value.status !== "unknown" && value.status !== "legacy_unlabeled";
}

/** kcal de una entrada, usada como peso para ponderar cuánto representa esa
    entrada dentro del día — nunca para juzgar la fiabilidad del propio
    kcal. Una entrada cuyo kcal no es ponderable (ver isWeighableKcal) pesa
    0 en esta suma — pero eso NO significa que el día pueda tratarse como
    si esa entrada no existiera: ver isUnweighableEntry, que la fuerza a
    `provisionalDays` en vez de dejarla desaparecer sin más. */
function entryWeight(entry: ValidatedEntry): number {
  const kcal = entry.nutrients.kcal;
  return isWeighableKcal(kcal) ? (kcal!.value ?? 0) : 0;
}

/** Una entrada cuya contribución al día no puede pesarse (ver
    isWeighableKcal). Corrección de un fallo real: si esta entrada
    simplemente pesara 0 y se dejara fuera del denominador como si no
    existiera, otra entrada del mismo día con macros conocidas podría
    hacer que el día pareciera 100% fiable — pese a que la comida de
    magnitud desconocida podría representar cualquier fracción real del
    día. La regla conservadora es la contraria: la presencia de UNA sola
    entrada así basta para que el día NUNCA cuente como fiable para NINGÚN
    nutriente, y para que cuente como `provisionalDays` sin más
    condiciones — nunca la reduce ni la sustituye, solo la fuerza. */
function isUnweighableEntry(entry: ValidatedEntry): boolean {
  return !isWeighableKcal(entry.nutrients.kcal);
}

function isReliableNutrientValue(value: NutrientValue | undefined): boolean {
  return value != null && (value.status === "known_nonzero" || value.status === "known_zero");
}

function isReliableFoodState(confidence: FoodStateConfidence): boolean {
  return confidence === "confirmed" || confidence === "not_applicable";
}

function computeEvaluated(request: ValidatedRequest): DailyIntegrityEvaluated {
  // Días de calendario de la ventana: una resta, sin enumerar fechas.
  const windowDays = dayNumber(request.endDateKey) - dayNumber(request.startDateKey) + 1;

  const byDate = new Map<string, ValidatedEntry[]>();
  for (const entry of request.entries) {
    const existing = byDate.get(entry.dateKey);
    if (existing) existing.push(entry);
    else byDate.set(entry.dateKey, [entry]);
  }

  // unloggedDays: días de la ventana sin ninguna entrada. No hace falta
  // enumerar cada fecha — basta con contar cuántas fechas distintas SÍ
  // tienen alguna entrada y restar de windowDays. windowDays nunca cambia.
  const unloggedDays = windowDays - byDate.size;

  let legacyUnlabeledDays = 0;
  let provisionalDays = 0;
  const reliableDaysByNutrient = new Map<NutrientKey, number>(NUTRIENT_KEYS.map((key) => [key, 0]));

  for (const dayEntries of byDate.values()) {
    // legacy_unlabeled: cada NutrientValue presente en cada entrada del día
    // es "legacy_unlabeled" — y existe al menos uno (un día con entradas
    // pero sin ningún nutriente reportado en absoluto no cuenta: no hay
    // nada etiquetado como legacy, solo ausencia total de datos).
    let hasAnyNutrientValue = false;
    let allLegacy = true;
    for (const entry of dayEntries) {
      for (const key of NUTRIENT_KEYS) {
        const value = entry.nutrients[key];
        if (value === undefined) continue;
        hasAnyNutrientValue = true;
        if (value.status !== "legacy_unlabeled") allLegacy = false;
      }
    }
    if (hasAnyNutrientValue && allLegacy) {
      legacyUnlabeledDays += 1;
      continue; // legacy_unlabeled y provisional son mutuamente excluyentes para el día
    }

    // Regla conservadora explícita: si CUALQUIER entrada del día tiene un
    // kcal no ponderable (ausente, "unknown" o "legacy_unlabeled"), el día
    // se fuerza a provisional sin más condiciones y NO puede contar como
    // fiable para ningún nutriente esta iteración — con independencia de
    // lo que digan las entradas restantes, que sí son ponderables. La
    // fracción ponderada de esas otras entradas nunca se calcula para
    // decidir fiabilidad ese día: sería precisamente el error que esta
    // regla corrige (una comida de tamaño desconocido no debe poder
    // "desaparecer" del denominador).
    if (dayEntries.some(isUnweighableEntry)) {
      provisionalDays += 1;
      continue;
    }

    const totalWeight = assertFinite(dayEntries.reduce((sum, entry) => sum + entryWeight(entry), 0));
    if (totalWeight <= 0) {
      // Sin peso con el que ponderar: el día no puede ser fiable ni
      // provisional por esta vía (0/0 nunca se trata como "cumple el
      // umbral", ni siquiera con un umbral de 0 — no hay señal real).
      continue;
    }

    const provisionalWeight = assertFinite(
      dayEntries.reduce(
        (sum, entry) =>
          sum + (entry.quantityConfidence === "low" || entry.energyConsistency === "mismatch" ? entryWeight(entry) : 0),
        0,
      ),
    );
    const provisionalFraction = assertFinite(provisionalWeight / totalWeight);
    if (provisionalFraction > request.provisionalKcalFractionThreshold) {
      provisionalDays += 1;
    }

    for (const key of NUTRIENT_KEYS) {
      const reliableWeight = assertFinite(
        dayEntries.reduce((sum, entry) => {
          const isReliable = isReliableNutrientValue(entry.nutrients[key]) && isReliableFoodState(entry.foodStateConfidence);
          return sum + (isReliable ? entryWeight(entry) : 0);
        }, 0),
      );
      const reliableFraction = assertFinite(reliableWeight / totalWeight);
      if (reliableFraction >= request.dailyReliabilityThreshold) {
        reliableDaysByNutrient.set(key, (reliableDaysByNutrient.get(key) ?? 0) + 1);
      }
    }
  }

  const perNutrient: NutrientCoverageResult[] = NUTRIENT_KEYS.map((nutrient) => {
    const daysWithReliableData = reliableDaysByNutrient.get(nutrient) ?? 0;
    return {
      nutrient,
      windowDays,
      daysWithReliableData,
      coverageFraction: assertFinite(daysWithReliableData / windowDays),
    };
  });

  return {
    status: "evaluated",
    windowStartDateKey: request.startDateKey,
    windowEndDateKey: request.endDateKey,
    windowDays,
    perNutrient,
    unloggedDays,
    legacyUnlabeledDays,
    provisionalDays,
  };
}

// ─── API pública ─────────────────────────────────────────────────────────

/** Cobertura e integridad de nutrientes registrados en una ventana
    explícita: por cada NutrientKey, qué fracción de días de la ventana
    tiene al menos `dailyReliabilityThreshold` de sus kcal respaldadas por
    valores `known_nonzero`/`known_zero` con `foodStateConfidence`
    aceptable. windowDays nunca se reduce: un día sin entradas fiables
    (o sin entradas en absoluto) sigue ocupando un lugar en el
    denominador. Un día con al menos una entrada cuyo kcal no es
    ponderable (ausente, "unknown" o "legacy_unlabeled" — ver
    isWeighableKcal) nunca cuenta como fiable para ningún nutriente y
    siempre cuenta como `provisionalDays`, sin importar cuánto respalden
    las demás entradas de ese día: una comida de magnitud desconocida no
    debe poder "desaparecer" del denominador. No decide ningún umbral por
    su cuenta más allá de los que recibe como parámetro — ver
    nutrient-coverage.ts. */
export function evaluateNutrientCoverage(input: DailyIntegrityWindowInput): DailyIntegrityResult {
  const validated = validateRequest(input);
  if ("status" in validated) return validated;

  try {
    return computeEvaluated(validated);
  } catch (error) {
    if (error instanceof NonFiniteDerivedValueError) return invalidInput(["derived_numeric_result_invalid"]);
    throw error;
  }
}
