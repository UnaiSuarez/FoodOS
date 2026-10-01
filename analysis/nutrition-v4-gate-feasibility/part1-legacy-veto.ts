// Nutrition v4 — PARTE 1: corrección del caso "receta/legacy mezclada con
// una ingesta confirmada". La formulación anterior ("invalida el día si
// pesa una fracción suficiente") describía mal el kernel: `isUnweighableEntry`
// es un VETO binario por entrada, no una tolerancia ponderada. Una sola
// entrada con kcal no ponderable (ausente, "unknown" o "legacy_unlabeled")
// fuerza `provisionalDays` y excluye el día de CUALQUIER nutriente fiable,
// con independencia de cuánto pese esa entrada frente a las demás.
//
// Ejecutar: npx tsx part1-legacy-veto.ts

import {
  inventoryConsumptionEntry, offConfirmedItem, recipeCookedEntry, manualOrPlanEntry,
  runWindow, printEvaluated, buildDiaryIntegrityInput, type FoodLogEntry,
} from "./fixtures";

const WINDOW_1DAY = { startDateKey: "2026-03-01", endDateKey: "2026-03-01" };
const THRESHOLDS = { dailyReliabilityThreshold: 0.8, provisionalKcalFractionThreshold: 0.25 };

console.log("=== PARTE 1: veto por entrada no ponderable, no tolerancia ponderada ===\n");

// Caso A: 900 kcal confirmadas (reliable) + 10 kcal de receta legacy en el
// MISMO día. La receta "pesa" solo el 1.1% del kcal total del día.
const caseA: FoodLogEntry[] = [
  inventoryConsumptionEntry("2026-03-01", offConfirmedItem({ kcal: 900, protein: 55, carbs: 0, fat: 20 })),
  recipeCookedEntry("2026-03-01", false, 10),
];
console.log("Caso A: 900 kcal confirmadas + 10 kcal receta legacy (1.1% del día)");
console.log(JSON.stringify(buildDiaryIntegrityInput(caseA, WINDOW_1DAY, THRESHOLDS).entries, null, 0));
printEvaluated("Caso A — resultado real", runWindow(caseA, WINDOW_1DAY, THRESHOLDS));
console.log("  -> Si fuera una tolerancia PONDERADA, 10/910=1.1% de kcal 'no ponderable' pasaria\n     facilmente cualquier umbral razonable y el dia seria fiable. NO lo es: ver arriba.\n");

// Caso B, contraste: 900 kcal confirmadas SOLAS (sin la receta) — mismo día,
// mismos umbrales. Debe ser fiable para los 4 macros.
const caseB: FoodLogEntry[] = [
  inventoryConsumptionEntry("2026-03-01", offConfirmedItem({ kcal: 900, protein: 55, carbs: 0, fat: 20 })),
];
console.log("Caso B (contraste): las mismas 900 kcal confirmadas, SIN la receta legacy");
printEvaluated("Caso B — resultado real", runWindow(caseB, WINDOW_1DAY, THRESHOLDS));

// Caso C, contraste: día compuesto EXCLUSIVAMENTE por entradas legacy (sin
// ninguna entrada known_*) — este SÍ debe caer en legacyUnlabeledDays, no en
// provisionalDays ni en "excluido del todo": son ramas distintas del kernel.
const caseC: FoodLogEntry[] = [
  recipeCookedEntry("2026-03-01", false, 700),
  manualOrPlanEntry("2026-03-01", 200),
];
console.log("\nCaso C (contraste): día compuesto SOLO por entradas legacy (receta + plato)");
printEvaluated("Caso C — resultado real", runWindow(caseC, WINDOW_1DAY, THRESHOLDS));
console.log("  -> legacyUnlabeledDays=1 aqui, NO provisionalDays: son ramas mutuamente excluyentes\n     del kernel (ver el `continue` tras legacyUnlabeledDays+=1 en computeEvaluated).");
