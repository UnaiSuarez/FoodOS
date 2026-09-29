import { describe, expect, it } from "vitest";
import type { DailyIntegrityWindowInput, FoodLogEntry, NutrientValue } from "@foodos/types";
import { buildDiaryIntegrityInput } from "./nutrition-v4-adapter";

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
