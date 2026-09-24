// PR3 — los escritores de los componentes (LogMealModal ×2, HomeView,
// PlannerView, SettingsView/seedHistorico). Se prueban sobre los constructores
// puros que esos componentes llaman; food-log-writers.test.ts comprueba después
// que cada componente los usa de verdad y que no queda otro escritor sin cubrir.
import { describe, expect, it } from "vitest";
import type { FoodLogEntry, NutrientStatus } from "@foodos/types";
import { buildDiaryIntegrityInput } from "./nutrition-v4-adapter";
import {
  buildDishLogEntry,
  buildExternalLogEntry,
  buildPlanLogEntry,
  HISTORICAL_SEED_MEALS,
  syntheticSeedMealsForDate,
} from "./food-log-entries";

const KNOWN: NutrientStatus[] = ["known_nonzero", "known_zero"];
const MACROS = ["kcal", "protein", "carbs", "fat"] as const;

function seqIds() {
  let n = 0;
  return () => `id-${++n}`;
}

describe("buildDishLogEntry — plato compuesto (LogMealModal, pestaña Plato)", () => {
  const base = { id: "e1", date: "2026-09-20", time: "13:10", name: "Plato elaborado", mealType: "lunch" as const };

  it("los 4 macros son legacy_unlabeled y foodStateConfidence unknown: el total no hereda la certeza de los ingredientes", () => {
    const entry = buildDishLogEntry({ ...base, macros: { kcal: 612.4, protein: 40.06, carbs: 70, fat: 18.44 }, consumedIngredients: [] });
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    expect(entry.foodStateConfidence).toBe("unknown");
    expect(entry.synthetic).toBeUndefined();
  });

  it("reproduce el objeto de siempre: mismos campos y redondeos, origen manual", () => {
    const entry = buildDishLogEntry({ ...base, macros: { kcal: 612.4, protein: 40.06, carbs: 70, fat: 18.44 }, consumedIngredients: [] });
    expect(entry).toMatchObject({ id: "e1", date: "2026-09-20", time: "13:10", name: "Plato elaborado", qty: null, unit: null, kcal: 612, protein: 40.1, carbs: 70, fat: 18.4, source: "manual", mealType: "lunch" });
  });

  it("consumedIngredients solo se incluye si hay alguno", () => {
    const macros = { kcal: 100, protein: 1, carbs: 1, fat: 1 };
    expect("consumedIngredients" in buildDishLogEntry({ ...base, macros, consumedIngredients: [] })).toBe(false);
    const ing = [{ inventoryItemId: "i1", name: "Arroz", qty: 100, unit: "g" }];
    expect(buildDishLogEntry({ ...base, macros, consumedIngredients: ing }).consumedIngredients).toEqual(ing);
  });
});

describe("buildExternalLogEntry — comida estimada por IA (LogMealModal, pestaña Externa)", () => {
  const base = { id: "e2", date: "2026-09-20", time: "21:00", name: "Pizza", mealType: "dinner" as const, macros: { kcal: 800, protein: 30, carbs: 90, fat: 35 } };

  it("los 4 macros son estimated (nunca known_*) y foodStateConfidence not_applicable", () => {
    const entry = buildExternalLogEntry(base);
    expect(entry.nutrientStatus).toEqual({ kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "estimated" });
    for (const key of MACROS) expect(KNOWN).not.toContain(entry.nutrientStatus?.[key]);
    expect(entry.foodStateConfidence).toBe("not_applicable");
  });

  it("los números no cambian y el origen sigue siendo manual (P6, hallazgo conocido)", () => {
    expect(buildExternalLogEntry(base)).toMatchObject({ kcal: 800, protein: 30, carbs: 90, fat: 35, source: "manual", qty: null, unit: null });
  });

  it("un macro que la IA omitió y la persona no tocó queda unknown, no un cero inventado", () => {
    const entry = buildExternalLogEntry({ ...base, macros: { ...base.macros, fat: 0 }, estimate: { nutrientStatus: { kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "unknown" } } });
    expect(entry.nutrientStatus?.fat).toBe("unknown");
    expect(entry.nutrientStatus?.kcal).toBe("estimated");
  });

  it("un macro ajustado a mano sigue siendo estimated — también si estaba unknown, y vaciar el campo (0) no da known_zero", () => {
    const entry = buildExternalLogEntry({
      ...base,
      macros: { kcal: 800, protein: 0, carbs: 90, fat: 22 },
      estimate: {
        nutrientStatus: { kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "unknown" },
        editedFields: ["protein", "fat"],
      },
    });
    expect(entry.nutrientStatus?.protein).toBe("estimated");
    expect(entry.nutrientStatus?.fat).toBe("estimated");
    expect(entry.nutrientStatus?.protein).not.toBe("known_zero");
  });

  it("aunque el estimador devolviera known_*, se rebaja a estimated", () => {
    const entry = buildExternalLogEntry({ ...base, estimate: { nutrientStatus: { kcal: "known_nonzero", protein: "known_zero", carbs: "known_nonzero", fat: "known_nonzero" } } });
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("estimated");
  });
});

describe("buildPlanLogEntry — HomeView 'Plan de hoy' y PlannerView 'plato rápido'", () => {
  const input = { id: "e3", date: "2026-09-20", time: "09:00", title: "Tortilla", macros: { kcal: 300, protein: 18, carbs: 5, fat: 20 }, mealType: "breakfast" as const };

  it("los 4 macros son legacy_unlabeled: ni Recipe ni QuickMeal conservan el origen de sus totales", () => {
    const entry = buildPlanLogEntry(input);
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    expect(entry.foodStateConfidence).toBe("unknown");
    expect(entry.quantityConfidence).toBeUndefined();
  });

  it("reproduce el objeto de siempre: título como nombre, origen recipe, números tal cual", () => {
    expect(buildPlanLogEntry(input)).toMatchObject({ id: "e3", date: "2026-09-20", time: "09:00", name: "Tortilla", qty: null, unit: null, kcal: 300, protein: 18, carbs: 5, fat: 20, source: "recipe", mealType: "breakfast" });
  });
});

describe("syntheticSeedMealsForDate — seedHistorico", () => {
  it("las 3 comidas del día son synthetic:true y ninguna lleva nutrientStatus, foodStateConfidence ni quantityConfidence", () => {
    const meals = syntheticSeedMealsForDate("2026-09-19", [], seqIds());
    expect(meals).toHaveLength(3);
    for (const meal of meals) {
      expect(meal.synthetic).toBe(true);
      expect(meal.nutrientStatus).toBeUndefined();
      expect(meal.foodStateConfidence).toBeUndefined();
      expect(meal.quantityConfidence).toBeUndefined();
    }
  });

  it("mismas comidas, números, horas y origen que antes (solo se marcan)", () => {
    const meals = syntheticSeedMealsForDate("2026-09-19", [], seqIds());
    expect(meals.map((m) => [m.time, m.name, m.kcal, m.protein, m.carbs, m.fat, m.mealType, m.source, m.qty, m.unit])).toEqual([
      ["08:30", "Avena con proteína", 380, 28, 52, 8, "breakfast", "manual", null, null],
      ["13:30", "Pechuga de pollo con arroz", 520, 42, 65, 9, "lunch", "manual", null, null],
      ["20:30", "Salmón con verduras", 440, 38, 18, 22, "dinner", "manual", null, null],
    ]);
  });

  it("mantiene la guarda de deduplicación por (fecha, nombre)", () => {
    const first = syntheticSeedMealsForDate("2026-09-19", [], seqIds());
    expect(syntheticSeedMealsForDate("2026-09-19", first, seqIds())).toEqual([]);
    // otra fecha, o mismo día con otro nombre, no bloquea
    expect(syntheticSeedMealsForDate("2026-09-18", first, seqIds())).toHaveLength(3);
    const one = [{ ...first[0], name: "Otra cosa" }];
    expect(syntheticSeedMealsForDate("2026-09-19", one, seqIds())).toHaveLength(3);
    const real = [{ ...first[0], synthetic: undefined }]; // una entrada real con el mismo nombre también bloquea, como antes
    expect(syntheticSeedMealsForDate("2026-09-19", real, seqIds())).toHaveLength(2);
  });

  it("el catálogo del seed sigue siendo el de siempre (3 comidas)", () => {
    expect(HISTORICAL_SEED_MEALS.map((m) => m.name)).toEqual(["Avena con proteína", "Pechuga de pollo con arroz", "Salmón con verduras"]);
  });
});

describe("seedHistorico + adaptador de PR2 — filtrado por ENTRADA sin reducir la ventana (§1.5, §6, AC18/AC20/AC21)", () => {
  // 7 días sembrados dentro de una ventana de 28: 21 filas sintéticas.
  const WINDOW28 = { startDateKey: "2026-08-24", endDateKey: "2026-09-20" };
  const THRESHOLDS = { dailyReliabilityThreshold: 0.8, provisionalKcalFractionThreshold: 0.25 };

  function seeded(): FoodLogEntry[] {
    const log: FoodLogEntry[] = [];
    const newId = seqIds();
    for (let i = 1; i <= 7; i++) {
      const day = String(20 - i).padStart(2, "0");
      log.push(...syntheticSeedMealsForDate(`2026-09-${day}`, log, newId));
    }
    return log;
  }

  it("las 21 filas sembradas no llegan al kernel, y la ventana de 28 días llega intacta", () => {
    const log = seeded();
    expect(log).toHaveLength(21);
    expect(log.every((e) => e.synthetic === true)).toBe(true);
    const input = buildDiaryIntegrityInput(log, WINDOW28, THRESHOLDS);
    expect(input.entries).toHaveLength(0);
    expect(input.startDateKey).toBe("2026-08-24");
    expect(input.endDateKey).toBe("2026-09-20");
    // 24/08 → 20/09 son 28 días de calendario: la ventana NO se acorta por haber filtrado.
    const days = (Date.UTC(2026, 8, 20) - Date.UTC(2026, 7, 24)) / 86_400_000 + 1;
    expect(days).toBe(28);
  });

  it("un día con una entrada real y una sintética conserva la real (AC20): solo se filtra la fila sintética", () => {
    const real: FoodLogEntry = {
      id: "real-1", date: "2026-09-19", time: "10:00", name: "Desayuno real", qty: 100, unit: "g",
      kcal: 400, protein: 20, carbs: 40, fat: 15, source: "inventory", mealType: "breakfast",
      nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero" },
    };
    const input = buildDiaryIntegrityInput([...seeded(), real], WINDOW28, THRESHOLDS);
    expect(input.entries).toHaveLength(1);
    expect(input.entries[0].dateKey).toBe("2026-09-19");
    expect(input.entries[0].nutrients.kcal?.value).toBe(400);
  });
});
