import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIConfig } from "./ai-config";
import { estimateMealFromPhoto, estimateMealMacros, fillFoodData, identifyFoodFromPhoto, scanTicketImage } from "./ai-inventory";

// PR3a — procedencia en los 3 niveles de fillFoodData (BD local → OFF/USDA →
// IA) y en los dos caminos de análisis de imagen (ticket, foto de
// alimento). El fetch real se sustituye por respuestas controladas, igual
// que en ai-provider.test.ts/food-lookup.test.ts.

const GEMINI_CONFIG: AIConfig = { provider: "gemini", apiKey: "test-key", model: "gemini-1.5-flash" };
const UNKNOWN_NAME = "Xyzalimentoinventadoqueseguronoexiste";

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

function mockFetchRouter(opts: { offProducts?: unknown[]; usdaFoods?: unknown[]; geminiText?: string; geminiArrayText?: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/food-search")) {
        return { ok: true, json: async () => ({ products: opts.offProducts ?? [] }) };
      }
      if (url.includes("api.nal.usda.gov")) {
        return { ok: true, json: async () => ({ foods: opts.usdaFoods ?? [] }) };
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        const text = opts.geminiArrayText ?? opts.geminiText ?? "[]";
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fillFoodData — nivel 1: BD local", () => {
  it("un alimento del catálogo local es legacy_unlabeled, nunca known_*", async () => {
    const result = await fillFoodData(null, "Pechuga de pollo");
    expect(result?.source).toBe("local");
    expect(result?.nutrientStatus?.kcal).toBe("legacy_unlabeled");
    expect(result?.nutrientStatus?.protein).toBe("legacy_unlabeled");
  });
});

describe("fillFoodData — nivel 2: OFF/USDA (propaga la procedencia real ya calculada)", () => {
  it("un macro explícitamente cero en OFF llega como known_zero, no como ausencia", async () => {
    mockFetchRouter({
      offProducts: [
        {
          product_name_es: UNKNOWN_NAME,
          nutriments: { "energy-kcal_100g": 40, proteins_100g: 0 },
        },
      ],
    });
    const result = await fillFoodData(null, UNKNOWN_NAME);
    expect(result?.source).toBe("off");
    expect(result?.nutrientStatus?.protein).toBe("known_zero");
    // FoodNutriData solo transporta kcal/protein: un estado de carbs/fat sin
    // número detrás sería metadato huérfano.
    expect(Object.keys(result?.nutrientStatus ?? {}).sort()).toEqual(["kcal", "protein"]);
  });

  it("un macro ausente en la fuente USDA llega como unknown, no known_zero, aunque el número visible sea 0", async () => {
    // "conejo" es una entrada real de ES_TO_EN en food-lookup.ts — searchUSDA
    // solo intenta la búsqueda cuando el nombre tiene traducción conocida.
    mockFetchRouter({
      offProducts: [],
      usdaFoods: [
        {
          description: "Rabbit, meat, raw",
          foodNutrients: [{ nutrientId: 1008, value: 50 }], // solo kcal, sin proteína
        },
      ],
    });
    const result = await fillFoodData(null, "conejo");
    expect(result?.source).toBe("usda");
    expect(result?.nutrientStatus?.protein).toBe("unknown");
    expect(result?.protein).toBe(0);
  });
});

describe("fillFoodData — nivel 3: IA (última opción, nunca known_*)", () => {
  it("un campo que la IA omite queda unknown, no estimated ni known_zero, pese al fallback ?? 0 del número mostrado", async () => {
    mockFetchRouter({
      offProducts: [], usdaFoods: [],
      geminiText: JSON.stringify({ kcal: 120, unit: "g", defaultQty: 100, storage: "Nevera", expiryDays: 5 }), // protein omitido
    });
    const result = await fillFoodData(GEMINI_CONFIG, UNKNOWN_NAME);
    expect(result?.source).toBe("ai");
    expect(result?.nutrientStatus?.kcal).toBe("estimated");
    expect(result?.nutrientStatus?.protein).toBe("unknown");
    expect(result?.protein).toBe(0);
  });

  it("un campo que la IA declara en 0 es estimated, no known_zero (una IA nunca es known_*)", async () => {
    mockFetchRouter({
      offProducts: [], usdaFoods: [],
      geminiText: JSON.stringify({ kcal: 0, protein: 0, unit: "g", defaultQty: 100, storage: "Nevera", expiryDays: 5 }),
    });
    const result = await fillFoodData(GEMINI_CONFIG, UNKNOWN_NAME);
    expect(result?.nutrientStatus?.kcal).toBe("estimated");
    expect(result?.nutrientStatus?.protein).toBe("estimated");
  });
});

describe("scanTicketImage — siempre IA", () => {
  it("un artículo del ticket sin proteína declarada queda unknown, no estimated", async () => {
    mockFetchRouter({
      geminiArrayText: JSON.stringify([{ name: "Producto ticket", qty: 200, unit: "g", kcal: 80, storage: "Nevera", expiryDays: 5, price: 1.5 }]),
    });
    const [item] = await scanTicketImage(GEMINI_CONFIG, "base64data", "image/jpeg");
    expect(item.nutrientStatus?.kcal).toBe("estimated");
    expect(item.nutrientStatus?.protein).toBe("unknown");
    expect(item.protein).toBe(0);
  });
});

describe("identifyFoodFromPhoto — siempre IA", () => {
  it("un candidato identificado sin proteína declarada queda unknown, no estimated", async () => {
    mockFetchRouter({
      geminiArrayText: JSON.stringify([{ name: "Manzana", kcal: 52, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 14 }]),
    });
    const [candidate] = await identifyFoodFromPhoto(GEMINI_CONFIG, "base64data", "image/jpeg");
    expect(candidate.nutrientStatus?.kcal).toBe("estimated");
    expect(candidate.nutrientStatus?.protein).toBe("unknown");
    expect(candidate.protein).toBe(0);
  });
});

// PR3 (hueco de PR3a) — los dos estimadores de COMIDA COMPLETA no llevaban
// procedencia: colapsaban protein/carbs/fat con `?? 0` y no declaraban que su
// número ya es el total consumido (AC25e). El número devuelto no cambia.
describe("estimateMealMacros — total de comida completa por IA", () => {
  it("los cuatro macros declarados son estimated (nunca known_*) y foodStateConfidence es not_applicable", async () => {
    mockFetchRouter({ geminiText: JSON.stringify({ kcal: 600, protein: 40, carbs: 55, fat: 20 }) });
    const result = await estimateMealMacros(GEMINI_CONFIG, "menú del día");
    expect(result).toMatchObject({ kcal: 600, protein: 40, carbs: 55, fat: 20 });
    expect(result?.nutrientStatus).toEqual({ kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "estimated" });
    expect(result?.foodStateConfidence).toBe("not_applicable");
  });

  it("un macro que la IA omite queda unknown pese al ?? 0 del número devuelto; un 0 explícito es estimated", async () => {
    mockFetchRouter({ geminiText: JSON.stringify({ kcal: 300, protein: 0, carbs: 30 }) }); // protein 0 explícito, fat omitido
    const result = await estimateMealMacros(GEMINI_CONFIG, "tostada");
    expect(result?.fat).toBe(0); // el número mostrado conserva su fallback
    expect(result?.nutrientStatus?.fat).toBe("unknown");
    expect(result?.nutrientStatus?.protein).toBe("estimated");
    expect(result?.nutrientStatus?.protein).not.toBe("known_zero");
  });

  it("sin kcal numérico no hay resultado (comportamiento previo intacto)", async () => {
    mockFetchRouter({ geminiText: JSON.stringify({ protein: 10 }) });
    expect(await estimateMealMacros(GEMINI_CONFIG, "algo")).toBeNull();
  });
});

describe("estimateMealFromPhoto — total de comida completa por IA", () => {
  it("propaga estimated por macro y not_applicable, y un macro omitido queda unknown", async () => {
    mockFetchRouter({ geminiText: JSON.stringify({ name: "Paella", kcal: 700, protein: 35, carbs: 90 }) }); // fat omitido
    const result = await estimateMealFromPhoto(GEMINI_CONFIG, "base64data", "image/jpeg");
    expect(result).toMatchObject({ name: "Paella", kcal: 700, protein: 35, carbs: 90, fat: 0 });
    expect(result?.nutrientStatus).toEqual({ kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "unknown" });
    expect(result?.foodStateConfidence).toBe("not_applicable");
  });
});
