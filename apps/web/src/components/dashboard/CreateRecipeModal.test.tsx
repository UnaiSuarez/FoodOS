// PR3a — supervivencia de la procedencia a través de los dos puntos de
// colapso identificados en la auditoría: (1) ingToRecord, al guardar la
// receta; (2) riToIngDraft, al recargarla para editar. Ambas son
// funciones puras exportadas — se prueban directamente, sin montar el
// componente.
import { describe, expect, it } from "vitest";
import type { RecipeIngredient } from "@foodos/types";
import { blankIng, ingToRecord, riToIngDraft, type IngDraft } from "./CreateRecipeModal";

function draft(overrides: Partial<IngDraft> = {}): IngDraft {
  return { ...blankIng(), name: "Pechuga de pollo", status: "found", ...overrides };
}

describe("ingToRecord — colapso 1 (guardar)", () => {
  it("un nutriente ausente en el draft (nunca evaluado) no se guarda como known_zero", () => {
    const ing = draft({
      kcalPer100: 165, proteinPer100: 31, carbsPer100: 0, fatPer100: 3.6,
      nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero" }, // carbs/fat sin evaluar
    });
    const record = ingToRecord(ing);
    expect(record.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(record.nutrientStatus?.carbs).toBeUndefined();
    // El número sí se guarda (comportamiento numérico sin cambios).
    expect(record.carbsPer100).toBe(0);
  });

  it("un ingrediente en estado idle no guarda ni números ni procedencia", () => {
    const ing = draft({ status: "idle", nutrientStatus: undefined });
    const record = ingToRecord(ing);
    expect(record.kcalPer100).toBeUndefined();
    expect(record.nutrientStatus).toBeUndefined();
  });

  it("un ingrediente manual con campos sin rellenar guarda unknown, no known_zero, aunque el número visible sea 0", () => {
    const ing = draft({
      status: "manual",
      kcalPer100: 0, proteinPer100: 0, carbsPer100: 0, fatPer100: 0,
      nutrientStatus: { kcal: "unknown", protein: "unknown", carbs: "unknown", fat: "unknown" },
    });
    const record = ingToRecord(ing);
    expect(record.kcalPer100).toBe(0);
    expect(record.nutrientStatus?.kcal).toBe("unknown");
  });

  it("foodStateConfidence sobrevive al guardado cuando el ingrediente está found/manual", () => {
    const ing = draft({ foodStateConfidence: "confirmed" });
    expect(ingToRecord(ing).foodStateConfidence).toBe("confirmed");
  });
});

describe("riToIngDraft — colapso 2 (recargar para editar)", () => {
  it("una receta guardada bajo PR3a conserva su nutrientStatus real, sin reinterpretarlo", () => {
    const ri: RecipeIngredient = {
      name: "Agua con gas", quantity: 100, unit: "g",
      kcalPer100: 0, proteinPer100: 0, carbsPer100: 0, fatPer100: 0,
      nutrientStatus: { kcal: "known_zero", protein: "known_zero", carbs: "known_zero", fat: "known_zero" },
    };
    const ing = riToIngDraft(ri);
    // Un kcal EXPLÍCITAMENTE cero (known_zero) sobrevive tal cual — no se
    // reinterpreta como legacy_unlabeled solo porque el número sea 0.
    expect(ing.nutrientStatus?.kcal).toBe("known_zero");
  });

  it("una receta ausente de nutrientStatus (anterior a PR3a) con números presentes se trata como legacy_unlabeled, nunca known_*", () => {
    const ri: RecipeIngredient = {
      name: "Pechuga de pollo", quantity: 200, unit: "g",
      kcalPer100: 165, proteinPer100: 31, carbsPer100: 0, fatPer100: 3.6,
      // sin nutrientStatus: dato guardado antes de esta entrega
    };
    const ing = riToIngDraft(ri);
    expect(ing.nutrientStatus?.kcal).toBe("legacy_unlabeled");
    expect(ing.nutrientStatus?.protein).toBe("legacy_unlabeled");
    // carbsPer100 es 0 mismo pre-PR3a: igual legacy_unlabeled, no unknown,
    // porque el número SÍ está presente en el registro guardado.
    expect(ing.nutrientStatus?.carbs).toBe("legacy_unlabeled");
  });

  it("un ingrediente sin ningún macro guardado (ausente de verdad) reconstruye unknown", () => {
    const ri: RecipeIngredient = { name: "Sal (sin buscar)", quantity: 1, unit: "pizca" };
    const ing = riToIngDraft(ri);
    expect(ing.nutrientStatus?.kcal).toBe("unknown");
    expect(ing.status).toBe("idle");
  });
});

describe("Supervivencia end-to-end: unknown atraviesa los dos colapsos sin convertirse en known_zero", () => {
  it("un nutriente ausente en el punto de captura original sigue siendo unknown tras guardar y recargar", () => {
    // Simula el resultado de una búsqueda donde un macro concreto nunca se
    // pudo determinar (ej. protein ausente en la fuente).
    const capturedIng = draft({
      kcalPer100: 200, proteinPer100: 0, carbsPer100: 10, fatPer100: 5,
      nutrientStatus: { kcal: "known_nonzero", protein: "unknown", carbs: "known_nonzero", fat: "known_nonzero" },
    });

    // Colapso 1: guardar la receta.
    const saved = ingToRecord(capturedIng);
    expect(saved.nutrientStatus?.protein).toBe("unknown");
    expect(saved.proteinPer100).toBe(0); // el número visible sigue siendo el fallback

    // Colapso 2: reabrir la receta para editar.
    const reloaded = riToIngDraft(saved);
    expect(reloaded.nutrientStatus?.protein).toBe("unknown");
    expect(reloaded.proteinPer100).toBe(0);
  });
});
