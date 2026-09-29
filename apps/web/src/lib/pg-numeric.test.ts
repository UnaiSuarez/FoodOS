// canonicalNumeric2 — el valor que PostgreSQL persiste en una columna numeric(p,2).
//
// Los VALORES ESPERADOS de la tabla no salen de esta función: se obtuvieron
// ejecutando en un PostgreSQL real y aislado (PGlite 0.5.8, motor PostgreSQL 18.3)
// exactamente el camino de escritura de PostgREST —
//   insert … select … from json_populate_recordset(null::t, '[{"k": <valor>}]')
// con la columna `k numeric(7,2)` — y leyendo el resultado. Una comprobación
// aparte con 36 040 valores (41 fijos + 35 999 aleatorios, incluidos bordes x,xx5)
// dio 0 diferencias entre esta función y Postgres. Ver docs §19.7.
import { describe, expect, it } from "vitest";
import { canonicalNumeric2 } from "./pg-numeric";

/** [valor enviado por el cliente (JSON), valor que devolvió PostgreSQL]. */
const FROM_POSTGRES: Array<[number, number]> = [
  [165.0051, 165.01], [165.005, 165.01], [165.0049, 165], [165.01, 165.01], [165, 165],
  [1.005, 1.01], [2.675, 2.68], [0.005, 0.01], [0.0049, 0], [0.004, 0], [0.015, 0.02],
  [999.995, 1000], [9.995, 10], [31.004, 31], [31.006, 31.01], [31.01, 31.01],
  [0.30000000000000004, 0.3], [1e-7, 0], [0.0015, 0], [12345.675, 12345.68],
  [1.115, 1.12], [1.125, 1.13], [1.135, 1.14], [8.345, 8.35], [10.075, 10.08], [0.285, 0.29],
  [4.35, 4.35], [1.4999999, 1.5], [33.335, 33.34], [0.995, 1], [0.994999, 0.99], [99999.994, 99999.99],
  [0, 0], [350.25, 350.25], [0.7, 0.7], [125.129, 125.13], [5e-7, 0], [1.5e-7, 0], [12345.6789, 12345.68], [100, 100], [0.1, 0.1],
];

describe("canonicalNumeric2", () => {
  it.each(FROM_POSTGRES)("%s → %s (lo que persiste Postgres)", (sent, stored) => {
    expect(canonicalNumeric2(sent)).toBe(stored);
  });

  it("los casos de la revisión: 165,0051 se guarda como 165,01, y 165,00 es OTRO valor", () => {
    expect(canonicalNumeric2(165.0051)).toBe(165.01);
    expect(canonicalNumeric2(165)).toBe(165);
    expect(canonicalNumeric2(165.0051)).not.toBe(canonicalNumeric2(165));
  });

  it("redondea el texto decimal, no el double: 1,005 → 1,01 aunque Math.round(1.005 * 100) / 100 dé 1", () => {
    expect(Math.round(1.005 * 100) / 100).toBe(1); // el error que se evita
    expect(canonicalNumeric2(1.005)).toBe(1.01);
    expect(Math.round(9.995 * 100) / 100).toBe(9.99);
    expect(canonicalNumeric2(9.995)).toBe(10);
  });

  it("un valor ya canónico no cambia (idempotente)", () => {
    for (const [, stored] of FROM_POSTGRES) expect(canonicalNumeric2(stored)).toBe(stored);
  });

  it("notación exponencial: se expande antes de redondear", () => {
    expect(canonicalNumeric2(1e-7)).toBe(0);
    expect(canonicalNumeric2(5e-3)).toBe(0.01);
    expect(canonicalNumeric2(1.5e3)).toBe(1500);
    expect(canonicalNumeric2(1.2345e-2)).toBe(0.01);
    expect(canonicalNumeric2(1e21)).toBe(1e21);
  });

  it("mitad hacia arriba en valor absoluto (también en negativos) y sin cero negativo", () => {
    expect(canonicalNumeric2(-1.005)).toBe(-1.01);
    expect(canonicalNumeric2(-0.004)).toBe(0);
    expect(Object.is(canonicalNumeric2(-0.004), -0)).toBe(false);
  });

  it("el acarreo cruza dígitos: 99,995 → 100 y 0,995 → 1", () => {
    expect(canonicalNumeric2(99.995)).toBe(100);
    expect(canonicalNumeric2(0.995)).toBe(1);
  });

  it("un valor no finito se devuelve tal cual", () => {
    expect(canonicalNumeric2(Number.NaN)).toBeNaN();
    expect(canonicalNumeric2(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});
