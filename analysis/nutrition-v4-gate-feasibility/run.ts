// Nutrition v4 — análisis de viabilidad del gate (§17 del documento de
// diseño). Script de SOLO LECTURA, fuera del workspace de npm (no toca la
// frontera apps/web ↔ packages/engine: no se ejecuta como parte de ningún
// build ni test de esos paquetes), que recorre el camino REAL completo:
//
//   escritor real (food-log-provenance.ts / nutrient-provenance.ts)
//     → FoodLogEntry real
//     → buildDiaryIntegrityInput (nutrition-v4-adapter.ts, sin modificar)
//     → evaluateNutrientCoverage (packages/engine, sin modificar)
//
// Todos los datos son sintéticos, construidos aquí mismo — no se lee
// ninguna fila de food_log real ni se toca Supabase. No fija ningún umbral
// "correcto": ejecuta la MISMA ventana con varios umbrales para mostrar
// cómo cambia el resultado, que es justamente la pregunta de producto
// pendiente (§17).
//
// Ejecutar: npx tsx run.ts   (desde este directorio)

import { evaluateNutrientCoverage } from "@foodos/engine";
import { buildDiaryIntegrityInput } from "../../apps/web/src/lib/nutrition-v4-adapter";
import {
  aiWholeMealProvenance,
  inventoryConsumptionProvenance,
  legacyTotalProvenance,
  qtyOverridesIgnored,
  recipeTotalProvenance,
} from "../../apps/web/src/lib/food-log-provenance";
import {
  knownStatusFromValue,
  localCatalogStatusFromValue,
  resolveFoodStateConfidenceForGenericMatch,
  resolveFoodStateConfidenceForProduct,
} from "../../apps/web/src/lib/nutrient-provenance";
import type { FoodLogEntry, InventoryItem, DailyIntegrityEvaluated, DailyIntegrityResult } from "@foodos/types";

// ─── Fixtures: InventoryItem realistas, construidos con las MISMAS
// funciones que usa cada sitio de captura real (PR3a) ─────────────────────

function offConfirmedItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  // Búsqueda OFF por texto, campos "_100g" presentes (base confirmada), Y
  // el texto buscado Y el de la referencia declaran EXPLÍCITAMENTE el MISMO
  // estado ("crudo"/"raw" en ambos) → foodStateConfidence "confirmed" vía
  // resolveFoodStateConfidenceForGenericMatch. IMPORTANTE (hallazgo del
  // propio análisis): un nombre SIN palabra de estado — el caso mayoritario
  // real, p. ej. "pechuga de pollo" a secas — da "unspecified" en ambos
  // lados y por tanto SIEMPRE "unknown", nunca "confirmed". Ver
  // `offConfirmedButUnspecifiedItem` más abajo para ese caso, mucho más
  // frecuente en la práctica.
  const kcal = overrides.kcal ?? 165;
  const protein = overrides.protein ?? 31;
  const carbs = overrides.carbs ?? 0;
  const fat = overrides.fat ?? 3.6;
  return {
    id: "inv-off-confirmed",
    name: "Pechuga de pollo cruda",
    qty: 500,
    unit: "g",
    storage: "Nevera",
    expires: "2099-01-01",
    price: 4,
    kcal, protein, carbs, fat,
    dataSource: "off",
    nutrientStatus: {
      kcal: knownStatusFromValue(kcal),
      protein: knownStatusFromValue(protein),
      carbs: knownStatusFromValue(carbs),
      fat: knownStatusFromValue(fat),
    },
    foodStateConfidence: resolveFoodStateConfidenceForGenericMatch("pechuga de pollo cruda", "pechuga de pollo cruda"),
    ...overrides,
  };
}

function usdaConfirmedItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  // USDA Foundation/SR Legacy: mismo resolveUsdaStatus → known_*, misma
  // salvaguarda de estado del alimento que OFF (resolveFoodStateConfidenceForGenericMatch).
  return offConfirmedItem({ id: "inv-usda-confirmed", dataSource: "usda", name: "Arroz blanco crudo", ...overrides });
}

function offConfirmedButUnspecifiedItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  // EL CASO MAYORITARIO REAL: búsqueda OFF con campos "_100g" (known_*),
  // pero el nombre buscado NO declara ningún estado — "unspecified" en
  // ambos lados → resolveFoodStateConfidenceForGenericMatch da "unknown",
  // NO "confirmed". known_* por sí solo nunca basta para ser "reliable".
  const kcal = 165, protein = 31, carbs = 0, fat = 3.6;
  return {
    id: "inv-off-unspecified",
    name: "Pechuga de pollo",
    qty: 500,
    unit: "g",
    storage: "Nevera",
    expires: "2099-01-01",
    price: 4,
    kcal, protein, carbs, fat,
    dataSource: "off",
    nutrientStatus: {
      kcal: knownStatusFromValue(kcal),
      protein: knownStatusFromValue(protein),
      carbs: knownStatusFromValue(carbs),
      fat: knownStatusFromValue(fat),
    },
    foodStateConfidence: resolveFoodStateConfidenceForGenericMatch("pechuga de pollo", "pechuga de pollo"),
    ...overrides,
  };
}

function barcodeScannedItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  // BarcodeScannerModal: mismos campos "_100g" (known_*), pero
  // foodStateConfidence SIEMPRE "unknown" (resolveFoodStateConfidenceForProduct) —
  // nunca "confirmed", aunque el número sea igual de fiable que el de búsqueda.
  const kcal = 544, protein = 5, carbs = 58, fat = 32;
  return {
    id: "inv-barcode",
    name: "Crema de cacao (código de barras)",
    qty: 400,
    unit: "g",
    storage: "Despensa",
    expires: "2099-01-01",
    price: 3,
    kcal, protein, carbs, fat,
    dataSource: "off",
    nutrientStatus: {
      kcal: knownStatusFromValue(kcal),
      protein: knownStatusFromValue(protein),
      carbs: knownStatusFromValue(carbs),
      fat: knownStatusFromValue(fat),
    },
    foodStateConfidence: resolveFoodStateConfidenceForProduct(),
    ...overrides,
  };
}

function localCatalogItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  // food-db.ts vía InventoryView.tsx (búsqueda en catálogo local): las ~200
  // fichas están atribuidas EN CONJUNTO, no por fila → legacy_unlabeled
  // para las cuatro SIEMPRE, con independencia de foodStateConfidence, que
  // el sitio de captura SÍ fija con la misma salvaguarda de nombre que OFF
  // (resolveFoodStateConfidenceForGenericMatch) — puede llegar a
  // "confirmed", pero nutrientStatus sigue sin ser known_*, así que el día
  // NUNCA puede ser "reliable" para ningún nutriente por esta vía.
  const kcal = 350, protein = 8, carbs = 70, fat = 3;
  return {
    id: "inv-catalog",
    name: "Pasta",
    qty: 500,
    unit: "g",
    storage: "Despensa",
    expires: "2099-01-01",
    price: 1.5,
    kcal, protein, carbs, fat,
    dataSource: "local",
    nutrientStatus: {
      kcal: localCatalogStatusFromValue(kcal),
      protein: localCatalogStatusFromValue(protein),
      carbs: localCatalogStatusFromValue(carbs),
      fat: localCatalogStatusFromValue(fat),
    },
    foodStateConfidence: resolveFoodStateConfidenceForGenericMatch("pasta", "pasta"),
    ...overrides,
  };
}

// ─── Fixtures: FoodLogEntry realistas, uno por cada escritor real ─────────

let seq = 0;
function baseEntry(date: string, overrides: Partial<FoodLogEntry>): FoodLogEntry {
  seq += 1;
  return {
    id: `e${seq}`, date, time: "13:00", name: "entrada", qty: null, unit: null,
    kcal: 0, protein: 0, carbs: 0, fat: 0, source: "manual", mealType: "lunch",
    ...overrides,
  };
}

/** consumeInventoryItem con un item OFF/USDA confirmado (state.tsx:3032).
 *  Usa directamente los macros por-100g del item como si la ración
 *  consumida fuera esa (simplifica el ejemplo; qty/unit no participan en
 *  el cálculo de cobertura, solo en la UI real). */
function offUsdaConsumptionEntry(date: string, item: InventoryItem): FoodLogEntry {
  const p = inventoryConsumptionProvenance(item);
  return baseEntry(date, {
    name: item.name, qty: item.qty, unit: item.unit, source: "inventory",
    kcal: item.kcal, protein: item.protein, carbs: item.carbs ?? 0, fat: item.fat ?? 0,
    ...p,
  });
}

/** cookRecipe (state.tsx:3018) — total agregado, legacy_unlabeled siempre (AC28). */
function recipeCookedEntry(date: string, overridesIgnored: boolean): FoodLogEntry {
  const p = recipeTotalProvenance({ qtyOverridesIgnored: overridesIgnored });
  return baseEntry(date, { name: "Receta cocinada", source: "recipe", kcal: 700, protein: 45, carbs: 60, fat: 25, ...p });
}

/** buildDishLogEntry / buildPlanLogEntry (food-log-entries.ts) — mismo
 *  destino que legacyTotalProvenance; representamos ambos con una sola
 *  construcción porque producen exactamente el mismo tipo de procedencia. */
function manualOrPlanEntry(date: string, kcal = 500): FoodLogEntry {
  return baseEntry(date, { name: "Plato/plan", kcal, protein: 30, carbs: 40, fat: 15, ...legacyTotalProvenance() });
}

/** buildExternalLogEntry (LogMealModal "Externa", comida estimada por IA). */
function aiWholeMealEntry(date: string, kcal = 600): FoodLogEntry {
  return baseEntry(date, { name: "Comida estimada por IA", kcal, protein: 35, carbs: 55, fat: 20, ...aiWholeMealProvenance() });
}

/** Entrada defensiva: metadatos corrompidos/kcal negativo llegando por un
 *  sync parcial o un dato local sin sanear (ver PR4) — el adaptador la
 *  traduce a unknown/null, nunca la descarta. */
function malformedEntry(date: string): FoodLogEntry {
  return baseEntry(date, { name: "Entrada corrupta", kcal: -50, protein: 10, carbs: 10, fat: 5 });
}

// ─── Construcción de la ventana de 28 días ────────────────────────────────

const WINDOW = { startDateKey: "2026-02-01", endDateKey: "2026-02-28" };

const entries: FoodLogEntry[] = [
  // 1: OFF confirmado — el único perfil capaz de ser "reliable" por nutriente.
  offUsdaConsumptionEntry("2026-02-01", offConfirmedItem()),
  // 2: USDA confirmado — mismo perfil, fuente distinta.
  offUsdaConsumptionEntry("2026-02-02", usdaConfirmedItem()),
  // 3: producto escaneado — known_* pero foodState siempre "unknown".
  offUsdaConsumptionEntry("2026-02-03", barcodeScannedItem()),
  // 4: catálogo local — legacy_unlabeled.
  offUsdaConsumptionEntry("2026-02-04", localCatalogItem()),
  // 5: receta cocinada, sin overrides ignorados — legacy_unlabeled.
  recipeCookedEntry("2026-02-05", false),
  // 6: receta cocinada, CON overrides ignorados — legacy_unlabeled también
  //    (el día se clasifica legacy ANTES de llegar a mirar quantityConfidence).
  recipeCookedEntry("2026-02-06", true),
  // 7: comida estimada por IA — estimated/not_applicable, nunca reliable.
  aiWholeMealEntry("2026-02-07"),
  // 8: plato manual / entrada de planificador — legacy_unlabeled.
  manualOrPlanEntry("2026-02-08"),
  // 9: día MIXTO, la fracción fiable NO alcanza 0.8 (600/(600+200)=0.75).
  offUsdaConsumptionEntry("2026-02-09", offConfirmedItem({ kcal: 600, protein: 40, carbs: 0, fat: 13 })),
  aiWholeMealEntry("2026-02-09", 200),
  // 10: día MIXTO, la fracción fiable SÍ alcanza 0.8 (850/(850+50)=0.944).
  offUsdaConsumptionEntry("2026-02-10", offConfirmedItem({ kcal: 850, protein: 60, carbs: 0, fat: 18 })),
  aiWholeMealEntry("2026-02-10", 50),
  // 11: entrada no ponderable (kcal negativo/corrupto) JUNTO a una perfecta
  //     OFF-confirmada — fuerza provisional y excluye el día de CUALQUIER
  //     nutriente fiable, pese a que la otra entrada sea intachable.
  offUsdaConsumptionEntry("2026-02-11", offConfirmedItem({ kcal: 900, protein: 55, carbs: 0, fat: 20 })),
  malformedEntry("2026-02-11"),
  // 12: SOLO una entrada sintética (seedDemo) — el adaptador la filtra por
  //     completo: el día queda igual que si no se hubiera registrado nada.
  { ...manualOrPlanEntry("2026-02-12"), synthetic: true },
  // 13: OFF confirmado por CAMPOS (known_*) pero SIN palabra de estado en
  //     el nombre buscado — el caso mayoritario real. known_* no basta:
  //     foodStateConfidence queda "unknown", nunca "confirmed".
  offUsdaConsumptionEntry("2026-02-13", offConfirmedButUnspecifiedItem()),
];

// ─── Ejecución: dos calibraciones de umbral, para ver cómo cambia el resultado ─

const THRESHOLD_SETS = [
  { label: "dailyReliability=0.8 / provisionalKcalFraction=0.25 (calibración típica de ejemplo)", dailyReliabilityThreshold: 0.8, provisionalKcalFractionThreshold: 0.25 },
  { label: "dailyReliability=0.7 / provisionalKcalFraction=0.25 (umbral diario más laxo)", dailyReliabilityThreshold: 0.7, provisionalKcalFractionThreshold: 0.25 },
  { label: "dailyReliability=0.8 / provisionalKcalFraction=1.0 (desactiva el disparador de provisional por cantidad)", dailyReliabilityThreshold: 0.8, provisionalKcalFractionThreshold: 1.0 },
];

console.log("═══ Nutrition v4 — análisis de viabilidad del gate ═══");
console.log(`Ventana: ${WINDOW.startDateKey} -> ${WINDOW.endDateKey} (28 dias). Entradas reales construidas: ${entries.filter(e => !e.synthetic).length}. Sinteticas (deben filtrarse): ${entries.filter(e => e.synthetic).length}.\n`);

for (const t of THRESHOLD_SETS) {
  const input = buildDiaryIntegrityInput(entries, WINDOW, t);
  const result: DailyIntegrityResult = evaluateNutrientCoverage(input);
  console.log(`─── ${t.label} ───`);
  if (result.status === "invalid_input") {
    console.log("  invalid_input:", result.reasons);
    continue;
  }
  const r = result as DailyIntegrityEvaluated;
  console.log(`  windowDays=${r.windowDays}  unloggedDays=${r.unloggedDays}  legacyUnlabeledDays=${r.legacyUnlabeledDays}  provisionalDays=${r.provisionalDays}`);
  for (const n of r.perNutrient) {
    console.log(`  ${n.nutrient.padEnd(8)} daysWithReliableData=${n.daysWithReliableData}  coverageFraction=${n.coverageFraction.toFixed(4)}`);
  }
  console.log("");
}

// ─── Verificación explícita del reparto día a día (para la tabla del informe) ─

console.log("═══ Detalle día a día (con dailyReliability=0.8, la primera calibración) ═══");
const detailInput = buildDiaryIntegrityInput(entries, WINDOW, THRESHOLD_SETS[0]);
for (const e of detailInput.entries) {
  console.log(JSON.stringify(e));
}
