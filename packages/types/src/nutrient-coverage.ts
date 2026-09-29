// Nutrition Engine v4 — cobertura e integridad de nutrientes registrados.
// Ver nutrient-value.ts para el contexto completo (relación con PR5A/PR5B,
// alcance de esta entrega). Mismo criterio de fechas que
// IntakeLoggingCoverageInput (intake-logging-coverage.ts): `YYYY-MM-DD`
// estricto, ventana `[startDateKey, endDateKey]` inclusiva por ambos
// extremos, sin `Date`.
//
// A diferencia de `LoggedIntakeRecord` (PR5A, como mucho un registro por
// día), aquí una fecha puede tener VARIAS entradas — cada una es una
// ingesta real (desayuno, comida, cena...), no un total ya agregado del
// día. El kernel las agrupa y pondera internamente.
//
// Este contrato NO incluye `aggregateCoverageFraction` ni ningún campo
// "de paso" para un número calculado en otro sitio: la cobertura agregada
// de presencia/plausibilidad ya la calcula PR5A
// (`IntakeLoggingCoverageResult`); combinar ambas señales es trabajo de
// una capa de integración futura, no de este kernel.

import type { EnergyConsistency, FoodStateConfidence, NutrientKey, NutrientValue } from "./nutrient-value";

// ─── Entrada ────────────────────────────────────────────────────────────

/**
 * Una ingesta ya resuelta — NO es `FoodLogEntry` de producción (ese vive
 * en `apps/web` y tiene campos opcionales para admitir migración
 * incremental, ver el documento de diseño §7). Esta es la forma
 * NORMALIZADA que el kernel exige: quien la construya (el futuro
 * adaptador) decide qué hacer con una entrada real que todavía no tenga
 * `nutrientStatus`/`foodStateConfidence` propios (mapearla a
 * `"legacy_unlabeled"`/`"unknown"`, nunca inventar un valor) ANTES de
 * llamar al kernel. El kernel no adivina valores por defecto.
 */
export interface DailyIntegrityEntry {
  /** `YYYY-MM-DD` estricto. */
  dateKey: string;
  nutrients: Partial<Record<NutrientKey, NutrientValue>>;
  quantityConfidence: "high" | "low";
  foodStateConfidence: FoodStateConfidence;
  energyConsistency: EnergyConsistency;
}

export interface DailyIntegrityWindowInput {
  startDateKey: string;
  /** Inclusive, igual criterio que `IntakeLoggingCoverageInput`. */
  endDateKey: string;
  /** Entradas de TODA la ventana o de fuera de ella; las que caigan fuera
   *  de `[startDateKey, endDateKey]` se descartan sin más — mismo
   *  criterio que PR5A con sus registros fuera de ventana. */
  entries: readonly DailyIntegrityEntry[];
  /**
   * Fracción en `[0, 1]` de las kcal del día que deben proceder de
   * entradas `known_nonzero`/`known_zero` con `foodStateConfidence`
   * "confirmed"/"not_applicable" para que ESE día cuente como fiable para
   * un nutriente dado. El kernel NO fija este umbral — el documento de
   * diseño (§1.6/§11) lo deja explícitamente sin calibrar; quien llama
   * debe decidirlo y pasarlo.
   */
  dailyReliabilityThreshold: number;
  /**
   * Fracción en `[0, 1]` de las kcal del día con `quantityConfidence:
   * "low"` o `energyConsistency: "mismatch"` que marca el día como
   * `provisional`. Tampoco fijado por el kernel, mismo motivo.
   */
  provisionalKcalFractionThreshold: number;
}

// ─── invalid_input ──────────────────────────────────────────────────────

/** El orden de declaración es el orden canónico de `reasons`. */
export type DailyIntegrityInvalidReason =
  | "input_object_invalid"
  | "start_date_key_invalid"
  | "end_date_key_invalid"
  | "date_window_order_invalid"
  | "daily_reliability_threshold_invalid"
  | "provisional_kcal_fraction_threshold_invalid"
  | "entries_not_array"
  | "entry_object_invalid"
  | "entry_date_key_invalid"
  | "entry_nutrients_invalid"
  | "entry_quantity_confidence_invalid"
  | "entry_food_state_confidence_invalid"
  | "entry_energy_consistency_invalid"
  | "derived_numeric_result_invalid";

export type NonEmptyDailyIntegrityInvalidReasons = [DailyIntegrityInvalidReason, ...DailyIntegrityInvalidReason[]];

export interface DailyIntegrityInvalidInput {
  status: "invalid_input";
  /** Deduplicadas y en orden canónico, nunca en orden de descubrimiento. */
  reasons: NonEmptyDailyIntegrityInvalidReasons;
}

// ─── evaluated ──────────────────────────────────────────────────────────

export interface NutrientCoverageResult {
  nutrient: NutrientKey;
  /** Igual valor que `DailyIntegrityEvaluated.windowDays` — se repite aquí
   *  para que cada fila de `perNutrient` sea autocontenida. */
  windowDays: number;
  daysWithReliableData: number;
  /** `daysWithReliableData / windowDays`. NUNCA se compara aquí contra
   *  ningún umbral — el kernel comunica la fracción, no decide si basta.
   *  Esa decisión es de quien consuma el resultado (documento de diseño
   *  §1.6: el umbral de ventana por nutriente sigue sin fijarse). */
  coverageFraction: number;
}

/**
 * Sin estado `insufficient_data`: las fracciones están definidas también
 * con cero días fiables. Invariante: `0 <= daysWithReliableData <=
 * windowDays` para cada fila de `perNutrient`, y `unloggedDays +
 * legacyUnlabeledDays + provisionalDays <= windowDays` (un día cuenta como
 * mucho en uno de los tres — ver el kernel para la precedencia exacta;
 * ninguno de los tres es aditivo con "fiable", que se calcula por
 * separado, por nutriente).
 */
export interface DailyIntegrityEvaluated {
  status: "evaluated";
  windowStartDateKey: string;
  windowEndDateKey: string;
  /** Días de calendario de la ventana, ambos extremos incluidos. NUNCA se
   *  reduce por la presencia de días sin datos fiables ni por descartar
   *  entradas — filtrar no puede aumentar artificialmente la cobertura. */
  windowDays: number;
  /** Una fila por cada `NutrientKey` de la unión, siempre las 7, incluso
   *  si ninguna entrada de la ventana menciona ese nutriente. */
  perNutrient: readonly NutrientCoverageResult[];
  /** Días de la ventana sin ninguna entrada. Sigue contando en
   *  `windowDays` — nunca se resta de él. */
  unloggedDays: number;
  /** Días con al menos una entrada, donde CADA valor nutricional de CADA
   *  entrada de ese día es `"legacy_unlabeled"`. */
  legacyUnlabeledDays: number;
  /** Días no `unloggedDays` ni `legacyUnlabeledDays` donde CUALQUIERA de
   *  estas dos condiciones se cumple: (a) al menos una entrada tiene un
   *  kcal no ponderable — ausente, `"unknown"` o `"legacy_unlabeled"`,
   *  regla conservadora incondicional, nunca se evalúa la fracción
   *  ponderada de las demás entradas para decidir esto; o (b) la fracción
   *  ponderada por kcal de entradas con `quantityConfidence: "low"` o
   *  `energyConsistency: "mismatch"` supera `provisionalKcalFractionThreshold`. */
  provisionalDays: number;
}

export type DailyIntegrityResult = DailyIntegrityInvalidInput | DailyIntegrityEvaluated;
