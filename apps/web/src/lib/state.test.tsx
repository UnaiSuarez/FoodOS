import { describe, expect, it } from "vitest";
import type { InventoryItem, Recipe } from "@foodos/types";
import { defaultState, getIngredientStatus, getRecipeMatch } from "./state";

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
