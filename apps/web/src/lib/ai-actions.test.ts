import { describe, expect, it } from "vitest";
import { validateInventoryAction, validateRecipeAction } from "./ai-actions";

describe("validateInventoryAction", () => {
  it("acepta una acción bien formada", () => {
    const result = validateInventoryAction({
      name: "Pechuga de pollo", qty: 500, unit: "g", storage: "Nevera",
      expires_days: 4, price: 3.2, kcal: 165, protein: 31,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Pechuga de pollo");
      expect(result.value.qty).toBe(500);
      expect(result.value.storage).toBe("Nevera");
    }
  });

  it("rechaza sin nombre", () => {
    const result = validateInventoryAction({ qty: 100 });
    expect(result.ok).toBe(false);
  });

  it("rechaza nombre vacío o solo espacios", () => {
    expect(validateInventoryAction({ name: "   ", qty: 100 }).ok).toBe(false);
  });

  it("rechaza cantidad negativa, cero o no numérica", () => {
    expect(validateInventoryAction({ name: "Arroz", qty: -5 }).ok).toBe(false);
    expect(validateInventoryAction({ name: "Arroz", qty: 0 }).ok).toBe(false);
    expect(validateInventoryAction({ name: "Arroz", qty: "muchísimo" }).ok).toBe(false);
    expect(validateInventoryAction({ name: "Arroz", qty: NaN }).ok).toBe(false);
  });

  it("recorta (no rechaza) una cantidad absurdamente grande", () => {
    const result = validateInventoryAction({ name: "Sal", qty: 99_999_999 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.qty).toBeLessThanOrEqual(100_000);
  });

  it("cae a 'Despensa' si storage no es uno de los tres valores válidos", () => {
    const result = validateInventoryAction({ name: "Yogur", qty: 1, storage: "Frigorífico" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.storage).toBe("Despensa");
  });

  it("recorta precio/kcal/proteína negativos a 0 en vez de guardarlos negativos", () => {
    const result = validateInventoryAction({ name: "Leche", qty: 1, price: -5, kcal: -100, protein: -20 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.price).toBe(0);
      expect(result.value.kcal).toBe(0);
      expect(result.value.protein).toBe(0);
    }
  });

  it("usa valores por defecto razonables para campos ausentes", () => {
    const result = validateInventoryAction({ name: "Manzana", qty: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unit).toBe("g");
      expect(result.value.storage).toBe("Despensa");
      expect(result.value.expiresDays).toBe(7);
    }
  });

  it("recorta un nombre absurdamente largo en vez de rechazarlo", () => {
    const longName = "a".repeat(500);
    const result = validateInventoryAction({ name: longName, qty: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name.length).toBeLessThanOrEqual(80);
  });
});

describe("validateRecipeAction", () => {
  it("acepta una receta bien formada", () => {
    const result = validateRecipeAction({
      title: "Tortilla de patatas",
      ingredients: [{ name: "Huevo", quantity: 3, unit: "ud" }, { name: "Patata", quantity: 400, unit: "g" }],
      kcal: 350, protein: 18, carbs: 30, fat: 15, cost: 1.5, time: 30, servings: 2,
      steps: ["Pelar y cortar patatas", "Batir huevos", "Freír y cuajar"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Tortilla de patatas");
      expect(result.value.ingredients).toHaveLength(2);
      expect(result.value.steps).toHaveLength(3);
    }
  });

  it("rechaza sin título", () => {
    expect(validateRecipeAction({ ingredients: [{ name: "Huevo", quantity: 1, unit: "ud" }] }).ok).toBe(false);
  });

  it("rechaza sin ningún ingrediente reconocible", () => {
    expect(validateRecipeAction({ title: "Receta vacía", ingredients: [] }).ok).toBe(false);
    expect(validateRecipeAction({ title: "Receta rara", ingredients: "no es un array" }).ok).toBe(false);
  });

  it("descarta ingredientes individuales sin nombre, pero conserva los válidos", () => {
    const result = validateRecipeAction({
      title: "Ensalada",
      ingredients: [{ name: "Lechuga", quantity: 100, unit: "g" }, { quantity: 50, unit: "g" }, { name: "", quantity: 20 }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ingredients).toHaveLength(1);
  });

  it("recorta macros/coste/tiempo absurdos a rangos plausibles en vez de rechazar toda la receta", () => {
    const result = validateRecipeAction({
      title: "Receta exagerada",
      ingredients: [{ name: "Proteína en polvo", quantity: 1, unit: "kg" }],
      kcal: 999_999, protein: 999_999, cost: 999_999, time: 999_999, servings: 999_999,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kcal).toBeLessThanOrEqual(5000);
      expect(result.value.protein).toBeLessThanOrEqual(500);
      expect(result.value.cost).toBeLessThanOrEqual(200);
      expect(result.value.time).toBeLessThanOrEqual(600);
      expect(result.value.servings).toBeLessThanOrEqual(50);
    }
  });

  it("nunca deja macros negativos", () => {
    const result = validateRecipeAction({
      title: "Receta con macros negativos",
      ingredients: [{ name: "Agua", quantity: 200, unit: "ml" }],
      kcal: -100, protein: -10, carbs: -10, fat: -10, cost: -5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kcal).toBe(0);
      expect(result.value.protein).toBe(0);
      expect(result.value.carbs).toBe(0);
      expect(result.value.fat).toBe(0);
      expect(result.value.cost).toBe(0);
    }
  });

  it("marca aiGenerated: true siempre", () => {
    const result = validateRecipeAction({
      title: "Receta IA",
      ingredients: [{ name: "Arroz", quantity: 100, unit: "g" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.aiGenerated).toBe(true);
  });
});
