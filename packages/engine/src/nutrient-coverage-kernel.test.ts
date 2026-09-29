import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import type {
  DailyIntegrityEntry,
  DailyIntegrityEvaluated,
  DailyIntegrityInvalidInput,
  DailyIntegrityResult,
  DailyIntegrityWindowInput,
  FoodStateConfidence,
  NutrientKey,
  NutrientStatus,
  NutrientValue,
} from "@foodos/types";
import { evaluateNutrientCoverage } from "./nutrient-coverage-kernel";
import * as engineBarrel from "./index";

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Solo para construir fixtures (el kernel no usa Date): suma días vía UTC. */
function addDays(dateKey: string, days: number): string {
  const date = new Date(Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10))));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nv(status: NutrientStatus, value: number | null): NutrientValue {
  return { status, value };
}

function entry(
  dateKey: string,
  nutrients: Partial<Record<NutrientKey, NutrientValue>>,
  overrides: Partial<Omit<DailyIntegrityEntry, "dateKey" | "nutrients">> = {},
): DailyIntegrityEntry {
  return {
    dateKey,
    nutrients,
    quantityConfidence: "high",
    foodStateConfidence: "not_applicable",
    energyConsistency: "match",
    ...overrides,
  };
}

function windowInput(
  entries: readonly DailyIntegrityEntry[],
  overrides: Partial<DailyIntegrityWindowInput> = {},
): DailyIntegrityWindowInput {
  return {
    startDateKey: "2026-01-01",
    endDateKey: "2026-01-07",
    entries,
    dailyReliabilityThreshold: 0.8,
    provisionalKcalFractionThreshold: 0.25,
    ...overrides,
  };
}

function expectEvaluated(result: DailyIntegrityResult): DailyIntegrityEvaluated {
  if (result.status !== "evaluated") throw new Error(`esperado evaluated, recibido ${JSON.stringify(result)}`);
  return result;
}
function expectInvalid(result: DailyIntegrityResult): DailyIntegrityInvalidInput {
  if (result.status !== "invalid_input") throw new Error(`esperado invalid_input, recibido ${JSON.stringify(result)}`);
  return result;
}

function coverageOf(result: DailyIntegrityEvaluated, nutrient: NutrientKey) {
  const row = result.perNutrient.find((p) => p.nutrient === nutrient);
  if (!row) throw new Error(`sin fila de cobertura para ${nutrient}`);
  return row;
}

const ALL_NUTRIENTS: readonly NutrientKey[] = ["kcal", "protein", "carbs", "fat", "fiber", "sugars", "salt"];

// ─── Fase 1 — forma superior, ventana y umbrales ───────────────────────────

describe("fase 1 — forma superior, ventana y umbrales", () => {
  it("input que no es un objeto → input_object_invalid", () => {
    expect(expectInvalid(evaluateNutrientCoverage(null as never)).reasons).toEqual(["input_object_invalid"]);
    expect(expectInvalid(evaluateNutrientCoverage([1, 2] as never)).reasons).toEqual(["input_object_invalid"]);
  });

  it("startDateKey/endDateKey inválidos o invertidos", () => {
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([], { startDateKey: "2026-13-01" }))).reasons).toEqual([
      "start_date_key_invalid",
    ]);
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([], { endDateKey: "not-a-date" }))).reasons).toEqual([
      "end_date_key_invalid",
    ]);
    expect(
      expectInvalid(evaluateNutrientCoverage(windowInput([], { startDateKey: "2026-01-07", endDateKey: "2026-01-01" }))).reasons,
    ).toEqual(["date_window_order_invalid"]);
  });

  it("fecha con día inválido para su mes (incluye frontera bisiesta) se rechaza", () => {
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([], { startDateKey: "2026-02-30" }))).reasons).toEqual([
      "start_date_key_invalid",
    ]);
    // 2026 no es bisiesto: 29 de febrero no existe.
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([], { endDateKey: "2026-02-29" }))).reasons).toEqual([
      "end_date_key_invalid",
    ]);
  });

  it("umbrales fuera de [0,1] o no numéricos", () => {
    expect(
      expectInvalid(evaluateNutrientCoverage(windowInput([], { dailyReliabilityThreshold: 1.5 }))).reasons,
    ).toEqual(["daily_reliability_threshold_invalid"]);
    expect(
      expectInvalid(evaluateNutrientCoverage(windowInput([], { dailyReliabilityThreshold: -0.1 }))).reasons,
    ).toEqual(["daily_reliability_threshold_invalid"]);
    expect(
      expectInvalid(evaluateNutrientCoverage(windowInput([], { provisionalKcalFractionThreshold: Number.NaN }))).reasons,
    ).toEqual(["provisional_kcal_fraction_threshold_invalid"]);
    // Frontera inclusiva: 0 y 1 son válidos.
    expect(expectEvaluated(evaluateNutrientCoverage(windowInput([], { dailyReliabilityThreshold: 0 }))).status).toBe(
      "evaluated",
    );
    expect(expectEvaluated(evaluateNutrientCoverage(windowInput([], { dailyReliabilityThreshold: 1 }))).status).toBe(
      "evaluated",
    );
  });

  it("entries que no es un array", () => {
    expect(expectInvalid(evaluateNutrientCoverage(windowInput({} as never))).reasons).toEqual(["entries_not_array"]);
  });

  it("varias razones de fase 1 se acumulan y se devuelven en orden canónico, no de descubrimiento", () => {
    const result = expectInvalid(
      evaluateNutrientCoverage({
        startDateKey: "bad",
        endDateKey: "2026-01-01",
        entries: "not-an-array",
        dailyReliabilityThreshold: 2,
        provisionalKcalFractionThreshold: -1,
      } as never),
    );
    expect(result.reasons).toEqual([
      "start_date_key_invalid",
      "daily_reliability_threshold_invalid",
      "provisional_kcal_fraction_threshold_invalid",
      "entries_not_array",
    ]);
  });
});

// ─── Fase 2 — cada entrada es un objeto con dateKey real ───────────────────

describe("fase 2 — cada entrada es un objeto con dateKey real (invalida siempre)", () => {
  it("entrada que no es un objeto", () => {
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([42 as never]))).reasons).toEqual(["entry_object_invalid"]);
  });

  it("entrada con dateKey inválido", () => {
    expect(
      expectInvalid(evaluateNutrientCoverage(windowInput([entry("no-es-fecha", {})]))).reasons,
    ).toEqual(["entry_date_key_invalid"]);
  });
});

// ─── Fase 3 — selección por ventana ────────────────────────────────────────

describe("fase 3 — entradas fuera de la ventana se descartan sin examinarse más", () => {
  it("una entrada con dateKey fuera de [start,end], aunque tenga campos profundos inválidos, no invalida el resultado", () => {
    const outside = { dateKey: "2025-12-31", nutrients: "esto-no-es-un-objeto-valido" } as unknown as DailyIntegrityEntry;
    const result = expectEvaluated(evaluateNutrientCoverage(windowInput([outside])));
    expect(result.status).toBe("evaluated");
    expect(result.unloggedDays).toBe(7);
  });

  it("una entrada exactamente en el borde de la ventana (start o end) SÍ se procesa", () => {
    const onStart = entry("2026-01-01", { kcal: nv("known_nonzero", 500) });
    const onEnd = entry("2026-01-07", { kcal: nv("known_nonzero", 500) });
    const result = expectEvaluated(evaluateNutrientCoverage(windowInput([onStart, onEnd])));
    expect(result.unloggedDays).toBe(5);
  });
});

// ─── Fase 4 — campos profundos ──────────────────────────────────────────────

describe("fase 4 — campos profundos de cada entrada dentro de la ventana", () => {
  it("nutrients no es un objeto", () => {
    const bad = entry("2026-01-01", null as never);
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([bad]))).reasons).toEqual(["entry_nutrients_invalid"]);
  });

  it("nutrients con una clave que no es un NutrientKey reconocido", () => {
    const bad = entry("2026-01-01", { vitamin_c: nv("known_nonzero", 10) } as never);
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([bad]))).reasons).toEqual(["entry_nutrients_invalid"]);
  });

  it.each([
    ["unknown con value no nulo", nv("unknown", 0)],
    ["known_zero con value distinto de 0", nv("known_zero", 1)],
    ["known_nonzero con value 0", nv("known_nonzero", 0)],
    ["known_nonzero con value negativo", nv("known_nonzero", -5)],
    ["estimated con value negativo", nv("estimated", -1)],
    ["known_nonzero con value no finito", nv("known_nonzero", Number.POSITIVE_INFINITY)],
    ["status desconocido para la unión", { status: "measured", value: 5 } as unknown as NutrientValue],
  ])("NutrientValue inválido — %s", (_label, value) => {
    const bad = entry("2026-01-01", { fat: value });
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([bad]))).reasons).toEqual(["entry_nutrients_invalid"]);
  });

  it("quantityConfidence, foodStateConfidence y energyConsistency fuera de sus uniones", () => {
    const badQuantity = entry("2026-01-01", {}, { quantityConfidence: "medium" as never });
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([badQuantity]))).reasons).toEqual([
      "entry_quantity_confidence_invalid",
    ]);
    const badState = entry("2026-01-02", {}, { foodStateConfidence: "maybe" as never });
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([badState]))).reasons).toEqual([
      "entry_food_state_confidence_invalid",
    ]);
    const badEnergy = entry("2026-01-03", {}, { energyConsistency: "close_enough" as never });
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([badEnergy]))).reasons).toEqual([
      "entry_energy_consistency_invalid",
    ]);
  });

  it("varias entradas con razones distintas se acumulan, deduplicadas, en orden canónico", () => {
    const a = entry("2026-01-01", { fat: nv("unknown", 1) });
    const b = entry("2026-01-02", {}, { quantityConfidence: "medium" as never });
    const c = entry("2026-01-03", {}, { foodStateConfidence: "maybe" as never });
    const result = expectInvalid(evaluateNutrientCoverage(windowInput([a, b, c])));
    expect(result.reasons).toEqual([
      "entry_nutrients_invalid",
      "entry_quantity_confidence_invalid",
      "entry_food_state_confidence_invalid",
    ]);
  });
});

// ─── Regla 1 (pedida explícitamente) ───────────────────────────────────────

describe("regla 1 — known_zero, unknown y legacy_unlabeled producen resultados distintos; ninguno de los dos últimos es fiable", () => {
  const dayKnownZero = entry("2026-01-01", { kcal: nv("known_nonzero", 500), fat: nv("known_zero", 0) });
  const dayUnknown = entry("2026-01-02", { kcal: nv("known_nonzero", 500), fat: nv("unknown", null) });
  const dayLegacy = entry("2026-01-03", { kcal: nv("legacy_unlabeled", 500), fat: nv("legacy_unlabeled", 20) });

  it("known_zero cuenta como fiable; unknown y legacy_unlabeled no", () => {
    const result = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([dayKnownZero, dayUnknown, dayLegacy], {
          startDateKey: "2026-01-01",
          endDateKey: "2026-01-03",
          dailyReliabilityThreshold: 1,
        }),
      ),
    );
    const fat = coverageOf(result, "fat");
    expect(fat.daysWithReliableData).toBe(1);
    expect(fat.windowDays).toBe(3);
    expect(fat.coverageFraction).toBeCloseTo(1 / 3);
  });

  it("un día enteramente legacy_unlabeled se cuenta en legacyUnlabeledDays; uno con unknown (pero no todo legacy) no", () => {
    const result = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([dayKnownZero, dayUnknown, dayLegacy], { startDateKey: "2026-01-01", endDateKey: "2026-01-03" }),
      ),
    );
    expect(result.legacyUnlabeledDays).toBe(1);
  });

  it("un día con kcal known_nonzero y fat unknown NO cuenta como legacy_unlabeled (no todo el día lo es)", () => {
    const result = expectEvaluated(
      evaluateNutrientCoverage(windowInput([dayUnknown], { startDateKey: "2026-01-02", endDateKey: "2026-01-02" })),
    );
    expect(result.legacyUnlabeledDays).toBe(0);
  });
});

// ─── Regla 2 (pedida explícitamente) ───────────────────────────────────────

describe("regla 2 — la fiabilidad exige NutrientStatus known_* Y foodStateConfidence aceptable a la vez", () => {
  const base = (foodStateConfidence: FoodStateConfidence, dateKey: string) =>
    entry(dateKey, { kcal: nv("known_nonzero", 500), fat: nv("known_nonzero", 20) }, { foodStateConfidence });

  it("known_nonzero con foodStateConfidence 'unknown' o 'incompatible' NO es fiable", () => {
    const result = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([base("unknown", "2026-01-01"), base("incompatible", "2026-01-02")], {
          startDateKey: "2026-01-01",
          endDateKey: "2026-01-02",
          dailyReliabilityThreshold: 1,
        }),
      ),
    );
    expect(coverageOf(result, "fat").daysWithReliableData).toBe(0);
  });

  it("known_nonzero con foodStateConfidence 'confirmed' o 'not_applicable' SÍ es fiable", () => {
    const result = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([base("confirmed", "2026-01-01"), base("not_applicable", "2026-01-02")], {
          startDateKey: "2026-01-01",
          endDateKey: "2026-01-02",
          dailyReliabilityThreshold: 1,
        }),
      ),
    );
    expect(coverageOf(result, "fat").daysWithReliableData).toBe(2);
  });

  it("las cuatro combinaciones en una sola ventana — matriz completa", () => {
    const days = [
      base("confirmed", "2026-01-01"),
      base("unknown", "2026-01-02"),
      base("incompatible", "2026-01-03"),
      base("not_applicable", "2026-01-04"),
    ];
    const result = expectEvaluated(
      evaluateNutrientCoverage(windowInput(days, { startDateKey: "2026-01-01", endDateKey: "2026-01-04", dailyReliabilityThreshold: 1 })),
    );
    expect(coverageOf(result, "fat").daysWithReliableData).toBe(2); // confirmed + not_applicable
    expect(coverageOf(result, "fat").windowDays).toBe(4);
  });
});

// ─── Regla 3 (pedida explícitamente) ────────────────────────────────────────

describe("corrección — un kcal no ponderable (ausente/unknown/legacy_unlabeled) nunca deja que el día parezca más fiable ni menos provisional", () => {
  it("bug reportado: una comida de kcal desconocida junto a otra de 500 kcal con grasa conocida NO puede dar un día 100% fiable para grasa", () => {
    const unweighableMeal = entry("2026-01-03", { fat: nv("known_nonzero", 15) }, { foodStateConfidence: "confirmed" }); // sin kcal en absoluto
    const knownMeal = entry("2026-01-03", { kcal: nv("known_nonzero", 500), fat: nv("known_nonzero", 20) }, { foodStateConfidence: "confirmed" });
    const result = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([unweighableMeal, knownMeal], { startDateKey: "2026-01-01", endDateKey: "2026-01-07", dailyReliabilityThreshold: 1 }),
      ),
    );
    expect(coverageOf(result, "fat").daysWithReliableData).toBe(0); // NUNCA 1/1 = 100%
  });

  it("el mismo bug con kcal explícitamente 'unknown' (no solo ausente) en vez de otra entrada más grande", () => {
    const unweighableMeal = entry("2026-01-03", { kcal: nv("unknown", null) });
    const knownMeal = entry("2026-01-03", { kcal: nv("known_nonzero", 500), fat: nv("known_nonzero", 20) }, { foodStateConfidence: "confirmed" });
    const result = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([unweighableMeal, knownMeal], { startDateKey: "2026-01-01", endDateKey: "2026-01-07", dailyReliabilityThreshold: 1 }),
      ),
    );
    expect(coverageOf(result, "fat").daysWithReliableData).toBe(0);
  });

  it("ese mismo día se cuenta SIEMPRE en provisionalDays, sin condiciones adicionales", () => {
    const unweighableMeal = entry("2026-01-03", { fat: nv("known_nonzero", 15) });
    const knownMeal = entry("2026-01-03", { kcal: nv("known_nonzero", 500), fat: nv("known_nonzero", 20) }, { foodStateConfidence: "confirmed" });
    const result = expectEvaluated(
      evaluateNutrientCoverage(windowInput([unweighableMeal, knownMeal], { startDateKey: "2026-01-01", endDateKey: "2026-01-07" })),
    );
    expect(result.provisionalDays).toBe(1);
  });

  it("la entrada no ponderable NO debe hacer que el día parezca MENOS provisional: sin ella el día no era provisional; con ella, sí", () => {
    const knownMeal = entry("2026-01-03", { kcal: nv("known_nonzero", 500), fat: nv("known_nonzero", 20) }, {
      foodStateConfidence: "confirmed",
      quantityConfidence: "high",
      energyConsistency: "match",
    });
    const withoutUnweighable = expectEvaluated(
      evaluateNutrientCoverage(windowInput([knownMeal], { startDateKey: "2026-01-01", endDateKey: "2026-01-07" })),
    );
    expect(withoutUnweighable.provisionalDays).toBe(0); // día "limpio" por sí solo

    const unweighableMeal = entry("2026-01-03", { fat: nv("known_nonzero", 15) });
    const withUnweighable = expectEvaluated(
      evaluateNutrientCoverage(windowInput([knownMeal, unweighableMeal], { startDateKey: "2026-01-01", endDateKey: "2026-01-07" })),
    );
    expect(withUnweighable.provisionalDays).toBe(1); // añadirla SOLO puede subir la cautela, nunca bajarla
  });

  it("una kcal 'legacy_unlabeled' usada como peso: tener un número no hace fiable su magnitud — mismo tratamiento que ausente/unknown", () => {
    // kcal legacy_unlabeled en una entrada, pero NO todo el día es legacy
    // (la otra entrada es known_nonzero) — no debe caer en legacyUnlabeledDays,
    // debe caer en la nueva regla de "no ponderable".
    const legacyKcalMeal = entry("2026-01-03", { kcal: nv("legacy_unlabeled", 500) });
    const knownMeal = entry("2026-01-03", { kcal: nv("known_nonzero", 300), fat: nv("known_nonzero", 20) }, { foodStateConfidence: "confirmed" });
    const result = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([legacyKcalMeal, knownMeal], { startDateKey: "2026-01-01", endDateKey: "2026-01-07", dailyReliabilityThreshold: 1 }),
      ),
    );
    expect(result.legacyUnlabeledDays).toBe(0); // no es el caso "todo el día es legacy"
    expect(result.provisionalDays).toBe(1); // pero SÍ cae en la regla nueva
    expect(coverageOf(result, "fat").daysWithReliableData).toBe(0); // y no cuenta como fiable
  });

  it("un día donde TODAS las entradas tienen kcal ponderable (known_nonzero/known_zero/estimated/recipe_derived/imputed) no activa la regla nueva", () => {
    const estimatedKcal = entry("2026-01-03", { kcal: nv("estimated", 450), fat: nv("known_nonzero", 20) }, { foodStateConfidence: "confirmed" });
    const result = expectEvaluated(
      evaluateNutrientCoverage(windowInput([estimatedKcal], { startDateKey: "2026-01-01", endDateKey: "2026-01-07", dailyReliabilityThreshold: 1 })),
    );
    expect(result.provisionalDays).toBe(0);
    expect(coverageOf(result, "fat").daysWithReliableData).toBe(1);
  });
});

describe("regla 3 — windowDays nunca se reduce; un día sin entradas fiables permanece en el denominador; filtrar no infla la cobertura", () => {
  it("windowDays se deriva SOLO del rango de fechas, nunca del número de entradas recibidas", () => {
    const manyEntriesOneDay = Array.from({ length: 50 }, (_, i) =>
      entry("2026-01-03", { kcal: nv("known_nonzero", 100 + i) }),
    );
    const result = expectEvaluated(
      evaluateNutrientCoverage(windowInput(manyEntriesOneDay, { startDateKey: "2026-01-01", endDateKey: "2026-01-05" })),
    );
    expect(result.windowDays).toBe(5);
    for (const row of result.perNutrient) expect(row.windowDays).toBe(5);
  });

  it("un día sin ninguna entrada (equivalente a que un adaptador futuro filtrara toda entrada sintética de ese día) sigue contando en windowDays como unloggedDays, no desaparece del denominador", () => {
    // 6 de 7 días con kcal fiable; el día 4 llega VACÍO (simula el resultado
    // de filtrar entradas synthetic:true antes de construir el input del
    // kernel — el kernel en sí nunca ve una entrada synthetic).
    const reliableDays = [1, 2, 3, 5, 6, 7].map((day) =>
      entry(`2026-01-0${day}`, { kcal: nv("known_nonzero", 500) }),
    );
    const result = expectEvaluated(
      evaluateNutrientCoverage(windowInput(reliableDays, { startDateKey: "2026-01-01", endDateKey: "2026-01-07", dailyReliabilityThreshold: 1 })),
    );
    expect(result.windowDays).toBe(7); // nunca 6
    expect(result.unloggedDays).toBe(1);
    const kcalCoverage = coverageOf(result, "kcal");
    expect(kcalCoverage.daysWithReliableData).toBe(6);
    expect(kcalCoverage.coverageFraction).toBeCloseTo(6 / 7); // nunca 6/6 = 1
    expect(kcalCoverage.coverageFraction).not.toBeCloseTo(1);
  });

  it("un día con una entrada real y una entrada 'sintética' ya descartada (no llega al kernel) conserva solo la real, sin marcarse unlogged", () => {
    // La entrada sintética nunca llega — el adaptador la habría filtrado
    // antes. Lo único que ve el kernel es la entrada real de ese día.
    const realBreakfast = entry("2026-01-03", { kcal: nv("known_nonzero", 400) });
    const result = expectEvaluated(
      evaluateNutrientCoverage(windowInput([realBreakfast], { startDateKey: "2026-01-01", endDateKey: "2026-01-07", dailyReliabilityThreshold: 1 })),
    );
    expect(result.unloggedDays).toBe(6); // los otros 6 días, no el 3
    expect(coverageOf(result, "kcal").daysWithReliableData).toBe(1);
  });
});

// ─── Regla 4 (pedida explícitamente) ────────────────────────────────────────

describe("regla 4 — el kernel comunica coverageFraction sin fijar ningún umbral por su cuenta", () => {
  it("la MISMA fracción de fiabilidad (0.75) cruza el umbral o no según el parámetro recibido, nunca según una constante interna", () => {
    // kcal=400 total, de los cuales 300 son fat known_nonzero+confirmed → 0.75.
    const day = entry("2026-01-01", {
      kcal: nv("known_nonzero", 400),
    });
    // Construimos dos entradas del mismo día que juntas dan 0.75 de peso fiable.
    const reliablePart = entry("2026-01-01", { kcal: nv("known_nonzero", 300), fat: nv("known_nonzero", 10) });
    const unreliablePart = entry("2026-01-01", { kcal: nv("known_nonzero", 100), fat: nv("unknown", null) });
    void day;

    const low = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([reliablePart, unreliablePart], { startDateKey: "2026-01-01", endDateKey: "2026-01-01", dailyReliabilityThreshold: 0.5 }),
      ),
    );
    const high = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([reliablePart, unreliablePart], { startDateKey: "2026-01-01", endDateKey: "2026-01-01", dailyReliabilityThreshold: 0.9 }),
      ),
    );
    expect(coverageOf(low, "fat").daysWithReliableData).toBe(1); // 0.75 >= 0.5
    expect(coverageOf(high, "fat").daysWithReliableData).toBe(0); // 0.75 < 0.9
  });

  it("lo mismo para provisionalKcalFractionThreshold: la misma ventana es o no provisional según el parámetro", () => {
    const lowQuality = entry("2026-01-01", { kcal: nv("known_nonzero", 500) }, { quantityConfidence: "low" });
    const highQuality = entry("2026-01-01", { kcal: nv("known_nonzero", 500) }, { quantityConfidence: "high" });
    // 50% de las kcal del día son quantityConfidence:"low".
    const lenient = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([lowQuality, highQuality], { startDateKey: "2026-01-01", endDateKey: "2026-01-01", provisionalKcalFractionThreshold: 0.6 }),
      ),
    );
    const strict = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput([lowQuality, highQuality], { startDateKey: "2026-01-01", endDateKey: "2026-01-01", provisionalKcalFractionThreshold: 0.4 }),
      ),
    );
    expect(lenient.provisionalDays).toBe(0); // 0.5 no supera 0.6
    expect(strict.provisionalDays).toBe(1); // 0.5 sí supera 0.4
  });

  it("ventana real de 28 días — el mínimo teórico de §14 del documento de diseño: 24/28 ≈ 0,857 ya supera un umbral de 0,85, 23/28 no", () => {
    const reliableDates = Array.from({ length: 24 }, (_, i) => addDays("2026-01-01", i));
    const entries28 = reliableDates.map((d) => entry(d, { kcal: nv("known_nonzero", 500) }));
    const result = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput(entries28, { startDateKey: "2026-01-01", endDateKey: addDays("2026-01-01", 27), dailyReliabilityThreshold: 1 }),
      ),
    );
    expect(result.windowDays).toBe(28);
    const kcal = coverageOf(result, "kcal");
    expect(kcal.daysWithReliableData).toBe(24);
    expect(kcal.coverageFraction).toBeCloseTo(24 / 28);
    expect(kcal.coverageFraction).toBeGreaterThanOrEqual(0.85);

    const only23 = entries28.slice(0, 23);
    const result23 = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput(only23, { startDateKey: "2026-01-01", endDateKey: addDays("2026-01-01", 27), dailyReliabilityThreshold: 1 }),
      ),
    );
    expect(coverageOf(result23, "kcal").coverageFraction).toBeLessThan(0.85);
  });
});

// ─── Fixture literal del documento de diseño (§1.6, v7) ─────────────────────

describe("fixture literal — reproduce §1.6 del documento de diseño (ventana de 7 días, resultado esperado 3/6 conocidos, 3/7 de cobertura)", () => {
  it("Lun(unknown)/Mar(confirmed)/Mié(not_applicable)/Jue(unknown)/Vie(unknown)/Sáb(confirmed)/Dom(estimated) → 3 días fiables de 7", () => {
    const days: DailyIntegrityEntry[] = [
      entry("2026-01-05", { kcal: nv("known_nonzero", 500) }, { foodStateConfidence: "unknown" }), // Lun
      entry("2026-01-06", { kcal: nv("known_nonzero", 500) }, { foodStateConfidence: "confirmed" }), // Mar
      entry("2026-01-07", { kcal: nv("known_nonzero", 500) }, { foodStateConfidence: "not_applicable" }), // Mié
      entry("2026-01-08", { kcal: nv("known_nonzero", 500) }, { foodStateConfidence: "unknown" }), // Jue
      entry("2026-01-09", { kcal: nv("known_nonzero", 500) }, { foodStateConfidence: "unknown" }), // Vie
      entry("2026-01-10", { kcal: nv("known_nonzero", 500) }, { foodStateConfidence: "confirmed" }), // Sáb
      entry("2026-01-11", { kcal: nv("estimated", 600) }, { foodStateConfidence: "not_applicable" }), // Dom
    ];
    const result = expectEvaluated(
      evaluateNutrientCoverage(windowInput(days, { startDateKey: "2026-01-05", endDateKey: "2026-01-11", dailyReliabilityThreshold: 1 })),
    );
    expect(result.windowDays).toBe(7);
    const kcal = coverageOf(result, "kcal");
    expect(kcal.daysWithReliableData).toBe(3); // Mar, Mié, Sáb
    expect(kcal.coverageFraction).toBeCloseTo(3 / 7);
  });
});

// ─── Todos los NutrientKey se informan siempre ─────────────────────────────

describe("perNutrient siempre informa las 7 claves, incluso si ninguna entrada las menciona", () => {
  it("ventana vacía → 7 filas, todas con daysWithReliableData 0", () => {
    const result = expectEvaluated(evaluateNutrientCoverage(windowInput([])));
    expect(result.perNutrient.map((p) => p.nutrient).sort()).toEqual([...ALL_NUTRIENTS].sort());
    for (const row of result.perNutrient) {
      expect(row.daysWithReliableData).toBe(0);
      expect(row.coverageFraction).toBe(0);
      expect(row.windowDays).toBe(result.windowDays);
    }
    expect(result.unloggedDays).toBe(result.windowDays);
  });
});

// ─── Día sin ningún nutriente reportado — no es legacy_unlabeled ───────────

describe("un día con entradas pero sin ningún NutrientValue en absoluto no es legacy_unlabeled — y, tras la corrección, sí es provisional (kcal ausente es no ponderable)", () => {
  it("nutrients: {} en la única entrada del día", () => {
    const result = expectEvaluated(
      evaluateNutrientCoverage(windowInput([entry("2026-01-03", {})], { startDateKey: "2026-01-01", endDateKey: "2026-01-07" })),
    );
    expect(result.legacyUnlabeledDays).toBe(0);
    // Corrección: sin kcal en absoluto, la entrada es "no ponderable" —
    // ver isUnweighableEntry — así que el día se fuerza a provisionalDays
    // en vez de quedar en un cuarto estado sin nombre.
    expect(result.provisionalDays).toBe(1);
    for (const row of result.perNutrient) expect(row.daysWithReliableData).toBe(0);
  });
});

// ─── Seguridad numérica ─────────────────────────────────────────────────────

describe("seguridad numérica — derived_numeric_result_invalid es alcanzable, no solo teórico", () => {
  it("dos entradas con kcal = Number.MAX_VALUE el mismo día desbordan la suma a Infinity y se rechazan", () => {
    const overflow = [
      entry("2026-01-01", { kcal: nv("known_nonzero", Number.MAX_VALUE) }),
      entry("2026-01-01", { kcal: nv("known_nonzero", Number.MAX_VALUE) }),
    ];
    const result = expectInvalid(
      evaluateNutrientCoverage(windowInput(overflow, { startDateKey: "2026-01-01", endDateKey: "2026-01-01" })),
    );
    expect(result.reasons).toEqual(["derived_numeric_result_invalid"]);
  });

  it("un evaluated nunca contiene NaN ni Infinity en ningún campo numérico", () => {
    const result = expectEvaluated(
      evaluateNutrientCoverage(
        windowInput(
          [
            entry("2026-01-01", { kcal: nv("known_nonzero", 500), fat: nv("known_zero", 0) }),
            entry("2026-01-02", { kcal: nv("legacy_unlabeled", 400) }),
          ],
          { startDateKey: "2026-01-01", endDateKey: "2026-01-07" },
        ),
      ),
    );
    const numbers: number[] = [
      result.windowDays,
      result.unloggedDays,
      result.legacyUnlabeledDays,
      result.provisionalDays,
      ...result.perNutrient.flatMap((p) => [p.windowDays, p.daysWithReliableData, p.coverageFraction]),
    ];
    for (const n of numbers) {
      expect(Number.isFinite(n)).toBe(true);
      expect(Number.isNaN(n)).toBe(false);
    }
  });
});

// ─── Determinismo e inmutabilidad ───────────────────────────────────────────

describe("determinismo e inmutabilidad", () => {
  it("dos llamadas con el mismo input dan resultados profundamente iguales", () => {
    const input = windowInput([entry("2026-01-03", { kcal: nv("known_nonzero", 500), fat: nv("estimated", 20) })]);
    expect(evaluateNutrientCoverage(input)).toEqual(evaluateNutrientCoverage(input));
  });

  it("el input no se muta", () => {
    const entries = [entry("2026-01-03", { kcal: nv("known_nonzero", 500) })];
    const input = windowInput(entries);
    const snapshot = JSON.parse(JSON.stringify(input));
    evaluateNutrientCoverage(input);
    expect(input).toEqual(snapshot);
  });
});

// ─── API pública del barrel ────────────────────────────────────────────────

describe("barrel — solo evaluateNutrientCoverage es pública desde este kernel", () => {
  const PRIVATE_NAMES = [
    "isRecordObject",
    "isLeapYear",
    "isValidCalendarDateKey",
    "dayNumber",
    "compareDateKeys",
    "NUTRIENT_KEYS",
    "isValidNutrientKey",
    "isValidNutrientValue",
    "isValidNutrientsMap",
    "isValidQuantityConfidence",
    "isValidFoodStateConfidence",
    "isValidEnergyConsistency",
    "isValidUnitFraction",
    "DATE_KEY_PATTERN",
    "DAYS_IN_MONTH",
    "INVALID_REASON_ORDER",
    "invalidInput",
    "NonFiniteDerivedValueError",
    "assertFinite",
    "validateRequest",
    "isWeighableKcal",
    "entryWeight",
    "isUnweighableEntry",
    "isReliableNutrientValue",
    "isReliableFoodState",
    "computeEvaluated",
  ];

  it("expone evaluateNutrientCoverage y ninguna declaración privada de este kernel", () => {
    const barrel = engineBarrel as Record<string, unknown>;
    expect(typeof barrel.evaluateNutrientCoverage).toBe("function");
    for (const name of PRIVATE_NAMES) expect(barrel[name]).toBeUndefined();
  });

  it("la lista de nombres privados cubre todas las declaraciones de nivel superior del kernel (no queda obsoleta)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fileName = join(here, "nutrient-coverage-kernel.ts");
    const sourceFile = ts.createSourceFile(fileName, readFileSync(fileName, "utf-8"), ts.ScriptTarget.Latest, true);
    const declared: string[] = [];
    for (const statement of sourceFile.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declared.push(statement.name.text);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) declared.push(declaration.name.text);
      }
    }
    const publicNames = ["evaluateNutrientCoverage"];
    expect(declared.filter((name) => !publicNames.includes(name) && !PRIVATE_NAMES.includes(name))).toEqual([]);
    expect(declared).toContain("evaluateNutrientCoverage");
  });

  it("evaluateNutrientCoverage importado desde el barrel se comporta igual que el import directo", () => {
    const input = windowInput([entry("2026-01-03", { kcal: nv("known_nonzero", 500) })]);
    expect(engineBarrel.evaluateNutrientCoverage(input)).toEqual(evaluateNutrientCoverage(input));
  });
});

// ─── Pureza y alcance (AST real) ────────────────────────────────────────────

function findForbiddenDirectRuntimeReferences(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const bareForbiddenNames = new Set(["fetch", "localStorage", "sessionStorage", "globalThis", "setTimeout", "setInterval"]);
  const violations: string[] = [];
  function describeNode(node: ts.Node): string {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${node.getText(sourceFile)} (línea ${line + 1})`;
  }
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
      violations.push(describeNode(node));
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const objectName = node.expression.text;
      const propertyName = node.name.text;
      if ((objectName === "Date" && propertyName === "now") || (objectName === "Math" && propertyName === "random") || (objectName === "process" && propertyName === "env")) {
        violations.push(describeNode(node));
      }
      if (propertyName === "localeCompare") violations.push(describeNode(node));
    } else if (ts.isIdentifier(node) && bareForbiddenNames.has(node.text)) {
      violations.push(describeNode(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

function collectImportModuleSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

describe("pureza y alcance — accesos directos prohibidos, imports y conocimiento ajeno", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const kernelFile = join(here, "nutrient-coverage-kernel.ts");
  const kernelSource = readFileSync(kernelFile, "utf-8");

  it("el AST no contiene accesos directos a Date, reloj, aleatoriedad, red, almacenamiento, estado global ni localeCompare", () => {
    expect(findForbiddenDirectRuntimeReferences(kernelSource, kernelFile)).toEqual([]);
  });

  it("el único import del kernel es de tipos de @foodos/types — nada de apps/web, PR3, PR4, PR5A/PR5B, Supabase, red ni filesystem", () => {
    const specifiers = collectImportModuleSpecifiers(kernelSource, kernelFile);
    expect(specifiers).toEqual(["@foodos/types"]);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/apps\/web|supabase|node:|undici|axios|weekly-|exercise-|macro-|adaptive-|intake-logging-|weight-trend/i);
    }
  });

  it("el kernel y su contrato no contienen conocimiento sobre sesiones, calibración, persistencia, Supabase ni el coordinador adaptativo", () => {
    const contractFiles = [
      join(here, "..", "..", "types", "src", "nutrient-value.ts"),
      join(here, "..", "..", "types", "src", "nutrient-coverage.ts"),
    ];
    for (const [name, source] of [
      ["kernel", kernelSource],
      ...contractFiles.map((f) => [f, readFileSync(f, "utf-8")] as const),
    ] as const) {
      expect({ name, offending: source.match(/calibrat|supabase|session|sesi[oó]n|coordinat|persist/gi) }).toEqual({
        name,
        offending: null,
      });
    }
  });
});

// ─── Dominio de fechas ───────────────────────────────────────────────────────

describe("dominio de fechas — 0001-01-01 a 9999-12-31, gregoriano proléptico, sin año cero", () => {
  it("acepta el primer y el último día representables", () => {
    const first = expectEvaluated(
      evaluateNutrientCoverage(windowInput([], { startDateKey: "0001-01-01", endDateKey: "0001-01-01" })),
    );
    expect(first.windowDays).toBe(1);
    const last = expectEvaluated(
      evaluateNutrientCoverage(windowInput([], { startDateKey: "9999-12-31", endDateKey: "9999-12-31" })),
    );
    expect(last.windowDays).toBe(1);
  });

  it("año 0000 se rechaza (sin año cero en este dominio)", () => {
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([], { startDateKey: "0000-01-01" }))).reasons).toEqual([
      "start_date_key_invalid",
    ]);
  });

  it("29 de febrero se acepta en años bisiestos y se rechaza en no bisiestos", () => {
    expect(
      expectEvaluated(evaluateNutrientCoverage(windowInput([], { startDateKey: "2024-02-29", endDateKey: "2024-02-29" }))).status,
    ).toBe("evaluated");
    expect(expectInvalid(evaluateNutrientCoverage(windowInput([], { startDateKey: "2026-02-29" }))).reasons).toEqual([
      "start_date_key_invalid",
    ]);
  });
});
