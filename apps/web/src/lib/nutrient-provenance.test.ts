import { describe, expect, it } from "vitest";
import {
  aiStatusFromValue,
  estimatedStatusFromValue,
  extractDeclaredState,
  knownStatusFromValue,
  legacyOrUnknown,
  localCatalogStatusFromValue,
  manualStatusFromValue,
  offHasSeparatePreparedBasis,
  resolveFoodStateConfidenceForDirectEntry,
  resolveFoodStateConfidenceForGenericMatch,
  resolveFoodStateConfidenceForProduct,
  resolveOffConfirmedOnlyStatus,
  resolveOffKcalStatus,
  resolveOffTieredStatus,
  resolveUsdaStatus,
} from "./nutrient-provenance";

describe("knownStatusFromValue", () => {
  it("clasifica un valor positivo como known_nonzero", () => {
    expect(knownStatusFromValue(12.5)).toBe("known_nonzero");
  });

  it("clasifica un cero explícito como known_zero, no como ausencia", () => {
    expect(knownStatusFromValue(0)).toBe("known_zero");
  });

  it("clasifica undefined como unknown", () => {
    expect(knownStatusFromValue(undefined)).toBe("unknown");
  });

  it("clasifica null como unknown", () => {
    expect(knownStatusFromValue(null)).toBe("unknown");
  });

  it("clasifica NaN/Infinity como unknown, nunca como known_*", () => {
    expect(knownStatusFromValue(NaN)).toBe("unknown");
    expect(knownStatusFromValue(Infinity)).toBe("unknown");
  });
});

describe("estimatedStatusFromValue — base de medida no confirmada", () => {
  it("un valor presente pero de base no confirmada nunca sube a known_*", () => {
    expect(estimatedStatusFromValue(50)).toBe("estimated");
  });

  it("un cero de base no confirmada también es estimated, no known_zero", () => {
    expect(estimatedStatusFromValue(0)).toBe("estimated");
  });

  it("ausente sigue siendo unknown", () => {
    expect(estimatedStatusFromValue(undefined)).toBe("unknown");
  });
});

describe("aiStatusFromValue — IA nunca es known_*", () => {
  it("un número inferido por IA es estimated aunque sea un valor 'limpio'", () => {
    expect(aiStatusFromValue(200)).toBe("estimated");
    expect(aiStatusFromValue(0)).toBe("estimated");
  });

  it("un campo omitido por la IA es unknown", () => {
    expect(aiStatusFromValue(undefined)).toBe("unknown");
  });
});

describe("localCatalogStatusFromValue — catálogo local sin procedencia por ficha", () => {
  it("un valor del catálogo local nunca es known_*, siempre legacy_unlabeled", () => {
    expect(localCatalogStatusFromValue(25)).toBe("legacy_unlabeled");
  });

  it("un cero del catálogo local también es legacy_unlabeled, no known_zero", () => {
    expect(localCatalogStatusFromValue(0)).toBe("legacy_unlabeled");
  });

  it("ausente sigue siendo unknown incluso en el catálogo local", () => {
    expect(localCatalogStatusFromValue(undefined)).toBe("unknown");
  });
});

describe("manualStatusFromValue — entrada manual vs. fallback numérico para la interfaz", () => {
  it("un campo sin rellenar (no tocado por el usuario) es unknown aunque su valor de interfaz sea 0", () => {
    expect(manualStatusFromValue(0, false)).toBe("unknown");
  });

  it("un fallback numérico para mostrar un número NO convierte unknown en known_zero", () => {
    const uiDisplayValue = 0;
    const wasExplicitlyEnteredByUser = false;
    expect(manualStatusFromValue(uiDisplayValue, wasExplicitlyEnteredByUser)).toBe("unknown");
  });

  it("un cero tecleado explícitamente por el usuario SÍ es known_zero", () => {
    expect(manualStatusFromValue(0, true)).toBe("known_zero");
  });

  it("un valor no-cero tecleado explícitamente es known_nonzero", () => {
    expect(manualStatusFromValue(30, true)).toBe("known_nonzero");
  });
});

describe("resolveOffKcalStatus — 3 niveles, mismo orden que la cadena existente", () => {
  it("energy-kcal_100g presente → known_* aunque los otros niveles también estén presentes", () => {
    expect(resolveOffKcalStatus(213, 250, 890)).toBe("known_nonzero");
  });

  it("energy-kcal_100g ausente, energy-kcal (bare) presente → estimated, nunca known_*", () => {
    expect(resolveOffKcalStatus(undefined, 250, 890)).toBe("estimated");
  });

  it("solo energy_100g (kJ) presente → known_* vía la conversión, que también es base 100g", () => {
    expect(resolveOffKcalStatus(undefined, undefined, 890)).toBe("known_nonzero");
  });

  it("ningún nivel presente → unknown", () => {
    expect(resolveOffKcalStatus(undefined, undefined, undefined)).toBe("unknown");
  });

  it("energy-kcal_100g explícitamente 0 → known_zero, no unknown", () => {
    expect(resolveOffKcalStatus(0, undefined, undefined)).toBe("known_zero");
  });

  it("un campo presente pero no numérico no sube a known_*/estimated, y no cae al siguiente nivel", () => {
    expect(resolveOffKcalStatus("no aplica", 250, 890)).toBe("unknown");
  });
});

describe("resolveOffTieredStatus — 2 niveles (proteína/carbohidratos/grasa)", () => {
  it("campo sufijado _100g presente → known_*", () => {
    expect(resolveOffTieredStatus(12.5, 20)).toBe("known_nonzero");
  });

  it("solo el campo sin sufijo presente → estimated", () => {
    expect(resolveOffTieredStatus(undefined, 20)).toBe("estimated");
  });

  it("ninguno presente → unknown", () => {
    expect(resolveOffTieredStatus(undefined, undefined)).toBe("unknown");
  });

  it("_100g explícitamente 0 → known_zero", () => {
    expect(resolveOffTieredStatus(0, 20)).toBe("known_zero");
  });
});

describe("resolveOffConfirmedOnlyStatus — 1 nivel (sal/fibra/azúcares)", () => {
  it("presente → known_*", () => {
    expect(resolveOffConfirmedOnlyStatus(1.2)).toBe("known_nonzero");
  });

  it("ausente → unknown", () => {
    expect(resolveOffConfirmedOnlyStatus(undefined)).toBe("unknown");
  });

  it("explícitamente 0 → known_zero", () => {
    expect(resolveOffConfirmedOnlyStatus(0)).toBe("known_zero");
  });
});

describe("resolveUsdaStatus", () => {
  it("valor presente → known_* (asunción de base 100g para Foundation/SR Legacy)", () => {
    expect(resolveUsdaStatus(31.02)).toBe("known_nonzero");
  });

  it("ausente → unknown", () => {
    expect(resolveUsdaStatus(undefined)).toBe("unknown");
  });

  it("explícitamente 0 → known_zero, no ausencia", () => {
    expect(resolveUsdaStatus(0)).toBe("known_zero");
  });
});

describe("legacyOrUnknown — reconstrucción al cargar datos previos a esta entrega", () => {
  it("un status guardado explícito se respeta tal cual, sea el que sea", () => {
    expect(legacyOrUnknown("known_nonzero", 50)).toBe("known_nonzero");
    expect(legacyOrUnknown("estimated", 50)).toBe("estimated");
  });

  it("sin status guardado pero con número presente → legacy_unlabeled, nunca known_*", () => {
    expect(legacyOrUnknown(undefined, 50)).toBe("legacy_unlabeled");
  });

  it("sin status guardado y un cero presente → también legacy_unlabeled, no known_zero", () => {
    expect(legacyOrUnknown(undefined, 0)).toBe("legacy_unlabeled");
  });

  it("ni status ni número presentes → unknown", () => {
    expect(legacyOrUnknown(undefined, undefined)).toBe("unknown");
  });
});

describe("extractDeclaredState — léxico fijo, sin clasificador semántico", () => {
  it("detecta crudo/raw", () => {
    expect(extractDeclaredState("Pechuga de pollo cruda")).toBe("raw");
    expect(extractDeclaredState("Raw chicken breast")).toBe("raw");
  });

  it("detecta cocido/cooked en sus variantes", () => {
    expect(extractDeclaredState("Arroz cocido")).toBe("cooked");
    expect(extractDeclaredState("Pollo asado")).toBe("cooked");
    expect(extractDeclaredState("Grilled salmon")).toBe("cooked");
  });

  it("detecta seco/instantáneo antes que cualquier coincidencia casual con cocido", () => {
    expect(extractDeclaredState("Puré de patata instantáneo")).toBe("dry");
    expect(extractDeclaredState("Leche en polvo")).toBe("dry");
  });

  it("detecta reconstituido/hidratado", () => {
    expect(extractDeclaredState("Leche reconstituida")).toBe("reconstituted");
  });

  it("detecta escurrido/drained", () => {
    expect(extractDeclaredState("Atún escurrido")).toBe("drained");
  });

  it("sin ninguna palabra del léxico devuelve unspecified", () => {
    expect(extractDeclaredState("Manzana")).toBe("unspecified");
    expect(extractDeclaredState("Coca-Cola lata 330ml")).toBe("unspecified");
  });

  it("es insensible a mayúsculas", () => {
    expect(extractDeclaredState("POLLO CRUDO")).toBe("raw");
  });

  it("no lee 'raw' dentro de 'strawberry' — coincidencia de palabra completa, no subcadena", () => {
    expect(extractDeclaredState("strawberry")).toBe("unspecified");
    expect(extractDeclaredState("Mermelada de strawberry")).toBe("unspecified");
  });

  it("declaración inequívoca de 'raw'", () => {
    expect(extractDeclaredState("Pollo crudo")).toBe("raw");
  });

  it("declaración inequívoca de 'cocido'", () => {
    expect(extractDeclaredState("Arroz cocido")).toBe("cooked");
  });

  it("un texto que declara a la vez estado seco Y preparado es ambiguous, no elige uno por orden de comprobación", () => {
    expect(extractDeclaredState("Sopa deshidratada, lista para preparar")).toBe("ambiguous");
    expect(extractDeclaredState("Leche en polvo reconstituida")).toBe("ambiguous");
  });

  it("declarar crudo y cocido a la vez también es ambiguous", () => {
    expect(extractDeclaredState("pollo crudo o cocido, a elegir")).toBe("ambiguous");
  });
});

describe("resolveFoodStateConfidenceForGenericMatch — búsqueda por texto", () => {
  it("ambos lados declaran el mismo estado → confirmed", () => {
    expect(resolveFoodStateConfidenceForGenericMatch("pollo crudo", "Pechuga de pollo cruda")).toBe("confirmed");
  });

  it("estados declarados distintos → incompatible, aunque el nutriente sea known_*", () => {
    expect(resolveFoodStateConfidenceForGenericMatch("pollo crudo", "Pollo cocido")).toBe("incompatible");
  });

  it("la búsqueda no declara estado → unknown (caso mayoritario)", () => {
    expect(resolveFoodStateConfidenceForGenericMatch("pollo", "Pechuga de pollo cruda")).toBe("unknown");
  });

  it("la referencia no declara estado → unknown", () => {
    expect(resolveFoodStateConfidenceForGenericMatch("pollo crudo", "Pollo")).toBe("unknown");
  });

  it("ninguno de los dos declara estado → unknown", () => {
    expect(resolveFoodStateConfidenceForGenericMatch("manzana", "Manzana Golden")).toBe("unknown");
  });

  it("un lado ambiguo (varios estados en conflicto) → unknown, nunca confirmed ni incompatible", () => {
    expect(resolveFoodStateConfidenceForGenericMatch("pollo crudo", "Sopa deshidratada para preparar")).toBe("unknown");
  });
});

describe("offHasSeparatePreparedBasis", () => {
  it("detecta una base preparada separada cuando existe cualquier campo *_prepared_100g", () => {
    expect(offHasSeparatePreparedBasis({ "energy-kcal_100g": 100, "energy-kcal_prepared_100g": 350 })).toBe(true);
  });

  it("sin ningún campo *_prepared_100g → false", () => {
    expect(offHasSeparatePreparedBasis({ "energy-kcal_100g": 100, proteins_100g: 5 })).toBe(false);
  });

  it("nutriments ausente → false", () => {
    expect(offHasSeparatePreparedBasis(undefined)).toBe(false);
    expect(offHasSeparatePreparedBasis(null)).toBe(false);
  });
});

describe("resolveFoodStateConfidenceForProduct — código de barras / producto (corrección tras revisión)", () => {
  it("un producto escaneado sin campos preparados ni estado declarado NO puede quedar not_applicable — la ausencia de indicios no es prueba de nada", () => {
    expect(resolveFoodStateConfidenceForProduct()).toBe("unknown");
  });

  it("nunca produce not_applicable con las señales disponibles hoy, para ningún caso", () => {
    // El valor de un producto escaneado siempre es una referencia por 100g
    // (ver el comentario de la función) — not_applicable exigiría una señal
    // estructural verificable que ningún sitio de captura actual extrae.
    expect(resolveFoodStateConfidenceForProduct()).not.toBe("not_applicable");
  });
});

describe("resolveFoodStateConfidenceForDirectEntry — entrada manual/IA directa", () => {
  it("total de ingesta ya consumida → siempre not_applicable, nunca por ser código de barras o manual", () => {
    expect(resolveFoodStateConfidenceForDirectEntry("whole_intake_total")).toBe("not_applicable");
    expect(resolveFoodStateConfidenceForDirectEntry("whole_intake_total", "Cualquier nombre")).toBe("not_applicable");
  });

  it("referencia por 100g con nombre que declara estado → confirmed (débil, un solo lado)", () => {
    expect(resolveFoodStateConfidenceForDirectEntry("per_unit_reference", "Arroz cocido")).toBe("confirmed");
  });

  it("referencia por 100g sin estado declarado en el nombre → unknown", () => {
    expect(resolveFoodStateConfidenceForDirectEntry("per_unit_reference", "Arroz")).toBe("unknown");
  });

  it("referencia por 100g sin nombre → unknown", () => {
    expect(resolveFoodStateConfidenceForDirectEntry("per_unit_reference")).toBe("unknown");
  });

  it("referencia por 100g con nombre ambiguo (varios estados en conflicto) → unknown, nunca confirmed", () => {
    expect(resolveFoodStateConfidenceForDirectEntry("per_unit_reference", "Sopa deshidratada para preparar")).toBe("unknown");
  });
});
