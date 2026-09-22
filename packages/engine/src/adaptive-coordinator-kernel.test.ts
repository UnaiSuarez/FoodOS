import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import type {
  AdaptiveReviewAdjustmentProposal,
  AdaptiveReviewInput,
  AdaptiveReviewResult,
} from "@foodos/types";
import { evaluateAdaptiveReview } from "./adaptive-coordinator-kernel";
import * as engineBarrel from "./index";

// ─── Fixtures ─────────────────────────────────────────────────────────────
//
// Los objetos "strategy"/"weightTrend"/"intakeCoverage"/"exercisePerformance"
// aquí construidos son deliberadamente MÍNIMOS: solo llevan los campos que
// evaluateAdaptiveReview realmente lee (verificado leyendo el kernel, no
// asumido) — igual criterio que las fixtures de weekly-plan-kernel.test.ts
// y macro-allocation-kernel.test.ts, que tampoco reconstruyen el contrato
// completo de PR2A/PR2B cuando el caso no lo necesita. Se pasan con
// `as unknown as X` porque el propio kernel trata su entrada como
// `unknown` en runtime (contrato JSON-like), igual que el resto del
// repositorio.
//
// `addDaysUTC` es aritmética de fechas PROPIA de este archivo de test,
// deliberadamente independiente de `days_from_civil` del kernel — mismo
// motivo que `consecutiveDateKeys` en weekly-plan-kernel.test.ts: no
// verificar la implementación contra sí misma.
function addDaysUTC(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

const REF = "2026-09-21";
const WEIGHT_WINDOW_START = addDaysUTC(REF, -28); // 29 fechas inclusive
const INTAKE_WINDOW_START = addDaysUTC(REF, -27); // 28 fechas inclusive

interface StrategyOverrides {
  status?: string;
  weeklyKcalTargetInForce?: number;
  objective?: string;
  priority?: string | null;
  minPct?: number;
  maxPct?: number;
  distributionRoundingDeltaKcal?: number;
}

/** Estrategia PR3 "ok" — escenario PRODUCTIVO real: 80kg/178cm, TDEE 2600,
 *  fat_loss_lean -> semanal 15236 kcal, banda [-1.0,-0.5] %/sem (números
 *  reales, verificados ejecutando planWeeklyStrategy durante el diseño). */
function okStrategy(overrides: StrategyOverrides = {}): unknown {
  const {
    weeklyKcalTargetInForce = 15236,
    objective = "fat_loss",
    priority = "fat_loss_lean",
    minPct = -1.0,
    maxPct = -0.5,
    distributionRoundingDeltaKcal = 0,
  } = overrides;
  return {
    status: "ok",
    objective,
    priority,
    weeklyPlan: { status: "ok", energy: { roundedWeeklyKcalTarget: weeklyKcalTargetInForce, distributionRoundingDeltaKcal } },
    audit: { desiredObservedRateBandPctPerWeek: { minPct, maxPct } },
  };
}

function stopStrategy(kind: "specialist_review_required" | "unsupported_plan"): unknown {
  return { status: kind, audit: { minKcalDetected: 1100, maxKcalDetected: 1100, reasons: ["low_energy_diet_day_present"] } };
}

function unsupportedPopulationStrategy(reasons: string[] = ["self_reported_persistent_fatigue"]): unknown {
  return { status: "unsupported_population", reasons, diagnostic: null };
}

/** Forma mínima real de unresolved_input/invalid_input/infeasible: los
 *  tres exigen `reasons` no vacío en el contrato real de PR3 — un objeto
 *  sin él (o con reasons:[]) es malformado, no un "not_ok" legítimo (ver
 *  la corrección de la auditoría: classifyStrategy ahora lo exige). */
function notOkStrategy(status: "unresolved_input" | "invalid_input" | "infeasible", reasons: string[] = ["propagated_from_weekly_plan"]): unknown {
  return { status, reasons };
}

interface WeightOverrides {
  windowStartDateKey?: string;
  windowEndDateKey?: string;
  windowCalendarDays?: number;
  measurementsInWindow?: number;
  measurementSpanDays?: number;
  trendQualityLevel?: string;
  weeklyChangePercent?: number;
}

/** Tendencia "evaluated" — ventana real de 29 fechas terminada en REF.
 *  weeklyChangePercent=-0.7 es el número real (redondeado por v3.1 a esa
 *  cifra) verificado durante el diseño con calcWeightTrend/
 *  calculateWeightTrend sobre una serie sintética ilustrativa. */
function weightEvaluated(overrides: WeightOverrides = {}): unknown {
  const {
    windowStartDateKey = WEIGHT_WINDOW_START,
    windowEndDateKey = REF,
    windowCalendarDays = 29,
    measurementsInWindow = 29,
    measurementSpanDays = 28,
    trendQualityLevel = "high",
    weeklyChangePercent = -0.7,
  } = overrides;
  return {
    status: "evaluated",
    coverage: { windowStartDateKey, windowEndDateKey, windowCalendarDays, measurementsInWindow, minimumMeasurementsRequired: 3 },
    measurementSpanDays,
    trendQualityLevel,
    weeklyChangePercent,
  };
}

function weightInsufficient(overrides: Partial<WeightOverrides & { minimumMeasurementsRequired: number }> = {}): unknown {
  const {
    windowStartDateKey = WEIGHT_WINDOW_START,
    windowEndDateKey = REF,
    windowCalendarDays = 29,
    measurementsInWindow = 10,
    minimumMeasurementsRequired = 21,
  } = overrides;
  return { status: "insufficient_data", coverage: { windowStartDateKey, windowEndDateKey, windowCalendarDays, measurementsInWindow, minimumMeasurementsRequired } };
}

function weightInvalid(): unknown {
  return { status: "invalid_input", reasons: ["measurement_date_key_duplicate"] };
}

interface IntakeOverrides {
  windowStartDateKey?: string;
  windowEndDateKey?: string;
  eligibleCalendarDays?: number;
  loggedDays?: number;
  plausibleDays?: number;
  recordsWithTargetCount?: number;
  plausibleCoverageFraction?: number;
  averagePlausibleLoggedKcal?: number | null;
  intakeAccuracy?: string;
}

/** Cobertura "evaluated" — ventana real de 28 fechas terminada en REF,
 *  28/28 logueados y plausibles, todos con objetivo diario (política
 *  cerrada del diseño, cierra O4). */
function intakeEvaluated(overrides: IntakeOverrides = {}): unknown {
  const {
    windowStartDateKey = INTAKE_WINDOW_START,
    windowEndDateKey = REF,
    eligibleCalendarDays = 28,
    loggedDays = 28,
    plausibleDays = 28,
    recordsWithTargetCount = 28,
    plausibleCoverageFraction = 1,
    averagePlausibleLoggedKcal = 2137,
    intakeAccuracy = "unknown",
  } = overrides;
  return {
    status: "evaluated",
    windowStartDateKey,
    windowEndDateKey,
    eligibleCalendarDays,
    loggedDays,
    plausibleDays,
    recordsWithTargetCount,
    plausibleCoverageFraction,
    averagePlausibleLoggedKcal,
    intakeAccuracy,
  };
}

function intakeInvalid(): unknown {
  return { status: "invalid_input", reasons: ["record_date_key_duplicate"] };
}

function exerciseEvaluated(windowSessionCount = 2): unknown {
  return { status: "evaluated", windowSessionCount };
}
function exerciseInvalid(): unknown {
  return { status: "invalid_input", reasons: ["no_sessions_in_window"] };
}

interface InputOverrides {
  referenceDateKey?: string;
  baseline?: unknown;
  strategy?: unknown;
  weightTrend?: unknown;
  intakeCoverage?: unknown;
  exercisePerformance?: unknown;
  reviewHistory?: unknown;
  selfReport?: unknown;
}

function baseline(overrides: Partial<{ weeklyKcalTargetInForce: number; targetVersionId: string; strategyVersionId: string; calibrationBaselineDateKey: string | null }> = {}): unknown {
  const { weeklyKcalTargetInForce = 15236, targetVersionId = "target-v1", strategyVersionId = "strategy-v1", calibrationBaselineDateKey = null } = overrides;
  return { weeklyKcalTargetInForce, targetVersionId, strategyVersionId, calibrationBaselineDateKey };
}

function reviewHistory(overrides: Partial<{ lastResolvedOnDateKey: string | null; pendingProposalId: string | null }> = {}): unknown {
  const { lastResolvedOnDateKey = null, pendingProposalId = null } = overrides;
  return { lastResolvedOnDateKey, pendingProposalId };
}

/** Entrada base VÁLIDA que alcanza limpiamente la Fase E (sin stop, sin
 *  deferred, con todas las puertas de evidencia superadas) — escenario
 *  PRODUCTIVO real (números verificados ejecutando las funciones reales
 *  de PR3/PR5A durante el diseño). Cada test la clona con overrides. */
function validInput(overrides: InputOverrides = {}): unknown {
  return {
    referenceDateKey: REF,
    baseline: overrides.baseline ?? baseline(),
    strategy: overrides.strategy ?? okStrategy(),
    weightTrend: overrides.weightTrend ?? weightEvaluated(),
    intakeCoverage: overrides.intakeCoverage ?? intakeEvaluated(),
    exercisePerformance: "exercisePerformance" in overrides ? overrides.exercisePerformance : exerciseEvaluated(),
    reviewHistory: overrides.reviewHistory ?? reviewHistory(),
    selfReport: overrides.selfReport,
    ...(overrides.referenceDateKey !== undefined ? { referenceDateKey: overrides.referenceDateKey } : {}),
  };
}

function evaluate(overrides: InputOverrides = {}): AdaptiveReviewResult {
  return evaluateAdaptiveReview(validInput(overrides) as unknown as AdaptiveReviewInput);
}

function expectStatus<S extends AdaptiveReviewResult["status"]>(result: AdaptiveReviewResult, status: S): Extract<AdaptiveReviewResult, { status: S }> {
  if (result.status !== status) throw new Error(`esperado status="${status}", recibido ${JSON.stringify(result)}`);
  return result as Extract<AdaptiveReviewResult, { status: S }>;
}

// ─── Fase A — SEGURIDAD ────────────────────────────────────────────────

describe("Fase A — autoinforme válido produce stop (mapa exhaustivo, ítem 10)", () => {
  const cases: Array<{ concern: string; expected: string }> = [
    { concern: "missed_periods", expected: "self_reported_missed_periods" },
    { concern: "persistent_fatigue", expected: "self_reported_persistent_fatigue" },
    { concern: "disordered_eating_history", expected: "self_reported_disordered_eating_history" },
    { concern: "medical_condition_affecting_nutrition", expected: "self_reported_medical_condition" },
  ];
  for (const { concern, expected } of cases) {
    it(`concern="${concern}" -> reason="${expected}"`, () => {
      const result = evaluate({ selfReport: { concerns: [concern] } });
      const stop = expectStatus(result, "stop_and_recommend_review");
      expect(stop.reasons).toEqual([expected]);
      expect(stop.strategySafetyAudit).toBeNull();
    });
  }

  it("isPregnantOrBreastfeeding:true -> pregnant_or_breastfeeding", () => {
    const stop = expectStatus(evaluate({ selfReport: { isPregnantOrBreastfeeding: true } }), "stop_and_recommend_review");
    expect(stop.reasons).toEqual(["pregnant_or_breastfeeding"]);
  });

  it("isPregnantOrBreastfeeding:false no produce stop por sí solo", () => {
    expect(evaluate({ selfReport: { isPregnantOrBreastfeeding: false } }).status).toBe("keep_targets");
  });

  it("autoinforme ausente (undefined) es válido, sin señal", () => {
    expect(evaluate({ selfReport: undefined }).status).toBe("keep_targets");
  });

  it("varias señales del autoinforme a la vez -> todas presentes, orden canónico", () => {
    const stop = expectStatus(
      evaluate({ selfReport: { concerns: ["disordered_eating_history", "missed_periods"], isPregnantOrBreastfeeding: true } }),
      "stop_and_recommend_review",
    );
    expect(stop.reasons).toEqual(["pregnant_or_breastfeeding", "self_reported_missed_periods", "self_reported_disordered_eating_history"]);
  });
});

describe("Fase A — estrategia con estado válido de seguridad produce stop", () => {
  it("specialist_review_required válido -> stop, propaga audit tal cual", () => {
    const stop = expectStatus(evaluate({ strategy: stopStrategy("specialist_review_required") }), "stop_and_recommend_review");
    expect(stop.reasons).toEqual(["strategy_specialist_review_required"]);
    expect(stop.strategySafetyAudit).toEqual({ minKcalDetected: 1100, maxKcalDetected: 1100, reasons: ["low_energy_diet_day_present"] });
  });

  it("unsupported_plan válido -> stop", () => {
    const stop = expectStatus(evaluate({ strategy: stopStrategy("unsupported_plan") }), "stop_and_recommend_review");
    expect(stop.reasons).toEqual(["strategy_unsupported_plan"]);
  });

  it("unsupported_population válido -> stop, reasons reutilizados tal cual", () => {
    const stop = expectStatus(
      evaluate({ strategy: unsupportedPopulationStrategy(["pregnant_or_breastfeeding", "self_reported_missed_periods"]) }),
      "stop_and_recommend_review",
    );
    expect(stop.reasons).toEqual(["pregnant_or_breastfeeding", "self_reported_missed_periods"]);
    expect(stop.strategySafetyAudit).toBeNull();
  });

  it("autoinforme válido + estrategia con stop -> ambas fuentes combinadas, orden canónico", () => {
    const stop = expectStatus(
      evaluate({ selfReport: { isPregnantOrBreastfeeding: true }, strategy: stopStrategy("unsupported_plan") }),
      "stop_and_recommend_review",
    );
    expect(stop.reasons).toEqual(["pregnant_or_breastfeeding", "strategy_unsupported_plan"]);
    expect(stop.strategySafetyAudit).not.toBeNull();
  });
});

describe("Fase A — precedencia de seguridad sobre errores no relacionados (P6, ítem 10)", () => {
  it("autoinforme malformado + estrategia con stop VÁLIDO -> gana el stop; self_report_invalid nunca se surge", () => {
    const result = evaluate({ selfReport: { concerns: "no-es-array" }, strategy: stopStrategy("unsupported_plan") });
    expect(expectStatus(result, "stop_and_recommend_review").reasons).toEqual(["strategy_unsupported_plan"]);
  });

  it("autoinforme malformado + estrategia SIN stop -> invalid_input/self_report_invalid", () => {
    const result = evaluate({ selfReport: { concerns: "no-es-array" } });
    expect(expectStatus(result, "invalid_input").reasons).toEqual(["self_report_invalid"]);
  });

  it("autoinforme malformado + estrategia TAMBIÉN malformada -> ambas razones", () => {
    const result = evaluate({ selfReport: { isPregnantOrBreastfeeding: "sí" }, strategy: { status: "ok" } });
    expect(expectStatus(result, "invalid_input").reasons).toEqual(["strategy_result_malformed", "self_report_invalid"]);
  });

  it("concern desconocido (fuera del vocabulario cerrado) -> self_report_invalid, nunca descartado en silencio", () => {
    const result = evaluate({ selfReport: { concerns: ["bogus_concern"] } });
    expect(expectStatus(result, "invalid_input").reasons).toEqual(["self_report_invalid"]);
  });

  it("un string PARECIDO a una preocupación válida (mayúscula distinta o espacio) NUNCA activa stop — comparación exacta, sin normalización", () => {
    for (const nearMiss of ["Missed_Periods", " missed_periods", "missed_periods ", "missed-periods"]) {
      const result = evaluate({ selfReport: { concerns: [nearMiss] } });
      expect(result.status).not.toBe("stop_and_recommend_review");
      expect(expectStatus(result, "invalid_input").reasons).toEqual(["self_report_invalid"]);
    }
  });

  it("un autoinforme PARCIALMENTE inválido nunca honra la parte válida — concerns malformado descarta también isPregnantOrBreastfeeding:true", () => {
    const result = evaluate({ selfReport: { concerns: "no-es-array", isPregnantOrBreastfeeding: true } });
    expect(result.status).not.toBe("stop_and_recommend_review");
    expect(expectStatus(result, "invalid_input").reasons).toEqual(["self_report_invalid"]);
  });

  it("la misma razón de stop llegando por autoinforme Y por estrategia se deduplica a una sola aparición", () => {
    const stop = expectStatus(
      evaluate({
        selfReport: { isPregnantOrBreastfeeding: true },
        strategy: unsupportedPopulationStrategy(["pregnant_or_breastfeeding"]),
      }),
      "stop_and_recommend_review",
    );
    expect(stop.reasons).toEqual(["pregnant_or_breastfeeding"]);
    expect(stop.reasons).toHaveLength(1);
  });
});

// ─── Fase B — FORMA, RELACIONES INTERNAS Y POLÍTICA DE VENTANA ─────────

describe("Fase B — forma superior de la entrada", () => {
  it("input no es un objeto -> input_object_invalid, nunca lanza", () => {
    for (const garbage of [null, undefined, "x", 42, [], true]) {
      expect(() => evaluateAdaptiveReview(garbage as unknown as AdaptiveReviewInput)).not.toThrow();
      expect(evaluateAdaptiveReview(garbage as unknown as AdaptiveReviewInput)).toEqual({ status: "invalid_input", reasons: ["input_object_invalid"] });
    }
  });
});

describe("Fase B — cada razón de invalid_input es alcanzable de forma aislada (14 en total)", () => {
  it("reference_date_key_invalid — fecha con formato imposible", () => {
    expect(expectStatus(evaluate({ referenceDateKey: "21-09-2026" }), "invalid_input").reasons).toEqual(["reference_date_key_invalid"]);
  });
  it("reference_date_key_invalid — 2026-02-30 no existe", () => {
    expect(expectStatus(evaluate({ referenceDateKey: "2026-02-30" }), "invalid_input").reasons).toEqual(["reference_date_key_invalid"]);
  });

  it("baseline_invalid — weeklyKcalTargetInForce no entero seguro", () => {
    expect(expectStatus(evaluate({ baseline: baseline({ weeklyKcalTargetInForce: 15236.5 }) }), "invalid_input").reasons).toEqual(["baseline_invalid"]);
  });
  it("baseline_invalid — targetVersionId vacío", () => {
    expect(expectStatus(evaluate({ baseline: baseline({ targetVersionId: "" }) }), "invalid_input").reasons).toEqual(["baseline_invalid"]);
  });
  it("baseline_invalid — strategyVersionId ausente", () => {
    const b = baseline() as Record<string, unknown>;
    delete b.strategyVersionId;
    expect(expectStatus(evaluate({ baseline: b }), "invalid_input").reasons).toEqual(["baseline_invalid"]);
  });
  it("baseline_invalid — baseline no es un objeto", () => {
    expect(expectStatus(evaluate({ baseline: "bogus" }), "invalid_input").reasons).toEqual(["baseline_invalid"]);
  });

  it("baseline_calibration_date_invalid — formato imposible", () => {
    expect(expectStatus(evaluate({ baseline: baseline({ calibrationBaselineDateKey: "no-fecha" }) }), "invalid_input").reasons).toEqual([
      "baseline_calibration_date_invalid",
    ]);
  });
  it("baseline_calibration_date_invalid — fecha futura respecto a referenceDateKey", () => {
    expect(expectStatus(evaluate({ baseline: baseline({ calibrationBaselineDateKey: addDaysUTC(REF, 1) }) }), "invalid_input").reasons).toEqual([
      "baseline_calibration_date_invalid",
    ]);
  });
  it("calibrationBaselineDateKey === referenceDateKey (mismo día) es válido, no futuro", () => {
    expect(evaluate({ baseline: baseline({ calibrationBaselineDateKey: REF }) }).status).toBe("keep_targets");
  });

  it("strategy_result_malformed — status desconocido", () => {
    expect(expectStatus(evaluate({ strategy: { status: "bogus" } }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("strategy_result_malformed — ok sin weeklyPlan", () => {
    expect(expectStatus(evaluate({ strategy: { status: "ok", objective: "fat_loss", priority: "fat_loss_lean", audit: { desiredObservedRateBandPctPerWeek: { minPct: -1, maxPct: -0.5 } } } }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("strategy_result_malformed — distributionRoundingDeltaKcal != 0 (relación imposible, PR2B la garantiza siempre 0 en ok)", () => {
    expect(expectStatus(evaluate({ strategy: okStrategy({ distributionRoundingDeltaKcal: 1 }) }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("strategy_result_malformed — banda con minPct > maxPct", () => {
    expect(expectStatus(evaluate({ strategy: okStrategy({ minPct: 0, maxPct: -1 }) }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("strategy_result_malformed — objective=maintain con priority no nula (coherencia miembro-de-unión)", () => {
    expect(expectStatus(evaluate({ strategy: okStrategy({ objective: "maintain", priority: "balanced" }) }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("strategy_result_malformed — objective distinto de maintain con priority nula", () => {
    expect(expectStatus(evaluate({ strategy: okStrategy({ objective: "fat_loss", priority: null }) }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("objective=maintain con priority=null SÍ es coherente (caso real alcanzable)", () => {
    const result = evaluate({
      strategy: okStrategy({ objective: "maintain", priority: null, minPct: -0.25, maxPct: 0.25 }),
      weightTrend: weightEvaluated({ weeklyChangePercent: 0 }), // dentro de la banda de "maintain"
    });
    expect(result.status).toBe("keep_targets");
  });
  it("unsupported_population malformada (diagnostic != null) -> strategy_result_malformed, no stop", () => {
    const strategy = { status: "unsupported_population", reasons: ["pregnant_or_breastfeeding"], diagnostic: "no debería tener texto" };
    expect(expectStatus(evaluate({ strategy }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("unsupported_population con reasons fuera del vocabulario cerrado -> strategy_result_malformed", () => {
    expect(expectStatus(evaluate({ strategy: unsupportedPopulationStrategy(["bogus_reason"]) }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("specialist_review_required con audit malformado (minKcalDetected > maxKcalDetected) -> strategy_result_malformed", () => {
    const strategy = { status: "specialist_review_required", audit: { minKcalDetected: 1200, maxKcalDetected: 1100, reasons: ["low_energy_diet_day_present"] } };
    expect(expectStatus(evaluate({ strategy }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  // Hallazgo de la auditoría adversarial (P1): un objeto con status
  // "unresolved_input"/"invalid_input"/"infeasible" pero SIN `reasons` (o
  // con reasons:[], imposible en el contrato real de PR3) atravesaba antes
  // la validación como "not_ok" legítimo -> deferred, en vez de quedar
  // marcado como strategy_result_malformed. Corregido en classifyStrategy.
  it("strategy_result_malformed — unresolved_input SIN reasons (payload imposible con status conocido)", () => {
    expect(expectStatus(evaluate({ strategy: { status: "unresolved_input" } }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("strategy_result_malformed — invalid_input con reasons:[] (vacío, imposible en el contrato real de PR3)", () => {
    expect(expectStatus(evaluate({ strategy: { status: "invalid_input", reasons: [] } }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });
  it("strategy_result_malformed — infeasible SIN reasons", () => {
    expect(expectStatus(evaluate({ strategy: { status: "infeasible" } }), "invalid_input").reasons).toEqual(["strategy_result_malformed"]);
  });

  it("weight_trend_result_malformed — coverage ausente", () => {
    expect(expectStatus(evaluate({ weightTrend: { status: "evaluated" } }), "invalid_input").reasons).toEqual(["weight_trend_result_malformed"]);
  });
  it("weight_trend_result_malformed — windowCalendarDays declarado no coincide con la diferencia ordinal real (ítem 5)", () => {
    expect(expectStatus(evaluate({ weightTrend: weightEvaluated({ windowCalendarDays: 30 }) }), "invalid_input").reasons).toEqual(["weight_trend_result_malformed"]);
  });
  it("weight_trend_result_malformed — measurementsInWindow > windowCalendarDays (relación imposible)", () => {
    expect(expectStatus(evaluate({ weightTrend: weightEvaluated({ measurementsInWindow: 30 }) }), "invalid_input").reasons).toEqual(["weight_trend_result_malformed"]);
  });
  it("weight_trend_result_malformed — measurementSpanDays >= windowCalendarDays (relación imposible)", () => {
    expect(expectStatus(evaluate({ weightTrend: weightEvaluated({ measurementSpanDays: 29 }) }), "invalid_input").reasons).toEqual(["weight_trend_result_malformed"]);
  });
  it("weight_trend_result_malformed — trendQualityLevel desconocido", () => {
    expect(expectStatus(evaluate({ weightTrend: weightEvaluated({ trendQualityLevel: "excellent" }) }), "invalid_input").reasons).toEqual(["weight_trend_result_malformed"]);
  });
  it("weight_trend_result_malformed — insufficient_data con measurementsInWindow >= minimumMeasurementsRequired (contradicción)", () => {
    expect(expectStatus(evaluate({ weightTrend: weightInsufficient({ measurementsInWindow: 21, minimumMeasurementsRequired: 21 }) }), "invalid_input").reasons).toEqual([
      "weight_trend_result_malformed",
    ]);
  });
  it("weight_trend_result_malformed — invalid_input con reasons vacío", () => {
    expect(expectStatus(evaluate({ weightTrend: { status: "invalid_input", reasons: [] } }), "invalid_input").reasons).toEqual(["weight_trend_result_malformed"]);
  });

  it("weight_window_not_policy — fin distinto de referenceDateKey", () => {
    expect(expectStatus(evaluate({ weightTrend: weightEvaluated({ windowEndDateKey: addDaysUTC(REF, -1), windowStartDateKey: addDaysUTC(REF, -29) }) }), "invalid_input").reasons).toEqual([
      "weight_window_not_policy",
    ]);
  });
  it("weight_window_not_policy — longitud real correcta pero distinta de 29 (28 fechas)", () => {
    expect(
      expectStatus(
        evaluate({ weightTrend: weightEvaluated({ windowStartDateKey: addDaysUTC(REF, -27), windowCalendarDays: 28, measurementsInWindow: 25, measurementSpanDays: 27 }) }),
        "invalid_input",
      ).reasons,
    ).toEqual(["weight_window_not_policy"]);
  });

  it("intake_coverage_result_malformed — plausibleDays > loggedDays (relación imposible)", () => {
    expect(expectStatus(evaluate({ intakeCoverage: intakeEvaluated({ plausibleDays: 29, loggedDays: 28 }) }), "invalid_input").reasons).toEqual(["intake_coverage_result_malformed"]);
  });
  it("intake_coverage_result_malformed — recordsWithTargetCount > loggedDays", () => {
    expect(expectStatus(evaluate({ intakeCoverage: intakeEvaluated({ recordsWithTargetCount: 29, loggedDays: 28 }) }), "invalid_input").reasons).toEqual(["intake_coverage_result_malformed"]);
  });
  it("intake_coverage_result_malformed — plausibleCoverageFraction incoherente con plausibleDays/eligibleCalendarDays (fuera de tolerancia)", () => {
    expect(expectStatus(evaluate({ intakeCoverage: intakeEvaluated({ plausibleDays: 14, eligibleCalendarDays: 28, plausibleCoverageFraction: 0.9 }) }), "invalid_input").reasons).toEqual([
      "intake_coverage_result_malformed",
    ]);
  });
  it("plausibleCoverageFraction dentro de tolerancia 1e-9 SÍ se acepta (14/28 = 0.5 exacto, declarado con un error de 1e-10)", () => {
    const result = evaluate({
      intakeCoverage: intakeEvaluated({ loggedDays: 14, plausibleDays: 14, recordsWithTargetCount: 14, plausibleCoverageFraction: 0.5 + 1e-10 }),
    });
    expect(result.status).not.toBe("invalid_input");
  });
  it("intake_coverage_result_malformed — plausibleDays=0 con averagePlausibleLoggedKcal no nulo", () => {
    expect(expectStatus(evaluate({ intakeCoverage: intakeEvaluated({ plausibleDays: 0, plausibleCoverageFraction: 0, averagePlausibleLoggedKcal: 100 }) }), "invalid_input").reasons).toEqual([
      "intake_coverage_result_malformed",
    ]);
  });
  it("intake_coverage_result_malformed — intakeAccuracy != 'unknown'", () => {
    expect(expectStatus(evaluate({ intakeCoverage: intakeEvaluated({ intakeAccuracy: "high" }) }), "invalid_input").reasons).toEqual(["intake_coverage_result_malformed"]);
  });
  it("intake_window_not_policy — longitud distinta de 28", () => {
    expect(
      expectStatus(
        evaluate({
          intakeCoverage: intakeEvaluated({
            windowStartDateKey: addDaysUTC(REF, -28),
            eligibleCalendarDays: 29,
            plausibleCoverageFraction: 28 / 29,
          }),
        }),
        "invalid_input",
      ).reasons,
    ).toEqual(["intake_window_not_policy"]);
  });

  it("exercise_performance_result_malformed — windowSessionCount negativo", () => {
    expect(expectStatus(evaluate({ exercisePerformance: { status: "evaluated", windowSessionCount: -1 } }), "invalid_input").reasons).toEqual(["exercise_performance_result_malformed"]);
  });
  it("exercise_performance_result_malformed — status desconocido", () => {
    expect(expectStatus(evaluate({ exercisePerformance: { status: "bogus" } }), "invalid_input").reasons).toEqual(["exercise_performance_result_malformed"]);
  });

  it("review_history_invalid — pendingProposalId vacío (ni null ni no-vacío)", () => {
    expect(expectStatus(evaluate({ reviewHistory: reviewHistory({ pendingProposalId: "" }) }), "invalid_input").reasons).toEqual(["review_history_invalid"]);
  });
  it("review_history_last_resolved_date_invalid — formato imposible", () => {
    expect(expectStatus(evaluate({ reviewHistory: reviewHistory({ lastResolvedOnDateKey: "no-fecha" }) }), "invalid_input").reasons).toEqual(["review_history_last_resolved_date_invalid"]);
  });
  it("review_history_last_resolved_date_invalid — fecha futura respecto a referenceDateKey", () => {
    expect(expectStatus(evaluate({ reviewHistory: reviewHistory({ lastResolvedOnDateKey: addDaysUTC(REF, 1) }) }), "invalid_input").reasons).toEqual([
      "review_history_last_resolved_date_invalid",
    ]);
  });
});

describe("Fase B — cuando referenceDateKey es inválida, no se compara ninguna fecha contra ella (sin comparación sin sentido)", () => {
  it("calibrationBaselineDateKey válida pero referenceDateKey inválida -> solo reference_date_key_invalid, no calibración", () => {
    const result = evaluate({ referenceDateKey: "bogus", baseline: baseline({ calibrationBaselineDateKey: "2099-01-01" }) });
    expect(expectStatus(result, "invalid_input").reasons).toEqual(["reference_date_key_invalid"]);
  });
  it("ventanas no se evalúan contra política cuando referenceDateKey es inválida, pero sí se valida su forma/relaciones", () => {
    const result = evaluate({ referenceDateKey: "bogus", weightTrend: weightEvaluated({ measurementsInWindow: 999 }) });
    const invalid = expectStatus(result, "invalid_input");
    expect(invalid.reasons).toContain("reference_date_key_invalid");
    expect(invalid.reasons).toContain("weight_trend_result_malformed");
    expect(invalid.reasons).not.toContain("weight_window_not_policy");
  });
});

describe("Fase B — varias razones a la vez se acumulan y canonicalizan (no solo la primera encontrada)", () => {
  it("orden canónico independiente del orden de construcción del objeto de entrada", () => {
    const a = evaluate({ referenceDateKey: "bogus", strategy: { status: "bogus" }, exercisePerformance: { status: "bogus" } });
    const b = evaluate({ exercisePerformance: { status: "bogus" }, strategy: { status: "bogus" }, referenceDateKey: "bogus" });
    expect(expectStatus(a, "invalid_input").reasons).toEqual(["reference_date_key_invalid", "strategy_result_malformed", "exercise_performance_result_malformed"]);
    expect(expectStatus(a, "invalid_input").reasons).toEqual(expectStatus(b, "invalid_input").reasons);
  });
});

// ─── Fase C — APLAZAMIENTO ─────────────────────────────────────────────

describe("Fase C — deferred, seis razones alcanzables individualmente, con evidence (ítem 13, no provisional)", () => {
  it("strategy_unresolved_input", () => {
    const result = expectStatus(evaluate({ strategy: notOkStrategy("unresolved_input") }), "deferred");
    expect(result.reasons).toEqual(["strategy_unresolved_input"]);
    expect(result.reviewIntervalDaysRemaining).toBeNull();
    expect(result.evidence.weight.status).toBe("evaluated");
    expect("classifiedRatePctPerWeek" in result).toBe(false);
    expect("rateBandPosition" in result).toBe(false);
    expect("deltaKcalPerDay" in result).toBe(false);
  });
  it("strategy_invalid_input", () => {
    expect(expectStatus(evaluate({ strategy: notOkStrategy("invalid_input") }), "deferred").reasons).toEqual(["strategy_invalid_input"]);
  });
  it("strategy_infeasible", () => {
    expect(expectStatus(evaluate({ strategy: notOkStrategy("infeasible") }), "deferred").reasons).toEqual(["strategy_infeasible"]);
  });
  it("baseline_target_mismatch — el objetivo persistido no coincide con el que PR3 acaba de resolver", () => {
    const result = expectStatus(evaluate({ baseline: baseline({ weeklyKcalTargetInForce: 15236 }), strategy: okStrategy({ weeklyKcalTargetInForce: 15529 }) }), "deferred");
    expect(result.reasons).toEqual(["baseline_target_mismatch"]);
  });
  it("proposal_pending_decision", () => {
    expect(expectStatus(evaluate({ reviewHistory: reviewHistory({ pendingProposalId: "prop-1" }) }), "deferred").reasons).toEqual(["proposal_pending_decision"]);
  });
  it("review_interval_active — 13 días bloquea, remaining=1", () => {
    const result = expectStatus(evaluate({ reviewHistory: reviewHistory({ lastResolvedOnDateKey: addDaysUTC(REF, -13) }) }), "deferred");
    expect(result.reasons).toEqual(["review_interval_active"]);
    expect(result.reviewIntervalDaysRemaining).toBe(1);
  });
  it("review_interval_active — 14 días permite (frontera inclusiva, paridad v3.1)", () => {
    expect(evaluate({ reviewHistory: reviewHistory({ lastResolvedOnDateKey: addDaysUTC(REF, -14) }) }).status).not.toBe("deferred");
  });
  it("múltiples razones de aplazamiento a la vez, orden canónico", () => {
    const result = expectStatus(
      evaluate({ strategy: notOkStrategy("infeasible"), reviewHistory: reviewHistory({ pendingProposalId: "p1", lastResolvedOnDateKey: addDaysUTC(REF, -5) }) }),
      "deferred",
    );
    expect(result.reasons).toEqual(["strategy_infeasible", "proposal_pending_decision", "review_interval_active"]);
  });
});

// ─── Fase D — EVIDENCIA INSUFICIENTE ────────────────────────────────────

describe("Fase D — insufficient_evidence, siete razones alcanzables individualmente", () => {
  it("weight_trend_unavailable", () => {
    expect(expectStatus(evaluate({ weightTrend: weightInvalid() }), "insufficient_evidence").reasons).toEqual(["weight_trend_unavailable"]);
  });
  it("weight_trend_insufficient_data", () => {
    expect(expectStatus(evaluate({ weightTrend: weightInsufficient() }), "insufficient_evidence").reasons).toEqual(["weight_trend_insufficient_data"]);
  });
  it("weight_trend_quality_not_high", () => {
    expect(expectStatus(evaluate({ weightTrend: weightEvaluated({ trendQualityLevel: "moderate" }) }), "insufficient_evidence").reasons).toContain("weight_trend_quality_not_high");
  });
  it("weight_measurements_below_minimum (nivel high pero <21 mediciones — recuento, no amplitud de calendario, O1 cerrado)", () => {
    const result = expectStatus(evaluate({ weightTrend: weightEvaluated({ measurementsInWindow: 10, trendQualityLevel: "high" }) }), "insufficient_evidence");
    expect(result.reasons).toContain("weight_measurements_below_minimum");
  });
  it("intake_coverage_unavailable", () => {
    expect(expectStatus(evaluate({ intakeCoverage: intakeInvalid() }), "insufficient_evidence").reasons).toEqual(["intake_coverage_unavailable"]);
  });
  it("intake_records_missing_daily_targets — 27/28 con objetivo diario (cierra O4)", () => {
    expect(expectStatus(evaluate({ intakeCoverage: intakeEvaluated({ recordsWithTargetCount: 27 }) }), "insufficient_evidence").reasons).toEqual(["intake_records_missing_daily_targets"]);
  });
  it("intake_plausible_coverage_below_minimum — 18/28 = 0.643", () => {
    const result = expectStatus(
      evaluate({ intakeCoverage: intakeEvaluated({ loggedDays: 18, plausibleDays: 18, recordsWithTargetCount: 18, plausibleCoverageFraction: 18 / 28 }) }),
      "insufficient_evidence",
    );
    expect(result.reasons).toEqual(["intake_plausible_coverage_below_minimum"]);
  });
  it("varias razones de evidencia insuficiente a la vez, orden canónico", () => {
    const result = expectStatus(evaluate({ weightTrend: weightInsufficient(), intakeCoverage: intakeInvalid() }), "insufficient_evidence");
    expect(result.reasons).toEqual(["weight_trend_insufficient_data", "intake_coverage_unavailable"]);
  });
  it("insufficient_evidence conserva context.performance", () => {
    const result = expectStatus(evaluate({ weightTrend: weightInvalid(), exercisePerformance: exerciseEvaluated(3) }), "insufficient_evidence");
    expect(result.context.performance).toEqual({ status: "observed", influenceOnDecision: "none", windowSessionCount: 3 });
  });
});

// ─── Fase E/F — CLASIFICACIÓN Y PROPUESTA (escenario productivo real) ──

describe("Fase E — keep_targets, dentro de banda", () => {
  it("-0.7 dentro de [-1.0,-0.5] -> keep_targets, sin campo de confianza", () => {
    const result = expectStatus(evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -0.7 }) }), "keep_targets");
    expect(result.reasons).toEqual(["rate_within_expected_band"]);
    expect(result.classifiedRatePctPerWeek).toBe(-0.7);
    expect(result.desiredBandPctPerWeek).toEqual({ minPct: -1.0, maxPct: -0.5 });
    expect("confidence" in result).toBe(false);
    expect(result.policy.provenance.stepKcalPerDay).toBe("heuristic_inherited_from_v3_1");
    expect(result.policy.provenance.intakeRecordsRequireDailyTarget).toBe("v4_conservative_safeguard");
    expect(result.policy.provenance.performanceIsNonDecisional).toBe("v4_architectural_decision");
    expect(result.policy.provenance.weightWindowCalendarDays).toBe("window_length_observed_parity_with_v3_1");
  });

  it("frontera exacta de banda (-0.5 y -1.0) cae dentro (inclusiva)", () => {
    expect(evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -0.5 }) }).status).toBe("keep_targets");
    expect(evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -1.0 }) }).status).toBe("keep_targets");
  });
});

describe("Fase E/F — adjustment_proposal, fuera de banda (números reales verificados durante el diseño)", () => {
  it("-0.1919831576844906 (redondea a -0.2) -> above_band -> -100/día", () => {
    const result = expectStatus(evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -0.1919831576844906 }) }), "adjustment_proposal");
    expect(result.rateBandPosition).toBe("above_band");
    expect(result.classifiedRatePctPerWeek).toBe(-0.2);
    expect(result.deltaKcalPerDay).toBe(-100);
    expect(result.deltaKcalPerWeek).toBe(-700);
    expect(result.currentWeeklyKcalTarget).toBe(15236);
    expect(result.proposedWeeklyKcalTarget).toBe(14536);
    expect(result.currentDailyAverageKcal).toBeCloseTo(2176.5714285714284, 9);
    expect(result.proposedDailyAverageKcal).toBeCloseTo(2076.5714285714284, 9);
    expect(result.confidence).toBe("moderate");
    expect(result.requiresNutritionReplan).toBe(true);
    expect(result.requiresExplicitUserAcceptance).toBe(true);
  });

  it("-1.3208754169959263 (redondea a -1.3) -> below_band -> +100/día", () => {
    const result = expectStatus(evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -1.3208754169959263 }) }), "adjustment_proposal");
    expect(result.rateBandPosition).toBe("below_band");
    expect(result.classifiedRatePctPerWeek).toBe(-1.3);
    expect(result.deltaKcalPerDay).toBe(100);
    expect(result.proposedWeeklyKcalTarget).toBe(15936);
  });

  it("basis contiene los hechos observados, pendingProposalIdObserved siempre null (ítem 12)", () => {
    const result = expectStatus(
      evaluate({
        weightTrend: weightEvaluated({ weeklyChangePercent: -1.4 }),
        baseline: baseline({ targetVersionId: "tv-9", strategyVersionId: "sv-9", calibrationBaselineDateKey: "2026-09-01" }),
        reviewHistory: reviewHistory({ lastResolvedOnDateKey: addDaysUTC(REF, -20) }),
      }),
      "adjustment_proposal",
    );
    expect(result.basis).toEqual({
      policyVersion: "adaptive-coordinator-v1",
      referenceDateKey: REF,
      targetVersionId: "tv-9",
      weeklyKcalTargetInForce: 15236,
      strategyObjective: "fat_loss",
      strategyPriority: "fat_loss_lean",
      strategyVersionId: "sv-9",
      calibrationBaselineDateKey: "2026-09-01",
      lastResolvedOnDateKey: addDaysUTC(REF, -20),
      pendingProposalIdObserved: null,
    });
  });
});

// ─── Numeric extremes — DEFENSA runtime, no escenario productivo (ítem 4) ─
//
// Estos dos casos NO son planes que PR3 produciría en un uso normal: son
// pruebas de robustez del coordinador ante un objetivo semanal extremo o
// inconsistente con la procedencia habitual, construido con un `strategy`
// estructuralmente válido (misma forma que "ok" real) únicamente para
// alcanzar el límite numérico. Ver §3/§4 del diseño v3: el error tardío
// derived_numeric_result_invalid solo puede descubrirse aquí, en la fase
// de construcción de la propuesta, y no se acota artificialmente
// weeklyKcalTargetInForce en la Fase B para evitarlos.

describe("Fase F — defensa runtime ante límites numéricos extremos (no escenarios productivos)", () => {
  it("DEFENSA: weeklyKcalTargetInForce = MAX_SAFE_INTEGER-3, below_band (+700) desborda el entero seguro -> invalid_input/derived_numeric_result_invalid", () => {
    const extreme = Number.MAX_SAFE_INTEGER - 3;
    const result = evaluate({
      baseline: baseline({ weeklyKcalTargetInForce: extreme }),
      strategy: okStrategy({ weeklyKcalTargetInForce: extreme }),
      weightTrend: weightEvaluated({ weeklyChangePercent: -1.4 }), // below_band -> +100/día
    });
    expect(result).toEqual({ status: "invalid_input", reasons: ["derived_numeric_result_invalid"] });
  });

  it("DEFENSA: weeklyKcalTargetInForce = 600 (mínimo positivo, no un plan real), above_band (-700) da un resultado no positivo -> invalid_input/derived_numeric_result_invalid", () => {
    const result = evaluate({
      baseline: baseline({ weeklyKcalTargetInForce: 600 }),
      strategy: okStrategy({ weeklyKcalTargetInForce: 600 }),
      weightTrend: weightEvaluated({ weeklyChangePercent: -0.2 }), // above_band -> -100/día
    });
    expect(result).toEqual({ status: "invalid_input", reasons: ["derived_numeric_result_invalid"] });
  });

  it("PRODUCTIVO (control): el mismo weeklyKcalTargetInForce=600 con ritmo DENTRO de banda no llega nunca a la Fase F -> keep_targets, no invalid_input", () => {
    const result = evaluate({
      baseline: baseline({ weeklyKcalTargetInForce: 600 }),
      strategy: okStrategy({ weeklyKcalTargetInForce: 600 }),
      weightTrend: weightEvaluated({ weeklyChangePercent: -0.7 }), // dentro de banda
    });
    expect(result.status).toBe("keep_targets");
  });

  it("DEFENSA: la Fase B NO impone ningún suelo artificial sobre weeklyKcalTargetInForce — 600 pasa la Fase B sin ninguna razón de invalid_input", () => {
    // Confirma explícitamente que el rechazo de los dos casos anteriores
    // ocurre en la Fase F (dirección ya conocida), nunca antes.
    const result = evaluate({ baseline: baseline({ weeklyKcalTargetInForce: 600 }), strategy: okStrategy({ weeklyKcalTargetInForce: 600 }) });
    expect(result.status).not.toBe("invalid_input");
  });
});

// ─── Normalización de cero negativo (ítem 2) ────────────────────────────

describe("classifiedRatePctPerWeek nunca es -0", () => {
  // Banda "maintain" [-0.25,0.25] — la única de las cuatro bandas reales
  // que contiene el cero y el entorno de -0.2/-0.25 usado en estos casos.
  const maintainStrategy = () => okStrategy({ objective: "maintain", priority: null, minPct: -0.25, maxPct: 0.25 });

  it("valor negativo pequeño que redondearía a -0 (-0.02) se normaliza a 0", () => {
    const result = expectStatus(evaluate({ strategy: maintainStrategy(), weightTrend: weightEvaluated({ weeklyChangePercent: -0.02 }) }), "keep_targets");
    expect(Object.is(result.classifiedRatePctPerWeek, -0)).toBe(false);
    expect(result.classifiedRatePctPerWeek).toBe(0);
  });

  it("frontera exacta de media décima negativa (-0.05): Math.round(-0.5) = -0 en JS -> se normaliza a 0, no a -0.1", () => {
    expect(Math.round(-0.5)).toBe(-0); // documenta la premisa real de JS, no derivada del kernel
    const result = expectStatus(evaluate({ strategy: maintainStrategy(), weightTrend: weightEvaluated({ weeklyChangePercent: -0.05 }) }), "keep_targets");
    expect(result.classifiedRatePctPerWeek).toBe(0);
  });

  it("frontera negativa de media década no trivial (-0.25): Math.round(-2.5) = -2 en JS (redondeo hacia +Infinity, no 'lejos de cero') -> clasifica -0.2, no -0.3", () => {
    expect(Math.round(-2.5)).toBe(-2); // documenta la semántica real de Math.round antes de exigirla del kernel
    const result = expectStatus(evaluate({ strategy: maintainStrategy(), weightTrend: weightEvaluated({ weeklyChangePercent: -0.25 }) }), "keep_targets");
    expect(result.classifiedRatePctPerWeek).toBe(-0.2);
  });

  it("comprobación recursiva — ningún número del resultado público es -0, para varios estados", () => {
    function assertNoNegativeZero(value: unknown, path: string): void {
      if (typeof value === "number") {
        expect(Object.is(value, -0)).toBe(false);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => assertNoNegativeZero(v, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) assertNoNegativeZero(v, `${path}.${k}`);
      }
    }
    const scenarios: AdaptiveReviewResult[] = [
      evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -0.02 }) }),
      evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -0.05 }) }),
      evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -1.3208754169959263 }) }),
      evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -0.1919831576844906 }) }),
    ];
    scenarios.forEach((s, i) => assertNoNegativeZero(s, `scenario[${i}]`));
  });
});

// ─── Tabla exhaustiva: -0 literal inyectado desde upstream en cada campo
// numérico público reenviado (auditoría de la ronda anterior) ───────────
//
// El test recursivo de arriba solo detecta un -0 que YA llegó a la salida
// — no basta como regresión porque ningún fixture anterior inyectaba -0
// como valor de ENTRADA en estos campos concretos (el bug real de la
// ronda anterior era precisamente que ninguna fixture lo hacía). Esta
// tabla inyecta -0 literal en cada camino y falla si se retira la llamada
// a normalizeZero correspondiente — o, para los dos campos donde -0 no es
// un valor de dominio válido (tamaño de ventana), comprueba que se
// rechaza como payload malformado en vez de colarse.
describe("tabla — -0 literal desde upstream en cada campo numérico público, ítems 1 y 2 de la auditoría", () => {
  interface ZeroCase {
    name: string;
    run: () => AdaptiveReviewResult;
    /** Para los campos NORMALIZADOS: extrae el número del resultado. */
    extract?: (result: AdaptiveReviewResult) => number;
    /** Para los dos campos donde 0 NO es un valor de dominio válido
     *  (tamaño de ventana): la razón de invalid_input esperada. */
    expectRejectedAs?: "weight_trend_result_malformed" | "intake_coverage_result_malformed";
  }

  const cases: ZeroCase[] = [
    {
      name: "weightTrend.weeklyChangePercent = -0 -> evidence.weight.weeklyChangePercent normalizado",
      run: () => evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -0 }) }),
      extract: (r) => (r as any).evidence.weight.weeklyChangePercent,
    },
    {
      name: "weightTrend.coverage.measurementsInWindow = -0 (evaluated) -> evidence.weight.measurementsInWindow normalizado",
      run: () => evaluate({ weightTrend: weightEvaluated({ measurementsInWindow: -0 }) }),
      extract: (r) => (r as any).evidence.weight.measurementsInWindow,
    },
    {
      name: "weightTrend.coverage.measurementsInWindow = -0 (insufficient_data) -> evidence.weight.measurementsInWindow normalizado",
      run: () => evaluate({ weightTrend: weightInsufficient({ measurementsInWindow: -0, minimumMeasurementsRequired: 21 }) }),
      extract: (r) => (r as any).evidence.weight.measurementsInWindow,
    },
    {
      name: "weightTrend.measurementSpanDays = -0 -> evidence.weight.measurementSpanDays normalizado",
      run: () => evaluate({ weightTrend: weightEvaluated({ measurementSpanDays: -0 }) }),
      extract: (r) => (r as any).evidence.weight.measurementSpanDays,
    },
    {
      name: "weightTrend.coverage.windowCalendarDays = -0 -> 0 NO es tamaño de ventana válido, rechazado (no normalizado)",
      run: () => evaluate({ weightTrend: weightEvaluated({ windowCalendarDays: -0 }) }),
      expectRejectedAs: "weight_trend_result_malformed",
    },
    {
      name: "strategy.audit.desiredObservedRateBandPctPerWeek.minPct = -0 -> desiredBandPctPerWeek.minPct normalizado",
      run: () =>
        evaluate({
          strategy: okStrategy({ objective: "maintain", priority: null, minPct: -0, maxPct: 0.25 }),
          weightTrend: weightEvaluated({ weeklyChangePercent: 0.1 }),
        }),
      extract: (r) => (r as any).desiredBandPctPerWeek.minPct,
    },
    {
      name: "strategy.audit.desiredObservedRateBandPctPerWeek.maxPct = -0 -> desiredBandPctPerWeek.maxPct normalizado",
      run: () =>
        evaluate({
          strategy: okStrategy({ objective: "maintain", priority: null, minPct: -0.25, maxPct: -0 }),
          weightTrend: weightEvaluated({ weeklyChangePercent: -0.1 }),
        }),
      extract: (r) => (r as any).desiredBandPctPerWeek.maxPct,
    },
    {
      name: "intakeCoverage.loggedDays = -0 -> evidence.intake.loggedDays normalizado",
      run: () =>
        evaluate({
          intakeCoverage: intakeEvaluated({ loggedDays: -0, plausibleDays: 0, recordsWithTargetCount: 0, plausibleCoverageFraction: 0, averagePlausibleLoggedKcal: null }),
        }),
      extract: (r) => (r as any).evidence.intake.loggedDays,
    },
    {
      name: "intakeCoverage.plausibleDays = -0 -> evidence.intake.plausibleDays normalizado",
      run: () =>
        evaluate({
          intakeCoverage: intakeEvaluated({ plausibleDays: -0, loggedDays: 28, recordsWithTargetCount: 28, plausibleCoverageFraction: 0, averagePlausibleLoggedKcal: null }),
        }),
      extract: (r) => (r as any).evidence.intake.plausibleDays,
    },
    {
      name: "intakeCoverage.recordsWithTargetCount = -0 -> evidence.intake.recordsWithTargetCount normalizado",
      run: () => evaluate({ intakeCoverage: intakeEvaluated({ recordsWithTargetCount: -0 }) }),
      extract: (r) => (r as any).evidence.intake.recordsWithTargetCount,
    },
    {
      name: "intakeCoverage.plausibleCoverageFraction = -0 -> evidence.intake.plausibleCoverageFraction normalizado",
      run: () =>
        evaluate({
          intakeCoverage: intakeEvaluated({ plausibleCoverageFraction: -0, plausibleDays: 0, loggedDays: 0, recordsWithTargetCount: 0, averagePlausibleLoggedKcal: null }),
        }),
      extract: (r) => (r as any).evidence.intake.plausibleCoverageFraction,
    },
    {
      name: "intakeCoverage.averagePlausibleLoggedKcal = -0 -> evidence.intake.averagePlausibleLoggedKcal normalizado",
      run: () => evaluate({ intakeCoverage: intakeEvaluated({ averagePlausibleLoggedKcal: -0 }) }),
      extract: (r) => (r as any).evidence.intake.averagePlausibleLoggedKcal,
    },
    {
      name: "intakeCoverage.eligibleCalendarDays = -0 -> 0 NO es tamaño de ventana válido, rechazado (no normalizado)",
      run: () => evaluate({ intakeCoverage: intakeEvaluated({ eligibleCalendarDays: -0 }) }),
      expectRejectedAs: "intake_coverage_result_malformed",
    },
    {
      name: "exercisePerformance.windowSessionCount = -0 -> context.performance.windowSessionCount normalizado",
      run: () => evaluate({ exercisePerformance: { status: "evaluated", windowSessionCount: -0 } }),
      extract: (r) => (r as any).context.performance.windowSessionCount,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = c.run();
      if (c.expectRejectedAs) {
        expect(expectStatus(result, "invalid_input").reasons).toEqual([c.expectRejectedAs]);
        return;
      }
      expect(result.status).not.toBe("invalid_input");
      const value = c.extract!(result);
      expect(Object.is(value, -0)).toBe(false);
      expect(value).toBe(0);
    });
  }
});

// ─── Propiedades condicionadas correctamente (ítem 5) ───────────────────
//
// NO se afirma "keep_targets <=> dentro de banda" como equivalencia
// global (es falsa si hay stop/deferred/insufficient_evidence/entrada
// inválida) — se restringe explícitamente a entradas que ya alcanzan la
// Fase E limpiamente.

/** Generador congruencial determinista — mismo patrón que PR5A, el barrido
 *  no depende de Math.random. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 0xffffffff;
  };
}

describe("Propiedad — para entradas que alcanzan la Fase E limpiamente, dentro de banda produce keep_targets y fuera produce adjustment_proposal", () => {
  // Deliberadamente NO recalcula Math.round(weeklyChangePercent*10)/10 como
  // un oráculo independiente (eso sería reimplementar la única fórmula que
  // esta propiedad debería estar poniendo a prueba, y un error compartido
  // entre kernel y test pasaría desapercibido). En su lugar comprueba
  // AUTOCONSISTENCIA del propio resultado: qué status devolvió, si su
  // classifiedRatePctPerWeek cae dentro de la banda que el propio
  // resultado declara, y si rateBandPosition coincide con esa posición —
  // los valores exactos de redondeo (incluidas las fronteras de -0 y de
  // Math.round con negativos) ya están cubiertos por separado con
  // literales independientes verificados a mano más arriba.
  it("barrido de 400 valores de ritmo semilla-deterministas, con banda fija [-1.0,-0.5] — autoconsistencia, sin -0 en ningún punto", () => {
    const next = lcg(20260921);
    for (let i = 0; i < 400; i++) {
      const weeklyChangePercent = -3 + next() * 4; // rango [-3, 1)
      const result = evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent }) });
      if (result.status === "keep_targets") {
        expect(result.classifiedRatePctPerWeek).toBeGreaterThanOrEqual(result.desiredBandPctPerWeek.minPct);
        expect(result.classifiedRatePctPerWeek).toBeLessThanOrEqual(result.desiredBandPctPerWeek.maxPct);
      } else if (result.status === "adjustment_proposal") {
        const belowMin = result.classifiedRatePctPerWeek < result.desiredBandPctPerWeek.minPct;
        const aboveMax = result.classifiedRatePctPerWeek > result.desiredBandPctPerWeek.maxPct;
        expect(belowMin || aboveMax).toBe(true);
        expect(result.rateBandPosition).toBe(belowMin ? "below_band" : "above_band");
      } else {
        throw new Error(`estado inesperado para weeklyChangePercent=${weeklyChangePercent}: ${result.status}`);
      }
      expect(Object.is(result.classifiedRatePctPerWeek, -0)).toBe(false);
    }
  });
});

describe("Propiedad metamórfica — rendimiento entre alternativas VÁLIDAS deja idéntico todo salvo context.performance (ítem 3)", () => {
  const validAlternatives: Array<{ label: string; value: unknown }> = [
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "PR4 evaluated (0 sesiones)", value: exerciseEvaluated(0) },
    { label: "PR4 evaluated (7 sesiones)", value: exerciseEvaluated(7) },
    { label: "PR4 invalid_input", value: exerciseInvalid() },
  ];

  function withoutPerformance(result: AdaptiveReviewResult): unknown {
    if (!("context" in result)) return result;
    const { context, ...rest } = result as unknown as { context: { performance: unknown } } & Record<string, unknown>;
    const { performance: _performance, ...restContext } = context;
    return { ...rest, context: restContext };
  }

  // Pares SIN ordenar (i<j, no i!=j): comparar A contra B con toEqual es
  // simétrico — recorrer también (j,i) sería exactamente la misma
  // aserción con las dos llamadas intercambiadas, cero cobertura
  // adicional y el doble de casos (hallazgo de la auditoría de tests).
  for (let i = 0; i < validAlternatives.length; i++) {
    for (let j = i + 1; j < validAlternatives.length; j++) {
      const a = validAlternatives[i];
      const b = validAlternatives[j];
      it(`sustituir "${a.label}" por "${b.label}" (keep_targets) deja idéntico todo salvo context.performance`, () => {
        const resultA = evaluate({ exercisePerformance: a.value });
        const resultB = evaluate({ exercisePerformance: b.value });
        expect(resultA.status).toBe("keep_targets");
        expect(resultB.status).toBe("keep_targets");
        expect(withoutPerformance(resultA)).toEqual(withoutPerformance(resultB));
      });
    }
  }

  it("lo mismo se cumple en adjustment_proposal (delta y confianza no cambian)", () => {
    const resultA = evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -1.4 }), exercisePerformance: undefined }) as AdaptiveReviewAdjustmentProposal;
    const resultB = evaluate({ weightTrend: weightEvaluated({ weeklyChangePercent: -1.4 }), exercisePerformance: exerciseEvaluated(9) }) as AdaptiveReviewAdjustmentProposal;
    expect(resultA.status).toBe("adjustment_proposal");
    expect(resultB.status).toBe("adjustment_proposal");
    expect(resultA.deltaKcalPerDay).toBe(resultB.deltaKcalPerDay);
    expect(resultA.confidence).toBe(resultB.confidence);
    expect(withoutPerformance(resultA)).toEqual(withoutPerformance(resultB));
  });
});

describe("Un exercisePerformance MALFORMADO queda fuera de la propiedad metamórfica: produce invalid_input", () => {
  const malformed: unknown[] = [
    { status: "evaluated", windowSessionCount: -1 },
    { status: "evaluated", windowSessionCount: 1.5 },
    { status: "evaluated" },
    { status: "bogus" },
    42,
    "texto",
  ];
  for (const value of malformed) {
    it(`${JSON.stringify(value)} -> invalid_input/exercise_performance_result_malformed`, () => {
      expect(expectStatus(evaluate({ exercisePerformance: value }), "invalid_input").reasons).toEqual(["exercise_performance_result_malformed"]);
    });
  }

  it("salvo que una señal de seguridad válida tenga precedencia", () => {
    const result = evaluate({ exercisePerformance: { status: "bogus" }, strategy: stopStrategy("unsupported_plan") });
    expect(result.status).toBe("stop_and_recommend_review");
  });
});

// ─── Determinismo e inmutabilidad ────────────────────────────────────────

describe("determinismo", () => {
  it("misma entrada -> misma salida, profundamente idéntica", () => {
    const input = validInput({ weightTrend: weightEvaluated({ weeklyChangePercent: -1.1 }) }) as unknown as AdaptiveReviewInput;
    const a = evaluateAdaptiveReview(input);
    const b = evaluateAdaptiveReview(JSON.parse(JSON.stringify(input)));
    expect(a).toEqual(b);
  });
});

describe("inmutabilidad — evaluateAdaptiveReview nunca muta la entrada", () => {
  it("el input y sus objetos anidados permanecen intactos tras la llamada", () => {
    const input = validInput({ weightTrend: weightEvaluated({ weeklyChangePercent: -1.4 }) });
    const snapshot = JSON.parse(JSON.stringify(input));
    evaluateAdaptiveReview(input as unknown as AdaptiveReviewInput);
    expect(input).toEqual(snapshot);
  });
});

// ─── Estados upstream legítimos — barrido exhaustivo (ítem 14) ──────────

describe("todos los estados upstream legítimos producen el enrutamiento documentado en la tabla del diseño", () => {
  it("WeeklyStrategyResult: los 7 estados", () => {
    expect(evaluate({ strategy: okStrategy() }).status).toBe("keep_targets");
    expect(evaluate({ strategy: stopStrategy("specialist_review_required") }).status).toBe("stop_and_recommend_review");
    expect(evaluate({ strategy: stopStrategy("unsupported_plan") }).status).toBe("stop_and_recommend_review");
    expect(evaluate({ strategy: unsupportedPopulationStrategy() }).status).toBe("stop_and_recommend_review");
    expect(evaluate({ strategy: notOkStrategy("unresolved_input") }).status).toBe("deferred");
    expect(evaluate({ strategy: notOkStrategy("invalid_input") }).status).toBe("deferred");
    expect(evaluate({ strategy: notOkStrategy("infeasible") }).status).toBe("deferred");
  });
  it("WeightTrendEstimateResult: los 3 estados", () => {
    expect(evaluate({ weightTrend: weightEvaluated() }).status).toBe("keep_targets");
    expect(evaluate({ weightTrend: weightInsufficient() }).status).toBe("insufficient_evidence");
    expect(evaluate({ weightTrend: weightInvalid() }).status).toBe("insufficient_evidence");
  });
  it("IntakeLoggingCoverageResult: los 2 estados", () => {
    expect(evaluate({ intakeCoverage: intakeEvaluated() }).status).toBe("keep_targets");
    expect(evaluate({ intakeCoverage: intakeInvalid() }).status).toBe("insufficient_evidence");
  });
  it("ExercisePerformanceResult + ausencia: los 2 estados y la ausencia", () => {
    expect((evaluate({ exercisePerformance: exerciseEvaluated(4) }) as { context?: { performance: unknown } }).context?.performance).toEqual({
      status: "observed",
      influenceOnDecision: "none",
      windowSessionCount: 4,
    });
    expect((evaluate({ exercisePerformance: exerciseInvalid() }) as { context?: { performance: unknown } }).context?.performance).toEqual({
      status: "unavailable",
      influenceOnDecision: "none",
    });
    expect((evaluate({ exercisePerformance: undefined }) as { context?: { performance: unknown } }).context?.performance).toEqual({
      status: "not_provided",
      influenceOnDecision: "none",
    });
    expect((evaluate({ exercisePerformance: null }) as { context?: { performance: unknown } }).context?.performance).toEqual({
      status: "not_provided",
      influenceOnDecision: "none",
    });
  });
});

// ─── API pública del barrel ──────────────────────────────────────────────

describe("API público del barrel — packages/engine/src/index.ts", () => {
  it("expone evaluateAdaptiveReview y ninguno de los helpers internos de PR5B", () => {
    const barrel = engineBarrel as Record<string, unknown>;
    expect(typeof barrel.evaluateAdaptiveReview).toBe("function");
    const forbiddenNames = [
      "isPlainRecord",
      "isFiniteNumber",
      "isSafeInteger",
      "isNonEmptyString",
      "isNonEmptyStringArray",
      "isLeapYear",
      "daysInMonth",
      "isValidDateKey",
      "daysFromCivil",
      "parseValidDateKey",
      "daysBetweenDateKeys",
      "canonicalizeInvalid",
      "canonicalizeStop",
      "canonicalizeDeferral",
      "canonicalizeInsufficiency",
      "invalidInput",
      "isValidSafetyAudit",
      "classifyStrategy",
      "classifyWeightTrend",
      "classifyIntakeCoverage",
      "classifyExercisePerformance",
      "exerciseContextFrom",
      "classifySelfReport",
      "validateBaseline",
      "validateReviewHistory",
      "classifyRatePctPerWeek",
      "evidenceSummaryFrom",
    ];
    for (const name of forbiddenNames) expect(barrel[name]).toBeUndefined();
  });

  it("evaluateAdaptiveReview importado desde el barrel se comporta igual que el import directo", () => {
    const input = validInput() as unknown as AdaptiveReviewInput;
    expect(engineBarrel.evaluateAdaptiveReview(input)).toEqual(evaluateAdaptiveReview(input));
  });
});

// ─── Pureza (AST real, no regex) — mismo mecanismo auditado en
// weekly-plan-kernel.test.ts / exercise-performance-kernel.test.ts ──────

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

/** Certeza total, no heurística: enumera los especificadores de módulo de
 *  TODAS las declaraciones import del archivo — si esta lista solo
 *  contiene `@foodos/types`, el kernel no puede haber importado ningún
 *  otro kernel de packages/engine ni nada de apps/web, sin importar cómo
 *  lo use internamente. */
function collectImportModuleSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

describe("pureza — accesos directos prohibidos e imports prohibidos (AST real)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fileName = join(here, "adaptive-coordinator-kernel.ts");
  const source = readFileSync(fileName, "utf-8");

  it("el AST no contiene ningún acceso directo prohibido a Date/reloj/red/almacenamiento/estado global", () => {
    expect(findForbiddenDirectRuntimeReferences(source, fileName)).toEqual([]);
  });

  it("el único import del archivo es de tipos de @foodos/types — nunca otro kernel de packages/engine ni nada de apps/web", () => {
    const specifiers = collectImportModuleSpecifiers(source, fileName);
    expect(specifiers).toEqual(["@foodos/types"]);
  });
});

// ─── Confirmación estructural — apps/web no importa este kernel ────────

describe("confirmación estructural — apps/web no importa adaptive-coordinator-kernel ni @foodos/engine", () => {
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
