// PR3a — supervivencia de la procedencia a través de los dos puntos de
// colapso en EditRecipeModal (estructuralmente igual que CreateRecipeModal,
// ver ese archivo de test para el razonamiento completo). recipeIngToIng
// usa además una condición hasMacros distinta (kcal>0 O protein>0) que
// afecta a IngStatus (no a nutrientStatus) — fuera de alcance de PR3a.
import { describe, expect, it } from "vitest";
import type { RecipeIngredient } from "@foodos/types";
import { ingToRecord, recipeIngToIng, type IngDraft } from "./EditRecipeModal";

function draft(overrides: Partial<IngDraft> = {}): IngDraft {
  return {
    name: "Pechuga de pollo", quantity: 100, unit: "g",
    kcalPer100: 0, proteinPer100: 0, carbsPer100: 0, fatPer100: 0,
    status: "found", unitSize: 60, unitSizeUnit: undefined,
    ...overrides,
  };
}

describe("ingToRecord — colapso 1 (guardar)", () => {
  it("un nutriente ausente en el draft no se guarda como known_zero", () => {
    const ing = draft({
      kcalPer100: 165, proteinPer100: 31, carbsPer100: 0, fatPer100: 3.6,
      nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero" },
    });
    const record = ingToRecord(ing);
    expect(record.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(record.nutrientStatus?.carbs).toBeUndefined();
    expect(record.carbsPer100).toBe(0);
  });

  it("un ingrediente manual con campos sin rellenar guarda unknown, no known_zero", () => {
    const ing = draft({
      status: "manual",
      nutrientStatus: { kcal: "unknown", protein: "unknown", carbs: "unknown", fat: "unknown" },
    });
    const record = ingToRecord(ing);
    expect(record.kcalPer100).toBe(0);
    expect(record.nutrientStatus?.kcal).toBe("unknown");
  });
});

describe("recipeIngToIng — colapso 2 (recargar para editar)", () => {
  it("un nutriente explícitamente cero (known_zero) sobrevive tal cual, sin reinterpretarse", () => {
    const ri: RecipeIngredient = {
      name: "Agua con gas", quantity: 100, unit: "g",
      kcalPer100: 0, proteinPer100: 0, carbsPer100: 0, fatPer100: 0,
      nutrientStatus: { kcal: "known_zero", protein: "known_zero", carbs: "known_zero", fat: "known_zero" },
    };
    expect(recipeIngToIng(ri).nutrientStatus?.kcal).toBe("known_zero");
  });

  it("una receta anterior a PR3a (sin nutrientStatus) con números presentes se trata como legacy_unlabeled", () => {
    const ri: RecipeIngredient = {
      name: "Pechuga de pollo", quantity: 200, unit: "g",
      kcalPer100: 165, proteinPer100: 31, carbsPer100: 0, fatPer100: 3.6,
    };
    const ing = recipeIngToIng(ri);
    expect(ing.nutrientStatus?.kcal).toBe("legacy_unlabeled");
    expect(ing.nutrientStatus?.carbs).toBe("legacy_unlabeled");
  });

  it("un ingrediente sin ningún macro guardado reconstruye unknown", () => {
    const ri: RecipeIngredient = { name: "Sal", quantity: 1, unit: "pizca" };
    expect(recipeIngToIng(ri).nutrientStatus?.kcal).toBe("unknown");
  });
});

describe("Supervivencia end-to-end a través de los dos colapsos", () => {
  it("un nutriente ausente en el punto de captura original sigue siendo unknown tras guardar y recargar", () => {
    const capturedIng = draft({
      kcalPer100: 200, proteinPer100: 0, carbsPer100: 10, fatPer100: 5,
      nutrientStatus: { kcal: "known_nonzero", protein: "unknown", carbs: "known_nonzero", fat: "known_nonzero" },
    });

    const saved = ingToRecord(capturedIng);
    expect(saved.nutrientStatus?.protein).toBe("unknown");
    expect(saved.proteinPer100).toBe(0);

    const reloaded = recipeIngToIng(saved);
    expect(reloaded.nutrientStatus?.protein).toBe("unknown");
    expect(reloaded.proteinPer100).toBe(0);
  });
});
