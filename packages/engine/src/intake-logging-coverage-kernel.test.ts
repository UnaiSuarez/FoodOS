import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import type {
  IntakeCoverageResult as LegacyIntakeCoverageResult,
  IntakeLoggingCoverageEvaluated,
  IntakeLoggingCoverageInput,
  IntakeLoggingCoverageInvalidInput,
  IntakeLoggingCoverageInvalidReason,
  IntakeLoggingCoverageResult,
  LoggedIntakeRecord,
} from "@foodos/types";
import { calculateIntakeLoggingCoverage } from "./intake-logging-coverage-kernel";
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

function rec(dateKey: string, loggedKcal: number, targetKcalForDay: number | null = null): LoggedIntakeRecord {
  return { dateKey, loggedKcal, targetKcalForDay };
}

// Ventana de 28 fechas (referencia−27 … referencia): la del equivalente legacy
// de ingesta. La calcula el llamador; el kernel solo recibe las dos fechas.
const WINDOW_START = "2026-09-01";
const WINDOW_END = "2026-09-28";

function windowInput(records: readonly LoggedIntakeRecord[], overrides: Partial<IntakeLoggingCoverageInput> = {}): IntakeLoggingCoverageInput {
  return { startDateKey: WINDOW_START, endDateKey: WINDOW_END, records, ...overrides };
}

function expectEvaluated(result: IntakeLoggingCoverageResult): IntakeLoggingCoverageEvaluated {
  if (result.status !== "evaluated") throw new Error(`esperado evaluated, recibido ${JSON.stringify(result)}`);
  return result;
}
function expectInvalid(result: IntakeLoggingCoverageResult): IntakeLoggingCoverageInvalidInput {
  if (result.status !== "invalid_input") throw new Error(`esperado invalid_input, recibido ${JSON.stringify(result)}`);
  return result;
}

// Redondeos de PRESENTACIÓN de v3.1: se aplican del lado de la prueba.
const round2 = (value: number): number => Math.round(value * 100) / 100;
const legacyAverage = (value: number): number => Math.round(value);

const WINDOW_DAYS: string[] = Array.from({ length: 28 }, (_, index) => addDays(WINDOW_START, index));

// Diez días (09-19 … 09-28) con la mezcla que usó la captura de v3.1.
const MIXED_KCAL = [2000, 2000, 0, 300, 700, 1500, 1499, 2100, 2200, 1900];
const MIXED_DATES = MIXED_KCAL.map((_, index) => addDays("2026-09-19", index));
const MIXED_NO_TARGETS = MIXED_KCAL.map((kcal, index) => rec(MIXED_DATES[index], kcal));
const MIXED_WITH_TARGETS = MIXED_KCAL.map((kcal, index) => rec(MIXED_DATES[index], kcal, 2500));

// Seis valores (09-20 … 09-25) cuya suma depende del orden: ascendente
// 13890.210000000001, descendente 13890.21.
const ORDER_DEPENDENT_KCAL = [2804.84, 2872.99, 1611.84, 2996.06, 1814.45, 1790.03];
const ORDER_DEPENDENT = ORDER_DEPENDENT_KCAL.map((kcal, index) => rec(addDays("2026-09-20", index), kcal));
const ORDER_DEPENDENT_ASCENDING_TOTAL = 13890.210000000001;
const ORDER_DEPENDENT_DESCENDING_TOTAL = 13890.21;

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

/** Generador congruencial determinista: el barrido no depende de Math.random. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Registros sintéticos dentro de la ventana por defecto, con y sin objetivo. */
function seededRecords(seed: number): LoggedIntakeRecord[] {
  const next = lcg(seed);
  const offsets = Array.from({ length: 28 }, (_, index) => index);
  for (let index = offsets.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [offsets[index], offsets[other]] = [offsets[other], offsets[index]];
  }
  const count = Math.floor(next() * 29);
  return offsets.slice(0, count).map((offset) => {
    const target = next() < 0.5 ? null : 1500 + Math.floor(next() * 2000);
    const kcal = Math.round(next() * 4000 * 100) / 100;
    return rec(addDays(WINDOW_START, offset), kcal, target);
  });
}

// ─── Fase 1 — forma superior y ventana ─────────────────────────────────────

describe("fase 1 — forma superior y ventana", () => {
  it("input que no es un objeto (null, undefined, primitivo o array) → invalid_input/input_object_invalid, sin lanzar", () => {
    for (const garbage of [null, undefined, "x", 42, true, []]) {
      expect(() => calculateIntakeLoggingCoverage(garbage as unknown as IntakeLoggingCoverageInput)).not.toThrow();
      expect(calculateIntakeLoggingCoverage(garbage as unknown as IntakeLoggingCoverageInput)).toEqual({
        status: "invalid_input",
        reasons: ["input_object_invalid"],
      });
    }
  });

  it("startDateKey inválida → start_date_key_invalid", () => {
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput([], { startDateKey: "no-es-fecha" }))).reasons).toEqual(["start_date_key_invalid"]);
  });

  it("endDateKey con calendario imposible (2026-02-30) → end_date_key_invalid, sin normalización de Date", () => {
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput([], { endDateKey: "2026-02-30" }))).reasons).toEqual(["end_date_key_invalid"]);
  });

  it("ventana invertida → date_window_order_invalid; ventana de un día es válida", () => {
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput([], { startDateKey: "2026-09-28", endDateKey: "2026-09-27" }))).reasons).toEqual([
      "date_window_order_invalid",
    ]);
    const oneDay = expectEvaluated(calculateIntakeLoggingCoverage(windowInput([rec("2026-09-28", 2000)], { startDateKey: "2026-09-28", endDateKey: "2026-09-28" })));
    expect(oneDay.eligibleCalendarDays).toBe(1);
    expect(oneDay.loggingPresenceFraction).toBe(1);
  });

  it("records que no es array → records_not_array", () => {
    for (const records of ["no-array", null, undefined, {}, 5]) {
      const input = { startDateKey: WINDOW_START, endDateKey: WINDOW_END, records } as unknown as IntakeLoggingCoverageInput;
      expect(expectInvalid(calculateIntakeLoggingCoverage(input)).reasons).toEqual(["records_not_array"]);
    }
  });

  it("varios problemas de forma a la vez → todos, deduplicados y en orden canónico", () => {
    const input = { startDateKey: "x", endDateKey: "y", records: 5 } as unknown as IntakeLoggingCoverageInput;
    expect(expectInvalid(calculateIntakeLoggingCoverage(input)).reasons).toEqual(["start_date_key_invalid", "end_date_key_invalid", "records_not_array"]);
  });

  it("con una fecha límite inválida no se informa el orden de la ventana", () => {
    const result = expectInvalid(calculateIntakeLoggingCoverage(windowInput([], { startDateKey: "2026-09-30", endDateKey: "2026-13-01" })));
    expect(result.reasons).toEqual(["end_date_key_invalid"]);
  });

  it("orden de ventana + records_not_array a la vez, en orden canónico", () => {
    const input = { startDateKey: "2026-09-28", endDateKey: "2026-09-01", records: "x" } as unknown as IntakeLoggingCoverageInput;
    expect(expectInvalid(calculateIntakeLoggingCoverage(input)).reasons).toEqual(["date_window_order_invalid", "records_not_array"]);
  });
});

// ─── Fase 2 — fila entera: objeto y dateKey real ──────────────────────────

describe("fase 2 — cada registro es un objeto con dateKey real (invalida siempre)", () => {
  it("fila que no es un objeto (null, undefined, primitivo o array) → record_object_invalid", () => {
    for (const row of [null, undefined, "x", 3, []]) {
      const result = calculateIntakeLoggingCoverage(windowInput([row as unknown as LoggedIntakeRecord]));
      expect(expectInvalid(result).reasons).toEqual(["record_object_invalid"]);
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
    it(`dateKey ${JSON.stringify(dateKey) ?? "undefined"} → record_date_key_invalid`, () => {
      const row = { dateKey, loggedKcal: 2000, targetKcalForDay: null } as unknown as LoggedIntakeRecord;
      expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput([row]))).reasons).toEqual(["record_date_key_invalid"]);
    });
  }

  it("una fecha inválida invalida aunque sea imposible situar la fila dentro o fuera de la ventana", () => {
    const rows = [rec("2026-09-10", 2000), rec("1999-02-30", 2000)];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual(["record_date_key_invalid"]);
  });

  it("de una fila con fecha inválida no se evalúa ningún otro campo (ni de ella ni de las demás)", () => {
    const rows = [
      { dateKey: "2026-13-13", loggedKcal: -5, targetKcalForDay: -1 },
      { dateKey: "2026-09-10", loggedKcal: Number.NaN, targetKcalForDay: "x" },
    ] as unknown as LoggedIntakeRecord[];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual(["record_date_key_invalid"]);
  });

  it("objeto inválido y fecha inválida a la vez → ambas razones, en orden canónico", () => {
    const rows = [{ dateKey: "no-fecha", loggedKcal: 1, targetKcalForDay: null }, 7] as unknown as LoggedIntakeRecord[];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual(["record_object_invalid", "record_date_key_invalid"]);
  });
});

// ─── Fases 3 a 5 — ventana, valores, objetivo y duplicados ────────────────

describe("fases 3 a 5 — ventana, valores, objetivo y duplicados solo dentro de la ventana", () => {
  const CORRUPT_KCAL: unknown[] = [Number.NaN, Infinity, -Infinity, -1, -0.01, "2000", null, undefined, {}];
  const CORRUPT_TARGETS: unknown[] = [Number.NaN, Infinity, -Infinity, 0, -100, "2000", undefined, {}, []];

  it("loggedKcal corrupto en un registro FUERA de la ventana no invalida y no cuenta", () => {
    for (const loggedKcal of CORRUPT_KCAL) {
      const rows = [rec("2026-09-10", 2000), { dateKey: "2026-08-15", loggedKcal, targetKcalForDay: null }] as unknown as LoggedIntakeRecord[];
      const result = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows)));
      expect(result.loggedDays).toBe(1);
    }
  });

  it("loggedKcal corrupto DENTRO de la ventana → record_logged_kcal_invalid (divergencia D9: v3.1 aceptaba Infinity con promedio no finito y descartaba NaN y negativos en silencio)", () => {
    for (const loggedKcal of CORRUPT_KCAL) {
      const rows = [rec("2026-09-10", 2000), { dateKey: "2026-09-11", loggedKcal, targetKcalForDay: null }] as unknown as LoggedIntakeRecord[];
      expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual(["record_logged_kcal_invalid"]);
    }
  });

  it("registro sin la propiedad loggedKcal dentro de la ventana → record_logged_kcal_invalid", () => {
    const rows = [{ dateKey: "2026-09-11", targetKcalForDay: null }] as unknown as LoggedIntakeRecord[];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual(["record_logged_kcal_invalid"]);
  });

  it("objetivo corrupto FUERA de la ventana no invalida y no cuenta", () => {
    for (const targetKcalForDay of CORRUPT_TARGETS) {
      const rows = [rec("2026-09-10", 2000), { dateKey: "2026-09-29", loggedKcal: 2000, targetKcalForDay }] as unknown as LoggedIntakeRecord[];
      const result = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows)));
      expect(result.loggedDays).toBe(1);
      expect(result.recordsWithTargetCount).toBe(0);
    }
  });

  it("objetivo corrupto DENTRO de la ventana → record_target_kcal_invalid (divergencia D9: v3.1 aceptaba 0 y negativos como «sin suelo relativo», 600 kcal → 1 día)", () => {
    for (const targetKcalForDay of CORRUPT_TARGETS) {
      const rows = [{ dateKey: "2026-09-11", loggedKcal: 2000, targetKcalForDay }] as unknown as LoggedIntakeRecord[];
      expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual(["record_target_kcal_invalid"]);
    }
  });

  it("la propiedad targetKcalForDay ausente NO equivale a null: es inválida (el contrato exige number | null)", () => {
    const rows = [{ dateKey: "2026-09-11", loggedKcal: 2000 }] as unknown as LoggedIntakeRecord[];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual(["record_target_kcal_invalid"]);
  });

  it("dateKey duplicada dentro de la ventana → record_date_key_duplicate (divergencia D2: v3.1 aceptaba dos filas del 09-27, daysWithData=2, cobertura 0,07)", () => {
    const rows = [rec("2026-09-27", 2000), rec("2026-09-27", 2000)];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual(["record_date_key_duplicate"]);
  });

  it("dateKey duplicada FUERA de la ventana no se examina", () => {
    const rows = [rec("2026-09-10", 2000), rec("2026-08-10", 1800), rec("2026-08-10", 1900)];
    expect(expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows))).loggedDays).toBe(1);
  });

  it("kcal, objetivo y duplicado a la vez → las tres razones, en orden canónico", () => {
    const rows = [
      { dateKey: "2026-09-20", loggedKcal: -1, targetKcalForDay: 0 },
      { dateKey: "2026-09-20", loggedKcal: 2000, targetKcalForDay: null },
    ] as unknown as LoggedIntakeRecord[];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual([
      "record_logged_kcal_invalid",
      "record_target_kcal_invalid",
      "record_date_key_duplicate",
    ]);
  });

  it("los extremos de la ventana son inclusivos", () => {
    const rows = [rec(WINDOW_START, 2000), rec("2026-09-10", 2000), rec(WINDOW_END, 2000), rec("2026-08-31", 9999), rec("2026-09-29", 9999)];
    const result = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows)));
    expect(result.loggedDays).toBe(3);
    expect(result.plausibleLoggedKcalTotal).toBe(6000);
  });

  it("loggedKcal 0 es un valor válido (día registrado); un objetivo pequeño y positivo también", () => {
    const rows = [rec("2026-09-10", 0), rec("2026-09-11", 500, 0.5)];
    expect(calculateIntakeLoggingCoverage(windowInput(rows)).status).toBe("evaluated");
  });

  it("objetivo -0 se rechaza: no es estrictamente positivo", () => {
    const negativeZero = -0;
    expect(Object.is(negativeZero, -0)).toBe(true);
    const rows = [{ dateKey: "2026-09-10", loggedKcal: 2000, targetKcalForDay: negativeZero }];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(rows))).reasons).toEqual(["record_target_kcal_invalid"]);
  });

  it("loggedKcal -0 se acepta como dato numérico, pero no es plausible ni entra en el total ni en el promedio", () => {
    const negativeZero = -0;
    expect(Object.is(negativeZero, -0)).toBe(true);
    // Solo un registro: día registrado, sin ningún día plausible.
    const alone = expectEvaluated(calculateIntakeLoggingCoverage(windowInput([rec("2026-09-10", negativeZero)])));
    expect(alone.loggedDays).toBe(1);
    expect(alone.plausibleDays).toBe(0);
    expect(Object.is(alone.plausibleLoggedKcalTotal, 0)).toBe(true);
    expect(alone.averagePlausibleLoggedKcal).toBeNull();
    // Con objetivo: cuenta como registro con objetivo, sigue sin ser plausible.
    const withTarget = expectEvaluated(calculateIntakeLoggingCoverage(windowInput([rec("2026-09-10", negativeZero, 2000)])));
    expect(withTarget.recordsWithTargetCount).toBe(1);
    expect(withTarget.plausibleDays).toBe(0);
    // Junto a un día plausible: no altera total ni promedio, y ningún número del resultado es -0.
    const mixed = expectEvaluated(calculateIntakeLoggingCoverage(windowInput([rec("2026-09-10", negativeZero), rec("2026-09-11", 2000)])));
    expect(mixed.loggedDays).toBe(2);
    expect(mixed.plausibleDays).toBe(1);
    expect(mixed.plausibleLoggedKcalTotal).toBe(2000);
    expect(mixed.averagePlausibleLoggedKcal).toBe(2000);
    for (const result of [alone, withTarget, mixed]) {
      expect(collectNumbers(result).some((value) => Object.is(value, -0))).toBe(false);
    }
  });

  it("una misma razón producida por varias filas aparece una sola vez (fases 2, 4 y 5)", () => {
    // Fases 4 y 5: tres filas con kcal inválido, dos con objetivo inválido y una fecha repetida tres veces.
    const deep = [
      { dateKey: "2026-09-10", loggedKcal: Number.NaN, targetKcalForDay: null },
      { dateKey: "2026-09-11", loggedKcal: -1, targetKcalForDay: null },
      { dateKey: "2026-09-12", loggedKcal: "x", targetKcalForDay: null },
      { dateKey: "2026-09-13", loggedKcal: 2000, targetKcalForDay: 0 },
      { dateKey: "2026-09-14", loggedKcal: 2000, targetKcalForDay: -5 },
      { dateKey: "2026-09-15", loggedKcal: 2000, targetKcalForDay: null },
      { dateKey: "2026-09-15", loggedKcal: 2000, targetKcalForDay: null },
      { dateKey: "2026-09-15", loggedKcal: 2000, targetKcalForDay: null },
    ] as unknown as LoggedIntakeRecord[];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(deep))).reasons).toEqual([
      "record_logged_kcal_invalid",
      "record_target_kcal_invalid",
      "record_date_key_duplicate",
    ]);
    // Fase 2: varias filas que no son objetos y varias con fecha inválida.
    const shallow = [
      5,
      "x",
      null,
      { dateKey: "mal", loggedKcal: 2000, targetKcalForDay: null },
      { dateKey: "2026-13-40", loggedKcal: 2000, targetKcalForDay: null },
    ] as unknown as LoggedIntakeRecord[];
    expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(shallow))).reasons).toEqual(["record_object_invalid", "record_date_key_invalid"]);
  });
});

// ─── Matriz de cobertura: valores esperados a mano ────────────────────────

describe("fixtures literales independientes — matriz de cobertura deducida a mano", () => {
  interface Case {
    name: string;
    records: LoggedIntakeRecord[];
    expected: { loggedDays: number; plausibleDays: number; recordsWithTargetCount: number; total: number; average: number | null };
  }
  const D = (day: number): string => `2026-09-${String(day).padStart(2, "0")}`;
  const MATRIX: Case[] = [
    { name: "sin registros", records: [], expected: { loggedDays: 0, plausibleDays: 0, recordsWithTargetCount: 0, total: 0, average: null } },
    { name: "un registro plausible, sin objetivo", records: [rec(D(10), 2000)], expected: { loggedDays: 1, plausibleDays: 1, recordsWithTargetCount: 0, total: 2000, average: 2000 } },
    { name: "un día registrado con 0 kcal, sin objetivo", records: [rec(D(10), 0)], expected: { loggedDays: 1, plausibleDays: 0, recordsWithTargetCount: 0, total: 0, average: null } },
    { name: "499,99 kcal sin objetivo: por debajo del suelo absoluto", records: [rec(D(10), 499.99)], expected: { loggedDays: 1, plausibleDays: 0, recordsWithTargetCount: 0, total: 0, average: null } },
    { name: "500 kcal sin objetivo: el suelo absoluto es inclusivo", records: [rec(D(10), 500)], expected: { loggedDays: 1, plausibleDays: 1, recordsWithTargetCount: 0, total: 500, average: 500 } },
    { name: "objetivo 2000, 1200 kcal: suelo relativo inclusivo", records: [rec(D(10), 1200, 2000)], expected: { loggedDays: 1, plausibleDays: 1, recordsWithTargetCount: 1, total: 1200, average: 1200 } },
    { name: "objetivo 2000, 1199,99 kcal: por debajo del suelo relativo", records: [rec(D(10), 1199.99, 2000)], expected: { loggedDays: 1, plausibleDays: 0, recordsWithTargetCount: 1, total: 0, average: null } },
    { name: "objetivo 2500, 1500 kcal: frontera exacta", records: [rec(D(10), 1500, 2500)], expected: { loggedDays: 1, plausibleDays: 1, recordsWithTargetCount: 1, total: 1500, average: 1500 } },
    { name: "objetivo 3000, 1700 kcal: supera el absoluto pero no el relativo (1800)", records: [rec(D(10), 1700, 3000)], expected: { loggedDays: 1, plausibleDays: 0, recordsWithTargetCount: 1, total: 0, average: null } },
    { name: "objetivo 600, 450 kcal: supera el relativo (360) pero no el absoluto", records: [rec(D(10), 450, 600)], expected: { loggedDays: 1, plausibleDays: 0, recordsWithTargetCount: 1, total: 0, average: null } },
    { name: "objetivo 800, 500 kcal: relativo 480 y absoluto 500 se cumplen a la vez", records: [rec(D(10), 500, 800)], expected: { loggedDays: 1, plausibleDays: 1, recordsWithTargetCount: 1, total: 500, average: 500 } },
    { name: "dos días plausibles: 2000 y 2200", records: [rec(D(10), 2000), rec(D(11), 2200)], expected: { loggedDays: 2, plausibleDays: 2, recordsWithTargetCount: 0, total: 4200, average: 2100 } },
    { name: "3 registrados, 1 plausible: 2000, 300 y 0", records: [rec(D(10), 2000), rec(D(11), 300), rec(D(12), 0)], expected: { loggedDays: 3, plausibleDays: 1, recordsWithTargetCount: 0, total: 2000, average: 2000 } },
    { name: "solo registros fuera de la ventana", records: [rec("2026-08-31", 2000), rec("2026-09-29", 2000)], expected: { loggedDays: 0, plausibleDays: 0, recordsWithTargetCount: 0, total: 0, average: null } },
    { name: "los dos extremos de la ventana", records: [rec(WINDOW_START, 2000), rec(WINDOW_END, 2000)], expected: { loggedDays: 2, plausibleDays: 2, recordsWithTargetCount: 0, total: 4000, average: 2000 } },
    { name: "28 días completos a 2000 kcal", records: WINDOW_DAYS.map((dateKey) => rec(dateKey, 2000)), expected: { loggedDays: 28, plausibleDays: 28, recordsWithTargetCount: 0, total: 56000, average: 2000 } },
    { name: "diez días mixtos con objetivo 2500 (suelo relativo 1500)", records: MIXED_WITH_TARGETS, expected: { loggedDays: 10, plausibleDays: 6, recordsWithTargetCount: 10, total: 11700, average: 1950 } },
    { name: "los mismos diez días sin objetivo (solo suelo absoluto)", records: MIXED_NO_TARGETS, expected: { loggedDays: 10, plausibleDays: 8, recordsWithTargetCount: 0, total: 13899, average: 1737.375 } },
    { name: "kcal decimales que suman un entero: 1999,5 y 2000,5", records: [rec(D(10), 1999.5), rec(D(11), 2000.5)], expected: { loggedDays: 2, plausibleDays: 2, recordsWithTargetCount: 0, total: 4000, average: 2000 } },
    { name: "recordsWithTargetCount cuenta los registros con objetivo aunque no sean plausibles", records: [rec(D(10), 0, 2000), rec(D(11), 2000, 2000), rec(D(12), 2000)], expected: { loggedDays: 3, plausibleDays: 2, recordsWithTargetCount: 2, total: 4000, average: 2000 } },
  ];

  for (const testCase of MATRIX) {
    it(testCase.name, () => {
      const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(testCase.records)));
      expect(r.loggedDays).toBe(testCase.expected.loggedDays);
      expect(r.plausibleDays).toBe(testCase.expected.plausibleDays);
      expect(r.recordsWithTargetCount).toBe(testCase.expected.recordsWithTargetCount);
      expect(r.plausibleLoggedKcalTotal).toBe(testCase.expected.total);
      expect(r.averagePlausibleLoggedKcal).toBe(testCase.expected.average);
      expect(r.eligibleCalendarDays).toBe(28);
      expect(r.loggingPresenceFraction).toBe(testCase.expected.loggedDays / 28);
      expect(r.plausibleCoverageFraction).toBe(testCase.expected.plausibleDays / 28);
      expect(r.windowStartDateKey).toBe(WINDOW_START);
      expect(r.windowEndDateKey).toBe(WINDOW_END);
    });
  }
});

// ─── Estructura del resultado ─────────────────────────────────────────────

describe("fixtures literales independientes — estructura del resultado evaluated", () => {
  it("sin registros: evaluated (no existe insufficient_data), con fracciones 0 y promedio null", () => {
    expect(calculateIntakeLoggingCoverage(windowInput([]))).toEqual({
      status: "evaluated",
      windowStartDateKey: WINDOW_START,
      windowEndDateKey: WINDOW_END,
      eligibleCalendarDays: 28,
      loggedDays: 0,
      plausibleDays: 0,
      recordsWithTargetCount: 0,
      loggingPresenceFraction: 0,
      plausibleCoverageFraction: 0,
      plausibleLoggedKcalTotal: 0,
      averagePlausibleLoggedKcal: null,
      plausibilityHeuristic: { minLoggedKcal: 500, minFractionOfDayTarget: 0.6, comparison: "inclusive", provenance: "heuristic_inherited_from_v3_1" },
      intakeAccuracy: "unknown",
    });
  });

  it("cobertura completa y plausible NO afirma exactitud: intakeAccuracy sigue siendo 'unknown'", () => {
    const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(WINDOW_DAYS.map((dateKey) => rec(dateKey, 2000, 2500)))));
    expect(r.loggingPresenceFraction).toBe(1);
    expect(r.plausibleCoverageFraction).toBe(1);
    expect(r.intakeAccuracy).toBe("unknown");
  });

  it("el resultado declara la heurística aplicada y su procedencia", () => {
    const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput([rec("2026-09-10", 2000)])));
    expect(r.plausibilityHeuristic).toEqual({ minLoggedKcal: 500, minFractionOfDayTarget: 0.6, comparison: "inclusive", provenance: "heuristic_inherited_from_v3_1" });
  });
});

// ─── Frontera de la heurística ────────────────────────────────────────────

describe("fixtures literales independientes — frontera de la heurística, comparaciones inclusivas y a la vez", () => {
  const plausible = (loggedKcal: number, target: number | null): boolean =>
    expectEvaluated(calculateIntakeLoggingCoverage(windowInput([rec("2026-09-10", loggedKcal, target)]))).plausibleDays === 1;

  it("suelo absoluto: 500 sí, 499,99 no, 500,01 sí", () => {
    expect(plausible(500, null)).toBe(true);
    expect(plausible(499.99, null)).toBe(false);
    expect(plausible(500.01, null)).toBe(true);
  });

  it("suelo relativo con objetivo 2000: 1200 sí, 1199,99 no, 1200,0000001 sí", () => {
    expect(plausible(1200, 2000)).toBe(true);
    expect(plausible(1199.99, 2000)).toBe(false);
    expect(plausible(1200.0000001, 2000)).toBe(true);
  });

  it("los productos objetivo × 0,6 de objetivos habituales caen exactamente en la frontera y son plausibles", () => {
    for (const [target, boundary] of [[1800, 1080], [2000, 1200], [2500, 1500], [3000, 1800], [1234, 740.4]] as const) {
      expect(target * 0.6).toBe(boundary);
      expect(plausible(boundary, target)).toBe(true);
      expect(plausible(boundary - 0.01, target)).toBe(false);
    }
  });

  it("sin objetivo el criterio relativo no se aplica; con objetivo, el más exigente de los dos prevalece", () => {
    expect(plausible(700, null)).toBe(true);
    expect(plausible(700, 2000)).toBe(false); // relativo: 1200
    expect(plausible(450, 600)).toBe(false); // absoluto: 500 (el relativo, 360, sí se cumple)
    expect(plausible(1500, 2500)).toBe(true);
    expect(plausible(1499, 2500)).toBe(false);
  });

  it("un día con 0 kcal está registrado pero no es plausible, con y sin objetivo", () => {
    for (const target of [null, 2000]) {
      const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput([rec("2026-09-10", 0, target)])));
      expect(r.loggedDays).toBe(1);
      expect(r.plausibleDays).toBe(0);
      expect(r.loggingPresenceFraction).toBe(1 / 28);
      expect(r.plausibleCoverageFraction).toBe(0);
    }
  });
});

// ─── Suma, orden y reconstrucción ─────────────────────────────────────────

describe("fixtures literales independientes — suma cronológica ascendente", () => {
  it("la suma sigue el orden ascendente de dateKey aunque los registros lleguen al revés", () => {
    const ascendingSum = ORDER_DEPENDENT_KCAL.reduce((sum, kcal) => sum + kcal, 0);
    const descendingSum = [...ORDER_DEPENDENT_KCAL].reverse().reduce((sum, kcal) => sum + kcal, 0);
    // Las dos sumas difieren (precondición del fixture, no del kernel).
    expect(ascendingSum).toBe(ORDER_DEPENDENT_ASCENDING_TOTAL);
    expect(descendingSum).toBe(ORDER_DEPENDENT_DESCENDING_TOTAL);
    expect(ascendingSum).not.toBe(descendingSum);

    const reversedInput = [...ORDER_DEPENDENT].reverse();
    const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(reversedInput)));
    expect(r.plausibleLoggedKcalTotal).toBe(ORDER_DEPENDENT_ASCENDING_TOTAL);
    expect(r.plausibleLoggedKcalTotal).not.toBe(ORDER_DEPENDENT_DESCENDING_TOTAL);
  });

  it("las 720 permutaciones de los seis registros dan exactamente el mismo total, promedio y resultado completo", () => {
    const baseline = calculateIntakeLoggingCoverage(windowInput(ORDER_DEPENDENT));
    const perms = permutations(ORDER_DEPENDENT);
    expect(perms).toHaveLength(720);
    for (const permutation of perms) {
      expect(calculateIntakeLoggingCoverage(windowInput(permutation))).toEqual(baseline);
    }
  });
});

// ─── Propiedades que reexpresan una fórmula del contrato ──────────────────
// Recalculan una fórmula o identidad documentada (fracciones = días / ventana, criterio de
// plausibilidad, media × días ≈ total). Son pruebas de propiedades: detectan regresiones pero
// NO son evidencia independiente, porque comparten la especificación con el kernel. La
// evidencia independiente son los fixtures literales y la paridad capturada de v3.1.

describe("propiedades que reexpresan fórmulas del contrato — no son evidencia independiente", () => {
  it("invariante 0 <= plausibleDays <= loggedDays <= eligibleCalendarDays y coherencia de fracciones (barrido de 500 series)", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rows = seededRecords(seed);
      const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows)));
      expect(r.plausibleDays).toBeGreaterThanOrEqual(0);
      expect(r.plausibleDays).toBeLessThanOrEqual(r.loggedDays);
      expect(r.loggedDays).toBeLessThanOrEqual(r.eligibleCalendarDays);
      expect(r.loggedDays).toBe(rows.length);
      expect(r.recordsWithTargetCount).toBe(rows.filter((row) => row.targetKcalForDay !== null).length);
      expect(r.loggingPresenceFraction).toBe(r.loggedDays / r.eligibleCalendarDays);
      expect(r.plausibleCoverageFraction).toBe(r.plausibleDays / r.eligibleCalendarDays);
      expect(collectNumbers(r).every(Number.isFinite)).toBe(true);
      expect(r.averagePlausibleLoggedKcal === null).toBe(r.plausibleDays === 0);
    }
  });

  it("plausibilidad recalculada de forma independiente en el barrido: mismos días plausibles que el criterio escrito en la prueba", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rows = seededRecords(seed);
      const independent = rows.filter((row) => row.loggedKcal >= 500 && (row.targetKcalForDay === null || row.loggedKcal >= row.targetKcalForDay * 0.6));
      const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows)));
      expect(r.plausibleDays).toBe(independent.length);
    }
  });

  it("averagePlausibleLoggedKcal × plausibleDays reconstruye el total solo dentro de una tolerancia de coma flotante", () => {
    const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(ORDER_DEPENDENT)));
    const average = r.averagePlausibleLoggedKcal as number;
    expect(average).toBeCloseTo(r.plausibleLoggedKcalTotal / r.plausibleDays, 9);
    expect(average * r.plausibleDays).toBeCloseTo(r.plausibleLoggedKcalTotal, 6);
    // La igualdad estricta NO está garantizada (esta serie es un ejemplo): por eso la propiedad se expresa con tolerancia.
    expect(average * r.plausibleDays).not.toBe(r.plausibleLoggedKcalTotal);
    expect(Math.abs(average * r.plausibleDays - r.plausibleLoggedKcalTotal)).toBeLessThan(1e-9);
  });

  it("la reconstrucción con tolerancia se cumple en todo el barrido determinista", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(seededRecords(seed))));
      if (r.averagePlausibleLoggedKcal === null) {
        expect(r.plausibleLoggedKcalTotal).toBe(0);
        continue;
      }
      const tolerance = 1e-9 * Math.max(1, r.plausibleLoggedKcalTotal);
      expect(Math.abs(r.averagePlausibleLoggedKcal * r.plausibleDays - r.plausibleLoggedKcalTotal)).toBeLessThanOrEqual(tolerance);
    }
  });
});

// ─── Paridad con v3.1 (fixtures reproducidos) ─────────────────────────────
// Valores capturados de la función real calcIntakeCoverage con referencia
// 2026-09-28 y windowDays 28. El redondeo legacy (media a entero, fracción a
// 2 decimales) se aplica aquí, en la prueba. v3.1 devolvía null cuando no
// había ningún día plausible; su equivalente en PR5A es plausibleDays 0.

describe("paridad con v3.1 — donde ambos motores deben coincidir", () => {
  interface LegacyCapture {
    name: string;
    records: LoggedIntakeRecord[];
    legacy: Pick<LegacyIntakeCoverageResult, "avgKcal" | "coverageFraction" | "daysWithData"> | null;
  }
  const single = (dateKey: string, kcal: number, target: number | null = null): LoggedIntakeRecord[] => [rec(dateKey, kcal, target)];
  const CAPTURES: LegacyCapture[] = [
    { name: "I1 — 28 días a 2000 kcal, objetivo 2500", records: WINDOW_DAYS.map((dateKey) => rec(dateKey, 2000, 2500)), legacy: { avgKcal: 2000, coverageFraction: 1, daysWithData: 28 } },
    { name: "I2 — 500 kcal sin objetivo", records: single("2026-09-05", 500), legacy: { avgKcal: 500, coverageFraction: 0.04, daysWithData: 1 } },
    { name: "I2 — 499,99 kcal sin objetivo", records: single("2026-09-05", 499.99), legacy: null },
    { name: "I2 — 1200 kcal, objetivo 2000", records: single("2026-09-01", 1200, 2000), legacy: { avgKcal: 1200, coverageFraction: 0.04, daysWithData: 1 } },
    { name: "I2 — 1199,99 kcal, objetivo 2000", records: single("2026-09-02", 1199.99, 2000), legacy: null },
    { name: "I2 — 1200,0000001 kcal, objetivo 2000", records: single("2026-09-03", 1200.0000001, 2000), legacy: { avgKcal: 1200, coverageFraction: 0.04, daysWithData: 1 } },
    { name: "I2 — día presente con 0 kcal", records: single("2026-09-04", 0, 2000), legacy: null },
    { name: "I3 — solo el día de referencia−27", records: single("2026-09-01", 2000), legacy: { avgKcal: 2000, coverageFraction: 0.04, daysWithData: 1 } },
    { name: "I3 — solo el día de referencia−28 (queda fuera de la ventana de 28 fechas)", records: single("2026-08-31", 2000), legacy: null },
    { name: "I4 — diez días mixtos con objetivo 2500", records: MIXED_WITH_TARGETS, legacy: { avgKcal: 1950, coverageFraction: 0.21, daysWithData: 6 } },
    { name: "I4 — los mismos diez días sin objetivo", records: MIXED_NO_TARGETS, legacy: { avgKcal: 1737, coverageFraction: 0.29, daysWithData: 8 } },
    { name: "I5 — 24 de 28 días", records: WINDOW_DAYS.slice(0, 24).map((dateKey) => rec(dateKey, 2000)), legacy: { avgKcal: 2000, coverageFraction: 0.86, daysWithData: 24 } },
    { name: "I5 — 23 de 28 días", records: WINDOW_DAYS.slice(0, 23).map((dateKey) => rec(dateKey, 2000)), legacy: { avgKcal: 2000, coverageFraction: 0.82, daysWithData: 23 } },
    { name: "I6 — 10 días consecutivos plausibles sobre la ventana completa de 28", records: Array.from({ length: 10 }, (_, index) => rec(addDays("2026-09-19", index), 2000)), legacy: { avgKcal: 2000, coverageFraction: 0.36, daysWithData: 10 } },
  ];

  for (const capture of CAPTURES) {
    it(`${capture.name}: tras el redondeo legacy coincide con v3.1`, () => {
      const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(capture.records)));
      if (capture.legacy === null) {
        expect(r.plausibleDays).toBe(0);
        expect(r.averagePlausibleLoggedKcal).toBeNull();
        return;
      }
      expect(r.plausibleDays).toBe(capture.legacy.daysWithData);
      expect(legacyAverage(r.averagePlausibleLoggedKcal as number)).toBe(capture.legacy.avgKcal);
      expect(round2(r.plausibleCoverageFraction)).toBe(capture.legacy.coverageFraction);
    });
  }

  it("diferencia histórica explícita: 28 fechas para el equivalente legacy de ingesta y 29 para el de peso, calculadas por el llamador", () => {
    // Referencia 2026-09-28: ingesta = referencia−27 … referencia.
    expect(expectEvaluated(calculateIntakeLoggingCoverage(windowInput([], { startDateKey: "2026-09-01", endDateKey: "2026-09-28" }))).eligibleCalendarDays).toBe(28);
    // El kernel no fija la longitud: una ventana de 29 fechas se expresa igual.
    expect(expectEvaluated(calculateIntakeLoggingCoverage(windowInput([], { startDateKey: "2026-08-31", endDateKey: "2026-09-28" }))).eligibleCalendarDays).toBe(29);
  });
});

// ─── Divergencias deliberadas respecto a v3.1 ─────────────────────────────

describe("divergencia deliberada respecto a v3.1 — el valor legacy y el de PR5A difieren a propósito", () => {
  // Divergencias documentadas cuyo test ya existe en otra sección; no se repiten aquí para no
  // inflar la suite con casos equivalentes:
  //  · D2 (fecha duplicada) → «fases 3 a 5», test de dateKey duplicada.
  //  · D5 (promedio sin redondeo, 1737,375) → fila «los mismos diez días sin objetivo» de la
  //    matriz y captura I4 de la paridad.
  //  · D6 (ningún día plausible; v3.1 devolvía null) → filas de 0 kcal y 499,99 de la matriz y
  //    capturas «null» de la paridad.
  //  · Presencia frente a plausibilidad (loggedDays 10, plausibleDays 6) → fila «diez días mixtos
  //    con objetivo 2500» de la matriz.
  //  · D9 (objetivo ≤ 0; kcal infinito, NaN o negativo) → «fases 3 a 5», tests de objetivo y de
  //    kcal corruptos.
  // Se conservan aquí dos tests: la fracción sin redondear (única aserción con el literal
  // 0,8571428571428571; la matriz expresa las fracciones como un cociente calculado en la prueba)
  // y el orden de suma que el redondeo legacy ocultaba.

  it("fracción sin redondeo: 24 de 28 días → legacy 0,86; PR5A 0,8571428571428571", () => {
    const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(WINDOW_DAYS.slice(0, 24).map((dateKey) => rec(dateKey, 2000)))));
    expect(r.plausibleCoverageFraction).toBe(0.8571428571428571);
    expect(r.plausibleCoverageFraction).not.toBe(0.86);
  });

  it("el redondeo legacy ocultaba el orden de suma (ambos órdenes dan 2315); PR5A lo fija y lo hace observable", () => {
    const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(ORDER_DEPENDENT)));
    expect(legacyAverage(r.averagePlausibleLoggedKcal as number)).toBe(2315);
    expect(r.plausibleLoggedKcalTotal).toBe(ORDER_DEPENDENT_ASCENDING_TOTAL);
  });
});

// ─── La ventana la fija el llamador ───────────────────────────────────────

describe("la ventana recibida determina el denominador — el kernel no la reescribe", () => {
  it("los mismos 10 días recientes: sobre la ventana completa de 28 la cobertura es 10/28; recortada a esos 10 días sería 1", () => {
    const rows = Array.from({ length: 10 }, (_, index) => rec(addDays("2026-09-19", index), 2000));
    const full = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows)));
    const shortened = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows, { startDateKey: "2026-09-19" })));
    expect(full.plausibleCoverageFraction).toBe(10 / 28);
    expect(shortened.plausibleCoverageFraction).toBe(1);
  });

  it("8 días plausibles de 10 recientes: 8/28 con la ventana completa, no un 80 % de ventana completa", () => {
    const rows = Array.from({ length: 10 }, (_, index) => rec(addDays("2026-09-19", index), index < 8 ? 2000 : 0));
    const full = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows)));
    expect(full.plausibleDays).toBe(8);
    expect(full.plausibleCoverageFraction).toBe(8 / 28);
    expect(full.plausibleCoverageFraction).toBeLessThan(0.3);
  });

  // Que el llamador quite antes de invocar los registros anteriores a una fecha de corte es,
  // para el kernel, idéntico al primer test: recibe las mismas filas y la misma ventana completa
  // (10/28); los días excluidos siguen contando como ausencia dentro de esa ventana.
});

// ─── Dominio de fechas ────────────────────────────────────────────────────

describe("dominio de fechas — 0001-01-01 a 9999-12-31, gregoriano proléptico, sin año cero", () => {
  const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const FULL_DOMAIN = { startDateKey: "0001-01-01", endDateKey: "9999-12-31" };

  it("extremos del dominio: ventana de 3.652.059 días de calendario, sin enumerar", () => {
    const r = expectEvaluated(calculateIntakeLoggingCoverage({ ...FULL_DOMAIN, records: [] }));
    expect(r.eligibleCalendarDays).toBe(3652059);
    expect(Number.isSafeInteger(r.eligibleCalendarDays)).toBe(true);
  });

  it("año 0000 rechazado como límite y como fecha de fila", () => {
    expect(expectInvalid(calculateIntakeLoggingCoverage({ startDateKey: "0000-01-01", endDateKey: "0001-01-01", records: [] })).reasons).toEqual(["start_date_key_invalid"]);
    expect(expectInvalid(calculateIntakeLoggingCoverage({ startDateKey: "0001-01-01", endDateKey: "0000-12-31", records: [] })).reasons).toEqual(["end_date_key_invalid"]);
    expect(expectInvalid(calculateIntakeLoggingCoverage({ ...FULL_DOMAIN, records: [rec("0000-06-15", 2000)] })).reasons).toEqual(["record_date_key_invalid"]);
  });

  it("bisiestos: 2000 y 2024 sí; 1900 y 2100 no", () => {
    for (const [year, valid] of [[2000, true], [2024, true], [1900, false], [2100, false]] as const) {
      const result = calculateIntakeLoggingCoverage({ ...FULL_DOMAIN, records: [rec(`${year}-02-29`, 2000)] });
      expect(result.status).toBe(valid ? "evaluated" : "invalid_input");
    }
  });

  it("último día de cada mes (año no bisiesto y bisiesto) válido; el día siguiente, inválido", () => {
    const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (const [year, february] of [[2026, 28], [2028, 29]] as const) {
      lengths.forEach((baseLength, index) => {
        const length = index === 1 ? february : baseLength;
        const month = String(index + 1).padStart(2, "0");
        const last = calculateIntakeLoggingCoverage({ ...FULL_DOMAIN, records: [rec(`${year}-${month}-${String(length).padStart(2, "0")}`, 2000)] });
        const beyond = calculateIntakeLoggingCoverage({ ...FULL_DOMAIN, records: [rec(`${year}-${month}-${String(length + 1).padStart(2, "0")}`, 2000)] });
        expect(last.status).toBe("evaluated");
        expect(beyond.status).toBe("invalid_input");
      });
    }
  });

  it("recorre los años 1…9999 por la API pública: 365/366 días por año y 2 días entre el 31-dic y el 1-ene siguiente", () => {
    const failures: string[] = [];
    for (let year = 1; year <= 9999; year++) {
      const y = String(year).padStart(4, "0");
      const yearResult = calculateIntakeLoggingCoverage({ startDateKey: `${y}-01-01`, endDateKey: `${y}-12-31`, records: [] });
      if (yearResult.status !== "evaluated" || yearResult.eligibleCalendarDays !== (isLeap(year) ? 366 : 365)) failures.push(`${y}: año`);
      if (year < 9999) {
        const next = String(year + 1).padStart(4, "0");
        const bridge = calculateIntakeLoggingCoverage({ startDateKey: `${y}-12-31`, endDateKey: `${next}-01-01`, records: [] });
        if (bridge.status !== "evaluated" || bridge.eligibleCalendarDays !== 2) failures.push(`${y}: cambio de año`);
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
      const result = expectEvaluated(calculateIntakeLoggingCoverage({ startDateKey, endDateKey, records: [] }));
      expect({ startDateKey, endDateKey, days: result.eligibleCalendarDays }).toEqual({ startDateKey, endDateKey, days });
    }
  });

  it("registros separados por milenios dentro de una ventana enorme → fracciones finitas y correctas", () => {
    const rows = [rec("0001-01-01", 2000), rec("5000-06-15", 2000), rec("9999-12-31", 2000)];
    const r = expectEvaluated(calculateIntakeLoggingCoverage({ ...FULL_DOMAIN, records: rows }));
    expect(r.eligibleCalendarDays).toBe(3652059);
    expect(r.loggedDays).toBe(3);
    expect(r.loggingPresenceFraction).toBe(3 / 3652059);
    expect(collectNumbers(r).every(Number.isFinite)).toBe(true);
  });
});

// ─── Seguridad numérica ───────────────────────────────────────────────────

describe("seguridad numérica — nunca un evaluated con NaN, infinito o entero inseguro", () => {
  it("dos registros plausibles de 1e308 kcal: la suma desborda → derived_numeric_result_invalid, sin resultado parcial", () => {
    const rows = [rec("2026-09-10", 1e308), rec("2026-09-11", 1e308)];
    expect(calculateIntakeLoggingCoverage(windowInput(rows))).toEqual({ status: "invalid_input", reasons: ["derived_numeric_result_invalid"] });
  });

  it("el desbordamiento de la suma no depende del orden de entrada", () => {
    const rows = [rec("2026-09-10", 1e308), rec("2026-09-11", 1e308), rec("2026-09-12", 5)];
    for (const permutation of permutations(rows)) {
      expect(calculateIntakeLoggingCoverage(windowInput(permutation))).toEqual({ status: "invalid_input", reasons: ["derived_numeric_result_invalid"] });
    }
  });

  it("un único registro con el mayor número finito es válido y todo el resultado sigue siendo finito", () => {
    const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput([rec("2026-09-10", Number.MAX_VALUE)])));
    expect(r.plausibleLoggedKcalTotal).toBe(Number.MAX_VALUE);
    expect(r.averagePlausibleLoggedKcal).toBe(Number.MAX_VALUE);
    expect(collectNumbers(r).every(Number.isFinite)).toBe(true);
  });

  it("un objetivo enorme y finito no produce infinitos: 0,6 × MAX_VALUE no desborda", () => {
    const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput([rec("2026-09-10", 2000, Number.MAX_VALUE)])));
    expect(r.loggedDays).toBe(1);
    expect(r.plausibleDays).toBe(0);
    expect(collectNumbers(r).every(Number.isFinite)).toBe(true);
  });

  it("todos los números de un resultado evaluated son finitos y los contadores, enteros seguros", () => {
    for (const rows of [[], MIXED_NO_TARGETS, MIXED_WITH_TARGETS, ORDER_DEPENDENT, WINDOW_DAYS.map((dateKey) => rec(dateKey, 2000))]) {
      const r = expectEvaluated(calculateIntakeLoggingCoverage(windowInput(rows)));
      expect(collectNumbers(r).every(Number.isFinite)).toBe(true);
      for (const counter of [r.eligibleCalendarDays, r.loggedDays, r.plausibleDays, r.recordsWithTargetCount]) {
        expect(Number.isSafeInteger(counter)).toBe(true);
      }
    }
  });
});

// ─── Determinismo, canonicalización, inmutabilidad ────────────────────────

describe("determinismo y canonicalización", () => {
  it("las 120 permutaciones de cinco registros producen el mismo resultado completo", () => {
    const rows = MIXED_WITH_TARGETS.slice(0, 5);
    const baseline = calculateIntakeLoggingCoverage(windowInput(rows));
    for (const permutation of permutations(rows)) {
      expect(calculateIntakeLoggingCoverage(windowInput(permutation))).toEqual(baseline);
    }
  });

  it("las razones de error no dependen del orden de las filas (todas las permutaciones)", () => {
    const rows = [
      { dateKey: "2026-09-20", loggedKcal: -1, targetKcalForDay: null },
      { dateKey: "2026-09-20", loggedKcal: 2000, targetKcalForDay: 0 },
      { dateKey: "2026-09-21", loggedKcal: 2000, targetKcalForDay: null },
      { dateKey: "2026-08-01", loggedKcal: "corrupto", targetKcalForDay: -3 },
    ] as unknown as LoggedIntakeRecord[];
    for (const permutation of permutations(rows)) {
      expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(permutation))).reasons).toEqual([
        "record_logged_kcal_invalid",
        "record_target_kcal_invalid",
        "record_date_key_duplicate",
      ]);
    }
  });

  it("las razones de fila entera tampoco dependen del orden", () => {
    const rows = [5, { dateKey: "no-fecha", loggedKcal: 2000, targetKcalForDay: null }, rec("2026-09-20", -1)] as unknown as LoggedIntakeRecord[];
    for (const permutation of permutations(rows)) {
      expect(expectInvalid(calculateIntakeLoggingCoverage(windowInput(permutation))).reasons).toEqual(["record_object_invalid", "record_date_key_invalid"]);
    }
  });

  it("misma entrada → mismo resultado, profundamente idéntico", () => {
    expect(calculateIntakeLoggingCoverage(windowInput(MIXED_WITH_TARGETS))).toEqual(calculateIntakeLoggingCoverage(windowInput(JSON.parse(JSON.stringify(MIXED_WITH_TARGETS)))));
  });
});

describe("razones de error — cada razón declarada es alcanzable y sobrevive a la canonicalización", () => {
  // Record exhaustivo: si la unión gana una razón sin entrada aquí, el typecheck falla. Y si
  // el orden canónico del kernel no la incluyera, la razón desaparecería del resultado y este
  // test fallaría en ejecución (el kernel además lo rechaza al compilar).
  const TRIGGERS: Record<IntakeLoggingCoverageInvalidReason, () => unknown> = {
    input_object_invalid: () => null,
    start_date_key_invalid: () => windowInput([], { startDateKey: "no-es-fecha" }),
    end_date_key_invalid: () => windowInput([], { endDateKey: "2026-02-30" }),
    date_window_order_invalid: () => windowInput([], { startDateKey: "2026-09-28", endDateKey: "2026-09-27" }),
    records_not_array: () => ({ startDateKey: WINDOW_START, endDateKey: WINDOW_END, records: "no-array" }),
    record_object_invalid: () => windowInput([null as unknown as LoggedIntakeRecord]),
    record_date_key_invalid: () => windowInput([rec("2026-13-01", 2000)]),
    record_logged_kcal_invalid: () => windowInput([rec("2026-09-10", -1)]),
    record_target_kcal_invalid: () => windowInput([rec("2026-09-10", 2000, 0)]),
    record_date_key_duplicate: () => windowInput([rec("2026-09-10", 2000), rec("2026-09-10", 2000)]),
    derived_numeric_result_invalid: () => windowInput([rec("2026-09-10", 1e308), rec("2026-09-11", 1e308)]),
  };

  it("cada disparador produce exactamente su razón, sola y en el resultado", () => {
    for (const [reason, build] of Object.entries(TRIGGERS)) {
      expect(calculateIntakeLoggingCoverage(build() as IntakeLoggingCoverageInput)).toEqual({ status: "invalid_input", reasons: [reason] });
    }
  });
});

describe("inmutabilidad, independencia entre llamadas y datos JSON-like", () => {
  it("una entrada profundamente congelada no lanza y queda intacta", () => {
    const rows = deepFreeze(MIXED_WITH_TARGETS.map((row) => ({ ...row })));
    const input = deepFreeze({ startDateKey: WINDOW_START, endDateKey: WINDOW_END, records: rows });
    const snapshot = JSON.parse(JSON.stringify(input));
    expect(() => calculateIntakeLoggingCoverage(input)).not.toThrow();
    expect(input).toEqual(snapshot);
  });

  it("el orden de la entrada no se altera al ordenar internamente", () => {
    const reversed = [...ORDER_DEPENDENT].reverse();
    const before = JSON.parse(JSON.stringify(reversed));
    calculateIntakeLoggingCoverage(windowInput(reversed));
    expect(reversed).toEqual(before);
  });

  it("independencia entre llamadas: alterar un resultado devuelto no modifica el de una llamada posterior", () => {
    const inputs = [
      windowInput(MIXED_WITH_TARGETS), // evaluated con promedio
      windowInput([]), // evaluated sin registros (promedio null)
      windowInput([], { startDateKey: "no-es-fecha" }), // invalid_input
    ];
    for (const input of inputs) {
      const baseline = JSON.parse(JSON.stringify(calculateIntakeLoggingCoverage(input)));
      const first = calculateIntakeLoggingCoverage(input);
      corrupt(first);
      expect(first).not.toEqual(baseline); // la alteración tuvo efecto sobre el objeto devuelto…
      expect(calculateIntakeLoggingCoverage(input)).toEqual(baseline); // …y no se filtra a la llamada siguiente
    }
  });

  // El contrato cubre datos ordinarios de tipo JSON, incluidos los estructuralmente inválidos.
  // Objetos hostiles (getters que lanzan, proxies revocados) quedan fuera del contrato.
  it("no lanza para una combinación amplia de valores JSON-like estructuralmente inválidos", () => {
    const garbage: unknown[] = [
      null, undefined, 0, "x", [], {},
      { startDateKey: "bogus" },
      { records: "bogus" },
      { startDateKey: WINDOW_START, endDateKey: WINDOW_END, records: [{}] },
      { startDateKey: WINDOW_START, endDateKey: WINDOW_END, records: [null, 1, "a", []] },
      { startDateKey: WINDOW_START, endDateKey: WINDOW_END, records: [{ dateKey: "2026-09-10", loggedKcal: {}, targetKcalForDay: {} }] },
    ];
    for (const input of garbage) {
      expect(() => calculateIntakeLoggingCoverage(input as unknown as IntakeLoggingCoverageInput)).not.toThrow();
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
    "isPlausible",
    "computeEvaluated",
    "MIN_LOGGED_KCAL",
    "MIN_FRACTION_OF_DAY_TARGET",
    "DATE_KEY_PATTERN",
    "DAYS_IN_MONTH",
    "INVALID_REASON_ORDER",
  ];

  it("expone calculateIntakeLoggingCoverage y calculateWeightTrend, y ninguna declaración privada de este kernel", () => {
    const barrel = engineBarrel as Record<string, unknown>;
    expect(typeof barrel.calculateIntakeLoggingCoverage).toBe("function");
    expect(typeof barrel.calculateWeightTrend).toBe("function");
    for (const name of PRIVATE_NAMES) expect(barrel[name]).toBeUndefined();
  });

  it("la lista de nombres privados cubre todas las declaraciones de nivel superior del kernel (no queda obsoleta)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fileName = join(here, "intake-logging-coverage-kernel.ts");
    const sourceFile = ts.createSourceFile(fileName, readFileSync(fileName, "utf-8"), ts.ScriptTarget.Latest, true);
    const declared: string[] = [];
    for (const statement of sourceFile.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declared.push(statement.name.text);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) declared.push(declaration.name.text);
      }
    }
    const publicNames = ["calculateIntakeLoggingCoverage"];
    expect(declared.filter((name) => !publicNames.includes(name) && !PRIVATE_NAMES.includes(name))).toEqual([]);
    expect(declared).toContain("calculateIntakeLoggingCoverage");
  });

  it("calculateIntakeLoggingCoverage importado desde el barrel se comporta igual que el import directo", () => {
    const input = windowInput(MIXED_WITH_TARGETS);
    expect(engineBarrel.calculateIntakeLoggingCoverage(input)).toEqual(calculateIntakeLoggingCoverage(input));
  });
});

// ─── Tipos ────────────────────────────────────────────────────────────────

/** Comprobación de tipos, no de ejecución: el nombre del contrato de PR5A
    resuelve al de PR5A, no al `IntakeCoverageResult` homónimo de v3.1 (que no
    tiene `status`). Falla en compilación si un `export *` quedara tapado. */
function _typeChecksNeverCalled(): void {
  type Assert<T extends true> = T;
  type HasStatus<T> = T extends { status: string } ? true : false;
  type _ResultHasStatus = Assert<HasStatus<IntakeLoggingCoverageResult>>;
  // @ts-expect-error — el tipo homónimo de v3.1 no tiene `status`.
  type _LegacyHasNoStatus = Assert<HasStatus<LegacyIntakeCoverageResult>>;
}

describe("tipos — sin colisión con el IntakeCoverageResult de v3.1", () => {
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
  const kernelFile = join(here, "intake-logging-coverage-kernel.ts");
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
    const contractFile = join(here, "..", "..", "types", "src", "intake-logging-coverage.ts");
    for (const [name, source] of [["kernel", kernelSource], ["contrato", readFileSync(contractFile, "utf-8")]] as const) {
      expect({ name, offending: source.match(/calibrat|supabase|session|sesi[oó]n|coordinat|persist/gi) }).toEqual({ name, offending: null });
    }
  });
});
