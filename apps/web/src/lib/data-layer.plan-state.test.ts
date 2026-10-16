// C0 — comportamiento de RemoteAdapter.pushState frente a la protección del estado de plan, con un
// cliente Supabase falso (SIMULADO: no demuestra nada sobre Postgres; eso lo hacen la batería SQL y el
// workflow de concurrencia). Cubre: sonda de capacidad (servidor anterior confirmado frente a errores
// transitorios/permisos/respuesta inválida), base declarada, lectura autoritativa explícita, orden de
// lecturas dentro de una cuenta, cambio de cuenta/época y relectura pendiente durable y acotada.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodOSState } from "@foodos/types";
import { remote } from "./data-layer";
import type { PlanReadback } from "./plan-state";

type Call = { table?: string; op: string; args?: unknown };
type RpcResult = { data?: unknown; error?: { code?: string; message?: string } | null };

const USER = "user-1";
const TODAY = "2026-10-14";

function serverRead(over: Record<string, unknown> = {}) {
  return { protocol: 1, serverDate: TODAY, offset: 0, calibrationStartedAt: null, lastTargetChangedAt: null, engineVersion: null, goal: null, conflicts: [], ...over };
}

function makeClient(rpcImpl: (name: string, args: unknown, n: number) => Promise<RpcResult> | RpcResult) {
  const calls: Call[] = [];
  let rpcCount = 0;
  const client = {
    from(table: string) {
      let op = "select";
      const b: Record<string, unknown> = {
        upsert(payload: unknown) { op = "upsert"; calls.push({ table, op, args: payload }); return b; },
        update(payload: unknown) { op = "update"; calls.push({ table, op, args: payload }); return b; },
        insert(payload: unknown) { op = "insert"; calls.push({ table, op, args: payload }); return b; },
        delete() { op = "delete"; calls.push({ table, op }); return b; },
        select() { return b; }, eq() { return b; }, in() { return b; }, gte() { return b; }, lte() { return b; },
        order() { return b; }, limit() { return b; }, maybeSingle() { return b; }, single() { return b; },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve({ data: op === "select" ? [] : null, error: null }).then(resolve, reject);
        },
      };
      return b;
    },
    async rpc(name: string, args: unknown) {
      calls.push({ op: "rpc", table: name, args });
      return rpcImpl(name, args, ++rpcCount);
    },
  };
  return { client, calls };
}

function stateWithGoal(offset = 0): FoodOSState {
  const nutrition = { kcal: 2039, protein: 160, carbs: 222, fat: 57, mode: "fat_loss" as const };
  return {
    inventory: [], cart: [], expenses: [], incomeSources: [], recurringExpenses: [], savingsGoalPct: 20, savingsGoal: null,
    foodLog: [], waterLog: {}, weightLog: [], customRecipes: [], savedRecipeIds: [],
    profile: { age: 32, sex: "male", heightCm: 178, weightKg: 80, bodyFatPct: null, activityLevel: "moderate", goal: "fat_loss", gymDays: [1], allergies: [], excludedFoods: [], adaptiveKcalOffsetKcal: offset },
    nutrition, weeklyBudget: 70, bankSynced: false, mascotId: "zana", recipeTag: "todos", macroPreference: "balanced",
    settings: {}, dismissedSuggestions: [], mealPlan: {}, plannerQuickMeals: [], debugDate: TODAY, categoryBudgets: {}, routines: [],
    workoutLog: [], stepsLog: {}, pendingAdjustmentProposal: null, lastAdjustmentDecisionAt: null,
    nutritionGoalsHistory: { [TODAY]: { ...nutrition, calculationVersion: "nutrition-v3.1", recordedAt: null } },
  } as unknown as FoodOSState;
}

function attach(client: unknown, userId = USER) {
  const r = remote as unknown as { client: unknown; user: unknown; shoppingListId: string | null };
  remote.resetSessionState();
  r.client = client;
  r.user = { id: userId };
  r.shoppingListId = "list-1";
}
const ctx = (over: Partial<{ userId: string; mutationId: string }> = {}) => ({
  userId: over.userId ?? USER, epoch: remote.sessionEpoch, mutationId: over.mutationId ?? "m1", signal: new AbortController().signal,
});
const goalUpserts = (calls: Call[]) => calls.filter((c) => c.table === "nutrition_goals" && c.op === "upsert");
const writes = (calls: Call[]) => calls.filter((c) => c.op === "upsert" || c.op === "insert" || c.op === "update" || c.op === "delete");

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => {
  vi.useRealTimers();
  remote.onPlanReadback = null;
  remote.onStatusChange = null;
  remote.resetSessionState();
  (remote as unknown as { client: unknown; user: unknown }).client = null;
  (remote as unknown as { client: unknown; user: unknown }).user = null;
  localStorage.clear();
});

describe("sonda de capacidad", () => {
  it("servidor ANTERIOR confirmado (función inexistente): se comporta como antes — sin base, sin lectura autoritativa", async () => {
    const { client, calls } = makeClient(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.fn_plan_state_read(p_goal_date) in the schema cache" } }));
    attach(client);
    const seen: PlanReadback[] = [];
    remote.onPlanReadback = (i) => { seen.push(i.readback); return "confirmed"; };
    await expect(remote.pushState(ctx(), stateWithGoal())).resolves.toBeUndefined();
    const up = goalUpserts(calls);
    expect(up.length).toBe(1);
    expect(up[0].args).not.toHaveProperty("basis_offset_kcal");
    expect(calls.filter((c) => c.op === "rpc").length).toBe(1); // solo la sonda
    expect(seen).toEqual([]);
    // y no se vuelve a sondear en la sesión
    await remote.pushState(ctx(), stateWithGoal());
    expect(calls.filter((c) => c.op === "rpc").length).toBe(1);
  });

  it.each([
    ["error transitorio de red", () => Promise.reject(new Error("Failed to fetch"))],
    ["error del servidor", () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })],
    ["permisos", () => ({ data: null, error: { code: "42501", message: "permission denied for function fn_plan_state_read" } })],
    ["respuesta inválida", () => ({ data: { hola: 1 }, error: null })],
    ["protocolo desconocido", () => ({ data: { protocol: 2 }, error: null })],
  ])("%s: NO se degrada en silencio — el push falla de forma visible, no escribe nada y no cachea la sonda", async (_label, impl) => {
    const { client, calls } = makeClient(impl as never);
    attach(client);
    await expect(remote.pushState(ctx(), stateWithGoal())).rejects.toThrow();
    expect(writes(calls)).toEqual([]); // ni perfil ni objetivos: nada sin base
    // se vuelve a sondear en el siguiente intento (no quedó cacheado como «ausente»)
    await expect(remote.pushState(ctx(), stateWithGoal())).rejects.toThrow();
    expect(calls.filter((c) => c.op === "rpc").length).toBe(2);
  });

  it("servidor con protección: declara la base (el offset local, saneado) y lee de forma explícita con la identidad del push", async () => {
    const { client, calls } = makeClient(() => ({ data: serverRead(), error: null }));
    attach(client);
    const seen: Array<{ userId: string; epoch: number; readback: PlanReadback }> = [];
    remote.onPlanReadback = (i) => { seen.push(i); return "confirmed"; };
    await remote.pushState(ctx({ mutationId: "m-77" }), stateWithGoal(-100));
    expect(goalUpserts(calls)[0].args).toMatchObject({ basis_offset_kcal: -100 });
    const reads = calls.filter((c) => c.op === "rpc");
    expect(reads.map((c) => c.args)).toEqual([{ p_goal_date: null }, { p_goal_date: TODAY }]);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ userId: USER, epoch: remote.sessionEpoch });
    expect(seen[0].readback.mutationId).toBe("m-77");
    expect(seen[0].readback.requestedGoalDate).toBe(TODAY);
  });

  it("un offset local inválido (decimal) se declara como 0, nunca como basura", async () => {
    const { client, calls } = makeClient(() => ({ data: serverRead(), error: null }));
    attach(client);
    await remote.pushState(ctx(), stateWithGoal(12.5));
    expect(goalUpserts(calls)[0].args).toMatchObject({ basis_offset_kcal: 0 });
  });
});

describe("lectura autoritativa tras escribir", () => {
  it("dos lecturas fuera de orden en la misma cuenta: la respuesta más antigua llegada tarde se descarta", async () => {
    let resolveFirst!: (v: RpcResult) => void;
    let resolveSecond!: (v: RpcResult) => void;
    const { client } = makeClient((name, _a, n) => {
      if (n === 1) return { data: serverRead(), error: null }; // sonda
      if (n === 2) return new Promise<RpcResult>((r) => { resolveFirst = r; });
      return new Promise<RpcResult>((r) => { resolveSecond = r; });
    });
    attach(client);
    const seen: PlanReadback[] = [];
    remote.onPlanReadback = (i) => { seen.push(i.readback); return "confirmed"; };
    const p1 = remote.pushState(ctx({ mutationId: "m-1" }), stateWithGoal());
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
    const p2 = remote.pushState(ctx({ mutationId: "m-2" }), stateWithGoal());
    await vi.waitFor(() => expect(resolveSecond).toBeTypeOf("function"));
    resolveSecond({ data: serverRead({ offset: -100 }), error: null }); // la petición MÁS NUEVA responde primero
    await p2;
    resolveFirst({ data: serverRead({ offset: 0 }), error: null }); // la antigua llega tarde
    await p1;
    expect(seen.map((r) => r.slice.offset)).toEqual([-100]);
    expect(seen[0].mutationId).toBe("m-2");
  });

  it("si la sesión cambia mientras la lectura está en vuelo, nada llega al estado de otra cuenta", async () => {
    let resolveRead!: (v: RpcResult) => void;
    const { client } = makeClient((_n, _a, n) => (n === 1 ? { data: serverRead(), error: null } : new Promise<RpcResult>((r) => { resolveRead = r; })));
    attach(client);
    const seen: unknown[] = [];
    remote.onPlanReadback = (i) => { seen.push(i); return "confirmed"; };
    const p = remote.pushState(ctx(), stateWithGoal());
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    (remote as unknown as { user: unknown }).user = { id: "user-B" }; // A→B
    resolveRead({ data: serverRead({ offset: -100 }), error: null });
    await p.catch(() => undefined);
    expect(seen).toEqual([]);
  });

  it("si la época cambia (logout/nuevo login) mientras la lectura está en vuelo, el push se aborta sin entregar", async () => {
    let resolveRead!: (v: RpcResult) => void;
    const { client } = makeClient((_n, _a, n) => (n === 1 ? { data: serverRead(), error: null } : new Promise<RpcResult>((r) => { resolveRead = r; })));
    attach(client);
    const seen: unknown[] = [];
    remote.onPlanReadback = (i) => { seen.push(i); return "confirmed"; };
    const p = remote.pushState(ctx(), stateWithGoal());
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    (remote as unknown as { sessionEpoch: number }).sessionEpoch += 1;
    resolveRead({ data: serverRead(), error: null });
    await expect(p).rejects.toThrow(/abortado/);
    expect(seen).toEqual([]);
  });
});

describe("lectura fallida: relectura pendiente, durable y acotada", () => {
  function failingReads(failures: number) {
    let readFailures = 0;
    return makeClient((_n, _a, n) => {
      if (n === 1) return { data: serverRead(), error: null }; // sonda
      if (readFailures < failures) { readFailures++; return { data: null, error: { code: "08006", message: "connection failure" } }; }
      return { data: serverRead({ offset: -100 }), error: null };
    });
  }

  it("un fallo de la lectura tras escribir no es un fallo del push, pero deja una relectura pendiente: no se anuncia «guardado» y la marca persiste", async () => {
    vi.useFakeTimers();
    const { client } = failingReads(1);
    attach(client);
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);
    const seen: PlanReadback[] = [];
    remote.onPlanReadback = (i) => { seen.push(i.readback); return "confirmed"; };
    await remote.pushState(ctx(), stateWithGoal());
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    expect(localStorage.getItem(`foodos-plan-recheck-v1-${USER}`)).toBe(JSON.stringify({ goalDate: TODAY }));
    expect(statuses).not.toContain("saved");
    // tras la espera acotada, la relectura sale bien y entrega con mutationId null (relectura de recuperación)
    await vi.advanceTimersByTimeAsync(5_100);
    expect(remote.hasPendingPlanRecheck()).toBe(false);
    expect(localStorage.getItem(`foodos-plan-recheck-v1-${USER}`)).toBeNull();
    expect(seen.length).toBe(1);
    expect(seen[0].mutationId).toBeNull();
    expect(seen[0].slice.offset).toBe(-100);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("reintentos con espera creciente y tope: agotados, queda en error, la marca durable permanece y no hay timer vivo", async () => {
    vi.useFakeTimers();
    const { client, calls } = failingReads(99);
    attach(client);
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);
    await remote.pushState(ctx(), stateWithGoal());
    await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 45_000 + 120_000 + 300_000 + 1_000);
    const reads = calls.filter((c) => c.op === "rpc" && (c.args as { p_goal_date: unknown }).p_goal_date === TODAY).length;
    expect(reads).toBe(1 /* tras escribir */ + 5 /* reintentos acotados */);
    expect(statuses.at(-1)).toBe("error");
    expect(localStorage.getItem(`foodos-plan-recheck-v1-${USER}`)).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tras recargar: resumePlanRecheckFor retoma la relectura sin esperar a otra edición del usuario", async () => {
    vi.useFakeTimers();
    localStorage.setItem(`foodos-plan-recheck-v1-${USER}`, JSON.stringify({ goalDate: TODAY }));
    const { client } = makeClient(() => ({ data: serverRead({ offset: -100 }), error: null }));
    attach(client);
    const seen: PlanReadback[] = [];
    remote.onPlanReadback = (i) => { seen.push(i.readback); return "confirmed"; };
    remote.resumePlanRecheckFor(USER);
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(seen.map((r) => r.slice.offset)).toEqual([-100]);
    expect(localStorage.getItem(`foodos-plan-recheck-v1-${USER}`)).toBeNull();
  });

  it("la marca de un usuario no se retoma en la sesión de otro (A→B) ni en un cambio de época", async () => {
    vi.useFakeTimers();
    localStorage.setItem(`foodos-plan-recheck-v1-${USER}`, JSON.stringify({ goalDate: TODAY }));
    const { client, calls } = makeClient(() => ({ data: serverRead(), error: null }));
    attach(client, "user-B");
    remote.resumePlanRecheckFor(USER); // B está activo: no debe actuar por A
    await vi.advanceTimersByTimeAsync(10_000);
    expect(remote.hasPendingPlanRecheck()).toBe(false);
    expect(calls.filter((c) => c.op === "rpc").length).toBe(0);

    attach(client, USER);
    remote.resumePlanRecheckFor(USER);
    (remote as unknown as { sessionEpoch: number }).sessionEpoch += 1; // logout/login mientras esperaba
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.filter((c) => c.op === "rpc").length).toBe(0);
  });
});

describe("recibido ≠ confirmado: solo una reconciliación confirmada retira la relectura pendiente", () => {
  const validRead = () => ({ data: serverRead({ offset: -100 }), error: null });
  const markKey = `foodos-plan-recheck-v1-${USER}`;

  it("regresión de Codex: el consumidor pide otra relectura mientras la recuperación sigue activa (como el proveedor bloqueado) y devuelve «pending» → NO se borra la marca ni se anuncia «guardado»", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { client } = makeClient((_name, _a, k) => (k === 1 ? { data: serverRead(), error: null } : (++n === 1 ? { data: null, error: { code: "08006", message: "caída" } } : validRead())));
    attach(client);
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);
    let deliveries = 0;
    remote.onPlanReadback = (i) => {
      deliveries++;
      remote.requestPlanRecheck(i.userId, i.epoch, i.readback.requestedGoalDate); // el proveedor pide otra vez…
      return "pending"; // …y no ha podido reconciliar
    };
    await remote.pushState(ctx(), stateWithGoal()); // la lectura posterior a escribir falla → relectura pendiente
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_100); // la relectura recibe una respuesta VÁLIDA pero no se reconcilia
    expect(deliveries).toBe(1);
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    expect(localStorage.getItem(markKey)).not.toBeNull();
    expect(statuses).not.toContain("saved");
  });

  it("respuestas válidas pero no aplicables consumen el presupuesto acotado; agotado: error, marca durable, sin temporizadores huérfanos", async () => {
    vi.useFakeTimers();
    const { client, calls } = makeClient(() => validRead());
    attach(client);
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);
    remote.onPlanReadback = () => "pending";
    await remote.pushState(ctx(), stateWithGoal()); // lectura válida, no confirmada → relectura pendiente
    await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 45_000 + 120_000 + 300_000 + 1_000);
    const reads = calls.filter((c) => c.op === "rpc" && (c.args as { p_goal_date: unknown }).p_goal_date === TODAY).length;
    expect(reads).toBe(1 + 5); // la de tras escribir + 5 reintentos, ni uno más
    expect(statuses.at(-1)).toBe("error");
    expect(statuses).not.toContain("saved");
    expect(localStorage.getItem(markKey)).not.toBeNull();
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gate cerrado y reapertura: «pending» mientras no se puede aplicar; al reabrirse devuelve «confirmed» y solo entonces se retira, se borra la marca y se anuncia «guardado»", async () => {
    vi.useFakeTimers();
    const { client } = makeClient(() => validRead());
    attach(client);
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);
    let gateOpen = false;
    let calls = 0;
    remote.onPlanReadback = () => { calls++; return gateOpen ? "confirmed" : "pending"; };
    await remote.pushState(ctx(), stateWithGoal());
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_100); // intento 1: cerrado
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    gateOpen = true;
    await vi.advanceTimersByTimeAsync(15_100); // intento 2: abierto
    expect(remote.hasPendingPlanRecheck()).toBe(false);
    expect(localStorage.getItem(markKey)).toBeNull();
    expect(statuses.at(-1)).toBe("saved");
    expect(calls).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sin consumidor registrado no hay quien reconcilie: nada queda confirmado", async () => {
    vi.useFakeTimers();
    const { client } = makeClient(() => validRead());
    attach(client);
    remote.onPlanReadback = null;
    await remote.pushState(ctx(), stateWithGoal());
    expect(remote.hasPendingPlanRecheck()).toBe(true);
  });

  it("un push cuya lectura SÍ se confirma retira el pendiente anterior de la misma identidad; uno sin confirmar no lo retira", async () => {
    vi.useFakeTimers();
    const { client } = makeClient(() => validRead());
    attach(client);
    localStorage.setItem(markKey, JSON.stringify({ goalDate: TODAY }));
    remote.resumePlanRecheckFor(USER);
    remote.onPlanReadback = () => "pending";
    await remote.pushState(ctx(), stateWithGoal());
    expect(remote.hasPendingPlanRecheck()).toBe(true);
    expect(localStorage.getItem(markKey)).not.toBeNull();
    remote.onPlanReadback = () => "confirmed";
    await remote.pushState(ctx(), stateWithGoal());
    expect(remote.hasPendingPlanRecheck()).toBe(false);
    expect(localStorage.getItem(markKey)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("A→B con una relectura en vuelo: lo que responda para A no retira la marca de A ni se entrega a B", async () => {
    vi.useFakeTimers();
    let release!: (v: RpcResult) => void;
    const delivered: string[] = [];
    const { client } = makeClient((_n, _a, k) => (k === 1 ? { data: serverRead(), error: null } : new Promise<RpcResult>((r) => { release = r; })));
    attach(client);
    remote.onPlanReadback = (i) => { delivered.push(i.userId); return "confirmed"; };
    localStorage.setItem(markKey, JSON.stringify({ goalDate: TODAY }));
    remote.resumePlanRecheckFor(USER);
    await vi.advanceTimersByTimeAsync(5_100); // el reintento queda en vuelo
    expect(release).toBeTypeOf("function");
    const r = remote as unknown as { user: unknown };
    remote.resetSessionState(); // logout / cambio de sesión
    r.user = { id: "user-B" };
    release({ data: serverRead({ offset: -100 }), error: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(delivered).toEqual([]);
    expect(localStorage.getItem(markKey)).not.toBeNull(); // la marca de A sigue ahí para cuando vuelva A
    expect(remote.hasPendingPlanRecheck()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
