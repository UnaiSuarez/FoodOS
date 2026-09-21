import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import type {
  WeightTrendEstimateEvaluated,
  WeightTrendEstimateInput,
  WeightTrendEstimateInsufficientData,
  WeightTrendEstimateInvalidInput,
  WeightTrendEstimateInvalidReason,
  WeightTrendEstimateResult,
  WeightTrendMeasurement,
  WeightTrendResult as LegacyWeightTrendResult,
} from "@foodos/types";
import { calculateWeightTrend } from "./weight-trend-kernel";
import * as engineBarrel from "./index";

// Organización de la suite, para no confundir tipos de evidencia:
//  · «fixtures literales independientes»: esperados deducidos a mano o literales.
//  · «paridad con v3.1»: literales capturados una vez de la función real de v3.1 (la suite
//    no importa ni ejecuta v3.1) con el redondeo legacy aplicado aquí, en la prueba.
//  · «propiedades que reexpresan fórmulas del contrato»: recalculan una fórmula o identidad
//    documentada; detectan regresiones pero NO son evidencia independiente.
// El resto (validación por fases, fechas, seguridad numérica, determinismo, barrel y pureza)
// comprueba el contrato y no depende de un oráculo numérico.

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Solo para construir fixtures (el kernel no usa Date): suma días vía UTC. */
function addDays(dateKey: string, days: number): string {
  const date = new Date(Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10))));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function series(startDateKey: string, weights: readonly number[]): WeightTrendMeasurement[] {
  return weights.map((kg, index) => ({ dateKey: addDays(startDateKey, index), kg }));
}

const WINDOW_START = "2026-08-31";
const WINDOW_END = "2026-09-28";

function windowInput(measurements: readonly WeightTrendMeasurement[], overrides: Partial<WeightTrendEstimateInput> = {}): WeightTrendEstimateInput {
  return { startDateKey: WINDOW_START, endDateKey: WINDOW_END, measurements, ...overrides };
}

function expectEvaluated(result: WeightTrendEstimateResult): WeightTrendEstimateEvaluated {
  if (result.status !== "evaluated") throw new Error(`esperado evaluated, recibido ${JSON.stringify(result)}`);
  return result;
}
function expectInsufficient(result: WeightTrendEstimateResult): WeightTrendEstimateInsufficientData {
  if (result.status !== "insufficient_data") throw new Error(`esperado insufficient_data, recibido ${JSON.stringify(result)}`);
  return result;
}
function expectInvalid(result: WeightTrendEstimateResult): WeightTrendEstimateInvalidInput {
  if (result.status !== "invalid_input") throw new Error(`esperado invalid_input, recibido ${JSON.stringify(result)}`);
  return result;
}

// Redondeos de PRESENTACIÓN de v3.1: se aplican del lado de la prueba, nunca en el kernel.
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10000) / 10000;

const P1_CONSTANT_15 = series("2026-09-14", Array<number>(15).fill(80.0));
const P2_NOISY_DECLINE_15 = series("2026-09-14", [80.4, 80.2, 80.3, 80.0, 79.9, 80.1, 79.7, 79.8, 79.5, 79.6, 79.3, 79.4, 79.1, 79.0, 79.2]);
const P3_IRREGULAR_6: WeightTrendMeasurement[] = [
  { dateKey: "2026-09-01", kg: 82.0 },
  { dateKey: "2026-09-03", kg: 81.8 },
  { dateKey: "2026-09-10", kg: 81.9 },
  { dateKey: "2026-09-11", kg: 81.5 },
  { dateKey: "2026-09-20", kg: 81.0 },
  { dateKey: "2026-09-28", kg: 80.7 },
];
const P4_MINIMUM_3: WeightTrendMeasurement[] = [
  { dateKey: "2026-09-24", kg: 70.0 },
  { dateKey: "2026-09-26", kg: 69.8 },
  { dateKey: "2026-09-28", kg: 69.9 },
];
const P5_WINDOW_29 = series(
  "2026-08-31",
  [75, 75, 74.9, 74.9, 74.8, 74.8, 74.7, 74.7, 74.6, 74.6, 74.5, 74.5, 74.4, 74.4, 74.3, 74.3, 74.2, 74.2, 74.1, 74.1, 74, 74, 73.9, 73.9, 73.8, 73.8, 73.7, 73.7, 73.6],
);
const D4_TWENTY_ONE = series(
  "2026-09-08",
  [72.3, 72.1, 72.1, 71.9, 72.3, 72.2, 72.3, 72.3, 72.0, 72.3, 72.0, 72.2, 72.0, 72.0, 72.4, 72.5, 72.5, 72.0, 72.3, 72.4, 72.2],
);

/** Generador congruencial determinista: el barrido no depende de Math.random. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Serie sintética dentro de la ventana por defecto: 3 a 29 mediciones en días
    distintos, con tendencia y ruido, a 1 decimal como las de la aplicación. */
function seededMeasurements(seed: number): WeightTrendMeasurement[] {
  const next = lcg(seed);
  const offsets = Array.from({ length: 29 }, (_, index) => index);
  for (let index = offsets.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [offsets[index], offsets[other]] = [offsets[other], offsets[index]];
  }
  const count = 3 + Math.floor(next() * 27);
  const chosen = offsets.slice(0, count).sort((a, b) => a - b);
  const slope = (next() - 0.5) * 0.3;
  const noise = next() * 1.5;
  return chosen.map((offset) => ({ dateKey: addDays(WINDOW_START, offset), kg: round1(75 + slope * offset + (next() - 0.5) * noise) }));
}

function collectNumbers(value: unknown, into: number[] = []): number[] {
  if (typeof value === "number") into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, into));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectNumbers(item, into));
  return into;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  });
  return result;
}

/** Altera in situ un resultado devuelto: números → -1, textos → «alterado», arrays vaciados. */
function corrupt(value: unknown): void {
  if (Array.isArray(value)) {
    value.length = 0;
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (typeof child === "number") record[key] = -1;
      else if (typeof child === "string") record[key] = "alterado";
      else corrupt(child);
    }
  }
}

// ─── Fase 1 — forma superior y ventana ─────────────────────────────────────

describe("fase 1 — forma superior y ventana", () => {
  it("input que no es un objeto (null, undefined, primitivo o array) → invalid_input/input_object_invalid, sin lanzar", () => {
    for (const garbage of [null, undefined, "x", 42, true, []]) {
      expect(() => calculateWeightTrend(garbage as unknown as WeightTrendEstimateInput)).not.toThrow();
      expect(calculateWeightTrend(garbage as unknown as WeightTrendEstimateInput)).toEqual({
        status: "invalid_input",
        reasons: ["input_object_invalid"],
      });
    }
  });

  it("startDateKey inválida → start_date_key_invalid", () => {
    expect(expectInvalid(calculateWeightTrend(windowInput([], { startDateKey: "no-es-fecha" }))).reasons).toEqual(["start_date_key_invalid"]);
  });

  it("endDateKey con calendario imposible (2026-02-30) → end_date_key_invalid, sin normalización de Date", () => {
    expect(expectInvalid(calculateWeightTrend(windowInput([], { endDateKey: "2026-02-30" }))).reasons).toEqual(["end_date_key_invalid"]);
  });

  it("ventana invertida → date_window_order_invalid; ventana de un día es válida", () => {
    expect(expectInvalid(calculateWeightTrend(windowInput([], { startDateKey: "2026-09-28", endDateKey: "2026-09-27" }))).reasons).toEqual([
      "date_window_order_invalid",
    ]);
    const oneDay = expectInsufficient(calculateWeightTrend(windowInput([], { startDateKey: "2026-09-28", endDateKey: "2026-09-28" })));
    expect(oneDay.coverage.windowCalendarDays).toBe(1);
  });

  it("measurements que no es array → measurements_not_array", () => {
    const input = { startDateKey: WINDOW_START, endDateKey: WINDOW_END, measurements: "no-array" } as unknown as WeightTrendEstimateInput;
    expect(expectInvalid(calculateWeightTrend(input)).reasons).toEqual(["measurements_not_array"]);
  });

  it("varios problemas de forma a la vez → todos, deduplicados y en orden canónico", () => {
    const input = { startDateKey: "x", endDateKey: "y", measurements: 5 } as unknown as WeightTrendEstimateInput;
    expect(expectInvalid(calculateWeightTrend(input)).reasons).toEqual(["start_date_key_invalid", "end_date_key_invalid", "measurements_not_array"]);
  });

  it("con una fecha límite inválida no se informa el orden de la ventana", () => {
    const result = expectInvalid(calculateWeightTrend(windowInput([], { startDateKey: "2026-09-30", endDateKey: "2026-13-01" })));
    expect(result.reasons).toEqual(["end_date_key_invalid"]);
  });

  it("orden de ventana + measurements_not_array a la vez → ambas razones, en orden canónico entre fases", () => {
    const input = { startDateKey: "2026-09-28", endDateKey: "2026-09-01", measurements: "x" } as unknown as WeightTrendEstimateInput;
    expect(expectInvalid(calculateWeightTrend(input)).reasons).toEqual(["date_window_order_invalid", "measurements_not_array"]);
  });
});

// ─── Fase 2 — fila entera: objeto y dateKey real ──────────────────────────

describe("fase 2 — cada fila es un objeto con dateKey real (invalida siempre)", () => {
  it("fila que no es un objeto (null, undefined, primitivo o array) → measurement_object_invalid", () => {
    for (const row of [null, undefined, "x", 3, []]) {
      const result = calculateWeightTrend(windowInput([row as unknown as WeightTrendMeasurement]));
      expect(expectInvalid(result).reasons).toEqual(["measurement_object_invalid"]);
    }
  });

  const INVALID_DATE_KEYS: unknown[] = [
    "2026-9-1",
    " 2026-09-01",
    "2026-09-01 ",
    "2026-09-01T00:00:00",
    "2026/09/01",
    "20260901",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "2026-02-30",
    "2100-02-29",
    "0000-01-01",
    "abcd-ef-gh",
    "",
    20260901,
    null,
    undefined,
  ];
  for (const dateKey of INVALID_DATE_KEYS) {
    it(`dateKey ${JSON.stringify(dateKey) ?? "undefined"} → measurement_date_key_invalid`, () => {
      const row = { dateKey, kg: 80 } as unknown as WeightTrendMeasurement;
      expect(expectInvalid(calculateWeightTrend(windowInput([row]))).reasons).toEqual(["measurement_date_key_invalid"]);
    });
  }

  it("una fecha inválida invalida aunque sea imposible situar la fila dentro o fuera de la ventana", () => {
    const rows = [...P4_MINIMUM_3, { dateKey: "1999-02-30", kg: 70 }];
    expect(expectInvalid(calculateWeightTrend(windowInput(rows))).reasons).toEqual(["measurement_date_key_invalid"]);
  });

  it("de una fila con fecha inválida no se evalúa ningún otro campo (ni de ella ni de las demás)", () => {
    const rows = [
      { dateKey: "2026-13-13", kg: -5 },
      { dateKey: "2026-09-10", kg: Number.NaN },
    ] as unknown as WeightTrendMeasurement[];
    expect(expectInvalid(calculateWeightTrend(windowInput(rows))).reasons).toEqual(["measurement_date_key_invalid"]);
  });
});

// ─── Fases 3 a 5 — ventana, valores y duplicados ──────────────────────────

describe("fases 3 a 5 — ventana, valores y duplicados solo dentro de la ventana", () => {
  const CORRUPT_WEIGHTS: unknown[] = [Number.NaN, Infinity, -Infinity, 0, -1, "80", null, undefined, {}];

  it("kg corrupto en una fila FUERA de la ventana no invalida y no cuenta", () => {
    for (const kg of CORRUPT_WEIGHTS) {
      const rows = [...P4_MINIMUM_3, { dateKey: "2026-08-15", kg }] as unknown as WeightTrendMeasurement[];
      const result = expectEvaluated(calculateWeightTrend(windowInput(rows)));
      expect(result.coverage.measurementsInWindow).toBe(3);
    }
  });

  it("kg corrupto DENTRO de la ventana → measurement_weight_invalid", () => {
    for (const kg of CORRUPT_WEIGHTS) {
      const rows = [...P4_MINIMUM_3, { dateKey: "2026-09-20", kg }] as unknown as WeightTrendMeasurement[];
      expect(expectInvalid(calculateWeightTrend(windowInput(rows))).reasons).toEqual(["measurement_weight_invalid"]);
    }
  });

  it("fila sin la propiedad kg dentro de la ventana → measurement_weight_invalid", () => {
    const rows = [...P4_MINIMUM_3, { dateKey: "2026-09-20" }] as unknown as WeightTrendMeasurement[];
    expect(expectInvalid(calculateWeightTrend(windowInput(rows))).reasons).toEqual(["measurement_weight_invalid"]);
  });

  it("kg -0 se rechaza como peso no positivo dentro de la ventana y se ignora fuera de ella", () => {
    const negativeZero = -0;
    expect(Object.is(negativeZero, -0)).toBe(true);
    const inside = [...P4_MINIMUM_3, { dateKey: "2026-09-20", kg: negativeZero }];
    expect(expectInvalid(calculateWeightTrend(windowInput(inside))).reasons).toEqual(["measurement_weight_invalid"]);
    const outside = [...P4_MINIMUM_3, { dateKey: "2026-08-15", kg: negativeZero }];
    expect(expectEvaluated(calculateWeightTrend(windowInput(outside))).coverage.measurementsInWindow).toBe(3);
  });

  it("dateKey duplicada dentro de la ventana → measurement_date_key_duplicate (divergencia D1: v3.1 la aceptaba, n=16, calidad 0,842473239175989, «moderate»)", () => {
    const rows = [...P2_NOISY_DECLINE_15, { dateKey: "2026-09-20", kg: 79.9 }];
    expect(expectInvalid(calculateWeightTrend(windowInput(rows))).reasons).toEqual(["measurement_date_key_duplicate"]);
  });

  it("dateKey duplicada FUERA de la ventana no se examina", () => {
    const rows = [...P4_MINIMUM_3, { dateKey: "2026-08-10", kg: 71 }, { dateKey: "2026-08-10", kg: 72 }];
    expect(expectEvaluated(calculateWeightTrend(windowInput(rows))).coverage.measurementsInWindow).toBe(3);
  });

  it("valor corrupto y duplicado a la vez → ambas razones, en orden canónico", () => {
    const rows = [
      { dateKey: "2026-09-20", kg: -1 },
      { dateKey: "2026-09-20", kg: 80 },
    ];
    expect(expectInvalid(calculateWeightTrend(windowInput(rows))).reasons).toEqual(["measurement_weight_invalid", "measurement_date_key_duplicate"]);
  });

  it("los extremos de la ventana son inclusivos", () => {
    const rows = [
      { dateKey: WINDOW_START, kg: 80 },
      { dateKey: "2026-09-10", kg: 79.5 },
      { dateKey: WINDOW_END, kg: 79 },
      { dateKey: "2026-08-30", kg: 99.9 },
      { dateKey: "2026-09-29", kg: 99.9 },
    ];
    expect(expectEvaluated(calculateWeightTrend(windowInput(rows))).coverage.measurementsInWindow).toBe(3);
  });
});

// ─── Suficiencia y cobertura ──────────────────────────────────────────────

describe("suficiencia — mínimo de 3 mediciones en la ventana", () => {
  it("2 mediciones → insufficient_data con cobertura exacta y sin ningún campo de tendencia", () => {
    const result = expectInsufficient(calculateWeightTrend(windowInput(P4_MINIMUM_3.slice(0, 2))));
    expect(result).toEqual({
      status: "insufficient_data",
      coverage: {
        windowStartDateKey: WINDOW_START,
        windowEndDateKey: WINDOW_END,
        windowCalendarDays: 29,
        measurementsInWindow: 2,
        minimumMeasurementsRequired: 3,
      },
      reasons: ["fewer_than_minimum_measurements_in_window"],
    });
  });

  it("0 mediciones → insufficient_data", () => {
    expect(expectInsufficient(calculateWeightTrend(windowInput([]))).coverage.measurementsInWindow).toBe(0);
  });

  it("solo cuentan las mediciones dentro de la ventana", () => {
    const rows = [...P4_MINIMUM_3.slice(0, 2), ...series("2026-07-01", [70, 70, 70, 70, 70])];
    expect(expectInsufficient(calculateWeightTrend(windowInput(rows))).coverage.measurementsInWindow).toBe(2);
  });

  it("exactamente 3 mediciones → evaluated", () => {
    expect(expectEvaluated(calculateWeightTrend(windowInput(P4_MINIMUM_3))).coverage.measurementsInWindow).toBe(3);
  });
});

// ─── Fixtures literales independientes ────────────────────────────────────
// Los valores esperados están deducidos a mano (regularidad 0,5 y 0), fijados como
// literales (serie plana, constantes y umbrales) o comprobados contra literales
// calculados a mano (80, 82, 79, 81). No dependen de reproducir el algoritmo del kernel.

describe("fixtures literales independientes — valores deducidos a mano", () => {
  it("regularidad deducida a mano: huecos 1 y 3 → media 2, desviación poblacional 1, CV 0,5 → 0,5 exacto", () => {
    const rows: WeightTrendMeasurement[] = [
      { dateKey: "2026-09-20", kg: 80 },
      { dateKey: "2026-09-21", kg: 79.5 },
      { dateKey: "2026-09-24", kg: 79 },
    ];
    expect(expectEvaluated(calculateWeightTrend(windowInput(rows))).qualityComponents.regularityScore).toBe(0.5);
  });

  it("regularidad recortada a 0: huecos 1, 1, 1 y 20 → CV 1,43 > 1, sin puntuación negativa", () => {
    const gaps = [1, 1, 1, 20];
    const meanGap = 23 / 4;
    const populationVariance = gaps.reduce((sum, gap) => sum + (gap - meanGap) ** 2, 0) / gaps.length;
    expect(Math.sqrt(populationVariance) / meanGap).toBeGreaterThan(1);
    const rows = [0, 1, 2, 3, 23].map((offset, index) => ({ dateKey: addDays("2026-09-01", offset), kg: 80 - 0.1 * index }));
    const r = expectEvaluated(calculateWeightTrend(windowInput(rows)));
    expect(r.qualityComponents.regularityScore).toBe(0);
    expect(r.qualityComponents.combinedScore).toBeGreaterThanOrEqual(0);
  });

  it("80, 82, 79, 81: mediana real en el interior, promedio en los bordes y EWMA con alfa 0,2", () => {
    const m0 = (80 + 82) / 2; // borde
    const m1 = 80; // mediana de [80, 82, 79] (no su media, 80,33…)
    const m2 = 81; // mediana de [82, 79, 81]
    const m3 = (79 + 81) / 2; // borde
    const e0 = m0;
    const e1 = 0.2 * m1 + (1 - 0.2) * e0;
    const e2 = 0.2 * m2 + (1 - 0.2) * e1;
    const e3 = 0.2 * m3 + (1 - 0.2) * e2;
    const yMean = (e0 + e1 + e2 + e3) / 4;
    const dayMean = 1.5;
    const numerator = (0 - dayMean) * (e0 - yMean) + (1 - dayMean) * (e1 - yMean) + (2 - dayMean) * (e2 - yMean) + (3 - dayMean) * (e3 - yMean);
    const denominator = (0 - dayMean) ** 2 + (1 - dayMean) ** 2 + (2 - dayMean) ** 2 + (3 - dayMean) ** 2;

    const result = expectEvaluated(calculateWeightTrend(windowInput(series("2026-09-25", [80, 82, 79, 81]))));
    expect(result.trendWeightKg).toBeCloseTo(e3, 12);
    expect(result.trendWeightKg).toBeCloseTo(80.672, 12);
    expect(result.latestWeightKg).toBe(81);
    expect(result.slopeKgPerDay).toBeCloseTo(numerator / denominator, 12);
    expect(result.slopeKgPerDay).toBeCloseTo(-0.0944, 12);
  });

  it("serie plana → pendiente +0, ajuste 1 por la rama de varianza total nula", () => {
    const result = expectEvaluated(calculateWeightTrend(windowInput(P1_CONSTANT_15)));
    expect(Object.is(result.slopeKgPerDay, 0)).toBe(true);
    expect(Object.is(result.weeklyChangeKg, 0)).toBe(true);
    expect(Object.is(result.weeklyChangePercent, 0)).toBe(true);
    expect(result.trendWeightKg).toBe(80);
    expect(result.qualityComponents.fitScore).toBe(1);
  });

  it("épsilon de serie plana: una oscilación de 4e-4 kg da fitScore 1; una de 4e-2 kg ya lo calcula (< 1)", () => {
    const alternating = (high: number): WeightTrendMeasurement[] => series("2026-09-23", [80, high, 80, high, 80, high]);
    const tiny = expectEvaluated(calculateWeightTrend(windowInput(alternating(80.0004))));
    const visible = expectEvaluated(calculateWeightTrend(windowInput(alternating(80.04))));
    expect(tiny.qualityComponents.fitScore).toBe(1);
    expect(visible.qualityComponents.fitScore).toBeLessThan(1);
    expect(visible.qualityComponents.fitScore).toBeGreaterThanOrEqual(0);
  });

  it("el resultado declara las constantes aplicadas y su procedencia heurística", () => {
    const r = expectEvaluated(calculateWeightTrend(windowInput(P2_NOISY_DECLINE_15)));
    expect(r.smoothing).toEqual({ medianWindowSize: 3, ewmaAlpha: 0.2, provenance: "heuristic_inherited_from_v3_1" });
    expect(r.qualityModel).toEqual({
      quantityTargetCount: 14,
      spanTargetDays: 21,
      highMinCombinedScore: 0.85,
      moderateMinCombinedScore: 0.65,
      flatSeriesEpsilonKgSquared: 1e-6,
      provenance: "heuristic_inherited_from_v3_1",
    });
    expect(r.coverage.minimumMeasurementsRequired).toBe(3);
  });
});

// ─── Propiedades que reexpresan una fórmula del contrato ──────────────────
// Estas pruebas recalculan la fórmula documentada con aritmética propia o comprueban una
// identidad del contrato (combinedScore, weeklyChange*, umbrales de nivel). Son pruebas de
// propiedades: detectan regresiones, pero NO son evidencia independiente de que la fórmula
// sea correcta, porque comparten la especificación con el kernel. La evidencia independiente
// son los fixtures literales de arriba y la paridad capturada de v3.1 de más abajo.

describe("propiedades que reexpresan fórmulas del contrato — no son evidencia independiente", () => {
  it("80, 79, 78 en días consecutivos: mediana, EWMA, regresión, semanal y calidad", () => {
    const m0 = (80 + 79) / 2; // borde: mediana de 2 valores = su promedio
    const m1 = 79; // interior: mediana de [80, 79, 78]
    const m2 = (79 + 78) / 2;
    const e0 = m0; // el EWMA arranca en el primer punto ya suavizado
    const e1 = 0.2 * m1 + (1 - 0.2) * e0;
    const e2 = 0.2 * m2 + (1 - 0.2) * e1;
    const yMean = (e0 + e1 + e2) / 3;
    const slope = ((0 - 1) * (e0 - yMean) + (1 - 1) * (e1 - yMean) + (2 - 1) * (e2 - yMean)) / ((0 - 1) ** 2 + (1 - 1) ** 2 + (2 - 1) ** 2);
    const q = 3 / 14;
    const t = 2 / 21;
    const r = 1; // huecos idénticos → desviación 0
    const ssTot = (e0 - yMean) ** 2 + (e1 - yMean) ** 2 + (e2 - yMean) ** 2;
    const ssRes = (e0 - (yMean + slope * (0 - 1))) ** 2 + (e1 - (yMean + slope * (1 - 1))) ** 2 + (e2 - (yMean + slope * (2 - 1))) ** 2;
    const f = 1 - ssRes / ssTot;
    const combined = (q + t + r + f) / 4;

    const result = expectEvaluated(calculateWeightTrend(windowInput(series("2026-09-26", [80, 79, 78]))));
    expect(result.latestWeightKg).toBe(78);
    expect(result.trendWeightKg).toBeCloseTo(e2, 12);
    expect(result.slopeKgPerDay).toBeCloseTo(slope, 12);
    expect(result.weeklyChangeKg).toBeCloseTo(slope * 7, 12);
    expect(result.weeklyChangePercent).toBeCloseTo(((slope * 7) / e2) * 100, 12);
    expect(result.measurementSpanDays).toBe(2);
    expect(result.qualityComponents.quantityScore).toBeCloseTo(q, 12);
    expect(result.qualityComponents.temporalCoverageScore).toBeCloseTo(t, 12);
    expect(result.qualityComponents.regularityScore).toBe(r);
    expect(result.qualityComponents.fitScore).toBeCloseTo(f, 12);
    expect(result.qualityComponents.combinedScore).toBeCloseTo(combined, 12);
    expect(result.trendQualityLevel).toBe("low");
  });

  it("huecos irregulares: la regresión usa días de calendario, no índices de array", () => {
    // Días 0, 1 y 5 desde la primera medición (brecha de 4 días al final).
    const m0 = (80 + 79) / 2;
    const m1 = 79; // mediana de [80, 79, 78.5]
    const m2 = (79 + 78.5) / 2;
    const e0 = m0;
    const e1 = 0.2 * m1 + (1 - 0.2) * e0;
    const e2 = 0.2 * m2 + (1 - 0.2) * e1;
    const yMean = (e0 + e1 + e2) / 3;
    const days = [0, 1, 5];
    const dayMean = (0 + 1 + 5) / 3;
    const numerator = (days[0] - dayMean) * (e0 - yMean) + (days[1] - dayMean) * (e1 - yMean) + (days[2] - dayMean) * (e2 - yMean);
    const denominator = (days[0] - dayMean) ** 2 + (days[1] - dayMean) ** 2 + (days[2] - dayMean) ** 2;
    const slopeByCalendarDays = numerator / denominator;
    const slopeByIndex = (e2 - e0) / 2; // con x = 0, 1, 2 (incorrecto)

    const rows: WeightTrendMeasurement[] = [
      { dateKey: "2026-09-20", kg: 80 },
      { dateKey: "2026-09-21", kg: 79 },
      { dateKey: "2026-09-25", kg: 78.5 },
    ];
    const result = expectEvaluated(calculateWeightTrend(windowInput(rows)));
    expect(result.slopeKgPerDay).toBeCloseTo(slopeByCalendarDays, 12);
    expect(Math.abs(result.slopeKgPerDay - slopeByIndex)).toBeGreaterThan(0.05);
    expect(result.measurementSpanDays).toBe(5);
  });

  it("los componentes son los de v3.1 y combinedScore es su promedio simple, sumado de izquierda a derecha", () => {
    for (const rows of [P1_CONSTANT_15, P2_NOISY_DECLINE_15, P3_IRREGULAR_6, P4_MINIMUM_3, P5_WINDOW_29]) {
      const c = expectEvaluated(calculateWeightTrend(windowInput(rows))).qualityComponents;
      for (const component of [c.quantityScore, c.temporalCoverageScore, c.regularityScore, c.fitScore, c.combinedScore]) {
        expect(component).toBeGreaterThanOrEqual(0);
        expect(component).toBeLessThanOrEqual(1);
      }
      // Misma expresión, mismo orden: igualdad estricta de esta operación concreta.
      expect(c.combinedScore).toBe((c.quantityScore + c.temporalCoverageScore + c.regularityScore + c.fitScore) / 4);
    }
  });

  it("weeklyChangeKg y weeklyChangePercent se reconstruyen desde slopeKgPerDay y trendWeightKg", () => {
    for (const rows of [P2_NOISY_DECLINE_15, P3_IRREGULAR_6, P5_WINDOW_29]) {
      const r = expectEvaluated(calculateWeightTrend(windowInput(rows)));
      expect(r.weeklyChangeKg).toBeCloseTo(r.slopeKgPerDay * 7, 12);
      expect(r.weeklyChangePercent).toBeCloseTo((r.weeklyChangeKg / r.trendWeightKg) * 100, 12);
    }
  });

  it("umbrales de nivel: barrido determinista de 600 series → nivel = f(combinedScore) con 0,85 y 0,65 inclusivos", () => {
    // Los umbrales son inclusivos (>=) por paridad con v3.1. No se ha encontrado ninguna serie
    // que dé exactamente 0,85 ni 0,65 (sería una igualdad exacta de coma flotante), así que con
    // el dominio alcanzable `>=` y `>` no se distinguen desde la API pública: el mutante `>=`→`>`
    // es observacionalmente equivalente. No se fabrica una igualdad artificial para forzarlo.
    const seen = { high: 0, moderate: 0, low: 0 };
    for (let seed = 1; seed <= 600; seed++) {
      const rows = seededMeasurements(seed);
      const r = expectEvaluated(calculateWeightTrend(windowInput(rows)));
      const combined = r.qualityComponents.combinedScore;
      const expected = combined >= 0.85 ? "high" : combined >= 0.65 ? "moderate" : "low";
      expect({ seed, level: r.trendQualityLevel }).toEqual({ seed, level: expected });
      seen[expected] += 1;
      // Mismo resultado con la serie recibida al revés.
      expect(calculateWeightTrend(windowInput([...rows].reverse()))).toEqual(r);
      expect(collectNumbers(r).every(Number.isFinite)).toBe(true);
    }
    expect(seen.high).toBeGreaterThan(20);
    expect(seen.moderate).toBeGreaterThan(20);
    expect(seen.low).toBeGreaterThan(20);
  });
});

// ─── Paridad con v3.1 (fixtures reproducidos) ─────────────────────────────
// Valores capturados de la función real calcWeightTrend con referencia
// 2026-09-28 y windowDays 28. El redondeo legacy se aplica aquí, en la
// prueba. Ver la tabla de paridad del roadmap.

describe("paridad con v3.1 — donde ambos motores deben coincidir", () => {
  interface LegacyFixture {
    name: string;
    rows: WeightTrendMeasurement[];
    legacy: Pick<LegacyWeightTrendResult, "trendWeightKg" | "slopeKgPerDay" | "weeklyChangeKg" | "weeklyChangePercent" | "validMeasurements" | "confidence" | "qualityScore">;
    components: { quantityScore: number; temporalCoverageScore: number; regularityScore: number; fitScore: number };
  }
  const FIXTURES: LegacyFixture[] = [
    {
      name: "P1 — 15 días, peso constante 80,0",
      rows: P1_CONSTANT_15,
      legacy: { trendWeightKg: 80, slopeKgPerDay: 0, weeklyChangeKg: 0, weeklyChangePercent: 0, validMeasurements: 15, confidence: "high", qualityScore: 0.9166666666666666 },
      components: { quantityScore: 1, temporalCoverageScore: 0.6666666666666666, regularityScore: 1, fitScore: 1 },
    },
    {
      name: "P2 — 15 días con ruido y descenso",
      rows: P2_NOISY_DECLINE_15,
      legacy: { trendWeightKg: 79.4, slopeKgPerDay: -0.0697, weeklyChangeKg: -0.49, weeklyChangePercent: -0.6, validMeasurements: 15, confidence: "high", qualityScore: 0.9094919135528291 },
      components: { quantityScore: 1, temporalCoverageScore: 0.6666666666666666, regularityScore: 1, fitScore: 0.9713009875446499 },
    },
    {
      name: "P3 — 6 mediciones irregulares (amplitud 27 días)",
      rows: P3_IRREGULAR_6,
      legacy: { trendWeightKg: 81.5, slopeKgPerDay: -0.016, weeklyChangeKg: -0.11, weeklyChangePercent: -0.1, validMeasurements: 6, confidence: "moderate", qualityScore: 0.6895691809801114 },
      components: { quantityScore: 0.42857142857142855, temporalCoverageScore: 1, regularityScore: 0.3959442062851819, fitScore: 0.9337610890638355 },
    },
    {
      name: "P4 — mínimo de 3 mediciones",
      rows: P4_MINIMUM_3,
      legacy: { trendWeightKg: 69.9, slopeKgPerDay: -0.0025, weeklyChangeKg: -0.02, weeklyChangePercent: 0, validMeasurements: 3, confidence: "low", qualityScore: 0.5386904761904762 },
      components: { quantityScore: 0.21428571428571427, temporalCoverageScore: 0.19047619047619047, regularityScore: 1, fitScore: 0.75 },
    },
    {
      name: "P5 — 29 fechas, de referencia−28 a referencia",
      rows: P5_WINDOW_29,
      legacy: { trendWeightKg: 73.8, slopeKgPerDay: -0.0444, weeklyChangeKg: -0.31, weeklyChangePercent: -0.4, validMeasurements: 29, confidence: "high", qualityScore: 0.9979277926310486 },
      components: { quantityScore: 1, temporalCoverageScore: 1, regularityScore: 1, fitScore: 0.9917111705241942 },
    },
  ];

  for (const fixture of FIXTURES) {
    it(`${fixture.name}: tras el redondeo legacy coincide con v3.1; calidad idéntica bit a bit`, () => {
      const r = expectEvaluated(calculateWeightTrend(windowInput(fixture.rows)));
      expect(round1(r.trendWeightKg)).toBe(fixture.legacy.trendWeightKg);
      expect(round4(r.slopeKgPerDay)).toBe(fixture.legacy.slopeKgPerDay);
      expect(round2(r.weeklyChangeKg)).toBe(fixture.legacy.weeklyChangeKg);
      expect(round1(r.weeklyChangePercent)).toBeCloseTo(fixture.legacy.weeklyChangePercent, 12);
      expect(r.coverage.measurementsInWindow).toBe(fixture.legacy.validMeasurements);
      expect(r.trendQualityLevel).toBe(fixture.legacy.confidence);
      // v3.1 no redondeaba qualityScore: la operación aritmética es idéntica.
      expect(r.qualityComponents.combinedScore).toBe(fixture.legacy.qualityScore);
      expect(r.qualityComponents.quantityScore).toBe(fixture.components.quantityScore);
      expect(r.qualityComponents.temporalCoverageScore).toBe(fixture.components.temporalCoverageScore);
      expect(r.qualityComponents.regularityScore).toBe(fixture.components.regularityScore);
      expect(r.qualityComponents.fitScore).toBe(fixture.components.fitScore);
    });
  }

  it("P5: la medición de referencia−28 entra y la de referencia−29 queda fuera (ventana de 29 fechas)", () => {
    const withOlder = [{ dateKey: "2026-08-30", kg: 99.9 }, ...P5_WINDOW_29];
    const baseline = expectEvaluated(calculateWeightTrend(windowInput(P5_WINDOW_29)));
    const result = expectEvaluated(calculateWeightTrend(windowInput(withOlder)));
    expect(baseline.coverage.windowCalendarDays).toBe(29);
    expect(baseline.coverage.measurementsInWindow).toBe(29);
    expect(result).toEqual(baseline);
    expect(expectEvaluated(calculateWeightTrend(windowInput(P5_WINDOW_29.slice(1)))).coverage.measurementsInWindow).toBe(28);
  });
});

// ─── Divergencias deliberadas respecto a v3.1 ─────────────────────────────

describe("divergencia deliberada respecto a v3.1 — el valor legacy y el de PR5A difieren a propósito", () => {
  it("trendWeightKg sin redondeo previo: P2 → legacy 79,4; PR5A 79,3834917805261", () => {
    const r = expectEvaluated(calculateWeightTrend(windowInput(P2_NOISY_DECLINE_15)));
    expect(r.trendWeightKg).toBeCloseTo(79.3834917805261, 12);
    expect(r.trendWeightKg).not.toBe(79.4);
  });

  it("weeklyChangePercent sin doble redondeo: 21 mediciones → legacy 0,1; PR5A 0,049432773355047865", () => {
    const r = expectEvaluated(calculateWeightTrend(windowInput(D4_TWENTY_ONE)));
    // v3.1 dividía 0,04 (kg/semana ya redondeado a 2 decimales) entre 72,3
    // (tendencia ya redondeada a 1): 0,04 / 72,3 · 100 → 0,1.
    expect(r.weeklyChangeKg).toBeCloseTo(0.0357363442323988, 12);
    expect(r.trendWeightKg).toBeCloseTo(72.29281670224063, 12);
    expect(r.weeklyChangePercent).toBeCloseTo(0.049432773355047865, 12);
    expect(round1(r.weeklyChangePercent)).not.toBe(0.1);
  });

  // Otras divergencias de este kernel se fijan donde ya hay un test equivalente, sin repetirlo:
  //  · D1 (fecha duplicada): «dateKey duplicada dentro de la ventana», en las fases 3 a 5.
  //  · «menos de 3 mediciones»: v3.1 devolvía null; PR5A devuelve `insufficient_data` con
  //    cobertura, fijado en «suficiencia» (0 y 2 mediciones).
});

// ─── Dominio de fechas ────────────────────────────────────────────────────

describe("dominio de fechas — 0001-01-01 a 9999-12-31, gregoriano proléptico, sin año cero", () => {
  const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

  it("extremos del dominio: ventana de 3.652.059 días de calendario, sin enumerar", () => {
    const result = expectInsufficient(calculateWeightTrend({ startDateKey: "0001-01-01", endDateKey: "9999-12-31", measurements: [] }));
    expect(result.coverage.windowCalendarDays).toBe(3652059);
    expect(Number.isSafeInteger(result.coverage.windowCalendarDays)).toBe(true);
  });

  it("año 0000 rechazado como límite y como fecha de fila", () => {
    expect(expectInvalid(calculateWeightTrend({ startDateKey: "0000-01-01", endDateKey: "0001-01-01", measurements: [] })).reasons).toEqual(["start_date_key_invalid"]);
    expect(expectInvalid(calculateWeightTrend({ startDateKey: "0001-01-01", endDateKey: "0000-12-31", measurements: [] })).reasons).toEqual(["end_date_key_invalid"]);
  });

  it("bisiestos: 2000 y 2024 sí; 1900 y 2100 no", () => {
    for (const [year, valid] of [[2000, true], [2024, true], [1900, false], [2100, false]] as const) {
      const row = { dateKey: `${year}-02-29`, kg: 80 };
      const result = calculateWeightTrend({ startDateKey: "0001-01-01", endDateKey: "9999-12-31", measurements: [row] });
      expect(result.status).toBe(valid ? "insufficient_data" : "invalid_input");
    }
  });

  it("último día de cada mes (año no bisiesto y bisiesto) válido; el día siguiente, inválido", () => {
    const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (const [year, february] of [[2026, 28], [2028, 29]] as const) {
      lengths.forEach((baseLength, index) => {
        const length = index === 1 ? february : baseLength;
        const month = String(index + 1).padStart(2, "0");
        const base = { startDateKey: "0001-01-01", endDateKey: "9999-12-31" };
        const last = calculateWeightTrend({ ...base, measurements: [{ dateKey: `${year}-${month}-${String(length).padStart(2, "0")}`, kg: 80 }] });
        const beyond = calculateWeightTrend({ ...base, measurements: [{ dateKey: `${year}-${month}-${String(length + 1).padStart(2, "0")}`, kg: 80 }] });
        expect(last.status).toBe("insufficient_data");
        expect(beyond.status).toBe("invalid_input");
      });
    }
  });

  it("recorre los años 1…9999 por la API pública: 365/366 días por año y 2 días entre el 31-dic y el 1-ene siguiente", () => {
    const failures: string[] = [];
    for (let year = 1; year <= 9999; year++) {
      const y = String(year).padStart(4, "0");
      const yearResult = calculateWeightTrend({ startDateKey: `${y}-01-01`, endDateKey: `${y}-12-31`, measurements: [] });
      if (yearResult.status !== "insufficient_data" || yearResult.coverage.windowCalendarDays !== (isLeap(year) ? 366 : 365)) failures.push(`${y}: año`);
      if (year < 9999) {
        const next = String(year + 1).padStart(4, "0");
        const bridge = calculateWeightTrend({ startDateKey: `${y}-12-31`, endDateKey: `${next}-01-01`, measurements: [] });
        if (bridge.status !== "insufficient_data" || bridge.coverage.windowCalendarDays !== 2) failures.push(`${y}: cambio de año`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("transiciones mensuales representativas: fin de mes, febrero no bisiesto, bisiesto y regla del siglo", () => {
    // [inicio, fin, días de calendario con ambos extremos incluidos], deducidos a mano.
    const cases: Array<[string, string, number]> = [
      ["2026-01-31", "2026-02-01", 2], // enero → febrero
      ["2026-04-30", "2026-05-01", 2], // mes de 30 días
      ["2026-02-28", "2026-03-01", 2], // febrero no bisiesto: no existe el 29
      ["2028-02-28", "2028-03-01", 3], // febrero bisiesto: 28, 29 y 1 de marzo
      ["2028-02-29", "2028-03-01", 2],
      ["1900-02-28", "1900-03-01", 2], // 1900 no es bisiesto (regla del siglo)
      ["2000-02-28", "2000-03-01", 3], // 2000 sí lo es (divisible por 400)
    ];
    for (const [startDateKey, endDateKey, days] of cases) {
      const result = expectInsufficient(calculateWeightTrend({ startDateKey, endDateKey, measurements: [] }));
      expect({ startDateKey, endDateKey, days: result.coverage.windowCalendarDays }).toEqual({ startDateKey, endDateKey, days });
    }
  });

  it("mediciones separadas por milenios dentro de una ventana enorme → resultado finito", () => {
    const rows: WeightTrendMeasurement[] = [
      { dateKey: "0001-01-01", kg: 80 },
      { dateKey: "5000-06-15", kg: 79 },
      { dateKey: "9999-12-31", kg: 78 },
    ];
    const r = expectEvaluated(calculateWeightTrend({ startDateKey: "0001-01-01", endDateKey: "9999-12-31", measurements: rows }));
    expect(r.measurementSpanDays).toBe(3652058);
    expect(r.coverage.windowCalendarDays).toBe(3652059);
    expect(r.qualityComponents.temporalCoverageScore).toBe(1);
    expect(collectNumbers(r).every(Number.isFinite)).toBe(true);
  });

  it("diferencia histórica explícita: 29 fechas para el equivalente legacy de peso y 28 para el de ingesta, calculadas por el llamador", () => {
    // El kernel solo recibe fechas: 2026-08-31…2026-09-28 (referencia−28…referencia).
    expect(expectInsufficient(calculateWeightTrend(windowInput([], { startDateKey: "2026-08-31", endDateKey: "2026-09-28" }))).coverage.windowCalendarDays).toBe(29);
    // Una ventana de 28 fechas (referencia−27…referencia) se expresa igual de fácil.
    expect(expectInsufficient(calculateWeightTrend(windowInput([], { startDateKey: "2026-09-01", endDateKey: "2026-09-28" }))).coverage.windowCalendarDays).toBe(28);
  });
});

// ─── Seguridad numérica ───────────────────────────────────────────────────

describe("seguridad numérica — nunca un evaluated con NaN, infinito o entero inseguro", () => {
  it("pesos finitos cuya mediana de borde desborda (1e308 × 3) → derived_numeric_result_invalid, sin resultado parcial", () => {
    const result = expectInvalid(calculateWeightTrend(windowInput(series("2026-09-26", [1e308, 1e308, 1e308]))));
    expect(result).toEqual({ status: "invalid_input", reasons: ["derived_numeric_result_invalid"] });
  });

  it("pesos finitos que desbordan solo al elevar al cuadrado (varianza total): 1e200…4e200", () => {
    const rows = series("2026-09-25", [1e200, 2e200, 3e200, 4e200]);
    // Ninguna mediana, EWMA ni pendiente es infinita; sí lo es Σ(e − media)².
    expect(expectInvalid(calculateWeightTrend(windowInput(rows)))).toEqual({ status: "invalid_input", reasons: ["derived_numeric_result_invalid"] });
  });

  it("todos los números de un resultado evaluated son finitos y los contadores, enteros seguros", () => {
    for (const rows of [P1_CONSTANT_15, P2_NOISY_DECLINE_15, P3_IRREGULAR_6, P4_MINIMUM_3, P5_WINDOW_29, D4_TWENTY_ONE]) {
      const r = expectEvaluated(calculateWeightTrend(windowInput(rows)));
      expect(collectNumbers(r).every(Number.isFinite)).toBe(true);
      expect(Number.isSafeInteger(r.coverage.windowCalendarDays)).toBe(true);
      expect(Number.isSafeInteger(r.coverage.measurementsInWindow)).toBe(true);
      expect(Number.isSafeInteger(r.measurementSpanDays)).toBe(true);
    }
  });

  it("pesos positivos muy pequeños pero finitos no producen NaN: o evaluated finito o error tipado", () => {
    const result = calculateWeightTrend(windowInput(series("2026-09-26", [5e-324, 5e-324, 5e-324])));
    if (result.status === "evaluated") expect(collectNumbers(result).every(Number.isFinite)).toBe(true);
    else expect(result.status).toBe("invalid_input");
  });
});

// ─── Determinismo, canonicalización, inmutabilidad ────────────────────────

describe("determinismo y canonicalización", () => {
  it("las 120 permutaciones de las mediciones producen el mismo resultado completo", () => {
    const rows = P3_IRREGULAR_6.slice(0, 5);
    const baseline = calculateWeightTrend(windowInput(rows));
    for (const permutation of permutations(rows)) {
      expect(calculateWeightTrend(windowInput(permutation))).toEqual(baseline);
    }
  });

  it("las razones de error no dependen del orden de las filas (todas las permutaciones)", () => {
    const rows = [
      { dateKey: "2026-09-20", kg: -1 },
      { dateKey: "2026-09-20", kg: 80 },
      { dateKey: "2026-09-21", kg: Number.NaN },
      { dateKey: "2026-08-01", kg: "corrupto" },
    ] as unknown as WeightTrendMeasurement[];
    for (const permutation of permutations(rows)) {
      expect(expectInvalid(calculateWeightTrend(windowInput(permutation))).reasons).toEqual(["measurement_weight_invalid", "measurement_date_key_duplicate"]);
    }
  });

  it("las razones de fila entera tampoco dependen del orden", () => {
    const rows = [5, { dateKey: "no-fecha", kg: 80 }, { dateKey: "2026-09-20", kg: -1 }] as unknown as WeightTrendMeasurement[];
    for (const permutation of permutations(rows)) {
      expect(expectInvalid(calculateWeightTrend(windowInput(permutation))).reasons).toEqual(["measurement_object_invalid", "measurement_date_key_invalid"]);
    }
  });

  it("misma entrada → mismo resultado, profundamente idéntico", () => {
    expect(calculateWeightTrend(windowInput(P2_NOISY_DECLINE_15))).toEqual(calculateWeightTrend(windowInput(JSON.parse(JSON.stringify(P2_NOISY_DECLINE_15)))));
  });
});

describe("razones de error — cada razón declarada es alcanzable y sobrevive a la canonicalización", () => {
  // Record exhaustivo: si la unión gana una razón sin entrada aquí, el typecheck falla. Y si
  // el orden canónico del kernel no la incluyera, la razón desaparecería del resultado y este
  // test fallaría en ejecución (el kernel además lo rechaza al compilar).
  const TRIGGERS: Record<WeightTrendEstimateInvalidReason, () => unknown> = {
    input_object_invalid: () => null,
    start_date_key_invalid: () => windowInput([], { startDateKey: "no-es-fecha" }),
    end_date_key_invalid: () => windowInput([], { endDateKey: "2026-02-30" }),
    date_window_order_invalid: () => windowInput([], { startDateKey: "2026-09-28", endDateKey: "2026-09-27" }),
    measurements_not_array: () => ({ startDateKey: WINDOW_START, endDateKey: WINDOW_END, measurements: "no-array" }),
    measurement_object_invalid: () => windowInput([null as unknown as WeightTrendMeasurement]),
    measurement_date_key_invalid: () => windowInput([{ dateKey: "2026-13-01", kg: 80 }]),
    measurement_weight_invalid: () => windowInput([{ dateKey: "2026-09-10", kg: -1 }]),
    measurement_date_key_duplicate: () =>
      windowInput([
        { dateKey: "2026-09-10", kg: 80 },
        { dateKey: "2026-09-10", kg: 80 },
      ]),
    derived_numeric_result_invalid: () => windowInput(series("2026-09-26", [1e308, 1e308, 1e308])),
  };

  it("cada disparador produce exactamente su razón, sola y en el resultado", () => {
    for (const [reason, build] of Object.entries(TRIGGERS)) {
      expect(calculateWeightTrend(build() as WeightTrendEstimateInput)).toEqual({ status: "invalid_input", reasons: [reason] });
    }
  });
});

describe("inmutabilidad, independencia entre llamadas y datos JSON-like", () => {
  it("una entrada profundamente congelada no lanza y queda intacta", () => {
    const rows = deepFreeze(P2_NOISY_DECLINE_15.map((row) => ({ ...row })));
    const input = deepFreeze({ startDateKey: WINDOW_START, endDateKey: WINDOW_END, measurements: rows });
    const snapshot = JSON.parse(JSON.stringify(input));
    expect(() => calculateWeightTrend(input)).not.toThrow();
    expect(input).toEqual(snapshot);
  });

  it("el orden de la entrada no se altera al ordenar internamente", () => {
    const reversed = [...P2_NOISY_DECLINE_15].reverse();
    const before = JSON.parse(JSON.stringify(reversed));
    calculateWeightTrend(windowInput(reversed));
    expect(reversed).toEqual(before);
  });

  it("independencia entre llamadas: alterar un resultado devuelto no modifica el de una llamada posterior", () => {
    const inputs = [
      windowInput(P2_NOISY_DECLINE_15), // evaluated
      windowInput(P4_MINIMUM_3.slice(0, 2)), // insufficient_data
      windowInput([], { startDateKey: "no-es-fecha" }), // invalid_input
    ];
    for (const input of inputs) {
      const baseline = JSON.parse(JSON.stringify(calculateWeightTrend(input)));
      const first = calculateWeightTrend(input);
      corrupt(first);
      expect(first).not.toEqual(baseline); // la alteración tuvo efecto sobre el objeto devuelto…
      expect(calculateWeightTrend(input)).toEqual(baseline); // …y no se filtra a la llamada siguiente
    }
  });

  // El contrato cubre datos ordinarios de tipo JSON, incluidos los estructuralmente inválidos.
  // Objetos hostiles (getters que lanzan, proxies revocados) quedan fuera del contrato.
  it("no lanza para una combinación amplia de valores JSON-like estructuralmente inválidos", () => {
    const garbage: unknown[] = [
      null, undefined, 0, "x", [], {},
      { startDateKey: "bogus" },
      { measurements: "bogus" },
      { startDateKey: WINDOW_START, endDateKey: WINDOW_END, measurements: [{}] },
      { startDateKey: WINDOW_START, endDateKey: WINDOW_END, measurements: [null, 1, "a", []] },
      { startDateKey: WINDOW_START, endDateKey: WINDOW_END, measurements: [{ dateKey: "2026-09-10", kg: {} }] },
    ];
    for (const input of garbage) {
      expect(() => calculateWeightTrend(input as unknown as WeightTrendEstimateInput)).not.toThrow();
    }
  });
});

// ─── API pública del barrel ────────────────────────────────────────────────

describe("barrel — solo las dos funciones de PR5A son públicas", () => {
  const PRIVATE_NAMES = [
    "isRecordObject",
    "isLeapYear",
    "isValidCalendarDateKey",
    "dayNumber",
    "compareDateKeys",
    "invalidInput",
    "NonFiniteDerivedValueError",
    "assertFinite",
    "validateRequest",
    "medianOfWindow",
    "sumInOrder",
    "qualityLevelOf",
    "computeEvaluated",
    "MINIMUM_MEASUREMENTS",
    "MEDIAN_WINDOW_SIZE",
    "MEDIAN_HALF_WIDTH",
    "EWMA_ALPHA",
    "QUANTITY_TARGET_COUNT",
    "SPAN_TARGET_DAYS",
    "HIGH_MIN_COMBINED_SCORE",
    "MODERATE_MIN_COMBINED_SCORE",
    "FLAT_SERIES_EPSILON_KG_SQUARED",
    "DAYS_PER_WEEK",
    "DATE_KEY_PATTERN",
    "DAYS_IN_MONTH",
    "INVALID_REASON_ORDER",
  ];

  it("expone calculateWeightTrend y calculateIntakeLoggingCoverage, y ninguna declaración privada de este kernel", () => {
    const barrel = engineBarrel as Record<string, unknown>;
    expect(typeof barrel.calculateWeightTrend).toBe("function");
    expect(typeof barrel.calculateIntakeLoggingCoverage).toBe("function");
    for (const name of PRIVATE_NAMES) expect(barrel[name]).toBeUndefined();
  });

  it("la lista de nombres privados cubre todas las declaraciones de nivel superior del kernel (no queda obsoleta)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fileName = join(here, "weight-trend-kernel.ts");
    const sourceFile = ts.createSourceFile(fileName, readFileSync(fileName, "utf-8"), ts.ScriptTarget.Latest, true);
    const declared: string[] = [];
    for (const statement of sourceFile.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declared.push(statement.name.text);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) declared.push(declaration.name.text);
      }
    }
    const publicNames = ["calculateWeightTrend"];
    expect(declared.filter((name) => !publicNames.includes(name) && !PRIVATE_NAMES.includes(name))).toEqual([]);
    expect(declared).toContain("calculateWeightTrend");
  });

  it("calculateWeightTrend importado desde el barrel se comporta igual que el import directo", () => {
    const input = windowInput(P2_NOISY_DECLINE_15);
    expect(engineBarrel.calculateWeightTrend(input)).toEqual(calculateWeightTrend(input));
  });
});

// ─── Tipos ────────────────────────────────────────────────────────────────

/** Comprobación de tipos, no de ejecución: el nombre del contrato de PR5A
    resuelve al de PR5A, no al `WeightTrendResult` homónimo de v3.1 (que no
    tiene `status`). Falla en compilación si un `export *` quedara tapado. */
function _typeChecksNeverCalled(): void {
  type Assert<T extends true> = T;
  type HasStatus<T> = T extends { status: string } ? true : false;
  type _EstimateHasStatus = Assert<HasStatus<WeightTrendEstimateResult>>;
  // @ts-expect-error — el tipo homónimo de v3.1 no tiene `status`.
  type _LegacyHasNoStatus = Assert<HasStatus<LegacyWeightTrendResult>>;
}

describe("tipos — sin colisión con el WeightTrendResult de v3.1", () => {
  it("marcador — el contenido real son las aserciones de tipos de _typeChecksNeverCalled", () => {
    expect(typeof _typeChecksNeverCalled).toBe("function");
  });
});

// ─── Pureza y alcance (AST real, alcance declarado) ───────────────────────
//
// El visitor detecta ACCESOS DIRECTOS prohibidos (new Date, Date.now,
// Math.random, process.env) e IDENTIFICADORES GLOBALES sueltos (fetch,
// localStorage…) tal como aparecen escritos: no es un análisis de flujo de
// datos y no detecta alias ni desestructuración. La comprobación de imports
// es, en cambio, exacta: lista los especificadores de módulo declarados.

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
  const kernelFile = join(here, "weight-trend-kernel.ts");
  const kernelSource = readFileSync(kernelFile, "utf-8");

  it("el AST no contiene accesos directos a Date, reloj, aleatoriedad, red, almacenamiento, estado global ni localeCompare", () => {
    expect(findForbiddenDirectRuntimeReferences(kernelSource, kernelFile)).toEqual([]);
  });

  it("el único import del kernel es de tipos de @foodos/types — nada de apps/web, PR3, PR4, Supabase, red ni filesystem", () => {
    const specifiers = collectImportModuleSpecifiers(kernelSource, kernelFile);
    expect(specifiers).toEqual(["@foodos/types"]);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/apps\/web|supabase|node:|undici|axios|weekly-|exercise-|macro-|nutrition-/i);
    }
  });

  it("el kernel y su contrato no contienen conocimiento sobre sesiones, calibración, persistencia, Supabase ni el coordinador", () => {
    const contractFile = join(here, "..", "..", "types", "src", "weight-trend.ts");
    for (const [name, source] of [["kernel", kernelSource], ["contrato", readFileSync(contractFile, "utf-8")]] as const) {
      expect({ name, offending: source.match(/calibrat|supabase|session|sesi[oó]n|coordinat|persist/gi) }).toEqual({ name, offending: null });
    }
  });
});
