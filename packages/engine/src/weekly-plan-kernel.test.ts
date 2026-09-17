import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import type {
  DayLabel,
  DayMacroPolicyRequirement,
  MacroAllocationInfeasible,
  MacroAllocationInvalidInput,
  MacroAllocationOk,
  MacroAllocationUnresolvedInput,
  WeeklyDistributionPolicy,
  WeeklyPlanDayInput,
  WeeklyPlanInfeasible,
  WeeklyPlanInfeasibleDayResult,
  WeeklyPlanInvalidDailyAllocationError,
  WeeklyPlanInvalidRequestError,
  WeeklyPlanOk,
  WeeklyPlanOkDayResult,
  WeeklyPlanPartialDayDiagnosticKind,
  WeeklyPlanRequest,
  WeeklyPlanUnresolvedInput,
} from "@foodos/types";
import { planWeek } from "./weekly-plan-kernel";
import * as engineBarrel from "./index";

// ─── Constructores de fixtures — independientes del kernel ────────────

/** Genera `count` dateKeys consecutivos a partir de (y,m,d) usando
    Date.UTC — deliberadamente independiente del algoritmo days_from_civil
    del kernel, para no verificar la implementación contra sí misma. */
function consecutiveDateKeys(y: number, m: number, d: number, count = 7): string[] {
  const start = Date.UTC(y, m - 1, d);
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return keys;
}

const WEEK1 = consecutiveDateKeys(2026, 9, 21, 7); // ["2026-09-21", ..., "2026-09-27"]

function resolvedDay(dateKey: string, label: DayLabel, proteinTargetG: number, fatTargetG: number): WeeklyPlanDayInput {
  return { dateKey, label, macros: { status: "resolved", proteinTargetG, fatTargetG } };
}

function unresolvedDay(
  dateKey: string,
  label: DayLabel,
  reasons: [DayMacroPolicyRequirement, ...DayMacroPolicyRequirement[]],
): WeeklyPlanDayInput {
  return { dateKey, label, macros: { status: "unresolved", reasons } };
}

function neutralWeek(proteinTargetG = 0, fatTargetG = 0): WeeklyPlanDayInput[] {
  return WEEK1.map((dateKey) => resolvedDay(dateKey, "unclassified", proteinTargetG, fatTargetG));
}

function requestWith(distribution: WeeklyDistributionPolicy, weeklyKcalTarget: number, days: WeeklyPlanDayInput[]): WeeklyPlanRequest {
  return { energyPolicy: { status: "resolved", weeklyKcalTarget, distribution }, days };
}

function uniformRequest(weeklyKcalTarget: number, days: WeeklyPlanDayInput[]): WeeklyPlanRequest {
  return requestWith({ kind: "uniform" }, weeklyKcalTarget, days);
}

// ─── Fase 1 — casos numéricos verificados a mano durante el diseño ────

describe("caso 1 — uniform, división exacta (verificado a mano)", () => {
  it("14000 kcal / 7 días -> 2000 cada uno, ok, energy audit exacto", () => {
    const result = planWeek(uniformRequest(14000, neutralWeek(150, 60)));
    if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
    expect(result.days.map((d) => d.distributedKcalTarget)).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 2000]);
    expect(result.days.map((d) => d.dateKey)).toEqual(WEEK1);
    for (const d of result.days) {
      if (d.allocation.status !== "ok") throw new Error("esperado ok por día");
      expect(d.allocation.protein.assignedG).toBe(150);
      expect(d.allocation.fat.assignedG).toBe(60);
      expect(d.allocation.carbs.assignedG).toBe(215);
      expect(d.allocation.kcal).toBe(2000);
    }
    expect(result.energy).toEqual({
      requestedWeeklyKcal: 14000,
      roundedWeeklyKcalTarget: 14000,
      distributedWeeklyKcalTotal: 14000,
      distributionRoundingDeltaKcal: 0,
      reconstructedWeeklyKcalTotal: 14000,
      macroReconstructionDeltaKcal: 0,
      totalDeltaFromRequestedWeeklyKcal: 0,
    });
  });
});

describe("caso 2 — weighted_by_label, remainder 'intuitivo pero equivocado' (verificado a mano)", () => {
  const days = [
    resolvedDay(WEEK1[0], "strength", 150, 60),
    resolvedDay(WEEK1[1], "strength", 150, 60),
    resolvedDay(WEEK1[2], "strength", 150, 60),
    resolvedDay(WEEK1[3], "rest", 150, 60),
    resolvedDay(WEEK1[4], "rest", 150, 60),
    resolvedDay(WEEK1[5], "rest", 150, 60),
    resolvedDay(WEEK1[6], "rest", 150, 60),
  ];
  const req = requestWith({ kind: "weighted_by_label", weights: { strength: 1.15, rest: 0.9 } }, 15000, days);

  it("el remainder de rest (0.9) es MAYOR que el de strength (1.15) pese al peso menor -> rest recibe el sobrante primero", () => {
    const result = planWeek(req);
    if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
    expect(result.days.map((d) => d.distributedKcalTarget)).toEqual([2447, 2447, 2446, 1915, 1915, 1915, 1915]);
    expect(result.energy.distributedWeeklyKcalTotal).toBe(15000);
    expect(result.energy.distributionRoundingDeltaKcal).toBe(0);
  });
});

describe("caso 3 — uniform, remainder no divisible (verificado a mano)", () => {
  it("2200.3 kcal (redondea a 2200) / 7 -> [315,315,314,314,314,314,314]", () => {
    const result = planWeek(uniformRequest(2200.3, neutralWeek()));
    if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
    expect(result.days.map((d) => d.distributedKcalTarget)).toEqual([315, 315, 314, 314, 314, 314, 314]);
    expect(result.energy.roundedWeeklyKcalTarget).toBe(2200);
    expect(result.energy.requestedWeeklyKcal).toBe(2200.3);
  });
});

describe("caso 4 — mínimo representable y cuota no positiva (verificado a mano)", () => {
  it("weeklyKcalTarget=10 -> [2,2,2,1,1,1,1], todo positivo, ok", () => {
    const result = planWeek(uniformRequest(10, neutralWeek()));
    if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
    expect(result.days.map((d) => d.distributedKcalTarget)).toEqual([2, 2, 2, 1, 1, 1, 1]);
  });

  it("weeklyKcalTarget=4 -> [1,1,1,1,0,0,0], las 3 fechas con 0 nunca llaman a PR2A -> infeasible", () => {
    const result = planWeek(uniformRequest(4, neutralWeek()));
    if (result.status !== "infeasible") throw new Error(`esperado infeasible, recibido ${result.status}`);
    expect(result.reasons).toEqual(["distributed_kcal_target_non_positive"]);
    expect(result.days.map((d) => d.dateKey)).toEqual(WEEK1.slice(0, 4));
    expect(result.days.every((d) => d.allocation.status === "ok")).toBe(true);
    const zeroShareDates = result.partialDiagnostics
      .filter((d) => d.diagnostic.kind === "non_positive_share")
      .map((d) => d.dateKey);
    expect(zeroShareDates).toEqual(WEEK1.slice(4));
    for (const diag of result.partialDiagnostics) {
      if (diag.diagnostic.kind === "non_positive_share") {
        expect(diag.diagnostic.distributedKcalTarget).toBe(0);
      }
    }
  });
});

describe("caso 5 — un día individualmente inviable (verificado a mano)", () => {
  it("10500 kcal uniform -> 1500/día; 6 días ok (reconstructedKcal=1502), 1 día infeasible (excede por 600)", () => {
    const days = WEEK1.map((dateKey) =>
      dateKey === WEEK1[3] ? resolvedDay(dateKey, "unclassified", 300, 100) : resolvedDay(dateKey, "unclassified", 100, 50),
    );
    const result = planWeek(uniformRequest(10500, days));
    if (result.status !== "infeasible") throw new Error(`esperado infeasible, recibido ${result.status}`);
    expect(result.reasons).toEqual(["macro_allocation_infeasible"]);
    expect(result.days).toHaveLength(7);
    const infeasibleDay = result.days.find((d) => d.dateKey === WEEK1[3]);
    if (!infeasibleDay || infeasibleDay.allocation.status !== "infeasible") throw new Error("esperado día infeasible");
    expect(infeasibleDay.allocation.exceedsRoundedTargetByKcal).toBe(600);
    for (const d of result.days) {
      if (d.dateKey === WEEK1[3]) continue;
      if (d.allocation.status !== "ok") throw new Error("esperado ok");
      expect(d.allocation.energy.reconstructedKcal).toBe(1502);
      expect(d.allocation.energy.macroRoundingDeltaKcal).toBe(2);
    }
    expect(result.partialDiagnostics).toHaveLength(1);
    expect(result.partialDiagnostics[0].dateKey).toBe(WEEK1[3]);
    expect(result.partialDiagnostics[0].diagnostic.kind).toBe("infeasible");
  });
});

describe("un rechazo de PR2A produce invalid_input, NUNCA infeasible (corrección de v2->v3)", () => {
  it("proteína cercana a MAX_SAFE_INTEGER en un día -> invalid_input/daily_allocation, no infeasible", () => {
    const days = WEEK1.map((dateKey) =>
      dateKey === WEEK1[2] ? resolvedDay(dateKey, "unclassified", Number.MAX_SAFE_INTEGER, 50) : resolvedDay(dateKey, "unclassified", 100, 50),
    );
    const result = planWeek(uniformRequest(14000, days));
    if (result.status !== "invalid_input" || result.scope !== "daily_allocation") {
      throw new Error(`esperado invalid_input/daily_allocation, recibido ${JSON.stringify(result)}`);
    }
    expect(result.reasons).toEqual(["daily_macro_allocation_invalid"]);
    expect(result.partialDiagnostics).toHaveLength(1);
    const diag = result.partialDiagnostics[0];
    expect(diag.dateKey).toBe(WEEK1[2]);
    if (diag.diagnostic.kind !== "rejected_by_pr2a") throw new Error("esperado rejected_by_pr2a");
    expect(diag.diagnostic.allocation).toEqual({ status: "invalid_input", reasons: ["numeric_range_unsafe"] });
  });
});

describe("explicit_daily_targets — la suma debe coincidir EXACTAMENTE con el objetivo semanal redondeado", () => {
  it("suma 14100 vs weeklyKcalTarget 14000 -> invalid_input/request, explicit_daily_targets_sum_mismatch", () => {
    const dailyKcalTargets: Record<string, number> = {};
    const values = [2000, 2000, 2000, 2000, 2000, 2000, 2100];
    WEEK1.forEach((dateKey, i) => (dailyKcalTargets[dateKey] = values[i]));
    const req = requestWith({ kind: "explicit_daily_targets", dailyKcalTargets }, 14000, neutralWeek());
    const result = planWeek(req);
    expect(result).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["explicit_daily_targets_sum_mismatch"],
    });
  });

  it("suma exacta -> ok, distributedKcalTarget = el valor explícito de cada día", () => {
    const dailyKcalTargets: Record<string, number> = {};
    const values = [2000, 2000, 2000, 2000, 2000, 2000, 2000];
    WEEK1.forEach((dateKey, i) => (dailyKcalTargets[dateKey] = values[i]));
    const req = requestWith({ kind: "explicit_daily_targets", dailyKcalTargets }, 14000, neutralWeek());
    const result = planWeek(req);
    if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
    expect(result.days.map((d) => d.distributedKcalTarget)).toEqual(values);
  });
});

describe("weighted_by_date — el resultado es independiente del orden de `days` en la entrada", () => {
  const weights: Record<string, number> = {};
  [1.15, 1.15, 1.15, 0.9, 0.9, 0.9, 0.9].forEach((w, i) => (weights[WEEK1[i]] = w));
  const days = [
    resolvedDay(WEEK1[0], "unclassified", 0, 0),
    resolvedDay(WEEK1[1], "unclassified", 0, 0),
    resolvedDay(WEEK1[2], "unclassified", 0, 0),
    resolvedDay(WEEK1[3], "unclassified", 0, 0),
    resolvedDay(WEEK1[4], "unclassified", 0, 0),
    resolvedDay(WEEK1[5], "unclassified", 0, 0),
    resolvedDay(WEEK1[6], "unclassified", 0, 0),
  ];
  const req = requestWith({ kind: "weighted_by_date", weights }, 15000, days);
  const reversedReq = requestWith({ kind: "weighted_by_date", weights }, 15000, [...days].reverse());

  it("orden original y orden invertido producen exactamente el mismo reparto por fecha", () => {
    const a = planWeek(req);
    const b = planWeek(reversedReq);
    if (a.status !== "ok" || b.status !== "ok") throw new Error("esperado ok en ambos");
    expect(a.days).toEqual(b.days);
    expect(a.days.map((d) => d.dateKey)).toEqual(WEEK1); // siempre ordenado por dateKey
    expect(a.days.map((d) => d.distributedKcalTarget)).toEqual([2447, 2447, 2446, 1915, 1915, 1915, 1915]);
  });
});

describe("pesos — desbordamiento, underflow, y precisión segura (verificado a mano)", () => {
  function dateWeights(values: number[]): Record<string, number> {
    const weights: Record<string, number> = {};
    WEEK1.forEach((dateKey, i) => (weights[dateKey] = values[i]));
    return weights;
  }

  it("desbordamiento — MAX_VALUE en los 7 días normaliza a 1 cada uno -> recupera el reparto uniform", () => {
    const weights = dateWeights(new Array(7).fill(Number.MAX_VALUE));
    const req = requestWith({ kind: "weighted_by_date", weights }, 14000, neutralWeek());
    const result = planWeek(req);
    if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
    expect(result.days.map((d) => d.distributedKcalTarget)).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 2000]);
  });

  it("underflow — un peso positivo (MIN_VALUE) normaliza a 0 exacto junto a MAX_VALUE -> rechazado, nunca tratado como 0 legítimo", () => {
    const weights = dateWeights([Number.MIN_VALUE, ...new Array(6).fill(Number.MAX_VALUE)]);
    const req = requestWith({ kind: "weighted_by_date", weights }, 14000, neutralWeek());
    expect(planWeek(req)).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["distribution_weights_numeric_range_unsafe"],
    });
  });

  it("seguro pero desigual — [1,1e10,1e10,1e10,1,1,1] no subdesborda a 0 -> nunca se rechaza por seguridad numérica", () => {
    const weights = dateWeights([1, 1e10, 1e10, 1e10, 1, 1, 1]);
    const req = requestWith({ kind: "weighted_by_date", weights }, 14000, neutralWeek());
    const result = planWeek(req);
    const rejectedForSafety =
      result.status === "invalid_input" &&
      result.scope === "request" &&
      (result.reasons.includes("distribution_weights_numeric_range_unsafe") ||
        result.reasons.includes("distribution_weights_all_zero"));
    expect(rejectedForSafety).toBe(false);
  });

  it("todos los pesos en 0 -> invalid_input/request, distribution_weights_all_zero", () => {
    const weights = dateWeights(new Array(7).fill(0));
    const req = requestWith({ kind: "weighted_by_date", weights }, 14000, neutralWeek());
    expect(planWeek(req)).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["distribution_weights_all_zero"],
    });
  });

  it("invarianza de escala — multiplicar todos los pesos por 100 produce el MISMO reparto entero final", () => {
    const weightsA = dateWeights([1.15, 1.15, 1.15, 0.9, 0.9, 0.9, 0.9]);
    const weightsB = dateWeights([115, 115, 115, 90, 90, 90, 90]);
    const reqA = requestWith({ kind: "weighted_by_date", weights: weightsA }, 15000, neutralWeek());
    const reqB = requestWith({ kind: "weighted_by_date", weights: weightsB }, 15000, neutralWeek());
    const resultA = planWeek(reqA);
    const resultB = planWeek(reqB);
    if (resultA.status !== "ok" || resultB.status !== "ok") throw new Error("esperado ok en ambos");
    expect(resultA.days.map((d) => d.distributedKcalTarget)).toEqual([2447, 2447, 2446, 1915, 1915, 1915, 1915]);
    expect(resultA.days.map((d) => d.distributedKcalTarget)).toEqual(resultB.days.map((d) => d.distributedKcalTarget));
  });

  it("magnitud extrema — weeklyKcalTarget = Number.MAX_SAFE_INTEGER, uniform: reparto seguro y suma exacta (verificado con un script Node independiente, no con otro campo del propio resultado)", () => {
    // Valores calculados de antemano con un script Node aparte (no con el
    // kernel): 9007199254740991/7 -> rawShare = 1286742750677284.2 en coma
    // flotante (la fracción real, 0.4285714..., se pierde parcialmente a
    // esta magnitud, pero floor() sigue dando el mismo entero), floor =
    // 1286742750677284 en los 7, flooredSum = 9007199254740988, leftover =
    // 3 (dentro de [0,7)) -> los 3 primeros dateKeys (orden ascendente)
    // reciben +1. Suma final = 3*1286742750677285 + 4*1286742750677284 =
    // 9007199254740991, exactamente roundedWeeklyKcalTarget.
    const expectedDistributed = [
      1286742750677285, 1286742750677285, 1286742750677285,
      1286742750677284, 1286742750677284, 1286742750677284, 1286742750677284,
    ];
    const req = uniformRequest(Number.MAX_SAFE_INTEGER, neutralWeek(0, 0));
    const result = planWeek(req);
    if (result.status !== "ok") throw new Error(`esperado ok, recibido ${result.status}`);
    expect(result.days.map((d) => d.distributedKcalTarget)).toEqual(expectedDistributed);
    expect(result.days.every((d) => Number.isSafeInteger(d.distributedKcalTarget))).toBe(true);
    const sum = expectedDistributed.reduce((a, b) => a + b, 0);
    expect(sum).toBe(Number.MAX_SAFE_INTEGER); // constante externa, no result.energy.distributedWeeklyKcalTotal
    expect(result.energy.distributedWeeklyKcalTotal).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.energy.distributionRoundingDeltaKcal).toBe(0);
  });
});

describe("fechas reales — bisiestos, cambio de año, formato y rango (verificado independientemente vía Date.UTC)", () => {
  it("2028 es bisiesto — 2028-02-27..2028-03-04 (incluye 29 feb) son 7 fechas consecutivas válidas", () => {
    const dates = consecutiveDateKeys(2028, 2, 27, 7);
    expect(dates).toContain("2028-02-29");
    const result = planWeek(uniformRequest(14000, dates.map((d) => resolvedDay(d, "unclassified", 0, 0))));
    expect(result.status).toBe("ok");
  });

  it("2026 NO es bisiesto — 2026-02-29 no existe -> date_key_out_of_range", () => {
    const days = [
      resolvedDay("2026-02-25", "unclassified", 0, 0),
      resolvedDay("2026-02-26", "unclassified", 0, 0),
      resolvedDay("2026-02-27", "unclassified", 0, 0),
      resolvedDay("2026-02-28", "unclassified", 0, 0),
      resolvedDay("2026-02-29", "unclassified", 0, 0), // inexistente
      resolvedDay("2026-03-01", "unclassified", 0, 0),
      resolvedDay("2026-03-02", "unclassified", 0, 0),
    ];
    expect(planWeek(uniformRequest(14000, days))).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["date_key_out_of_range"],
    });
  });

  it("cambio de año — 2026-12-29..2027-01-04 son 7 fechas consecutivas válidas", () => {
    const dates = consecutiveDateKeys(2026, 12, 29, 7);
    expect(dates).toEqual(["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"]);
    const result = planWeek(uniformRequest(14000, dates.map((d) => resolvedDay(d, "unclassified", 0, 0))));
    expect(result.status).toBe("ok");
  });

  it("formato inválido (no YYYY-MM-DD) -> date_key_format_invalid", () => {
    const days = neutralWeek();
    days[0] = { ...days[0], dateKey: "21-09-2026" };
    expect(planWeek(uniformRequest(14000, days))).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["date_key_format_invalid"],
    });
  });

  it("fecha duplicada -> duplicate_date_key", () => {
    const days = neutralWeek();
    days[6] = { ...days[6], dateKey: days[0].dateKey };
    expect(planWeek(uniformRequest(14000, days))).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["duplicate_date_key"],
    });
  });

  it("7 fechas válidas pero NO consecutivas (un salto) -> date_keys_not_consecutive", () => {
    const days = neutralWeek();
    days[6] = { ...days[6], dateKey: "2026-10-05" }; // rompe la consecutividad
    expect(planWeek(uniformRequest(14000, days))).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["date_keys_not_consecutive"],
    });
  });
});

// ─── Precedencia: estructura + política resuelta ANTES que "unresolved" ─

describe("precedencia — una política resuelta pero MALFORMADA nunca se enmascara por un día pendiente (ajuste final #1)", () => {
  it("weeklyKcalTarget inválido + 1 día unresolved -> invalid_input/request, NUNCA unresolved_input", () => {
    const days = neutralWeek();
    days[3] = unresolvedDay(days[3].dateKey, "unclassified", ["protein_target_not_resolved"]);
    const req = requestWith({ kind: "uniform" }, -100, days); // weeklyKcalTarget inválido
    expect(planWeek(req)).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["weekly_kcal_target_invalid"],
    });
  });

  it("mapa de pesos con clave desconocida + 1 día unresolved -> invalid_input/request, NUNCA unresolved_input", () => {
    const days = [
      resolvedDay(WEEK1[0], "strength", 100, 50),
      resolvedDay(WEEK1[1], "strength", 100, 50),
      unresolvedDay(WEEK1[2], "rest", ["fat_target_not_resolved"]),
      resolvedDay(WEEK1[3], "rest", 100, 50),
      resolvedDay(WEEK1[4], "rest", 100, 50),
      resolvedDay(WEEK1[5], "rest", 100, 50),
      resolvedDay(WEEK1[6], "rest", 100, 50),
    ];
    const req = requestWith(
      { kind: "weighted_by_label", weights: { strength: 1, rest: 1, unclassified: 1 } as Record<string, number> },
      14000,
      days,
    );
    const result = planWeek(req as unknown as WeeklyPlanRequest);
    expect(result).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["weight_key_unknown_label"],
    });
  });
});

// ─── unresolved_input — las tres variantes de scope ────────────────────

describe("unresolved_input — las tres variantes de scope (ajuste v1->v2)", () => {
  it("scope 'energy_policy' — solo la política semanal está pendiente", () => {
    const req: WeeklyPlanRequest = {
      energyPolicy: { status: "unresolved", reasons: ["weekly_kcal_target_not_resolved"] },
      days: neutralWeek(),
    };
    const result = planWeek(req);
    expect(result).toEqual({
      status: "unresolved_input",
      scope: "energy_policy",
      weeklyReasons: ["weekly_kcal_target_not_resolved"],
    });
  });

  it("scope 'days' — política resuelta y válida, 2 días pendientes", () => {
    const days = neutralWeek();
    days[1] = unresolvedDay(days[1].dateKey, "unclassified", ["protein_target_not_resolved"]);
    days[5] = unresolvedDay(days[5].dateKey, "unclassified", ["fat_target_not_resolved", "protein_target_not_resolved"]);
    const result = planWeek(uniformRequest(14000, days));
    expect(result).toEqual({
      status: "unresolved_input",
      scope: "days",
      unresolvedDays: [
        { dateKey: days[1].dateKey, reasons: ["protein_target_not_resolved"] },
        { dateKey: days[5].dateKey, reasons: ["protein_target_not_resolved", "fat_target_not_resolved"] },
      ],
    });
  });

  it("scope 'both' — política pendiente Y al menos un día pendiente", () => {
    const days = neutralWeek();
    days[2] = unresolvedDay(days[2].dateKey, "unclassified", ["fat_target_not_resolved"]);
    const req: WeeklyPlanRequest = {
      energyPolicy: { status: "unresolved", reasons: ["distribution_policy_not_resolved"] },
      days,
    };
    expect(planWeek(req)).toEqual({
      status: "unresolved_input",
      scope: "both",
      weeklyReasons: ["distribution_policy_not_resolved"],
      unresolvedDays: [{ dateKey: days[2].dateKey, reasons: ["fat_target_not_resolved"] }],
    });
  });
});

// ─── Coexistencia: rechazo de PR2A + inviabilidad en la misma ejecución ─

describe("coexistencia — un rechazo de PR2A y una inviabilidad en el mismo intento -> invalid_input conserva AMBOS diagnósticos", () => {
  it("día A rechazado por PR2A + día B nutricionalmente inviable -> invalid_input/daily_allocation con 2 partialDiagnostics", () => {
    const days = [
      resolvedDay(WEEK1[0], "unclassified", Number.MAX_SAFE_INTEGER, 50), // rechazado por PR2A
      resolvedDay(WEEK1[1], "unclassified", 300, 100), // inviable (400+900=1300 > 1500? usemos target bajo)
      resolvedDay(WEEK1[2], "unclassified", 0, 0),
      resolvedDay(WEEK1[3], "unclassified", 0, 0),
      resolvedDay(WEEK1[4], "unclassified", 0, 0),
      resolvedDay(WEEK1[5], "unclassified", 0, 0),
      resolvedDay(WEEK1[6], "unclassified", 0, 0),
    ];
    // uniform 700/día: día B usa 300*4+100*9=2100 > 700 -> infeasible.
    const result = planWeek(uniformRequest(4900, days));
    if (result.status !== "invalid_input" || result.scope !== "daily_allocation") {
      throw new Error(`esperado invalid_input/daily_allocation, recibido ${JSON.stringify(result)}`);
    }
    expect(result.reasons).toEqual(["daily_macro_allocation_invalid"]);
    expect(result.partialDiagnostics).toHaveLength(2);
    const kinds = result.partialDiagnostics.map((d) => d.diagnostic.kind).sort();
    expect(kinds).toEqual(["infeasible", "rejected_by_pr2a"]);
    expect(result.partialDiagnostics.map((d) => d.dateKey).sort()).toEqual([WEEK1[0], WEEK1[1]].sort());
  });
});

// ─── Contratos malformados en runtime ──────────────────────────────────

describe("guarda total sobre `request` — nunca lanza, sin importar qué llegue", () => {
  const malformed: Array<{ label: string; value: unknown }> = [
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "string", value: "resolved" },
    { label: "número", value: 42 },
    { label: "boolean", value: true },
    { label: "array vacío", value: [] },
    { label: "array con contenido", value: [1, 2, 3] },
  ];
  for (const { label, value } of malformed) {
    it(`${label} -> invalid_input/request/request_object_invalid, nunca lanza`, () => {
      const req = value as unknown as WeeklyPlanRequest;
      expect(() => planWeek(req)).not.toThrow();
      expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["request_object_invalid"] });
    });
  }

  it("energyPolicy ausente -> energy_policy_status_invalid; days ausente -> days_not_array (ambos a la vez)", () => {
    const req = {} as unknown as WeeklyPlanRequest;
    expect(() => planWeek(req)).not.toThrow();
    expect(planWeek(req)).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["energy_policy_status_invalid", "days_not_array"],
    });
  });

  it("energyPolicy.status desconocido -> energy_policy_status_invalid", () => {
    const req = { energyPolicy: { status: "bogus" }, days: neutralWeek() } as unknown as WeeklyPlanRequest;
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["energy_policy_status_invalid"] });
  });

  it("energyPolicy unresolved con reasons vacío -> energy_policy_reasons_invalid", () => {
    const req = { energyPolicy: { status: "unresolved", reasons: [] }, days: neutralWeek() } as unknown as WeeklyPlanRequest;
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["energy_policy_reasons_invalid"] });
  });

  it("energyPolicy unresolved con motivo desconocido -> energy_policy_reasons_invalid, no se descarta en silencio", () => {
    const req = {
      energyPolicy: { status: "unresolved", reasons: ["bogus_reason"] },
      days: neutralWeek(),
    } as unknown as WeeklyPlanRequest;
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["energy_policy_reasons_invalid"] });
  });

  it("days no es un array -> days_not_array", () => {
    const req = { energyPolicy: { status: "resolved", weeklyKcalTarget: 14000, distribution: { kind: "uniform" } }, days: "nope" } as unknown as WeeklyPlanRequest;
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["days_not_array"] });
  });

  it("days con 6 elementos -> days_count_invalid", () => {
    const req = uniformRequest(14000, neutralWeek().slice(0, 6));
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["days_count_invalid"] });
  });

  it("days con 8 elementos -> days_count_invalid", () => {
    const days = [...neutralWeek(), resolvedDay("2026-09-28", "unclassified", 0, 0)];
    expect(planWeek(uniformRequest(14000, days))).toEqual({ status: "invalid_input", scope: "request", reasons: ["days_count_invalid"] });
  });

  it("un día no es un objeto -> day_object_invalid", () => {
    const days = neutralWeek() as unknown[];
    days[2] = null;
    expect(planWeek(uniformRequest(14000, days as WeeklyPlanDayInput[]))).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["day_object_invalid"],
    });
  });

  it("label desconocida -> day_label_invalid", () => {
    const days = neutralWeek();
    days[0] = { ...days[0], label: "bogus" } as unknown as WeeklyPlanDayInput;
    expect(planWeek(uniformRequest(14000, days))).toEqual({ status: "invalid_input", scope: "request", reasons: ["day_label_invalid"] });
  });

  it("macros.status desconocido -> day_macro_status_invalid", () => {
    const days = neutralWeek();
    days[0] = { ...days[0], macros: { status: "bogus" } } as unknown as WeeklyPlanDayInput;
    expect(planWeek(uniformRequest(14000, days))).toEqual({ status: "invalid_input", scope: "request", reasons: ["day_macro_status_invalid"] });
  });

  it("macros unresolved con reasons vacío -> day_macro_reasons_invalid", () => {
    const days = neutralWeek();
    days[0] = { ...days[0], macros: { status: "unresolved", reasons: [] } } as unknown as WeeklyPlanDayInput;
    expect(planWeek(uniformRequest(14000, days))).toEqual({ status: "invalid_input", scope: "request", reasons: ["day_macro_reasons_invalid"] });
  });

  it("macros unresolved con motivo desconocido (incluye 'kcal_target_not_resolved', que no aplica a nivel de día) -> day_macro_reasons_invalid", () => {
    const days = neutralWeek();
    days[0] = { ...days[0], macros: { status: "unresolved", reasons: ["kcal_target_not_resolved"] } } as unknown as WeeklyPlanDayInput;
    expect(planWeek(uniformRequest(14000, days))).toEqual({ status: "invalid_input", scope: "request", reasons: ["day_macro_reasons_invalid"] });
  });

  it("distribution.kind desconocido -> distribution_kind_invalid", () => {
    const req = requestWith({ kind: "bogus" } as unknown as WeeklyDistributionPolicy, 14000, neutralWeek());
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["distribution_kind_invalid"] });
  });

  it("distribution no es un objeto -> distribution_kind_invalid", () => {
    const req = requestWith("bogus" as unknown as WeeklyDistributionPolicy, 14000, neutralWeek());
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["distribution_kind_invalid"] });
  });

  it("nunca lanza para una combinación amplia de valores estructuralmente inválidos", () => {
    const garbage: unknown[] = [null, undefined, 0, "x", [], {}, { status: "resolved" }, { status: "unresolved" }];
    for (const g of garbage) {
      const req = { energyPolicy: g, days: g } as unknown as WeeklyPlanRequest;
      expect(() => planWeek(req)).not.toThrow();
    }
  });
});

// ─── Mapas: claves heredadas, desconocidas, ausentes, sobrantes ────────

describe("mapas de pesos — solo propiedades propias enumerables (nunca la cadena de prototipos)", () => {
  it("clave heredada del prototipo se ignora por completo (no cuenta como conocida ni como desconocida)", () => {
    const proto = { unclassified: 999 };
    const weights = Object.create(proto) as Record<string, number>;
    weights.strength = 1;
    weights.rest = 1;
    const days = [
      resolvedDay(WEEK1[0], "strength", 0, 0),
      resolvedDay(WEEK1[1], "rest", 0, 0),
      resolvedDay(WEEK1[2], "rest", 0, 0),
      resolvedDay(WEEK1[3], "rest", 0, 0),
      resolvedDay(WEEK1[4], "rest", 0, 0),
      resolvedDay(WEEK1[5], "rest", 0, 0),
      resolvedDay(WEEK1[6], "rest", 0, 0),
    ];
    const result = planWeek(requestWith({ kind: "weighted_by_label", weights }, 14000, days));
    expect(result.status).toBe("ok");
  });

  it("clave propia desconocida en weighted_by_label -> weight_key_unknown_label", () => {
    const days = [
      resolvedDay(WEEK1[0], "strength", 0, 0),
      ...WEEK1.slice(1).map((k) => resolvedDay(k, "rest", 0, 0)),
    ];
    const req = requestWith({ kind: "weighted_by_label", weights: { strength: 1, rest: 1, unclassified: 1 } as Record<string, number> }, 14000, days);
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["weight_key_unknown_label"] });
  });

  it("falta un peso para una label USADA -> weight_missing_for_label", () => {
    const days = [
      resolvedDay(WEEK1[0], "strength", 0, 0),
      ...WEEK1.slice(1).map((k) => resolvedDay(k, "rest", 0, 0)),
    ];
    const req = requestWith({ kind: "weighted_by_label", weights: { rest: 1 } }, 14000, days);
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["weight_missing_for_label"] });
  });

  it("label declarada pero NO usada esa semana -> permitido, no es un error", () => {
    const days = WEEK1.map((k) => resolvedDay(k, "rest", 0, 0));
    const req = requestWith({ kind: "weighted_by_label", weights: { rest: 1, cardio: 5, mixed: 3 } }, 14000, days);
    expect(planWeek(req).status).toBe("ok");
  });

  it("'unclassified' con weighted_by_label -> unclassified_incompatible_with_weighted_by_label", () => {
    const days = [resolvedDay(WEEK1[0], "unclassified", 0, 0), ...WEEK1.slice(1).map((k) => resolvedDay(k, "rest", 0, 0))];
    const req = requestWith({ kind: "weighted_by_label", weights: { rest: 1 } }, 14000, days);
    expect(planWeek(req)).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["unclassified_incompatible_with_weighted_by_label"],
    });
  });

  it("weighted_by_date — falta una fecha -> weight_missing_for_date", () => {
    const weights: Record<string, number> = {};
    WEEK1.slice(0, 6).forEach((k) => (weights[k] = 1)); // falta la 7ª
    const req = requestWith({ kind: "weighted_by_date", weights }, 14000, neutralWeek());
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["weight_missing_for_date"] });
  });

  it("weighted_by_date — fecha sobrante que no pertenece al plan -> weight_present_for_unknown_date", () => {
    const weights: Record<string, number> = {};
    WEEK1.forEach((k) => (weights[k] = 1));
    weights["2099-01-01"] = 1;
    const req = requestWith({ kind: "weighted_by_date", weights }, 14000, neutralWeek());
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["weight_present_for_unknown_date"] });
  });

  it("explicit_daily_targets — falta una fecha -> explicit_daily_targets_missing_for_date", () => {
    const dailyKcalTargets: Record<string, number> = {};
    WEEK1.slice(0, 6).forEach((k) => (dailyKcalTargets[k] = 2000));
    const req = requestWith({ kind: "explicit_daily_targets", dailyKcalTargets }, 12000, neutralWeek());
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["explicit_daily_targets_missing_for_date"] });
  });

  it("explicit_daily_targets — fecha sobrante -> explicit_daily_targets_extra_date", () => {
    const dailyKcalTargets: Record<string, number> = {};
    WEEK1.forEach((k) => (dailyKcalTargets[k] = 2000));
    dailyKcalTargets["2099-01-01"] = 2000;
    const req = requestWith({ kind: "explicit_daily_targets", dailyKcalTargets }, 14000, neutralWeek());
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["explicit_daily_targets_extra_date"] });
  });
});

// ─── Ramas del contrato que no tenían cobertura (hallazgo de la revisión) ─

describe("weekly_kcal_target — casos límite sin cubrir antes", () => {
  it("0.3 (positivo, redondea a 0) -> weekly_kcal_target_rounds_to_zero", () => {
    const req = uniformRequest(0.3, neutralWeek());
    expect(planWeek(req)).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["weekly_kcal_target_rounds_to_zero"],
    });
  });

  it("0.49 (frontera inferior) -> weekly_kcal_target_rounds_to_zero; 0.5 (frontera exacta) -> NO, procede", () => {
    expect(planWeek(uniformRequest(0.49, neutralWeek()))).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["weekly_kcal_target_rounds_to_zero"],
    });
    const result = planWeek(uniformRequest(0.5, neutralWeek()));
    // round(0.5)=1 -> ya no "rounds_to_zero"; con 7 días y target=1 al menos
    // un día queda en 0 -> infeasible/distributed_kcal_target_non_positive,
    // pero eso es un motivo DISTINTO — la frontera en sí queda probada.
    if (result.status === "invalid_input" && result.scope === "request") {
      expect(result.reasons).not.toContain("weekly_kcal_target_rounds_to_zero");
    }
  });

  it("1e17 (finito, redondea a un entero que excede Number.MAX_SAFE_INTEGER) -> weekly_kcal_target_unsafe", () => {
    expect(Number.isSafeInteger(Math.round(1e17))).toBe(false); // confirma la premisa del caso, no derivado del kernel
    const req = uniformRequest(1e17, neutralWeek());
    expect(planWeek(req)).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["weekly_kcal_target_unsafe"],
    });
  });
});

describe("distribution_weights_invalid — mapa malformado y valores individuales (hallazgos de la revisión)", () => {
  it("weighted_by_date con weights = array (typeof object, pero no un mapa) -> distribution_weights_invalid", () => {
    const req = requestWith({ kind: "weighted_by_date", weights: [1, 2, 3] as unknown as Record<string, number> }, 14000, neutralWeek());
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["distribution_weights_invalid"] });
  });

  it("weighted_by_label con weights = string -> distribution_weights_invalid", () => {
    // Días con labels weighteables reales (no "unclassified"): así el único
    // motivo posible es el mapa en sí, sin mezclarlo con
    // unclassified_incompatible_with_weighted_by_label.
    const days = [resolvedDay(WEEK1[0], "strength", 0, 0), ...WEEK1.slice(1).map((k) => resolvedDay(k, "rest", 0, 0))];
    const req = requestWith({ kind: "weighted_by_label", weights: "nope" as unknown as Record<string, number> }, 14000, days);
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["distribution_weights_invalid"] });
  });

  it("un peso individual mal tipado (string en vez de number) -> distribution_weights_invalid, y también weight_missing_for_label (un valor inválido nunca cuenta como cobertura)", () => {
    const days = [resolvedDay(WEEK1[0], "strength", 0, 0), ...WEEK1.slice(1).map((k) => resolvedDay(k, "rest", 0, 0))];
    const req = requestWith(
      { kind: "weighted_by_label", weights: { strength: "5" as unknown as number, rest: 1 } },
      14000,
      days,
    );
    expect(planWeek(req)).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["distribution_weights_invalid", "weight_missing_for_label"],
    });
  });

  it("un peso individual negativo -> distribution_weights_invalid + weight_missing_for_label (rama distinta del tipo incorrecto, mismas dos razones por el mismo motivo)", () => {
    const days = [resolvedDay(WEEK1[0], "strength", 0, 0), ...WEEK1.slice(1).map((k) => resolvedDay(k, "rest", 0, 0))];
    const req = requestWith({ kind: "weighted_by_label", weights: { strength: -5, rest: 1 } }, 14000, days);
    expect(planWeek(req)).toEqual({
      status: "invalid_input",
      scope: "request",
      reasons: ["distribution_weights_invalid", "weight_missing_for_label"],
    });
  });

  it("explicit_daily_targets con dailyKcalTargets = string (no es un objeto) -> explicit_daily_targets_invalid", () => {
    const req = requestWith(
      { kind: "explicit_daily_targets", dailyKcalTargets: "nope" as unknown as Record<string, number> },
      14000,
      neutralWeek(),
    );
    expect(planWeek(req)).toEqual({ status: "invalid_input", scope: "request", reasons: ["explicit_daily_targets_invalid"] });
  });
});

describe("daily_macro_allocation_unexpected_unresolved — rama defensiva, solo alcanzable mockeando PR2A", () => {
  afterEach(() => {
    vi.doUnmock("./macro-allocation-kernel");
    vi.resetModules();
  });

  it("si allocateDailyMacros devolviera unresolved_input (PR2B nunca lo provoca con entradas reales), el veredicto es invalid_input/daily_allocation con la razón y el diagnóstico correctos", async () => {
    vi.resetModules();
    vi.doMock("./macro-allocation-kernel", () => ({
      allocateDailyMacros: () => ({
        status: "unresolved_input",
        reasons: ["protein_target_not_resolved"],
      }),
    }));
    // Reimport dinámico DESPUÉS de vi.doMock: weekly-plan-kernel.ts importa
    // allocateDailyMacros de forma estática en su cabecera, así que solo
    // una instancia de módulo fresca (tras vi.resetModules()) recoge el
    // mock — no se añade ninguna exportación ni parámetro nuevo al kernel
    // real solo para esto.
    const { planWeek: mockedPlanWeek } = await import("./weekly-plan-kernel");
    const result = mockedPlanWeek(uniformRequest(14000, neutralWeek(100, 50)));
    if (result.status !== "invalid_input" || result.scope !== "daily_allocation") {
      throw new Error(`esperado invalid_input/daily_allocation, recibido ${JSON.stringify(result)}`);
    }
    expect(result.reasons).toEqual(["daily_macro_allocation_unexpected_unresolved"]);
    expect(result.partialDiagnostics).toHaveLength(7); // los 7 días reciben la misma respuesta mockeada
    for (const diag of result.partialDiagnostics) {
      if (diag.diagnostic.kind !== "rejected_by_pr2a") throw new Error("esperado rejected_by_pr2a");
      expect(diag.diagnostic.allocation).toEqual({ status: "unresolved_input", reasons: ["protein_target_not_resolved"] });
    }
  });
});

// ─── Barrido determinista: la suma repartida SIEMPRE es exacta ────────

describe("barrido determinista — invariante de suma semanal", () => {
  it("uniform: para targets de 1 a 40, la suma de las cuotas repartidas es EXACTAMENTE round(target)", () => {
    for (let target = 1; target <= 40; target++) {
      const result = planWeek(uniformRequest(target, neutralWeek()));
      let total: number;
      if (result.status === "ok") {
        total = result.days.reduce((sum, d) => sum + d.distributedKcalTarget, 0);
      } else if (result.status === "infeasible") {
        const fromDays = result.days.reduce((sum, d) => sum + d.distributedKcalTarget, 0);
        const fromDiagnostics = result.partialDiagnostics
          .filter((d) => d.diagnostic.kind === "non_positive_share")
          .reduce((sum, d) => sum + (d.diagnostic as { distributedKcalTarget: number }).distributedKcalTarget, 0);
        total = fromDays + fromDiagnostics;
      } else {
        throw new Error(`estado inesperado para target=${target}: ${result.status}`);
      }
      expect(total).toBe(Math.round(target));
    }
  });

  it("weighted_by_date con pesos desiguales fijos: la suma repartida es exacta para varios targets", () => {
    const weights: Record<string, number> = {};
    [3, 1, 4, 1, 5, 9, 2].forEach((w, i) => (weights[WEEK1[i]] = w));
    for (const target of [7, 100, 2200.3, 9999, 50000]) {
      const req = requestWith({ kind: "weighted_by_date", weights }, target, neutralWeek());
      const result = planWeek(req);
      if (result.status !== "ok" && result.status !== "infeasible") {
        throw new Error(`estado inesperado para target=${target}: ${result.status}`);
      }
      const fromDays = result.days.reduce((sum, d) => sum + d.distributedKcalTarget, 0);
      const fromDiagnostics =
        result.status === "infeasible"
          ? result.partialDiagnostics
              .filter((d) => d.diagnostic.kind === "non_positive_share")
              .reduce((sum, d) => sum + (d.diagnostic as { distributedKcalTarget: number }).distributedKcalTarget, 0)
          : 0;
      expect(fromDays + fromDiagnostics).toBe(Math.round(target));
    }
  });
});

// ─── Inmutabilidad ──────────────────────────────────────────────────

describe("inmutabilidad — planWeek nunca muta ninguna estructura de entrada", () => {
  it("el objeto request, el array days y el mapa de pesos permanecen intactos tras la llamada", () => {
    const weights = { strength: 1.15, rest: 0.9 };
    const days = [
      resolvedDay(WEEK1[0], "strength", 150, 60),
      resolvedDay(WEEK1[1], "strength", 150, 60),
      resolvedDay(WEEK1[2], "strength", 150, 60),
      resolvedDay(WEEK1[3], "rest", 150, 60),
      resolvedDay(WEEK1[4], "rest", 150, 60),
      resolvedDay(WEEK1[5], "rest", 150, 60),
      resolvedDay(WEEK1[6], "rest", 150, 60),
    ];
    const req = requestWith({ kind: "weighted_by_label", weights }, 15000, days);
    const snapshot = JSON.parse(JSON.stringify(req));
    planWeek(req);
    expect(req).toEqual(snapshot);
    expect(Object.isFrozen(req)).toBe(false); // no hace falta congelar para probar que no se mutó
  });

  it("dos llamadas con el mismo objeto reordenado (reversed) no afectan una a la otra", () => {
    const days = neutralWeek();
    const reversedCopy = [...days].reverse();
    const before = JSON.parse(JSON.stringify(days));
    planWeek(uniformRequest(14000, days));
    planWeek(uniformRequest(14000, reversedCopy));
    expect(days).toEqual(before);
  });
});

// ─── Determinismo ───────────────────────────────────────────────────

describe("determinismo", () => {
  it("misma entrada -> misma salida, profundamente idéntica", () => {
    const req = uniformRequest(14000, neutralWeek(150, 60));
    const a = planWeek(req);
    const b = planWeek(JSON.parse(JSON.stringify(req)));
    expect(a).toEqual(b);
  });
});

// ─── Pruebas de tipo — las uniones impiden estados contradictorios ────
//
// Verificadas por `tsc --noEmit` (el typecheck de este paquete incluye
// este archivo), NO por la ejecución de vitest. Cada `@ts-expect-error`
// exige que la línea siguiente produzca un error de tipo; si algún día se
// ensancha el tipo correspondiente y la línea deja de ser un error, tsc
// reporta "Unused '@ts-expect-error' directive" y el typecheck falla —
// así que estas líneas son una prueba real, no una simple documentación.
//
// Todo vive dentro de una función que NUNCA se llama: sus parámetros
// nunca se evalúan en runtime, así que el cuerpo jamás se ejecuta al
// correr vitest (a diferencia de usar `declare const` a nivel de módulo,
// que compilaría a una referencia sin binding real y lanzaría
// ReferenceError en cuanto el archivo se cargara). tsc sigue analizando
// el cuerpo igualmente, porque el chequeo de tipos es estático y no
// depende de si la función llega a invocarse.
function _typeChecksNeverCalled(
  okAllocation: MacroAllocationOk,
  infeasibleAllocation: MacroAllocationInfeasible,
  invalidAllocation: MacroAllocationInvalidInput,
  unresolvedAllocation: MacroAllocationUnresolvedInput,
): void {
  // 1) Un día de WeeklyPlanOk exige MacroAllocationOk — nunca infeasible,
  //    ni un rechazo de PR2A.
  const okDayRejectsInfeasible: WeeklyPlanOkDayResult = {
    dateKey: "2026-09-21",
    label: "unclassified",
    distributedKcalTarget: 2000,
    // @ts-expect-error — allocation de un día "ok" debe ser MacroAllocationOk, nunca infeasible.
    allocation: infeasibleAllocation,
  };
  const okDayRejectsInvalid: WeeklyPlanOkDayResult = {
    dateKey: "2026-09-21",
    label: "unclassified",
    distributedKcalTarget: 2000,
    // @ts-expect-error — allocation de un día "ok" debe ser MacroAllocationOk, nunca un rechazo invalid_input de PR2A.
    allocation: invalidAllocation,
  };
  const okDayRejectsUnresolved: WeeklyPlanOkDayResult = {
    dateKey: "2026-09-21",
    label: "unclassified",
    distributedKcalTarget: 2000,
    // @ts-expect-error — allocation de un día "ok" debe ser MacroAllocationOk, nunca un rechazo unresolved_input de PR2A.
    allocation: unresolvedAllocation,
  };

  // 2) Un día de WeeklyPlanInfeasible admite ok|infeasible, pero nunca un
  //    rechazo de PR2A (eso siempre gana como invalid_input/daily_allocation).
  const infeasibleDayAdmitsOk: WeeklyPlanInfeasibleDayResult = {
    dateKey: "2026-09-21",
    label: "unclassified",
    distributedKcalTarget: 2000,
    allocation: okAllocation, // sin @ts-expect-error — esto SÍ debe compilar.
  };
  const infeasibleDayAdmitsInfeasible: WeeklyPlanInfeasibleDayResult = {
    dateKey: "2026-09-21",
    label: "unclassified",
    distributedKcalTarget: 2000,
    allocation: infeasibleAllocation, // sin @ts-expect-error — esto SÍ debe compilar.
  };
  const infeasibleDayRejectsInvalid: WeeklyPlanInfeasibleDayResult = {
    dateKey: "2026-09-21",
    label: "unclassified",
    distributedKcalTarget: 2000,
    // @ts-expect-error — un día de WeeklyPlanInfeasible nunca admite un rechazo invalid_input de PR2A.
    allocation: invalidAllocation,
  };
  const infeasibleDayRejectsUnresolved: WeeklyPlanInfeasibleDayResult = {
    dateKey: "2026-09-21",
    label: "unclassified",
    distributedKcalTarget: 2000,
    // @ts-expect-error — un día de WeeklyPlanInfeasible nunca admite un rechazo unresolved_input de PR2A.
    allocation: unresolvedAllocation,
  };

  // 3) Un rechazo de PR2A (invalid_input o unresolved_input) SOLO cabe
  //    dentro del diagnóstico "rejected_by_pr2a" de
  //    WeeklyPlanPartialDayDiagnosticKind (el que exige
  //    scope:"daily_allocation" en WeeklyPlanInvalidInput) — no en el
  //    diagnóstico "infeasible", que exige MacroAllocationInfeasible.
  const rejectedDiagnosticAcceptsInvalid: WeeklyPlanPartialDayDiagnosticKind = {
    kind: "rejected_by_pr2a",
    allocation: invalidAllocation, // sin @ts-expect-error — esto SÍ debe compilar.
  };
  const rejectedDiagnosticAcceptsUnresolved: WeeklyPlanPartialDayDiagnosticKind = {
    kind: "rejected_by_pr2a",
    allocation: unresolvedAllocation, // sin @ts-expect-error — esto SÍ debe compilar.
  };
  const infeasibleDiagnosticRejectsInvalid: WeeklyPlanPartialDayDiagnosticKind = {
    kind: "infeasible",
    // @ts-expect-error — el diagnóstico "infeasible" exige MacroAllocationInfeasible, nunca un rechazo de PR2A.
    allocation: invalidAllocation,
  };

  // Referencias triviales para que ningún linter marque estas constantes
  // como no usadas — el cuerpo nunca se ejecuta de todos modos.
  void [
    okDayRejectsInfeasible,
    okDayRejectsInvalid,
    okDayRejectsUnresolved,
    infeasibleDayAdmitsOk,
    infeasibleDayAdmitsInfeasible,
    infeasibleDayRejectsInvalid,
    infeasibleDayRejectsUnresolved,
    rejectedDiagnosticAcceptsInvalid,
    rejectedDiagnosticAcceptsUnresolved,
    infeasibleDiagnosticRejectsInvalid,
  ];
}

describe("tipos — las uniones discriminadas impiden estados contradictorios (verificado por tsc --noEmit, no en runtime)", () => {
  it("marcador — el contenido real de esta prueba son los @ts-expect-error dentro de _typeChecksNeverCalled, nunca invocada", () => {
    expect(typeof _typeChecksNeverCalled).toBe("function");
  });
});

// ─── API pública del barrel ─────────────────────────────────────────

describe("API público del barrel — packages/engine/src/index.ts", () => {
  it("expone planWeek y ninguno de los helpers internos de PR2B", () => {
    const barrel = engineBarrel as Record<string, unknown>;
    expect(typeof barrel.planWeek).toBe("function");
    const forbiddenNames = [
      "computeLargestRemainderShares",
      "daysFromCivil",
      "parseDayStructure",
      "classifyDayMacros",
      "validateNumericWeightsMap",
      "validateWeightsSafety",
      "validateExplicitDailyTargets",
      "canonicalizeStructuralReasons",
      "isPlainRecord",
    ];
    for (const name of forbiddenNames) {
      expect(barrel[name]).toBeUndefined();
    }
  });

  it("planWeek importado desde el barrel se comporta igual que el import directo", () => {
    const req = uniformRequest(14000, neutralWeek(150, 60));
    expect(engineBarrel.planWeek(req)).toEqual(planWeek(req));
  });
});

// ─── Pureza ──────────────────────────────────────────────────────────

/**
 * Recorre el AST real del código fuente (vía el compilador de TypeScript,
 * ya presente como devDependency de este paquete — no se añade ninguna
 * dependencia nueva) buscando nodos EJECUTABLES que referencien una fuente
 * de no-determinismo o efecto lateral. A diferencia de una regex sobre el
 * texto crudo, un identificador o property-access dentro de un comentario
 * o de un string literal nunca produce un nodo de este tipo — no hace
 * falta (ni es fiable) intentar excluirlos con lookaheads/lookbehinds.
 *
 * `new Date`, `Date.now`, `Math.random` y `process.env` se detectan por su
 * FORMA estructural exacta (NewExpression / PropertyAccessExpression),
 * para no marcar usos legítimos de `Date`/`Math`/`process` con otro
 * miembro (este archivo sí usa Math.round/Math.floor/Math.max
 * legítimamente). El resto (`fetch`, `localStorage`, `sessionStorage`,
 * `globalThis`, `setTimeout`, `setInterval`) se detecta por identificador
 * — ninguno de esos nombres tiene un uso legítimo distinto en este archivo.
 */
function findForbiddenRuntimeReferences(sourceText: string, fileName: string): string[] {
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
      if (
        (objectName === "Date" && propertyName === "now") ||
        (objectName === "Math" && propertyName === "random") ||
        (objectName === "process" && propertyName === "env")
      ) {
        violations.push(describeNode(node));
      }
    } else if (ts.isIdentifier(node) && bareForbiddenNames.has(node.text)) {
      violations.push(describeNode(node));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe("pureza — sin Date, reloj, red, almacenamiento ni estado global (AST real, no regex sobre texto)", () => {
  it("el AST del kernel no contiene ningún nodo ejecutable de new Date/Date.now/Math.random/fetch/localStorage/sessionStorage/process.env/globalThis/timers", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fileName = join(here, "weekly-plan-kernel.ts");
    const source = readFileSync(fileName, "utf-8");
    expect(findForbiddenRuntimeReferences(source, fileName)).toEqual([]);
  });

  it("comentarios/strings que mencionen esos términos NO producen falsos positivos (a diferencia de la regex anterior)", () => {
    const fileName = "fixture.ts";
    const source = [
      "// Este kernel nunca usa Date.now, Math.random, fetch(), localStorage ni setTimeout.",
      '/** Tampoco process.env ni globalThis, ni siquiera dentro de un bloque /* anidado */ en la documentación. */',
      'const mensaje = "no llames a fetch() ni a localStorage.getItem aquí";',
      "export function ejemploPuro(x: number): number { return Math.round(x) + Math.floor(x) + Math.max(x, 0); }",
    ].join("\n");
    expect(findForbiddenRuntimeReferences(source, fileName)).toEqual([]);
  });

  it("demuestra que el detector SÍ dispara para cada patrón prohibido cuando aparece como código real", () => {
    const fileName = "fixture.ts";
    const cases = [
      "const x = new Date();",
      "const x = Date.now();",
      "const x = Math.random();",
      "fetch('https://example.com');",
      "const x = localStorage.getItem('k');",
      "const x = sessionStorage.getItem('k');",
      "const x = process.env.NODE_ENV;",
      "const x = globalThis;",
      "setTimeout(() => {}, 0);",
      "setInterval(() => {}, 0);",
    ];
    for (const code of cases) {
      expect(findForbiddenRuntimeReferences(code, fileName).length).toBeGreaterThan(0);
    }
  });
});

describe("confirmación estructural — apps/web no importa weekly-plan-kernel", () => {
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
