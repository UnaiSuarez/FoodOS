import { planWeeklyStrategy } from "./weekly-strategy-kernel";
import type {
  AdaptiveProposalApplicable,
  AdaptiveProposalApplicationCandidate,
  AdaptiveProposalApplicationInput,
  AdaptiveProposalApplicationInvalidInput,
  AdaptiveProposalApplicationInvalidReason,
  AdaptiveProposalApplicationResult,
  AdaptiveProposalCandidateNotApplicable,
  AdaptiveProposalCurrentStrategyUnavailable,
  AdaptiveProposalStale,
  AdaptiveProposalStalenessReason,
  NonEmptyAdaptiveProposalApplicationInvalidReasons,
  NonEmptyAdaptiveProposalStalenessReasons,
  UserPriorityLevel,
  ValidatedCurrentAdaptiveIdentity,
  WeeklyStrategyObjective,
  WeeklyStrategyOk,
  WeeklyStrategyResult,
} from "@foodos/types";

/*
 * Nutrition Engine v4 — verificación pura de aplicabilidad de propuestas
 * adaptativas. Paso 3 de la secuencia cerrada del roadmap. Ver el
 * comentario de cabecera de adaptive-proposal-application.ts para el
 * contrato completo y docs/NUTRITION_V4_EXERCISE_V2_ROADMAP.md, "Alcance
 * de la verificación de aplicabilidad de propuestas", para el diseño
 * cerrado.
 *
 * Dependencia real, deliberada: EXCLUSIVAMENTE planWeeklyStrategy
 * (weekly-strategy-kernel.ts, PR3) — nunca planWeek/allocateDailyMacros
 * directamente (PR3 ya los usa; este kernel nunca duplica su
 * aritmética), nunca evaluateAdaptiveReview (PR5B decide SI hace falta
 * un ajuste; este kernel decide si uno YA propuesto sigue siendo
 * aplicable).
 *
 * Precedencia (orden estricto):
 * 1) Fase 1 — validación estructural (wrapper/proposal/tokens actuales)
 *    -> invalid_input. Única categoría, siempre detectada antes de
 *    recalcular nada.
 * 2) Fase 2 — estrategia actual: planWeeklyStrategy(currentStrategyInput).
 *    status !== "ok" -> current_strategy_unavailable.
 * 3) Fase 3 — divergencia de TOKENS (comparación opaca, primaria) sobre
 *    currentTargetVersionId/currentStrategyVersionId vs. proposal.basis
 *    -> stale_proposal (razones SOLO de esta fase).
 * 4) Fase 4 — divergencia ESTRUCTURAL (defensa adicional, solo si la fase
 *    3 ya pasó limpia) sobre objective/priority/weeklyKcalTargetInForce
 *    ya recalculados -> stale_proposal (razones SOLO de esta fase, nunca
 *    mezcladas con las de la fase 3).
 * 5) Fase 5 — nextAverageDailyEnergyAdjustmentKcal = ajuste vigente +
 *    proposal.deltaKcalPerDay. SIEMPRE entero seguro, sin rama de fallo:
 *    currentRecomputed.status==="ok" (fase 2, ya superada) exige, por la
 *    propia guarda de PR3 sobre baseWeeklyKcal redondeado
 *    (weekly-strategy-kernel.ts, Number.isSafeInteger(roundedBaseWeeklyKcal))
 *    y la de PR2B sobre requestedWeeklyKcal redondeado
 *    (weekly-plan-kernel.ts, Number.isSafeInteger(rounded) tras
 *    rawWeeklyKcalTarget > 0), que baseWeeklyKcal y
 *    baseWeeklyKcal + 7·X queden ambos por debajo de,
 *    aproximadamente, MAX_SAFE_INTEGER + 0.5 (el margen exacto de
 *    Math.round para un entero seguro). De ahí:
 *      7·X < (MAX_SAFE_INTEGER + 0.5) - baseWeeklyKcal < MAX_SAFE_INTEGER
 *      ⟹ X < MAX_SAFE_INTEGER / 7 ≈ 1 286 742 750 677 284
 *    con un margen simétrico por debajo de cero. El propio X (el ajuste
 *    vigente en currentStrategyInput, cuando está presente) ya está
 *    validado como Number.isSafeInteger por la fase 2 de PR3
 *    (weekly-strategy-kernel.ts, comprobación de
 *    currentAverageDailyEnergyAdjustmentKcal) — pero la cota relevante
 *    aquí es la más estricta que impone "ok", muy por debajo de esa
 *    validación de entrada. La distancia resultante hasta
 *    MAX_SAFE_INTEGER (≈7,72×10^15) es catorce órdenes de magnitud mayor
 *    que los ±100 de deltaKcalPerDay — verificado además con un barrido
 *    real contra el kernel cubriendo tdeeKcal extremo (hasta el propio
 *    Number.MAX_SAFE_INTEGER/MAX_VALUE, que ya son rechazados como
 *    "tdee_invalid" antes de llegar a "ok"), las cinco tablas de
 *    factores cerradas (incluida muscle_gain_max banda A, factor 1.1, el
 *    mayor de todas), y una cancelación numérica deliberada entre
 *    baseWeeklyKcal y 7·X. Nunca se encontró ni un solo caso por debajo
 *    de 7×10^15 de margen. Por eso este kernel NUNCA produce un
 *    derived_numeric_result_invalid: sería una rama demostrablemente
 *    inalcanzable, no una defensa real.
 * 6) Fase 6 — candidata: planWeeklyStrategy con
 *    nextAverageDailyEnergyAdjustmentKcal. status !== "ok" ->
 *    candidate_not_applicable.
 * 7) Fase 7 -> applicable (calculada, nunca aplicada ni persistida).
 *
 * Frontera explícita (no resuelta ni fingida por este kernel puro): que
 * currentStrategyInput/currentTargetVersionId/currentStrategyVersionId
 * reflejen de verdad el estado más reciente entre dispositivos/sesiones,
 * y que una misma propuesta no se aplique dos veces ante aceptaciones
 * concurrentes — ambas exigen lectura fresca y consumo atómico/idempotente
 * en la capa de integración, nunca en una función pura.
 */

// ─── Utilidades genéricas ────────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const KNOWN_OBJECTIVES: ReadonlySet<string> = new Set<WeeklyStrategyObjective>([
  "fat_loss",
  "recomp",
  "muscle_gain",
  "maintain",
]);
const KNOWN_PRIORITIES: ReadonlySet<string> = new Set<UserPriorityLevel>([
  "fat_loss_max",
  "fat_loss_lean",
  "balanced",
  "muscle_gain_lean",
  "muscle_gain_max",
]);

const INVALID_REASON_ORDER: readonly AdaptiveProposalApplicationInvalidReason[] = [
  "input_object_invalid",
  "proposal_malformed",
  "current_identity_malformed",
];
const STALENESS_REASON_ORDER: readonly AdaptiveProposalStalenessReason[] = [
  "target_version_id_mismatch",
  "strategy_version_id_mismatch",
  "current_objective_changed",
  "current_priority_changed",
  "current_weekly_target_changed",
];

function canonicalizeInvalidReasons(
  reasons: readonly AdaptiveProposalApplicationInvalidReason[],
): NonEmptyAdaptiveProposalApplicationInvalidReasons {
  const present = new Set(reasons);
  return INVALID_REASON_ORDER.filter((r) => present.has(r)) as NonEmptyAdaptiveProposalApplicationInvalidReasons;
}

function canonicalizeStalenessReasons(
  reasons: readonly AdaptiveProposalStalenessReason[],
): NonEmptyAdaptiveProposalStalenessReasons {
  const present = new Set(reasons);
  return STALENESS_REASON_ORDER.filter((r) => present.has(r)) as NonEmptyAdaptiveProposalStalenessReasons;
}

function invalidInput(reasons: AdaptiveProposalApplicationInvalidReason[]): AdaptiveProposalApplicationInvalidInput {
  return { status: "invalid_input", reasons: canonicalizeInvalidReasons(reasons) };
}

// ─── Validación de la propuesta — subconjunto mínimo, copia canónica ───
// Nunca se transporta la referencia original ni un superconjunto sin
// validar: se reconstruye campo a campo tras comprobar cada uno.

type ProposalOutcome = { kind: "invalid" } | { kind: "ok"; proposal: AdaptiveProposalApplicationCandidate };

function validateProposal(raw: unknown): ProposalOutcome {
  if (!isPlainRecord(raw)) return { kind: "invalid" };
  if (raw.status !== "adjustment_proposal") return { kind: "invalid" };
  const delta = raw.deltaKcalPerDay;
  if (delta !== -100 && delta !== 100) return { kind: "invalid" };
  const rawBasis = raw.basis;
  if (!isPlainRecord(rawBasis)) return { kind: "invalid" };
  const { strategyObjective, strategyPriority, weeklyKcalTargetInForce, targetVersionId, strategyVersionId } = rawBasis;
  if (typeof strategyObjective !== "string" || !KNOWN_OBJECTIVES.has(strategyObjective)) return { kind: "invalid" };
  if (strategyPriority !== null && (typeof strategyPriority !== "string" || !KNOWN_PRIORITIES.has(strategyPriority))) {
    return { kind: "invalid" };
  }
  // Misma coherencia miembro-de-unión que ya exige classifyStrategy de
  // PR5B: "maintain" nunca lleva prioridad, y viceversa.
  if ((strategyObjective === "maintain") !== (strategyPriority === null)) return { kind: "invalid" };
  if (
    typeof weeklyKcalTargetInForce !== "number" ||
    !Number.isSafeInteger(weeklyKcalTargetInForce) ||
    weeklyKcalTargetInForce <= 0
  ) {
    return { kind: "invalid" };
  }
  if (!isNonEmptyString(targetVersionId) || !isNonEmptyString(strategyVersionId)) return { kind: "invalid" };
  return {
    kind: "ok",
    proposal: {
      status: "adjustment_proposal",
      deltaKcalPerDay: delta,
      basis: {
        strategyObjective: strategyObjective as WeeklyStrategyObjective,
        strategyPriority: strategyPriority as UserPriorityLevel | null,
        weeklyKcalTargetInForce,
        targetVersionId,
        strategyVersionId,
      },
    },
  };
}

// ─── Punto de entrada ───────────────────────────────────────────────

/** Punto de entrada del kernel de aplicabilidad. Ver
    adaptive-proposal-application.ts para el contrato completo.
    Validación runtime COMPLETA sobre `input` tratado como `unknown` —
    igual disciplina que planWeeklyStrategy/evaluateAdaptiveReview. */
export function evaluateAdaptiveProposalApplication(
  input: AdaptiveProposalApplicationInput,
): AdaptiveProposalApplicationResult {
  const raw: unknown = input;
  if (!isPlainRecord(raw)) {
    return invalidInput(["input_object_invalid"]);
  }

  // ─── Fase 1: validación estructural — acumula TODAS las razones antes
  // de decidir (mismo criterio que PR1-PR5B).
  const invalidReasons: AdaptiveProposalApplicationInvalidReason[] = [];

  const proposalOutcome = validateProposal(raw.proposal);
  if (proposalOutcome.kind === "invalid") invalidReasons.push("proposal_malformed");

  const rawCurrentTargetVersionId = raw.currentTargetVersionId;
  const rawCurrentStrategyVersionId = raw.currentStrategyVersionId;
  if (!isNonEmptyString(rawCurrentTargetVersionId) || !isNonEmptyString(rawCurrentStrategyVersionId)) {
    invalidReasons.push("current_identity_malformed");
  }

  if (invalidReasons.length > 0) return invalidInput(invalidReasons);

  // A partir de aquí, garantizados no-inválidos por la comprobación de
  // arriba.
  const proposal = (proposalOutcome as { kind: "ok"; proposal: AdaptiveProposalApplicationCandidate }).proposal;
  const currentTargetVersionId = rawCurrentTargetVersionId as string;
  const currentStrategyVersionId = rawCurrentStrategyVersionId as string;
  const currentIdentity: ValidatedCurrentAdaptiveIdentity = {
    targetVersionId: currentTargetVersionId,
    strategyVersionId: currentStrategyVersionId,
  };

  // currentStrategyInput es responsabilidad exclusiva de
  // planWeeklyStrategy (PR3) — es una función total sobre `unknown`, así
  // que este kernel nunca duplica su validación: cualquier problema
  // termina en current_strategy_unavailable con el WeeklyStrategyResult
  // real, propagado íntegro.
  const currentStrategyInput = input.currentStrategyInput;

  // ─── Fase 2: estrategia actual.
  const currentRecomputed = planWeeklyStrategy(currentStrategyInput);
  if (currentRecomputed.status !== "ok") {
    const result: AdaptiveProposalCurrentStrategyUnavailable = {
      status: "current_strategy_unavailable",
      currentStrategyResult: currentRecomputed as Exclude<WeeklyStrategyResult, WeeklyStrategyOk>,
      proposal,
      currentIdentity,
    };
    return result;
  }

  // ─── Fase 3: divergencia de TOKENS — comparación opaca, primaria.
  const tokenReasons: AdaptiveProposalStalenessReason[] = [];
  if (currentTargetVersionId !== proposal.basis.targetVersionId) tokenReasons.push("target_version_id_mismatch");
  if (currentStrategyVersionId !== proposal.basis.strategyVersionId) tokenReasons.push("strategy_version_id_mismatch");
  if (tokenReasons.length > 0) {
    const result: AdaptiveProposalStale = {
      status: "stale_proposal",
      reasons: canonicalizeStalenessReasons(tokenReasons),
      currentStrategy: currentRecomputed,
      proposal,
      currentIdentity,
    };
    return result;
  }

  // ─── Fase 4: divergencia ESTRUCTURAL — defensa adicional, nunca
  // mezclada con las razones de la fase 3 (solo se alcanza si la fase 3
  // ya pasó limpia).
  const structuralReasons: AdaptiveProposalStalenessReason[] = [];
  if (currentRecomputed.objective !== proposal.basis.strategyObjective) {
    structuralReasons.push("current_objective_changed");
  }
  if (currentRecomputed.priority !== proposal.basis.strategyPriority) {
    structuralReasons.push("current_priority_changed");
  }
  if (currentRecomputed.weeklyPlan.energy.roundedWeeklyKcalTarget !== proposal.basis.weeklyKcalTargetInForce) {
    structuralReasons.push("current_weekly_target_changed");
  }
  if (structuralReasons.length > 0) {
    const result: AdaptiveProposalStale = {
      status: "stale_proposal",
      reasons: canonicalizeStalenessReasons(structuralReasons),
      currentStrategy: currentRecomputed,
      proposal,
      currentIdentity,
    };
    return result;
  }

  // ─── Fase 5: siguiente ajuste — SIEMPRE entero seguro, sin rama de
  // fallo (ver la demostración completa en el comentario de cabecera).
  const nextAverageDailyEnergyAdjustmentKcal =
    (currentStrategyInput.currentAverageDailyEnergyAdjustmentKcal ?? 0) + proposal.deltaKcalPerDay;

  // ─── Fase 6: candidata.
  const candidateStrategy = planWeeklyStrategy({
    ...currentStrategyInput,
    currentAverageDailyEnergyAdjustmentKcal: nextAverageDailyEnergyAdjustmentKcal,
  });
  if (candidateStrategy.status !== "ok") {
    const result: AdaptiveProposalCandidateNotApplicable = {
      status: "candidate_not_applicable",
      previousStrategy: currentRecomputed,
      proposal,
      currentIdentity,
      nextAverageDailyEnergyAdjustmentKcal,
      candidateStrategyResult: candidateStrategy as Exclude<WeeklyStrategyResult, WeeklyStrategyOk>,
    };
    return result;
  }

  // ─── Fase 7: aplicable — calculada, nunca aplicada ni persistida.
  const result: AdaptiveProposalApplicable = {
    status: "applicable",
    previousStrategy: currentRecomputed,
    proposal,
    currentIdentity,
    nextAverageDailyEnergyAdjustmentKcal,
    candidateStrategy,
  };
  return result;
}
