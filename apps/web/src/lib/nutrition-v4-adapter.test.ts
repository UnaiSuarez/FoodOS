import { describe, expect, it } from "vitest";
import type { DailyIntegrityWindowInput, FoodLogEntry, NutrientValue } from "@foodos/types";
import { buildDiaryIntegrityInput } from "./nutrition-v4-adapter";
import { recipeTotalProvenance, sanitizeFoodLogProvenance } from "./food-log-provenance";

// Ningún import del paquete de kernels puros en este archivo — a
// propósito. Ver la nota de cabecera de nutrition-v4-adapter.ts: apps/web
// no cruza esa frontera en PR2, y la propia suite de ese paquete falla si
// algún archivo de apps/web/src lo menciona por nombre o por ruta
// (comentarios incluidos — por eso este archivo tampoco escribe esas dos
// cadenas literales). Estos tests inspeccionan el DailyIntegrityWindowInput
// CONSTRUIDO, nunca un resultado evaluado.

// ─── Fixtures ─────────────────────────────────────────────────────────────

function addDays(dateKey: string, days: number): string {
  const date = new Date(Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10))));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

let seq = 0;
function logEntry(overrides: Partial<FoodLogEntry> = {}): FoodLogEntry {
  seq += 1;
  return {
    id: `entry-${seq}`,
    date: "2026-01-03",
    time: "13:00",
    name: "Pollo con arroz",
    qty: 300,
    unit: "g",
    kcal: 500,
    protein: 40,
    carbs: 50,
    fat: 15,
    source: "manual",
    mealType: "lunch",
    ...overrides,
  };
}

const WINDOW = { startDateKey: "2026-01-01", endDateKey: "2026-01-07" };
const THRESHOLDS = { dailyReliabilityThreshold: 0.8, provisionalKcalFractionThreshold: 0.25 };

function entriesFor(input: DailyIntegrityWindowInput, dateKey: string) {
  return input.entries.filter((e) => e.dateKey === dateKey);
}

// ─── Ventana y umbrales se transportan sin tocarlos ────────────────────────

describe("la ventana y los umbrales se transportan tal cual, nunca los fija ni los recorta el adaptador", () => {
  it("startDateKey/endDateKey del resultado son EXACTAMENTE los recibidos, con o sin entradas", () => {
    const input = buildDiaryIntegrityInput([], WINDOW, THRESHOLDS);
    expect(input.startDateKey).toBe(WINDOW.startDateKey);
    expect(input.endDateKey).toBe(WINDOW.endDateKey);
  });

  it("una ventana de 28 días se transporta igual, aunque no haya ninguna entrada dentro", () => {
    const window28 = { startDateKey: "2026-01-01", endDateKey: addDays("2026-01-01", 27) };
    const input = buildDiaryIntegrityInput([logEntry({ date: "2099-01-01" })], window28, THRESHOLDS);
    expect(input.startDateKey).toBe(window28.startDateKey);
    expect(input.endDateKey).toBe(window28.endDateKey);
    // El adaptador no filtra por fecha — eso es responsabilidad del
    // kernel (fase 3 de su validación, ya probada en PR1). Una entrada
    // fuera de la ventana sigue apareciendo en `entries`; es el futuro
    // llamador del kernel quien se beneficia de que el kernel la descarte,
    // no este adaptador quien debe adelantarse a hacerlo.
    expect(input.entries).toHaveLength(1);
  });

  it("los dos umbrales son EXACTAMENTE los recibidos del llamador, nunca un valor fijado aquí", () => {
    for (const thresholds of [
      { dailyReliabilityThreshold: 0, provisionalKcalFractionThreshold: 0 },
      { dailyReliabilityThreshold: 1, provisionalKcalFractionThreshold: 1 },
      { dailyReliabilityThreshold: 0.37, provisionalKcalFractionThreshold: 0.91 },
    ]) {
      const input = buildDiaryIntegrityInput([], WINDOW, thresholds);
      expect(input.dailyReliabilityThreshold).toBe(thresholds.dailyReliabilityThreshold);
      expect(input.provisionalKcalFractionThreshold).toBe(thresholds.provisionalKcalFractionThreshold);
    }
  });
});

// ─── Regla 1 del encargo: ausencia de etiqueta → legacy_unlabeled, nunca known_* ─

describe("una entrada real de hoy (sin metadatos de PR3a/PR3) se traduce SIEMPRE a legacy_unlabeled, incluido un cero guardado", () => {
  it("kcal/protein/carbs/fat quedan legacy_unlabeled con su valor real, incluido 0", () => {
    const input = buildDiaryIntegrityInput(
      [logEntry({ date: "2026-01-03", kcal: 0, protein: 40, carbs: 50, fat: 0 })],
      WINDOW,
      THRESHOLDS,
    );
    const [entry] = entriesFor(input, "2026-01-03");
    const expected: Record<"kcal" | "protein" | "carbs" | "fat", NutrientValue> = {
      kcal: { status: "legacy_unlabeled", value: 0 },
      protein: { status: "legacy_unlabeled", value: 40 },
      carbs: { status: "legacy_unlabeled", value: 50 },
      fat: { status: "legacy_unlabeled", value: 0 },
    };
    expect(entry.nutrients).toEqual(expected);
  });

  it("un valor positivo grande tampoco se convierte en known_nonzero", () => {
    const input = buildDiaryIntegrityInput([logEntry({ date: "2026-01-03", kcal: 2400 })], WINDOW, THRESHOLDS);
    expect(entriesFor(input, "2026-01-03")[0].nutrients.kcal).toEqual({ status: "legacy_unlabeled", value: 2400 });
  });

  it("fiber/sugars/salt, que FoodLogEntry no guarda hoy, quedan AUSENTES de nutrients — nunca inventados como unknown explícito ni como ningún otro valor", () => {
    const input = buildDiaryIntegrityInput([logEntry({ date: "2026-01-03" })], WINDOW, THRESHOLDS);
    const nutrients = entriesFor(input, "2026-01-03")[0].nutrients;
    expect(Object.keys(nutrients).sort()).toEqual(["carbs", "fat", "kcal", "protein"]);
    expect("fiber" in nutrients).toBe(false);
    expect("sugars" in nutrients).toBe(false);
    expect("salt" in nutrients).toBe(false);
  });
});

// ─── Regla 2 del encargo: quantityConfidence/foodStateConfidence sin elevar por inferencia ─

describe("quantityConfidence y foodStateConfidence nunca se elevan por inferencia, para ningún source", () => {
  it.each(["manual", "recipe", "inventory"] as const)("source=%s produce quantityConfidence:low y foodStateConfidence:unknown", (source) => {
    const input = buildDiaryIntegrityInput([logEntry({ date: "2026-01-03", source })], WINDOW, THRESHOLDS);
    const entry = entriesFor(input, "2026-01-03")[0];
    expect(entry.quantityConfidence).toBe("low");
    expect(entry.foodStateConfidence).toBe("unknown");
  });

  it("energyConsistency es siempre not_evaluable — no existe hoy ningún cálculo real que leer", () => {
    const input = buildDiaryIntegrityInput([logEntry({ date: "2026-01-03" })], WINDOW, THRESHOLDS);
    expect(entriesFor(input, "2026-01-03")[0].energyConsistency).toBe("not_evaluable");
  });
});

// ─── Regla 3 del encargo: synthetic:true se filtra, fechas de ventana intactas ─

describe("synthetic:true se filtra antes de construir la entrada del kernel, sin tocar startDateKey/endDateKey", () => {
  it("una entrada synthetic:true no aparece en absoluto en entries", () => {
    const synthetic = { ...logEntry({ date: "2026-01-03" }), synthetic: true } as FoodLogEntry;
    const input = buildDiaryIntegrityInput([synthetic], WINDOW, THRESHOLDS);
    expect(input.entries).toHaveLength(0);
    // La ventana sigue siendo la solicitada — filtrar entradas no la toca.
    expect(input.startDateKey).toBe(WINDOW.startDateKey);
    expect(input.endDateKey).toBe(WINDOW.endDateKey);
  });

  it("un día con una entrada real y otra sintética conserva SOLO la real", () => {
    const real = logEntry({ date: "2026-01-03", kcal: 500 });
    const synthetic = { ...logEntry({ date: "2026-01-03", kcal: 9999 }), synthetic: true } as FoodLogEntry;
    const input = buildDiaryIntegrityInput([real, synthetic], WINDOW, THRESHOLDS);
    const dayEntries = entriesFor(input, "2026-01-03");
    expect(dayEntries).toHaveLength(1);
    expect(dayEntries[0].nutrients.kcal).toEqual({ status: "legacy_unlabeled", value: 500 });
  });

  it("synthetic con cualquier valor distinto de true (undefined, false, 1, 'true' como string) NO se filtra", () => {
    for (const value of [undefined, false, 1, "true"]) {
      const entry = { ...logEntry({ date: "2026-01-03" }), synthetic: value } as FoodLogEntry;
      const input = buildDiaryIntegrityInput([entry], WINDOW, THRESHOLDS);
      expect(input.entries).toHaveLength(1);
    }
  });
});

// ─── Regla 4 del encargo: entradas mixtas se conservan, ninguna se elimina por su contenido ─

describe("el adaptador nunca elimina una entrada por su contenido — el veto de PR1 (kcal no ponderable) debe poder actuar cuando el kernel se conecte", () => {
  it("un día con dos entradas de valores muy distintos (incluida kcal 0) conserva AMBAS, sin filtrar ninguna por parecer poco fiable", () => {
    const bigMeal = logEntry({ date: "2026-01-03", kcal: 900 });
    const zeroMeal = logEntry({ date: "2026-01-03", kcal: 0, protein: 0, carbs: 0, fat: 0 });
    const input = buildDiaryIntegrityInput([bigMeal, zeroMeal], WINDOW, THRESHOLDS);
    expect(entriesFor(input, "2026-01-03")).toHaveLength(2);
  });

  it("todas las entradas de la ventana llegan al resultado — el adaptador no pre-juzga cuál será 'fiable'", () => {
    const entries = Array.from({ length: 5 }, (_, i) => logEntry({ date: "2026-01-03", kcal: i * 100 }));
    const input = buildDiaryIntegrityInput(entries, WINDOW, THRESHOLDS);
    expect(input.entries).toHaveLength(5);
  });
});

// ─── El adaptador no muta kcal ni macros históricos ────────────────────────

describe("el adaptador no modifica las kcal ni los macros históricos almacenados", () => {
  it("las entradas de entrada no se mutan, ni siquiera sus objetos anidados", () => {
    const entries = [logEntry({ date: "2026-01-03" }), logEntry({ date: "2026-01-04" })];
    const snapshot = JSON.parse(JSON.stringify(entries));
    buildDiaryIntegrityInput(entries, WINDOW, THRESHOLDS);
    expect(entries).toEqual(snapshot);
  });

  it("dos llamadas con el mismo input dan resultados profundamente iguales (determinismo)", () => {
    const entries = [logEntry({ date: "2026-01-03" })];
    expect(buildDiaryIntegrityInput(entries, WINDOW, THRESHOLDS)).toEqual(buildDiaryIntegrityInput(entries, WINDOW, THRESHOLDS));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PR4 — lectura fiel de la procedencia REALMENTE guardada (PR3), reconciliada
// con el número antes de traducirla. Los bloques de arriba (fixtures sin
// nutrientStatus) siguen pasando sin cambios: son la prueba de que el
// histórico anterior al etiquetado no mejora solo por leerlo de nuevo.
// ═══════════════════════════════════════════════════════════════════════════

function nutrients(entry: FoodLogEntry) {
  const input = buildDiaryIntegrityInput([entry], WINDOW, THRESHOLDS);
  return entriesFor(input, entry.date)[0];
}

// ─── Un estado guardado y coherente con su número se conserva tal cual ────

describe("PR4 — un nutrientStatus guardado y coherente con su número se traduce tal cual, nunca degradado", () => {
  it("known_zero con un 0 real se mantiene known_zero — se distingue de un 0 sin ninguna etiqueta (legacy_unlabeled)", () => {
    const declared = logEntry({ date: "2026-01-03", kcal: 0, nutrientStatus: { kcal: "known_zero" } });
    const absent = logEntry({ date: "2026-01-03", kcal: 0 });
    expect(nutrients(declared).nutrients.kcal).toEqual({ status: "known_zero", value: 0 });
    expect(nutrients(absent).nutrients.kcal).toEqual({ status: "legacy_unlabeled", value: 0 });
  });

  it("known_nonzero con un positivo real se mantiene known_nonzero", () => {
    const entry = logEntry({ date: "2026-01-03", protein: 42, nutrientStatus: { protein: "known_nonzero" } });
    expect(nutrients(entry).nutrients.protein).toEqual({ status: "known_nonzero", value: 42 });
  });

  it("estimated/recipe_derived/imputed pasan tal cual, sin restricción numérica que comprobar", () => {
    for (const status of ["estimated", "recipe_derived", "imputed"] as const) {
      const entry = logEntry({ date: "2026-01-03", carbs: 30, nutrientStatus: { carbs: status } });
      expect(nutrients(entry).nutrients.carbs).toEqual({ status, value: 30 });
    }
  });

  it("un nutrientStatus solo parcial (p. ej. solo kcal) deja el resto de macros como si estuviera ausente (legacy_unlabeled)", () => {
    const entry = logEntry({ date: "2026-01-03", kcal: 500, protein: 40, nutrientStatus: { kcal: "known_nonzero" } });
    const result = nutrients(entry).nutrients;
    expect(result.kcal).toEqual({ status: "known_nonzero", value: 500 });
    expect(result.protein).toEqual({ status: "legacy_unlabeled", value: 40 });
  });
});

// ─── Contradicción entre estado y número: degrada a estimated, nunca se descarta ni se mantiene la certeza falsa ─

describe("PR4 — contradicción entre nutrientStatus y el número guardado degrada a estimated (nunca se descarta la entrada ni se conserva known_*)", () => {
  it("known_zero con un número distinto de 0 (declarado 0, guardado no-0) pasa a estimated", () => {
    const entry = logEntry({ date: "2026-01-03", kcal: 120, nutrientStatus: { kcal: "known_zero" } });
    expect(nutrients(entry).nutrients.kcal).toEqual({ status: "estimated", value: 120 });
  });

  it("known_nonzero con un número exactamente 0 pasa a estimated", () => {
    const entry = logEntry({ date: "2026-01-03", protein: 0, nutrientStatus: { protein: "known_nonzero" } });
    expect(nutrients(entry).nutrients.protein).toEqual({ status: "estimated", value: 0 });
  });

});

// ─── Un número negativo no es válido bajo NINGÚN estado (isValidNutrientValue del kernel exige raw>=0 salvo unknown, que exige null) ─

describe("PR4 — un número negativo (defensivo) se traduce a unknown/null bajo cualquier estado — ninguna variante de NutrientValue admite un valor negativo", () => {
  it("known_nonzero con un número negativo NO pasa a estimated (estimated exige raw>=0): pasa a unknown/null", () => {
    const entry = { ...logEntry({ date: "2026-01-03", nutrientStatus: { fat: "known_nonzero" } }), fat: -5 } as FoodLogEntry;
    expect(nutrients(entry).nutrients.fat).toEqual({ status: "unknown", value: null });
  });

  it("un macro sin nutrientStatus (legacy_unlabeled por ausencia) con un número negativo tampoco expone ese negativo: legacy_unlabeled también exige raw>=0", () => {
    const entry = logEntry({ date: "2026-01-03", protein: -3 });
    expect(nutrients(entry).nutrients.protein).toEqual({ status: "unknown", value: null });
  });

  it("una kcal negativa no hace desaparecer la entrada del día: sigue no ponderable (unknown), nunca oculta ni descartada", () => {
    const negative = logEntry({ date: "2026-01-03", kcal: -50 });
    const normal = logEntry({ date: "2026-01-03", kcal: 600, nutrientStatus: { kcal: "known_nonzero" } });
    const input = buildDiaryIntegrityInput([negative, normal], WINDOW, THRESHOLDS);
    const day = entriesFor(input, "2026-01-03");
    expect(day).toHaveLength(2);
    expect(day.map((e) => e.nutrients.kcal)).toEqual(
      expect.arrayContaining([{ status: "unknown", value: null }, { status: "known_nonzero", value: 600 }]),
    );
  });
});

// ─── unknown produce siempre value:null, con independencia de cualquier resto numérico ─

describe("PR4 — nutrientStatus: 'unknown' produce siempre value:null, incluso con un número guardado presente", () => {
  it("un macro marcado unknown con un número real guardado (posible tras una sincronización parcial) no expone ese número", () => {
    const entry = logEntry({ date: "2026-01-03", kcal: 500, nutrientStatus: { kcal: "unknown" } });
    expect(nutrients(entry).nutrients.kcal).toEqual({ status: "unknown", value: null });
  });

  it("kcal no ponderable (unknown) no se oculta ni se sustituye: el kernel debe poder verla para marcar el día provisional cuando se conecte", () => {
    const unweighable = logEntry({ date: "2026-01-03", kcal: 500, nutrientStatus: { kcal: "unknown" } });
    const normal = logEntry({ date: "2026-01-03", kcal: 600, nutrientStatus: { kcal: "known_nonzero" } });
    const input = buildDiaryIntegrityInput([unweighable, normal], WINDOW, THRESHOLDS);
    const day = entriesFor(input, "2026-01-03");
    expect(day).toHaveLength(2);
    expect(day.map((e) => e.nutrients.kcal)).toEqual(
      expect.arrayContaining([{ status: "unknown", value: null }, { status: "known_nonzero", value: 600 }]),
    );
  });
});

// ─── Un número no finito no es un dato utilizable bajo ningún estado ──────

describe("PR4 — un número no finito (defensivo) se trata como si no existiera, cualquiera que sea el estado declarado", () => {
  it("NaN bajo known_nonzero se traduce a unknown/null, no a estimated ni a known_nonzero", () => {
    const entry = { ...logEntry({ date: "2026-01-03", nutrientStatus: { kcal: "known_nonzero" } }), kcal: NaN } as FoodLogEntry;
    expect(nutrients(entry).nutrients.kcal).toEqual({ status: "unknown", value: null });
  });
});

// ─── quantityConfidence/foodStateConfidence: solo lo que el dato guardado permite justificar ─

describe("PR4 — quantityConfidence y foodStateConfidence se propagan con lo que el dato guardado permite justificar, nunca menos ni más", () => {
  it("§20.7B — 'high' SIN declaredGrams (evidencia ausente) degrada a 'low', nunca se propaga a ciegas", () => {
    const entry = logEntry({ date: "2026-01-03", quantityConfidence: { level: "high" } });
    expect(nutrients(entry).quantityConfidence).toBe("low");
  });

  it("§20.7B — 'high' con declaredGrams coherente con qty/unit (g) sí se propaga como 'high'", () => {
    const entry = logEntry({ date: "2026-01-03", qty: 300, unit: "g", quantityConfidence: { level: "high", declaredGrams: 300 } });
    expect(nutrients(entry).quantityConfidence).toBe("high");
  });

  it("quantityConfidence.level 'low' con un motivo se propaga como 'low' — el motivo no forma parte del contrato del kernel", () => {
    const entry = logEntry({ date: "2026-01-03", quantityConfidence: { level: "low", reason: "missing_unit_size" } });
    expect(nutrients(entry).quantityConfidence).toBe("low");
  });

  it.each(["confirmed", "incompatible", "not_applicable"] as const)("foodStateConfidence '%s' guardado se propaga tal cual", (foodStateConfidence) => {
    const entry = logEntry({ date: "2026-01-03", foodStateConfidence });
    expect(nutrients(entry).foodStateConfidence).toBe(foodStateConfidence);
  });
});

// ─── §20.7B — relectura defensiva de 'high': degrada ante evidencia inválida o incoherente, nunca descarta la entrada ─

describe("§20.7B — 'high' degrada a 'low' ante declaredGrams/qty/unit inválidos o incoherentes, sin descartar nunca la entrada", () => {
  it("declaredGrams coherente con qty/unit 'kg' (misma magnitud, distinta unidad) sigue siendo 'high'", () => {
    const entry = logEntry({ date: "2026-01-03", qty: 0.2, unit: "kg", quantityConfidence: { level: "high", declaredGrams: 200 } });
    expect(nutrients(entry).quantityConfidence).toBe("high");
  });

  it("declaredGrams incoherente con qty/unit (edición posterior, p. ej. EditLogModal, sin limpiar la declaración) degrada a 'low'", () => {
    const entry = logEntry({ date: "2026-01-03", qty: 150, unit: "g", quantityConfidence: { level: "high", declaredGrams: 300 } });
    expect(nutrients(entry).quantityConfidence).toBe("low");
  });

  it("declaredGrams=0 degrada a 'low'", () => {
    const entry = logEntry({ date: "2026-01-03", qty: 300, unit: "g", quantityConfidence: { level: "high", declaredGrams: 0 } });
    expect(nutrients(entry).quantityConfidence).toBe("low");
  });

  it("declaredGrams negativo degrada a 'low'", () => {
    const entry = logEntry({ date: "2026-01-03", qty: 300, unit: "g", quantityConfidence: { level: "high", declaredGrams: -300 } });
    expect(nutrients(entry).quantityConfidence).toBe("low");
  });

  it("declaredGrams no finito (NaN/Infinity, defensivo) degrada a 'low'", () => {
    for (const bad of [NaN, Infinity]) {
      const entry = { ...logEntry({ date: "2026-01-03", qty: 300, unit: "g" }), quantityConfidence: { level: "high" as const, declaredGrams: bad } };
      expect(nutrients(entry).quantityConfidence).toBe("low");
    }
  });

  it("unidad no admitida ('ud'/'ml'/ausente) degrada a 'low', aunque declaredGrams sea coherente en apariencia", () => {
    for (const unit of ["ud", "ml", null] as const) {
      const entry = logEntry({ date: "2026-01-03", qty: 300, unit, quantityConfidence: { level: "high", declaredGrams: 300 } });
      expect(nutrients(entry).quantityConfidence).toBe("low");
    }
  });

  it("qty final inválido (0, negativo, null) degrada a 'low'", () => {
    for (const qty of [0, -50, null] as const) {
      const entry = logEntry({ date: "2026-01-03", qty, unit: "g", quantityConfidence: { level: "high", declaredGrams: 300 } });
      expect(nutrients(entry).quantityConfidence).toBe("low");
    }
  });

  it("una discrepancia de ruido de coma flotante (0,01 g) NO se rechaza — comparación con precisión explícita, no exacta", () => {
    // 0.233 kg * 1000 puede dar 233.00000000000003 en JS — no debe rechazar
    // un caso perfectamente coherente por representación binaria.
    const entry = logEntry({ date: "2026-01-03", qty: 0.233, unit: "kg", quantityConfidence: { level: "high", declaredGrams: 233 } });
    expect(nutrients(entry).quantityConfidence).toBe("high");
  });

  it("una discrepancia real de varios gramos SÍ se rechaza, aunque sea pequeña en términos relativos", () => {
    const entry = logEntry({ date: "2026-01-03", qty: 0.23, unit: "kg", quantityConfidence: { level: "high", declaredGrams: 233 } });
    expect(nutrients(entry).quantityConfidence).toBe("low");
  });

  it("la entrada NUNCA se descarta por un 'high' inválido — solo pierde la etiqueta, el resto de la entrada se traduce con normalidad", () => {
    const entry = logEntry({ date: "2026-01-03", qty: 300, unit: "g", kcal: 500, nutrientStatus: { kcal: "known_nonzero" }, quantityConfidence: { level: "high", declaredGrams: 999 } });
    const result = nutrients(entry);
    expect(result.quantityConfidence).toBe("low");
    expect(result.nutrients.kcal).toEqual({ status: "known_nonzero", value: 500 });
  });
});

// ─── qtyOverrides ignorados: la baja confianza de cantidad llega al kernel ─

describe("PR4 — qtyOverrides ignorados en una receta cocinada: el adaptador lee la quantityConfidence:low que food-log-provenance.ts decidió al escribir", () => {
  it("una entrada construida con recipeTotalProvenance({ qtyOverridesIgnored: true }) llega al kernel con quantityConfidence:low", () => {
    const provenance = recipeTotalProvenance({ qtyOverridesIgnored: true });
    const entry = logEntry({ date: "2026-01-03", ...provenance });
    const result = nutrients(entry);
    expect(result.quantityConfidence).toBe("low");
    // Los cuatro macros de un total de receta son legacy_unlabeled (AC28: no
    // se deriva la certeza del total a partir de sus ingredientes).
    expect(result.nutrients).toEqual({
      kcal: { status: "legacy_unlabeled", value: entry.kcal },
      protein: { status: "legacy_unlabeled", value: entry.protein },
      carbs: { status: "legacy_unlabeled", value: entry.carbs },
      fat: { status: "legacy_unlabeled", value: entry.fat },
    });
  });

  it("una entrada de receta SIN overrides ignorados (recipeTotalProvenance({ qtyOverridesIgnored: false })) no lleva quantityConfidence — se lee como low por ausencia", () => {
    const provenance = recipeTotalProvenance({ qtyOverridesIgnored: false });
    expect(provenance.quantityConfidence).toBeUndefined();
    const entry = logEntry({ date: "2026-01-03", ...provenance });
    expect(nutrients(entry).quantityConfidence).toBe("low");
  });
});

// ─── Metadatos perdidos o malformados al sincronizar degradan de forma segura ─

describe("PR4 — metadatos perdidos o malformados en la sincronización (client_meta) degradan de forma segura, nunca a known_*", () => {
  it("un client_meta completamente ajeno (sin ninguno de los tres campos) sanea a 'ausente' y el adaptador lo lee como legacy_unlabeled/low/unknown", () => {
    const garbage = { foo: "bar", nutrientStatus: "no-es-un-objeto", quantityConfidence: 42, foodStateConfidence: "inventado" };
    const provenance = sanitizeFoodLogProvenance(garbage);
    expect(provenance).toEqual({});
    const entry = logEntry({ date: "2026-01-03", kcal: 300, ...provenance });
    const result = nutrients(entry);
    expect(result.nutrients.kcal).toEqual({ status: "legacy_unlabeled", value: 300 });
    expect(result.quantityConfidence).toBe("low");
    expect(result.foodStateConfidence).toBe("unknown");
  });

  it("un client_meta con un nutrientStatus parcialmente válido (una clave con un estado real, una clave con basura) conserva solo la válida", () => {
    const garbage = { nutrientStatus: { kcal: "known_nonzero", protein: "no-es-un-estado", fat: 99 } };
    const provenance = sanitizeFoodLogProvenance(garbage);
    expect(provenance.nutrientStatus).toEqual({ kcal: "known_nonzero" });
    const entry = logEntry({ date: "2026-01-03", kcal: 400, protein: 40, ...provenance });
    const result = nutrients(entry);
    expect(result.nutrients.kcal).toEqual({ status: "known_nonzero", value: 400 });
    // protein no sobrevivió al saneado: ausente ⇒ legacy_unlabeled, igual que si nunca se hubiera guardado.
    expect(result.nutrients.protein).toEqual({ status: "legacy_unlabeled", value: 40 });
  });

  it("un nutrientStatus saneado pero contradictorio con el número guardado (p. ej. tras editar el número sin volver a sincronizar el estado) degrada a estimated, no se descarta", () => {
    const garbage = { nutrientStatus: { kcal: "known_zero" } };
    const provenance = sanitizeFoodLogProvenance(garbage);
    const entry = logEntry({ date: "2026-01-03", kcal: 250, ...provenance });
    expect(nutrients(entry).nutrients.kcal).toEqual({ status: "estimated", value: 250 });
  });
});

// ─── Metadatos LOCALES inválidos en tiempo de ejecución, sin pasar por sanitizeFoodLogProvenance ─
//
// pullState() sanea la procedencia remota (data-layer.ts llama a
// sanitizeFoodLogProvenance antes de construir cada FoodLogEntry), pero
// loadLocalState() (state.tsx → data-layer.ts) hace un JSON.parse crudo de
// localStorage y normalizeState() no vuelve a sanear los campos de
// procedencia de foodLog — solo migra forma (mealType, consumedMeals). Una
// entrada con un nutrientStatus/foodStateConfidence técnicamente inválido en
// tiempo de ejecución (el tipo de FoodLogEntry lo prohíbe, pero nada lo
// impide una vez los datos cruzan JSON.parse) puede llegar así, directa, al
// adaptador — nunca a través del saneador. El adaptador no debe asumir que
// su entrada ya es válida solo porque el tipo lo declare.

describe("PR4 — metadatos LOCALES inválidos en tiempo de ejecución (sin pasar por sanitizeFoodLogProvenance) degradan igual de conservador", () => {
  it("nutrientStatus con un string que no es un NutrientStatus válido produce legacy_unlabeled para ese macro, no se propaga tal cual", () => {
    const entry = {
      ...logEntry({ date: "2026-01-03", kcal: 500 }),
      nutrientStatus: { kcal: "medido_mas_o_menos" },
    } as unknown as FoodLogEntry;
    expect(nutrients(entry).nutrients.kcal).toEqual({ status: "legacy_unlabeled", value: 500 });
  });

  it("nutrientStatus que no es ni siquiera un objeto (p. ej. un string suelto) se trata como ausente en los cuatro macros", () => {
    const entry = { ...logEntry({ date: "2026-01-03" }), nutrientStatus: "known_nonzero" } as unknown as FoodLogEntry;
    const result = nutrients(entry).nutrients;
    for (const key of ["kcal", "protein", "carbs", "fat"] as const) {
      expect(result[key]?.status).toBe("legacy_unlabeled");
    }
  });

  it("foodStateConfidence con un valor fuera de las cuatro variantes válidas se lee como unknown, no se propaga tal cual", () => {
    const entry = { ...logEntry({ date: "2026-01-03" }), foodStateConfidence: "probablemente" } as unknown as FoodLogEntry;
    expect(nutrients(entry).foodStateConfidence).toBe("unknown");
  });

  it("quantityConfidence con una forma inválida (nivel desconocido, o no es un objeto) se sigue leyendo como low, sin necesitar saneado previo", () => {
    const invalidLevel = { ...logEntry({ date: "2026-01-03" }), quantityConfidence: { level: "MEDIA" } } as unknown as FoodLogEntry;
    const notAnObject = { ...logEntry({ date: "2026-01-03" }), quantityConfidence: "high" } as unknown as FoodLogEntry;
    expect(nutrients(invalidLevel).quantityConfidence).toBe("low");
    expect(nutrients(notAnObject).quantityConfidence).toBe("low");
  });

  it("una entrada con los tres campos inválidos a la vez degrada los tres de forma independiente (legacy_unlabeled + unknown + low), sin descartar la entrada", () => {
    const entry = {
      ...logEntry({ date: "2026-01-03", kcal: 700, protein: 30 }),
      nutrientStatus: { kcal: "certisimo", protein: 12345 },
      foodStateConfidence: "seguramente",
      quantityConfidence: { level: "alta", reason: "porque_si" },
    } as unknown as FoodLogEntry;
    const result = nutrients(entry);
    expect(result.nutrients.kcal).toEqual({ status: "legacy_unlabeled", value: 700 });
    expect(result.nutrients.protein).toEqual({ status: "legacy_unlabeled", value: 30 });
    expect(result.foodStateConfidence).toBe("unknown");
    expect(result.quantityConfidence).toBe("low");
  });
});

// ─── Entrada sintética con procedencia "known_*": se filtra igualmente ────

describe("PR4 — una entrada sintética con nutrientStatus known_* (no debería ocurrir en producción, pero es defendible) se filtra igual que cualquier otra sintética", () => {
  it("no aparece en absoluto, aunque declare known_nonzero en sus cuatro macros", () => {
    const synthetic = {
      ...logEntry({ date: "2026-01-03", kcal: 9999, nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero" } }),
      synthetic: true,
    } as FoodLogEntry;
    const input = buildDiaryIntegrityInput([synthetic], WINDOW, THRESHOLDS);
    expect(input.entries).toHaveLength(0);
  });
});
