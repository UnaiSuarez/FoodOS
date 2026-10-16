// C0 — estado de plan (offset adaptativo, calibración, objetivos del día): política temporal y de valores
// compartida con el servidor (supabase/migrations/20261014120000_plan_state_protection.sql) y las
// funciones PURAS de lectura autoritativa y reconciliación. Sin React, sin Supabase, sin reloj propio: la
// fecha de referencia entra siempre como parámetro.
//
// Política temporal ÚNICA (cliente y servidor):
//   admisible = fecha de calendario existente (YYYY-MM-DD) ∧ >= 2000-01-01 ∧ <= referencia + 1 día.
//   - En el servidor la referencia es current_date (UTC) y el +1 absorbe el huso horario.
//   - En el cliente la referencia es `readback.serverDate` siempre que haya una lectura del servidor; solo
//     al cargar estado local/pull (donde aún no hay lectura) se usa la fecha local del dispositivo. Así un
//     valor legítimo generado en otro huso cerca de medianoche (local = UTC±1) se juzga con la MISMA
//     regla en ambos lados y no se elimina ni se reintroduce en bucle. Todo valor que no cumple se trata
//     como AUSENTE (nunca se interpreta ni se propaga) y no aborta nada.
// El cliente nunca usa el reloj del host para decidir si un valor DEL SERVIDOR es admisible cuando tiene
// serverDate.

import type { FoodOSState, PhysicalProfile } from "@foodos/types";
import { addDaysToDateKey, isValidCalendarDateKey } from "./utils";

export const PLAN_DATE_FLOOR = "2000-01-01";
export const PLAN_OFFSET_MAX_ABS = 10_000;
/** Reintentos acotados de cada recuperación del cliente (re-sincronizar / refrescar). */
export const PLAN_RECONCILE_MAX_REPUSH = 2;
export const PLAN_RECONCILE_MAX_REFRESH = 2;

/** Fecha admisible según la política única, o null. `referenceDay`: ver arriba. */
export function sanitizePlanDate(value: unknown, referenceDay: string): string | null {
  if (typeof value !== "string" || !isValidCalendarDateKey(value) || !isValidCalendarDateKey(referenceDay)) return null;
  if (value < PLAN_DATE_FLOOR || value > addDaysToDateKey(referenceDay, 1)) return null;
  return value;
}

/** Offset válido: número entero finito con |valor| <= 10000 (mismo criterio que fn_plan_safe_offset). */
export function sanitizePlanOffset(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (Math.abs(value) > PLAN_OFFSET_MAX_ABS) return null;
  return value === 0 ? 0 : value; // normaliza -0
}

/** Fusión monótona: la mayor de las fechas admisibles; null solo si ninguna lo es. */
export function mergePlanDate(a: unknown, b: unknown, referenceDay: string): string | null {
  const x = sanitizePlanDate(a, referenceDay);
  const y = sanitizePlanDate(b, referenceDay);
  if (x === null) return y;
  if (y === null) return x;
  return x >= y ? x : y;
}

export interface PlanSlice {
  /** null = el servidor no tiene un offset válido (sin inicializar). */
  offset: number | null;
  calibrationStartedAt: string | null;
  lastTargetChangedAt: string | null;
  engineVersion: string | null;
}

export interface PlanReadbackGoal {
  goalDate: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  mode: string;
  basisOffsetKcal: number | null;
  calculationVersion: string | null;
  sourceSnapshotId: string | null;
}

export interface PlanConflictRef {
  id: string;
  kind: string;
  subject: string;
}

export interface PlanReadback {
  slice: PlanSlice;
  /** Fila del objetivo de `requestedGoalDate` en el servidor, o null si no existe (o no se pidió). */
  goal: PlanReadbackGoal | null;
  conflicts: PlanConflictRef[];
  /** Fecha del servidor (UTC), referencia de la política temporal. null si la respuesta no la trae. */
  serverDate: string | null;
  /** Fecha del objetivo que se pidió leer (la que escribió ese push). */
  requestedGoalDate: string | null;
  /** Mutación (del outbox) cuyo push produjo esta lectura; null para una relectura de recuperación. */
  mutationId: string | null;
}

/** Interpreta la respuesta de fn_plan_state_read con la MISMA política: nunca confía en la forma. */
export function parsePlanReadback(
  raw: unknown,
  ctx: { fallbackDay: string; requestedGoalDate: string | null; mutationId: string | null },
): PlanReadback | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.protocol !== 1) return null;
  const serverDate = typeof r.serverDate === "string" && isValidCalendarDateKey(r.serverDate) ? r.serverDate : null;
  const ref = serverDate ?? ctx.fallbackDay;
  const num = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  const g = r.goal && typeof r.goal === "object" && !Array.isArray(r.goal) ? (r.goal as Record<string, unknown>) : null;
  let goal: PlanReadbackGoal | null = null;
  if (g) {
    const kcal = num(g.kcal), protein = num(g.protein), carbs = num(g.carbs), fat = num(g.fat);
    if (typeof g.goalDate === "string" && kcal !== null && protein !== null && carbs !== null && fat !== null && typeof g.mode === "string") {
      goal = {
        goalDate: g.goalDate, kcal, protein, carbs, fat, mode: g.mode,
        basisOffsetKcal: sanitizePlanOffset(g.basisOffsetKcal),
        calculationVersion: typeof g.calculationVersion === "string" ? g.calculationVersion : null,
        sourceSnapshotId: typeof g.sourceSnapshotId === "string" ? g.sourceSnapshotId : null,
      };
    }
  }
  const conflicts: PlanConflictRef[] = Array.isArray(r.conflicts)
    ? r.conflicts.flatMap((c) => {
        if (!c || typeof c !== "object") return [];
        const o = c as Record<string, unknown>;
        return typeof o.id === "string" && typeof o.kind === "string" && typeof o.subject === "string"
          ? [{ id: o.id, kind: o.kind, subject: o.subject }]
          : [];
      })
    : [];
  return {
    slice: {
      offset: sanitizePlanOffset(r.offset),
      calibrationStartedAt: sanitizePlanDate(r.calibrationStartedAt, ref),
      lastTargetChangedAt: sanitizePlanDate(r.lastTargetChangedAt, ref),
      engineVersion: typeof r.engineVersion === "string" && r.engineVersion.length > 0 && r.engineVersion.length <= 64 ? r.engineVersion : null,
    },
    goal,
    conflicts,
    serverDate,
    requestedGoalDate: ctx.requestedGoalDate,
    mutationId: ctx.mutationId,
  };
}

export interface PlanProfileDelta {
  offset?: number;
  adaptiveCalibrationStartedAt?: string | null;
  lastTargetChangedAt?: string | null;
  lastCalculationEngineVersion?: string;
}

/**
 * Diferencia entre el perfil local y el trozo autoritativo del servidor:
 *  - offset: si el servidor tiene uno válido, MANDA (escritor único: el RPC). Sin offset en el servidor
 *    el local se conserva (inicialización).
 *  - calibración y última fecha de cambio: fusión monótona de valores admisibles de AMBOS lados; un valor
 *    local que deja de ser admisible se sustituye por el del servidor (o null) → nunca se reintroduce una
 *    fecha inválida, anterior al suelo o futura mediante max(local, servidor).
 *  - versión de motor: solo se adopta la del servidor si el local no tiene ninguna (evita una transición
 *    espuria); si ambos la tienen, manda el local.
 * Devuelve null si no hay nada que cambiar.
 */
export function planSliceDelta(profile: PhysicalProfile, slice: PlanSlice, referenceDay: string): PlanProfileDelta | null {
  const delta: PlanProfileDelta = {};
  if (slice.offset !== null && profile.adaptiveKcalOffsetKcal !== slice.offset) delta.offset = slice.offset;

  const cal = mergePlanDate(profile.adaptiveCalibrationStartedAt, slice.calibrationStartedAt, referenceDay);
  if ((profile.adaptiveCalibrationStartedAt ?? null) !== cal) delta.adaptiveCalibrationStartedAt = cal;
  const ltc = mergePlanDate(profile.lastTargetChangedAt, slice.lastTargetChangedAt, referenceDay);
  if ((profile.lastTargetChangedAt ?? null) !== ltc) delta.lastTargetChangedAt = ltc;

  if (slice.engineVersion !== null && !profile.lastCalculationEngineVersion) delta.lastCalculationEngineVersion = slice.engineVersion;

  return Object.keys(delta).length > 0 ? delta : null;
}

export function applyPlanDelta(profile: PhysicalProfile, delta: PlanProfileDelta): void {
  if (delta.offset !== undefined) profile.adaptiveKcalOffsetKcal = delta.offset;
  if (delta.adaptiveCalibrationStartedAt !== undefined) profile.adaptiveCalibrationStartedAt = delta.adaptiveCalibrationStartedAt;
  if (delta.lastTargetChangedAt !== undefined) profile.lastTargetChangedAt = delta.lastTargetChangedAt;
  if (delta.lastCalculationEngineVersion !== undefined) profile.lastCalculationEngineVersion = delta.lastCalculationEngineVersion;
}

/** Sanea los campos de plan de un perfil recién leído/cargado (pull remoto o localStorage): un valor
 *  inválido pasa a «sin valor» en vez de propagarse. `referenceDay`: fecha local del dispositivo (aún no
 *  hay lectura del servidor). Devuelve true si cambió algo. */
export function sanitizeProfilePlanFields(profile: PhysicalProfile, referenceDay: string): boolean {
  let changed = false;
  if (profile.adaptiveCalibrationStartedAt !== undefined && profile.adaptiveCalibrationStartedAt !== null) {
    const v = sanitizePlanDate(profile.adaptiveCalibrationStartedAt, referenceDay);
    if (v !== profile.adaptiveCalibrationStartedAt) { profile.adaptiveCalibrationStartedAt = v; changed = true; }
  }
  if (profile.lastTargetChangedAt !== undefined && profile.lastTargetChangedAt !== null) {
    const v = sanitizePlanDate(profile.lastTargetChangedAt, referenceDay);
    if (v !== profile.lastTargetChangedAt) { profile.lastTargetChangedAt = v; changed = true; }
  }
  if (profile.adaptiveKcalOffsetKcal !== undefined) {
    const v = sanitizePlanOffset(profile.adaptiveKcalOffsetKcal);
    if (v === null) { delete profile.adaptiveKcalOffsetKcal; changed = true; }
    else if (v !== profile.adaptiveKcalOffsetKcal) { profile.adaptiveKcalOffsetKcal = v; changed = true; }
  }
  return changed;
}

// ─── Objetivo de hoy ────────────────────────────────────────────────────────────────────────────────

export type GoalVerdict =
  /** No hay nada que comparar: sin objetivo local acreditado por el ledger de esa fecha. */
  | "not_applicable"
  | "in_sync"
  /** El servidor no tiene fila para la fecha (un INSERT omitido, una política que rechaza…). */
  | "server_row_missing"
  /** La fila del servidor se calculó con otro offset (o sin base): hay que reescribirla con la base vigente. */
  | "basis_stale"
  /** Misma base pero otras cifras: probablemente otro dispositivo con un perfil más reciente. */
  | "figures_diverged"
  /** Mismas cifras y base pero distinta versión de cálculo: metadato por alinear. */
  | "metadata_diverged";

/**
 * Compara el objetivo de la fecha pedida en el servidor con el que ESTE dispositivo escribiría. Solo mira
 * esa fecha (la de HOY del push): jamás compara ni copia objetivos históricos. Aplica a un estado en el que
 * el offset local ya coincide con el del servidor (se reconcilia antes).
 */
export function classifyGoalReadback(state: FoodOSState, readback: PlanReadback): GoalVerdict {
  const date = readback.requestedGoalDate;
  const profile = state.profile;
  if (!date || !profile) return "not_applicable";
  const entry = state.nutritionGoalsHistory?.[date];
  // Misma condición que la puerta de escritura de pushState: sin entrada del ledger coherente con
  // state.nutrition no se escribió nada que comparar.
  if (
    !entry || !entry.calculationVersion ||
    entry.kcal !== state.nutrition.kcal || entry.protein !== state.nutrition.protein ||
    entry.carbs !== state.nutrition.carbs || entry.fat !== state.nutrition.fat || entry.mode !== state.nutrition.mode
  ) return "not_applicable";
  const server = readback.goal;
  if (!server || server.goalDate !== date) return "server_row_missing";
  const localOffset = sanitizePlanOffset(profile.adaptiveKcalOffsetKcal) ?? 0;
  if (server.basisOffsetKcal !== localOffset) return "basis_stale";
  if (server.kcal !== entry.kcal || server.protein !== entry.protein || server.carbs !== entry.carbs || server.fat !== entry.fat || server.mode !== entry.mode) {
    return "figures_diverged";
  }
  if (server.calculationVersion !== entry.calculationVersion) return "metadata_diverged";
  return "in_sync";
}

// ─── Manejo de la lectura autoritativa (inyectable, sin React) ─────────────────────────────────────

export interface PlanReadbackDeps {
  /** Identidad ACTUAL de la sesión; null si no hay. */
  currentIdentity: () => { userId: string; epoch: number } | null;
  getState: () => FoodOSState;
  /** ¿Terminó la hidratación de esta sesión? (un estado sin perfil durante la carga es provisional). */
  hydrationReady: () => boolean;
  /** Aplica una mutación equivalente a una edición del usuario (recalcula objetivos, ledger de HOY, outbox y push). */
  mutate: (fn: (draft: FoodOSState) => void | false) => boolean;
  /** Fecha local del dispositivo (solo referencia cuando la lectura no trae serverDate). */
  todayKey: () => string;
  /** ¿Es `mutationId` la mutación más reciente (no hay otra pendiente tras ella)? null = relectura de recuperación. */
  isLatestMutation: (mutationId: string | null) => boolean;
  /** Pide una hidratación normal (refresca perfil/objetivos desde el servidor). */
  requestRefresh: () => void;
  notify: (message: string) => void;
  acknowledgeConflicts: (userId: string, epoch: number, ids: string[]) => void;
}

/** Contadores de recuperación acotada, por cuenta y época. Los reinicia el proveedor al cambiar la identidad. */
export interface PlanReconcileBudget {
  repush: number;
  refresh: number;
  warned: boolean;
  /** Último offset anunciado al usuario (deduplica el aviso). */
  notifiedOffset: number | null;
}
export function newPlanReconcileBudget(): PlanReconcileBudget {
  return { repush: 0, refresh: 0, warned: false, notifiedOffset: null };
}

/** Qué le devuelve el consumidor a la capa de datos tras RECIBIR una lectura:
 *  - "confirmed": el estado local quedó comprobado contra el servidor → se puede retirar la relectura pendiente;
 *  - "pending": se recibió pero no está reconciliado (aplicación diferida, bloqueada, reintentos en curso o
 *    agotados, mutación más nueva en cola, otra identidad) → la relectura pendiente se MANTIENE. */
export type PlanReadbackAck = "confirmed" | "pending";

export type PlanReadbackOutcome =
  | { kind: "ignored"; reason: "no_session" | "identity_changed" | "no_profile" | "not_hydrated" }
  /** El plan (offset, calibración, versión) coincide. `goalCompared` indica si además se pudo COMPARAR el
   *  objetivo de hoy: sin un ledger coherente no se compara, y entonces no se reconocen los conflictos del
   *  objetivo (solo los del plan, que sí se verificaron). */
  | { kind: "in_sync"; goalCompared: boolean }
  /** Se aplicó un cambio de plan; el objetivo se reescribirá con el push que genera esa mutación. */
  | { kind: "reconciled"; delta: PlanProfileDelta }
  /** Hay una mutación local más nueva: su propio push traerá su lectura; no se concluye nada aún. */
  | { kind: "deferred_newer_mutation" }
  /** Las mutaciones están bloqueadas ahora mismo; hay que reintentar la lectura más tarde. */
  | { kind: "blocked" }
  | { kind: "repush"; verdict: GoalVerdict }
  | { kind: "refresh"; verdict: GoalVerdict }
  /** Agotados los reintentos acotados: NO se da por reconciliado ni se reconocen conflictos. */
  | { kind: "unresolved"; verdict: GoalVerdict };

/** Recibido ≠ aplicado ≠ confirmado. Solo `in_sync` (y «no hay perfil», donde no existe estado de plan que
 *  reconciliar) confirma; todo lo demás deja la relectura pendiente — incluida `reconciled`, que solo encola
 *  el cambio: lo confirmará la lectura de su propio push. */
export function planOutcomeAck(outcome: PlanReadbackOutcome): PlanReadbackAck {
  if (outcome.kind === "in_sync") return "confirmed";
  if (outcome.kind === "ignored" && outcome.reason === "no_profile") return "confirmed";
  return "pending";
}

/**
 * Recibe una lectura autoritativa de la identidad (userId, epoch) con la que se pidió. Garantías:
 *  - si la sesión ya no es esa (A→B, logout, cambio de época) NO toca nada;
 *  - actúa sobre el estado MÁS RECIENTE (incluidas ediciones hechas mientras la sincronización estaba en
 *    vuelo), nunca sobre el snapshot enviado;
 *  - solo cambia offset/calibración/versión (planSliceDelta); el resto del perfil, las ediciones legítimas
 *    pendientes y el ledger de fechas pasadas no se tocan (el recalculado de HOY lo hace mutate());
 *  - con el plan al día compara el objetivo de HOY (classifyGoalReadback): reescribir (re-push) si el
 *    servidor tiene otra base o no tiene fila; refrescar si otro dispositivo escribió otras cifras; ambos
 *    con presupuesto acotado;
 *  - los conflictos solo se reconocen cuando todo coincide (`in_sync`); nunca antes de resolverlos.
 */
export function handlePlanReadback(
  identity: { userId: string; epoch: number },
  readback: PlanReadback,
  deps: PlanReadbackDeps,
  budget: PlanReconcileBudget,
): PlanReadbackOutcome {
  const current = deps.currentIdentity();
  if (!current) return { kind: "ignored", reason: "no_session" };
  if (current.userId !== identity.userId || current.epoch !== identity.epoch) return { kind: "ignored", reason: "identity_changed" };

  const state = deps.getState();
  if (!state.profile) {
    // «Sin perfil» solo es definitivo (cuenta sin onboarding, nada que reconciliar) con la hidratación
    // terminada; mientras carga, el estado puede ser provisional y no se confirma nada.
    return { kind: "ignored", reason: deps.hydrationReady() ? "no_profile" : "not_hydrated" };
  }

  const ref = readback.serverDate ?? deps.todayKey();
  const delta = planSliceDelta(state.profile, readback.slice, ref);  if (delta) {
    const applied = deps.mutate((draft) => {
      if (!draft.profile) return false;
      // Recalculado contra el borrador (el estado más reciente en el momento de aplicar): si otra
      // lectura ya lo reconcilió, no hay nada que escribir ni que enviar.
      const d = planSliceDelta(draft.profile, readback.slice, ref);
      if (!d) return false;
      applyPlanDelta(draft.profile, d);
    });
    if (!applied) return { kind: "blocked" };
    // El estado leído por este manejador puede ir un render por detrás (la mutación se aplica de forma
    // diferida): el aviso se deduplica por valor de offset para no repetirlo.
    if (delta.offset !== undefined && budget.notifiedOffset !== delta.offset) {
      budget.notifiedOffset = delta.offset;
      deps.notify("Otro dispositivo había ajustado tu plan; ya está al día en este.");
    }
    return { kind: "reconciled", delta };
  }

  if (!deps.isLatestMutation(readback.mutationId)) return { kind: "deferred_newer_mutation" };

  const verdict = classifyGoalReadback(state, readback);
  if (verdict === "not_applicable" || verdict === "in_sync") {
    budget.repush = 0;
    budget.refresh = 0;
    budget.warned = false;
    budget.notifiedOffset = null;
    const goalCompared = verdict === "in_sync";
    // Solo se reconoce lo que se verificó: el plan coincide, así que los conflictos del plan se pueden
    // reconocer; los del objetivo diario (`daily_goal_*`) solo si el objetivo de hoy se pudo comparar.
    const ackable = readback.conflicts.filter((c) => goalCompared || !c.kind.startsWith("daily_goal_"));
    if (ackable.length > 0) deps.acknowledgeConflicts(identity.userId, identity.epoch, ackable.map((c) => c.id));
    return { kind: "in_sync", goalCompared };
  }

  if (verdict === "figures_diverged") {
    if (budget.refresh < PLAN_RECONCILE_MAX_REFRESH) {
      budget.refresh += 1;
      deps.requestRefresh();
      return { kind: "refresh", verdict };
    }
  } else if (budget.repush < PLAN_RECONCILE_MAX_REPUSH) {
    // server_row_missing | basis_stale | metadata_diverged: reescribir el objetivo de hoy desde el perfil
    // vigente. mutate() recalcula, registra la entrada de HOY y programa el push; sin cambios de datos.
    const ok = deps.mutate(() => {});
    if (!ok) return { kind: "blocked" };
    budget.repush += 1;
    return { kind: "repush", verdict };
  }
  if (!budget.warned) {
    budget.warned = true;
    deps.notify("No se pudo confirmar tu objetivo de hoy en el servidor; se reintentará.");
  }
  return { kind: "unresolved", verdict };
}
