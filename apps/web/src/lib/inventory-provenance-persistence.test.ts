// Persistencia de la procedencia de un InventoryItem con su fila (columna JSONB
// nullable `nutrition_provenance`). Las pruebas de ida y vuelta completas contra
// pushState/pullState están en data-layer.test.ts; aquí, las reglas puras de
// serialización, saneado y FRESCURA (clientes antiguos) en sus casos límite.
import { describe, expect, it } from "vitest";
import type { InventoryItem } from "@foodos/types";
import { inventoryProvenanceFromColumn, inventoryProvenanceToColumn, type InventoryReference } from "./inventory-provenance-persistence";

const REF: InventoryReference = { name: "Pechuga", unit: "g", kcal: 165, protein: 31, carbs: 0, fat: 3.6 };

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "i1", qty: 100, storage: "Nevera", expires: "2099-01-01", price: 1,
    ...REF,
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

  it("guarda dataSource, nutrientStatus y foodStateConfidence junto a la referencia que describen", () => {
    expect(inventoryProvenanceToColumn(item())).toEqual({
      dataSource: "off",
      nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
      foodStateConfidence: "confirmed",
      basis: { name: "Pechuga", unit: "g", kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
    });
  });

  it("basis incluye un número solo si el item lo tiene (kcal 0 sí; carbs/fat ausentes no)", () => {
    const col = inventoryProvenanceToColumn(item({ kcal: 0, protein: 0, carbs: undefined, fat: undefined, salt: 0.2 }));
    expect(col?.basis).toEqual({ name: "Pechuga", unit: "g", kcal: 0, protein: 0, salt: 0.2 });
  });

  it("basis lleva unitSize y su dimensión cuando el item los tiene", () => {
    const col = inventoryProvenanceToColumn(item({ unit: "ud", unitSize: 330, unitSizeUnit: "ml" }));
    expect(col?.basis).toMatchObject({ unit: "ud", unitSize: 330, unitSizeUnit: "ml" });
  });

  it("los números del basis se guardan en su forma CANÓNICA de numeric(…,2), no en la del cliente", () => {
    const col = inventoryProvenanceToColumn(item({ kcal: 165.0051, protein: 31.004, carbs: 1.005, unit: "ud", unitSize: 125.129, unitSizeUnit: "g" }));
    expect(col?.basis).toMatchObject({ kcal: 165.01, protein: 31, carbs: 1.01, unitSize: 125.13 });
  });

  it("basta una sola pieza de procedencia (p. ej. solo dataSource) para escribir el objeto", () => {
    const col = inventoryProvenanceToColumn(item({ nutrientStatus: undefined, foodStateConfidence: undefined, dataSource: "ai" }));
    expect(col).toEqual({ dataSource: "ai", basis: { name: "Pechuga", unit: "g", kcal: 165, protein: 31, carbs: 0, fat: 3.6 } });
  });

  it("solo salen valores válidos: un dataSource o estado corrupto en memoria no se persiste", () => {
    const corrupt = item({
      dataSource: "supermercado" as unknown as InventoryItem["dataSource"],
      nutrientStatus: { kcal: "known_maybe", protein: "estimated" } as unknown as InventoryItem["nutrientStatus"],
      foodStateConfidence: "seguro" as unknown as InventoryItem["foodStateConfidence"],
    });
    expect(inventoryProvenanceToColumn(corrupt)).toEqual({ nutrientStatus: { protein: "estimated" }, basis: { name: "Pechuga", unit: "g", kcal: 165, protein: 31, carbs: 0, fat: 3.6 } });
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

  it("ida y vuelta: lo escrito se lee tal cual cuando la referencia no cambió", () => {
    expect(inventoryProvenanceFromColumn(good(), REF)).toEqual({
      dataSource: "off",
      nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
      foodStateConfidence: "confirmed",
    });
  });

  describe("números — valor canónico exacto, sin banda de tolerancia", () => {
    it("165,0051 se guarda como 165,01: el redondeo inicial NO descarta la procedencia", () => {
      const col = inventoryProvenanceToColumn(item({ kcal: 165.0051 }))!;
      expect(inventoryProvenanceFromColumn(col, { ...REF, kcal: 165.01 }).nutrientStatus).toBeDefined();
    });

    it("…pero una edición posterior a 165,00 (una diferencia real de 0,01) SÍ la descarta", () => {
      const col = inventoryProvenanceToColumn(item({ kcal: 165.0051 }))!;
      expect(inventoryProvenanceFromColumn(col, { ...REF, kcal: 165 })).toEqual({});
    });

    it("el redondeo es el de Postgres (mitad hacia arriba sobre el texto decimal), no el del double: 1,005 → 1,01", () => {
      const col = inventoryProvenanceToColumn(item({ carbs: 1.005 }))!;
      expect(inventoryProvenanceFromColumn(col, { ...REF, carbs: 1.01 }).nutrientStatus).toBeDefined();
      expect(inventoryProvenanceFromColumn(col, { ...REF, carbs: 1 })).toEqual({}); // con Math.round(x*100)/100 saldría 1 y coincidiría por error
    });

    it("cualquier número por 100 que cambió, aunque sea en el último decimal, invalida TODA la procedencia", () => {
      for (const changed of [{ kcal: 165.01 }, { protein: 31.01 }, { carbs: 0.01 }, { fat: 3.61 }, { kcal: 200 }]) {
        expect(inventoryProvenanceFromColumn(good(), { ...REF, ...changed }), JSON.stringify(changed)).toEqual({});
      }
    });

    it("un número que el item ganó y la procedencia no conocía (o al revés) la invalida", () => {
      expect(inventoryProvenanceFromColumn(good(), { ...REF, salt: 1 })).toEqual({});
      const withoutFat = inventoryProvenanceToColumn(item({ fat: undefined }))!;
      expect(inventoryProvenanceFromColumn(withoutFat, { ...REF, fat: undefined }).dataSource).toBe("off");
      expect(inventoryProvenanceFromColumn(good(), { ...REF, fat: undefined })).toEqual({}); // el item perdió la grasa
    });
  });

  describe("nombre", () => {
    it("«arroz crudo» → «arroz cocido» sin tocar los números la invalida (foodStateConfidence no se hereda)", () => {
      const col = inventoryProvenanceToColumn(item({ name: "Arroz crudo" }))!;
      expect(inventoryProvenanceFromColumn(col, { ...REF, name: "Arroz crudo" }).foodStateConfidence).toBe("confirmed");
      expect(inventoryProvenanceFromColumn(col, { ...REF, name: "arroz cocido" })).toEqual({});
    });

    it("mayúsculas y espacios de más no cuentan como cambio de nombre (§16.5)", () => {
      const col = inventoryProvenanceToColumn(item({ name: "Arroz crudo" }))!;
      for (const name of ["ARROZ CRUDO", "  arroz   crudo ", "arroz crudo"]) {
        expect(inventoryProvenanceFromColumn(col, { ...REF, name }).foodStateConfidence, name).toBe("confirmed");
      }
    });

    it("un basis sin nombre, o con un nombre que no es texto, no se puede verificar: se descarta", () => {
      for (const name of [undefined, null, 5, {}, []]) {
        const col = { ...good(), basis: { ...good().basis, name } };
        expect(inventoryProvenanceFromColumn(col, REF)).toEqual({});
      }
    });
  });

  describe("unidad y tamaño de unidad", () => {
    const can = () => inventoryProvenanceToColumn(item({ unit: "ud", unitSize: 330, unitSizeUnit: "ml" }))!;
    const CAN: InventoryReference = { ...REF, unit: "ud", unitSize: 330, unitSizeUnit: "ml" };

    it("sin cambios, sigue válida", () => {
      expect(inventoryProvenanceFromColumn(can(), CAN).foodStateConfidence).toBe("confirmed");
    });

    it("cambiar la unidad, el tamaño o su dimensión la invalida", () => {
      for (const changed of [{ unit: "g" }, { unit: "L" }, { unitSize: 500 }, { unitSize: 330.01 }, { unitSizeUnit: "g" as const }, { unitSizeUnit: undefined }, { unitSize: undefined }]) {
        expect(inventoryProvenanceFromColumn(can(), { ...CAN, ...changed }), JSON.stringify(changed)).toEqual({});
      }
    });

    it("un item que ganó un tamaño de unidad que la procedencia no conocía la invalida", () => {
      expect(inventoryProvenanceFromColumn(good(), { ...REF, unit: "g", unitSize: 60, unitSizeUnit: "g" })).toEqual({});
    });

    it("una unidad ausente o que no es texto en el basis se descarta", () => {
      for (const unit of [undefined, null, 1]) expect(inventoryProvenanceFromColumn({ ...good(), basis: { ...good().basis, unit } }, REF)).toEqual({});
    });
  });

  it("sin basis, o con un basis inservible, no hay forma de verificarla: se descarta", () => {
    const { basis: _basis, ...withoutBasis } = good();
    void _basis;
    for (const bad of [
      withoutBasis, { ...good(), basis: null }, { ...good(), basis: "x" }, { ...good(), basis: [] }, { ...good(), basis: { name: "Pechuga", unit: "g", kcal: 165 } },
      { ...good(), basis: { ...good().basis, kcal: "165" } },
    ]) {
      expect(inventoryProvenanceFromColumn(bad, REF)).toEqual({});
    }
  });

  it("valores que no son un objeto se ignoran sin lanzar", () => {
    for (const bad of [null, undefined, "texto", 5, true, [], [good()]]) {
      expect(inventoryProvenanceFromColumn(bad, REF)).toEqual({});
    }
  });

  it("descarta uno a uno los campos inválidos y conserva los válidos", () => {
    const out = inventoryProvenanceFromColumn(
      { ...good(), dataSource: "supermercado", foodStateConfidence: "seguro", nutrientStatus: { kcal: "known_maybe", protein: "known_nonzero", potassium: "known_nonzero" } },
      REF,
    );
    expect(out).toEqual({ nutrientStatus: { protein: "known_nonzero" } });
  });

  it("un basis válido con todos los campos inválidos no deja un objeto con claves vacías", () => {
    expect(inventoryProvenanceFromColumn({ ...good(), dataSource: 3, nutrientStatus: [], foodStateConfidence: 7 }, REF)).toEqual({});
  });

  it("no muta ni la columna ni la referencia", () => {
    const col = good();
    const snapshot = structuredClone(col);
    const ref = { ...REF };
    inventoryProvenanceFromColumn(col, ref);
    expect(col).toEqual(snapshot);
    expect(ref).toEqual(REF);
  });

  it("un JSON de la base (sin undefined, con null) se lee igual que el objeto original", () => {
    const viaJson = JSON.parse(JSON.stringify(good()));
    expect(inventoryProvenanceFromColumn(viaJson, REF).nutrientStatus).toEqual(good().nutrientStatus);
  });
});
