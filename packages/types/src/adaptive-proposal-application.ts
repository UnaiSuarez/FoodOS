// Nutrition Engine v4 — verificación pura de aplicabilidad de propuestas
// adaptativas. Paso 3 de la secuencia cerrada en el roadmap: PR5B
// (evaluateAdaptiveReview) → canal de ajuste energético en PR3
// (currentAverageDailyEnergyAdjustmentKcal) → ESTE PASO → integración con
// persistencia/UI. Ver docs/NUTRITION_V4_EXERCISE_V2_ROADMAP.md, "Alcance
// de la verificación de aplicabilidad de propuestas", para el diseño
// completo: identidad, precedencia por fases, la demostración de por qué
// no existe (ni hace falta) un derived_numeric_result_invalid en este
// kernel, y la frontera transaccional que este kernel NO puede resolver
// por sí solo.
//
// Contrato de una única función pública:
// evaluateAdaptiveProposalApplication (packages/engine/src/
// adaptive-proposal-application-kernel.ts). Puro, inerte: no persiste
// nada, no aplica nada, no acepta propuestas automáticamente, no conoce
// Supabase/UI/reloj, y no puede otorgar crédito de calorías de
// ejercicio — ni siquiera estructuralmente, porque este contrato no tiene
// ningún campo relacionado con ExercisePerformanceResult.
//
// Dependencia real, deliberada: EXCLUSIVAMENTE planWeeklyStrategy (PR3,
// weekly-strategy-kernel.ts) — nunca planWeek/allocateDailyMacros
// directamente, nunca evaluateAdaptiveReview (PR5B decide SI hace falta
// un ajuste; este kernel decide si uno YA propuesto sigue siendo
// aplicable).

import type { AdaptiveProposalBasis } from "./adaptive-coordinator";
import type { WeeklyStrategyInput, WeeklyStrategyOk, WeeklyStrategyResult } from "./nutrition-weekly-strategy";

// ─── Propuesta — subconjunto mínimo, nunca el contrato completo de PR5B ──

/**
 * Subconjunto MÍNIMO y VALIDADO de AdaptiveReviewAdjustmentProposal que
 * este kernel realmente necesita y valida — nunca el contrato completo.
 * Gracias al tipado estructural, una propuesta real y completa de PR5B
 * sigue siendo aceptable aquí (tiene todos estos campos y más), pero esta
 * interfaz no promete que el kernel consuma o valide `evidence`/
 * `context`/`policy`/`confidence`/`rateBandPosition`/etc. — esa validez
 * completa sigue siendo responsabilidad exclusiva de
 * `evaluateAdaptiveReview` (PR5B). Este mismo tipo se usa tanto para la
 * entrada como para la copia canónica que cada estado de salida
 * transporta — reconstruida campo a campo tras validar en runtime, nunca
 * la referencia original ni un superconjunto con campos sin comprobar.
 */
export interface AdaptiveProposalApplicationCandidate {
  status: "adjustment_proposal";
  deltaKcalPerDay: -100 | 100;
  basis: Pick<
    AdaptiveProposalBasis,
    "strategyObjective" | "strategyPriority" | "weeklyKcalTargetInForce" | "targetVersionId" | "strategyVersionId"
  >;
}

// ─── Entrada ────────────────────────────────────────────────────────────

export interface AdaptiveProposalApplicationInput {
  /** La propuesta aceptada por el usuario — posiblemente persistida y
      recuperada más tarde en otra sesión/pestaña/dispositivo, nunca
      asumida "recién calculada en el mismo proceso". */
  proposal: AdaptiveProposalApplicationCandidate;
  /**
   * Identidad ACTUALMENTE persistida, tal como la conoce el llamador
   * justo antes de esta evaluación — opacos, solo igualdad estricta de
   * cadenas. Este kernel nunca los genera ni los interpreta; el
   * adaptador futuro decide cómo construirlos (deberá depender de
   * `currentAverageDailyEnergyAdjustmentKcal`, entre otros inputs, para
   * que dos estrategias con el mismo perfil pero distinto ajuste vigente
   * nunca compartan versión).
   */
  currentTargetVersionId: string;
  currentStrategyVersionId: string;
  /**
   * El WeeklyStrategyInput VIGENTE tal como lo conoce el llamador ahora
   * mismo, incluido su `currentAverageDailyEnergyAdjustmentKcal` actual
   * (ausente/0 es tan válido como cualquier otro valor — mismo criterio
   * que PR3). Este kernel NO puede verificar que este valor refleje el
   * estado realmente más reciente entre dispositivos/sesiones — esa
   * garantía es responsabilidad exclusiva de la capa de integración, que
   * debe leerlo fresco inmediatamente antes de invocar este kernel.
   */
  currentStrategyInput: WeeklyStrategyInput;
}

// ─── Identidad actual — canónica, auditable ────────────────────────────

/** Reconstrucción canónica de los dos tokens de entrada, ya validados
    como string no vacía — para que un resultado (stale_proposal, sobre
    todo) sea autocontenido sin depender de conservar el input original en
    otro sitio. */
export interface ValidatedCurrentAdaptiveIdentity {
  targetVersionId: string;
  strategyVersionId: string;
}

// ─── invalid_input — única categoría, siempre detectada antes de recalcular

export type AdaptiveProposalApplicationInvalidReason =
  | "input_object_invalid"
  | "proposal_malformed"
  | "current_identity_malformed";
export type NonEmptyAdaptiveProposalApplicationInvalidReasons = [
  AdaptiveProposalApplicationInvalidReason,
  ...AdaptiveProposalApplicationInvalidReason[],
];

export interface AdaptiveProposalApplicationInvalidInput {
  status: "invalid_input";
  reasons: NonEmptyAdaptiveProposalApplicationInvalidReasons;
}

// ─── current_strategy_unavailable ──────────────────────────────────────
// El perfil actual, INDEPENDIENTEMENTE de esta propuesta, ya no produce
// "ok". No es "obsolescencia" (eso compara contra la propuesta) — es que
// ni siquiera se puede establecer el estado de partida.

export interface AdaptiveProposalCurrentStrategyUnavailable {
  status: "current_strategy_unavailable";
  /** El WeeklyStrategyResult real (nunca "ok") de recalcular
      currentStrategyInput SIN aplicar la propuesta — propagado íntegro. */
  currentStrategyResult: Exclude<WeeklyStrategyResult, WeeklyStrategyOk>;
  proposal: AdaptiveProposalApplicationCandidate;
  currentIdentity: ValidatedCurrentAdaptiveIdentity;
}

// ─── stale_proposal ─────────────────────────────────────────────────────
// Dos familias de razones, en dos fases estrictamente secuenciales — NUNCA
// mezcladas en un mismo resultado: los tokens (fase 3, primaria) se
// comprueban antes que la estructura (fase 4, defensa adicional); la fase
// 4 solo se alcanza si la fase 3 ya pasó limpia.

export type AdaptiveProposalStalenessReason =
  | "target_version_id_mismatch"
  | "strategy_version_id_mismatch"
  | "current_objective_changed"
  | "current_priority_changed"
  | "current_weekly_target_changed";
export type NonEmptyAdaptiveProposalStalenessReasons = [
  AdaptiveProposalStalenessReason,
  ...AdaptiveProposalStalenessReason[],
];

export interface AdaptiveProposalStale {
  status: "stale_proposal";
  /** Todas las divergencias detectadas EN LA MISMA FASE, nunca solo la
      primera — pero nunca mezcladas entre fase 3 y fase 4. */
  reasons: NonEmptyAdaptiveProposalStalenessReasons;
  /** El estado recalculado AHORA MISMO (ya "ok", sin la propuesta) contra
      el que se comparó — para que el llamador entienda exactamente qué
      cambió, nunca para decidir nada por sí solo. */
  currentStrategy: WeeklyStrategyOk;
  proposal: AdaptiveProposalApplicationCandidate;
  currentIdentity: ValidatedCurrentAdaptiveIdentity;
}

// ─── candidate_not_applicable ───────────────────────────────────────────
// La propuesta seguía vigente, pero el ajuste RESULTANTE ya no produce
// "ok" — nunca se llama "aplicado": es un cálculo, y este kernel se
// detiene aquí sin persistir ni recomendar nada.

export interface AdaptiveProposalCandidateNotApplicable {
  status: "candidate_not_applicable";
  previousStrategy: WeeklyStrategyOk;
  proposal: AdaptiveProposalApplicationCandidate;
  currentIdentity: ValidatedCurrentAdaptiveIdentity;
  /** (currentStrategyInput.currentAverageDailyEnergyAdjustmentKcal ?? 0)
      + proposal.deltaKcalPerDay. */
  nextAverageDailyEnergyAdjustmentKcal: number;
  /** El WeeklyStrategyResult real (nunca "ok") de recalcular CON el
      ajuste candidato — propagado íntegro. Puede ser cualquiera de los 6
      estados "no ok" de PR3 — el consumidor decide qué UX corresponde a
      cada uno leyendo `.status`, este kernel no inventa una segunda
      taxonomía. */
  candidateStrategyResult: Exclude<WeeklyStrategyResult, WeeklyStrategyOk>;
}

// ─── applicable ─────────────────────────────────────────────────────────

export interface AdaptiveProposalApplicable {
  status: "applicable";
  /** La estrategia recalculada AHORA MISMO, sin la propuesta — conservada
      para auditoría/comparación, nunca para decidir nada por sí sola. */
  previousStrategy: WeeklyStrategyOk;
  proposal: AdaptiveProposalApplicationCandidate;
  currentIdentity: ValidatedCurrentAdaptiveIdentity;
  nextAverageDailyEnergyAdjustmentKcal: number;
  /** La estrategia CANDIDATA, YA CALCULADA con
      nextAverageDailyEnergyAdjustmentKcal — este kernel la calcula, nunca
      la persiste ni la aplica. Quien reciba este resultado decide si la
      materializa. */
  candidateStrategy: WeeklyStrategyOk;
}

export type AdaptiveProposalApplicationResult =
  | AdaptiveProposalApplicationInvalidInput
  | AdaptiveProposalCurrentStrategyUnavailable
  | AdaptiveProposalStale
  | AdaptiveProposalCandidateNotApplicable
  | AdaptiveProposalApplicable;
