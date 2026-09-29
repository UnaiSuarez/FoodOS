import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupFoodExternal, searchOFFSuggestions } from "./food-lookup";

// PR3a — pruebas de procedencia (nutrientStatus/foodStateConfidence) para
// las dos fuentes externas de captura: Open Food Facts (vía el proxy
// interno /api/food-search) y USDA FoodData Central. El fetch real se
// sustituye por respuestas controladas, igual que en ai-provider.test.ts.
// `searchOFFSuggestions` no filtra por kcal>0 (a diferencia de searchOFF,
// usado internamente por lookupFoodExternal), así que es el camino más
// directo para probar absence/presence por campo sin pelear con ese filtro.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function offProduct(topLevel: Record<string, unknown>, nutriments: Record<string, unknown>): any {
  return { product_name_es: "Producto de prueba", ...topLevel, nutriments };
}

function mockFetchRouter(opts: { offProducts?: unknown[]; usdaFoods?: unknown[] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/food-search")) {
        return { ok: true, json: async () => ({ products: opts.offProducts ?? [] }) };
      }
      if (url.includes("api.nal.usda.gov")) {
        return { ok: true, json: async () => ({ foods: opts.usdaFoods ?? [] }) };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
}

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchOFFSuggestions — procedencia por campo (Open Food Facts)", () => {
  it("un macro sufijado _100g presente y en 0 es known_zero, no ausencia", async () => {
    mockFetchRouter({
      offProducts: [
        offProduct({ product_name_es: "Agua mineral" }, {
          "energy-kcal_100g": 0,
          proteins_100g: 0,
          carbohydrates_100g: 0,
          fat_100g: 0,
        }),
      ],
    });
    const [result] = await searchOFFSuggestions("agua");
    expect(result.nutrientStatus?.kcal).toBe("known_zero");
    expect(result.nutrientStatus?.protein).toBe("known_zero");
  });

  it("un macro ausente queda unknown en el metadato, aunque el número visible caiga al fallback ?? 0", async () => {
    mockFetchRouter({
      offProducts: [offProduct({}, { "energy-kcal_100g": 200 })],
    });
    const [result] = await searchOFFSuggestions("prueba");
    expect(result.nutrientStatus?.protein).toBe("unknown");
    expect(result.protein).toBe(0);
    // salt/fiber/sugars no están en absoluto en nutriments: se omiten del todo,
    // tanto el número como su status (no se inventa un 0 ni un "unknown" para
    // algo que esta fuente ni siquiera intentó reportar).
    expect(result.nutrientStatus?.salt).toBeUndefined();
    expect(result.salt).toBeUndefined();
  });

  it("un macro solo disponible en el campo SIN sufijo (base no confirmada) es estimated", async () => {
    mockFetchRouter({
      offProducts: [offProduct({}, { "energy-kcal_100g": 200, proteins: 12 })],
    });
    const [result] = await searchOFFSuggestions("prueba");
    expect(result.nutrientStatus?.protein).toBe("estimated");
    // El número mostrado no cambia por degradar el status: sigue siendo el
    // del campo bare, exactamente como antes de esta entrega.
    expect(result.protein).toBeCloseTo(12);
  });

  it("kcal solo disponible en el campo bare 'energy-kcal' es estimated, aunque sea el número mostrado", async () => {
    mockFetchRouter({
      offProducts: [offProduct({}, { "energy-kcal": 250 })],
    });
    const [result] = await searchOFFSuggestions("prueba");
    expect(result.nutrientStatus?.kcal).toBe("estimated");
    expect(result.kcal).toBe(250);
  });

  it("kcal solo disponible vía energy_100g (kJ) es known_* — la conversión también es base 100g", async () => {
    mockFetchRouter({
      offProducts: [offProduct({}, { energy_100g: 836.8 })], // 836.8 kJ ÷ 4.184 = 200 kcal
    });
    const [result] = await searchOFFSuggestions("prueba");
    expect(result.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(result.kcal).toBe(200);
  });

  it("estado del alimento: búsqueda y producto declaran el mismo estado → confirmed", async () => {
    mockFetchRouter({
      offProducts: [offProduct({ product_name_es: "Pechuga de pollo cruda" }, { "energy-kcal_100g": 110 })],
    });
    const [result] = await searchOFFSuggestions("pollo crudo");
    expect(result.foodStateConfidence).toBe("confirmed");
  });

  it("estado del alimento: búsqueda y producto declaran estados incompatibles → incompatible, aunque el nutriente sea known_*", async () => {
    mockFetchRouter({
      offProducts: [offProduct({ product_name_es: "Pollo cocido a la plancha" }, { "energy-kcal_100g": 165 })],
    });
    const [result] = await searchOFFSuggestions("pollo crudo");
    expect(result.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(result.foodStateConfidence).toBe("incompatible");
  });

  it("estado del alimento: sin estado declarado en la búsqueda → unknown (caso mayoritario)", async () => {
    mockFetchRouter({
      offProducts: [offProduct({ product_name_es: "Pechuga de pollo cruda" }, { "energy-kcal_100g": 110 })],
    });
    const [result] = await searchOFFSuggestions("pollo");
    expect(result.foodStateConfidence).toBe("unknown");
  });
});

describe("lookupFoodExternal — USDA (tras agotar OFF)", () => {
  it("un nutriente USDA explícitamente en 0 es known_zero, no ausencia", async () => {
    mockFetchRouter({
      offProducts: [],
      usdaFoods: [
        {
          description: "Rabbit, meat, raw",
          foodNutrients: [
            { nutrientId: 1008, value: 173 },
            { nutrientId: 1003, value: 0 },
            { nutrientId: 1005, value: 20 },
            { nutrientId: 1004, value: 8 },
          ],
        },
      ],
    });
    const result = await lookupFoodExternal("conejo");
    expect(result?.source).toBe("usda");
    expect(result?.nutrientStatus?.protein).toBe("known_zero");
    expect(result?.protein).toBe(0);
  });

  it("un nutriente USDA ausente del array de foodNutrients es unknown, nunca known_zero", async () => {
    mockFetchRouter({
      offProducts: [],
      usdaFoods: [
        {
          description: "Rabbit, meat, raw",
          foodNutrients: [
            { nutrientId: 1008, value: 173 },
            { nutrientId: 1005, value: 20 },
            { nutrientId: 1004, value: 8 },
            // nutrientId 1003 (proteína) no está presente en absoluto
          ],
        },
      ],
    });
    const result = await lookupFoodExternal("conejo");
    expect(result?.nutrientStatus?.protein).toBe("unknown");
    // El número mostrado sigue cayendo a 0 (mismo fallback de siempre), pero
    // eso no debe leerse como "cero conocido" en el metadato — ver arriba.
    expect(result?.protein).toBe(0);
  });

  it("estado del alimento: la búsqueda declara un estado que coincide con la descripción de USDA → confirmed", async () => {
    mockFetchRouter({
      offProducts: [],
      usdaFoods: [{ description: "Beef, roasted", foodNutrients: [{ nutrientId: 1008, value: 250 }] }],
    });
    const result = await lookupFoodExternal("ternera asada");
    expect(result?.foodStateConfidence).toBe("confirmed");
  });

  it("estado del alimento: la búsqueda declara un estado incompatible con la descripción de USDA → incompatible", async () => {
    mockFetchRouter({
      offProducts: [],
      usdaFoods: [{ description: "Beef, raw", foodNutrients: [{ nutrientId: 1008, value: 250 }] }],
    });
    const result = await lookupFoodExternal("ternera asada");
    expect(result?.foodStateConfidence).toBe("incompatible");
  });

  it("estado del alimento: la búsqueda no declara ningún estado → unknown", async () => {
    mockFetchRouter({
      offProducts: [],
      usdaFoods: [{ description: "Croissant, butter", foodNutrients: [{ nutrientId: 1008, value: 406 }] }],
    });
    const result = await lookupFoodExternal("croissant");
    expect(result?.foodStateConfidence).toBe("unknown");
  });
});
