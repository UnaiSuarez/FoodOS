// PR3 — etiquetado de procedencia en los escritores de `foodLog` que viven en
// state.tsx: cookRecipe, consumeInventoryItem, la migración de consumedMeals y
// el historial DEMO de seedDemo. Cada prueba fija una regla del diseño sobre el
// escritor real (no sobre un constructor aislado).
import { describe, expect, it } from "vitest";
import type { FoodLogEntry, InventoryItem, NutrientStatus, Recipe, RecipeIngredient } from "@foodos/types";
import { actions, buildDemoFoodLog, defaultState, macrosForQuantity, normalizeState } from "./state";

const KNOWN: NutrientStatus[] = ["known_nonzero", "known_zero"];
const MACROS = ["kcal", "protein", "carbs", "fat"] as const;

function inv(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "inv-1", name: "Pollo", qty: 500, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 3,
    kcal: 165, protein: 31, ...overrides,
  };
}

/** Ingrediente con la MEJOR procedencia posible: todo known_nonzero y confirmado. */
function knownIngredient(name: string, quantity: number): RecipeIngredient {
  return {
    name, quantity, unit: "g",
    kcalPer100: 130, proteinPer100: 2.7, carbsPer100: 28, fatPer100: 0.3,
    nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero" },
    foodStateConfidence: "confirmed",
  };
}

function recipe(ingredients: RecipeIngredient[]): Recipe {
  return {
    id: "r-1", title: "Arroz con pollo", ingredients,
    kcal: 500, protein: 40, carbs: 50, fat: 15, cost: 3, image: "", time: 20, servings: 1,
    difficulty: "fácil", tags: [], steps: [],
  };
}

function lastEntry(draft: { foodLog: FoodLogEntry[] }): FoodLogEntry {
  return draft.foodLog[draft.foodLog.length - 1];
}

describe("cookRecipe — AC28: el total de una receta es legacy_unlabeled", () => {
  it("aunque TODOS los ingredientes sean known_nonzero y confirmed, los 4 macros del diario son legacy_unlabeled", () => {
    const draft = structuredClone(defaultState);
    actions.cookRecipe(draft, recipe([knownIngredient("Arroz", 100), knownIngredient("Pollo", 200)]), 1);
    const entry = lastEntry(draft);
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    for (const key of MACROS) expect(KNOWN).not.toContain(entry.nutrientStatus?.[key]);
    expect(entry.foodStateConfidence).toBe("unknown");
    expect(entry.synthetic).toBeUndefined();
  });

  it("el número registrado no cambia por el etiquetado (recipe.kcal × ratio, como antes)", () => {
    const draft = structuredClone(defaultState);
    actions.cookRecipe(draft, recipe([knownIngredient("Arroz", 100)]), 2);
    expect(lastEntry(draft)).toMatchObject({ kcal: 1000, protein: 80, carbs: 100, fat: 30, source: "recipe" });
  });

  it("sin qtyOverrides no hay quantityConfidence", () => {
    const draft = structuredClone(defaultState);
    actions.cookRecipe(draft, recipe([knownIngredient("Arroz", 100)]), 1, { deductIngredients: true });
    expect(lastEntry(draft).quantityConfidence).toBeUndefined();
  });

  it("con qtyOverrides sobre un ingrediente real: quantityConfidence low con motivo overrides_ignored, y los macros NO los reflejan", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [inv({ id: "a", name: "Arroz", qty: 1000, unit: "g" })];
    actions.cookRecipe(draft, recipe([knownIngredient("Arroz", 100)]), 1, { deductIngredients: true, qtyOverrides: { Arroz: 300 } });
    const entry = lastEntry(draft);
    expect(entry.quantityConfidence).toEqual({ level: "low", reason: "overrides_ignored" });
    // El override sí descontó del inventario…
    expect(draft.inventory[0].qty).toBe(700);
    // …pero el número del diario sigue siendo recipe.kcal × ratio (por eso se marca).
    expect(entry.kcal).toBe(500);
    // La procedencia del número no cambia por el override.
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
  });

  it("qtyOverrides con una clave que no es ingrediente de la receta no marca nada", () => {
    const draft = structuredClone(defaultState);
    actions.cookRecipe(draft, recipe([knownIngredient("Arroz", 100)]), 1, { qtyOverrides: { Lentejas: 500 } });
    expect(lastEntry(draft).quantityConfidence).toBeUndefined();
  });

  it("una receta registrada sin descontar inventario (LogMealModal / plan) lleva la misma procedencia", () => {
    const draft = structuredClone(defaultState);
    actions.cookRecipe(draft, recipe([knownIngredient("Arroz", 100)]), 1, { deductIngredients: false, mealType: "dinner" });
    const entry = lastEntry(draft);
    expect(entry.mealType).toBe("dinner");
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
  });
});

describe("consumeInventoryItem — lee la procedencia del item (PR3a)", () => {
  it("un item con procedencia completa propaga nutrientStatus y foodStateConfidence al diario", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [
      inv({
        carbs: 0, fat: 3.6,
        nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
        foodStateConfidence: "confirmed",
      }),
    ];
    actions.consumeInventoryItem(draft, "inv-1", 200);
    const entry = lastEntry(draft);
    expect(entry).toMatchObject({ kcal: 330, protein: 62, carbs: 0, fat: 7.2, source: "inventory", qty: 200, unit: "g" });
    expect(entry.nutrientStatus).toEqual({ kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" });
    expect(entry.foodStateConfidence).toBe("confirmed");
    expect(entry.quantityConfidence).toBeUndefined();
    expect(draft.inventory[0].qty).toBe(300); // el descuento de inventario no cambia
  });

  it("un item anterior a PR3a (sin nutrientStatus) queda legacy_unlabeled: que el número exista no lo hace known_*", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [inv({ carbs: 0, fat: 3.6 })];
    actions.consumeInventoryItem(draft, "inv-1", 100);
    const entry = lastEntry(draft);
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    expect(entry.foodStateConfidence).toBe("unknown");
  });

  it("carbs/grasa imputados por macrosForQuantity quedan estimated y la entrada con quantityConfidence low", () => {
    const draft = structuredClone(defaultState);
    const item = inv({ nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero" } });
    draft.inventory = [item];
    const expected = macrosForQuantity(item, 100);
    actions.consumeInventoryItem(draft, "inv-1", 100);
    const entry = lastEntry(draft);
    expect(entry).toMatchObject(expected); // los números imputados son los de siempre
    expect(entry.nutrientStatus).toMatchObject({ kcal: "known_nonzero", protein: "known_nonzero", carbs: "estimated", fat: "estimated" });
    expect(entry.quantityConfidence).toEqual({ level: "low" });
  });

  it("AC19 de extremo a extremo: un item de IA nunca deja known_* en el diario", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [
      inv({
        dataSource: "ai", carbs: 1, fat: 1,
        nutrientStatus: { kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "estimated" },
        foodStateConfidence: "not_applicable",
      }),
    ];
    actions.consumeInventoryItem(draft, "inv-1", 100);
    const entry = lastEntry(draft);
    for (const key of MACROS) expect(KNOWN).not.toContain(entry.nutrientStatus?.[key]);
    expect(entry.nutrientStatus).toEqual({ kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "estimated" });
  });

  it("un known_nonzero cuyo valor escalado se redondea a 0 pasa a estimated (el kernel exige known_nonzero ⇒ > 0)", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [
      inv({
        kcal: 165, protein: 0.3, carbs: 0.1, fat: 0.1,
        nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero" },
      }),
    ];
    actions.consumeInventoryItem(draft, "inv-1", 5); // 5 g: protein 0.015 → 0.0
    const entry = lastEntry(draft);
    expect(entry.protein).toBe(0);
    expect(entry.nutrientStatus?.protein).toBe("estimated");
    expect(entry.nutrientStatus?.kcal).toBe("known_nonzero"); // 8 kcal sigue siendo > 0
  });

  it("known_zero sigue siendo known_zero cuando el valor guardado es 0", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [
      inv({
        kcal: 0, protein: 0, carbs: 0, fat: 0,
        nutrientStatus: { kcal: "known_zero", protein: "known_zero", carbs: "known_zero", fat: "known_zero" },
      }),
    ];
    actions.consumeInventoryItem(draft, "inv-1", 100);
    const entry = lastEntry(draft);
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("known_zero");
  });

  it("'unknown' guardado con relleno 0 sigue unknown en el diario (ausencia ≠ cero)", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [
      inv({ carbs: 0, fat: 0, nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "unknown", fat: "unknown" } }),
    ];
    actions.consumeInventoryItem(draft, "inv-1", 100);
    const entry = lastEntry(draft);
    expect(entry.nutrientStatus).toMatchObject({ carbs: "unknown", fat: "unknown" });
  });

  it("'ud' sin tamaño de unidad → missing_unit_size", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [inv({ unit: "ud", qty: 3, carbs: 1, fat: 1 })];
    actions.consumeInventoryItem(draft, "inv-1", 1);
    expect(lastEntry(draft).quantityConfidence).toEqual({ level: "low", reason: "missing_unit_size" });
  });

  it("un item inexistente no escribe nada (comportamiento previo intacto)", () => {
    const draft = structuredClone(defaultState);
    actions.consumeInventoryItem(draft, "no-existe", 10);
    expect(draft.foodLog).toHaveLength(0);
  });
});

describe("normalizeState — no reescribe el pasado", () => {
  it("la migración de consumedMeals etiqueta legacy_unlabeled los 4 macros, sin synthetic ni known_*", () => {
    const legacy = {
      ...defaultState,
      consumedMeals: [{ id: "old-1", name: "Tortilla", kcal: 300, protein: 18, carbs: 5, fat: 20 }],
    };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    const entry = next.foodLog[0];
    expect(entry).toMatchObject({ name: "Tortilla", kcal: 300, protein: 18, carbs: 5, fat: 20 });
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    expect(entry.foodStateConfidence).toBe("unknown");
    expect(entry.synthetic).toBeUndefined();
  });

  it("una entrada histórica SIN metadatos sigue sin metadatos: no se le inventa ninguna etiqueta", () => {
    const old: FoodLogEntry = {
      id: "h-1", date: "2026-01-10", time: "13:00", name: "Comida antigua", qty: null, unit: null,
      kcal: 500, protein: 30, carbs: 50, fat: 15, source: "manual", mealType: "lunch",
    };
    const next = normalizeState({ ...defaultState, foodLog: [old] });
    expect(next.foodLog[0]).toEqual(old);
    expect(next.foodLog[0].nutrientStatus).toBeUndefined();
    expect(next.foodLog[0].foodStateConfidence).toBeUndefined();
    expect(next.foodLog[0].quantityConfidence).toBeUndefined();
  });

  it("una entrada ya etiquetada (incluido synthetic) sobrevive intacta a normalizeState", () => {
    const labeled: FoodLogEntry = {
      id: "l-1", date: "2026-01-10", time: "13:00", name: "Etiquetada", qty: 100, unit: "g",
      kcal: 165, protein: 31, carbs: 0, fat: 3.6, source: "inventory", mealType: "lunch",
      nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
      foodStateConfidence: "confirmed",
      quantityConfidence: { level: "low", reason: "missing_unit_size" },
    };
    const demo: FoodLogEntry = { ...labeled, id: "d-1", synthetic: true, nutrientStatus: undefined, foodStateConfidence: undefined, quantityConfidence: undefined };
    const next = normalizeState({ ...defaultState, foodLog: [labeled, demo] });
    expect(next.foodLog[0]).toEqual(labeled);
    expect(next.foodLog[1].synthetic).toBe(true);
  });
});

describe("buildDemoFoodLog — 'Cargar datos demo' (noveno escritor, no listado en §1.4)", () => {
  const dateOf = (n: number) => `2026-09-${String(20 - n).padStart(2, "0")}`;

  it("TODAS las filas son synthetic:true y ninguna lleva procedencia real", () => {
    const entries = buildDemoFoodLog(dateOf);
    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect(entry.synthetic).toBe(true);
      expect(entry.nutrientStatus).toBeUndefined();
      expect(entry.foodStateConfidence).toBeUndefined();
      expect(entry.quantityConfidence).toBeUndefined();
    }
  });

  it("los números y fechas de demo no cambian (solo se marcan)", () => {
    const entries = buildDemoFoodLog(dateOf);
    expect(entries.map((e) => [e.date, e.name, e.kcal, e.protein, e.carbs, e.fat])).toEqual([
      ["2026-09-19", "Tostada de huevo y yogur", 480, 32, 48, 18],
      ["2026-09-19", "Bowl proteico de pollo", 610, 54, 72, 12],
      ["2026-09-19", "Yogur griego", 119, 12.5, 5, 6],
      ["2026-09-18", "Pasta rápida con atún", 690, 42, 96, 14],
      ["2026-09-18", "Lentejas de despensa", 540, 28, 92, 7],
    ]);
  });

  it("cada llamada genera ids distintos", () => {
    const a = buildDemoFoodLog(dateOf).map((e) => e.id);
    const b = buildDemoFoodLog(dateOf).map((e) => e.id);
    expect(new Set([...a, ...b]).size).toBe(10);
  });
});
