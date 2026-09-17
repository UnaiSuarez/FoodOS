import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MacroAllocationRequest, MacroPolicyRequirement } from "@foodos/types";
import { allocateDailyMacros } from "./macro-allocation-kernel";
import * as engineBarrel from "./index";

function resolved(kcalTarget: number, proteinTargetG: number, fatTargetG: number): MacroAllocationRequest {
  return { status: "resolved", kcalTarget, proteinTargetG, fatTargetG };
}

describe("seis casos reales — recalculados con las fórmulas exactas de v3.1", () => {
  // Cada caso: [requestedKcal, proteinTargetG, fatTargetG, viejoProtein, viejoFat, viejoCarbs, viejoDelta]
  // Los decimales de entrada son genuinos (calculados a mano con calcTMB/
  // ACTIVITY_FACTORS/resolveProteinBase/kcalFactor/GOAL_CONFIG.fatPct de
  // nutrition.ts para perfiles ilustrativos), no una salida ya redondeada
  // de v3.1 reutilizada como si fuera decimal.
  // Todos los "expected*" están calculados y revisados a mano a partir de
  // las entradas — nunca derivados de ningún campo que el kernel devuelva
  // (corrección de revisión final: la versión anterior comparaba
  // totalDeltaFromRequestedKcal contra result.energy.reconstructedKcal -
  // c.requestedKcal, es decir, contra OTRO campo del mismo resultado
  // recalculado con la misma resta que ya hace la implementación — no podía
  // fallar pase lo que pasara dentro del kernel, ver la demostración de
  // regresión más abajo).
  const cases: Array<{
    name: string;
    requestedKcal: number;
    proteinTargetG: number;
    fatTargetG: number;
    expectedProteinG: number;
    expectedFatG: number;
    expectedCarbsG: number;
    expectedRoundedTargetKcal: number;
    expectedInputRoundingDeltaKcal: number;
    expectedMacroDelta: number;
    expectedReconstructedKcal: number;
    expectedTotalDeltaFromRequestedKcal: number;
  }> = [
    { name: "1 — fat_loss, sedentario, sin %grasa", requestedKcal: 1779.2, proteinTargetG: 176.8, fatTargetG: 49.4222, expectedProteinG: 177, expectedFatG: 49, expectedCarbsG: 158, expectedRoundedTargetKcal: 1779, expectedInputRoundingDeltaKcal: -0.2, expectedMacroDelta: 2, expectedReconstructedKcal: 1781, expectedTotalDeltaFromRequestedKcal: 1.8 },
    { name: "2 — fat_loss, activo, gym day", requestedKcal: 2000.8, proteinTargetG: 152.4, fatTargetG: 55.5778, expectedProteinG: 152, expectedFatG: 56, expectedCarbsG: 222, expectedRoundedTargetKcal: 2001, expectedInputRoundingDeltaKcal: 0.2, expectedMacroDelta: -1, expectedReconstructedKcal: 2000, expectedTotalDeltaFromRequestedKcal: -0.8 },
    { name: "3 — fat_loss + DXA 35%", requestedKcal: 2454.4, proteinTargetG: 209.56, fatTargetG: 68.1778, expectedProteinG: 210, expectedFatG: 68, expectedCarbsG: 251, expectedRoundedTargetKcal: 2454, expectedInputRoundingDeltaKcal: -0.4, expectedMacroDelta: 2, expectedReconstructedKcal: 2456, expectedTotalDeltaFromRequestedKcal: 1.6 },
    { name: "4 — recomp, IMC<30, gym day", requestedKcal: 2340.0, proteinTargetG: 165.4, fatTargetG: 65.0, expectedProteinG: 165, expectedFatG: 65, expectedCarbsG: 274, expectedRoundedTargetKcal: 2340, expectedInputRoundingDeltaKcal: 0, expectedMacroDelta: 1, expectedReconstructedKcal: 2341, expectedTotalDeltaFromRequestedKcal: 1 },
    { name: "5 — maintain", requestedKcal: 2627.0, proteinTargetG: 164.34, fatTargetG: 81.7289, expectedProteinG: 164, expectedFatG: 82, expectedCarbsG: 308, expectedRoundedTargetKcal: 2627, expectedInputRoundingDeltaKcal: 0, expectedMacroDelta: -1, expectedReconstructedKcal: 2626, expectedTotalDeltaFromRequestedKcal: -1 },
    { name: "6 — muscle_gain, IMC<27", requestedKcal: 2174.55, proteinTargetG: 124.02, fatTargetG: 60.4042, expectedProteinG: 124, expectedFatG: 60, expectedCarbsG: 285, expectedRoundedTargetKcal: 2175, expectedInputRoundingDeltaKcal: 0.45, expectedMacroDelta: 1, expectedReconstructedKcal: 2176, expectedTotalDeltaFromRequestedKcal: 1.45 },
  ];

  for (const c of cases) {
    it(`caso ${c.name}`, () => {
      const result = allocateDailyMacros(resolved(c.requestedKcal, c.proteinTargetG, c.fatTargetG));
      if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
      expect(result.protein.assignedG).toBe(c.expectedProteinG);
      expect(result.fat.assignedG).toBe(c.expectedFatG);
      expect(result.carbs.assignedG).toBe(c.expectedCarbsG);
      // Enteros exactos -> igualdad estricta, cada uno contra una constante
      // externa calculada a mano, nunca contra otro campo del resultado.
      expect(result.energy.roundedTargetKcal).toBe(c.expectedRoundedTargetKcal);
      expect(result.energy.macroRoundingDeltaKcal).toBe(c.expectedMacroDelta);
      expect(Math.abs(result.energy.macroRoundingDeltaKcal)).toBeLessThanOrEqual(2);
      expect(result.energy.reconstructedKcal).toBe(c.expectedReconstructedKcal);
      // Decimales -> tolerancia explícita, contra constantes externas
      // calculadas a mano (nunca contra result.energy.reconstructedKcal ni
      // ningún otro campo devuelto por el kernel).
      expect(result.energy.inputRoundingDeltaKcal).toBeCloseTo(c.expectedInputRoundingDeltaKcal, 9);
      expect(result.energy.totalDeltaFromRequestedKcal).toBeCloseTo(c.expectedTotalDeltaFromRequestedKcal, 9);
      expect(Math.abs(result.energy.totalDeltaFromRequestedKcal)).toBeLessThanOrEqual(2.5);
    });
  }
});

describe("frontera de factibilidad", () => {
  it("proteína+grasa = kcal exacto -> ok, carbs=0", () => {
    // 10 y 8 ya son enteros (no sufren ajuste de redondeo): 10*4 + 8*9 = 40+72=112.
    const result = allocateDailyMacros(resolved(112, 10, 8));
    if (result.status !== "ok") throw new Error("esperado ok");
    expect(result.carbs.assignedG).toBe(0);
    expect(result.energy.reconstructedKcal).toBe(112);
  });

  it("proteína+grasa excede el redondeado por 1 kcal -> infeasible", () => {
    const result = allocateDailyMacros(resolved(100, 26, 0)); // 26*4=104 > 100
    if (result.status !== "infeasible") throw new Error("esperado infeasible");
    expect(result.exceedsRoundedTargetByKcal).toBe(4);
    expect(result.reasons).toEqual(["protein_and_fat_exceed_rounded_kcal_target"]);
  });
});

describe("sorpresa de redondeo (factibilidad se decide sobre valores YA redondeados)", () => {
  it("decimalmente factible pero el redondeo lo vuelve inviable", () => {
    // decimal: 24.5*4 + 0 = 98 <= 99.4 (factible, margen 1.4)
    // redondeado: round(24.5)=25 -> 25*4=100 > round(99.4)=99 -> infeasible
    const result = allocateDailyMacros(resolved(99.4, 24.5, 0));
    if (result.status !== "infeasible") throw new Error(`esperado infeasible, recibido ${result.status}`);
    expect(result.roundedTargetKcal).toBe(99);
    expect(result.proteinG).toBe(25);
    expect(result.exceedsRoundedTargetByKcal).toBe(1);
    // Los decimales originales quedan expuestos para que esto no sea sorprendente.
    expect(result.requestedKcal).toBe(99.4);
    expect(result.requestedProteinG).toBe(24.5);
  });

  it("decimalmente excede pero el redondeo produce una combinación viable", () => {
    // decimal: 25.4*4 + 0 = 101.6 > 100.3 (infeasible decimalmente, excede por 1.3)
    // redondeado: round(25.4)=25 -> 25*4=100 <= round(100.3)=100 -> ok, carbs=0
    const result = allocateDailyMacros(resolved(100.3, 25.4, 0));
    if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
    expect(result.protein.assignedG).toBe(25);
    expect(result.carbs.assignedG).toBe(0);
    expect(result.energy.roundedTargetKcal).toBe(100);
  });
});

describe("cero explícito — matemáticamente válido (decisión ya aprobada)", () => {
  it("proteinTargetG=0 -> ok, protein.assignedG=0", () => {
    const result = allocateDailyMacros(resolved(2000, 0, 50));
    if (result.status !== "ok") throw new Error("esperado ok");
    expect(result.protein.assignedG).toBe(0);
  });
  it("fatTargetG=0 -> ok, fat.assignedG=0", () => {
    const result = allocateDailyMacros(resolved(2000, 150, 0));
    if (result.status !== "ok") throw new Error("esperado ok");
    expect(result.fat.assignedG).toBe(0);
  });
  it("proteína y grasa ambos 0 -> ok, todo a carbohidratos", () => {
    const result = allocateDailyMacros(resolved(2000, 0, 0));
    if (result.status !== "ok") throw new Error("esperado ok");
    expect(result.protein.assignedG).toBe(0);
    expect(result.fat.assignedG).toBe(0);
    expect(result.carbs.assignedG).toBe(500);
  });
});

describe("caso mínimo representable — 'ok' es 'representable dentro del error', no 'kcal>0' (corrección de revisión final #1)", () => {
  it("kcalTarget=0.5, proteína=grasa=0 -> ok con reconstructedKcal=0 exacto", () => {
    // roundedTargetKcal=round(0.5)=1; carbsG=round(1/4)=round(0.25)=0 ->
    // reconstructedKcal=0. Sigue siendo "ok": cumple la cota matemática
    // (|macroRoundingDeltaKcal|=1 <= 2) igual que cualquier otro caso. El
    // corte de 0.5 en kcal_target_rounds_to_zero impide que el OBJETIVO
    // colapse a cero, nunca que el RESULTADO reconstruido lo haga.
    const result = allocateDailyMacros(resolved(0.5, 0, 0));
    if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
    expect(result.energy.roundedTargetKcal).toBe(1);
    expect(result.carbs.assignedG).toBe(0);
    expect(result.kcal).toBe(0);
    expect(result.energy.reconstructedKcal).toBe(0);
    expect(result.energy.macroRoundingDeltaKcal).toBe(-1);
  });
});

describe("kcalTarget que redondea a cero — umbral exacto en 0.5 (corrección de revisión #1)", () => {
  const roundsToZero = [Number.MIN_VALUE, 0.1, 0.49];
  for (const v of roundsToZero) {
    it(`kcalTarget=${v} redondea a 0 -> invalid_input`, () => {
      const result = allocateDailyMacros(resolved(v, 0, 0));
      expect(result).toEqual({ status: "invalid_input", reasons: ["kcal_target_rounds_to_zero"] });
    });
  }
  const roundsToPositive = [0.5, 0.51];
  for (const v of roundsToPositive) {
    it(`kcalTarget=${v} redondea a 1 -> ok`, () => {
      const result = allocateDailyMacros(resolved(v, 0, 0));
      if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
      expect(result.energy.roundedTargetKcal).toBe(1);
      expect(result.carbs.assignedG).toBe(0); // round(1/4)=0
    });
  }
});

describe("rango numérico seguro (corrección de revisión #2 y #6)", () => {
  it("kcalTarget = Number.MAX_SAFE_INTEGER, protein=fat=0 -> invalid_input (falla en la fase de carbohidratos, no en la primera)", () => {
    // Verificado numéricamente: roundedTargetKcal/remainingKcal/carbsG siguen
    // siendo seguros, pero carbsG*4 = 2^53 dejan de serlo — demuestra que el
    // primer barrido de rango seguro NO basta y hace falta el segundo.
    const result = allocateDailyMacros(resolved(Number.MAX_SAFE_INTEGER, 0, 0));
    expect(result).toEqual({ status: "invalid_input", reasons: ["numeric_range_unsafe"] });
  });

  it("kcalTarget ligeramente menor (MAX_SAFE_INTEGER - 4) -> ok (el borde es exacto, no una zona difusa)", () => {
    const result = allocateDailyMacros(resolved(Number.MAX_SAFE_INTEGER - 4, 0, 0));
    expect(result.status).toBe("ok");
  });

  it("proteína/grasa cercanas a MAX_SAFE_INTEGER -> invalid_input, numeric_range_unsafe (falla ya en la primera fase)", () => {
    const result = allocateDailyMacros(resolved(100, Number.MAX_SAFE_INTEGER, 0));
    expect(result).toEqual({ status: "invalid_input", reasons: ["numeric_range_unsafe"] });
  });
});

describe("validación — entrada cruda", () => {
  const invalidKcal = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const v of invalidKcal) {
    it(`kcalTarget=${v} -> invalid_input/kcal_target_invalid`, () => {
      const result = allocateDailyMacros(resolved(v, 10, 10));
      expect(result).toEqual({ status: "invalid_input", reasons: ["kcal_target_invalid"] });
    });
  }
  const invalidGrams = [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const v of invalidGrams) {
    it(`proteinTargetG=${v} -> invalid_input/protein_target_invalid`, () => {
      const result = allocateDailyMacros(resolved(2000, v, 10));
      expect(result).toEqual({ status: "invalid_input", reasons: ["protein_target_invalid"] });
    });
    it(`fatTargetG=${v} -> invalid_input/fat_target_invalid`, () => {
      const result = allocateDailyMacros(resolved(2000, 10, v));
      expect(result).toEqual({ status: "invalid_input", reasons: ["fat_target_invalid"] });
    });
  }

  it("varios campos inválidos a la vez -> todas las razones, en orden canónico, sin importar el orden de las comprobaciones internas", () => {
    const result = allocateDailyMacros(resolved(Number.NaN, Number.NaN, 10));
    expect(result).toEqual({ status: "invalid_input", reasons: ["kcal_target_invalid", "protein_target_invalid"] });
  });

  it("nunca lanza para ninguna combinación de valores inválidos", () => {
    const values = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 100];
    for (const kcal of values) {
      for (const protein of values) {
        for (const fat of values) {
          expect(() => allocateDailyMacros(resolved(kcal, protein, fat))).not.toThrow();
        }
      }
    }
  });
});

describe("unresolved_input — política sin resolver, nunca simulada con 0/NaN (corrección de revisión #1 y #4)", () => {
  const allReasons: MacroPolicyRequirement[] = [
    "kcal_target_not_resolved",
    "protein_target_not_resolved",
    "fat_target_not_resolved",
  ];

  for (const reason of allReasons) {
    it(`reasons=["${reason}"] -> unresolved_input con ese único motivo`, () => {
      const result = allocateDailyMacros({ status: "unresolved", reasons: [reason] });
      expect(result).toEqual({ status: "unresolved_input", reasons: [reason] });
    });
  }

  it("duplicados y orden invertido -> canonicalizado, sin duplicados, orden fijo", () => {
    const input: MacroPolicyRequirement[] = ["fat_target_not_resolved", "kcal_target_not_resolved", "fat_target_not_resolved"];
    const result = allocateDailyMacros({ status: "unresolved", reasons: input as [MacroPolicyRequirement, ...MacroPolicyRequirement[]] });
    expect(result).toEqual({ status: "unresolved_input", reasons: ["kcal_target_not_resolved", "fat_target_not_resolved"] });
  });

  it("todas las permutaciones de los 3 motivos producen el mismo resultado canonicalizado", () => {
    const permutations: MacroPolicyRequirement[][] = [
      ["kcal_target_not_resolved", "protein_target_not_resolved", "fat_target_not_resolved"],
      ["kcal_target_not_resolved", "fat_target_not_resolved", "protein_target_not_resolved"],
      ["protein_target_not_resolved", "kcal_target_not_resolved", "fat_target_not_resolved"],
      ["protein_target_not_resolved", "fat_target_not_resolved", "kcal_target_not_resolved"],
      ["fat_target_not_resolved", "kcal_target_not_resolved", "protein_target_not_resolved"],
      ["fat_target_not_resolved", "protein_target_not_resolved", "kcal_target_not_resolved"],
    ];
    const expected = { status: "unresolved_input", reasons: allReasons };
    for (const perm of permutations) {
      expect(allocateDailyMacros({ status: "unresolved", reasons: perm as [MacroPolicyRequirement, ...MacroPolicyRequirement[]] })).toEqual(expected);
    }
  });

  it("no muta el array de reasons recibido", () => {
    const input: [MacroPolicyRequirement, ...MacroPolicyRequirement[]] = ["fat_target_not_resolved", "kcal_target_not_resolved"];
    const snapshot = [...input];
    allocateDailyMacros({ status: "unresolved", reasons: input });
    expect(input).toEqual(snapshot);
  });

  it("reasons vacío colado en runtime (bypass del tipo) -> invalid_input/unresolved_reasons_missing, nunca un unresolved_input mudo", () => {
    const request = { status: "unresolved", reasons: [] } as unknown as MacroAllocationRequest;
    const result = allocateDailyMacros(request);
    expect(result).toEqual({ status: "invalid_input", reasons: ["unresolved_reasons_missing"] });
  });

  it("reasons no es un array (bypass del tipo) -> invalid_input/unresolved_reason_invalid (distinto de 'vacío')", () => {
    const request = { status: "unresolved", reasons: "kcal_target_not_resolved" } as unknown as MacroAllocationRequest;
    expect(allocateDailyMacros(request)).toEqual({ status: "invalid_input", reasons: ["unresolved_reason_invalid"] });
  });

  it("motivo desconocido (bypass del tipo) -> invalid_input/unresolved_reason_invalid, nunca descartado en silencio", () => {
    const request = { status: "unresolved", reasons: ["bogus_reason"] } as unknown as MacroAllocationRequest;
    const result = allocateDailyMacros(request);
    expect(result).toEqual({ status: "invalid_input", reasons: ["unresolved_reason_invalid"] });
  });

  it("mezcla de motivo válido y desconocido -> invalid_input/unresolved_reason_invalid, no se queda solo con el válido", () => {
    const request = {
      status: "unresolved",
      reasons: ["kcal_target_not_resolved", "bogus_reason"],
    } as unknown as MacroAllocationRequest;
    const result = allocateDailyMacros(request);
    expect(result).toEqual({ status: "invalid_input", reasons: ["unresolved_reason_invalid"] });
  });
});

describe("guarda total sobre `request` — nunca lanza, sin importar qué llegue (corrección de revisión final #2)", () => {
  const malformedRequests: Array<{ label: string; value: unknown }> = [
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "string", value: "resolved" },
    { label: "número", value: 42 },
    { label: "boolean", value: true },
    { label: "array vacío", value: [] },
    { label: "array con contenido", value: [1, 2, 3] },
    { label: "objeto sin status", value: { kcalTarget: 2000, proteinTargetG: 150, fatTargetG: 60 } },
    { label: "status desconocido", value: { status: "something_else", kcalTarget: 2000, proteinTargetG: 150, fatTargetG: 60 } },
  ];

  for (const { label, value } of malformedRequests) {
    it(`${label} -> invalid_input/request_status_invalid, nunca lanza`, () => {
      const request = value as unknown as MacroAllocationRequest;
      expect(() => allocateDailyMacros(request)).not.toThrow();
      expect(allocateDailyMacros(request)).toEqual({ status: "invalid_input", reasons: ["request_status_invalid"] });
    });
  }

  it("objeto 'resolved' con los tres campos numéricos ausentes -> las razones numéricas correspondientes, no request_status_invalid", () => {
    const request = { status: "resolved" } as unknown as MacroAllocationRequest;
    expect(() => allocateDailyMacros(request)).not.toThrow();
    expect(allocateDailyMacros(request)).toEqual({
      status: "invalid_input",
      reasons: ["kcal_target_invalid", "protein_target_invalid", "fat_target_invalid"],
    });
  });

  it("objeto 'unresolved' con reasons no-array -> unresolved_reason_invalid, no request_status_invalid (el status en sí es válido)", () => {
    const request = { status: "unresolved", reasons: 12345 } as unknown as MacroAllocationRequest;
    expect(() => allocateDailyMacros(request)).not.toThrow();
    expect(allocateDailyMacros(request)).toEqual({ status: "invalid_input", reasons: ["unresolved_reason_invalid"] });
  });
});

describe("API público del barrel — packages/engine/src/index.ts (corrección de revisión final #1)", () => {
  it("expone allocateDailyMacros y nada de los canonicalizadores internos de PR2A", () => {
    const barrel = engineBarrel as Record<string, unknown>;
    expect(typeof barrel.allocateDailyMacros).toBe("function");
    expect(barrel.dedupeAndOrderInvalidReasons).toBeUndefined();
    expect(barrel.dedupeAndOrderPolicyRequirements).toBeUndefined();
  });

  it("allocateDailyMacros importado desde el barrel se comporta igual que el import directo", () => {
    expect(engineBarrel.allocateDailyMacros(resolved(112, 10, 8))).toEqual(allocateDailyMacros(resolved(112, 10, 8)));
  });
});

describe("barrido determinista del límite de redondeo", () => {
  it("|macroRoundingDeltaKcal| <= 2 y |totalDeltaFromRequestedKcal| <= 2.5 para un barrido amplio, y ningún 'ok' contiene NaN/Infinito/entero inseguro (corrección de revisión final #3)", () => {
    const proteinOptions = [0, 50, 120.3, 200];
    const fatOptions = [0, 30.7, 70, 90.9];
    let okCount = 0;
    for (let kcal = 1200; kcal <= 1260; kcal += 1) {
      for (const protein of proteinOptions) {
        for (const fat of fatOptions) {
          const result = allocateDailyMacros(resolved(kcal, protein, fat));
          if (result.status !== "ok") continue; // combinaciones infeasible no aplican al límite de redondeo
          okCount++;
          // Enteros exactos -> igualdad/comparación estricta.
          expect(Math.abs(result.energy.macroRoundingDeltaKcal)).toBeLessThanOrEqual(2);
          // Decimales -> tolerancia explícita (corrección de revisión #3 de la ronda anterior).
          expect(Math.abs(result.energy.totalDeltaFromRequestedKcal)).toBeLessThanOrEqual(2.5);
          // Ningún campo numérico de un resultado "ok" es NaN, ±Infinito, ni
          // (para los enteros) un valor fuera de Number.isSafeInteger.
          for (const n of [
            result.protein.assignedG, result.fat.assignedG, result.carbs.assignedG, result.kcal,
            result.energy.roundedTargetKcal, result.energy.reconstructedKcal, result.energy.macroRoundingDeltaKcal,
          ]) {
            expect(Number.isSafeInteger(n)).toBe(true);
          }
          for (const n of [
            result.energy.requestedKcal, result.energy.inputRoundingDeltaKcal, result.energy.totalDeltaFromRequestedKcal,
            result.protein.requestedG, result.protein.deltaG, result.fat.requestedG, result.fat.deltaG,
          ]) {
            expect(Number.isFinite(n)).toBe(true);
          }
        }
      }
    }
    expect(okCount).toBeGreaterThan(0); // confirma que de verdad ejercitamos casos "ok", no solo infeasible
  });
});

describe("las dos fases de rango numérico seguro son ambas necesarias (corrección de revisión final #3)", () => {
  it("un valor cerca de MAX_SAFE_INTEGER en proteína/grasa falla en la PRIMERA fase (antes de calcular carbohidratos)", () => {
    const result = allocateDailyMacros(resolved(100, Number.MAX_SAFE_INTEGER, 0));
    expect(result).toEqual({ status: "invalid_input", reasons: ["numeric_range_unsafe"] });
  });
  it("kcalTarget = MAX_SAFE_INTEGER con proteína/grasa en 0 pasa la primera fase pero falla en la SEGUNDA (carbsG*4 desborda)", () => {
    const result = allocateDailyMacros(resolved(Number.MAX_SAFE_INTEGER, 0, 0));
    expect(result).toEqual({ status: "invalid_input", reasons: ["numeric_range_unsafe"] });
  });
});

describe("determinismo", () => {
  it("misma entrada -> misma salida, profundamente idéntica", () => {
    const req = resolved(2338.7, 187.3, 65.2);
    const a = allocateDailyMacros(req);
    const b = allocateDailyMacros({ ...req });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("pureza — sin reloj, red, almacenamiento ni estado global", () => {
  it("el archivo del kernel no referencia ninguna fuente de no-determinismo o efecto lateral", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "macro-allocation-kernel.ts"), "utf-8");
    const forbidden = /Date\.|Math\.random|fetch\(|localStorage|sessionStorage|process\.env|globalThis|setTimeout|setInterval/;
    expect(forbidden.test(source)).toBe(false);
  });
});

describe("confirmación estructural — apps/web no importa macro-allocation-kernel (mismo alcance que el test de PR1)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const webSrcPath = join(repoRoot, "apps", "web", "src");

  function walkSourceFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkSourceFiles(fullPath));
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it("ningún archivo de apps/web/src menciona @foodos/engine ni packages/engine", () => {
    const files = walkSourceFiles(webSrcPath);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => {
      const content = readFileSync(f, "utf-8");
      return /@foodos\/engine/.test(content) || /packages\/engine/.test(content);
    });
    expect(offenders).toEqual([]);
  });
});
