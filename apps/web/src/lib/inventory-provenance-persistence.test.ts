// Persistencia de la procedencia de un InventoryItem con su fila (columna JSONB
// nullable `nutrition_provenance`). Las pruebas de ida y vuelta completas contra
// pushState/pullState están en data-layer.test.ts; aquí, las reglas puras de
// serialización, saneado y FRESCURA (clientes antiguos) en sus casos límite.
import { describe, expect, it } from "vitest";
import type { InventoryItem } from "@foodos/types";
import { inventoryProvenanceFromColumn, inventoryProvenanceToColumn } from "./inventory-provenance-persistence";

const NUMBERS = { kcal: 165, protein: 31, carbs: 0, fat: 3.6 } as const;

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "i1", name: "Pechuga", qty: 100, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 1,
    ...NUMBERS,
    dataSource: "off",
    nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
    foodStateConfidence: "confirmed",
    ...overrides,
  };
}

describe("inventoryProvenanceToColumn", () => {
  it("un item sin ninguna procedencia (anterior a PR3a) escribe NULL — nunca un objeto vacío", () => {
    const legacy = item();
    delete legacy.dataSource;
    delete legacy.nutrientStatus;
    delete legacy.foodStateConfidence;
    expect(inventoryProvenanceToColumn(legacy)).toBeNull();
  });

  it("guarda dataSource, nutrientStatus y foodStateConfidence junto a los números por 100 que describen", () => {
    expect(inventoryProvenanceToColumn(item())).toEqual({
      dataSource: "off",
      nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
      foodStateConfidence: "confirmed",
      basis: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
    });
  });

  it("basis incluye un valor solo si el item lo tiene (kcal 0 sí; carbs/fat ausentes no)", () => {
    const col = inventoryProvenanceToColumn(item({ kcal: 0, protein: 0, carbs: undefined, fat: undefined, salt: 0.2 }));
    expect(col?.basis).toEqual({ kcal: 0, protein: 0, salt: 0.2 });
  });

  it("basta una sola pieza de procedencia (p. ej. solo dataSource) para escribir el objeto", () => {
    const col = inventoryProvenanceToColumn(item({ nutrientStatus: undefined, foodStateConfidence: undefined, dataSource: "ai" }));
    expect(col).toEqual({ dataSource: "ai", basis: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 } });
  });

  it("solo salen valores válidos: un dataSource o estado corrupto en memoria no se persiste", () => {
    const corrupt = item({
      dataSource: "supermercado" as unknown as InventoryItem["dataSource"],
      nutrientStatus: { kcal: "known_maybe", protein: "estimated" } as unknown as InventoryItem["nutrientStatus"],
      foodStateConfidence: "seguro" as unknown as InventoryItem["foodStateConfidence"],
    });
    expect(inventoryProvenanceToColumn(corrupt)).toEqual({ nutrientStatus: { protein: "estimated" }, basis: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 } });
  });

  it("no muta el item", () => {
    const original = item();
    const snapshot = structuredClone(original);
    inventoryProvenanceToColumn(original);
    expect(original).toEqual(snapshot);
  });
});

describe("inventoryProvenanceFromColumn — frescura y saneado", () => {
  const good = () => inventoryProvenanceToColumn(item())!;

  it("ida y vuelta: lo escrito se lee tal cual cuando los números no cambiaron", () => {
    expect(inventoryProvenanceFromColumn(good(), NUMBERS)).toEqual({
      dataSource: "off",
      nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
      foodStateConfidence: "confirmed",
    });
  });

  it("tolera el redondeo de la base a 2 decimales (≤ 0,005) pero no un cambio real", () => {
    const col = inventoryProvenanceToColumn(item({ kcal: 165.456 }))!;
    expect(inventoryProvenanceFromColumn(col, { ...NUMBERS, kcal: 165.46 }).nutrientStatus).toBeDefined();
    expect(inventoryProvenanceFromColumn(col, { ...NUMBERS, kcal: 165.47 })).toEqual({}); // 0,014 de diferencia
    expect(inventoryProvenanceFromColumn(good(), { ...NUMBERS, kcal: 166 })).toEqual({});
  });

  it("cualquier número por 100 que cambió invalida TODA la procedencia (no solo ese campo)", () => {
    for (const changed of [{ kcal: 200 }, { protein: 25 }, { carbs: 1 }, { fat: 9 }]) {
      expect(inventoryProvenanceFromColumn(good(), { ...NUMBERS, ...changed })).toEqual({});
    }
  });

  it("un número que el item ganó y la procedencia no conocía (o al revés) la invalida", () => {
    expect(inventoryProvenanceFromColumn(good(), { ...NUMBERS, salt: 1 })).toEqual({});
    const withoutFat = inventoryProvenanceToColumn(item({ fat: undefined }))!;
    expect(inventoryProvenanceFromColumn(withoutFat, { kcal: 165, protein: 31, carbs: 0, fat: undefined }).dataSource).toBe("off");
    expect(inventoryProvenanceFromColumn(good(), { kcal: 165, protein: 31, carbs: 0, fat: undefined })).toEqual({}); // el item perdió la grasa
  });

  it("sin basis, o con un basis inservible, no hay forma de verificarla: se descarta", () => {
    const { basis: _basis, ...withoutBasis } = good();
    void _basis;
    for (const bad of [withoutBasis, { ...good(), basis: null }, { ...good(), basis: "x" }, { ...good(), basis: [] }, { ...good(), basis: { kcal: 165 } }, { ...good(), basis: { kcal: "165", protein: 31 } }]) {
      expect(inventoryProvenanceFromColumn(bad, NUMBERS)).toEqual({});
    }
  });

  it("valores que no son un objeto se ignoran sin lanzar", () => {
    for (const bad of [null, undefined, "texto", 5, true, [], [good()]]) {
      expect(inventoryProvenanceFromColumn(bad, NUMBERS)).toEqual({});
    }
  });

  it("descarta uno a uno los campos inválidos y conserva los válidos", () => {
    const out = inventoryProvenanceFromColumn(
      { ...good(), dataSource: "supermercado", foodStateConfidence: "seguro", nutrientStatus: { kcal: "known_maybe", protein: "known_nonzero", potassium: "known_nonzero" } },
      NUMBERS,
    );
    expect(out).toEqual({ nutrientStatus: { protein: "known_nonzero" } });
  });

  it("un basis válido con todos los campos inválidos no deja un objeto con claves vacías", () => {
    expect(inventoryProvenanceFromColumn({ ...good(), dataSource: 3, nutrientStatus: [], foodStateConfidence: 7 }, NUMBERS)).toEqual({});
  });

  it("no muta ni la columna ni los números", () => {
    const col = good();
    const snapshot = structuredClone(col);
    const numbers = { ...NUMBERS };
    inventoryProvenanceFromColumn(col, numbers);
    expect(col).toEqual(snapshot);
    expect(numbers).toEqual(NUMBERS);
  });

  it("un JSON de la base (sin undefined, con null) se lee igual que el objeto original", () => {
    const viaJson = JSON.parse(JSON.stringify(good()));
    expect(inventoryProvenanceFromColumn(viaJson, NUMBERS).nutrientStatus).toEqual(good().nutrientStatus);
  });
});
