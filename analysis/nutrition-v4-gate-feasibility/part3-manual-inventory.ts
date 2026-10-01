// Nutrition v4 — PARTE 3: recorrido de creacion/edicion MANUAL de
// inventario, por separado de "Plato" del diario (que es SIEMPRE
// legacy_unlabeled, AC28 — un camino completamente distinto). Usa
// literalmente applyManualNutrientEdit/foodStateConfidenceAfterInventoryEdit
// (InventoryView.tsx/EditInventoryModal.tsx), no una reconstruccion propia.
//
// Ejecutar: npx tsx part3-manual-inventory.ts

import {
  applyManualNutrientEdit, foodStateConfidenceAfterInventoryEdit, offConfirmedItem,
  inventoryConsumptionEntry, runWindow, printEvaluated, buildDiaryIntegrityInput,
  type InventoryItem,
} from "./fixtures";

const WINDOW_1DAY = { startDateKey: "2026-05-01", endDateKey: "2026-05-01" };
const THRESHOLDS = { dailyReliabilityThreshold: 0.8, provisionalKcalFractionThreshold: 0.25 };

console.log("=== PARTE 3: creacion y edicion MANUAL de inventario (InventoryView/EditInventoryModal) ===\n");

// ─── 3.1: creacion 100% manual, kcal+proteina tecleados, nombre declara
// estado, carbs/grasa SIN rellenar en "Datos avanzados" (quedan ausentes
// del item por completo, ni siquiera un numero). ─────────────────────────
{
  let nutrientStatus = {};
  let foodStateConfidence: any = undefined;
  let referenceFields: any[] = [];
  let manualFields: any[] = [];
  const name = "Pollo crudo casero";

  // El usuario teclea kcal, luego proteina — exactamente la secuencia de
  // setField() en InventoryView.tsx.
  let edit = applyManualNutrientEdit({ key: "kcal", value: 165, name, nutrientStatus, foodStateConfidence, referenceFields, manualFields });
  ({ nutrientStatus, foodStateConfidence, manualFields } = edit);
  edit = applyManualNutrientEdit({ key: "protein", value: 31, name, nutrientStatus, foodStateConfidence, referenceFields, manualFields });
  ({ nutrientStatus, foodStateConfidence, manualFields } = edit);

  const item: InventoryItem = {
    id: "inv-manual-1", name, qty: 500, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 4,
    kcal: 165, protein: 31, // carbs/fat: AUSENTES (nunca rellenados)
    nutrientStatus, foodStateConfidence,
  };
  console.log("3.1 — 100% manual, carbs/fat ausentes:");
  console.log("  item.nutrientStatus =", JSON.stringify(item.nutrientStatus));
  console.log("  item.foodStateConfidence =", item.foodStateConfidence);
  const entry = inventoryConsumptionEntry("2026-05-01", item);
  console.log("  entrada del diario:", JSON.stringify(buildDiaryIntegrityInput([entry], WINDOW_1DAY, THRESHOLDS).entries[0]));
  printEvaluated("3.1 — resultado real", runWindow([entry], WINDOW_1DAY, THRESHOLDS));
  console.log("");
}

// ─── 3.2: igual que 3.1 pero el usuario SÍ rellena carbs/grasa en "Datos
// avanzados" — esos dos campos NUNCA pasan por applyManualNutrientEdit
// (limitación estructural de EditInventoryModal/InventoryView: solo
// kcal/proteína se editan ahí), así que quedan con NÚMERO pero SIN
// nutrientStatus propio → legacy_unlabeled al consumir, nunca known_*. ───
{
  let nutrientStatus = {};
  let foodStateConfidence: any = undefined;
  const name = "Pollo crudo casero";
  let edit = applyManualNutrientEdit({ key: "kcal", value: 165, name, nutrientStatus, foodStateConfidence, referenceFields: [], manualFields: [] });
  ({ nutrientStatus, foodStateConfidence } = edit);
  edit = applyManualNutrientEdit({ key: "protein", value: 31, name, nutrientStatus, foodStateConfidence, referenceFields: [], manualFields: edit.manualFields });
  ({ nutrientStatus, foodStateConfidence } = edit);

  const item: InventoryItem = {
    id: "inv-manual-2", name, qty: 500, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 4,
    kcal: 165, protein: 31, carbs: 0, fat: 3.6, // escritos a mano en "Datos avanzados", SIN pasar por applyManualNutrientEdit
    nutrientStatus, foodStateConfidence,
  };
  console.log("3.2 — 100% manual, carbs/fat CON número pero sin nutrientStatus propio:");
  console.log("  item.nutrientStatus =", JSON.stringify(item.nutrientStatus), " (carbs/fat ausentes del mapa)");
  const entry = inventoryConsumptionEntry("2026-05-01", item);
  const kernelEntry = buildDiaryIntegrityInput([entry], WINDOW_1DAY, THRESHOLDS).entries[0];
  console.log("  entrada del diario:", JSON.stringify(kernelEntry));
  printEvaluated("3.2 — resultado real (fijarse: kcal/protein vs carbs/fat)", runWindow([entry], WINDOW_1DAY, THRESHOLDS));
  console.log("  -> kcal y protein SI pueden ser 'reliable' por esta via (known_nonzero + confirmed,\n     per_unit_reference via nombre). carbs y fat NUNCA, aunque tengan numero: estructural,\n     no un descuido de este ejemplo — EditInventoryModal solo edita kcal/proteina.\n");
}

// ─── 3.3: editar UN SOLO macro (kcal) de un item que vino de OFF confirmado
// — demuestra que foodStateConfidence se REBAJA de confirmed a unknown,
// aunque protein/carbs/fat sigan intactos con su known_* original. ────────
{
  const original = offConfirmedItem(); // confirmed + known_* en los 4
  const kcalChanged = true, proteinChanged = false;
  const nextNutrientStatus = {
    ...original.nutrientStatus,
    kcal: "known_nonzero" as const, // manualStatusFromValue(nuevoValor, true) con nuevoValor>0
  };
  const nextFoodState = foodStateConfidenceAfterInventoryEdit({
    item: original, nextName: original.name, kcalChanged, proteinChanged,
  });
  console.log("3.3 — editar SOLO kcal en un item OFF-confirmado:");
  console.log("  foodStateConfidence ANTES =", original.foodStateConfidence, " -> DESPUES =", nextFoodState);
  const editedItem: InventoryItem = { ...original, kcal: 170, nutrientStatus: nextNutrientStatus, foodStateConfidence: nextFoodState };
  const entry = inventoryConsumptionEntry("2026-05-01", editedItem);
  printEvaluated("3.3 — resultado real (ningun nutriente reliable, pese a known_* en los 4)", runWindow([entry], WINDOW_1DAY, THRESHOLDS));
  console.log("  -> Editar un solo macro a mano sobre un item con referencia externa APAGA la\n     fiabilidad de TODOS los nutrientes de esa entrada, no solo del editado.\n");
}
