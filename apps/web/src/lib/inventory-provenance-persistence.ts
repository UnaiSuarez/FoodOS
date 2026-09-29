// Nutrition Engine v4, PR3 — persistencia de la procedencia de un InventoryItem
// junto a SU FILA de `inventory_items` (columna JSONB nullable
// `nutrition_provenance`, migración aditiva 20260924190000).
//
// Contexto: PR3a captura `nutrientStatus`, `foodStateConfidence` y `dataSource`
// en cada item, pero pushState escribía `inventory_items` con una lista fija de
// columnas y pullState reconstruía cada item desde otra lista fija; ninguna la
// conservaba. Tras sincronizar y recargar, un item OFF/USDA/IA la perdía y
// consumirlo acababa como `legacy_unlabeled` — seguro, pero la captura de PR3a
// nunca llegaba a aportar cobertura.
//
// Diseño: puro y sin red. Dos funciones, una por dirección, con el mismo saneado.
//
// FRESCURA (clientes antiguos). Un cliente anterior a este cambio no conoce la
// columna: al hacer upsert no la toca, pero SÍ puede cambiar otras columnas de la
// fila. La procedencia guardada dejaría de describir lo que hay en la fila y un
// cliente nuevo la seguiría afirmando. Por eso el JSON lleva `basis`: la
// REFERENCIA a la que describe — los números por 100, el nombre y la unidad con su
// tamaño. Al leer, si algo de eso ya no coincide con la fila, la procedencia se
// DESCARTA entera y el item se lee como legacy_unlabeled — el lado conservador.
// Sin `basis` válido tampoco hay forma de verificarla: se descarta.
//
//  * Nombre: «arroz crudo» → «arroz cocido» cambia el alimento al que se refiere
//    un `foodStateConfidence: "confirmed"` sin tocar un solo número. Se compara sin
//    distinguir mayúsculas ni espacios de más (misma regla que §16.5).
//  * Unidad, `unitSize` y `unitSizeUnit`: cambian cómo se interpreta la referencia
//    por 100 (g frente a ml, gramos por unidad).
//  * Números: se comparan EXACTAMENTE en su forma canónica, la que persiste
//    PostgreSQL en numeric(…,2) (pg-numeric.ts). Sin banda de tolerancia: un
//    redondeo inicial (165,0051 → 165,01) es el mismo valor, pero una edición
//    posterior a 165,00 es otro y descarta la procedencia.

import type { FoodStateConfidence, InventoryItem, NutrientKey, NutrientStatus } from "@foodos/types";
import { sanitizeFoodStateConfidence, sanitizeNutrientStatusMap } from "./food-log-provenance";
import { normalizeNameForComparison } from "./nutrient-provenance";
import { canonicalNumeric2 } from "./pg-numeric";

const NUTRIENT_BASIS_KEYS = ["kcal", "protein", "carbs", "fat", "salt", "fiber", "sugars"] as const satisfies readonly NutrientKey[];
type NutrientBasisKey = (typeof NUTRIENT_BASIS_KEYS)[number];
/** kcal y proteína siempre tienen número en un item (0 si faltaba); el resto, solo si existe. */
const REQUIRED_NUTRIENT_KEYS: readonly NutrientBasisKey[] = ["kcal", "protein"];

const DATA_SOURCES: readonly NonNullable<InventoryItem["dataSource"]>[] = ["local", "off", "usda", "ai", "manual"];
const UNIT_SIZE_UNITS = ["g", "ml"] as const;

/** Los campos de un item que definen la referencia a la que describe su procedencia. */
export type InventoryReference = Pick<InventoryItem, NutrientBasisKey | "name" | "unit" | "unitSize" | "unitSizeUnit">;

/** Lo que se guarda en `inventory_items.nutrition_provenance`. */
export interface InventoryProvenanceColumn {
  dataSource?: NonNullable<InventoryItem["dataSource"]>;
  nutrientStatus?: Partial<Record<NutrientKey, NutrientStatus>>;
  foodStateConfidence?: FoodStateConfidence;
  /** La referencia a la que describe la procedencia (ver «FRESCURA»). Los números,
      en su forma canónica de numeric(…,2). */
  basis: {
    name: string;
    unit: string;
    unitSize?: number;
    unitSizeUnit?: (typeof UNIT_SIZE_UNITS)[number];
  } & Partial<Record<NutrientBasisKey, number>>;
}

export type InventoryProvenanceFields = Pick<InventoryItem, "dataSource" | "nutrientStatus" | "foodStateConfidence">;

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function basisOf(item: InventoryReference): InventoryProvenanceColumn["basis"] {
  const basis: InventoryProvenanceColumn["basis"] = { name: item.name, unit: item.unit };
  if (isNumber(item.unitSize)) basis.unitSize = canonicalNumeric2(item.unitSize);
  if (item.unitSizeUnit && UNIT_SIZE_UNITS.includes(item.unitSizeUnit)) basis.unitSizeUnit = item.unitSizeUnit;
  for (const key of NUTRIENT_BASIS_KEYS) {
    const value = item[key];
    if (isNumber(value)) basis[key] = canonicalNumeric2(value);
  }
  return basis;
}

/**
 * Valor de la columna para un item. `null` (columna NULL) si el item no tiene
 * ninguna procedencia: un item anterior a PR3a no gana ninguna, y uno que la
 * perdió limpia la que hubiera en la base. Solo salen valores válidos.
 */
export function inventoryProvenanceToColumn(
  item: InventoryReference & Partial<Pick<InventoryItem, "dataSource" | "nutrientStatus" | "foodStateConfidence">>,
): InventoryProvenanceColumn | null {
  const dataSource = item.dataSource !== undefined && DATA_SOURCES.includes(item.dataSource) ? item.dataSource : undefined;
  const nutrientStatus = sanitizeNutrientStatusMap(item.nutrientStatus);
  const foodStateConfidence = sanitizeFoodStateConfidence(item.foodStateConfidence);
  if (!dataSource && !nutrientStatus && !foodStateConfidence) return null;
  return {
    ...(dataSource && { dataSource }),
    ...(nutrientStatus && { nutrientStatus }),
    ...(foodStateConfidence && { foodStateConfidence }),
    basis: basisOf(item),
  };
}

/** ¿Es el mismo valor una vez persistido? Comparación exacta en forma canónica. */
function sameStoredNumber(stored: unknown, current: unknown): boolean {
  return isNumber(stored) && isNumber(current) && canonicalNumeric2(stored) === canonicalNumeric2(current);
}

function matchesBasis(rawBasis: unknown, item: InventoryReference): boolean {
  if (rawBasis === null || typeof rawBasis !== "object" || Array.isArray(rawBasis)) return false;
  const basis = rawBasis as Record<string, unknown>;

  if (typeof basis.name !== "string" || normalizeNameForComparison(basis.name) !== normalizeNameForComparison(item.name)) return false;
  if (typeof basis.unit !== "string" || basis.unit !== item.unit) return false;

  if (basis.unitSize === undefined) {
    if (item.unitSize !== undefined) return false;
  } else if (!sameStoredNumber(basis.unitSize, item.unitSize)) return false;

  if (basis.unitSizeUnit !== item.unitSizeUnit) return false; // undefined solo si ambos lo son

  for (const key of NUTRIENT_BASIS_KEYS) {
    const stored = basis[key];
    const current = item[key];
    if (stored === undefined) {
      if (REQUIRED_NUTRIENT_KEYS.includes(key)) return false; // sin kcal/proteína no se puede verificar
      if (current !== undefined) return false; // el item ganó un número que la procedencia no conocía
      continue;
    }
    if (!sameStoredNumber(stored, current)) return false;
  }
  return true;
}

/**
 * Campos de procedencia de un item a partir de la columna leída de la base.
 * Devuelve solo las claves que sobreviven al saneado, o `{}` (legacy) si el
 * valor no es un objeto, no trae un `basis` verificable, o el `basis` ya no
 * describe la fila (un cliente antiguo cambió el nombre, la unidad o un número).
 * Nunca lanza.
 */
export function inventoryProvenanceFromColumn(raw: unknown, item: InventoryReference): InventoryProvenanceFields {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const column = raw as Record<string, unknown>;
  if (!matchesBasis(column.basis, item)) return {};

  const out: InventoryProvenanceFields = {};
  const dataSource = DATA_SOURCES.find((s) => s === column.dataSource);
  if (dataSource) out.dataSource = dataSource;
  const nutrientStatus = sanitizeNutrientStatusMap(column.nutrientStatus);
  if (nutrientStatus) out.nutrientStatus = nutrientStatus;
  const foodStateConfidence = sanitizeFoodStateConfidence(column.foodStateConfidence);
  if (foodStateConfidence) out.foodStateConfidence = foodStateConfidence;
  return out;
}
