import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import type {
  DayLabel,
  MacroAllocationInfeasible,
  MacroAllocationOk,
  ResolvedWeeklyPlanDayInput,
  ResolvedWeeklyPlanDays,
  ResolvedWeeklyPlanRequest,
  UserPriorityLevel,
  WeeklyPlanInfeasible,
  WeeklyPlanInvalidInput,
  WeeklyPlanOk,
  WeeklyStrategyDayInput,
  WeeklyStrategyGoalInput,
  WeeklyStrategyInfeasible,
  WeeklyStrategyInput,
  WeeklyStrategyInvalidInput,
  WeeklyStrategyOk,
  WeeklyStrategyResult,
  WeeklyStrategySpecialistReviewRequired,
  WeeklyStrategyUnsupportedPlan,
  WeeklyStrategyUnsupportedPopulation,
} from "@foodos/types";
import { planWeeklyStrategy } from "./weekly-strategy-kernel";
import * as engineBarrel from "./index";

// ─── Fixtures — independientes del kernel ──────────────────────────────

function consecutiveDateKeys(y: number, m: number, d: number, count = 7): string[] {
  const start = Date.UTC(y, m - 1, d);
  const keys: string[] = [];
  for (let i = 0; i < count; i++) keys.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  return keys;
}
const WEEK1 = consecutiveDateKeys(2026, 9, 21, 7); // 4 fechas de "semana normal"

function week(labels: readonly DayLabel[], dateKeys: readonly string[] = WEEK1): WeeklyStrategyDayInput[] {
  return dateKeys.map((dateKey, i) => ({ dateKey, label: labels[i] }));
}

function priorityGoal(priority: UserPriorityLevel): WeeklyStrategyGoalInput {
  return { goalIntent: "priority_driven", priority };
}
const MAINTAIN_GOAL: WeeklyStrategyGoalInput = { goalIntent: "maintain" };

function baseInput(overrides: Partial<WeeklyStrategyInput> = {}): WeeklyStrategyInput {
  return {
    weightKg: 78,
    heightCm: 178,
    tdeeKcal: 2901,
    goal: priorityGoal("fat_loss_lean"),
    days: week(["strength", "strength", "strength", "strength", "rest", "rest", "rest"]),
    ...overrides,
  };
}

function expectOk(result: WeeklyStrategyResult): WeeklyStrategyOk {
  if (result.status !== "ok") throw new Error(`esperado ok, recibido ${JSON.stringify(result)}`);
  return result;
}

// ─── Casos A-I (recalculados y verificados con un script Node aparte) ──

describe("Caso A — mismo perfil/presupuesto, distinta confirmación -> MISMOS gramos, distinta confianza", () => {
  const input = baseInput({
    weightKg: 78,
    heightCm: 178,
    tdeeKcal: 2901,
    bodyFatPct: 15,
    bodyFatSource: "dxa",
    sex: "male",
    age: 28,
    goal: priorityGoal("fat_loss_lean"),
  });

  it("explicitly_planned (por defecto, sin override) -> proteína 172.38g decimal, policy provisional", () => {
    const result = expectOk(planWeeklyStrategy(input));
    expect(result.protein.targetGPerDay).toBeCloseTo(66.3 * 2.6, 6); // FFM=78*0.85=66.3
    expect(result.protein.policy).toBe("provisional");
    expect(result.planRequest.days[0].macros.proteinTargetG).toBe(result.protein.targetGPerDay);
  });

  it("confirmed_current vía override externo -> MISMOS 172.38g decimal, policy evidence_supported", () => {
    const withOverride: WeeklyStrategyInput = {
      ...input,
      strengthTrainingCurrentStatus: "confirmed_current",
      strengthTrainingExperience: "confirmed_over_six_months",
      energyRestrictionStatus: "confirmed_current",
    };
    const result = expectOk(planWeeklyStrategy(withOverride));
    expect(result.protein.targetGPerDay).toBeCloseTo(66.3 * 2.6, 6);
    expect(result.protein.policy).toBe("evidence_supported");
  });

  it("los gramos decimales son IDÉNTICOS bit a bit entre ambas llamadas", () => {
    const a = expectOk(planWeeklyStrategy(input));
    const b = expectOk(
      planWeeklyStrategy({
        ...input,
        strengthTrainingCurrentStatus: "confirmed_current",
        strengthTrainingExperience: "confirmed_over_six_months",
        energyRestrictionStatus: "confirmed_current",
      }),
    );
    expect(a.protein.targetGPerDay).toBe(b.protein.targetGPerDay);
    expect(a.protein.base).toBe(b.protein.base);
    expect(a.protein.baseKg).toBe(b.protein.baseKg);
    expect(a.protein.policy).not.toBe(b.protein.policy); // solo la confianza cambia
  });

  it("PR2A redondea 172.38g -> 172g en la cuota real de planWeek", () => {
    const result = expectOk(planWeeklyStrategy(input));
    const day0 = result.weeklyPlan.days[0];
    if (day0.allocation.status !== "ok") throw new Error("esperado ok");
    expect(day0.allocation.protein.assignedG).toBe(172);
  });

  it("grasa decimal ~67.4756g/día (25% de la energía semanal real, banda A: 4×0.85+3×0.82), redondeada por PR2A", () => {
    const result = expectOk(planWeeklyStrategy(input));
    const expectedFatDecimal = ((2901 * (4 * 0.85 + 3 * 0.82)) / 7) * 0.25 / 9;
    expect(result.fatTargetGPerDay).toBeCloseTo(expectedFatDecimal, 9);
    const day0 = result.weeklyPlan.days[0];
    if (day0.allocation.status !== "ok") throw new Error("esperado ok");
    expect(day0.allocation.fat.assignedG).toBe(Math.round(result.fatTargetGPerDay));
  });
});

describe("Caso B — perfil 124kg/177cm, 5 prioridades, semana explícita 4 strength/3 rest — meseta total en banda C", () => {
  const WEEK_4_3 = week(["strength", "strength", "rest", "strength", "strength", "rest", "rest"]);
  function inputFor(priority: UserPriorityLevel): WeeklyStrategyInput {
    return baseInput({ weightKg: 124, heightCm: 177, tdeeKcal: 3155, sex: "male", age: 35, goal: priorityGoal(priority), days: WEEK_4_3 });
  }

  it("fat_loss_max y fat_loss_lean son TOTALMENTE idénticos en banda C (energía y proteína)", () => {
    const max = expectOk(planWeeklyStrategy(inputFor("fat_loss_max")));
    const lean = expectOk(planWeeklyStrategy(inputFor("fat_loss_lean")));
    expect(max.audit.requestedWeeklyKcal).toBeCloseTo(lean.audit.requestedWeeklyKcal, 6);
    expect(max.audit.requestedWeeklyKcal).toBeCloseTo(17668, 6);
    expect(max.weeklyPlan.days.map((d) => d.distributedKcalTarget)).toEqual([2524, 2524, 2524, 2524, 2524, 2524, 2524]);
    expect(lean.weeklyPlan.days.map((d) => d.distributedKcalTarget)).toEqual([2524, 2524, 2524, 2524, 2524, 2524, 2524]);
    expect(max.protein.targetGPerDay).toBeCloseTo(lean.protein.targetGPerDay, 9);
    expect(max.protein.targetGPerDay).toBeCloseTo(93.396 * 2.0, 3); // sin % de grasa -> fallback actual/adjusted 2.0
    expect(max.fatTargetGPerDay).toBeCloseTo(lean.fatTargetGPerDay, 9);
  });

  it("balanced difiere ligeramente (2619 gym / 2524 rest)", () => {
    const balanced = expectOk(planWeeklyStrategy(inputFor("balanced")));
    expect(balanced.audit.requestedWeeklyKcal).toBeCloseTo(18046.6, 3);
    expect(balanced.weeklyPlan.days.map((d) => d.distributedKcalTarget)).toEqual([2619, 2619, 2524, 2619, 2618, 2524, 2524]);
  });

  it("muscle_gain_lean y muscle_gain_max(sin experiencia) son idénticos con IMC>=27 (guardarraíl)", () => {
    const lean = expectOk(planWeeklyStrategy(inputFor("muscle_gain_lean")));
    const max = expectOk(planWeeklyStrategy(inputFor("muscle_gain_max")));
    expect(lean.weeklyPlan.days.map((d) => d.distributedKcalTarget)).toEqual([3155, 3155, 3155, 3155, 3155, 3155, 3155]);
    expect(max.weeklyPlan.days.map((d) => d.distributedKcalTarget)).toEqual([3155, 3155, 3155, 3155, 3155, 3155, 3155]);
    expect(lean.protein.targetGPerDay).toBeCloseTo(93.396 * 1.8, 3);
    expect(max.protein.targetGPerDay).toBeCloseTo(lean.protein.targetGPerDay, 9);
  });
});

describe("Caso C — semana 7-rest (0 strength), distribución uniforme", () => {
  it("balanced, banda A, TDEE=2500 -> reparto uniforme exacto", () => {
    const input = baseInput({
      weightKg: 70,
      heightCm: 175,
      tdeeKcal: 2500,
      goal: priorityGoal("balanced"),
      days: week(["rest", "rest", "rest", "rest", "rest", "rest", "rest"]),
    });
    const result = expectOk(planWeeklyStrategy(input));
    expect(result.audit.requestedWeeklyKcal).toBeCloseTo(2500 * 0.83 * 7, 6);
    expect(result.planRequest.energyPolicy.distribution).toEqual({ kind: "uniform" });
    expect(result.weeklyPlan.days.map((d) => d.distributedKcalTarget)).toEqual([2075, 2075, 2075, 2075, 2075, 2075, 2075]);
  });
});

describe("Caso D — mantenimiento, fatPct real de v3.1 (0.28, no 0.25)", () => {
  it("goalIntent=maintain -> factor 1.0 uniforme, fatPct=0.28", () => {
    const input = baseInput({
      weightKg: 78,
      heightCm: 178,
      tdeeKcal: 2901,
      bodyFatPct: 15,
      bodyFatSource: "dxa",
      goal: MAINTAIN_GOAL,
    });
    const result = expectOk(planWeeklyStrategy(input));
    expect(result.objective).toBe("maintain");
    expect(result.priority).toBeNull();
    expect(result.audit.requestedWeeklyKcal).toBeCloseTo(2901 * 7, 6);
    expect(result.planRequest.energyPolicy.distribution).toEqual({ kind: "uniform" });
    expect(result.fatTargetGPerDay).toBeCloseTo((2901 * 0.28) / 9, 6); // 90.253...
    expect(result.fatTargetGPerDay).not.toBeCloseTo((2901 * 0.25) / 9, 1); // NO el 0.25 de los otros objetivos
    const ffm = 78 * (1 - 0.15);
    expect(result.protein.targetGPerDay).toBeCloseTo(ffm * 2.0, 6); // no-déficit, FFM=2.0 (legacy, no Morton directo)
  });
});

describe("Caso E — propagación fiel de PR2B invalid_input (nunca reclasificado como infeasible)", () => {
  it("7 fechas no consecutivas (bug del caller) -> invalid_input con el veredicto de PR2B íntegro", () => {
    const badDays = week(
      ["strength", "strength", "strength", "strength", "rest", "rest", "rest"],
      [...WEEK1.slice(0, 6), "2099-01-01"], // rompe la consecutividad
    );
    const input = baseInput({ days: badDays });
    const result = planWeeklyStrategy(input);
    if (result.status !== "invalid_input") throw new Error(`esperado invalid_input, recibido ${result.status}`);
    expect(result.reasons).toEqual(["propagated_from_weekly_plan"]);
    expect(result.weeklyPlanVerdict).toBeDefined();
    const verdict = result.weeklyPlanVerdict as WeeklyPlanInvalidInput;
    expect(verdict.status).toBe("invalid_input");
    if (verdict.scope !== "request") throw new Error("esperado scope request");
    expect(verdict.reasons).toContain("date_keys_not_consecutive");
  });

  it("dos dateKey iguales (bug del caller) -> invalid_input con duplicate_date_key de PR2B, sin plan ejecutable", () => {
    const badDays = week(
      ["strength", "strength", "strength", "strength", "rest", "rest", "rest"],
      [...WEEK1.slice(0, 6), WEEK1[5]], // repite la fecha del día 6, nunca llega a 7 fechas únicas
    );
    const input = baseInput({ days: badDays });
    const result = planWeeklyStrategy(input);
    if (result.status !== "invalid_input") throw new Error(`esperado invalid_input, recibido ${result.status}`);
    expect(result.reasons).toEqual(["propagated_from_weekly_plan"]);
    const verdict = result.weeklyPlanVerdict as WeeklyPlanInvalidInput;
    expect(verdict.status).toBe("invalid_input");
    if (verdict.scope !== "request") throw new Error("esperado scope request");
    expect(verdict.reasons).toContain("duplicate_date_key");
    expect((result as unknown as { planRequest?: unknown }).planRequest).toBeUndefined();
    expect((result as unknown as { weeklyPlan?: unknown }).weeklyPlan).toBeUndefined();
  });
});

describe("Caso F — caso sintético de estrés defensivo para ejercitar la propagación de `infeasible` (no representa un perfil fisiológico plausible)", () => {
  it("95kg/145cm/85 años/mujer/6% grasa DXA, fat_loss_max -> combinación deliberadamente extrema e incoherente que fuerza planWeek a devolver infeasible, propagado íntegro", () => {
    // Este perfil es una construcción sintética, no un caso de uso realista:
    // combina edad muy avanzada (que reduce la TMB estimada) con un % de
    // grasa extremadamente bajo (que mantiene la masa libre de grasa, y por
    // tanto la proteína, alta) — una combinación internamente inverosímil en
    // una persona real, elegida únicamente porque satisface matemáticamente
    // el contrato de entrada y fuerza una vía real de `infeasible` en
    // planWeek. No usar como referencia de un caso de uso esperado ni añadir
    // validación antropométrica en PR3 para "corregirlo": queda fuera del
    // alcance de PR3 v1 (requeriría una política de plausibilidad nueva, no
    // evidencia ya acordada).
    const input = baseInput({
      weightKg: 95,
      heightCm: 145,
      age: 85,
      sex: "female",
      tdeeKcal: 1524, // TMB=1270 (Mifflin-St Jeor mujer) * 1.2 sedentario, verificado aparte
      bodyFatPct: 6,
      bodyFatSource: "dxa",
      goal: priorityGoal("fat_loss_max"),
      days: week(["rest", "rest", "rest", "rest", "rest", "rest", "rest"]),
    });
    const result = planWeeklyStrategy(input);
    if (result.status !== "infeasible") throw new Error(`esperado infeasible, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["propagated_from_weekly_plan"]);
    const verdict = result.weeklyPlanVerdict as WeeklyPlanInfeasible;
    expect(verdict.status).toBe("infeasible");
    expect(verdict.reasons).toEqual(["macro_allocation_infeasible"]);
    // FFM=95*0.94=89.3, proteína legacy fat_loss=2.6 -> 232.18 decimal -> 232g redondeado
    // kcal/día=round(1524*0.80)=1219 (con leftover de resto mayor, 6 días en 1219 y 1 en 1220)
    // fat decimal=(1524*0.80/9)*0.25=... usado(232*4+34*9)=1234 > 1219 -> infeasible
    const infeasibleDay = verdict.days.find((d) => d.allocation.status === "infeasible");
    expect(infeasibleDay).toBeDefined();
    const allocation = infeasibleDay?.allocation as MacroAllocationInfeasible;
    expect(allocation.proteinG).toBe(232);
    expect(allocation.fatG).toBe(34);
    expect(allocation.exceedsRoundedTargetByKcal).toBeGreaterThan(0);
  });
});

describe("Caso G — baja y muy baja energía (reachability verificado con perfiles extremos reales)", () => {
  it("50kg/155cm/60años/mujer/sedentaria, fat_loss_max -> specialist_review_required (low_energy_diet)", () => {
    const input = baseInput({
      weightKg: 50,
      heightCm: 155,
      age: 60,
      sex: "female",
      tdeeKcal: 1210,
      goal: priorityGoal("fat_loss_max"),
      days: week(["rest", "rest", "rest", "rest", "rest", "rest", "rest"]),
    });
    const result = planWeeklyStrategy(input);
    if (result.status !== "specialist_review_required") throw new Error(`esperado specialist_review_required, recibido ${JSON.stringify(result)}`);
    const r: WeeklyStrategySpecialistReviewRequired = result;
    expect(r.audit.reasons).toContain("low_energy_diet_day_present");
    expect(r.audit.minKcalDetected).toBeGreaterThanOrEqual(800);
    expect(r.audit.minKcalDetected).toBeLessThan(1200);
    expect((r as unknown as { planRequest?: unknown }).planRequest).toBeUndefined();
  });

  it("38kg/145cm/70años/mujer/sedentaria, fat_loss_max -> unsupported_plan (very_low_energy_diet)", () => {
    const input = baseInput({
      weightKg: 38,
      heightCm: 145,
      age: 70,
      sex: "female",
      tdeeKcal: 930,
      goal: priorityGoal("fat_loss_max"),
      days: week(["rest", "rest", "rest", "rest", "rest", "rest", "rest"]),
    });
    const result = planWeeklyStrategy(input);
    if (result.status !== "unsupported_plan") throw new Error(`esperado unsupported_plan, recibido ${JSON.stringify(result)}`);
    const r: WeeklyStrategyUnsupportedPlan = result;
    expect(r.audit.reasons).toContain("very_low_energy_diet_day_present");
    expect(r.audit.minKcalDetected).toBeLessThan(800);
    expect((r as unknown as { planRequest?: unknown }).planRequest).toBeUndefined();
  });
});

describe("Caso H — embarazo/lactancia bloquea TODOS los objetivos, sin excepción, antes de calcular nada", () => {
  for (const goal of [priorityGoal("fat_loss_max"), priorityGoal("muscle_gain_max"), MAINTAIN_GOAL] as const) {
    it(`goal=${JSON.stringify(goal)} + isPregnantOrBreastfeeding -> unsupported_population, diagnostic null`, () => {
      const input = baseInput({ goal, isPregnantOrBreastfeeding: true });
      const result = planWeeklyStrategy(input);
      expect(result).toEqual({
        status: "unsupported_population",
        reasons: ["pregnant_or_breastfeeding"],
        diagnostic: null,
      });
    });
  }

  it("preocupaciones autoinformadas también bloquean, con diagnostic:null", () => {
    const input = baseInput({ selfReportedConcerns: ["disordered_eating_history", "persistent_fatigue"] });
    const result = planWeeklyStrategy(input);
    expect(result).toEqual({
      status: "unsupported_population",
      reasons: ["self_reported_persistent_fatigue", "self_reported_disordered_eating_history"],
      diagnostic: null,
    });
  });
});

// ─── Experiencia — nunca 1.10 sin experiencia explícitamente resuelta ──

describe("muscle_gain_max — experiencia desconocida NUNCA recibe 1.10", () => {
  const week4_3 = week(["strength", "strength", "rest", "strength", "strength", "rest", "rest"]);
  function inputWithExperience(experienceLevel: "beginner" | "intermediate" | "advanced" | undefined): WeeklyStrategyInput {
    return baseInput({
      weightKg: 68,
      heightCm: 180,
      tdeeKcal: 2451,
      goal: priorityGoal("muscle_gain_max"),
      days: week4_3,
      experienceLevel: experienceLevel ?? undefined,
    });
  }

  // muscle_gain_max con IMC<27 da trainFactor===restFactor (plano) para
  // cualquier experiencia -> distribución "uniform" real, con el resto
  // mayor repartiendo el leftover a las fechas más tempranas (verificado
  // aparte con un script Node independiente): factor 1.10 -> [2697,2696×6]
  // suma 18873; factor 1.05 -> [2574×4,2573×3] suma 18015.
  it("beginner -> 1.10 (extremo bajo de Iraki) — reparto uniforme exacto verificado", () => {
    const result = expectOk(planWeeklyStrategy(inputWithExperience("beginner")));
    const shares = result.weeklyPlan.days.map((d) => d.distributedKcalTarget);
    expect(shares).toEqual([2697, 2696, 2696, 2696, 2696, 2696, 2696]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(18873);
  });
  it("intermediate -> 1.10 — mismo reparto exacto que beginner", () => {
    const result = expectOk(planWeeklyStrategy(inputWithExperience("intermediate")));
    const shares = result.weeklyPlan.days.map((d) => d.distributedKcalTarget);
    expect(shares).toEqual([2697, 2696, 2696, 2696, 2696, 2696, 2696]);
  });
  it("advanced -> 1.05 (meseta con muscle_gain_lean, nunca 1.10) — reparto uniforme exacto verificado", () => {
    const result = expectOk(planWeeklyStrategy(inputWithExperience("advanced")));
    const shares = result.weeklyPlan.days.map((d) => d.distributedKcalTarget);
    expect(shares).toEqual([2574, 2574, 2574, 2574, 2573, 2573, 2573]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(18015);
  });
  it("ausente (undefined) -> 1.05 conservador, NUNCA 1.10", () => {
    const result = expectOk(planWeeklyStrategy(inputWithExperience(undefined)));
    const shares = result.weeklyPlan.days.map((d) => d.distributedKcalTarget);
    expect(shares).toEqual([2574, 2574, 2574, 2574, 2573, 2573, 2573]);
    expect(shares.every((k) => k !== Math.round(2451 * 1.1) && k !== 2697)).toBe(true);
  });
});

// ─── Coherencia del override de energyRestrictionStatus ────────────────

describe("coherencia del override de energyRestrictionStatus — rechazo explícito ante contradicción", () => {
  it("presupuesto en déficit real + override 'not_restricted' -> invalid_input", () => {
    const input = baseInput({ goal: priorityGoal("fat_loss_max"), energyRestrictionStatus: "not_restricted" });
    expect(planWeeklyStrategy(input)).toEqual({
      status: "invalid_input",
      reasons: ["energy_restriction_override_contradicts_computed_deficit"],
    });
  });

  it("presupuesto en superávit (muscle_gain, IMC<27) + override 'confirmed_current' -> invalid_input", () => {
    const input = baseInput({
      weightKg: 68,
      heightCm: 180,
      goal: priorityGoal("muscle_gain_lean"),
      energyRestrictionStatus: "confirmed_current",
    });
    expect(planWeeklyStrategy(input)).toEqual({
      status: "invalid_input",
      reasons: ["energy_restriction_override_contradicts_computed_surplus_or_maintenance"],
    });
  });

  it("presupuesto en superávit + override 'explicitly_planned' -> también contradictorio", () => {
    const input = baseInput({
      weightKg: 68,
      heightCm: 180,
      goal: priorityGoal("muscle_gain_lean"),
      energyRestrictionStatus: "explicitly_planned",
    });
    expect(planWeeklyStrategy(input).status).toBe("invalid_input");
  });

  it("override 'unknown' nunca contradice nada, en déficit o superávit", () => {
    const deficit = baseInput({ goal: priorityGoal("fat_loss_max"), energyRestrictionStatus: "unknown" });
    const surplus = baseInput({ weightKg: 68, heightCm: 180, goal: priorityGoal("muscle_gain_lean"), energyRestrictionStatus: "unknown" });
    expect(planWeeklyStrategy(deficit).status).toBe("ok");
    expect(planWeeklyStrategy(surplus).status).toBe("ok");
  });

  it("sin override, PR3 deriva 'explicitly_planned' en déficit y 'not_restricted' en superávit, coherente matemáticamente", () => {
    const deficit = expectOk(planWeeklyStrategy(baseInput({ goal: priorityGoal("fat_loss_max") })));
    expect(deficit.protein.evidence).toBeDefined(); // solo confirma que se pudo clasificar sin lanzar
    const surplus = expectOk(planWeeklyStrategy(baseInput({ weightKg: 68, heightCm: 180, goal: priorityGoal("muscle_gain_lean") })));
    expect(surplus.status).toBe("ok");
  });
});

describe("coherencia de experiencia — advanced + under_six_months es una contradicción real", () => {
  it("experienceLevel=advanced + strengthTrainingExperience=under_six_months -> invalid_input", () => {
    const input = baseInput({ experienceLevel: "advanced", strengthTrainingExperience: "under_six_months" });
    expect(planWeeklyStrategy(input)).toEqual({
      status: "invalid_input",
      reasons: ["experience_signals_contradict_each_other"],
    });
  });

  it("advanced + unknown NO es contradictorio (experienceLevel nunca es proxy de strengthTrainingExperience)", () => {
    const input = baseInput({ experienceLevel: "advanced", strengthTrainingExperience: "unknown" });
    expect(planWeeklyStrategy(input).status).toBe("ok");
  });

  it("beginner + under_six_months NO es contradictorio (coherente entre sí)", () => {
    const input = baseInput({ experienceLevel: "beginner", strengthTrainingExperience: "under_six_months" });
    expect(planWeeklyStrategy(input).status).toBe("ok");
  });
});

// ─── Precedencia de seguridad ───────────────────────────────────────────

describe("precedencia de seguridad — orden estricto", () => {
  it("unsupported_population gana incluso con datos estructuralmente inválidos en otros campos", () => {
    const input = { ...baseInput(), isPregnantOrBreastfeeding: true, tdeeKcal: "no numérico" as unknown as number };
    expect(planWeeklyStrategy(input)).toEqual({
      status: "unsupported_population",
      reasons: ["pregnant_or_breastfeeding"],
      diagnostic: null,
    });
  });

  it("errores estructurales de entrada ganan antes de intentar llamar a planWeek", () => {
    const input = baseInput({ tdeeKcal: -100 });
    expect(planWeeklyStrategy(input)).toEqual({ status: "invalid_input", reasons: ["tdee_invalid"] });
  });

  it("varias razones de seguridad simultáneas se conservan TODAS, aunque el estado exterior lo decida la más restrictiva", () => {
    // Semana verificada aparte con un script Node: reparto real
    // [808,779,779,779,779,779,779] — el día de entreno cae en
    // [800,1200) (low_energy_diet) Y los 6 de descanso caen <800
    // (very_low_energy_diet) EN LA MISMA llamada — ambas razones deben
    // sobrevivir en `audit.reasons`, aunque el estado exterior sea el más
    // restrictivo (unsupported_plan, por el <800).
    const input = baseInput({
      weightKg: 70,
      heightCm: 175,
      age: 30,
      sex: "male",
      tdeeKcal: 950,
      goal: priorityGoal("fat_loss_lean"),
      days: week(["strength", "rest", "rest", "rest", "rest", "rest", "rest"]),
    });
    const result = planWeeklyStrategy(input);
    if (result.status !== "unsupported_plan") throw new Error(`esperado unsupported_plan, recibido ${JSON.stringify(result)}`);
    expect(result.audit.minKcalDetected).toBe(779);
    expect(result.audit.maxKcalDetected).toBe(808);
    expect(result.audit.reasons).toEqual(["very_low_energy_diet_day_present", "low_energy_diet_day_present"]);
  });
});

// ─── Tipos: solo `ok` puede contener un WeeklyPlanRequest ejecutable ──

describe("tipos — planRequest de ok es estrictamente resuelto (verificado por tsc --noEmit, no en runtime)", () => {
  it("marcador — el contenido real de esta prueba son los @ts-expect-error dentro de _typeChecksNeverCalled", () => {
    expect(typeof _typeChecksNeverCalled).toBe("function");
  });
});

function _typeChecksNeverCalled(
  resolvedDay: ResolvedWeeklyPlanDayInput,
  resolvedDays: ResolvedWeeklyPlanDays,
  fullyResolvedRequest: ResolvedWeeklyPlanRequest,
  genericRequest: import("@foodos/types").WeeklyPlanRequest,
): void {
  // 1) energyPolicy debe ser "resolved" — nunca "unresolved".
  const _t1: ResolvedWeeklyPlanRequest = {
    // @ts-expect-error — energyPolicy.status debe ser "resolved", ResolvedWeeklyEnergyPolicy no admite "unresolved".
    energyPolicy: { status: "unresolved", reasons: ["weekly_kcal_target_not_resolved"] },
    days: resolvedDays,
  };

  // 2) un día con macros "unresolved" no encaja en ResolvedWeeklyPlanDayInput.
  const _t2: ResolvedWeeklyPlanDayInput = {
    dateKey: "2026-09-21",
    label: "rest",
    // @ts-expect-error — macros debe ser {status:"resolved",...}, nunca "unresolved".
    macros: { status: "unresolved", reasons: ["protein_target_not_resolved"] },
  };

  // 3) ResolvedWeeklyPlanRequest ES asignable a WeeklyPlanRequest (estructuralmente compatible).
  const _t3: import("@foodos/types").WeeklyPlanRequest = fullyResolvedRequest;

  // 4) lo inverso NO es cierto: un WeeklyPlanRequest genérico no es un ResolvedWeeklyPlanRequest.
  // @ts-expect-error — WeeklyPlanRequest admite energyPolicy/macros sin resolver; ResolvedWeeklyPlanRequest no.
  const _t4: ResolvedWeeklyPlanRequest = genericRequest;

  void [_t1, _t2, _t3, _t4, resolvedDay];
}

// ─── Mock aislado — daily_macro_allocation_unexpected_unresolved a través de PR2B ──

describe("propagación defensiva de unresolved_input inesperado de PR2B (mock aislado)", () => {
  afterEach(() => {
    vi.doUnmock("./weekly-plan-kernel");
    vi.resetModules();
  });

  it("si planWeek devolviera unresolved_input (PR3 nunca lo provoca con entradas reales), el veredicto es invalid_input defensivo", async () => {
    vi.resetModules();
    vi.doMock("./weekly-plan-kernel", () => ({
      planWeek: () => ({ status: "unresolved_input", scope: "energy_policy", weeklyReasons: ["weekly_kcal_target_not_resolved"] }),
    }));
    const { planWeeklyStrategy: mockedPlanWeeklyStrategy } = await import("./weekly-strategy-kernel");
    const result = mockedPlanWeeklyStrategy(baseInput());
    expect(result).toEqual({
      status: "invalid_input",
      reasons: ["internal_construction_produced_unresolved_planweek_input"],
    });
  });
});

// ─── Inmutabilidad ──────────────────────────────────────────────────

describe("inmutabilidad — planWeeklyStrategy nunca muta la entrada", () => {
  it("el objeto input y su array days permanecen intactos tras la llamada", () => {
    const input = baseInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    planWeeklyStrategy(input);
    expect(input).toEqual(snapshot);
  });
});

// ─── Entradas runtime malformadas ───────────────────────────────────

describe("guarda total sobre `input` — nunca lanza, sin importar qué llegue", () => {
  const malformed: Array<{ label: string; value: unknown }> = [
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "string", value: "resolved" },
    { label: "número", value: 42 },
    { label: "array", value: [1, 2, 3] },
  ];
  for (const { label, value } of malformed) {
    it(`${label} -> invalid_input/input_object_invalid, nunca lanza`, () => {
      const input = value as unknown as WeeklyStrategyInput;
      expect(() => planWeeklyStrategy(input)).not.toThrow();
      expect(planWeeklyStrategy(input)).toEqual({ status: "invalid_input", reasons: ["input_object_invalid"] });
    });
  }

  it("objeto vacío -> unresolved_input con las 5 razones granulares", () => {
    const result = planWeeklyStrategy({} as unknown as WeeklyStrategyInput);
    expect(result).toEqual({
      status: "unresolved_input",
      reasons: ["weight_not_resolved", "height_not_resolved", "tdee_not_resolved", "goal_not_resolved", "days_not_resolved"],
    });
  });

  it("weightKg de tipo incorrecto -> invalid_input/weight_invalid (invalid gana sobre unresolved de otros campos)", () => {
    const input = { weightKg: "ochenta" } as unknown as WeeklyStrategyInput;
    const result = planWeeklyStrategy(input);
    expect(result.status).toBe("invalid_input");
    if (result.status === "invalid_input") expect(result.reasons).toContain("weight_invalid");
  });

  it("goal.goalIntent desconocido -> invalid_input/goal_invalid", () => {
    const input = baseInput({ goal: { goalIntent: "bogus" } as unknown as WeeklyStrategyGoalInput });
    expect(planWeeklyStrategy(input)).toEqual({ status: "invalid_input", reasons: ["goal_invalid"] });
  });

  it("priority_driven sin priority -> invalid_input/goal_invalid", () => {
    const input = baseInput({ goal: { goalIntent: "priority_driven" } as unknown as WeeklyStrategyGoalInput });
    expect(planWeeklyStrategy(input)).toEqual({ status: "invalid_input", reasons: ["goal_invalid"] });
  });

  it("days con 6 elementos -> invalid_input/days_invalid", () => {
    const input = baseInput({ days: week(["rest", "rest", "rest", "rest", "rest", "rest", "rest"]).slice(0, 6) });
    expect(planWeeklyStrategy(input)).toEqual({ status: "invalid_input", reasons: ["days_invalid"] });
  });

  it("label de día desconocida -> invalid_input/days_invalid", () => {
    const badDays = week(["strength", "strength", "strength", "strength", "rest", "rest", "rest"]);
    (badDays[0] as { label: unknown }).label = "bogus";
    expect(planWeeklyStrategy(baseInput({ days: badDays }))).toEqual({ status: "invalid_input", reasons: ["days_invalid"] });
  });

  it("sex con valor desconocido -> invalid_input/optional_context_signal_invalid", () => {
    const input = baseInput({ sex: "other" as unknown as WeeklyStrategyInput["sex"] });
    expect(planWeeklyStrategy(input)).toEqual({ status: "invalid_input", reasons: ["optional_context_signal_invalid"] });
  });

  it("isPregnantOrBreastfeeding no booleano -> invalid_input/pregnancy_flag_invalid", () => {
    const input = { ...baseInput(), isPregnantOrBreastfeeding: "sí" } as unknown as WeeklyStrategyInput;
    expect(planWeeklyStrategy(input)).toEqual({ status: "invalid_input", reasons: ["pregnancy_flag_invalid"] });
  });

  it("selfReportedConcerns con valor desconocido -> invalid_input/self_reported_concerns_invalid", () => {
    const input = { ...baseInput(), selfReportedConcerns: ["bogus"] } as unknown as WeeklyStrategyInput;
    expect(planWeeklyStrategy(input)).toEqual({ status: "invalid_input", reasons: ["self_reported_concerns_invalid"] });
  });

  it("nunca lanza para una combinación amplia de valores estructuralmente inválidos", () => {
    const garbage: unknown[] = [null, undefined, 0, "x", [], {}, { goal: "bogus" }, { days: "bogus" }];
    for (const g of garbage) {
      expect(() => planWeeklyStrategy(g as unknown as WeeklyStrategyInput)).not.toThrow();
    }
  });
});

// ─── Constantes / procedencia ───────────────────────────────────────

describe("constantes — fatPct reproduce exactamente la tabla de v3.1 (releída literalmente)", () => {
  it("fat_loss/recomp/muscle_gain=0.25, maintain=0.28", () => {
    const cases: Array<{ goal: WeeklyStrategyGoalInput; expectedFatPct: number; tdeeKcal: number; weightKg: number; heightCm: number }> = [
      { goal: priorityGoal("fat_loss_max"), expectedFatPct: 0.25, tdeeKcal: 2901, weightKg: 78, heightCm: 178 },
      { goal: priorityGoal("balanced"), expectedFatPct: 0.25, tdeeKcal: 2901, weightKg: 78, heightCm: 178 },
      { goal: priorityGoal("muscle_gain_lean"), expectedFatPct: 0.25, tdeeKcal: 2451, weightKg: 68, heightCm: 180 },
      { goal: MAINTAIN_GOAL, expectedFatPct: 0.28, tdeeKcal: 2901, weightKg: 78, heightCm: 178 },
    ];
    for (const c of cases) {
      const result = expectOk(planWeeklyStrategy(baseInput({ goal: c.goal, tdeeKcal: c.tdeeKcal, weightKg: c.weightKg, heightCm: c.heightCm })));
      const expectedFat = ((result.audit.requestedWeeklyKcal / 7) * c.expectedFatPct) / 9;
      expect(result.fatTargetGPerDay).toBeCloseTo(expectedFat, 9);
    }
  });
});

describe("auditoría de energía — decimal vs redondeado, nunca confundidos", () => {
  it("requestedWeeklyKcal es el decimal exacto; roundedWeeklyKcalTarget es su redondeo; deltaKcal es la diferencia", () => {
    const input = baseInput({ goal: priorityGoal("balanced") }); // banda A: 4*0.9+3*0.83=6.09 -> 2901*6.09=17669.09... no exacto, produce decimal real
    const result = expectOk(planWeeklyStrategy(input));
    const expectedRequested = 4 * (2901 * 0.9) + 3 * (2901 * 0.83);
    expect(result.audit.requestedWeeklyKcal).toBeCloseTo(expectedRequested, 6);
    expect(result.audit.roundedWeeklyKcalTarget).toBe(Math.round(expectedRequested));
    expect(result.audit.deltaKcal).toBeCloseTo(result.audit.roundedWeeklyKcalTarget - expectedRequested, 6);
    // El valor que PR2B redondeó de verdad coincide con el decimal, no con el pre-redondeado de PR3:
    const sumOfShares = result.weeklyPlan.days.reduce((s, d) => s + d.distributedKcalTarget, 0);
    expect(sumOfShares).toBe(result.audit.roundedWeeklyKcalTarget);
  });
});

// ─── API pública del barrel ─────────────────────────────────────────

describe("API público del barrel — packages/engine/src/index.ts", () => {
  it("expone planWeeklyStrategy y ninguno de los helpers internos de PR3", () => {
    const barrel = engineBarrel as Record<string, unknown>;
    expect(typeof barrel.planWeeklyStrategy).toBe("function");
    // Lista exhaustiva: los 23 nombres de función privada (sin `export`) que
    // existen hoy en weekly-strategy-kernel.ts. Se comprueba únicamente la
    // API pública real vista a través del barrel (`engineBarrel`, importado
    // arriba como `import * as engineBarrel from "./index"`), nunca leyendo
    // el archivo fuente ni filtrando por comentarios — si esta prueba pasa,
    // ninguno de estos nombres es alcanzable como propiedad del módulo
    // público. Si se añade o renombra un helper privado en el kernel sin
    // actualizar esta lista, la prueba deja de ser exhaustiva en silencio;
    // mantenerla sincronizada con las declaraciones `function` del kernel.
    const forbiddenNames = [
      "isPlainRecord",
      "assertNever",
      "isUsablePercent",
      "canonicalizeUnresolvedReasons",
      "canonicalizeInvalidReasons",
      "canonicalizeSafetyReasons",
      "canonicalizePopulationReasons",
      "invalidInput",
      "unresolvedInput",
      "validateRequiredNumber",
      "validateGoal",
      "validateDays",
      "isOptionalKnownString",
      "calcImc",
      "imcBand",
      "muscleGainMaxFactor",
      "resolveEnergyFactor",
      "objectiveFromGoal",
      "cyclingWeightForLabel",
      "buildDistribution",
      "actualOrAdjustedWeightBase",
      "resolveProteinBase",
      "buildHelmsProfile",
    ];
    for (const name of forbiddenNames) expect(barrel[name]).toBeUndefined();
  });

  it("planWeeklyStrategy importado desde el barrel se comporta igual que el import directo", () => {
    const input = baseInput();
    expect(engineBarrel.planWeeklyStrategy(input)).toEqual(planWeeklyStrategy(input));
  });
});

// ─── Pureza (AST real, no regex) ─────────────────────────────────────

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

describe("pureza — sin Date, reloj, red, almacenamiento ni estado global (AST real)", () => {
  it("el AST del kernel no contiene ningún nodo ejecutable prohibido", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fileName = join(here, "weekly-strategy-kernel.ts");
    const source = readFileSync(fileName, "utf-8");
    expect(findForbiddenRuntimeReferences(source, fileName)).toEqual([]);
  });
});

describe("confirmación estructural — apps/web no importa weekly-strategy-kernel", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const webSrcPath = join(repoRoot, "apps", "web", "src");

  function walkSourceFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walkSourceFiles(fullPath));
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(fullPath);
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

describe("determinismo", () => {
  it("misma entrada -> misma salida, profundamente idéntica", () => {
    const input = baseInput();
    const a = planWeeklyStrategy(input);
    const b = planWeeklyStrategy(JSON.parse(JSON.stringify(input)));
    expect(a).toEqual(b);
  });
});
