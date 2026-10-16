// Reproducción C0 de extremo a extremo — «el dispositivo A acepta un ajuste; el dispositivo B conserva el estado
// anterior y sincroniza después» — con el CÓDIGO REAL del cliente (RemoteAdapter.pushState/pullState/
// createAdjustmentReview/acceptAdjustmentProposal, plan-state.ts, calcDailyTargets, recordTodayNutritionGoal)
// contra el ESQUEMA REAL de supabase/migrations/ en un Postgres aislado (PGlite).
//
// Se ejecuta en dos esquemas, con la misma batería:
//   «previo»    = migraciones anteriores a C0 (lo que hay hoy en producción): documenta el defecto;
//   «migrado»   = + 20261014120000_plan_state_protection.sql: verifica la protección y la reconciliación.
//
// Qué NO es: PostgREST (postgrest.mjs lo emula), ni Postgres 17, ni concurrencia (PGlite = UNA conexión; las
// carreras se prueban en .github/workflows/plan-state-concurrency.yml, que aquí NO se ha ejecutado), ni el
// FoodOSProvider (eso lo cubre apps/web/src/lib/plan-state-provider.test.tsx). El «dispositivo» de esta
// batería aplica la reconciliación con handlePlanReadback sobre un estado en memoria y reenvía con un bucle
// acotado; la cola real (outbox) y la hidratación no intervienen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FoodOSState, NutritionCalculationSnapshot, PhysicalProfile } from "@foodos/types";
import { remote } from "../../../apps/web/src/lib/data-layer";
import { calcDailyTargets, calcSummary, evaluateNutritionSafety, NUTRITION_ENGINE_VERSION } from "../../../apps/web/src/lib/nutrition";
import { recordTodayNutritionGoal } from "../../../apps/web/src/lib/state";
import { handlePlanReadback, newPlanReconcileBudget, planOutcomeAck } from "../../../apps/web/src/lib/plan-state";
// @ts-expect-error módulos .mjs sin tipos
import { buildDb, seedUser } from "./schema.mjs";
// @ts-expect-error módulos .mjs sin tipos
import { postgrestLikeClient } from "./postgrest.mjs";

const TODAY = "2026-10-14"; // miércoles (día de gym en el perfil de prueba)
const MODES = [
  { name: "previo", withProtection: false },
  { name: "migrado", withProtection: true },
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const results: Record<string, any> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctxs: Record<string, { db: any; client: any; session: { userId: string } }> = {};

type Remote = { client: unknown; user: unknown; shoppingListId: string; sessionEpoch: number; userMutationsAllowed: boolean };
function useSession(mode: string, userId: string, c?: unknown) {
  const r = remote as unknown as Remote;
  remote.resetSessionState();
  ctxs[mode].session.userId = userId;
  r.client = c ?? ctxs[mode].client;
  r.user = { id: userId };
  r.shoppingListId = "00000000-0000-0000-0000-000000000000";
  r.userMutationsAllowed = true;
}
const pushCtx = (userId: string) => ({ userId, epoch: (remote as unknown as Remote).sessionEpoch, mutationId: `m-${randomUUID()}`, signal: new AbortController().signal });

function profile(over: Partial<PhysicalProfile> = {}): PhysicalProfile {
  return {
    age: 32, sex: "male", heightCm: 178, weightKg: 80, bodyFatPct: null, activityLevel: "moderate", goal: "fat_loss",
    gymDays: [0, 1, 2, 3, 4, 5, 6], allergies: [], excludedFoods: [], adaptiveKcalOffsetKcal: 0,
    adaptiveCalibrationStartedAt: null, lastTargetChangedAt: null, lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION, ...over,
  };
}
function stateFor(p: PhysicalProfile, over: Partial<FoodOSState> = {}): FoodOSState {
  const t = calcDailyTargets(p, true, "balanced");
  const s = {
    inventory: [], cart: [], expenses: [], incomeSources: [], recurringExpenses: [], savingsGoalPct: 20, savingsGoal: null,
    foodLog: [], waterLog: {}, weightLog: [], customRecipes: [], savedRecipeIds: [], profile: p,
    nutrition: { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, mode: p.goal },
    weeklyBudget: 70, bankSynced: false, mascotId: "zana", recipeTag: "todos", macroPreference: "balanced",
    settings: { expiryWarnDays: 3, waterGoalMl: 2500, dinnerSuggestionHour: 18, budgetWarnPct: 80, defaultStore: "Mercadona", lowStockThresholds: { g: 200, ml: 300, L: 0.5, kg: 0.3, ud: 2 }, extraExpenseCategories: [], stepsGoal: 8000 },
    dismissedSuggestions: [], mealPlan: {}, plannerQuickMeals: [], debugDate: TODAY, categoryBudgets: {}, routines: [], workoutLog: [], stepsLog: {},
    pendingAdjustmentProposal: null, lastAdjustmentDecisionAt: null, nutritionGoalsHistory: {}, ...over,
  } as FoodOSState;
  return recordTodayNutritionGoal(s, () => "2026-10-14T08:00:00.000Z");
}
function snapshotFor(p: PhysicalProfile, reason: NutritionCalculationSnapshot["triggerReason"]): NutritionCalculationSnapshot {
  const t = calcDailyTargets(p, true, "balanced");
  const { tmb, tdee } = calcSummary(p);
  return {
    calculationVersion: NUTRITION_ENGINE_VERSION, triggerReason: reason,
    inputSnapshot: { age: p.age, sex: p.sex, heightCm: p.heightCm, weightKg: p.weightKg, goal: p.goal, activityLevel: p.activityLevel, macroPreference: "balanced", activityModelVersion: "legacy_total_pal", trainingActivity: undefined },
    restingEnergy: { valueKcal: tmb, method: "mifflin_st_jeor" }, tdee: { valueKcal: tdee },
    calorieTarget: { kcal: t.kcal, dayType: t.dayType }, macros: { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, fiber: 25 },
    safety: evaluateNutritionSafety({ targetKcal: t.kcal, estimatedTdeeKcal: tdee, restingEnergyKcal: tmb }),
  } as NutritionCalculationSnapshot;
}

/** Un «dispositivo»: estado en memoria + reconciliación real (handlePlanReadback) + bucle de reenvío acotado. */
class Device {
  needsPush = false;
  notices: string[] = [];
  acks: string[][] = [];
  outcomes: string[] = [];
  budget = newPlanReconcileBudget();
  constructor(public mode: string, public userId: string, public state: FoodOSState) {}
  private install() {
    remote.onPlanReadback = ({ userId, epoch, readback }) => {
      const out = handlePlanReadback({ userId, epoch }, readback, {
        currentIdentity: () => (remote.user ? { userId: remote.user.id, epoch: remote.sessionEpoch } : null),
        getState: () => this.state,
        mutate: (fn) => {
          const draft = structuredClone(this.state);
          if (fn(draft) === false) return true;
          if (draft.profile) {
            const t = calcDailyTargets(draft.profile, true, draft.macroPreference);
            draft.nutrition = { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, mode: draft.profile.goal };
            const withToday = recordTodayNutritionGoal(draft, () => "2026-10-14T09:00:00.000Z");
            if (withToday !== draft) draft.nutritionGoalsHistory = withToday.nutritionGoalsHistory;
          }
          this.state = draft;
          this.needsPush = true;
          return true;
        },
        todayKey: () => TODAY,
        isLatestMutation: () => true,
        hydrationReady: () => true,
        requestRefresh: () => { this.outcomes.push("refresh"); },
        notify: (m) => this.notices.push(m),
        acknowledgeConflicts: (_u, _e, ids) => {
          this.acks.push(ids);
          void remote.ackPlanConflicts(userId, epoch, ids);
        },
      }, this.budget);
      this.outcomes.push(out.kind);
      return planOutcomeAck(out);
    };
  }
  /** Envía el estado y reconcilia hasta que no haya nada más que enviar (máx. 6 vueltas). */
  async sync() {
    useSession(this.mode, this.userId);
    this.install();
    for (let i = 0; i < 6; i++) {
      this.needsPush = false;
      await remote.pushState(pushCtx(this.userId), this.state);
      if (!this.needsPush) break;
    }
  }
}

async function serverView(mode: string, userId: string) {
  const { db } = ctxs[mode];
  const prof = (await db.query(`select extra_state, activity_level from public.user_profiles where user_id=$1`, [userId])).rows[0];
  const ex = (prof.extra_state ?? {}) as Record<string, unknown>;
  const goal = (await db.query(`select kcal_target::float as kcal, ${mode === "migrado" ? "basis_offset_kcal as basis," : ""} calculation_version as ver from public.nutrition_goals where user_id=$1 and goal_date=$2`, [userId, TODAY])).rows[0] ?? null;
  const proposals = (await db.query(`select status from public.nutrition_adjustment_proposals where user_id=$1`, [userId])).rows.map((r: { status: string }) => r.status);
  const snaps = (await db.query(`select count(*)::int as n from public.nutrition_calculation_snapshots where user_id=$1 and trigger_reason='adaptive_adjustment_accepted'`, [userId])).rows[0].n;
  const openConflicts = mode === "migrado"
    ? (await db.query(`select kind from public.nutrition_sync_conflicts where user_id=$1 and acknowledged_at is null order by kind`, [userId])).rows.map((r: { kind: string }) => r.kind)
    : [];
  return { offset: ex.adaptiveKcalOffsetKcal ?? null, calibration: ex.adaptiveCalibrationStartedAt ?? null, activityLevel: prof.activity_level as string, goal, proposals, acceptedSnapshots: snaps, openConflicts };
}

async function bootstrap(mode: string) {
  const userId = randomUUID();
  await seedUser(ctxs[mode].db, userId);
  const s0 = stateFor(profile());
  const d = new Device(mode, userId, s0);
  await d.sync();
  return { userId, s0 };
}

/** Lo que haría NutritionView: crear la propuesta (-100) y aceptarla desde el dispositivo. */
async function acceptFrom(mode: string, userId: string, state: FoodOSState, opts: { loseResponse?: boolean } = {}) {
  useSession(mode, userId);
  const p = state.profile!;
  const created = await remote.createAdjustmentReview({
    snapshot: snapshotFor(p, "adaptive_review"),
    decision: { shouldPropose: true, deltaKcal: -100, proposedTargetKcal: state.nutrition.kcal - 100, reason: "prueba", trajectory: "above", blockingReasons: [] },
    evidence: { evaluationWindow: { start: "2026-09-16", end: TODAY }, intakeCoverage: 0.9, averageIntakeKcal: 2300, weightMeasurements: 22, regressionSlopeKgPerDay: 0, confidence: "high", weightTrendQualityScore: 0.9, initialTdeeKcal: 2549, observedTdeeKcal: 2400, combinedTdeeKcal: 2480, warnings: [], engineVersion: NUTRITION_ENGINE_VERSION },
  });
  if (created.kind !== "ok" || !created.value) throw new Error("no se creó la propuesta: " + JSON.stringify(created));
  const proposal = created.value;
  const nextOffset = (p.adaptiveKcalOffsetKcal ?? 0) + proposal.deltaKcal;
  const nextProfile = { ...p, adaptiveKcalOffsetKcal: nextOffset };
  const nt = calcDailyTargets(nextProfile, true, "balanced");
  const real = ctxs[mode].client;
  const c = opts.loseResponse
    ? { ...real, rpc: async (name: string, args: unknown) => { const r = await real.rpc(name, args); return name === "fn_accept_nutrition_adjustment" ? { data: null, error: { message: "Failed to fetch" } } : r; } }
    : real;
  useSession(mode, userId, c);
  const res = await remote.acceptAdjustmentProposal({
    proposalId: proposal.id, accepted: true, goalDate: TODAY, newOffsetKcal: nextOffset,
    kcalTarget: nt.kcal, proteinG: nt.protein, carbsG: nt.carbs, fatG: nt.fat, mode: nextProfile.goal,
    finalSnapshot: snapshotFor(nextProfile, "adaptive_adjustment_accepted"),
  });
  let next = state;
  if (res.ok) {
    next = recordTodayNutritionGoal({ ...state, profile: nextProfile, nutrition: { kcal: nt.kcal, protein: nt.protein, carbs: nt.carbs, fat: nt.fat, mode: nextProfile.goal }, lastAdjustmentDecisionAt: TODAY } as FoodOSState, () => "2026-10-14T09:00:00.000Z");
  }
  return { proposal, result: res, state: next, nextOffset, nextTargets: nt };
}

beforeAll(async () => {
  for (const m of MODES) {
    const { db } = await buildDb({ withProtection: m.withProtection });
    const session = { userId: "" };
    ctxs[m.name] = { db, client: postgrestLikeClient(db, session), session };
  }
});
afterAll(() => {
  const dir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "repro.json", JSON.stringify({ note: "datos sintéticos; PGlite una conexión; cliente real; PostgREST emulado", results }, null, 2));
});

describe.each(MODES)("C0 [$name] — A acepta; B conserva el estado anterior y sincroniza después", ({ name: mode }) => {
  const migrated = mode === "migrado";

  it("R1: B (obsoleto) registra un peso y sincroniza → offset, objetivo del día, calibración e historial tras relectura", async () => {
    const { userId, s0 } = await bootstrap(mode);
    const A = await acceptFrom(mode, userId, structuredClone(s0));
    expect(A.result.ok).toBe(true);
    const afterAccept = await serverView(mode, userId);
    expect(afterAccept.offset).toBe(-100);

    const B = new Device(mode, userId, { ...structuredClone(s0), weightLog: [{ date: TODAY, kg: 79.6 }] } as FoodOSState);
    await B.sync();
    // Segunda sincronización (p. ej. al volver a abrir): estabilidad, sin bucles.
    await B.sync();

    const server = await serverView(mode, userId);
    // Relectura como un dispositivo nuevo
    useSession(mode, userId);
    const pulled = await remote.pullState(stateFor(profile(), { profile: null }));
    results[`R1/${mode}`] = { afterAccept: { offset: afterAccept.offset, kcal: afterAccept.goal?.kcal }, server, bLocalOffset: B.state.profile?.adaptiveKcalOffsetKcal, bOutcomes: B.outcomes, freshDeviceOffset: pulled.profile?.adaptiveKcalOffsetKcal ?? null };

    expect(server.proposals).toEqual(["accepted"]); // historial intacto
    expect(server.acceptedSnapshots).toBe(1);
    if (migrated) {
      expect(server.offset).toBe(-100);
      expect(pulled.profile?.adaptiveKcalOffsetKcal).toBe(-100);
      expect(B.state.profile?.adaptiveKcalOffsetKcal).toBe(-100); // B adopta el offset
      expect(B.state.nutrition.kcal).toBe(A.nextTargets.kcal); // y recalcula HOY con él
      expect(server.goal).toMatchObject({ kcal: A.nextTargets.kcal, basis: -100 });
      expect(B.notices.length).toBe(1); // el cambio se muestra
      expect(server.openConflicts).toEqual([]); // y los conflictos se reconocen al estar en sincronía
      expect(B.outcomes.at(-1)).toBe("in_sync");
    } else {
      // Defecto vigente: el offset aceptado desaparece aunque el historial diga «aceptado».
      expect(server.offset).toBe(0);
      expect(pulled.profile?.adaptiveKcalOffsetKcal).toBe(0);
      expect(server.goal?.kcal).toBe(s0.nutrition.kcal);
    }
  });

  it("R2: la calibración reiniciada por un cambio legítimo en A no retrocede por el push obsoleto de B", async () => {
    const { userId, s0 } = await bootstrap(mode);
    const pa = profile({ activityLevel: "active", adaptiveCalibrationStartedAt: TODAY, lastTargetChangedAt: TODAY });
    await new Device(mode, userId, stateFor(pa)).sync();
    const B = new Device(mode, userId, { ...structuredClone(s0), weightLog: [{ date: TODAY, kg: 79.7 }] } as FoodOSState);
    await B.sync();
    const server = await serverView(mode, userId);
    results[`R2/${mode}`] = { server, bCalibration: B.state.profile?.adaptiveCalibrationStartedAt ?? null };
    expect(server.calibration).toBe(migrated ? TODAY : null);
    if (migrated) expect(B.state.profile?.adaptiveCalibrationStartedAt).toBe(TODAY); // B la adopta
    // Residual declarado, fuera de C0: las columnas del perfil siguen con «último escritor gana».
    expect(server.activityLevel).toBe("moderate");
  });

  it("R3: cambio LEGÍTIMO de B (actividad) tras la aceptación de A → se conserva, y su objetivo se recalcula con el offset de A", async () => {
    const { userId, s0 } = await bootstrap(mode);
    const A = await acceptFrom(mode, userId, structuredClone(s0));
    expect(A.result.ok).toBe(true);
    const pb = profile({ activityLevel: "active", adaptiveCalibrationStartedAt: TODAY, lastTargetChangedAt: TODAY });
    const B = new Device(mode, userId, stateFor(pb));
    await B.sync();
    const server = await serverView(mode, userId);
    const expected = calcDailyTargets({ ...pb, adaptiveKcalOffsetKcal: -100 }, true, "balanced");
    results[`R3/${mode}`] = { server, bLocalKcal: B.state.nutrition.kcal, expectedKcal: expected.kcal };
    expect(server.activityLevel).toBe("active"); // el cambio legítimo de B se conserva en ambos esquemas
    if (migrated) {
      expect(server.offset).toBe(-100);
      expect(B.state.profile?.adaptiveKcalOffsetKcal).toBe(-100);
      expect(server.goal).toMatchObject({ kcal: expected.kcal, basis: -100 }); // actividad de B + offset de A
    } else {
      expect(server.offset).toBe(0);
    }
  });

  it("R4: respuesta perdida tras confirmar → el servidor lo conserva, el dispositivo lo adopta; el reintento sigue sin ser idempotente (C2)", async () => {
    const { userId, s0 } = await bootstrap(mode);
    const A = await acceptFrom(mode, userId, structuredClone(s0), { loseResponse: true });
    expect(A.result.ok).toBe(false); // el cliente ve un fallo…
    expect((await serverView(mode, userId)).offset).toBe(-100); // …pero el servidor lo aplicó

    useSession(mode, userId);
    const retry = await remote.acceptAdjustmentProposal({
      proposalId: A.proposal.id, accepted: true, goalDate: TODAY, newOffsetKcal: A.nextOffset, kcalTarget: A.nextTargets.kcal,
      proteinG: A.nextTargets.protein, carbsG: A.nextTargets.carbs, fatG: A.nextTargets.fat, mode: "fat_loss",
      finalSnapshot: snapshotFor({ ...profile(), adaptiveKcalOffsetKcal: A.nextOffset }, "adaptive_adjustment_accepted"),
    });
    expect(retry.ok).toBe(false);

    // El mismo dispositivo, con su estado local sin el ajuste, sincroniza otra edición.
    const dev = new Device(mode, userId, { ...structuredClone(s0), weightLog: [{ date: TODAY, kg: 79.5 }] } as FoodOSState);
    await dev.sync();
    const server = await serverView(mode, userId);
    results[`R4/${mode}`] = { clientSawOk: A.result.ok, retryOk: retry.ok, retryError: (retry as { error?: string }).error?.slice(0, 40), server, deviceOffset: dev.state.profile?.adaptiveKcalOffsetKcal };
    expect(server.proposals).toEqual(["accepted"]);
    expect(server.offset).toBe(migrated ? -100 : 0);
    if (migrated) expect(dev.state.profile?.adaptiveKcalOffsetKcal).toBe(-100);
  });

  it("R5: cambio de cuenta durante el push → nada de A se escribe sobre B ni sobre A", async () => {
    const a = await bootstrap(mode);
    const b = await bootstrap(mode);
    const beforeA = await serverView(mode, a.userId);
    const beforeB = await serverView(mode, b.userId);

    useSession(mode, b.userId); // la sesión del cliente ya es la de B…
    const staleA = { ...structuredClone(a.s0), weightLog: [{ date: TODAY, kg: 70 }] } as FoodOSState;
    let threw = false;
    try { await remote.pushState(pushCtx(a.userId), staleA); } catch { threw = true; } // …y llega un push de A
    const r = remote as unknown as Remote;
    const c = pushCtx(a.userId);
    r.sessionEpoch += 1; // o la época ya cambió
    let aborted = false;
    try { await remote.pushState(c, staleA); } catch { aborted = true; }
    r.sessionEpoch -= 1;

    expect((await serverView(mode, a.userId))).toEqual(beforeA);
    expect((await serverView(mode, b.userId))).toEqual(beforeB);
    results[`R5/${mode}`] = { pushUnderOtherSessionThrew: threw, staleEpochAborted: aborted };
    expect(threw).toBe(true);
    expect(aborted).toBe(true);
  });
});

describe("C0 [migrado] — cliente antiguo (sin protocolo) tras la migración", () => {
  it("el upsert habitual de un cliente antiguo no quita el sello ni cambia un objetivo sellado; el offset y la calibración se conservan", async () => {
    const mode = "migrado";
    const { userId, s0 } = await bootstrap(mode);
    const A = await acceptFrom(mode, userId, structuredClone(s0));
    expect(A.result.ok).toBe(true);
    // Cliente antiguo: sin cabecera de protocolo y sin base en sus escrituras (servidor «sin sonda»).
    const oldClient = postgrestLikeClient(ctxs[mode].db, ctxs[mode].session, { clientInfo: null });
    const stale = { ...structuredClone(s0), weightLog: [{ date: TODAY, kg: 79.6 }] } as FoodOSState;
    // Simula que el cliente antiguo no sondea: fuerza «ausente» para que no envíe base ni lea.
    useSession(mode, userId, { ...oldClient, rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) });
    await remote.pushState(pushCtx(userId), stale);
    const server = await serverView(mode, userId);
    results["antiguo/migrado"] = server;
    expect(server.offset).toBe(-100);
    expect(server.goal).toMatchObject({ kcal: A.nextTargets.kcal, basis: -100 });
    expect(server.openConflicts).toContain("daily_goal_overwrite_prevented");
  });
});
