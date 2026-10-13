// C0 — estado de plan (offset adaptativo, calibración, objetivos del día): política temporal y de valores
// compartida con el servidor (supabase/migrations/20261014120000_plan_state_protection.sql), y las
// funciones PURAS de lectura autoritativa y reconciliación. Sin React, sin Supabase, sin reloj propio: la
// fecha «de hoy» entra siempre como parámetro.
//
// Criterio temporal ÚNICO (cliente y servidor):
//   - una fecha de calendario válida (YYYY-MM-DD, existente),
//   - no anterior a 2000-01-01,
//   - no posterior a «hoy» del escritor. El servidor admite además +1 día (huso horario): la cota del
//     cliente es más estricta que la del servidor a propósito, así que todo valor que el cliente considera
//     admisible el servidor también lo admite (sin bucles de «el servidor lo rechaza, el cliente lo repone»).
// Un valor que no cumple se trata como AUSENTE (nunca se interpreta, nunca se propaga) y no aborta nada.

import type { FoodOSState, PhysicalProfile } from "@foodos/types";
import { isValidCalendarDateKey } from "./utils";

export const PLAN_DATE_FLOOR = "2000-01-01";
export const PLAN_OFFSET_MAX_ABS = 10_000;

/** Fecha admisible según el criterio único, o null. `todayKey` debe ser la fecha REAL del dispositivo
 *  (no debugDate): con una fecha simulada en el futuro, el valor se descarta igual que lo haría el servidor. */
export function sanitizePlanDate(value: unknown, todayKey: string): string | null {
  if (typeof value !== "string") return null;
  if (!isValidCalendarDateKey(value)) return null;
  if (value < PLAN_DATE_FLOOR || value > todayKey) return null;
  return value;
}

/** Offset válido: número entero finito con |valor| <= 10000 (mismo criterio que fn_plan_safe_offset). */
export function sanitizePlanOffset(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (Math.abs(value) > PLAN_OFFSET_MAX_ABS) return null;
  // Normaliza -0.
  return value === 0 ? 0 : value;
}

/** Fusión monótona: la mayor de las fechas admisibles; null solo si ninguna lo es. */
export function mergePlanDate(a: unknown, b: unknown, todayKey: string): string | null {
  const x = sanitizePlanDate(a, todayKey);
  const y = sanitizePlanDate(b, todayKey);
  if (x === null) return y;
  if (y === null) return x;
  return x >= y ? x : y;
}

export interface PlanSlice {
  /** null = el servidor no tiene un offset válido (sin inicializar). */
  offset: number | null;
  calibrationStartedAt: string | null;
  lastTargetChangedAt: string | null;
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
  goal: PlanReadbackGoal | null;
  conflicts: PlanConflictRef[];
  serverDate: string | null;
}

/** Interpreta la respuesta de fn_plan_state_read con la MISMA política: nunca confía en la forma. */
export function parsePlanReadback(raw: unknown, todayKey: string): PlanReadback | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.protocol !== 1) return null;
  const g = r.goal && typeof r.goal === "object" ? (r.goal as Record<string, unknown>) : null;
  const num = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
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
      calibrationStartedAt: sanitizePlanDate(r.calibrationStartedAt, addOneDayCap(todayKey)),
      lastTargetChangedAt: sanitizePlanDate(r.lastTargetChangedAt, addOneDayCap(todayKey)),
    },
    goal,
    conflicts,
    serverDate: typeof r.serverDate === "string" ? r.serverDate : null,
  };
}

/** Los valores que devuelve el SERVIDOR ya pasaron su criterio (≤ hoy UTC + 1): al leerlos no se aplica la
 *  cota estricta del cliente, solo validez y suelo — por eso se relaja la cota un día. La decisión de si
 *  el cliente los ADOPTA es de planSliceDelta (que usa la cota estricta sobre ambos lados). */
function addOneDayCap(todayKey: string): string {
  // todayKey es YYYY-MM-DD válido (lo garantiza quien llama); aritmética de calendario sin Date UTC.
  const [y, m, d] = todayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  dt.setDate(dt.getDate() + 1);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

export interface PlanProfileDelta {
  offset?: number;
  adaptiveCalibrationStartedAt?: string | null;
  lastTargetChangedAt?: string | null;
}

/**
 * Diferencia entre el perfil local y el trozo autoritativo del servidor. Reglas:
 *  - offset: si el servidor tiene un offset válido, MANDA (el local nunca es autoritativo; es escritor
 *    único el RPC). Si el servidor no tiene ninguno (sin inicializar), el local se conserva (inicialización).
 *  - calibración y última fecha de cambio: fusión monótona de valores admisibles de AMBOS lados, con la
 *    cota estricta del cliente (nunca reintroduce una fecha inválida, anterior al suelo o futura).
 *    Si el valor local deja de ser admisible se sustituye por el del servidor (o null).
 * Devuelve null si no hay nada que cambiar.
 */
export function planSliceDelta(profile: PhysicalProfile, slice: PlanSlice, todayKey: string): PlanProfileDelta | null {
  const delta: PlanProfileDelta = {};
  const localOffset = profile.adaptiveKcalOffsetKcal;
  if (slice.offset !== null && localOffset !== slice.offset) delta.offset = slice.offset;

  const cal = mergePlanDate(profile.adaptiveCalibrationStartedAt, slice.calibrationStartedAt, todayKey);
  if ((profile.adaptiveCalibrationStartedAt ?? null) !== cal) delta.adaptiveCalibrationStartedAt = cal;
  const ltc = mergePlanDate(profile.lastTargetChangedAt, slice.lastTargetChangedAt, todayKey);
  if ((profile.lastTargetChangedAt ?? null) !== ltc) delta.lastTargetChangedAt = ltc;

  return Object.keys(delta).length > 0 ? delta : null;
}

export function applyPlanDelta(profile: PhysicalProfile, delta: PlanProfileDelta): void {
  if (delta.offset !== undefined) profile.adaptiveKcalOffsetKcal = delta.offset;
  if (delta.adaptiveCalibrationStartedAt !== undefined) profile.adaptiveCalibrationStartedAt = delta.adaptiveCalibrationStartedAt;
  if (delta.lastTargetChangedAt !== undefined) profile.lastTargetChangedAt = delta.lastTargetChangedAt;
}

/** Sanea los campos de plan de un perfil recién leído/cargado (pull remoto o localStorage): un valor
 *  inválido pasa a «sin valor» en vez de propagarse. Devuelve true si cambió algo. */
export function sanitizeProfilePlanFields(profile: PhysicalProfile, todayKey: string): boolean {
  let changed = false;
  if (profile.adaptiveCalibrationStartedAt !== undefined && profile.adaptiveCalibrationStartedAt !== null) {
    const v = sanitizePlanDate(profile.adaptiveCalibrationStartedAt, todayKey);
    if (v !== profile.adaptiveCalibrationStartedAt) { profile.adaptiveCalibrationStartedAt = v; changed = true; }
  }
  if (profile.lastTargetChangedAt !== undefined && profile.lastTargetChangedAt !== null) {
    const v = sanitizePlanDate(profile.lastTargetChangedAt, todayKey);
    if (v !== profile.lastTargetChangedAt) { profile.lastTargetChangedAt = v; changed = true; }
  }
  if (profile.adaptiveKcalOffsetKcal !== undefined) {
    const v = sanitizePlanOffset(profile.adaptiveKcalOffsetKcal);
    if (v === null) { delete profile.adaptiveKcalOffsetKcal; changed = true; }
    else if (v !== profile.adaptiveKcalOffsetKcal) { profile.adaptiveKcalOffsetKcal = v; changed = true; }
  }
  return changed;
}

// ─── Manejo de la lectura autoritativa (inyectable, sin React) ─────────────────────────────────────

export interface PlanReadbackDeps {
  /** Identidad ACTUAL de la sesión; null si no hay. */
  currentIdentity: () => { userId: string; epoch: number } | null;
  getState: () => FoodOSState;
  /** Aplica una mutación de usuario-equivalente (recalcula objetivos, ledger de HOY, outbox y push). */
  mutate: (fn: (draft: FoodOSState) => void) => boolean;
  /** Fecha real del dispositivo (no debugDate). */
  todayKey: () => string;
  notify: (message: string) => void;
  acknowledgeConflicts: (userId: string, epoch: number, ids: string[]) => void;
}

export type PlanReadbackOutcome =
  | { kind: "ignored"; reason: "no_session" | "identity_changed" | "no_profile" }
  | { kind: "in_sync" }
  | { kind: "reconciled"; delta: PlanProfileDelta }
  | { kind: "blocked" };

/**
 * Recibe una lectura autoritativa de la identidad (userId, epoch) con la que se pidió. Garantías:
 *  - si la sesión ya no es esa (A→B, logout, cambio de época) NO toca nada;
 *  - actúa sobre el estado MÁS RECIENTE (incluidas ediciones hechas mientras la sincronización estaba
 *    en vuelo), nunca sobre el snapshot que se envió;
 *  - solo cambia offset/calibración (ver planSliceDelta); el resto del perfil, las ediciones legítimas
 *    pendientes y el ledger de fechas pasadas no se tocan (el recalculado de HOY lo hace mutate());
 *  - si el cambio no puede aplicarse ahora (mutaciones bloqueadas) lo devuelve como `blocked` y NO marca
 *    los conflictos como vistos: se reintentará con la siguiente lectura.
 */
export function handlePlanReadback(
  identity: { userId: string; epoch: number },
  readback: PlanReadback,
  deps: PlanReadbackDeps,
): PlanReadbackOutcome {
  const current = deps.currentIdentity();
  if (!current) return { kind: "ignored", reason: "no_session" };
  if (current.userId !== identity.userId || current.epoch !== identity.epoch) return { kind: "ignored", reason: "identity_changed" };

  const state = deps.getState();
  if (!state.profile) return { kind: "ignored", reason: "no_profile" };

  const todayKey = deps.todayKey();
  const delta = planSliceDelta(state.profile, readback.slice, todayKey);
  if (!delta) {
    if (readback.conflicts.length > 0) deps.acknowledgeConflicts(identity.userId, identity.epoch, readback.conflicts.map((c) => c.id));
    return { kind: "in_sync" };
  }

  const applied = deps.mutate((draft) => {
    if (!draft.profile) return;
    // Recalcula el delta contra el borrador (puede haber cambiado entre la lectura y este momento).
    const d = planSliceDelta(draft.profile, readback.slice, todayKey);
    if (d) applyPlanDelta(draft.profile, d);
  });
  if (!applied) return { kind: "blocked" };

  if (delta.offset !== undefined) {
    deps.notify("Otro dispositivo había ajustado tu plan; ya está al día en este.");
  }
  if (readback.conflicts.length > 0) deps.acknowledgeConflicts(identity.userId, identity.epoch, readback.conflicts.map((c) => c.id));
  return { kind: "reconciled", delta };
}
