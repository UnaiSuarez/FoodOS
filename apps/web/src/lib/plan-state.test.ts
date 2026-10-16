// C0 — funciones puras de plan-state.ts: política temporal, lectura autoritativa, reconciliación del
// perfil y del objetivo de HOY, presupuestos acotados y condiciones para reconocer conflictos.
import { describe, expect, it, vi } from "vitest";
import type { FoodOSState, PhysicalProfile } from "@foodos/types";
import {
  classifyGoalReadback,
  handlePlanReadback,
  mergePlanDate,
  newPlanReconcileBudget,
  parsePlanReadback,
  planOutcomeAck,
  planSliceDelta,
  sanitizePlanDate,
  sanitizePlanOffset,
  sanitizeProfilePlanFields,
  type PlanReadback,
  type PlanReadbackDeps,
} from "./plan-state";

const TODAY = "2026-10-14";

function profile(over: Partial<PhysicalProfile> = {}): PhysicalProfile {
  return {
    age: 32, sex: "male", heightCm: 178, weightKg: 80, bodyFatPct: null, activityLevel: "moderate", goal: "fat_loss",
    gymDays: [1, 3, 5], allergies: [], excludedFoods: [], adaptiveKcalOffsetKcal: 0, ...over,
  } as PhysicalProfile;
}
function stateOf(p: PhysicalProfile | null, over: Partial<FoodOSState> = {}): FoodOSState {
  const nutrition = { kcal: 2039, protein: 160, carbs: 222, fat: 57, mode: "fat_loss" as const };
  return {
    profile: p, nutrition,
    nutritionGoalsHistory: { [TODAY]: { ...nutrition, calculationVersion: "nutrition-v3.1", recordedAt: null } },
    ...over,
  } as unknown as FoodOSState;
}
function readback(over: Partial<PlanReadback> = {}): PlanReadback {
  return {
    slice: { offset: 0, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: null },
    goal: { goalDate: TODAY, kcal: 2039, protein: 160, carbs: 222, fat: 57, mode: "fat_loss", basisOffsetKcal: 0, calculationVersion: "nutrition-v3.1", sourceSnapshotId: null },
    conflicts: [], serverDate: TODAY, requestedGoalDate: TODAY, mutationId: "m1", ...over,
  };
}

describe("política temporal única", () => {
  it("admite fechas reales entre 2000-01-01 y referencia+1; rechaza el resto sin lanzar", () => {
    expect(sanitizePlanDate("2026-10-14", TODAY)).toBe("2026-10-14");
    expect(sanitizePlanDate("2026-10-15", TODAY)).toBe("2026-10-15"); // +1 por huso
    expect(sanitizePlanDate("2026-10-16", TODAY)).toBeNull();
    expect(sanitizePlanDate("1999-12-31", TODAY)).toBeNull();
    expect(sanitizePlanDate("2000-01-01", TODAY)).toBe("2000-01-01");
    for (const bad of ["2026-99-99", "2026-02-30", "14/10/2026", "", null, undefined, 20261014, {}, []]) {
      expect(sanitizePlanDate(bad as never, TODAY)).toBeNull();
    }
  });

  it("offset: solo enteros finitos con |valor| <= 10000", () => {
    expect(sanitizePlanOffset(-100)).toBe(-100);
    expect(sanitizePlanOffset(-0)).toBe(0);
    for (const bad of [12.5, "abc", NaN, Infinity, 10001, null, undefined, true]) expect(sanitizePlanOffset(bad)).toBeNull();
  });

  it("max(local, servidor) nunca reintroduce una fecha inválida o futura", () => {
    expect(mergePlanDate("2099-01-01", "2026-10-01", TODAY)).toBe("2026-10-01");
    expect(mergePlanDate("2026-99-99", null, TODAY)).toBeNull();
    expect(mergePlanDate("2026-10-01", "2026-10-10", TODAY)).toBe("2026-10-10");
    expect(mergePlanDate(null, "2026-10-10", TODAY)).toBe("2026-10-10");
  });

  it("otro huso cerca de medianoche: servidor UTC D, dispositivo UTC+13 (local D+1) y UTC−11 (local D−1) conservan el valor legítimo sin bucle", () => {
    const D = "2026-10-14";
    // Dispositivo adelantado: escribió su «hoy» local = D+1; el servidor (referencia D) lo admite.
    const ahead = profile({ adaptiveCalibrationStartedAt: "2026-10-15" });
    expect(planSliceDelta(ahead, { offset: 0, calibrationStartedAt: "2026-10-15", lastTargetChangedAt: null, engineVersion: null }, D)).toBeNull();
    // Y si el servidor aún guarda otra anterior, el local D+1 sigue siendo el mayor admisible: sin cambios.
    expect(planSliceDelta(ahead, { offset: 0, calibrationStartedAt: "2026-10-01", lastTargetChangedAt: null, engineVersion: null }, D)).toBeNull();
    // Dispositivo atrasado (local D−1) con el servidor en D: adopta D (monótono) una vez, y queda estable.
    const behind = profile({ adaptiveCalibrationStartedAt: "2026-10-13" });
    const slice = { offset: 0, calibrationStartedAt: "2026-10-14", lastTargetChangedAt: null, engineVersion: null };
    const delta = planSliceDelta(behind, slice, D);
    expect(delta).toEqual({ adaptiveCalibrationStartedAt: "2026-10-14" });
    const after = profile({ adaptiveCalibrationStartedAt: "2026-10-14" });
    expect(planSliceDelta(after, slice, D)).toBeNull();
    // Un valor local D+2 (inadmisible) se sustituye por el del servidor: converge, no oscila.
    const bad = profile({ adaptiveCalibrationStartedAt: "2026-10-16" });
    expect(planSliceDelta(bad, slice, D)).toEqual({ adaptiveCalibrationStartedAt: "2026-10-14" });
  });

  it("parsePlanReadback usa serverDate como referencia (no el reloj del host) y descarta basura", () => {
    const raw = { protocol: 1, serverDate: "2026-10-14", offset: -100, calibrationStartedAt: "2026-10-15", lastTargetChangedAt: "2026-99-99", engineVersion: "nutrition-v3.1", goal: null, conflicts: [{ id: "c1", kind: "x", subject: "s" }, { bad: true }] };
    const rb = parsePlanReadback(raw, { fallbackDay: "2001-01-01", requestedGoalDate: TODAY, mutationId: "m9" })!;
    expect(rb.slice).toEqual({ offset: -100, calibrationStartedAt: "2026-10-15", lastTargetChangedAt: null, engineVersion: "nutrition-v3.1" });
    expect(rb.conflicts).toEqual([{ id: "c1", kind: "x", subject: "s" }]);
    expect(rb.mutationId).toBe("m9");
    expect(parsePlanReadback({ protocol: 2 }, { fallbackDay: TODAY, requestedGoalDate: null, mutationId: null })).toBeNull();
    expect(parsePlanReadback("x", { fallbackDay: TODAY, requestedGoalDate: null, mutationId: null })).toBeNull();
  });

  it("sanea el perfil cargado (pull/localStorage) sin lanzar", () => {
    const p = profile({ adaptiveCalibrationStartedAt: "2026-99-99", lastTargetChangedAt: "2099-01-01", adaptiveKcalOffsetKcal: 12.5 });
    expect(sanitizeProfilePlanFields(p, TODAY)).toBe(true);
    expect(p.adaptiveCalibrationStartedAt).toBeNull();
    expect(p.lastTargetChangedAt).toBeNull();
    expect(p.adaptiveKcalOffsetKcal).toBeUndefined();
  });
});

describe("planSliceDelta", () => {
  it("el offset del servidor manda; sin offset en el servidor el local se conserva (inicialización)", () => {
    expect(planSliceDelta(profile({ adaptiveKcalOffsetKcal: 0 }), { offset: -100, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: null }, TODAY)).toEqual({ offset: -100 });
    expect(planSliceDelta(profile({ adaptiveKcalOffsetKcal: -100 }), { offset: null, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: null }, TODAY)).toBeNull();
  });
  it("versión de motor: se adopta la del servidor solo si el local no tiene ninguna", () => {
    const slice = { offset: 0, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: "nutrition-v3.1" };
    expect(planSliceDelta(profile({}), slice, TODAY)).toEqual({ lastCalculationEngineVersion: "nutrition-v3.1" });
    expect(planSliceDelta(profile({ lastCalculationEngineVersion: "nutrition-v3" }), slice, TODAY)).toBeNull();
  });
});

describe("classifyGoalReadback — solo el objetivo de la fecha pedida", () => {
  const p = profile();
  it("in_sync cuando cifras, base y versión coinciden", () => expect(classifyGoalReadback(stateOf(p), readback())).toBe("in_sync"));
  it("offset igual pero OBJETIVO diferente (otro dispositivo, misma base) → figures_diverged", () => {
    expect(classifyGoalReadback(stateOf(p), readback({ goal: { ...readback().goal!, kcal: 1900 } }))).toBe("figures_diverged");
  });
  it("base distinta (o sin base) → basis_stale; sin fila → server_row_missing; solo versión → metadata_diverged", () => {
    expect(classifyGoalReadback(stateOf(p), readback({ goal: { ...readback().goal!, basisOffsetKcal: -100 } }))).toBe("basis_stale");
    expect(classifyGoalReadback(stateOf(p), readback({ goal: { ...readback().goal!, basisOffsetKcal: null } }))).toBe("basis_stale");
    expect(classifyGoalReadback(stateOf(p), readback({ goal: null }))).toBe("server_row_missing");
    expect(classifyGoalReadback(stateOf(p), readback({ goal: { ...readback().goal!, calculationVersion: "nutrition-v3" } }))).toBe("metadata_diverged");
  });
  it("sin entrada coherente del ledger para esa fecha no hay nada que comparar; nunca mira otras fechas", () => {
    const s = stateOf(p, { nutritionGoalsHistory: { "2026-10-01": { kcal: 1, protein: 1, carbs: 1, fat: 1, mode: "fat_loss", calculationVersion: "v", recordedAt: null } } as never });
    expect(classifyGoalReadback(s, readback())).toBe("not_applicable");
    const incoherent = stateOf(p, { nutrition: { kcal: 1500, protein: 1, carbs: 1, fat: 1, mode: "fat_loss" } as never });
    expect(classifyGoalReadback(incoherent, readback())).toBe("not_applicable");
  });
});

function harness(state: FoodOSState, over: Partial<PlanReadbackDeps> = {}) {
  const calls = { mutate: 0, notify: [] as string[], ack: [] as string[][], refresh: 0 };
  const deps: PlanReadbackDeps = {
    currentIdentity: () => ({ userId: "A", epoch: 1 }),
    getState: () => state,
    hydrationReady: () => true,
    mutate: (fn) => { calls.mutate++; const draft = structuredClone(state); fn(draft); state = draft; return true; },
    todayKey: () => TODAY,
    isLatestMutation: () => true,
    requestRefresh: () => { calls.refresh++; },
    notify: (m) => calls.notify.push(m),
    acknowledgeConflicts: (_u, _e, ids) => calls.ack.push(ids),
    ...over,
  };
  return { deps, calls, getState: () => state };
}

describe("handlePlanReadback", () => {
  const id = { userId: "A", epoch: 1 };
  const conflict = [{ id: "c1", kind: "offset_overwrite_prevented", subject: "adaptiveKcalOffsetKcal" }];

  it("sin sesión o con otra identidad (A→B, logout, época distinta): no toca nada", () => {
    for (const cur of [null, { userId: "B", epoch: 1 }, { userId: "A", epoch: 2 }]) {
      const h = harness(stateOf(profile()), { currentIdentity: () => cur });
      const out = handlePlanReadback(id, readback({ slice: { offset: -100, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: null }, conflicts: conflict }), h.deps, newPlanReconcileBudget());
      expect(out.kind).toBe("ignored");
      expect(h.calls.mutate).toBe(0);
      expect(h.calls.ack).toEqual([]);
    }
  });

  it("offset distinto: aplica el del servidor sobre el estado MÁS RECIENTE, avisa y NO reconoce conflictos todavía", () => {
    const h = harness(stateOf(profile({ adaptiveKcalOffsetKcal: 0 })));
    const out = handlePlanReadback(id, readback({ slice: { offset: -100, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: null }, conflicts: conflict }), h.deps, newPlanReconcileBudget());
    expect(out.kind).toBe("reconciled");
    expect(h.getState().profile!.adaptiveKcalOffsetKcal).toBe(-100);
    expect(h.calls.notify.length).toBe(1);
    expect(h.calls.ack).toEqual([]); // se reconocerán cuando una lectura posterior confirme que todo coincide
  });

  it("no modifica nada más del perfil (ediciones legítimas) ni el ledger de otras fechas", () => {
    const base = stateOf(profile({ weightKg: 79, adaptiveKcalOffsetKcal: 0 }), {
      nutritionGoalsHistory: { "2026-10-01": { kcal: 1111, protein: 1, carbs: 1, fat: 1, mode: "fat_loss", calculationVersion: "v", recordedAt: null }, [TODAY]: { kcal: 2039, protein: 160, carbs: 222, fat: 57, mode: "fat_loss", calculationVersion: "nutrition-v3.1", recordedAt: null } } as never,
    });
    const h = harness(base);
    handlePlanReadback(id, readback({ slice: { offset: -100, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: null } }), h.deps, newPlanReconcileBudget());
    expect(h.getState().profile!.weightKg).toBe(79);
    expect(h.getState().nutritionGoalsHistory["2026-10-01"].kcal).toBe(1111);
  });

  it("plan al día + objetivo coincidente: in_sync y SOLO entonces se reconocen los conflictos", () => {
    const h = harness(stateOf(profile()));
    const out = handlePlanReadback(id, readback({ conflicts: conflict }), h.deps, newPlanReconcileBudget());
    expect(out).toEqual({ kind: "in_sync", goalCompared: true });
    expect(h.calls.ack).toEqual([["c1"]]);
    expect(planOutcomeAck(out)).toBe("confirmed");
  });

  it("not_applicable (sin ledger coherente): el plan coincide pero el objetivo NO se comparó → solo se reconocen los conflictos del plan, no los del objetivo", () => {
    const noLedger = stateOf(profile(), { nutritionGoalsHistory: {} as never });
    const h = harness(noLedger);
    const conflicts = [
      { id: "c-off", kind: "offset_overwrite_prevented", subject: "adaptiveKcalOffsetKcal" },
      { id: "c-cal", kind: "calibration_regression_prevented", subject: "adaptiveCalibrationStartedAt" },
      { id: "c-goal", kind: "daily_goal_overwrite_prevented", subject: `goal:${TODAY}` },
      { id: "c-miss", kind: "daily_goal_missing_basis", subject: `goal:${TODAY}` },
    ];
    const out = handlePlanReadback(id, readback({ conflicts }), h.deps, newPlanReconcileBudget());
    expect(out).toEqual({ kind: "in_sync", goalCompared: false });
    expect(h.calls.ack).toEqual([["c-off", "c-cal"]]); // los daily_goal_* siguen abiertos
  });

  it("recibido ≠ confirmado: solo in_sync (y «sin perfil» con la hidratación terminada) confirman; todo lo demás deja la relectura pendiente", () => {
    const pending: Array<Parameters<typeof planOutcomeAck>[0]> = [
      { kind: "reconciled", delta: { offset: -100 } },
      { kind: "deferred_newer_mutation" },
      { kind: "blocked" },
      { kind: "repush", verdict: "basis_stale" },
      { kind: "refresh", verdict: "figures_diverged" },
      { kind: "unresolved", verdict: "server_row_missing" },
      { kind: "ignored", reason: "no_session" },
      { kind: "ignored", reason: "identity_changed" },
      { kind: "ignored", reason: "not_hydrated" },
    ];
    for (const o of pending) expect(planOutcomeAck(o), o.kind).toBe("pending");
    expect(planOutcomeAck({ kind: "in_sync", goalCompared: true })).toBe("confirmed");
    expect(planOutcomeAck({ kind: "in_sync", goalCompared: false })).toBe("confirmed");
    expect(planOutcomeAck({ kind: "ignored", reason: "no_profile" })).toBe("confirmed");
  });

  it("sin perfil: con la hidratación terminada es definitivo (no_profile); mientras carga es provisional (not_hydrated)", () => {
    const empty = stateOf(null);
    const ready = harness(empty);
    expect(handlePlanReadback(id, readback(), ready.deps, newPlanReconcileBudget())).toEqual({ kind: "ignored", reason: "no_profile" });
    const loading = harness(empty, { hydrationReady: () => false });
    expect(handlePlanReadback(id, readback(), loading.deps, newPlanReconcileBudget())).toEqual({ kind: "ignored", reason: "not_hydrated" });
  });

  it("offset y fechas iguales pero objetivo con otra base: re-push (mutate sin cambios), sin reconocer conflictos", () => {
    const h = harness(stateOf(profile()));
    const out = handlePlanReadback(id, readback({ goal: { ...readback().goal!, basisOffsetKcal: -100 }, conflicts: conflict }), h.deps, newPlanReconcileBudget());
    expect(out).toEqual({ kind: "repush", verdict: "basis_stale" });
    expect(h.calls.mutate).toBe(1);
    expect(h.calls.ack).toEqual([]);
  });

  it("offset igual pero cifras distintas: refresca desde el servidor (no sobrescribe ni copia el objetivo), con tope", () => {
    const h = harness(stateOf(profile()));
    const budget = newPlanReconcileBudget();
    const rb = readback({ goal: { ...readback().goal!, kcal: 1900 }, conflicts: conflict });
    expect(handlePlanReadback(id, rb, h.deps, budget).kind).toBe("refresh");
    expect(handlePlanReadback(id, rb, h.deps, budget).kind).toBe("refresh");
    expect(handlePlanReadback(id, rb, h.deps, budget).kind).toBe("unresolved"); // agotado el presupuesto
    expect(h.calls.refresh).toBe(2);
    expect(h.calls.mutate).toBe(0);
    expect(h.calls.ack).toEqual([]);
    expect(h.calls.notify.length).toBe(1); // aviso único
    expect(h.getState().nutrition.kcal).toBe(2039); // nunca se copian cifras del servidor
  });

  it("re-push acotado: tras el tope queda unresolved, sin bucle y sin reconocer conflictos", () => {
    const h = harness(stateOf(profile()));
    const budget = newPlanReconcileBudget();
    const rb = readback({ goal: null, conflicts: conflict });
    const kinds = [1, 2, 3, 4].map(() => handlePlanReadback(id, rb, h.deps, budget).kind);
    expect(kinds).toEqual(["repush", "repush", "unresolved", "unresolved"]);
    expect(h.calls.ack).toEqual([]);
  });

  it("hay una mutación local más nueva: no concluye (ni aplica objetivo ni reconoce) aunque el servidor difiera", () => {
    const h = harness(stateOf(profile()), { isLatestMutation: () => false });
    const out = handlePlanReadback(id, readback({ goal: { ...readback().goal!, kcal: 1900 }, conflicts: conflict }), h.deps, newPlanReconcileBudget());
    expect(out.kind).toBe("deferred_newer_mutation");
    expect(h.calls.refresh).toBe(0);
    expect(h.calls.ack).toEqual([]);
  });

  it("mutaciones bloqueadas: blocked (el proveedor programa una relectura), nunca se da por reconciliado", () => {
    const h = harness(stateOf(profile()), { mutate: () => false });
    const out = handlePlanReadback(id, readback({ slice: { offset: -100, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: null }, conflicts: conflict }), h.deps, newPlanReconcileBudget());
    expect(out.kind).toBe("blocked");
    expect(h.calls.ack).toEqual([]);
    expect(h.calls.notify).toEqual([]);
  });

  it("el recálculo se hace contra el borrador: un cambio de offset entre la lectura y el mutate no se pisa dos veces", () => {
    const fn = vi.fn();
    const h = harness(stateOf(profile({ adaptiveKcalOffsetKcal: 0 })), {
      mutate: (f) => { fn(); const draft = structuredClone(stateOf(profile({ adaptiveKcalOffsetKcal: -100 }))); f(draft); return draft.profile!.adaptiveKcalOffsetKcal === -100; },
    });
    const out = handlePlanReadback(id, readback({ slice: { offset: -100, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: null } }), h.deps, newPlanReconcileBudget());
    expect(out.kind).toBe("reconciled");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
