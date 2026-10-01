// Pruebas de protección del gateway — nunca asumen que la firma
// (input -> resultado, sin cliente de Supabase ni setter) basta por sí
// sola para demostrar ausencia de efectos secundarios: lo comprueban en
// tiempo de ejecución.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyIntegrityWindowInput } from "@foodos/types";
import { evaluateDiaryNutrientCoverageReadOnly } from "./nutrition-v4-coverage-gateway";

function input(overrides: Partial<DailyIntegrityWindowInput> = {}): DailyIntegrityWindowInput {
  return {
    startDateKey: "2026-02-01",
    endDateKey: "2026-02-28",
    entries: [
      {
        dateKey: "2026-02-03",
        nutrients: { kcal: { status: "known_nonzero", value: 500 } },
        quantityConfidence: "low",
        foodStateConfidence: "confirmed",
        energyConsistency: "not_evaluable",
      },
    ],
    dailyReliabilityThreshold: 0.8,
    provisionalKcalFractionThreshold: 0.25,
    ...overrides,
  };
}

describe("evaluateDiaryNutrientCoverageReadOnly — determinismo y pureza", () => {
  it("la misma entrada produce dos resultados profundamente iguales", () => {
    const a = evaluateDiaryNutrientCoverageReadOnly(input());
    const b = evaluateDiaryNutrientCoverageReadOnly(input());
    expect(a).toEqual(b);
  });

  it("no muta el input recibido, ni siquiera sus objetos anidados (entries)", () => {
    const i = input();
    const snapshot = JSON.parse(JSON.stringify(i));
    evaluateDiaryNutrientCoverageReadOnly(i);
    expect(i).toEqual(snapshot);
  });

  // Nota deliberada: este archivo NO importa el paquete de motores
  // directamente para comparar contra el kernel "crudo" — aunque es un
  // archivo de test, sigue viviendo bajo apps/web/src, y la prueba de
  // frontera (findWebSrcBoundaryOffenders) escanea TODO archivo fuente de
  // ese árbol, pruebas incluidas, con una única excepción (el propio
  // gateway). La equivalencia con la función real que este gateway envuelve
  // ya la verifica, a nivel de AST, la suite del kernel correspondiente: que
  // el gateway la importa y la reexpone exacta, sin envolverla con ninguna
  // transformación. Aquí solo se verifica EL CONTRATO del gateway
  // (determinismo, no-mutación, cero red), no una comparación byte a byte
  // con esa función.
});

describe("evaluateDiaryNutrientCoverageReadOnly — cero red, cero E/S", () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Si el gateway (o cualquier dependencia transitiva, hoy o en el
    // futuro) intentara hacer una petición de red, esta sustitución lo
    // delata: la llamada lanzaría de inmediato, no se "colaría" en
    // silencio. La firma por sí sola (sin un cliente de red como
    // parámetro) no demuestra esto — esta prueba sí lo ejerce.
    globalThis.fetch = vi.fn(() => {
      throw new Error("evaluateDiaryNutrientCoverageReadOnly no debe hacer peticiones de red");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("no hace ninguna petición de red al evaluar una ventana con varias entradas y días vacíos", () => {
    const i = input({
      entries: [
        ...input().entries,
        { dateKey: "2026-02-10", nutrients: {}, quantityConfidence: "low", foodStateConfidence: "unknown", energyConsistency: "not_evaluable" },
      ],
    });
    expect(() => evaluateDiaryNutrientCoverageReadOnly(i)).not.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("no hace ninguna petición de red ante un input inválido (status invalid_input)", () => {
    const i = input({ startDateKey: "no-es-una-fecha" });
    const result = evaluateDiaryNutrientCoverageReadOnly(i);
    expect(result.status).toBe("invalid_input");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
