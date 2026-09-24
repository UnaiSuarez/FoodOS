// Nutrition Engine v4, PR3 — etiquetado de procedencia al ESCRIBIR el diario
// (`FoodLogEntry`). Nace de docs/NUTRITION_V4_DATA_INTEGRITY_DESIGN.md (§1.4,
// §16.4, §18): cada camino real que escribe `foodLog` decide AQUÍ qué
// procedencia lleva su entrada, en el momento de escribirla, a partir de la
// procedencia que PR3a capturó — nunca infiriendo `known_*` de que exista un
// número.
//
// Responsabilidad de este módulo: puro y sin estado. No calcula ningún número
// del diario (eso lo siguen haciendo los escritores, igual que antes); solo
// decide `nutrientStatus`, `foodStateConfidence` y, cuando hay un motivo
// concreto, `quantityConfidence`. Tampoco conecta nada con el kernel de
// cobertura: el adaptador de PR2 sigue leyendo cada entrada como
// `legacy_unlabeled` hasta un PR de integración posterior.
//
// Regla común a todos los constructores: un total AGREGADO (receta, plato
// compuesto, entrada de planificador) es `legacy_unlabeled` para sus cuatro
// macros — no se deriva la certeza del total a partir de la de sus
// ingredientes (AC28, §16.4). Solo un consumo directo de UN item de
// inventario y una estimación de IA de comida completa llevan otra cosa.

import type {
  FoodLogEntry,
  FoodStateConfidence,
  InventoryItem,
  NutrientKey,
  NutrientStatus,
  QuantityLowConfidenceReason,
  Recipe,
} from "@foodos/types";
import { legacyOrUnknown, resolveFoodStateConfidenceForDirectEntry } from "./nutrient-provenance";

export const DIARY_MACRO_KEYS = ["kcal", "protein", "carbs", "fat"] as const;
export type DiaryMacroKey = (typeof DIARY_MACRO_KEYS)[number];

/** Los tres campos de procedencia que un escritor decide (`synthetic` es aparte). */
export type FoodLogProvenance = Pick<FoodLogEntry, "nutrientStatus" | "quantityConfidence" | "foodStateConfidence">;

function uniformMacroStatus(status: NutrientStatus): Record<DiaryMacroKey, NutrientStatus> {
  return { kcal: status, protein: status, carbs: status, fat: status };
}

function isKnown(status: NutrientStatus): boolean {
  return status === "known_nonzero" || status === "known_zero";
}

/**
 * Total cuyo número EXISTE pero cuya procedencia no es verificable con lo que
 * se conserva: migración de `consumedMeals`, plato compuesto en el diario,
 * entrada de planificador (receta o plato rápido). Los cuatro macros son
 * `legacy_unlabeled` y el estado del alimento `"unknown"` (nunca `confirmed`
 * ni `not_applicable`: no hay una comparación verificable detrás).
 */
export function legacyTotalProvenance(): FoodLogProvenance {
  return { nutrientStatus: uniformMacroStatus("legacy_unlabeled"), foodStateConfidence: "unknown" };
}

/**
 * ¿Recibe `cookRecipe` cantidades por ingrediente que NO aplica al cálculo de
 * macros? `cookRecipe` usa `qtyOverrides` para descontar inventario pero
 * registra `recipe.kcal * ratio`, así que un override real deja el número del
 * diario desincronizado de lo cocinado (hallazgo P11). Solo cuentan las claves
 * que corresponden a un ingrediente de la receta y traen un número finito;
 * una clave suelta no cambia nada. No compara contra el valor por defecto: ante
 * la duda se marca (el efecto de marcar de más es un día provisional).
 */
export function qtyOverridesIgnored(
  recipe: Pick<Recipe, "ingredients">,
  qtyOverrides: Record<string, number> | undefined,
): boolean {
  if (!qtyOverrides) return false;
  return recipe.ingredients.some(
    (ing) => Object.prototype.hasOwnProperty.call(qtyOverrides, ing.name) && Number.isFinite(qtyOverrides[ing.name]),
  );
}

/**
 * Receta cocinada (`cookRecipe`, y una receta registrada desde el plan de
 * hoy). `Recipe.kcal/protein/carbs/fat` puede venir de `macroOverride` o de
 * una suma parcial, y `Recipe` no conserva cuál: los cuatro macros son
 * `legacy_unlabeled` aunque todos los ingredientes sean `known_*` (AC28).
 * `overrides_ignored` baja la confianza de la cantidad.
 */
export function recipeTotalProvenance(input: { qtyOverridesIgnored: boolean }): FoodLogProvenance {
  return {
    ...legacyTotalProvenance(),
    ...(input.qtyOverridesIgnored && { quantityConfidence: { level: "low" as const, reason: "overrides_ignored" as const } }),
  };
}

/**
 * Consumo directo de UN item de inventario (`consumeInventoryItem`): lee la
 * procedencia que PR3a guardó en el item.
 * - kcal/proteína: el estado guardado; sin él, el número presente es
 *   `legacy_unlabeled` (item anterior a PR3a) — nunca `known_*`.
 * - carbs/grasa: si el item no los tiene, `macrosForQuantity` los IMPUTA
 *   (grasa = 25 % de las kcal, carbos por diferencia): `estimated`, y la
 *   entrada queda con `quantityConfidence: low` (§2, P9). Si los tiene, el
 *   estado guardado (o `legacy_unlabeled` sin él).
 * - Un item con `dataSource: "ai"` nunca produce `known_*` (AC19): defensa en
 *   profundidad además de lo que PR3a ya captura.
 * - `foodStateConfidence` se propaga tal cual del item (ausente → `"unknown"`).
 * - "ud" sin un tamaño de unidad positivo: `toGrams` cae en 60 g por defecto →
 *   `quantityConfidence: low` con motivo `missing_unit_size`.
 *
 * Las condiciones de imputación (`== null`) deben coincidir exactamente con las
 * de `macrosForQuantity` (state.tsx); hay una prueba que lo verifica.
 */
export function inventoryConsumptionProvenance(item: InventoryItem): FoodLogProvenance {
  const stored = item.nutrientStatus ?? {};
  const carried = (key: DiaryMacroKey, raw: number | undefined): NutrientStatus => {
    const status = legacyOrUnknown(stored[key], raw);
    return item.dataSource === "ai" && isKnown(status) ? "estimated" : status;
  };
  const fatImputed = item.fat == null;
  const carbsImputed = item.carbs == null;

  let quantityConfidence: FoodLogEntry["quantityConfidence"];
  if (item.unit === "ud" && !(typeof item.unitSize === "number" && item.unitSize > 0)) {
    quantityConfidence = { level: "low", reason: "missing_unit_size" };
  } else if (fatImputed || carbsImputed) {
    quantityConfidence = { level: "low" };
  }

  return {
    nutrientStatus: {
      kcal: carried("kcal", item.kcal),
      protein: carried("protein", item.protein),
      carbs: carbsImputed ? "estimated" : carried("carbs", item.carbs),
      fat: fatImputed ? "estimated" : carried("fat", item.fat),
    },
    foodStateConfidence: item.foodStateConfidence ?? "unknown",
    ...(quantityConfidence && { quantityConfidence }),
  };
}

/**
 * Comida completa estimada por IA (`LogMealModal.confirmExternal`). Todos los
 * macros son `estimated` o `unknown` — nunca `known_*`, aunque el estimador
 * (que ya lo garantiza) devolviera otra cosa: un `known_*` recibido se rebaja
 * a `estimated`. Sin estados del estimador, los cuatro son `estimated`.
 * `editedFields`: macros que la persona ajustó a mano tras la estimación
 * ("puedes ajustarlos"): ajustar una estimación sigue siendo una estimación —
 * `estimated` (incluso si la IA lo había omitido) y NUNCA `known_*`, y vaciar
 * el campo (que da 0) no lo convierte en `known_zero`.
 * `foodStateConfidence` es `not_applicable`: el número YA es el total consumido
 * (§1.6, AC25e).
 */
export function aiWholeMealProvenance(estimate?: {
  nutrientStatus?: Partial<Record<NutrientKey, NutrientStatus>>;
  editedFields?: readonly NutrientKey[];
}): FoodLogProvenance {
  const cap = (key: DiaryMacroKey): NutrientStatus => {
    if (estimate?.editedFields?.includes(key)) return "estimated";
    const status = estimate?.nutrientStatus?.[key];
    return status === undefined || isKnown(status) ? "estimated" : status;
  };
  return {
    nutrientStatus: { kcal: cap("kcal"), protein: cap("protein"), carbs: cap("carbs"), fat: cap("fat") },
    foodStateConfidence: resolveFoodStateConfidenceForDirectEntry("whole_intake_total"),
  };
}

/** Marca de fila de DEMOSTRACIÓN: nunca lleva `nutrientStatus` (design §1.5). */
export const SYNTHETIC_FOOD_LOG_FIELDS = { synthetic: true } as const satisfies Pick<FoodLogEntry, "synthetic">;

/**
 * Ajusta cada estado al número que REALMENTE se guarda. El kernel de cobertura
 * exige `known_zero` ⇔ 0 y `known_nonzero` ⇒ > 0, y una sola entrada
 * incoherente invalida la ventana entera. Un `known_nonzero` cuyo valor
 * escalado y redondeado queda en 0 (cantidad diminuta) o un `known_zero` con un
 * valor distinto de 0 dejan de afirmar una medición que ya no describe el
 * número guardado: pasan a `estimated`. El resto de estados no tienen esa
 * restricción y no se tocan.
 */
export function reconcileStatusesWithValues(
  status: Partial<Record<NutrientKey, NutrientStatus>> | undefined,
  values: Partial<Record<NutrientKey, number>>,
): Partial<Record<NutrientKey, NutrientStatus>> | undefined {
  if (!status) return status;
  const next = { ...status };
  for (const key of Object.keys(status) as NutrientKey[]) {
    const value = values[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (next[key] === "known_nonzero" && value === 0) next[key] = "estimated";
    else if (next[key] === "known_zero" && value !== 0) next[key] = "estimated";
  }
  return next;
}

// ─── Persistencia (client_meta) ─────────────────────────────────────────────
// La sincronización con Supabase copia a `food_log.client_meta` (JSONB, sin
// cambio de esquema) una lista FIJA de campos. Sin esto, la procedencia y —
// sobre todo — `synthetic` se perderían en el primer viaje de ida y vuelta, y
// una fila de demostración volvería del servidor como una entrada real
// `legacy_unlabeled`. Ambas direcciones pasan por el mismo saneado: solo salen
// y entran valores válidos; cualquier otra cosa se descarta (→ la entrada se lee
// como `legacy_unlabeled`, el lado conservador).

const NUTRIENT_KEYS: readonly NutrientKey[] = ["kcal", "protein", "carbs", "fat", "fiber", "sugars", "salt"];
const NUTRIENT_STATUSES: readonly NutrientStatus[] = [
  "known_nonzero", "known_zero", "estimated", "recipe_derived", "imputed", "unknown", "legacy_unlabeled",
];
const FOOD_STATE_CONFIDENCES: readonly FoodStateConfidence[] = ["confirmed", "unknown", "incompatible", "not_applicable"];
const QUANTITY_REASONS: readonly QuantityLowConfidenceReason[] = [
  "missing_density", "missing_unit_size", "overrides_ignored", "legacy_unlabeled",
];

type PersistedProvenance = Pick<FoodLogEntry, "nutrientStatus" | "quantityConfidence" | "foodStateConfidence" | "synthetic">;

/** Extrae los campos de procedencia válidos de cualquier objeto (una entrada o
    un `client_meta` leído del servidor). Devuelve solo las claves presentes. */
export function sanitizeFoodLogProvenance(source: unknown): PersistedProvenance {
  const out: PersistedProvenance = {};
  if (source === null || typeof source !== "object") return out;
  const raw = source as Record<string, unknown>;

  const rawStatus = raw.nutrientStatus;
  if (rawStatus !== null && typeof rawStatus === "object" && !Array.isArray(rawStatus)) {
    const clean: Partial<Record<NutrientKey, NutrientStatus>> = {};
    for (const key of NUTRIENT_KEYS) {
      const value = (rawStatus as Record<string, unknown>)[key];
      if (typeof value === "string" && (NUTRIENT_STATUSES as readonly string[]).includes(value)) clean[key] = value as NutrientStatus;
    }
    if (Object.keys(clean).length > 0) out.nutrientStatus = clean;
  }

  if (typeof raw.foodStateConfidence === "string" && (FOOD_STATE_CONFIDENCES as readonly string[]).includes(raw.foodStateConfidence)) {
    out.foodStateConfidence = raw.foodStateConfidence as FoodStateConfidence;
  }

  const rawQuantity = raw.quantityConfidence;
  if (rawQuantity !== null && typeof rawQuantity === "object") {
    const q = rawQuantity as Record<string, unknown>;
    if (q.level === "high" || q.level === "low") {
      const reason = typeof q.reason === "string" && (QUANTITY_REASONS as readonly string[]).includes(q.reason) ? (q.reason as QuantityLowConfidenceReason) : undefined;
      out.quantityConfidence = reason ? { level: q.level, reason } : { level: q.level };
    }
  }

  if (raw.synthetic === true) out.synthetic = true;
  return out;
}
