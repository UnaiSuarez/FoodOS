import { describe, expect, it } from "vitest";
import type { FoodStateConfidence, NutrientKey, NutrientStatus } from "@foodos/types";
import {
  applyManualNutrientEdit,
  extractDeclaredState,
  foodStateConfidenceAfterInventoryEdit,
  foodStateConfidenceAfterManualEdit,
  ingredientBasisPatch,
  referenceFieldsFromStatus,
  restoredIngredientProvenance,
} from "./nutrient-provenance";

// Ronda de corrección: los eventos de edición manual de macros deben mantener
// sincronizados el número, nutrientStatus y foodStateConfidence. Estas pruebas
// fijan la regla pura; los cuatro formularios la aplican y se prueban aparte
// (manual-macro-edit.provenance.test.tsx, EditInventoryModal.provenance.test.tsx).

describe("extractDeclaredState — plurales y femeninos (coincidencia de palabra completa)", () => {
  it("«lentejas cocidas» declara cooked — el plural no se pierde al pasar de subcadena a palabra completa", () => {
    expect(extractDeclaredState("lentejas cocidas")).toBe("cooked");
    expect(extractDeclaredState("Garbanzos (cocidos)")).toBe("cooked");
    expect(extractDeclaredState("patatas crudas")).toBe("raw");
    expect(extractDeclaredState("atún escurrido")).toBe("drained");
  });
});

describe("referenceFieldsFromStatus", () => {
  it("solo cuenta los campos con un estado real: un unknown es un hueco de interfaz, no un número de la referencia", () => {
    expect(referenceFieldsFromStatus({ kcal: "known_nonzero", protein: "unknown", carbs: "legacy_unlabeled" }).sort()).toEqual(["carbs", "kcal"]);
    expect(referenceFieldsFromStatus(undefined)).toEqual([]);
  });
});

describe("foodStateConfidenceAfterManualEdit — regla explícita de entrada manual y de sustitución", () => {
  it("entrada 100 % manual con el nombre declarando UN estado → confirmed (débil, un solo lado)", () => {
    expect(foodStateConfidenceAfterManualEdit({ current: undefined, name: "arroz cocido", otherBasisRemains: false })).toBe("confirmed");
  });

  it("entrada 100 % manual sin estado declarado en el nombre → unknown", () => {
    expect(foodStateConfidenceAfterManualEdit({ current: undefined, name: "arroz", otherBasisRemains: false })).toBe("unknown");
  });

  it("entrada 100 % manual con nombre ambiguo (varios estados) → unknown", () => {
    expect(foodStateConfidenceAfterManualEdit({ current: undefined, name: "sopa deshidratada para preparar", otherBasisRemains: false })).toBe("unknown");
  });

  it("quedan números de otra base (referencia) → un confirmed previo se rebaja a unknown", () => {
    expect(foodStateConfidenceAfterManualEdit({ current: "confirmed", name: "arroz cocido", otherBasisRemains: true })).toBe("unknown");
  });

  it("con otra base presente NUNCA se eleva nada: unknown, incompatible y ausencia se conservan", () => {
    expect(foodStateConfidenceAfterManualEdit({ current: "unknown", name: "arroz cocido", otherBasisRemains: true })).toBe("unknown");
    expect(foodStateConfidenceAfterManualEdit({ current: "incompatible", name: "arroz cocido", otherBasisRemains: true })).toBe("incompatible");
    expect(foodStateConfidenceAfterManualEdit({ current: undefined, name: "arroz cocido", otherBasisRemains: true })).toBeUndefined();
  });

  it("si ya no queda ningún número de la referencia se recalcula por el nombre, no se hereda la confianza de la referencia", () => {
    expect(foodStateConfidenceAfterManualEdit({ current: "incompatible", name: "arroz cocido", otherBasisRemains: false })).toBe("confirmed");
    expect(foodStateConfidenceAfterManualEdit({ current: "confirmed", name: "arroz", otherBasisRemains: false })).toBe("unknown");
  });
});

describe("applyManualNutrientEdit — número, nutrientStatus y foodStateConfidence a la vez", () => {
  const MACROS: NutrientKey[] = ["kcal", "protein", "carbs", "fat"];
  const referenceStatus: Partial<Record<NutrientKey, NutrientStatus>> = {
    kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero",
  };

  it("reescribir UN campo de una referencia (quedan otros) marca ese campo known_* y rebaja confirmed a unknown", () => {
    const result = applyManualNutrientEdit({
      key: "kcal", value: 200, name: "arroz cocido",
      nutrientStatus: referenceStatus, foodStateConfidence: "confirmed",
      referenceFields: MACROS, manualFields: [],
    });
    expect(result.nutrientStatus.kcal).toBe("known_nonzero");
    expect(result.nutrientStatus.protein).toBe("known_nonzero"); // sin tocar
    expect(result.foodStateConfidence).toBe("unknown");
    expect(result.manualFields).toEqual(["kcal"]);
  });

  it("reescribir TODOS los campos de la referencia recalcula por el nombre, con independencia del orden", () => {
    let nutrientStatus: Partial<Record<NutrientKey, NutrientStatus>> = { ...referenceStatus };
    let foodStateConfidence: FoodStateConfidence | undefined = "confirmed";
    let manualFields: NutrientKey[] = [];
    for (const key of MACROS) {
      const edit = applyManualNutrientEdit({
        key, value: 10, name: "arroz cocido", nutrientStatus, foodStateConfidence,
        referenceFields: MACROS, manualFields,
      });
      nutrientStatus = edit.nutrientStatus;
      foodStateConfidence = edit.foodStateConfidence;
      manualFields = edit.manualFields;
      if (key !== "fat") expect(foodStateConfidence).toBe("unknown");
    }
    expect(foodStateConfidence).toBe("confirmed");
  });

  it("un cero tecleado es known_zero; el campo no tocado no cambia", () => {
    const result = applyManualNutrientEdit({
      key: "protein", value: 0, name: "agua",
      nutrientStatus: { kcal: "unknown" }, foodStateConfidence: undefined,
      referenceFields: [], manualFields: [],
    });
    expect(result.nutrientStatus.protein).toBe("known_zero");
    expect(result.nutrientStatus.kcal).toBe("unknown");
  });

  it("entrada manual nueva (sin referencia) con estado declarado → confirmed", () => {
    const result = applyManualNutrientEdit({
      key: "kcal", value: 130, name: "arroz cocido",
      nutrientStatus: {}, foodStateConfidence: undefined, referenceFields: [], manualFields: [],
    });
    expect(result.foodStateConfidence).toBe("confirmed");
  });
});

describe("ingredientBasisPatch / restoredIngredientProvenance", () => {
  it("una búsqueda encontrada fija los campos de referencia y vacía los manuales; una no encontrada, ninguno de referencia", () => {
    expect(ingredientBasisPatch({ status: "found", nutrientStatus: { kcal: "known_nonzero", carbs: "unknown" } }))
      .toEqual({ referenceFields: ["kcal"], manualFields: [] });
    expect(ingredientBasisPatch({ status: "manual" })).toEqual({ referenceFields: [], manualFields: [] });
    expect(ingredientBasisPatch({ status: "loading" })).toEqual({});
  });

  it("al recargar, todo campo con estado real se toma como de referencia (lado conservador); un número sin estado es legacy_unlabeled", () => {
    const restored = restoredIngredientProvenance({
      kcalPer100: 130, proteinPer100: 2.7, carbsPer100: 0, fatPer100: 0,
      nutrientStatus: { kcal: "known_nonzero" }, foodStateConfidence: "confirmed",
    });
    expect(restored.nutrientStatus.kcal).toBe("known_nonzero");
    expect(restored.nutrientStatus.protein).toBe("legacy_unlabeled");
    expect(restored.foodStateConfidence).toBe("confirmed");
    expect([...restored.referenceFields].sort()).toEqual(["carbs", "fat", "kcal", "protein"]);
    expect(restored.manualFields).toEqual([]);
  });
});

describe("foodStateConfidenceAfterInventoryEdit — EditInventoryModal", () => {
  const manualItem = { name: "arroz cocido", dataSource: undefined, foodStateConfidence: "confirmed" as const };

  it("sin ninguna edición conserva el valor tal cual", () => {
    expect(foodStateConfidenceAfterInventoryEdit({ item: manualItem, nextName: "arroz cocido", kcalChanged: false, proteinChanged: false })).toBe("confirmed");
  });

  it("item respaldado por una referencia (dataSource) y kcal reescrito: confirmed → unknown", () => {
    expect(foodStateConfidenceAfterInventoryEdit({
      item: { ...manualItem, dataSource: "off" }, nextName: "arroz cocido", kcalChanged: true, proteinChanged: false,
    })).toBe("unknown");
  });

  it("item con carbs (solo puede venir de una referencia) y ambos macros reescritos: sigue unknown", () => {
    expect(foodStateConfidenceAfterInventoryEdit({
      item: { ...manualItem, carbs: 22 }, nextName: "arroz cocido", kcalChanged: true, proteinChanged: true,
    })).toBe("unknown");
  });

  it("item 100 % manual, mismo nombre, kcal reescrito: se recalcula por el nombre (confirmed se mantiene)", () => {
    expect(foodStateConfidenceAfterInventoryEdit({ item: manualItem, nextName: "arroz cocido", kcalChanged: true, proteinChanged: false })).toBe("confirmed");
  });

  it("renombrar + reescribir solo kcal: la proteína sin reescribir se tecleó bajo el nombre anterior → unknown", () => {
    expect(foodStateConfidenceAfterInventoryEdit({
      item: { ...manualItem, name: "arroz crudo" }, nextName: "arroz cocido", kcalChanged: true, proteinChanged: false,
    })).toBe("unknown");
  });

  it("renombrar + reescribir AMBOS macros en un item 100 % manual: recalcula por el nombre nuevo", () => {
    expect(foodStateConfidenceAfterInventoryEdit({
      item: { ...manualItem, name: "arroz crudo" }, nextName: "arroz cocido", kcalChanged: true, proteinChanged: true,
    })).toBe("confirmed");
  });

  it("un item legacy sin foodStateConfidence y con nombre sin estado queda unknown tras editar kcal, nunca confirmed", () => {
    expect(foodStateConfidenceAfterInventoryEdit({
      item: { name: "arroz", dataSource: undefined, foodStateConfidence: undefined }, nextName: "arroz", kcalChanged: true, proteinChanged: false,
    })).toBe("unknown");
  });
});
