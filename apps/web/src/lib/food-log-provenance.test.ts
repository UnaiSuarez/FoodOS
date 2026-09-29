// PR3 — constructores puros de procedencia del diario. Cada regla del diseño
// (AC17–AC21, AC28, §16.4, §1.5) se prueba aquí sobre la función que la aplica;
// las pruebas de cada ESCRITOR real (state.test.tsx, food-log-writers.test.ts…)
// comprueban después que ese escritor llama a la función correcta.
import { describe, expect, it } from "vitest";
import type { InventoryItem, NutrientStatus, Recipe } from "@foodos/types";
import {
  aiWholeMealProvenance,
  DIARY_MACRO_KEYS,
  inventoryConsumptionProvenance,
  legacyTotalProvenance,
  qtyOverridesIgnored,
  reconcileStatusesWithValues,
  recipeTotalProvenance,
  sanitizeFoodLogProvenance,
  SYNTHETIC_FOOD_LOG_FIELDS,
} from "./food-log-provenance";
import { macrosForQuantity } from "./state";

const KNOWN: NutrientStatus[] = ["known_nonzero", "known_zero"];

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "inv-1", name: "Pollo", qty: 500, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 3,
    kcal: 165, protein: 31, ...overrides,
  };
}

function recipeWith(names: string[]): Pick<Recipe, "ingredients"> {
  return { ingredients: names.map((name) => ({ name, quantity: 100, unit: "g" })) };
}

describe("legacyTotalProvenance — totales agregados", () => {
  it("los cuatro macros son legacy_unlabeled y el estado del alimento unknown; sin quantityConfidence", () => {
    const p = legacyTotalProvenance();
    expect(p.nutrientStatus).toEqual({ kcal: "legacy_unlabeled", protein: "legacy_unlabeled", carbs: "legacy_unlabeled", fat: "legacy_unlabeled" });
    expect(p.foodStateConfidence).toBe("unknown");
    expect(p.quantityConfidence).toBeUndefined();
  });
});

describe("recipeTotalProvenance — AC28", () => {
  it("una receta es legacy_unlabeled para los 4 macros: la certeza del total no se deriva de sus ingredientes", () => {
    const p = recipeTotalProvenance({ qtyOverridesIgnored: false });
    for (const key of DIARY_MACRO_KEYS) expect(p.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    expect(p.foodStateConfidence).toBe("unknown");
    expect(p.quantityConfidence).toBeUndefined();
  });

  it("con overrides ignorados marca quantityConfidence low con motivo overrides_ignored, sin cambiar la procedencia", () => {
    const p = recipeTotalProvenance({ qtyOverridesIgnored: true });
    expect(p.quantityConfidence).toEqual({ level: "low", reason: "overrides_ignored" });
    for (const key of DIARY_MACRO_KEYS) expect(p.nutrientStatus?.[key]).toBe("legacy_unlabeled");
  });
});

describe("qtyOverridesIgnored", () => {
  const r = recipeWith(["Arroz", "Pollo"]);

  it("sin overrides o vacíos: no", () => {
    expect(qtyOverridesIgnored(r, undefined)).toBe(false);
    expect(qtyOverridesIgnored(r, {})).toBe(false);
  });

  it("un override de un ingrediente de la receta con número finito: sí", () => {
    expect(qtyOverridesIgnored(r, { Arroz: 150 })).toBe(true);
    expect(qtyOverridesIgnored(r, { Pollo: 0 })).toBe(true);
  });

  it("una clave que no es ingrediente de la receta, o un valor no finito, no cuentan", () => {
    expect(qtyOverridesIgnored(r, { Lentejas: 200 })).toBe(false);
    expect(qtyOverridesIgnored(r, { Arroz: Number.NaN })).toBe(false);
    expect(qtyOverridesIgnored(r, { Arroz: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("no se confunde con propiedades heredadas del objeto", () => {
    expect(qtyOverridesIgnored(recipeWith(["toString"]), {})).toBe(false);
  });
});

describe("inventoryConsumptionProvenance", () => {
  it("lee la procedencia que PR3a guardó en el item y propaga foodStateConfidence", () => {
    const p = inventoryConsumptionProvenance(
      item({
        carbs: 0, fat: 3.6,
        nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
        foodStateConfidence: "confirmed",
      }),
    );
    expect(p.nutrientStatus).toEqual({ kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" });
    expect(p.foodStateConfidence).toBe("confirmed");
    expect(p.quantityConfidence).toBeUndefined();
  });

  it("un item anterior a PR3a (sin nutrientStatus) es legacy_unlabeled — que el número exista no lo hace known_*", () => {
    const p = inventoryConsumptionProvenance(item({ carbs: 0, fat: 3.6 }));
    expect(p.nutrientStatus).toEqual({ kcal: "legacy_unlabeled", protein: "legacy_unlabeled", carbs: "legacy_unlabeled", fat: "legacy_unlabeled" });
    expect(p.foodStateConfidence).toBe("unknown");
  });

  it("carbs/grasa que macrosForQuantity IMPUTA son estimated y la entrada queda con quantityConfidence low sin motivo", () => {
    const p = inventoryConsumptionProvenance(
      item({ nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero" }, foodStateConfidence: "confirmed" }),
    );
    expect(p.nutrientStatus).toMatchObject({ kcal: "known_nonzero", protein: "known_nonzero", carbs: "estimated", fat: "estimated" });
    expect(p.quantityConfidence).toEqual({ level: "low" });
    expect(p.foodStateConfidence).toBe("confirmed");
  });

  it("con solo la grasa imputada, los carbos presentes conservan su estado guardado", () => {
    // fat ausente → imputada (estimated); carbs presente → macrosForQuantity usa item.carbs tal cual.
    const p = inventoryConsumptionProvenance(item({ carbs: 0, nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero" } }));
    expect(p.nutrientStatus?.fat).toBe("estimated");
    expect(p.nutrientStatus?.carbs).toBe("known_zero");
    expect(p.quantityConfidence).toEqual({ level: "low" });
  });

  it("un estado 'unknown' guardado con un número de relleno (0) se conserva unknown, no se convierte en known_zero", () => {
    const p = inventoryConsumptionProvenance(
      item({ carbs: 0, fat: 0, nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "unknown", fat: "unknown" } }),
    );
    expect(p.nutrientStatus).toMatchObject({ carbs: "unknown", fat: "unknown" });
  });

  it("'ud' sin tamaño de unidad → quantityConfidence low con motivo missing_unit_size (toGrams cae en 60 g)", () => {
    const p = inventoryConsumptionProvenance(item({ unit: "ud", carbs: 1, fat: 1 }));
    expect(p.quantityConfidence).toEqual({ level: "low", reason: "missing_unit_size" });
    expect(inventoryConsumptionProvenance(item({ unit: "ud", unitSize: 0, carbs: 1, fat: 1 })).quantityConfidence).toEqual({ level: "low", reason: "missing_unit_size" });
  });

  it("'ud' con tamaño declarado y carbs/grasa presentes no lleva quantityConfidence", () => {
    const p = inventoryConsumptionProvenance(item({ unit: "ud", unitSize: 250, unitSizeUnit: "g", carbs: 1, fat: 1 }));
    expect(p.quantityConfidence).toBeUndefined();
  });

  it("AC19: un item con dataSource 'ai' nunca produce known_*, aunque su nutrientStatus guardado lo dijera", () => {
    const p = inventoryConsumptionProvenance(
      item({
        dataSource: "ai", carbs: 0, fat: 3.6,
        nutrientStatus: { kcal: "known_nonzero", protein: "known_zero", carbs: "known_zero", fat: "known_nonzero" },
      }),
    );
    for (const key of DIARY_MACRO_KEYS) expect(KNOWN).not.toContain(p.nutrientStatus?.[key]);
    expect(p.nutrientStatus).toEqual({ kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "estimated" });
  });

  it("AC19 en todas las combinaciones de estado guardado: dataSource 'ai' jamás termina en known_*", () => {
    const all: NutrientStatus[] = ["known_nonzero", "known_zero", "estimated", "unknown", "legacy_unlabeled"];
    for (const s of all) {
      const p = inventoryConsumptionProvenance(item({ dataSource: "ai", carbs: 1, fat: 1, nutrientStatus: { kcal: s, protein: s, carbs: s, fat: s } }));
      for (const key of DIARY_MACRO_KEYS) expect(KNOWN).not.toContain(p.nutrientStatus?.[key]);
    }
  });

  it("propaga incompatible y no eleva nada: foodStateConfidence del item se copia tal cual", () => {
    expect(inventoryConsumptionProvenance(item({ carbs: 1, fat: 1, foodStateConfidence: "incompatible" })).foodStateConfidence).toBe("incompatible");
    expect(inventoryConsumptionProvenance(item({ carbs: 1, fat: 1, foodStateConfidence: "unknown" })).foodStateConfidence).toBe("unknown");
    expect(inventoryConsumptionProvenance(item({ carbs: 1, fat: 1 })).foodStateConfidence).toBe("unknown");
  });

  it("las condiciones de imputación coinciden con las de macrosForQuantity (no se desincronizan)", () => {
    const withoutFat = item({ kcal: 200, protein: 10, carbs: 20 }); // fat ausente
    const withoutCarbs = item({ kcal: 200, protein: 10, fat: 5 }); // carbs ausente
    const withBoth = item({ kcal: 200, protein: 10, carbs: 20, fat: 5 });
    const zeroFat = item({ kcal: 200, protein: 10, carbs: 20, fat: 0 }); // 0 explícito NO es ausente

    // fat imputado en macrosForQuantity ⇔ estimated en la procedencia
    expect(macrosForQuantity(withoutFat, 100).fat).toBe(Math.round(((200 * 0.25) / 9) * 10) / 10);
    expect(inventoryConsumptionProvenance(withoutFat).nutrientStatus?.fat).toBe("estimated");
    expect(inventoryConsumptionProvenance(withoutCarbs).nutrientStatus?.carbs).toBe("estimated");
    expect(macrosForQuantity(withBoth, 100)).toMatchObject({ carbs: 20, fat: 5 });
    expect(inventoryConsumptionProvenance(withBoth).nutrientStatus).toMatchObject({ carbs: "legacy_unlabeled", fat: "legacy_unlabeled" });
    expect(macrosForQuantity(zeroFat, 100).fat).toBe(0);
    expect(inventoryConsumptionProvenance(zeroFat).nutrientStatus?.fat).toBe("legacy_unlabeled");
  });
});

describe("aiWholeMealProvenance", () => {
  it("sin estados del estimador: los cuatro macros son estimated y el estado del alimento not_applicable", () => {
    const p = aiWholeMealProvenance();
    expect(p.nutrientStatus).toEqual({ kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "estimated" });
    expect(p.foodStateConfidence).toBe("not_applicable");
  });

  it("respeta unknown cuando el estimador declaró que la IA omitió el macro", () => {
    const p = aiWholeMealProvenance({ nutrientStatus: { kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "unknown" } });
    expect(p.nutrientStatus?.fat).toBe("unknown");
    expect(p.nutrientStatus?.kcal).toBe("estimated");
  });

  it("un known_* recibido se rebaja a estimated: una IA nunca es known_*", () => {
    const p = aiWholeMealProvenance({ nutrientStatus: { kcal: "known_nonzero", protein: "known_zero", carbs: "known_nonzero", fat: "known_zero" } });
    for (const key of DIARY_MACRO_KEYS) expect(p.nutrientStatus?.[key]).toBe("estimated");
  });

  it("un legacy_unlabeled recibido tampoco se presenta como algo mejor ni peor de lo que es: se conserva", () => {
    expect(aiWholeMealProvenance({ nutrientStatus: { kcal: "legacy_unlabeled" } }).nutrientStatus?.kcal).toBe("legacy_unlabeled");
  });
});

describe("SYNTHETIC_FOOD_LOG_FIELDS", () => {
  it("es exactamente { synthetic: true } — sin ningún nutrientStatus", () => {
    expect(SYNTHETIC_FOOD_LOG_FIELDS).toEqual({ synthetic: true });
  });
});

describe("reconcileStatusesWithValues — coherencia con el número guardado", () => {
  it("known_nonzero cuyo valor guardado es 0 (cantidad diminuta redondeada) pasa a estimated", () => {
    expect(reconcileStatusesWithValues({ protein: "known_nonzero" }, { protein: 0 })).toEqual({ protein: "estimated" });
  });

  it("known_zero con valor distinto de 0 pasa a estimated", () => {
    expect(reconcileStatusesWithValues({ fat: "known_zero" }, { fat: 2 })).toEqual({ fat: "estimated" });
  });

  it("estados coherentes o sin esa restricción no se tocan", () => {
    const status = { kcal: "known_nonzero", protein: "known_zero", carbs: "legacy_unlabeled", fat: "unknown" } as const;
    expect(reconcileStatusesWithValues(status, { kcal: 120, protein: 0, carbs: 0, fat: 0 })).toEqual(status);
  });

  it("sin estados devuelve undefined (una entrada anterior a PR3 no adquiere ninguno) y no muta la entrada", () => {
    expect(reconcileStatusesWithValues(undefined, { kcal: 0 })).toBeUndefined();
    const original = { kcal: "known_nonzero" } as const;
    reconcileStatusesWithValues(original, { kcal: 0 });
    expect(original.kcal).toBe("known_nonzero");
  });

  it("un valor no numérico o no finito no cambia el estado", () => {
    expect(reconcileStatusesWithValues({ kcal: "known_nonzero" }, { kcal: Number.NaN })).toEqual({ kcal: "known_nonzero" });
    expect(reconcileStatusesWithValues({ kcal: "known_nonzero" }, {})).toEqual({ kcal: "known_nonzero" });
  });
});

describe("sanitizeFoodLogProvenance — lo que viaja por client_meta", () => {
  it("deja pasar una procedencia válida completa", () => {
    const valid = {
      nutrientStatus: { kcal: "known_nonzero", protein: "estimated", carbs: "legacy_unlabeled", fat: "unknown" },
      foodStateConfidence: "confirmed",
      quantityConfidence: { level: "low", reason: "overrides_ignored" },
      synthetic: true,
    };
    expect(sanitizeFoodLogProvenance(valid)).toEqual(valid);
  });

  it("es idempotente", () => {
    const once = sanitizeFoodLogProvenance({ nutrientStatus: { kcal: "estimated" }, foodStateConfidence: "not_applicable" });
    expect(sanitizeFoodLogProvenance(once)).toEqual(once);
  });

  it("descarta estados, claves y valores inválidos en vez de aceptarlos", () => {
    const out = sanitizeFoodLogProvenance({
      nutrientStatus: { kcal: "known_maybe", protein: 5, potassium: "known_nonzero", carbs: "known_zero" },
      foodStateConfidence: "sure",
      quantityConfidence: { level: "medium" },
      synthetic: "true",
    });
    expect(out).toEqual({ nutrientStatus: { carbs: "known_zero" } });
  });

  it("synthetic solo se acepta como el booleano true", () => {
    expect(sanitizeFoodLogProvenance({ synthetic: true }).synthetic).toBe(true);
    for (const bad of [false, 1, "true", null, {}]) expect(sanitizeFoodLogProvenance({ synthetic: bad }).synthetic).toBeUndefined();
  });

  it("un motivo de cantidad inválido conserva el nivel (lado conservador) y descarta el motivo", () => {
    expect(sanitizeFoodLogProvenance({ quantityConfidence: { level: "low", reason: "porque_si" } })).toEqual({ quantityConfidence: { level: "low" } });
  });

  it("entradas basura (null, arrays, primitivos) no producen nada", () => {
    for (const bad of [null, undefined, 5, "x", [], { nutrientStatus: [] }, { nutrientStatus: null }]) {
      expect(sanitizeFoodLogProvenance(bad)).toEqual({});
    }
  });

  it("un nutrientStatus sin ninguna clave válida no deja un objeto vacío", () => {
    expect(sanitizeFoodLogProvenance({ nutrientStatus: { potassium: "known_nonzero" } })).toEqual({});
  });
});
