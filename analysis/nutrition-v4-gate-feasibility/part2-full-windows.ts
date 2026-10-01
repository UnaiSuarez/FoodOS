// Nutrition v4 — PARTE 2: separar "cobertura fiable por nutriente, para
// ciertas entradas" (ya demostrado en la parte 0) de "una decisión completa
// de activación" (no implementada, no evaluada aún). Tres ventanas de 28
// días COMPLETAS con uso sostenido de un solo perfil cada una, más una
// mixta realista. Los umbrales (0.7/0.8/0.25) son ILUSTRATIVOS — el propio
// script los etiqueta así, no son una calibración aprobada.
//
// Ejecutar: npx tsx part2-full-windows.ts

import {
  aiWholeMealEntry, inventoryConsumptionEntry, manualOrPlanEntry, recipeCookedEntry,
  offConfirmedItem, barcodeScannedItem, runWindow, printEvaluated, THRESHOLD_SETS,
  type FoodLogEntry,
} from "./fixtures";

const WINDOW = { startDateKey: "2026-04-01", endDateKey: "2026-04-28" };

function daysOf(start: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10))));
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const DAYS_28 = daysOf(WINDOW.startDateKey, 28);

// ─── A: consumo directo OFF/USDA confirmado, TODOS los días ────────────────
// Perfil disciplinado: cada día, una sola ingesta de inventario capturada
// por texto con un nombre que declara estado (confirmed) y campos known_*.
const windowA: FoodLogEntry[] = DAYS_28.map((date) =>
  inventoryConsumptionEntry(date, offConfirmedItem({ id: `inv-${date}`, kcal: 2000, protein: 120, carbs: 0, fat: 60 })),
);

// ─── B: uso MIXTO realista — inventario, recetas y planificador ───────────
// Patrón: 2 de cada 7 días con receta cocinada (fin de semana), 1 de cada 7
// con plato/plan (sobras del congelador), el resto consumo de inventario
// confirmado. Representa un usuario que SÍ usa el inventario con disciplina
// pero también cocina y usa el planificador como cualquier usuario real.
const windowB: FoodLogEntry[] = DAYS_28.flatMap((date, i) => {
  const dow = i % 7;
  if (dow === 5 || dow === 6) return [recipeCookedEntry(date, false, 750)]; // fin de semana: receta
  if (dow === 3) return [manualOrPlanEntry(date, 550)]; // plato/plan entre semana
  return [inventoryConsumptionEntry(date, offConfirmedItem({ id: `inv-${date}`, kcal: 1900, protein: 110, carbs: 0, fat: 55 }))];
});

// ─── C: consumo de productos por código de barras, TODOS los días ────────
// known_* por campos, pero foodStateConfidence SIEMPRE "unknown" (AC19).
const windowC: FoodLogEntry[] = DAYS_28.map((date) =>
  inventoryConsumptionEntry(date, barcodeScannedItem({ id: `inv-${date}` })),
);

console.log("=== PARTE 2: tres ventanas completas de 28 dias (uso sostenido, no un dia suelto) ===\n");

console.log("--- A: consumo directo OFF/USDA confirmado, los 28 dias ---");
for (const t of THRESHOLD_SETS) printEvaluated(t.label, runWindow(windowA, WINDOW, t));

console.log("\n--- B: uso MIXTO realista (inventario + receta fin de semana + plato entre semana) ---");
for (const t of THRESHOLD_SETS) printEvaluated(t.label, runWindow(windowB, WINDOW, t));

console.log("\n--- C: codigo de barras, los 28 dias ---");
for (const t of THRESHOLD_SETS) printEvaluated(t.label, runWindow(windowC, WINDOW, t));
