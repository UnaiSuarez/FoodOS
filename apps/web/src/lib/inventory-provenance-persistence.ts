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
// columna: al hacer upsert no la toca (solo actualiza las columnas de su
// payload), pero SÍ puede cambiar los números por 100 de la fila. La procedencia
// guardada dejaría de describir el número actual y un cliente nuevo la seguiría
// afirmando. Por eso el JSON lleva `basis`: los números por 100 a los que
// describe. Al leer, si los números de la fila ya no coinciden con `basis` (con
// la tolerancia del redondeo a 2 decimales de la base), la procedencia se
// DESCARTA entera y el item se lee como legacy_unlabeled — el lado conservador.
// Sin `basis` válido tampoco hay forma de verificarla: se descarta.

import type { FoodStateConfidence, InventoryItem, NutrientKey, NutrientStatus } from "@foodos/types";
import { sanitizeFoodStateConfidence, sanitizeNutrientStatusMap } from "./food-log-provenance";

const BASIS_KEYS = ["kcal", "protein", "carbs", "fat", "salt", "fiber", "sugars"] as const satisfies readonly NutrientKey[];
type BasisKey = (typeof BASIS_KEYS)[number];
/** kcal y proteína siempre tienen número en un item (0 si faltaba); el resto, solo si existe. */
const REQUIRED_BASIS_KEYS: readonly BasisKey[] = ["kcal", "protein"];

const DATA_SOURCES: readonly NonNullable<InventoryItem["dataSource"]>[] = ["local", "off", "usda", "ai", "manual"];

/** La base guarda numeric(…,2): un valor por 100 vuelve redondeado a 2 decimales
    (error máximo 0,005). Cualquier diferencia mayor es un cambio real. */
const BASIS_TOLERANCE = 0.006;

type ItemNumbers = Pick<InventoryItem, BasisKey>;

/** Lo que se guarda en `inventory_items.nutrition_provenance`. */
export interface InventoryProvenanceColumn {
  dataSource?: NonNullable<InventoryItem["dataSource"]>;
  nutrientStatus?: Partial<Record<NutrientKey, NutrientStatus>>;
  foodStateConfidence?: FoodStateConfidence;
  /** Valores por 100 a los que describe la procedencia (ver «FRESCURA»). */
  basis: Partial<Record<BasisKey, number>>;
}

export type InventoryProvenanceFields = Pick<InventoryItem, "dataSource" | "nutrientStatus" | "foodStateConfidence">;

function basisOf(item: ItemNumbers): Partial<Record<BasisKey, number>> {
  const basis: Partial<Record<BasisKey, number>> = {};
  for (const key of BASIS_KEYS) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value)) basis[key] = value;
  }
  return basis;
}

/**
 * Valor de la columna para un item. `null` (columna NULL) si el item no tiene
 * ninguna procedencia: un item anterior a PR3a no gana ninguna, y uno que la
 * perdió limpia la que hubiera en la base. Solo salen valores válidos.
 */
export function inventoryProvenanceToColumn(
  item: ItemNumbers & Partial<Pick<InventoryItem, "dataSource" | "nutrientStatus" | "foodStateConfidence">>,
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

function matchesBasis(rawBasis: unknown, item: ItemNumbers): boolean {
  if (rawBasis === null || typeof rawBasis !== "object" || Array.isArray(rawBasis)) return false;
  const basis = rawBasis as Record<string, unknown>;
  for (const key of BASIS_KEYS) {
    const stored = basis[key];
    const current = item[key];
    if (stored === undefined) {
      if (REQUIRED_BASIS_KEYS.includes(key)) return false; // sin kcal/proteína no se puede verificar
      if (current !== undefined) return false; // el item ganó un número que la procedencia no conocía
      continue;
    }
    if (typeof stored !== "number" || !Number.isFinite(stored)) return false;
    if (typeof current !== "number" || !Number.isFinite(current)) return false;
    if (Math.abs(stored - current) > BASIS_TOLERANCE) return false;
  }
  return true;
}

/**
 * Campos de procedencia de un item a partir de la columna leída de la base.
 * Devuelve solo las claves que sobreviven al saneado, o `{}` (legacy) si el
 * valor no es un objeto, no trae un `basis` verificable, o el `basis` ya no
 * coincide con los números actuales de la fila (un cliente antiguo los cambió).
 * Nunca lanza.
 */
export function inventoryProvenanceFromColumn(raw: unknown, itemNumbers: ItemNumbers): InventoryProvenanceFields {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const column = raw as Record<string, unknown>;
  if (!matchesBasis(column.basis, itemNumbers)) return {};

  const out: InventoryProvenanceFields = {};
  const dataSource = DATA_SOURCES.find((s) => s === column.dataSource);
  if (dataSource) out.dataSource = dataSource;
  const nutrientStatus = sanitizeNutrientStatusMap(column.nutrientStatus);
  if (nutrientStatus) out.nutrientStatus = nutrientStatus;
  const foodStateConfidence = sanitizeFoodStateConfidence(column.foodStateConfidence);
  if (foodStateConfidence) out.foodStateConfidence = foodStateConfidence;
  return out;
}
