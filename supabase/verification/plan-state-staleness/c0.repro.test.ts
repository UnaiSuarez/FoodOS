// Reproducción C0 — "un dispositivo obsoleto sincroniza después de que otro aceptó un ajuste".
//
// Qué ejecuta de verdad:
//   - el código REAL de cliente (RemoteAdapter.pushState / pullState / createAdjustmentReview /
//     acceptAdjustmentProposal, calcDailyTargets, recordTodayNutritionGoal) de apps/web/src/lib;
//   - el esquema REAL de supabase/migrations/ y la función REAL fn_accept_nutrition_adjustment, sobre un
//     Postgres aislado en memoria (PGlite), con RLS, GRANT y rol `authenticated`.
// Qué NO es: PostgREST (ver postgrest.mjs), ni el Postgres 17 de Supabase, ni concurrencia: PGlite tiene UNA
// conexión, las operaciones se ejecutan una detrás de otra. Este fallo es de ORDEN (el último en escribir
// gana), no de carrera, así que la reproducción es válida; las carreras reales (dos conexiones) quedan sin
// demostrar y se declaran en README.md.
//
// Dos modos (misma batería, aserciones distintas):
//   C0_GUARD no definida  → esquema vigente tal cual: documenta el defecto.
//   C0_GUARD=1            → aplica además candidate-c0-guard.sql: verifica la protección propuesta.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FoodOSState, NutritionCalculationSnapshot, PhysicalProfile } from "@foodos/types";
import { remote } from "../../../apps/web/src/lib/data-layer";
import { calcDailyTargets, calcSummary, evaluateNutritionSafety, NUTRITION_ENGINE_VERSION } from "../../../apps/web/src/lib/nutrition";
import { recordTodayNutritionGoal } from "../../../apps/web/src/lib/state";
// @ts-expect-error módulos .mjs sin tipos
import { buildDb, seedUser, asUser } from "./schema.mjs";
// @ts-expect-error módulos .mjs sin tipos
import { postgrestLikeClient } from "./postgrest.mjs";

const GUARDED = process.env.C0_GUARD === "1";
const MODE = GUARDED ? "guarded" : "current";
const TODAY = "2026-10-14"; // miércoles (día de gym en el perfil de prueba)
const LATER = "2026-10-15";

// ─── Infraestructura ────────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
const session = { userId: "" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const results: Record<string, any> = {};

type Remote = { client: unknown; user: unknown; shoppingListId: string; sessionEpoch: number; userMutationsAllowed: boolean };
function useSession(userId: string, c: unknown = client) {
  const r = remote as unknown as Remote;
  session.userId = userId;
  r.client = c;
  r.user = { id: userId };
  r.shoppingListId = "00000000-0000-0000-0000-000000000000";
  r.userMutationsAllowed = true;
}
function ctx(userId: string) {
  return { userId, epoch: (remote as unknown as Remote).sessionEpoch, mutationId: `m-${randomUUID()}`, signal: new AbortController().signal };
}

function profile(over: Partial<PhysicalProfile> = {}): PhysicalProfile {
  return {
    age: 32, sex: "male", heightCm: 178, weightKg: 80, bodyFatPct: null, activityLevel: "moderate",
    goal: "fat_loss", gymDays: [1, 3, 5], allergies: [], excludedFoods: [], adaptiveKcalOffsetKcal: 0,
    adaptiveCalibrationStartedAt: null, lastTargetChangedAt: null, lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION,
    ...over,
  };
}

function stateFor(p: PhysicalProfile, over: Partial<FoodOSState> = {}): FoodOSState {
  const t = calcDailyTargets(p, true, "balanced");
  const s = {
    inventory: [], cart: [], expenses: [], incomeSources: [], recurringExpenses: [], savingsGoalPct: 20, savingsGoal: null,
    foodLog: [], waterLog: {}, weightLog: [], customRecipes: [], savedRecipeIds: [], profile: p,
    nutrition: { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, mode: p.goal },
    weeklyBudget: 70, bankSynced: false, mascotId: "zana", recipeTag: "todos", macroPreference: "balanced",
    settings: { expiryWarnDays: 3, waterGoalMl: 2500, dinnerSuggestionHour: 18, budgetWarnPct: 80, defaultStore: "Mercadona",
      lowStockThresholds: { g: 200, ml: 300, L: 0.5, kg: 0.3, ud: 2 }, extraExpenseCategories: [], stepsGoal: 8000 },
    dismissedSuggestions: [], mealPlan: {}, plannerQuickMeals: [], debugDate: TODAY, categoryBudgets: {}, routines: [],
    workoutLog: [], stepsLog: {}, pendingAdjustmentProposal: null, lastAdjustmentDecisionAt: null, nutritionGoalsHistory: {},
    ...over,
  } as FoodOSState;
  return recordTodayNutritionGoal(s, () => "2026-10-14T08:00:00.000Z");
}

function snapshotFor(p: PhysicalProfile, reason: NutritionCalculationSnapshot["triggerReason"]): NutritionCalculationSnapshot {
  const t = calcDailyTargets(p, true, "balanced");
  const { tmb, tdee } = calcSummary(p);
  return {
    calculationVersion: NUTRITION_ENGINE_VERSION, triggerReason: reason,
    inputSnapshot: { age: p.age, sex: p.sex, heightCm: p.heightCm, weightKg: p.weightKg, goal: p.goal, activityLevel: p.activityLevel,
      macroPreference: "balanced", activityModelVersion: "legacy_total_pal", trainingActivity: undefined },
    restingEnergy: { valueKcal: tmb, method: "mifflin_st_jeor" }, tdee: { valueKcal: tdee },
    calorieTarget: { kcal: t.kcal, dayType: t.dayType },
    macros: { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, fiber: 25 },
    safety: evaluateNutritionSafety({ targetKcal: t.kcal, estimatedTdeeKcal: tdee, restingEnergyKcal: tmb }),
  } as NutritionCalculationSnapshot;
}

/** Cuenta con un dispositivo inicial sincronizado: perfil, ledger de hoy y objetivo de hoy en servidor. */
async function bootstrapAccount() {
  const userId = randomUUID();
  await seedUser(db, userId);
  useSession(userId);
  const s0 = stateFor(profile());
  await remote.pushState(ctx(userId), s0);
  return { userId, s0 };
}

/** Lo que haría NutritionView: crear propuesta (-100) y aceptarla desde el dispositivo `state`. */
async function acceptFromDevice(userId: string, state: FoodOSState, opts: { loseResponse?: boolean } = {}) {
  const p = state.profile!;
  const created = await remote.createAdjustmentReview({
    snapshot: snapshotFor(p, "adaptive_review"),
    decision: { shouldPropose: true, deltaKcal: -100, proposedTargetKcal: state.nutrition.kcal - 100, reason: "prueba", trajectory: "above", blockingReasons: [] },
    evidence: { evaluationWindow: { start: "2026-09-16", end: TODAY }, intakeCoverage: 0.9, averageIntakeKcal: 2300, weightMeasurements: 22,
      regressionSlopeKgPerDay: 0, confidence: "high", weightTrendQualityScore: 0.9, initialTdeeKcal: 2549, observedTdeeKcal: 2400,
      combinedTdeeKcal: 2480, warnings: [], engineVersion: NUTRITION_ENGINE_VERSION },
  });
  if (created.kind !== "ok" || !created.value) throw new Error("no se creó la propuesta: " + JSON.stringify(created));
  const proposal = created.value;
  const nextOffset = (p.adaptiveKcalOffsetKcal ?? 0) + proposal.deltaKcal;
  const nextProfile = { ...p, adaptiveKcalOffsetKcal: nextOffset };
  const nt = calcDailyTargets(nextProfile, true, "balanced");

  let c = client;
  if (opts.loseResponse) {
    // La transacción SE CONFIRMA en el servidor, pero la respuesta no llega al cliente.
    c = { ...client, rpc: async (name: string, args: unknown) => { await client.rpc(name, args); return { data: null, error: { message: "Failed to fetch" } }; } };
  }
  useSession(userId, c);
  const res = await remote.acceptAdjustmentProposal({
    proposalId: proposal.id, accepted: true, goalDate: TODAY, newOffsetKcal: nextOffset,
    kcalTarget: nt.kcal, proteinG: nt.protein, carbsG: nt.carbs, fatG: nt.fat, mode: nextProfile.goal,
    finalSnapshot: snapshotFor(nextProfile, "adaptive_adjustment_accepted"),
  });
  useSession(userId, client);
  let next = state;
  if (res.ok) {
    // mutate() de NutritionView tras ok:true
    next = recordTodayNutritionGoal(
      { ...state, profile: nextProfile, nutrition: { kcal: nt.kcal, protein: nt.protein, carbs: nt.carbs, fat: nt.fat, mode: nextProfile.goal },
        pendingAdjustmentProposal: null, lastAdjustmentDecisionAt: TODAY } as FoodOSState,
      () => "2026-10-14T09:00:00.000Z",
    );
  }
  return { proposal, result: res, state: next, nextOffset, nextTargets: nt };
}

async function serverView(userId: string) {
  const prof = (await db.query(`select extra_state, activity_level, goal from public.user_profiles where user_id=$1`, [userId])).rows[0];
  const ex = prof.extra_state ?? {};
  const goals = (await db.query(`select goal_date::text as d, kcal_target::float as kcal, protein_target_g::float as protein, mode, source_snapshot_id is not null as sealed${GUARDED ? ", basis_offset_kcal" : ""} from public.nutrition_goals where user_id=$1 order by goal_date`, [userId])).rows;
  const proposals = (await db.query(`select status, delta_kcal from public.nutrition_adjustment_proposals where user_id=$1`, [userId])).rows;
  const snaps = (await db.query(`select trigger_reason, count(*)::int as n from public.nutrition_calculation_snapshots where user_id=$1 group by 1 order by 1`, [userId])).rows;
  const conflicts = GUARDED
    ? (await db.query(`select kind, subject, kept, attempted from public.nutrition_sync_conflicts where user_id=$1 order by kind, subject`, [userId])).rows
    : [];
  return {
    offset: ex.adaptiveKcalOffsetKcal ?? null,
    calibration: ex.adaptiveCalibrationStartedAt ?? null,
    lastTargetChangedAt: ex.lastTargetChangedAt ?? null,
    activityLevel: prof.activity_level as string,
    goalColumn: prof.goal as string,
    goals, proposals, snapshots: snaps, conflicts,
  };
}

/** Relectura como la haría un dispositivo nuevo (pullState real). */
async function freshDeviceView(userId: string) {
  useSession(userId);
  const defaults = stateFor(profile(), { profile: null, nutritionGoalsHistory: {} });
  const pulled = await remote.pullState(defaults);
  return {
    offset: pulled.profile?.adaptiveKcalOffsetKcal ?? null,
    calibration: pulled.profile?.adaptiveCalibrationStartedAt ?? null,
    pending: pulled.pendingAdjustmentProposal?.id ?? null,
    lastDecision: pulled.lastAdjustmentDecisionAt ?? null,
  };
}

beforeAll(async () => {
  const extraSql = GUARDED ? [readFileSync(fileURLToPath(new URL("./candidate-c0-guard.sql", import.meta.url)), "utf8")] : [];
  const built = await buildDb({ extraSql });
  db = built.db;
  client = postgrestLikeClient(db, session);
});

afterAll(() => {
  const dir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + `${MODE}.json`, JSON.stringify({ mode: MODE, note: "datos sintéticos; PGlite una conexión; ver README.md", results }, null, 2));
});

// ─── Casos ──────────────────────────────────────────────────────────────────────────────────────
describe(`C0 [${MODE}] — A acepta; B conserva el estado anterior y sincroniza después`, () => {
  it("R1: un cambio no relacionado en B (peso) NO debe deshacer offset ni objetivo del día", async () => {
    const { userId, s0 } = await bootstrapAccount();
    const A = await acceptFromDevice(userId, structuredClone(s0));
    expect(A.result.ok).toBe(true);
    const afterAccept = await serverView(userId);
    expect(afterAccept.offset).toBe(-100);

    // B: mismo estado base que A tenía; el usuario registra un peso y la app empuja el snapshot COMPLETO.
    const B = structuredClone(s0);
    B.weightLog = [{ date: TODAY, kg: 79.6 }];
    useSession(userId);
    await remote.pushState(ctx(userId), B);

    const server = await serverView(userId);
    const fresh = await freshDeviceView(userId);
    results.R1 = { afterAccept: { offset: afterAccept.offset, goal: afterAccept.goals.at(-1)?.kcal }, afterStalePush: server, freshDevice: fresh,
      expectedAcceptedKcal: A.nextTargets.kcal, staleKcal: s0.nutrition.kcal };

    // Historial (propuesta aceptada + snapshot final) nunca lo toca pushState:
    expect(server.proposals).toEqual([{ status: "accepted", delta_kcal: -100 }]);
    expect(server.snapshots.find((s: { trigger_reason: string }) => s.trigger_reason === "adaptive_adjustment_accepted")?.n).toBe(1);
    // El defecto:
    expect(server.offset).toBe(GUARDED ? -100 : 0);
    expect(fresh.offset).toBe(GUARDED ? -100 : 0);
    expect(server.goals.find((g: { d: string }) => g.d === TODAY)?.kcal).toBe(GUARDED ? A.nextTargets.kcal : s0.nutrition.kcal);
    if (GUARDED) expect(server.conflicts.map((c: { kind: string }) => c.kind)).toContain("offset_overwrite_prevented");
  });

  it("R2: la calibración reiniciada por un cambio legítimo en A no retrocede por un push obsoleto de B", async () => {
    const { userId, s0 } = await bootstrapAccount();
    // A cambia su perfil de forma legítima (isRelevantCalibrationChange → reinicia la calibración a hoy)
    const pa = profile({ activityLevel: "active", adaptiveCalibrationStartedAt: TODAY, lastTargetChangedAt: TODAY });
    const A = stateFor(pa);
    useSession(userId);
    await remote.pushState(ctx(userId), A);
    const afterA = await serverView(userId);
    expect(afterA.calibration).toBe(TODAY);

    const B = structuredClone(s0); // nunca vio el cambio
    B.weightLog = [{ date: TODAY, kg: 79.7 }];
    await remote.pushState(ctx(userId), B);
    const server = await serverView(userId);
    results.R2 = { afterA: { calibration: afterA.calibration, activityLevel: afterA.activityLevel }, afterStalePush: server };
    expect(server.calibration).toBe(GUARDED ? TODAY : null);
    expect(server.lastTargetChangedAt).toBe(GUARDED ? TODAY : null);
    // Residual declarado (no es objeto de C0): columnas de perfil con "último escritor gana".
    expect(server.activityLevel).toBe("moderate");
  });

  it("R3: cambio LEGÍTIMO de perfil en B (obsoleto): se conserva el cambio de B, el offset de A y se señala el conflicto del objetivo", async () => {
    const { userId, s0 } = await bootstrapAccount();
    const A = await acceptFromDevice(userId, structuredClone(s0));
    expect(A.result.ok).toBe(true);

    // B (sin haber sincronizado) cambia a actividad "active": calibración a hoy (otra fecha) y objetivo recalculado
    // con SU offset local (0), que es el obsoleto.
    const pb = profile({ activityLevel: "active", adaptiveCalibrationStartedAt: LATER, lastTargetChangedAt: LATER });
    const B = stateFor(pb, { debugDate: LATER });
    useSession(userId);
    await remote.pushState(ctx(userId), B);

    const server = await serverView(userId);
    results.R3 = { acceptedOffset: A.nextOffset, afterBPush: server, bStaleLocalKcal: B.nutrition.kcal, aAcceptedKcal: A.nextTargets.kcal };
    expect(server.activityLevel).toBe("active"); // el cambio legítimo de B se conserva en ambos modos
    expect(server.calibration).toBe(LATER); // fecha posterior (la de B) gana en ambos modos
    expect(server.offset).toBe(GUARDED ? -100 : 0);
    if (GUARDED) {
      // El objetivo de HOY (A) no lo pisa B; el de LATER se escribe sin base → cliente antiguo: pasa (fila nueva sin sellar).
      expect(server.goals.find((g: { d: string }) => g.d === TODAY)?.kcal).toBe(A.nextTargets.kcal);
    }
  });

  it("R4: respuesta perdida tras confirmar → el dispositivo cree que falló y su siguiente push revierte lo confirmado", async () => {
    const { userId, s0 } = await bootstrapAccount();
    const A = await acceptFromDevice(userId, structuredClone(s0), { loseResponse: true });
    expect(A.result.ok).toBe(false); // el cliente ve un fallo…
    const committed = await serverView(userId);
    expect(committed.offset).toBe(-100); // …pero el servidor SÍ lo aplicó
    expect(committed.proposals).toEqual([{ status: "accepted", delta_kcal: -100 }]);

    // El reintento NO es idempotente hoy: la propuesta ya no está pendiente.
    useSession(userId);
    const retry = await remote.acceptAdjustmentProposal({
      proposalId: A.proposal.id, accepted: true, goalDate: TODAY, newOffsetKcal: A.nextOffset,
      kcalTarget: A.nextTargets.kcal, proteinG: A.nextTargets.protein, carbsG: A.nextTargets.carbs, fatG: A.nextTargets.fat,
      mode: "fat_loss", finalSnapshot: snapshotFor({ ...profile(), adaptiveKcalOffsetKcal: A.nextOffset }, "adaptive_adjustment_accepted"),
    });
    expect(retry.ok).toBe(false);

    // El mismo dispositivo A, con su estado local sin el ajuste, sincroniza otra edición cualquiera.
    const A2 = structuredClone(s0);
    A2.weightLog = [{ date: TODAY, kg: 79.5 }];
    await remote.pushState(ctx(userId), A2);
    const server = await serverView(userId);
    results.R4 = { clientSawOk: A.result.ok, retryOk: retry.ok, retryError: (retry as { error?: string }).error?.slice(0, 40), committed: { offset: committed.offset }, afterOwnPush: server };
    expect(server.offset).toBe(GUARDED ? -100 : 0);
    expect(server.proposals).toEqual([{ status: "accepted", delta_kcal: -100 }]);
  });

  it("R5: cambio de cuenta durante el push → nada de A se escribe sobre B ni sobre A", async () => {
    const a = await bootstrapAccount();
    const b = await bootstrapAccount();
    const beforeA = await serverView(a.userId);
    const beforeB = await serverView(b.userId);

    // La sesión del cliente pasa a B mientras un push de A (contexto de A) sigue en cola.
    useSession(b.userId);
    const staleA = structuredClone(a.s0);
    staleA.weightLog = [{ date: TODAY, kg: 70 }];
    let threw = false;
    try { await remote.pushState(ctx(a.userId), staleA); } catch { threw = true; }

    // Y con el epoch ya cambiado, ni siquiera llega a escribir.
    const r = remote as unknown as Remote;
    const c = ctx(a.userId);
    r.sessionEpoch += 1;
    let aborted = false;
    try { await remote.pushState(c, staleA); } catch { aborted = true; }
    r.sessionEpoch -= 1;

    const afterA = await serverView(a.userId);
    const afterB = await serverView(b.userId);
    results.R5 = { pushUnderOtherSessionThrew: threw, staleEpochAborted: aborted, aUnchanged: JSON.stringify(beforeA) === JSON.stringify(afterA), bUnchanged: JSON.stringify(beforeB) === JSON.stringify(afterB) };
    expect(threw).toBe(true);
    expect(aborted).toBe(true);
    expect(afterA.offset).toEqual(beforeA.offset);
    expect(afterB).toEqual(beforeB);
  });
});

describe.skipIf(!GUARDED)("C0 [guarded] — contrato del servidor con y sin base (carga útil elaborada a mano)", () => {
  async function asClient(userId: string, fn: () => Promise<unknown>) { return asUser(db, userId, fn); }

  it("S1: base == offset vigente → se acepta; base obsoleta → se conserva lo almacenado y se registra; sin base sobre fila sellada → igual", async () => {
    const { userId, s0 } = await bootstrapAccount();
    const A = await acceptFromDevice(userId, structuredClone(s0));
    expect(A.result.ok).toBe(true); // offset -100, fila de hoy sellada con base -100
    const sealed = A.nextTargets.kcal;

    const up = (row: Record<string, unknown>) => asClient(userId, () => db.query(
      `insert into public.nutrition_goals (user_id, goal_date, kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode, calculation_version ${"basis_offset_kcal" in row ? ", basis_offset_kcal" : ""})
       values ($1, $2, $3, 150, 200, 60, 'fat_loss', 'nutrition-v3.1' ${"basis_offset_kcal" in row ? ", $4" : ""})
       on conflict (user_id, goal_date) do update set kcal_target = excluded.kcal_target ${"basis_offset_kcal" in row ? ", basis_offset_kcal = excluded.basis_offset_kcal" : ""}`,
      "basis_offset_kcal" in row ? [userId, TODAY, row.kcal, row.basis_offset_kcal] : [userId, TODAY, row.kcal],
    ));
    const kcal = async () => (await serverView(userId)).goals.find((g: { d: string }) => g.d === TODAY)?.kcal;

    await up({ kcal: 1111, basis_offset_kcal: -100 }); // base vigente → legítimo
    const accepted = await kcal();
    await up({ kcal: 2222, basis_offset_kcal: 0 }); // base obsoleta
    const afterStaleBasis = await kcal();
    await up({ kcal: 3333 }); // sin base (cliente antiguo) sobre fila sellada
    const afterNoBasis = await kcal();
    // Fila de un día NUEVO (camino INSERT de un upsert): base obsoleta → no se crea; base vigente → se crea.
    const insertNew = (kcalV: number, basis: number | null) => asClient(userId, () => db.query(
      `insert into public.nutrition_goals (user_id, goal_date, kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode, calculation_version, basis_offset_kcal)
       values ($1, $2, $3, 150, 200, 60, 'fat_loss', 'nutrition-v3.1', $4)
       on conflict (user_id, goal_date) do update set kcal_target = excluded.kcal_target`, [userId, LATER, kcalV, basis]));
    const rowLater = async () => (await serverView(userId)).goals.find((g: { d: string }) => g.d === LATER)?.kcal ?? null;
    await insertNew(2321, 0); // obsoleta
    const newDateStale = await rowLater();
    await insertNew(1939, -100); // vigente
    const newDateFresh = await rowLater();
    // Residual declarado: cliente antiguo (sin base) y día todavía sin fila → no hay nada que comparar.
    await asClient(userId, () => db.query(
      `insert into public.nutrition_goals (user_id, goal_date, kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode, calculation_version)
       values ($1, '2026-10-16', 2321, 150, 200, 60, 'fat_loss', 'nutrition-v3.1')`, [userId]));
    const residualOldClientNewDate = (await serverView(userId)).goals.find((g: { d: string }) => g.d === "2026-10-16")?.kcal ?? null;
    results.S1 = { sealedByRpc: sealed, afterMatchingBasis: accepted, afterStaleBasis, afterNoBasis, newDateStaleBasis: newDateStale, newDateFreshBasis: newDateFresh,
      residualOldClientNewDate, conflicts: (await serverView(userId)).conflicts.map((c: { kind: string; subject: string }) => `${c.kind}:${c.subject}`) };
    expect(accepted).toBe(1111);
    expect(afterStaleBasis).toBe(1111);
    expect(afterNoBasis).toBe(1111);
    expect(newDateStale).toBeNull();
    expect(newDateFresh).toBe(1939);
    expect(residualOldClientNewDate).toBe(2321); // NO protegido: se documenta en el contrato
  });

  it("S3: una calibración 'futura' (fecha simulada) no queda fijada para siempre", async () => {
    const { userId } = await bootstrapAccount();
    const far = "2099-01-01";
    await asClient(userId, () => db.query(
      `update public.user_profiles set extra_state = jsonb_set(extra_state, '{adaptiveCalibrationStartedAt}', to_jsonb($2::text)) where user_id = $1`, [userId, far]));
    const poisoned = (await serverView(userId)).calibration;
    await asClient(userId, () => db.query(
      `update public.user_profiles set extra_state = jsonb_set(extra_state, '{adaptiveCalibrationStartedAt}', to_jsonb($2::text)) where user_id = $1`, [userId, TODAY]));
    const after = (await serverView(userId)).calibration;
    results.S3 = { afterFutureWrite: poisoned, afterCorrection: after };
    expect(poisoned).toBe(far); // el primer valor entra (no había uno protegido más antiguo)
    expect(after).toBe(TODAY); // y se puede corregir: un valor futuro NO se protege
  });

  it("S2: una escritura directa del offset por el cliente no cambia nada; el RPC con offset ≠ vigente+delta se rechaza", async () => {
    const { userId, s0 } = await bootstrapAccount();
    const A = await acceptFromDevice(userId, structuredClone(s0)); // offset -100
    expect(A.result.ok).toBe(true);
    await asClient(userId, () => db.query(
      `update public.user_profiles set extra_state = jsonb_set(extra_state, '{adaptiveKcalOffsetKcal}', '500') where user_id = $1`, [userId]));
    const afterDirect = (await serverView(userId)).offset;

    // Segunda propuesta aceptada desde un dispositivo que cree que el offset es 0 (obsoleto).
    useSession(userId);
    const created = await remote.createAdjustmentReview({
      snapshot: snapshotFor(profile(), "adaptive_review"),
      decision: { shouldPropose: true, deltaKcal: -100, proposedTargetKcal: 2000, reason: "x", trajectory: "above", blockingReasons: [] },
      evidence: { evaluationWindow: { start: "a", end: "b" }, intakeCoverage: null, averageIntakeKcal: null, weightMeasurements: 0,
        regressionSlopeKgPerDay: null, confidence: "high", weightTrendQualityScore: null, initialTdeeKcal: 0, observedTdeeKcal: null,
        combinedTdeeKcal: 0, warnings: [], engineVersion: NUTRITION_ENGINE_VERSION },
    });
    const id = created.kind === "ok" && created.value ? created.value.id : "";
    const stale = await remote.acceptAdjustmentProposal({
      proposalId: id, accepted: true, goalDate: TODAY, newOffsetKcal: -100, kcalTarget: 2000, proteinG: 150, carbsG: 200, fatG: 60,
      mode: "fat_loss", finalSnapshot: snapshotFor(profile(), "adaptive_adjustment_accepted"),
    });
    const view = await serverView(userId);
    results.S2 = { afterDirectWrite: afterDirect, staleAcceptOk: stale.ok, staleAcceptError: (stale as { error?: string }).error?.slice(0, 60), offsetAfter: view.offset, proposals: view.proposals };
    expect(afterDirect).toBe(-100);
    expect(stale.ok).toBe(false);
    expect(view.offset).toBe(-100);
  });
});
