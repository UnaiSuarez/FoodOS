// PR3a — procedencia en el punto de captura del escáner de código de
// barras. `parseBarcodeProduct` es una función pura (extraída de
// fetchProduct para poder probarla sin montar el componente ni simular
// getUserMedia/BarcodeDetector), así que se prueba directamente.
import { describe, expect, it } from "vitest";
import { parseBarcodeProduct } from "./BarcodeScannerModal";

describe("parseBarcodeProduct — procedencia por campo", () => {
  it("un macro sufijado _100g presente y en 0 es known_zero, no ausencia", () => {
    const result = parseBarcodeProduct(
      { product_name_es: "Agua mineral", nutriments: { "energy-kcal_100g": 0, proteins_100g: 0 } },
      "8410000000017",
    );
    expect(result.nutrientStatus?.kcal).toBe("known_zero");
    expect(result.nutrientStatus?.protein).toBe("known_zero");
  });

  it("un macro ausente queda unknown, aunque el número visible caiga al fallback ?? 0", () => {
    const result = parseBarcodeProduct(
      { product_name_es: "Producto sin proteína declarada", nutriments: { "energy-kcal_100g": 200 } },
      "8410000000017",
    );
    expect(result.nutrientStatus?.protein).toBe("unknown");
    expect(result.protein).toBe(0);
    // Este endpoint no tiene fallback a un campo bare para protein/carbs/fat:
    // ausente en _100g es directamente unknown, nunca "estimated".
  });

  it("kcal solo vía energy_100g (kJ) es known_* — este endpoint no consulta el campo bare 'energy-kcal'", () => {
    const result = parseBarcodeProduct(
      { product_name_es: "Producto de prueba", nutriments: { energy_100g: 836.8 } }, // ÷4.184 = 200 kcal
      "8410000000017",
    );
    expect(result.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(result.kcal).toBe(200);
  });

  it("sin ningún dato de energía → kcal unknown y el número visible cae a 0", () => {
    const result = parseBarcodeProduct({ product_name_es: "Producto sin datos", nutriments: {} }, "8410000000017");
    expect(result.nutrientStatus?.kcal).toBe("unknown");
    expect(result.kcal).toBe(0);
  });

  it("sin nombre de producto usa el código de barras como fallback, y sigue siendo el texto comparado para el estado del alimento", () => {
    const result = parseBarcodeProduct({ nutriments: { "energy-kcal_100g": 100 } }, "Pollo crudo");
    expect(result.name).toBe("Pollo crudo");
  });
});

describe("parseBarcodeProduct — estado del alimento (código de barras / producto, corrección tras revisión)", () => {
  it("un producto escaneado llamado «Pechuga de pollo», sin campos preparados ni estado declarado, NO puede quedar not_applicable", () => {
    const result = parseBarcodeProduct(
      { product_name_es: "Pechuga de pollo", nutriments: { "energy-kcal_100g": 165 } },
      "code",
    );
    expect(result.foodStateConfidence).toBe("unknown");
    expect(result.foodStateConfidence).not.toBe("not_applicable");
  });

  it("una lata de refresco sin ningún indicio de preparación tampoco es not_applicable — ausencia de indicios no es prueba", () => {
    const result = parseBarcodeProduct(
      { product_name_es: "Coca-Cola lata 330ml", nutriments: { "energy-kcal_100g": 42 } },
      "code",
    );
    expect(result.foodStateConfidence).toBe("unknown");
  });

  it("el producto declara una base preparada separada (*_prepared_100g) → unknown, igual que sin ella", () => {
    const result = parseBarcodeProduct(
      {
        product_name_es: "Pasta seca",
        nutriments: { "energy-kcal_100g": 350, "energy-kcal_prepared_100g": 140 },
      },
      "code",
    );
    expect(result.foodStateConfidence).toBe("unknown");
  });

  it("el nombre del producto ya declara una preparación → sigue siendo unknown, no confirmed (no hay un segundo lado con el que contrastar)", () => {
    const result = parseBarcodeProduct(
      { product_name_es: "Pasta cocida en salsa", nutriments: { "energy-kcal_100g": 120 } },
      "code",
    );
    expect(result.foodStateConfidence).toBe("unknown");
  });
});
