import { describe, expect, it } from "vitest";
import type { CartItem, InventoryItem, Recipe } from "@foodos/types";
import { actions, defaultState, getIngredientStatus, getRecipeMatch, normalizeState } from "./state";

function inv(overrides: Partial<InventoryItem>): InventoryItem {
  return {
    id: overrides.id ?? "inv-1",
    name: overrides.name ?? "Pollo",
    qty: overrides.qty ?? 100,
    unit: overrides.unit ?? "g",
    storage: overrides.storage ?? "Nevera",
    expires: overrides.expires ?? "2099-01-01",
    price: overrides.price ?? 1,
    kcal: overrides.kcal ?? 100,
    protein: overrides.protein ?? 20,
    ...overrides,
  };
}

function recipe(ingredients: Recipe["ingredients"]): Recipe {
  return {
    id: "r-1",
    title: "Receta de prueba",
    ingredients,
    kcal: 500,
    protein: 40,
    carbs: 50,
    fat: 15,
    cost: 3,
    image: "",
    time: 20,
    servings: 1,
    difficulty: "fácil",
    tags: [],
    steps: [],
  };
}

// E08-06: getRecipeMatch/getIngredientStatus consideran cantidad, no solo si
// existe algo con ese nombre en inventario.
describe("getRecipeMatch — cantidad, no solo nombre (E08-06)", () => {
  it("no cuenta un ingrediente como disponible si hay menos cantidad de la que pide la receta", () => {
    const state = { ...defaultState, inventory: [inv({ name: "Pollo", qty: 50, unit: "g" })] };
    const r = recipe([{ name: "Pollo", quantity: 500, unit: "g" }]);
    const match = getRecipeMatch(state, r);
    expect(match.matches).toHaveLength(0);
    expect(match.pct).toBe(0);
  });

  it("cuenta el ingrediente como disponible cuando la cantidad alcanza (sumando varios lotes)", () => {
    const state = {
      ...defaultState,
      inventory: [
        inv({ id: "a", name: "Pollo", qty: 300, unit: "g" }),
        inv({ id: "b", name: "Pollo", qty: 250, unit: "g" }),
      ],
    };
    const r = recipe([{ name: "Pollo", quantity: 500, unit: "g" }]);
    const match = getRecipeMatch(state, r);
    expect(match.matches).toHaveLength(1);
    expect(match.pct).toBe(100);
  });

  it("convierte unidades (kg de inventario vs g de la receta) antes de comparar", () => {
    const state = { ...defaultState, inventory: [inv({ name: "Arroz", qty: 1, unit: "kg" })] };
    const r = recipe([{ name: "Arroz", quantity: 200, unit: "g" }]);
    expect(getRecipeMatch(state, r).pct).toBe(100);
  });
});

describe("getIngredientStatus — mismo criterio por ingrediente (E08-05/06)", () => {
  it("marca has:false si la cantidad disponible no llega, aunque el nombre exista en inventario", () => {
    const state = { ...defaultState, inventory: [inv({ name: "Leche", qty: 50, unit: "ml" })] };
    const r = recipe([{ name: "Leche", quantity: 200, unit: "ml" }]);
    const status = getIngredientStatus(state, r);
    expect(status).toEqual([{ name: "Leche", quantity: 200, unit: "ml", has: false }]);
  });
});

function cartItem(overrides: Partial<CartItem>): CartItem {
  return {
    id: overrides.id ?? "cart-1",
    name: overrides.name ?? "Yogur",
    qty: overrides.qty ?? 1,
    unit: overrides.unit ?? "ud",
    price: overrides.price ?? 1,
    store: overrides.store ?? "Mercadona",
    checked: overrides.checked ?? true,
    ...overrides,
  };
}

// E10-03/05/07: repasar una compra antes de aplicarla — precio real
// (distinto del estimado del carrito), tienda y caducidad quedan en manos
// de lo que se confirme en el repaso, no de lo que llevaba el carrito.
describe("proposePurchaseReview / completePurchase (E10-03/05/07)", () => {
  it("propone solo los items marcados, con estimatedPrice y price iguales al del carrito", () => {
    const state = {
      ...defaultState,
      cart: [
        cartItem({ id: "a", name: "Pan", price: 1.2, checked: true }),
        cartItem({ id: "b", name: "Sin marcar", price: 9, checked: false }),
      ],
    };
    const proposal = actions.proposePurchaseReview(state);
    expect(proposal).toHaveLength(1);
    expect(proposal[0].name).toBe("Pan");
    expect(proposal[0].price).toBe(1.2);
    expect(proposal[0].estimatedPrice).toBe(1.2);
  });

  it("registra el gasto con el precio REVISADO, no el estimado del carrito", () => {
    const state = { ...defaultState, cart: [cartItem({ id: "a", name: "Pan", price: 1.2 })] };
    const proposal = actions.proposePurchaseReview(state);
    const reviewed = [{ ...proposal[0], price: 2.5 }]; // el usuario corrige el precio real
    const draft = structuredClone(state);
    actions.completePurchase(draft, reviewed);
    expect(draft.expenses).toHaveLength(1);
    expect(draft.expenses[0].amount).toBe(2.5);
  });

  it("da de alta el producto en inventario con la caducidad/tienda/almacén confirmados y vacía el carrito revisado", () => {
    const state = { ...defaultState, cart: [cartItem({ id: "a", name: "Pan", price: 1.2 })] };
    const proposal = actions.proposePurchaseReview(state);
    const reviewed = [{ ...proposal[0], expires: "2030-05-05", store: "Lidl", storage: "Despensa" as const }];
    const draft = structuredClone(state);
    actions.completePurchase(draft, reviewed);
    expect(draft.inventory).toHaveLength(1);
    expect(draft.inventory[0]).toMatchObject({ name: "Pan", expires: "2030-05-05", storage: "Despensa" });
    expect(draft.cart).toHaveLength(0);
  });
});

// E21-15: normalizeState es el punto único por el que pasa CUALQUIER estado
// cargado (local o importado a mano desde Ajustes) antes de usarse — si un
// formato antiguo no migra bien aquí, un usuario que importe un backup de
// hace tiempo puede acabar con datos corruptos o silenciosamente perdidos.
// Los objetos de entrada usan campos ausentes/con forma antigua a propósito
// (as unknown as FoodOSState) — así es como llega de verdad un JSON.parse
// de un archivo exportado hace tiempo, el tipo FoodOSState solo describe el
// formato ACTUAL.
describe("normalizeState — migración de estados antiguos (E21-15)", () => {
  it("migra los modos en español al enum actual", () => {
    const legacy = { ...defaultState, nutrition: { ...defaultState.nutrition, mode: "Perdida de grasa" } };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.nutrition.mode).toBe("fat_loss");
  });

  it("rellena arrays/objetos ausentes de versiones antiguas sin tocar el resto del estado", () => {
    const legacy = { ...defaultState, inventory: [inv({ name: "Pollo" })] } as unknown as Record<string, unknown>;
    delete legacy.incomeSources;
    delete legacy.recurringExpenses;
    delete legacy.waterLog;
    delete legacy.weightLog;
    delete legacy.routines;
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.incomeSources).toEqual([]);
    expect(next.recurringExpenses).toEqual([]);
    expect(next.waterLog).toEqual({});
    expect(next.weightLog).toEqual([]);
    expect(next.routines).toEqual([]);
    // Lo que SÍ traía el estado antiguo no se pierde en el proceso.
    expect(next.inventory).toHaveLength(1);
    expect(next.inventory[0].name).toBe("Pollo");
  });

  it("migra consumedMeals (formato pre-diario datado) a foodLog con fecha de hoy, y borra el campo legacy", () => {
    const legacy = {
      ...defaultState,
      consumedMeals: [{ id: "old-1", name: "Tortilla", kcal: 300, protein: 18, carbs: 5, fat: 20, fiber: 0 }],
    };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.foodLog).toHaveLength(1);
    expect(next.foodLog[0]).toMatchObject({ id: "old-1", name: "Tortilla", kcal: 300, source: "recipe" });
    expect((next as unknown as Record<string, unknown>).consumedMeals).toBeUndefined();
  });

  it("infiere mealType para entradas del diario antiguas que no lo tenían", () => {
    const legacy = {
      ...defaultState,
      foodLog: [{ id: "e1", date: "2025-01-01", time: "08:30", name: "Café con leche", qty: null, unit: null, kcal: 60, protein: 3, carbs: 6, fat: 2, source: "manual" }],
    };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.foodLog[0].mealType).toBe("breakfast");
  });

  it("convierte ingredientes de receta guardados como string plano a {name, quantity, unit}", () => {
    const legacy = {
      ...defaultState,
      customRecipes: [{ ...recipe(["Arroz", "Pollo"] as unknown as Recipe["ingredients"]) }],
    };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.customRecipes[0].ingredients).toEqual([
      { name: "Arroz", quantity: 100, unit: "g" },
      { name: "Pollo", quantity: 100, unit: "g" },
    ]);
  });

  it("fusiona settings parciales antiguos con los valores por defecto, sin perder el resto (incluido lowStockThresholds anidado)", () => {
    const legacy = { ...defaultState, settings: { waterGoalMl: 3000 } };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.settings.waterGoalMl).toBe(3000); // lo que traía el import se respeta
    expect(next.settings.expiryWarnDays).toBe(defaultState.settings.expiryWarnDays); // lo que faltaba, se rellena
    expect(next.settings.lowStockThresholds).toEqual(defaultState.settings.lowStockThresholds);
  });

  it("es idempotente: aplicarlo dos veces seguidas no duplica ni corrompe nada", () => {
    const legacy = {
      ...defaultState,
      consumedMeals: [{ id: "old-1", name: "Tortilla", kcal: 300, protein: 18, carbs: 5, fat: 20, fiber: 0 }],
      nutrition: { ...defaultState.nutrition, mode: "Recomposicion" },
    };
    const once = normalizeState(legacy as unknown as typeof defaultState);
    const twice = normalizeState(once);
    expect(twice.foodLog).toHaveLength(1); // no se duplica la comida migrada
    expect(twice.nutrition.mode).toBe("recomp");
    expect(twice).toEqual(once);
  });
});
