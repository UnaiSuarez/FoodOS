import { describe, expect, it } from "vitest";
import { convertQty, ensureUuid, isUuid, namesMatch, toGrams, unitDimension } from "./utils";

describe("toGrams", () => {
  it("kg y L multiplican por 1000", () => {
    expect(toGrams(2, "kg")).toBe(2000);
    expect(toGrams(1.5, "L")).toBe(1500);
  });

  it("g y ml pasan igual (caso por defecto)", () => {
    expect(toGrams(250, "g")).toBe(250);
    expect(toGrams(330, "ml")).toBe(330);
  });

  it("oz y lb usan el factor de conversión correcto", () => {
    expect(toGrams(1, "oz")).toBeCloseTo(28.35, 5);
    expect(toGrams(1, "lb")).toBeCloseTo(453.6, 5);
  });

  it("cucharada y pizca", () => {
    expect(toGrams(1, "cucharada")).toBe(15);
    expect(toGrams(1, "pizca")).toBe(0.5);
  });

  it("ud usa unitSize (o 60 por defecto)", () => {
    expect(toGrams(3, "ud")).toBe(180); // 3 * 60 por defecto
    expect(toGrams(2, "ud", 125)).toBe(250); // ej. yogures de 125g
  });
});

describe("namesMatch", () => {
  it("coincide con nombres idénticos (case-insensitive, con espacios)", () => {
    expect(namesMatch("Pechuga de pollo", "pechuga de pollo")).toBe(true);
    expect(namesMatch("  Leche  ", "leche")).toBe(true);
  });

  it("coincide si la primera palabra de uno está contenida en el otro", () => {
    expect(namesMatch("Pollo", "Pollo entero")).toBe(true);
    expect(namesMatch("Yogur griego", "Yogur")).toBe(true);
  });

  it("no coincide con nombres sin relación", () => {
    expect(namesMatch("Pollo", "Arroz")).toBe(false);
  });

  it("cadenas vacías nunca coinciden", () => {
    expect(namesMatch("", "algo")).toBe(false);
    expect(namesMatch("algo", "")).toBe(false);
  });

  // E08-07: antes solo comparaba la primera palabra, así que variantes con
  // el mismo primer término pero distinto matiz casaban por error.
  it("no confunde variantes distintas que comparten la primera palabra", () => {
    expect(namesMatch("Leche entera", "Leche de coco")).toBe(false);
    expect(namesMatch("Aceite de oliva", "Aceite de girasol")).toBe(false);
    expect(namesMatch("Yogur griego", "Yogur natural")).toBe(false);
    expect(namesMatch("Pechuga de pollo", "Muslo de pollo")).toBe(false);
  });

  it("sigue coincidiendo cuando una variante es realmente un caso concreto de la otra", () => {
    expect(namesMatch("Leche", "Leche entera")).toBe(true);
    expect(namesMatch("Tomate", "Tomate cherry")).toBe(true);
    expect(namesMatch("Arroz", "Arroz integral")).toBe(true);
  });

  it("tolera plural/género sin necesitar coincidencia exacta de palabra", () => {
    expect(namesMatch("Tomates", "Tomate cherry")).toBe(true);
  });
});

// B2 (revisión externa, 2026-08-22): ensureUuid() migra ids legacy no-UUID
// a UUIDs — tenía que ser DETERMINISTA (mismo id legacy -> misma UUID
// siempre) para que reenviar el mismo item tras un fallo parcial de sync no
// cree una fila duplicada en Supabase. Antes usaba crypto.randomUUID(),
// una UUID distinta en cada llamada.
describe("ensureUuid", () => {
  it("deja pasar un UUID válido tal cual", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(ensureUuid(uuid)).toBe(uuid);
  });

  it("un id legacy (no UUID) se convierte en un UUID válido", () => {
    const result = ensureUuid("legacy-item-42");
    expect(isUuid(result)).toBe(true);
  });

  it("el mismo id legacy produce SIEMPRE la misma UUID — determinista, no aleatorio", () => {
    const a = ensureUuid("legacy-item-42");
    const b = ensureUuid("legacy-item-42");
    const c = ensureUuid("legacy-item-42");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("ids legacy distintos producen UUIDs distintas", () => {
    expect(ensureUuid("legacy-item-1")).not.toBe(ensureUuid("legacy-item-2"));
  });

  it("es sensible a mayúsculas/minúsculas y a espacios (no normaliza el id de entrada)", () => {
    expect(ensureUuid("Legacy-1")).not.toBe(ensureUuid("legacy-1"));
    expect(ensureUuid("legacy-1 ")).not.toBe(ensureUuid("legacy-1"));
  });
});

// ── Ronda de cierre de auditoría: conversión ESTRICTA de unidades ──────────
// Reglas: g↔kg y ml↔L directo; masa↔volumen NUNCA sin densidad; "ud" solo con
// unitSize válido; cantidades negativas/NaN/infinitas nunca se propagan.
describe("convertQty — reglas dimensionales", () => {
  it("convierte directo dentro de la misma dimensión (g↔kg, ml↔L)", () => {
    expect(convertQty(1, "kg", "g")).toBe(1000);
    expect(convertQty(250, "g", "kg")).toBe(0.25);
    expect(convertQty(1.5, "L", "ml")).toBe(1500);
    expect(convertQty(750, "ml", "L")).toBe(0.75);
    expect(convertQty(2, "lb", "g")).toBeCloseTo(907.2, 1);
  });

  it("NUNCA cruza masa↔volumen sin densidad", () => {
    expect(convertQty(100, "ml", "g")).toBeNull();
    expect(convertQty(100, "g", "ml")).toBeNull();
    expect(convertQty(1, "L", "kg")).toBeNull();
    expect(convertQty(1, "kg", "L")).toBeNull();
  });

  it("'ud' solo convierte a masa/volumen con unitSize Y unitSizeUnit válidos — nunca el 60 por defecto", () => {
    expect(convertQty(2, "ud", "g", { fromUnitSize: 125, fromUnitSizeUnit: "g" })).toBe(250);
    expect(convertQty(250, "g", "ud", { toUnitSize: 125, toUnitSizeUnit: "g" })).toBe(2);
    expect(convertQty(2, "ud", "g", { fromUnitSizeUnit: "g" })).toBeNull();            // sin unitSize
    expect(convertQty(2, "ud", "g", { fromUnitSize: 0, fromUnitSizeUnit: "g" })).toBeNull();  // inválido
    expect(convertQty(2, "ud", "g", { fromUnitSize: -5, fromUnitSizeUnit: "g" })).toBeNull(); // inválido
    expect(convertQty(100, "g", "ud", { toUnitSizeUnit: "g" })).toBeNull();          // destino sin unitSize
  });

  it("'ud'↔'ud' es conteo directo, sin necesitar unitSize ni unitSizeUnit", () => {
    expect(convertQty(3, "ud", "ud")).toBe(3);
  });

  it("misma unidad es identidad (incluidas unidades desconocidas)", () => {
    expect(convertQty(42, "g", "g")).toBe(42);
    expect(convertQty(42, "raciones", "raciones")).toBe(42);
  });

  it("cantidades negativas, NaN o infinitas → null, nunca se propagan", () => {
    expect(convertQty(-1, "g", "kg")).toBeNull();
    expect(convertQty(Number.NaN, "g", "kg")).toBeNull();
    expect(convertQty(Infinity, "g", "kg")).toBeNull();
    expect(convertQty(-2, "ud", "ud")).toBeNull();
  });

  // Ronda de corrección (revisión externa): cucharada es un VOLUMEN exacto
  // (1 cucharada = 15 ml por definición de la propia unidad de medida) — no
  // una aproximación. cucharada→g sigue siendo masa↔volumen sin densidad, y
  // por tanto null, igual que ml→g; cucharada↔ml/L es directo.
  it("cucharada es un volumen exacto: convierte con ml/L, pero NUNCA a masa sin densidad", () => {
    expect(convertQty(2, "cucharada", "ml")).toBe(30);
    expect(convertQty(30, "ml", "cucharada")).toBe(2);
    expect(convertQty(1, "L", "cucharada")).toBeCloseTo(1000 / 15, 5);
    expect(convertQty(2, "cucharada", "g")).toBeNull();
    expect(convertQty(30, "g", "cucharada")).toBeNull();
  });

  // pizca, a diferencia de cucharada, no tiene una cantidad universal
  // conocida (no es "una fracción exacta de ml/g" por convención) — nunca
  // cruza a otra dimensión, ni siquiera declarando unitSizeUnit.
  it("pizca NUNCA convierte a otra dimensión — ni con unitSizeUnit declarado", () => {
    expect(convertQty(3, "pizca", "g")).toBeNull();
    expect(convertQty(3, "pizca", "ml")).toBeNull();
    expect(convertQty(3, "pizca", "ud", { toUnitSizeUnit: "g" })).toBeNull();
    expect(convertQty(3, "pizca", "pizca")).toBe(3); // identidad, la única conversión válida
  });

  // Ronda de corrección: unitSize por sí solo (un número) no dice si es
  // masa o volumen — antes "ud" cruzaba a CUALQUIER dimensión con el mismo
  // número, tratando 60 como "60 g" o "60 ml" según lo que pidiera el
  // destino, sin comprobar cuál es realmente. unitSizeUnit cierra ese hueco.
  describe("'ud' + unitSizeUnit — alimentos sólidos vs líquidos", () => {
    it("sólido: unitSize declarado en 'g' convierte a masa, pero NUNCA a volumen", () => {
      // 3 huevos de 60 g cada uno
      expect(convertQty(3, "ud", "g", { fromUnitSize: 60, fromUnitSizeUnit: "g" })).toBe(180);
      expect(convertQty(3, "ud", "ml", { fromUnitSize: 60, fromUnitSizeUnit: "g" })).toBeNull();
      expect(convertQty(3, "ud", "kg", { fromUnitSize: 60, fromUnitSizeUnit: "g" })).toBe(0.18);
    });

    it("líquido: unitSize declarado en 'ml' convierte a volumen, pero NUNCA a masa", () => {
      // 2 latas de 250 ml cada una
      expect(convertQty(2, "ud", "ml", { fromUnitSize: 250, fromUnitSizeUnit: "ml" })).toBe(500);
      expect(convertQty(2, "ud", "g", { fromUnitSize: 250, fromUnitSizeUnit: "ml" })).toBeNull();
      expect(convertQty(2, "ud", "L", { fromUnitSize: 250, fromUnitSizeUnit: "ml" })).toBe(0.5);
    });

    it("unitSize sin unitSizeUnit (dato legacy) nunca cruza a masa ni a volumen — se rehúsa, no asume", () => {
      expect(convertQty(3, "ud", "g", { fromUnitSize: 60 })).toBeNull();
      expect(convertQty(3, "ud", "ml", { fromUnitSize: 60 })).toBeNull();
    });

    it("unitSizeUnit que no coincide con la dimensión pedida → null (nunca se reinterpreta)", () => {
      // Declarado como líquido (ml) pero se pide como masa: null, no 250 g.
      expect(convertQty(2, "ud", "g", { fromUnitSize: 250, fromUnitSizeUnit: "ml" })).toBeNull();
      // Declarado como sólido (g) pero se pide como volumen: null, no 60 ml.
      expect(convertQty(3, "ud", "ml", { fromUnitSize: 60, fromUnitSizeUnit: "g" })).toBeNull();
    });

    it("mismas reglas en el lado destino ('ud' como toUnit)", () => {
      expect(convertQty(180, "g", "ud", { toUnitSize: 60, toUnitSizeUnit: "g" })).toBe(3);
      expect(convertQty(180, "ml", "ud", { toUnitSize: 60, toUnitSizeUnit: "g" })).toBeNull();
      expect(convertQty(500, "ml", "ud", { toUnitSize: 250, toUnitSizeUnit: "ml" })).toBe(2);
      expect(convertQty(500, "g", "ud", { toUnitSize: 250, toUnitSizeUnit: "ml" })).toBeNull();
    });
  });
});

describe("unitDimension", () => {
  it("clasifica cada unidad en su dimensión", () => {
    expect(unitDimension("g")).toBe("mass");
    expect(unitDimension("kg")).toBe("mass");
    expect(unitDimension("oz")).toBe("mass");
    expect(unitDimension("ml")).toBe("volume");
    expect(unitDimension("L")).toBe("volume");
    expect(unitDimension("ud")).toBe("count");
    expect(unitDimension("cucharada")).toBe("volume"); // 1 cucharada = 15 ml, volumen exacto
    expect(unitDimension("pizca")).toBe("approx"); // sin cantidad universal conocida
    expect(unitDimension("desconocida")).toBe("mass"); // passthrough, mismo criterio que toGrams
  });
});
