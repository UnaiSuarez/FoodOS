import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import type {
  AdaptiveProposalApplicationCandidate,
  AdaptiveProposalApplicationInput,
  AdaptiveProposalApplicationResult,
  DayLabel,
  UserPriorityLevel,
  WeeklyStrategyGoalInput,
  WeeklyStrategyInput,
} from "@foodos/types";
import { evaluateAdaptiveProposalApplication } from "./adaptive-proposal-application-kernel";
import * as engineBarrel from "./index";

// ─── Fixtures — independientes del kernel ──────────────────────────────

function consecutiveDateKeys(y: number, m: number, d: number, count = 7): string[] {
  const start = Date.UTC(y, m - 1, d);
  const keys: string[] = [];
  for (let i = 0; i < count; i++) keys.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  return keys;
}
const WEEK1 = consecutiveDateKeys(2026, 9, 21, 7);
function week(labels: readonly DayLabel[]): { dateKey: string; label: DayLabel }[] {
  return WEEK1.map((dateKey, i) => ({ dateKey, label: labels[i] }));
}
function priorityGoal(priority: UserPriorityLevel): WeeklyStrategyGoalInput {
  return { goalIntent: "priority_driven", priority };
}
const MAINTAIN_GOAL: WeeklyStrategyGoalInput = { goalIntent: "maintain" };

/** Perfil real ya verificado en la fase del canal de PR3: fat_loss_lean,
    78kg/178cm/tdee2901, 4 fuerza + 3 descanso. baseWeeklyKcal=16999.86,
    roundedWeeklyKcalTarget=17000 sin ajuste. */
function fatLossLeanInput(overrides: Partial<WeeklyStrategyInput> = {}): WeeklyStrategyInput {
  return {
    weightKg: 78,
    heightCm: 178,
    tdeeKcal: 2901,
    goal: priorityGoal("fat_loss_lean"),
    days: week(["strength", "strength", "strength", "strength", "rest", "rest", "rest"]),
    ...overrides,
  };
}

function proposal(overrides: Partial<AdaptiveProposalApplicationCandidate["basis"]> & { deltaKcalPerDay?: -100 | 100 } = {}): AdaptiveProposalApplicationCandidate {
  const { deltaKcalPerDay = 100, ...basisOverrides } = overrides;
  return {
    status: "adjustment_proposal",
    deltaKcalPerDay,
    basis: {
      strategyObjective: "fat_loss",
      strategyPriority: "fat_loss_lean",
      weeklyKcalTargetInForce: 17000,
      targetVersionId: "tv-1",
      strategyVersionId: "sv-1",
      ...basisOverrides,
    },
  };
}

function baseApplicationInput(overrides: Partial<AdaptiveProposalApplicationInput> = {}): AdaptiveProposalApplicationInput {
  return {
    proposal: proposal(),
    currentTargetVersionId: "tv-1",
    currentStrategyVersionId: "sv-1",
    currentStrategyInput: fatLossLeanInput(),
    ...overrides,
  };
}

function expectApplicable(result: AdaptiveProposalApplicationResult) {
  if (result.status !== "applicable") throw new Error(`esperado applicable, recibido ${JSON.stringify(result)}`);
  return result;
}

// ─── Guardas runtime completas — nunca lanza ───────────────────────────

describe("guarda total sobre `input` — nunca lanza, sin importar qué llegue", () => {
  const malformed: Array<{ label: string; value: unknown }> = [
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "string", value: "applicable" },
    { label: "número", value: 42 },
    { label: "array", value: [1, 2, 3] },
  ];
  for (const { label, value } of malformed) {
    it(`${label} -> invalid_input/input_object_invalid, nunca lanza`, () => {
      const input = value as unknown as AdaptiveProposalApplicationInput;
      expect(() => evaluateAdaptiveProposalApplication(input)).not.toThrow();
      expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["input_object_invalid"] });
    });
  }

  it("objeto vacío -> invalid_input con proposal_malformed y current_identity_malformed a la vez, orden canónico", () => {
    const result = evaluateAdaptiveProposalApplication({} as unknown as AdaptiveProposalApplicationInput);
    expect(result).toEqual({ status: "invalid_input", reasons: ["proposal_malformed", "current_identity_malformed"] });
  });

  it("nunca lanza para una combinación amplia de valores estructuralmente inválidos", () => {
    const garbage: unknown[] = [null, undefined, 0, "x", [], {}, { proposal: "bogus" }, { proposal: null, currentTargetVersionId: 5 }];
    for (const g of garbage) {
      expect(() => evaluateAdaptiveProposalApplication(g as unknown as AdaptiveProposalApplicationInput)).not.toThrow();
    }
  });
});

// ─── Corrupción de cada campo del subconjunto mínimo de la propuesta ───

describe("proposal_malformed — cada campo del subconjunto mínimo, aislado", () => {
  it("status distinto de 'adjustment_proposal'", () => {
    const input = baseApplicationInput({ proposal: { ...proposal(), status: "keep_targets" } as unknown as AdaptiveProposalApplicationCandidate });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });

  it("deltaKcalPerDay fuera de {-100,100}", () => {
    const input = baseApplicationInput({ proposal: { ...proposal(), deltaKcalPerDay: 50 } as unknown as AdaptiveProposalApplicationCandidate });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });

  it("basis ausente / no es un objeto", () => {
    const input = baseApplicationInput({ proposal: { status: "adjustment_proposal", deltaKcalPerDay: 100 } as unknown as AdaptiveProposalApplicationCandidate });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });

  it("basis.strategyObjective desconocido", () => {
    const input = baseApplicationInput({ proposal: proposal({ strategyObjective: "bogus" as unknown as AdaptiveProposalApplicationCandidate["basis"]["strategyObjective"] }) });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });

  it("basis.strategyPriority incoherente con strategyObjective (maintain con prioridad no nula)", () => {
    const input = baseApplicationInput({
      proposal: proposal({ strategyObjective: "maintain", strategyPriority: "fat_loss_max" }),
    });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });

  it("basis.strategyPriority incoherente con strategyObjective (no-maintain con prioridad nula)", () => {
    const input = baseApplicationInput({ proposal: proposal({ strategyPriority: null }) });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });

  it("basis.weeklyKcalTargetInForce no entero seguro", () => {
    const input = baseApplicationInput({ proposal: proposal({ weeklyKcalTargetInForce: 17000.5 }) });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });

  it("basis.weeklyKcalTargetInForce no positivo", () => {
    const input = baseApplicationInput({ proposal: proposal({ weeklyKcalTargetInForce: 0 }) });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });

  it("basis.targetVersionId vacío", () => {
    const input = baseApplicationInput({ proposal: proposal({ targetVersionId: "" }) });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });

  it("basis.strategyVersionId vacío", () => {
    const input = baseApplicationInput({ proposal: proposal({ strategyVersionId: "" }) });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["proposal_malformed"] });
  });
});

describe("current_identity_malformed — tokens actuales", () => {
  it("currentTargetVersionId vacío", () => {
    const input = baseApplicationInput({ currentTargetVersionId: "" });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["current_identity_malformed"] });
  });
  it("currentStrategyVersionId no es string", () => {
    const input = baseApplicationInput({ currentStrategyVersionId: 5 as unknown as string });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["current_identity_malformed"] });
  });
  it("ambos tokens actuales malformados a la vez -> una sola razón (no se duplica)", () => {
    const input = baseApplicationInput({ currentTargetVersionId: "", currentStrategyVersionId: "" });
    expect(evaluateAdaptiveProposalApplication(input)).toEqual({ status: "invalid_input", reasons: ["current_identity_malformed"] });
  });
});

// ─── Copia canónica — sin campos extra, inmutable ──────────────────────

describe("copia canónica de la propuesta — sin campos extra, no muta el original", () => {
  it("una propuesta completa de PR5B (con evidence/context/policy reales) es aceptada, pero el resultado solo transporta el subconjunto mínimo", () => {
    const fullPr5bProposal = {
      status: "adjustment_proposal" as const,
      rateBandPosition: "above_band" as const,
      classifiedRatePctPerWeek: -0.2,
      desiredBandPctPerWeek: { minPct: -1.0, maxPct: -0.5 },
      deltaKcalPerDay: 100 as const,
      deltaKcalPerWeek: 700 as const,
      currentWeeklyKcalTarget: 17000,
      proposedWeeklyKcalTarget: 17700,
      currentDailyAverageKcal: 2428.57,
      proposedDailyAverageKcal: 2528.57,
      confidence: "moderate" as const,
      evidence: { weight: { status: "invalid_input" as const }, intake: { status: "invalid_input" as const } },
      context: { calibrationBaselineDateKey: null, performance: { status: "not_provided" as const, influenceOnDecision: "none" as const } },
      policy: "un-objeto-cualquiera-no-se-valida-aqui" as unknown as never,
      basis: {
        policyVersion: "adaptive-coordinator-v1" as const,
        referenceDateKey: "2026-09-21",
        targetVersionId: "tv-1",
        weeklyKcalTargetInForce: 17000,
        strategyObjective: "fat_loss" as const,
        strategyPriority: "fat_loss_lean" as const,
        strategyVersionId: "sv-1",
        calibrationBaselineDateKey: null,
        lastResolvedOnDateKey: null,
        pendingProposalIdObserved: null,
      },
      requiresNutritionReplan: true as const,
      requiresExplicitUserAcceptance: true as const,
    };
    const snapshot = JSON.parse(JSON.stringify(fullPr5bProposal));
    const input = baseApplicationInput({ proposal: fullPr5bProposal });
    const result = expectApplicable(evaluateAdaptiveProposalApplication(input));
    expect(result.proposal).toEqual({
      status: "adjustment_proposal",
      deltaKcalPerDay: 100,
      basis: {
        strategyObjective: "fat_loss",
        strategyPriority: "fat_loss_lean",
        weeklyKcalTargetInForce: 17000,
        targetVersionId: "tv-1",
        strategyVersionId: "sv-1",
      },
    });
    // Ningún campo extra (evidence/context/policy/confidence/...) se filtró:
    expect(Object.keys(result.proposal)).toEqual(["status", "deltaKcalPerDay", "basis"]);
    expect(Object.keys(result.proposal.basis)).toEqual([
      "strategyObjective",
      "strategyPriority",
      "weeklyKcalTargetInForce",
      "targetVersionId",
      "strategyVersionId",
    ]);
    // El objeto original nunca se muta:
    expect(fullPr5bProposal).toEqual(snapshot);
  });

  it("el input completo (proposal + currentStrategyInput) permanece intacto tras la llamada", () => {
    const input = baseApplicationInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    evaluateAdaptiveProposalApplication(input);
    expect(input).toEqual(snapshot);
  });
});

// ─── current_strategy_unavailable ───────────────────────────────────────

describe("current_strategy_unavailable — el perfil actual, sin la propuesta, ya no es ok", () => {
  it("tdeeKcal inválido en currentStrategyInput -> propaga el WeeklyStrategyResult real (invalid_input)", () => {
    const input = baseApplicationInput({ currentStrategyInput: fatLossLeanInput({ tdeeKcal: -100 }) });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "current_strategy_unavailable") throw new Error(`esperado current_strategy_unavailable, recibido ${JSON.stringify(result)}`);
    expect(result.currentStrategyResult).toEqual({ status: "invalid_input", reasons: ["tdee_invalid"] });
    expect(result.currentIdentity).toEqual({ targetVersionId: "tv-1", strategyVersionId: "sv-1" });
    expect(result.proposal.deltaKcalPerDay).toBe(100);
  });

  it("perfil marginal ya en specialist_review_required (sin ajuste) -> current_strategy_unavailable, nunca candidate_not_applicable", () => {
    const marginalInput: WeeklyStrategyInput = {
      weightKg: 50, heightCm: 155, age: 60, sex: "female", tdeeKcal: 1210,
      goal: priorityGoal("fat_loss_max"), days: week(["rest", "rest", "rest", "rest", "rest", "rest", "rest"]),
      currentAverageDailyEnergyAdjustmentKcal: -100,
    };
    const input = baseApplicationInput({
      currentStrategyInput: marginalInput,
      proposal: proposal({ strategyObjective: "fat_loss", strategyPriority: "fat_loss_max", weeklyKcalTargetInForce: 8036 }),
    });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "current_strategy_unavailable") throw new Error(`esperado current_strategy_unavailable, recibido ${JSON.stringify(result)}`);
    expect(result.currentStrategyResult.status).toBe("specialist_review_required");
  });
});

// ─── stale_proposal — fase 3 (tokens) ──────────────────────────────────

describe("stale_proposal — fase 3, divergencia de tokens (primaria, aislada y conjunta)", () => {
  it("solo targetVersionId diverge", () => {
    const input = baseApplicationInput({ currentTargetVersionId: "tv-2" });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "stale_proposal") throw new Error(`esperado stale_proposal, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["target_version_id_mismatch"]);
    expect(result.currentIdentity).toEqual({ targetVersionId: "tv-2", strategyVersionId: "sv-1" });
    expect(result.currentStrategy.status).toBe("ok");
  });

  it("solo strategyVersionId diverge", () => {
    const input = baseApplicationInput({ currentStrategyVersionId: "sv-2" });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "stale_proposal") throw new Error(`esperado stale_proposal, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["strategy_version_id_mismatch"]);
  });

  it("ambos tokens divergen a la vez -> ambas razones, orden canónico", () => {
    const input = baseApplicationInput({ currentTargetVersionId: "tv-2", currentStrategyVersionId: "sv-2" });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "stale_proposal") throw new Error(`esperado stale_proposal, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["target_version_id_mismatch", "strategy_version_id_mismatch"]);
  });

  it("tokens divergen Y la estructura también divergiría -> gana SOLO la razón de tokens (fase 4 nunca se evalúa)", () => {
    const input = baseApplicationInput({
      currentTargetVersionId: "tv-2",
      proposal: proposal({ strategyObjective: "maintain", strategyPriority: null, weeklyKcalTargetInForce: 999 }),
    });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "stale_proposal") throw new Error(`esperado stale_proposal, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["target_version_id_mismatch"]);
    expect(result.reasons).not.toContain("current_objective_changed");
  });
});

// ─── stale_proposal — fase 4 (estructura) ──────────────────────────────

describe("stale_proposal — fase 4, divergencia estructural (defensa adicional, solo si los tokens ya coincidieron)", () => {
  it("objective divergente, priority intacta (basis dice muscle_gain con la MISMA prioridad fat_loss_lean del perfil actual)", () => {
    // Aísla la divergencia de objective: strategyPriority se deja igual
    // que la del perfil actual ("fat_loss_lean") para que
    // current_priority_changed no dispare a la vez.
    const input = baseApplicationInput({ proposal: proposal({ strategyObjective: "muscle_gain" }) });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "stale_proposal") throw new Error(`esperado stale_proposal, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["current_objective_changed"]);
  });

  it("priority divergente (mismo objective, distinta prioridad)", () => {
    const input = baseApplicationInput({ proposal: proposal({ strategyPriority: "fat_loss_max" }) });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "stale_proposal") throw new Error(`esperado stale_proposal, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["current_priority_changed"]);
  });

  it("weeklyKcalTargetInForce divergente (perfil real cambió desde que se generó la propuesta)", () => {
    const input = baseApplicationInput({ proposal: proposal({ weeklyKcalTargetInForce: 15000 }) });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "stale_proposal") throw new Error(`esperado stale_proposal, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["current_weekly_target_changed"]);
  });

  it("las tres divergencias estructurales a la vez -> las tres razones, orden canónico", () => {
    const input = baseApplicationInput({ proposal: proposal({ strategyObjective: "maintain", strategyPriority: null, weeklyKcalTargetInForce: 1 }) });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "stale_proposal") throw new Error(`esperado stale_proposal, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["current_objective_changed", "current_priority_changed", "current_weekly_target_changed"]);
  });
});

// ─── Precedencia entre estrategia no disponible, tokens y estructura ───

describe("precedencia — estrategia actual no disponible > tokens > estructura", () => {
  it("estrategia actual no ok Y tokens divergen -> gana current_strategy_unavailable", () => {
    const input = baseApplicationInput({ currentStrategyInput: fatLossLeanInput({ tdeeKcal: -100 }), currentTargetVersionId: "tv-2" });
    const result = evaluateAdaptiveProposalApplication(input);
    expect(result.status).toBe("current_strategy_unavailable");
  });

  it("estrategia actual ok, tokens coinciden, estructura diverge -> gana stale_proposal (fase 4)", () => {
    const input = baseApplicationInput({ proposal: proposal({ strategyPriority: "fat_loss_max" }) });
    const result = evaluateAdaptiveProposalApplication(input);
    expect(result.status).toBe("stale_proposal");
  });
});

// ─── candidate_not_applicable — fixtures reales ────────────────────────

describe("candidate_not_applicable — fixtures reales (delta real de PR5B, basis coincide con el estado actual)", () => {
  it("ok -> specialist_review_required (fat_loss_max, tdee=1560, 70kg/165cm, 7×rest, δ=-100)", () => {
    const currentStrategyInput: WeeklyStrategyInput = {
      weightKg: 70, heightCm: 165, tdeeKcal: 1560, goal: priorityGoal("fat_loss_max"),
      days: week(["rest", "rest", "rest", "rest", "rest", "rest", "rest"]),
    };
    const input = baseApplicationInput({
      currentStrategyInput,
      proposal: proposal({ deltaKcalPerDay: -100, strategyObjective: "fat_loss", strategyPriority: "fat_loss_max", weeklyKcalTargetInForce: 8736 }),
    });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "candidate_not_applicable") throw new Error(`esperado candidate_not_applicable, recibido ${JSON.stringify(result)}`);
    expect(result.previousStrategy.audit.roundedWeeklyKcalTarget).toBe(8736);
    expect(result.nextAverageDailyEnergyAdjustmentKcal).toBe(-100);
    if (result.candidateStrategyResult.status !== "specialist_review_required") {
      throw new Error(`esperado specialist_review_required, recibido ${JSON.stringify(result.candidateStrategyResult)}`);
    }
    expect(result.candidateStrategyResult.audit).toEqual({
      minKcalDetected: 1148,
      maxKcalDetected: 1148,
      reasons: ["low_energy_diet_day_present"],
    });
  });

  it("ok -> invalid_input por contradicción real de energyRestrictionStatus (maintain, tdee=2901, override not_restricted, δ=-100)", () => {
    const currentStrategyInput: WeeklyStrategyInput = {
      weightKg: 78, heightCm: 178, tdeeKcal: 2901, goal: MAINTAIN_GOAL,
      days: week(["strength", "strength", "strength", "strength", "rest", "rest", "rest"]),
      energyRestrictionStatus: "not_restricted",
    };
    const input = baseApplicationInput({
      currentStrategyInput,
      proposal: proposal({ deltaKcalPerDay: -100, strategyObjective: "maintain", strategyPriority: null, weeklyKcalTargetInForce: 20307 }),
    });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "candidate_not_applicable") throw new Error(`esperado candidate_not_applicable, recibido ${JSON.stringify(result)}`);
    expect(result.previousStrategy.audit.roundedWeeklyKcalTarget).toBe(20307);
    expect(result.candidateStrategyResult).toEqual({
      status: "invalid_input",
      reasons: ["energy_restriction_override_contradicts_computed_deficit"],
    });
  });
});

// ─── applicable ─────────────────────────────────────────────────────────

describe("applicable — calculada, nunca aplicada ni persistida (literales ya verificados en la fase del canal de PR3)", () => {
  it("+100 kcal/día -> candidata con total +700 semanal exacto, reparto real no uniforme", () => {
    const result = expectApplicable(evaluateAdaptiveProposalApplication(baseApplicationInput()));
    expect(result.previousStrategy.audit.roundedWeeklyKcalTarget).toBe(17000);
    expect(result.nextAverageDailyEnergyAdjustmentKcal).toBe(100);
    expect(result.candidateStrategy.audit.roundedWeeklyKcalTarget).toBe(17700);
    expect(result.candidateStrategy.weeklyPlan.days.map((d) => d.distributedKcalTarget)).toEqual([
      2568, 2567, 2567, 2567, 2477, 2477, 2477,
    ]);
    expect(result.currentIdentity).toEqual({ targetVersionId: "tv-1", strategyVersionId: "sv-1" });
    expect(result.proposal).toEqual(proposal());
  });

  it("-100 kcal/día -> candidata con total -700 semanal exacto", () => {
    const input = baseApplicationInput({ proposal: proposal({ deltaKcalPerDay: -100 }) });
    const result = expectApplicable(evaluateAdaptiveProposalApplication(input));
    expect(result.nextAverageDailyEnergyAdjustmentKcal).toBe(-100);
    expect(result.candidateStrategy.audit.roundedWeeklyKcalTarget).toBe(16300);
  });

  it("ausencia de currentAverageDailyEnergyAdjustmentKcal se trata como 0 -> nextAdjustment es exactamente el delta", () => {
    const input = baseApplicationInput({ currentStrategyInput: fatLossLeanInput() });
    const result = expectApplicable(evaluateAdaptiveProposalApplication(input));
    expect(result.nextAverageDailyEnergyAdjustmentKcal).toBe(100);
  });
});

// ─── Acumulación — dos rondas con propuestas y tokens regenerados ──────

describe("acumulación — dos rondas reales, cada propuesta generada contra el estado posterior a la anterior", () => {
  it("ronda 1 (0->100) aplicable, ronda 2 (100->200) generada contra el estado post-ronda-1, también aplicable", () => {
    // Ronda 1: ajuste vigente=0, tokens "tv-1"/"sv-1".
    const round1Input = baseApplicationInput();
    const round1 = expectApplicable(evaluateAdaptiveProposalApplication(round1Input));
    expect(round1.nextAverageDailyEnergyAdjustmentKcal).toBe(100);
    expect(round1.candidateStrategy.audit.roundedWeeklyKcalTarget).toBe(17700);

    // La integración (fuera de este kernel) persiste adjustment=100 y
    // REGENERA los tokens: "tv-2"/"sv-2".
    const round2CurrentInput = fatLossLeanInput({ currentAverageDailyEnergyAdjustmentKcal: 100 });
    const round2Proposal = proposal({ deltaKcalPerDay: 100, weeklyKcalTargetInForce: 17700, targetVersionId: "tv-2", strategyVersionId: "sv-2" });
    const round2Input = baseApplicationInput({
      proposal: round2Proposal,
      currentTargetVersionId: "tv-2",
      currentStrategyVersionId: "sv-2",
      currentStrategyInput: round2CurrentInput,
    });
    const round2 = expectApplicable(evaluateAdaptiveProposalApplication(round2Input));
    expect(round2.previousStrategy.audit.roundedWeeklyKcalTarget).toBe(17700);
    expect(round2.nextAverageDailyEnergyAdjustmentKcal).toBe(200);
    expect(round2.candidateStrategy.audit.roundedWeeklyKcalTarget).toBe(18400);
  });

  it("reutilizar la propuesta de la ronda 1 DESPUÉS de que la ronda 1 ya se aplicó -> stale_proposal por divergencia de AMBOS tokens", () => {
    const round1Proposal = proposal(); // basis con "tv-1"/"sv-1", weeklyKcalTargetInForce=17000
    // El estado real ya avanzó: adjustment=100, tokens regenerados a "tv-2"/"sv-2".
    const staleInput = baseApplicationInput({
      proposal: round1Proposal,
      currentTargetVersionId: "tv-2",
      currentStrategyVersionId: "sv-2",
      currentStrategyInput: fatLossLeanInput({ currentAverageDailyEnergyAdjustmentKcal: 100 }),
    });
    const result = evaluateAdaptiveProposalApplication(staleInput);
    if (result.status !== "stale_proposal") throw new Error(`esperado stale_proposal, recibido ${JSON.stringify(result)}`);
    expect(result.reasons).toEqual(["target_version_id_mismatch", "strategy_version_id_mismatch"]);
  });
});

// ─── Identidad actual en los cuatro estados posteriores a la validación ─

describe("currentIdentity — presente y correcta en los cuatro estados posteriores a la fase 1", () => {
  it("current_strategy_unavailable la incluye", () => {
    const input = baseApplicationInput({ currentStrategyInput: fatLossLeanInput({ tdeeKcal: -100 }), currentTargetVersionId: "tv-x", currentStrategyVersionId: "sv-x" });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "current_strategy_unavailable") throw new Error("esperado current_strategy_unavailable");
    expect(result.currentIdentity).toEqual({ targetVersionId: "tv-x", strategyVersionId: "sv-x" });
  });
  it("stale_proposal la incluye", () => {
    const input = baseApplicationInput({ currentTargetVersionId: "tv-x" });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "stale_proposal") throw new Error("esperado stale_proposal");
    expect(result.currentIdentity).toEqual({ targetVersionId: "tv-x", strategyVersionId: "sv-1" });
  });
  it("candidate_not_applicable la incluye", () => {
    const currentStrategyInput: WeeklyStrategyInput = {
      weightKg: 78, heightCm: 178, tdeeKcal: 2901, goal: MAINTAIN_GOAL,
      days: week(["strength", "strength", "strength", "strength", "rest", "rest", "rest"]),
      energyRestrictionStatus: "not_restricted",
    };
    const input = baseApplicationInput({
      currentStrategyInput,
      currentTargetVersionId: "tv-y",
      currentStrategyVersionId: "sv-y",
      proposal: proposal({ deltaKcalPerDay: -100, strategyObjective: "maintain", strategyPriority: null, weeklyKcalTargetInForce: 20307, targetVersionId: "tv-y", strategyVersionId: "sv-y" }),
    });
    const result = evaluateAdaptiveProposalApplication(input);
    if (result.status !== "candidate_not_applicable") throw new Error("esperado candidate_not_applicable");
    expect(result.currentIdentity).toEqual({ targetVersionId: "tv-y", strategyVersionId: "sv-y" });
  });
  it("applicable la incluye", () => {
    const input = baseApplicationInput({ currentTargetVersionId: "tv-z", currentStrategyVersionId: "sv-z", proposal: proposal({ targetVersionId: "tv-z", strategyVersionId: "sv-z" }) });
    const result = expectApplicable(evaluateAdaptiveProposalApplication(input));
    expect(result.currentIdentity).toEqual({ targetVersionId: "tv-z", strategyVersionId: "sv-z" });
  });
});

// ─── Inmutabilidad, determinismo, ausencia de -0 ───────────────────────

describe("inmutabilidad y determinismo", () => {
  it("misma entrada -> misma salida, profundamente idéntica", () => {
    const input = baseApplicationInput();
    const a = evaluateAdaptiveProposalApplication(input);
    const b = evaluateAdaptiveProposalApplication(JSON.parse(JSON.stringify(input)));
    expect(a).toEqual(b);
  });
});

describe("ausencia de -0 en nextAverageDailyEnergyAdjustmentKcal", () => {
  it("ajuste vigente que cancela exactamente el delta (100 + (-100) = 0) nunca produce -0", () => {
    const input = baseApplicationInput({
      currentStrategyInput: fatLossLeanInput({ currentAverageDailyEnergyAdjustmentKcal: 100 }),
      proposal: proposal({ deltaKcalPerDay: -100, weeklyKcalTargetInForce: 17700 }),
    });
    const result = expectApplicable(evaluateAdaptiveProposalApplication(input));
    expect(result.nextAverageDailyEnergyAdjustmentKcal).toBe(0);
    expect(Object.is(result.nextAverageDailyEnergyAdjustmentKcal, -0)).toBe(false);
  });

  it("ajuste vigente = -0 literal + delta -> nunca -0 (el delta, siempre != 0, domina la suma)", () => {
    const input = baseApplicationInput({ currentStrategyInput: fatLossLeanInput({ currentAverageDailyEnergyAdjustmentKcal: -0 }) });
    const result = expectApplicable(evaluateAdaptiveProposalApplication(input));
    expect(result.nextAverageDailyEnergyAdjustmentKcal).toBe(100);
    expect(Object.is(result.nextAverageDailyEnergyAdjustmentKcal, -0)).toBe(false);
  });
});

// ─── API pública del barrel ─────────────────────────────────────────

describe("API público del barrel — packages/engine/src/index.ts", () => {
  it("expone evaluateAdaptiveProposalApplication y ninguno de los helpers internos", () => {
    const barrel = engineBarrel as Record<string, unknown>;
    expect(typeof barrel.evaluateAdaptiveProposalApplication).toBe("function");
    const forbiddenNames = [
      "isPlainRecord",
      "isNonEmptyString",
      "canonicalizeInvalidReasons",
      "canonicalizeStalenessReasons",
      "invalidInput",
      "validateProposal",
    ];
    for (const name of forbiddenNames) expect(barrel[name]).toBeUndefined();
  });

  it("evaluateAdaptiveProposalApplication importado desde el barrel se comporta igual que el import directo", () => {
    const input = baseApplicationInput();
    expect(engineBarrel.evaluateAdaptiveProposalApplication(input)).toEqual(evaluateAdaptiveProposalApplication(input));
  });
});

// ─── Pureza (AST real) — sin Date/reloj/red/almacenamiento/estado global,
// e imports exclusivos a @foodos/types y weekly-strategy-kernel ─────────

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

describe("pureza — sin Date/reloj/red/almacenamiento/estado global (AST real), e imports exclusivos", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fileName = join(here, "adaptive-proposal-application-kernel.ts");
  const source = readFileSync(fileName, "utf-8");

  it("el AST no contiene ningún nodo ejecutable prohibido", () => {
    expect(findForbiddenRuntimeReferences(source, fileName)).toEqual([]);
  });

  it("los únicos imports son ./weekly-strategy-kernel (PR3) y tipos de @foodos/types — nunca planWeek/allocateDailyMacros/evaluateAdaptiveReview directamente, ni nada de apps/web", () => {
    const specifiers = collectImportModuleSpecifiers(source, fileName);
    expect(new Set(specifiers)).toEqual(new Set(["./weekly-strategy-kernel", "@foodos/types"]));
  });
});

// ─── Confirmación estructural — apps/web no importa este kernel ────────

describe("confirmación estructural — apps/web no importa adaptive-proposal-application-kernel ni @foodos/engine", () => {
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
