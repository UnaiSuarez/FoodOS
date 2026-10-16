// @vitest-environment jsdom
//
// C0 — integración con el FoodOSProvider REAL (react-dom/client + act + jsdom): cola de salida (outbox),
// hidratación, pendiente tras recarga, ediciones durante una sincronización en vuelo, orden de lecturas,
// logout / cambio de cuenta y relectura pendiente. El servidor es un MODELO en memoria (SIMULADO): aplica la
// regla de la guarda («el objetivo solo se almacena si su base coincide con el offset del servidor») y
// devuelve lo almacenado; no es Postgres. Lo que prueba aquí es el cliente.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FoodOSState, PhysicalProfile } from "@foodos/types";
import { FoodOSProvider, useFoodOS } from "./state";
import { remote } from "./data-layer";
import * as outbox from "./outbox";
import { PLAN_RECONCILE_MAX_REPUSH } from "./plan-state";
import { calcDailyTargets } from "./nutrition";
import { todayPlus } from "./utils";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clientHolder: { client: unknown } = vi.hoisted(() => ({ client: null }));
vi.mock("./supabase", () => ({
  hasSupabaseConfig: () => true,
  getSupabase: () => clientHolder.client,
  PLAN_PROTOCOL_CLIENT_INFO: "foodos-web plan-protocol/1",
}));

const A = "user-a";
const B = "user-b";
const TODAY = todayPlus(0);
const YESTERDAY = todayPlus(-1);

interface GoalRow { goalDate: string; kcal: number; protein: number; carbs: number; fat: number; mode: string; basisOffsetKcal: number | null; calculationVersion: string | null; sourceSnapshotId: null }
function makeServer() {
  return {
    offset: -100 as number | null,
    goal: null as GoalRow | null,
    conflicts: [] as Array<{ id: string; kind: string; subject: string }>,
    profile: null as PhysicalProfile | null,
    calls: [] as Array<{ table: string; op: string; args?: unknown }>,
    acks: [] as string[][],
    profileSelects: 0,
    /** Si no es null, las lecturas autoritativas esperan a esta promesa. */
    holdRead: null as Promise<void> | null,
    failReads: 0,
    /** El servidor recibe pero nunca almacena el objetivo del día (respuesta válida, reconciliación imposible). */
    dropGoals: false,
    readCount: 0,
  };
}
type Server = ReturnType<typeof makeServer>;

function profileRow(p: PhysicalProfile, s: Server) {
  return {
    mascot_id: "zana", weekly_food_budget: 70, age: p.age, sex: p.sex, height_cm: p.heightCm, weight_kg: p.weightKg,
    body_fat_pct: null, body_fat_source: null, activity_level: p.activityLevel, goal: p.goal, gym_days: p.gymDays,
    allergies: [], excluded_foods: [], target_weight_kg: null, experience_level: null, equipment_access: null,
    activity_model_version: "legacy_total_pal",
    extra_state: { adaptiveKcalOffsetKcal: s.offset, adaptiveCalibrationStartedAt: null, lastTargetChangedAt: null, lastCalculationEngineVersion: "nutrition-v3.1" },
  };
}

function makeClient(s: Server, initialUser: string | null) {
  let authCb: ((e: string, session: { user: { id: string } } | null) => void) | null = null;
  const tables: Record<string, unknown> = {
    almacenes: [{ id: "a1", name: "Nevera", type: "fridge" }, { id: "a2", name: "Congelador", type: "freezer" }, { id: "a3", name: "Despensa", type: "pantry" }],
    shopping_lists: [{ id: "list-1" }],
  };
  function builder(table: string) {
    let op = "select";
    const b: Record<string, unknown> = {
      upsert(p: Record<string, unknown>) {
        op = "upsert"; s.calls.push({ table, op, args: p });
        if (table === "nutrition_goals" && typeof p.goal_date === "string") {
          // Guarda del servidor: el objetivo solo se almacena si su base coincide con el offset vigente.
          if (!s.dropGoals && p.basis_offset_kcal === s.offset) {
            s.goal = { goalDate: p.goal_date as string, kcal: p.kcal_target as number, protein: p.protein_target_g as number, carbs: p.carbs_target_g as number, fat: p.fat_target_g as number, mode: p.mode as string, basisOffsetKcal: p.basis_offset_kcal as number, calculationVersion: p.calculation_version as string, sourceSnapshotId: null };
          }
        }
        return b;
      },
      update(p: unknown) { op = "update"; s.calls.push({ table, op, args: p }); return b; },
      insert(p: unknown) { op = "insert"; s.calls.push({ table, op, args: p }); return b; },
      delete() { op = "delete"; s.calls.push({ table, op }); return b; },
      select() { return b; }, eq() { return b; }, gte() { return b; }, lte() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { return b; }, single() { return b; },
      in(_c: string, ids: string[]) { if (table === "nutrition_sync_conflicts") s.acks.push(ids); return b; },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        let data: unknown = tables[table] ?? [];
        if (op === "select") {
          if (table === "user_profiles") { s.profileSelects++; data = s.profile ? profileRow(s.profile, s) : null; }
          if (table === "nutrition_goals") data = [];
        } else data = null;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  }
  const client = {
    from: (t: string) => builder(t),
    async rpc(name: string, args: { p_goal_date: string | null }) {
      s.calls.push({ table: name, op: "rpc", args });
      if (args.p_goal_date !== null) {
        s.readCount++;
        if (s.holdRead) await s.holdRead;
        if (s.failReads > 0) { s.failReads--; return { data: null, error: { code: "08006", message: "connection failure" } }; }
      }
      return {
        data: { protocol: 1, serverDate: TODAY, offset: s.offset, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: "nutrition-v3.1",
          goal: s.goal && args.p_goal_date === s.goal.goalDate ? s.goal : null, conflicts: s.conflicts },
        error: null,
      };
    },
    channel: () => { const ch = { on: () => ch, subscribe: (cb: (st: string) => void) => { queueMicrotask(() => cb("SUBSCRIBED")); return ch; } }; return ch; },
    removeChannel: async () => {},
    auth: {
      getSession: async () => ({ data: { session: initialUser ? { user: { id: initialUser } } : null } }),
      onAuthStateChange: (cb: (e: string, session: { user: { id: string } } | null) => void) => {
        authCb = cb;
        queueMicrotask(() => authCb?.("INITIAL_SESSION", initialUser ? { user: { id: initialUser } } : null));
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signOut: async () => ({ error: null }),
    },
    __emitAuth: (e: string, session: { user: { id: string } } | null) => authCb?.(e, session),
  };
  return client;
}

function seedProfile(over: Partial<PhysicalProfile> = {}): PhysicalProfile {
  return {
    age: 32, sex: "male", heightCm: 178, weightKg: 80, bodyFatPct: null, activityLevel: "moderate", goal: "fat_loss",
    gymDays: [0, 1, 2, 3, 4, 5, 6], allergies: [], excludedFoods: [], adaptiveKcalOffsetKcal: 0,
    lastCalculationEngineVersion: "nutrition-v3.1", ...over,
  } as PhysicalProfile;
}

function baseState(p: PhysicalProfile): FoodOSState {
  const t = calcDailyTargets(p, true, "balanced");
  const nutrition = { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat, mode: p.goal };
  return {
    inventory: [], cart: [], expenses: [], incomeSources: [], recurringExpenses: [], savingsGoalPct: 20, savingsGoal: null,
    foodLog: [], waterLog: {}, weightLog: [], customRecipes: [], savedRecipeIds: [], profile: p, nutrition,
    weeklyBudget: 70, bankSynced: false, mascotId: "zana", recipeTag: "todos", macroPreference: "balanced",
    settings: { expiryWarnDays: 3, waterGoalMl: 2500, dinnerSuggestionHour: 18, budgetWarnPct: 80, defaultStore: "Mercadona", lowStockThresholds: { g: 200, ml: 300, L: 0.5, kg: 0.3, ud: 2 }, extraExpenseCategories: [], stepsGoal: 8000 },
    dismissedSuggestions: [], mealPlan: {}, plannerQuickMeals: [], debugDate: null, categoryBudgets: {}, routines: [], workoutLog: [], stepsLog: {},
    pendingAdjustmentProposal: null, lastAdjustmentDecisionAt: null,
    nutritionGoalsHistory: {
      [YESTERDAY]: { ...nutrition, calculationVersion: "nutrition-v3.1", recordedAt: null },
      [TODAY]: { ...nutrition, calculationVersion: "nutrition-v3.1", recordedAt: null },
    },
  } as unknown as FoodOSState;
}

function resetRemote() {
  remote.resetSessionState();
  const r = remote as unknown as Record<string, unknown>;
  r.client = null; r.user = null; r.sessionEpoch = 0; r.shoppingListId = null; r.explicitSignOutInProgress = false;
  remote.onPushError = null; remote.onStatusChange = null; remote.onUnsyncedWrite = null; remote.onPlanReadback = null;
  localStorage.clear(); sessionStorage.clear();
}

type Ctx = ReturnType<typeof useFoodOS>;
const holder: { current: Ctx | null } = { current: null };
function Capture() { holder.current = useFoodOS(); return null; }

let container: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => { resetRemote(); holder.current = null; container = document.createElement("div"); document.body.appendChild(container); vi.useFakeTimers(); });
afterEach(() => {
  if (root) { act(() => { root!.unmount(); }); root = null; }
  container.remove(); vi.useRealTimers(); resetRemote();
});

async function mount(server: Server, user: string | null) {
  const client = makeClient(server, user);
  clientHolder.client = client;
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
    await vi.advanceTimersByTimeAsync(0);
  });
  return client;
}
/** Avanza el reloj en pasos cortos, cada uno dentro de su propio act(): en el navegador React renderiza
    entre eventos; un único act largo aplazaría TODOS los renders al final y el estado leído por los
    manejadores iría artificialmente por detrás. */
async function settle(ms = 4_000, step = 100) {
  for (let t = 0; t < ms; t += step) {
    await act(async () => { await vi.advanceTimersByTimeAsync(step); });
  }
}
const goalUpserts = (s: Server) => s.calls.filter((c) => c.table === "nutrition_goals" && c.op === "upsert").map((c) => c.args as Record<string, unknown>);
const profileUpserts = (s: Server) => s.calls.filter((c) => c.table === "user_profiles" && c.op === "upsert").map((c) => c.args as { weight_kg?: number; extra_state?: Record<string, unknown> });

describe("FoodOSProvider real — reconciliación del estado de plan", () => {
  it("recarga con pendiente obsoleto: el servidor conserva su offset, el cliente lo adopta, recalcula HOY (no el pasado), reenvía con la base vigente y solo entonces reconoce el conflicto", async () => {
    const server = makeServer();
    const stale = seedProfile({ adaptiveKcalOffsetKcal: 0 });
    server.profile = stale; // el servidor tiene el perfil con su offset (-100) en extra_state
    server.conflicts = [{ id: "c1", kind: "offset_overwrite_prevented", subject: "adaptiveKcalOffsetKcal" }];
    const old = baseState(stale);
    outbox.recordMutation(A, old, "tab-1"); // pendiente de una sesión anterior: lleva offset 0
    await mount(server, A);
    await settle(20_000);

    const ctx = holder.current!;
    expect(ctx.state.profile?.adaptiveKcalOffsetKcal).toBe(-100);
    const expectedToday = calcDailyTargets({ ...stale, adaptiveKcalOffsetKcal: -100 }, true, "balanced");
    expect(ctx.state.nutrition.kcal).toBe(expectedToday.kcal);
    // HOY recalculado; AYER intacto (nunca se reescribe el histórico)
    expect(ctx.state.nutritionGoalsHistory[TODAY].kcal).toBe(expectedToday.kcal);
    expect(ctx.state.nutritionGoalsHistory[YESTERDAY].kcal).toBe(old.nutrition.kcal);
    // El último envío declara la base vigente y las cifras recalculadas
    const last = goalUpserts(server).at(-1)!;
    expect(last.basis_offset_kcal).toBe(-100);
    expect(last.kcal_target).toBe(expectedToday.kcal);
    expect(server.goal?.kcal).toBe(expectedToday.kcal);
    // Conflicto reconocido solo tras una lectura en sincronía
    expect(server.acks).toEqual([["c1"]]);
    // Cola vacía
    expect(outbox.readEnvelope(A)?.pending ?? null).toBeNull();
  });

  it("edición del usuario mientras la sincronización está en vuelo: no se pierde, y el offset del servidor también se adopta", async () => {
    const server = makeServer();
    const p = seedProfile({ adaptiveKcalOffsetKcal: 0 });
    server.profile = p;
    let release!: () => void;
    server.holdRead = new Promise<void>((r) => { release = r; });
    outbox.recordMutation(A, baseState(p), "tab-1");
    await mount(server, A);
    await settle(2_000); // el push está escrito; su lectura está retenida
    expect(server.readCount).toBeGreaterThan(0);

    // El usuario edita ahora (peso): nueva mutación pendiente mientras la lectura de la anterior sigue en vuelo.
    await act(async () => { holder.current!.mutate((d) => { d.profile!.weightKg = 79; }); await vi.advanceTimersByTimeAsync(0); });
    server.holdRead = null;
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    await settle(10_000);

    expect(holder.current!.state.profile?.weightKg).toBe(79); // la edición legítima sobrevive
    expect(holder.current!.state.profile?.adaptiveKcalOffsetKcal).toBe(-100); // y el offset del servidor también
    const lastProfile = profileUpserts(server).at(-1)!;
    expect(lastProfile.weight_kg).toBe(79);
  });

  it("lectura de una mutación anterior con otra más nueva en cola: no concluye nada sobre el objetivo (no refresca ni reconoce)", async () => {
    const server = makeServer();
    server.offset = 0; // mismo offset → solo importa el objetivo
    const p = seedProfile({ adaptiveKcalOffsetKcal: 0 });
    server.profile = p;
    server.conflicts = [{ id: "c9", kind: "daily_goal_overwrite_prevented", subject: `goal:${TODAY}` }];
    // El servidor tiene otras cifras para hoy con la MISMA base (otro dispositivo): normalmente → refresco
    server.goal = { goalDate: TODAY, kcal: 1500, protein: 100, carbs: 100, fat: 50, mode: "fat_loss", basisOffsetKcal: 0, calculationVersion: "nutrition-v3.1", sourceSnapshotId: null };
    let release!: () => void;
    server.holdRead = new Promise<void>((r) => { release = r; });
    outbox.recordMutation(A, baseState(p), "tab-1");
    await mount(server, A);
    await settle(2_000);
    const selectsBefore = server.profileSelects;
    await act(async () => { holder.current!.mutate((d) => { d.profile!.weightKg = 79; }); await vi.advanceTimersByTimeAsync(0); });
    // Libera la lectura de la mutación anterior (la nueva sigue pendiente de push).
    server.holdRead = null;
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(server.acks).toEqual([]); // nada reconocido
    expect(server.profileSelects).toBe(selectsBefore); // ni hidratación por esa lectura
  });

  it("cambio de cuenta A→B con la lectura de A en vuelo: la respuesta de A no modifica ni el estado de B ni el envelope de A", async () => {
    const server = makeServer();
    const p = seedProfile({ adaptiveKcalOffsetKcal: 0 });
    server.profile = p;
    let release!: () => void;
    server.holdRead = new Promise<void>((r) => { release = r; });
    outbox.recordMutation(A, baseState(p), "tab-1");
    const client = await mount(server, A);
    await settle(2_000);
    expect(server.readCount).toBeGreaterThan(0);

    // A→B
    server.profile = null; // B no tiene perfil
    await act(async () => { client.__emitAuth("SIGNED_IN", { user: { id: B } }); await vi.advanceTimersByTimeAsync(0); });
    server.holdRead = null;
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    await settle(5_000);

    expect(holder.current!.state.profile?.adaptiveKcalOffsetKcal ?? null).toBeNull();
    expect(server.acks).toEqual([]);
    const envA = outbox.readEnvelope(A);
    expect(envA?.state.profile?.adaptiveKcalOffsetKcal ?? 0).toBe(0); // el envelope de A no recibió la respuesta
  });

  it("lectura fallida y recarga: la relectura pendiente sobrevive a desmontar/montar y reconcilia sin otra edición", async () => {
    const server = makeServer();
    const p = seedProfile({ adaptiveKcalOffsetKcal: 0 });
    server.profile = p;
    server.failReads = 99; // la lectura posterior a escribir falla siempre durante esta «carga»
    outbox.recordMutation(A, baseState(p), "tab-1");
    await mount(server, A);
    await settle(3_000);
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    expect(localStorage.getItem(`foodos-plan-recheck-v1-${A}`)).not.toBeNull();

    // «Recarga»: se desmonta, se conserva el almacenamiento y el servidor vuelve a responder.
    await act(async () => { root!.unmount(); }); root = null;
    remote.resetSessionState();
    const r = remote as unknown as Record<string, unknown>; r.client = null; r.user = null;
    server.failReads = 0;
    await mount(server, A);
    await settle(15_000);
    expect(remote.hasPendingPlanRecheck()).toBe(false);
    expect(holder.current!.state.profile?.adaptiveKcalOffsetKcal).toBe(-100);
    expect(localStorage.getItem(`foodos-plan-recheck-v1-${A}`)).toBeNull();
  });

  it("recibido ≠ confirmado: lectura VÁLIDA pero no reconciliable de forma persistente → reintentos acotados, error visible, marca durable; tras recargar y A→B se conserva; al poder reconciliar, se confirma y se borra", async () => {
    const server = makeServer();
    server.dropGoals = true; // el objetivo de hoy nunca llega a almacenarse: server_row_missing una y otra vez
    const p = seedProfile({ adaptiveKcalOffsetKcal: -100 });
    server.profile = p;
    outbox.recordMutation(A, baseState(p), "tab-1");
    await mount(server, A);
    await settle(520_000, 1_000); // cubre 5+15+45+120+300 s de reintentos
    const readsAfter = server.readCount;
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    expect(localStorage.getItem(`foodos-plan-recheck-v1-${A}`)).not.toBeNull();
    // Presupuesto EXACTO (no solo «acotado»): tras escribir, cada lectura «el objetivo no existe» reescribe el objetivo
    // hasta PLAN_RECONCILE_MAX_REPUSH veces (cada reescritura = un push = una lectura) y la relectura pendiente hace sus
    // 5 reintentos: 1 + MAX_REPUSH + 5. Una lectura más sería un reintento indebido; una menos, un presupuesto sin gastar.
    expect(readsAfter).toBe(1 + PLAN_RECONCILE_MAX_REPUSH + 5);
    expect(goalUpserts(server).length).toBe(1 + PLAN_RECONCILE_MAX_REPUSH);
    await settle(60_000, 1_000);
    expect(server.readCount).toBe(readsAfter); // agotado: ni un intento más ni temporizadores huérfanos
    expect(vi.getTimerCount()).toBe(0);

    // Recarga + cambio de cuenta A→B: la marca de A no se toca ni se atribuye a B (el modelo de servidor es compartido,
    // así que B puede tener la suya propia: es otra clave).
    const markA = localStorage.getItem(`foodos-plan-recheck-v1-${A}`);
    await act(async () => { root!.unmount(); }); root = null;
    remote.resetSessionState();
    const r = remote as unknown as Record<string, unknown>; r.client = null; r.user = null;
    await mount(server, B);
    await settle(10_000, 1_000);
    expect(localStorage.getItem(`foodos-plan-recheck-v1-${A}`)).toBe(markA);
    expect(markA).not.toBeNull();

    // Vuelve A y el servidor ya puede reconciliar: se confirma y solo entonces se borra la marca.
    await act(async () => { root!.unmount(); }); root = null;
    remote.resetSessionState(); r.client = null; r.user = null;
    server.dropGoals = false;
    await mount(server, A);
    await settle(30_000, 1_000);
    expect(remote.hasPendingPlanRecheck()).toBe(false);
    expect(localStorage.getItem(`foodos-plan-recheck-v1-${A}`)).toBeNull();
  });
});