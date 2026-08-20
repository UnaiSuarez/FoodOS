import { describe, expect, it } from "vitest";
import type { CartItem, InventoryItem, Recipe } from "@foodos/types";
import { actions, defaultState, getIngredientStatus, getRecipeMatch } from "./state";

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
