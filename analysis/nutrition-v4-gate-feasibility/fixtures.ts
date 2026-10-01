// Fixtures compartidas por todos los scripts de este análisis. Mismo
// principio que run.ts: construidas con las funciones REALES de
// apps/web/src/lib/{food-log-provenance,nutrient-provenance}.ts — nunca se
// inventa aquí qué NutrientStatus/FoodStateConfidence le toca a cada caso.

import { evaluateNutrientCoverage } from "@foodos/engine";
import { buildDiaryIntegrityInput } from "../../apps/web/src/lib/nutrition-v4-adapter";
import {
  aiWholeMealProvenance,
  inventoryConsumptionProvenance,
  legacyTotalProvenance,
  recipeTotalProvenance,
} from "../../apps/web/src/lib/food-log-provenance";
import {
  applyManualNutrientEdit,
  foodStateConfidenceAfterInventoryEdit,
  knownStatusFromValue,
  localCatalogStatusFromValue,
  resolveFoodStateConfidenceForGenericMatch,
  resolveFoodStateConfidenceForProduct,
} from "../../apps/web/src/lib/nutrient-provenance";
import type {
  DailyIntegrityEvaluated,
  DailyIntegrityResult,
  DailyIntegrityWindowInput,
  FoodLogEntry,
  InventoryItem,
} from "@foodos/types";

export { evaluateNutrientCoverage, buildDiaryIntegrityInput };
export {
  aiWholeMealProvenance, inventoryConsumptionProvenance, legacyTotalProvenance, recipeTotalProvenance,
  applyManualNutrientEdit, foodStateConfidenceAfterInventoryEdit, knownStatusFromValue,
  localCatalogStatusFromValue, resolveFoodStateConfidenceForGenericMatch, resolveFoodStateConfidenceForProduct,
};
export type { DailyIntegrityEvaluated, DailyIntegrityResult, DailyIntegrityWindowInput, FoodLogEntry, InventoryItem };

// ─── InventoryItem ──────────────────────────────────────────────────────

export function offConfirmedItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  // Búsqueda OFF por texto, campos "_100g" presentes (base confirmada), Y
  // el texto buscado Y el de la referencia declaran EXPLÍCITAMENTE el MISMO
  // estado ("crudo" en ambos) → foodStateConfidence "confirmed". Un nombre
  // SIN palabra de estado — el caso mayoritario real — da "unspecified" en
  // ambos lados y por tanto SIEMPRE "unknown": ver `offConfirmedButUnspecifiedItem`.
  const kcal = overrides.kcal ?? 165;
  const protein = overrides.protein ?? 31;
  const carbs = overrides.carbs ?? 0;
  const fat = overrides.fat ?? 3.6;
  const name = overrides.name ?? "Pechuga de pollo cruda";
  return {
    id: "inv-off-confirmed", name, qty: 500, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 4,
    kcal, protein, carbs, fat, dataSource: "off",
    nutrientStatus: {
      kcal: knownStatusFromValue(kcal), protein: knownStatusFromValue(protein),
      carbs: knownStatusFromValue(carbs), fat: knownStatusFromValue(fat),
    },
    foodStateConfidence: resolveFoodStateConfidenceForGenericMatch(name, name),
    ...overrides,
  };
}

export function usdaConfirmedItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return offConfirmedItem({ id: "inv-usda-confirmed", dataSource: "usda", name: "Arroz blanco crudo", ...overrides });
}

export function offConfirmedButUnspecifiedItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  // EL CASO MAYORITARIO REAL: known_* por campos, pero el nombre no declara
  // estado → "unspecified" en ambos lados → foodStateConfidence "unknown".
  const kcal = 165, protein = 31, carbs = 0, fat = 3.6;
  return {
    id: "inv-off-unspecified", name: "Pechuga de pollo", qty: 500, unit: "g", storage: "Nevera",
    expires: "2099-01-01", price: 4, kcal, protein, carbs, fat, dataSource: "off",
    nutrientStatus: {
      kcal: knownStatusFromValue(kcal), protein: knownStatusFromValue(protein),
      carbs: knownStatusFromValue(carbs), fat: knownStatusFromValue(fat),
    },
    foodStateConfidence: resolveFoodStateConfidenceForGenericMatch("pechuga de pollo", "pechuga de pollo"),
    ...overrides,
  };
}

export function barcodeScannedItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  const kcal = 544, protein = 5, carbs = 58, fat = 32;
  return {
    id: "inv-barcode", name: "Crema de cacao (código de barras)", qty: 400, unit: "g", storage: "Despensa",
    expires: "2099-01-01", price: 3, kcal, protein, carbs, fat, dataSource: "off",
    nutrientStatus: {
      kcal: knownStatusFromValue(kcal), protein: knownStatusFromValue(protein),
      carbs: knownStatusFromValue(carbs), fat: knownStatusFromValue(fat),
    },
    foodStateConfidence: resolveFoodStateConfidenceForProduct(),
    ...overrides,
  };
}

export function localCatalogItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  const kcal = 350, protein = 8, carbs = 70, fat = 3;
  return {
    id: "inv-catalog", name: "Pasta", qty: 500, unit: "g", storage: "Despensa", expires: "2099-01-01",
    price: 1.5, kcal, protein, carbs, fat, dataSource: "local",
    nutrientStatus: {
      kcal: localCatalogStatusFromValue(kcal), protein: localCatalogStatusFromValue(protein),
      carbs: localCatalogStatusFromValue(carbs), fat: localCatalogStatusFromValue(fat),
    },
    foodStateConfidence: resolveFoodStateConfidenceForGenericMatch("pasta", "pasta"),
    ...overrides,
  };
}

// ─── FoodLogEntry ───────────────────────────────────────────────────────

let seq = 0;
export function baseEntry(date: string, overrides: Partial<FoodLogEntry>): FoodLogEntry {
  seq += 1;
  return {
    id: `e${seq}`, date, time: "13:00", name: "entrada", qty: null, unit: null,
    kcal: 0, protein: 0, carbs: 0, fat: 0, source: "manual", mealType: "lunch",
    ...overrides,
  };
}

/** consumeInventoryItem (state.tsx:3032) con un item dado — usa directamente
 *  sus macros por-100g como si la ración consumida fuera esa (qty/unit no
 *  participan en el cálculo de cobertura, solo en la UI real). */
export function inventoryConsumptionEntry(date: string, item: InventoryItem): FoodLogEntry {
  const p = inventoryConsumptionProvenance(item);
  return baseEntry(date, {
    name: item.name, qty: item.qty, unit: item.unit, source: "inventory",
    kcal: item.kcal, protein: item.protein, carbs: item.carbs ?? 0, fat: item.fat ?? 0,
    ...p,
  });
}

export function recipeCookedEntry(date: string, overridesIgnored: boolean, kcal = 700): FoodLogEntry {
  const p = recipeTotalProvenance({ qtyOverridesIgnored: overridesIgnored });
  return baseEntry(date, { name: "Receta cocinada", source: "recipe", kcal, protein: 45, carbs: 60, fat: 25, ...p });
}

export function manualOrPlanEntry(date: string, kcal = 500): FoodLogEntry {
  return baseEntry(date, { name: "Plato/plan", kcal, protein: 30, carbs: 40, fat: 15, ...legacyTotalProvenance() });
}

export function aiWholeMealEntry(date: string, kcal = 600): FoodLogEntry {
  return baseEntry(date, { name: "Comida estimada por IA", kcal, protein: 35, carbs: 55, fat: 20, ...aiWholeMealProvenance() });
}

export function malformedEntry(date: string): FoodLogEntry {
  return baseEntry(date, { name: "Entrada corrupta", kcal: -50, protein: 10, carbs: 10, fat: 5 });
}

// ─── Umbrales: ilustrativos, no una calibración aprobada ───────────────────

export const THRESHOLD_SETS = [
  { label: "dailyReliability=0.8 / provisionalKcalFraction=0.25 (ILUSTRATIVO)", dailyReliabilityThreshold: 0.8, provisionalKcalFractionThreshold: 0.25 },
  { label: "dailyReliability=0.7 / provisionalKcalFraction=0.25 (ILUSTRATIVO)", dailyReliabilityThreshold: 0.7, provisionalKcalFractionThreshold: 0.25 },
  { label: "dailyReliability=0.8 / provisionalKcalFraction=1.0 (ILUSTRATIVO — desactiva el disparador por cantidad)", dailyReliabilityThreshold: 0.8, provisionalKcalFractionThreshold: 1.0 },
] as const;

export function runWindow(entries: readonly FoodLogEntry[], window: { startDateKey: string; endDateKey: string }, thresholds: { dailyReliabilityThreshold: number; provisionalKcalFractionThreshold: number }): DailyIntegrityResult {
  const input = buildDiaryIntegrityInput(entries, window, thresholds);
  return evaluateNutrientCoverage(input);
}

export function printEvaluated(label: string, result: DailyIntegrityResult): void {
  console.log(`--- ${label} ---`);
  if (result.status === "invalid_input") {
    console.log("  invalid_input:", result.reasons);
    return;
  }
  const r = result as DailyIntegrityEvaluated;
  console.log(`  windowDays=${r.windowDays}  unloggedDays=${r.unloggedDays}  legacyUnlabeledDays=${r.legacyUnlabeledDays}  provisionalDays=${r.provisionalDays}`);
  for (const n of r.perNutrient) {
    console.log(`  ${n.nutrient.padEnd(8)} daysWithReliableData=${n.daysWithReliableData}  coverageFraction=${n.coverageFraction.toFixed(4)}`);
  }
}
