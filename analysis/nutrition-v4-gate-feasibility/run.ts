// Nutrition v4 — PARTE 0: tabla de escenarios (un día por cada perfil de
// escritor real). Ver fixtures.ts para cómo se construye cada entrada.
// Ejecutar: npx tsx run.ts

import {
  aiWholeMealEntry, inventoryConsumptionEntry, manualOrPlanEntry, malformedEntry,
  offConfirmedButUnspecifiedItem, offConfirmedItem, usdaConfirmedItem, barcodeScannedItem, localCatalogItem,
  recipeCookedEntry, runWindow, printEvaluated, THRESHOLD_SETS,
  buildDiaryIntegrityInput,
  type FoodLogEntry,
} from "./fixtures";

const WINDOW = { startDateKey: "2026-02-01", endDateKey: "2026-02-28" };

const entries: FoodLogEntry[] = [
  inventoryConsumptionEntry("2026-02-01", offConfirmedItem()),
  inventoryConsumptionEntry("2026-02-02", usdaConfirmedItem()),
  inventoryConsumptionEntry("2026-02-03", barcodeScannedItem()),
  inventoryConsumptionEntry("2026-02-04", localCatalogItem()),
  recipeCookedEntry("2026-02-05", false),
  recipeCookedEntry("2026-02-06", true),
  aiWholeMealEntry("2026-02-07"),
  manualOrPlanEntry("2026-02-08"),
  inventoryConsumptionEntry("2026-02-09", offConfirmedItem({ kcal: 600, protein: 40, carbs: 0, fat: 13 })),
  aiWholeMealEntry("2026-02-09", 200),
  inventoryConsumptionEntry("2026-02-10", offConfirmedItem({ kcal: 850, protein: 60, carbs: 0, fat: 18 })),
  aiWholeMealEntry("2026-02-10", 50),
  inventoryConsumptionEntry("2026-02-11", offConfirmedItem({ kcal: 900, protein: 55, carbs: 0, fat: 20 })),
  malformedEntry("2026-02-11"),
  { ...manualOrPlanEntry("2026-02-12"), synthetic: true },
  inventoryConsumptionEntry("2026-02-13", offConfirmedButUnspecifiedItem()),
];

console.log("=== PARTE 0: tabla de escenarios ===");
console.log(`Ventana: ${WINDOW.startDateKey} -> ${WINDOW.endDateKey}. Entradas reales: ${entries.filter(e => !e.synthetic).length}. Sinteticas: ${entries.filter(e => e.synthetic).length}.\n`);

for (const t of THRESHOLD_SETS) printEvaluated(t.label, runWindow(entries, WINDOW, t));

console.log("\n=== Detalle dia a dia (dailyReliability=0.8/provisionalKcalFraction=0.25) ===");
for (const e of buildDiaryIntegrityInput(entries, WINDOW, THRESHOLD_SETS[0]).entries) console.log(JSON.stringify(e));
