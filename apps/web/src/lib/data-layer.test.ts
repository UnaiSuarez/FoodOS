// Tests de sincronización con Supabase (B2, revisión externa, 2026-08-21):
// pushState() ignoraba silenciosamente los { error } que devuelven las
// escrituras de Supabase-js (no lanza excepciones en fallos de escritura),
// así que runPush() marcaba "saved" aunque el perfil, los pesos, los
// objetivos nutricionales o un borrado no hubieran llegado a persistirse.
// Estos tests simulan cada fallo individualmente con un cliente Supabase
// falso (sin red real) y comprueban que pushState() los propaga, que el
// resto de tablas se sigue intentando (mejor esfuerzo — son independientes
// entre sí) y que reintentar el mismo snapshot es idempotente.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, FoodOSState, PhysicalProfile, TrainingActivityProfile } from "@foodos/types";
import { remote } from "./data-layer";
import * as outbox from "./outbox";

// ─── Cliente Supabase falso ─────────────────────────────────────────────────
// Reproduce la forma "thenable" del query builder de supabase-js: cada
// eslabón de la cadena (.eq()/.in()) devuelve el mismo builder, y el propio
// builder implementa .then() para que `await client.from(t).update(x).eq(y)`
// funcione igual que con el cliente real. El resultado devuelto depende de
// la ÚLTIMA operación de escritura/lectura de la cadena (update/upsert/
// select/delete), configurable por tabla en `config`.
interface PGResult {
  data?: unknown;
  error?: { message: string } | null;
}
// Un valor de config puede ser el resultado directo, o una función que lo
// PRODUCE de forma asíncrona — esto último sirve para retrasar a propósito
// una operación concreta en un test (simular "esta escritura sigue en
// vuelo") y así poder interleaving otra acción mientras tanto.
type PGResultOrGate = PGResult | (() => Promise<PGResult>);
interface FakeTableConfig {
  update?: PGResultOrGate;
  upsert?: PGResultOrGate;
  select?: PGResultOrGate;
  delete?: PGResultOrGate;
}
interface CallRecord {
  table: string;
  op: string;
  args?: unknown;
}

function makeFakeClient(config: Record<string, FakeTableConfig>, calls: CallRecord[]) {
  return {
    from(table: string) {
      let op: keyof FakeTableConfig | null = null;
      const builder: Record<string, unknown> = {
        update(payload: unknown) {
          op = "update";
          calls.push({ table, op: "update", args: payload });
          return builder;
        },
        upsert(payload: unknown) {
          op = "upsert";
          calls.push({ table, op: "upsert", args: payload });
          return builder;
        },
        select(cols: string) {
          op = "select";
          calls.push({ table, op: "select", args: cols });
          return builder;
        },
        delete() {
          op = "delete";
          calls.push({ table, op: "delete" });
          return builder;
        },
        eq(col: string, val: unknown) {
          calls.push({ table, op: "eq", args: [col, val] });
          return builder;
        },
        in(col: string, vals: unknown[]) {
          calls.push({ table, op: "in", args: [col, vals] });
          return builder;
        },
        then(resolve: (v: PGResult) => unknown, reject?: (e: unknown) => unknown) {
          const cfg = config[table] ?? {};
          const raw: PGResultOrGate | undefined = op ? cfg[op] : undefined;
          const result: PGResult | Promise<PGResult> = typeof raw === "function" ? raw() : raw ?? { data: null, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
    // rpc/storage/etc. no los usa pushState — no hacen falta en este fake.
  };
}

function successConfig(): Record<string, FakeTableConfig> {
  return {
    user_profiles: { upsert: { error: null } },
    weight_log: { upsert: { error: null }, select: { data: [], error: null }, delete: { error: null } },
    nutrition_goals: { upsert: { error: null } },
    inventory_items: { upsert: { error: null }, select: { data: [], error: null }, delete: { error: null } },
    shopping_items: { upsert: { error: null }, select: { data: [], error: null }, delete: { error: null } },
    gastos: { upsert: { error: null }, select: { data: [], error: null }, delete: { error: null } },
    ingresos_fuentes: { upsert: { error: null }, select: { data: [], error: null }, delete: { error: null } },
    food_log: { upsert: { error: null }, select: { data: [], error: null }, delete: { error: null } },
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  expiryWarnDays: 3,
  waterGoalMl: 2500,
  dinnerSuggestionHour: 18,
  budgetWarnPct: 80,
  defaultStore: "Mercadona",
  lowStockThresholds: { g: 200, ml: 300, L: 0.5, kg: 0.3, ud: 2 },
  extraExpenseCategories: [],
  stepsGoal: 8000,
};

function makeState(overrides: Partial<FoodOSState> = {}): FoodOSState {
  return {
    inventory: [],
    cart: [],
    expenses: [],
    incomeSources: [],
    recurringExpenses: [],
    savingsGoalPct: 20,
    savingsGoal: null,
    foodLog: [],
    waterLog: {},
    weightLog: [],
    customRecipes: [],
    savedRecipeIds: [],
    profile: null,
    nutrition: { kcal: 2200, protein: 150, carbs: 225, fat: 70, mode: "recomp" },
    weeklyBudget: 70,
    bankSynced: false,
    mascotId: "zana",
    recipeTag: "todos",
    macroPreference: "balanced",
    settings: DEFAULT_SETTINGS,
    dismissedSuggestions: [],
    mealPlan: {},
    plannerQuickMeals: [],
    debugDate: null,
    categoryBudgets: {},
    routines: [],
    workoutLog: [],
    stepsLog: {},
    pendingAdjustmentProposal: null,
    lastAdjustmentDecisionAt: null,
    ...overrides,
  } as FoodOSState;
}

// `remote` es un singleton — se resetean sus campos internos (algunos
// privados a nivel de TS, pero accesibles en runtime) antes de cada test
// para que no haya fugas de estado entre tests.
function resetRemote() {
  const r = remote as unknown as {
    client: unknown;
    user: unknown;
    almacenIdByName: Record<string, string>;
    shoppingListId: string | null;
    sessionEpoch: number;
    pushTimer: ReturnType<typeof setTimeout> | null;
    pushRetryTimer: ReturnType<typeof setTimeout> | null;
    activePush: unknown;
    pushQueued: unknown;
    lastPushErrorNotifiedAt: number;
    explicitSignOutInProgress: boolean;
    waterPending: Map<string, unknown>;
    waterRetryTimer: ReturnType<typeof setTimeout> | null;
    activeWaterWorker: unknown;
    waterHasError: boolean;
  };
  if (r.pushTimer) clearTimeout(r.pushTimer);
  if (r.pushRetryTimer) clearTimeout(r.pushRetryTimer);
  if (r.waterRetryTimer) clearTimeout(r.waterRetryTimer);
  r.client = null;
  r.user = null;
  r.almacenIdByName = {};
  r.shoppingListId = "shopping-list-1";
  r.sessionEpoch = 0;
  r.pushTimer = null;
  r.pushRetryTimer = null;
  r.activePush = null;
  r.pushQueued = null;
  r.lastPushErrorNotifiedAt = 0;
  r.explicitSignOutInProgress = false;
  r.waterPending = new Map();
  r.waterRetryTimer = null;
  r.activeWaterWorker = null;
  r.waterHasError = false;
  remote.onPushError = null;
  remote.onStatusChange = null;
  remote.onUnsyncedWrite = null;
  localStorage.clear();
  sessionStorage.clear();
}

function setup(config: Record<string, FakeTableConfig>): CallRecord[] {
  const calls: CallRecord[] = [];
  const r = remote as unknown as { client: unknown; user: unknown };
  r.client = makeFakeClient(config, calls);
  r.user = { id: "user-1" };
  return calls;
}

// ─── Helpers de la nueva firma con userId/epoch/mutationId explícitos ──────
// pushState()/schedulePush() ya no leen this.user — reciben el contexto de
// la operación de forma inmutable (ver diseño "sync/outbox-session-safety").
// Estos helpers reducen el ruido de los tests que no están probando ESE
// aspecto en concreto (la mayoría de los de más abajo, heredados de antes
// de la reescritura) — usan un userId/epoch por defecto consistentes con
// `setup()` (siempre "user-1").
function testCtx(overrides: Partial<{ userId: string; epoch: number; mutationId: string }> = {}) {
  return {
    userId: overrides.userId ?? "user-1",
    epoch: overrides.epoch ?? remote.sessionEpoch,
    mutationId: overrides.mutationId ?? `mut-${Math.random().toString(36).slice(2)}`,
    signal: new AbortController().signal,
  };
}

/** Además de construir el PendingPush, escribe la outbox real (mismo
    envelope atómico que mutate() escribiría) para que runPush() pueda
    hacer su compare-and-delete de verdad al confirmar — sin esto, "saved"
    nunca se emitiría (no habría nada que borrar), exactamente el
    comportamiento que se pretende garantizar. */
function testPush(state: FoodOSState, overrides: Partial<{ userId: string; epoch: number; mutationId: string; revision: number }> = {}) {
  const userId = overrides.userId ?? "user-1";
  const written = outbox.recordMutation(userId, state, "test-client");
  const pending = written.ok ? written.envelope.pending! : null;
  return {
    userId,
    epoch: overrides.epoch ?? remote.sessionEpoch,
    mutationId: overrides.mutationId ?? pending?.mutationId ?? `mut-${Math.random().toString(36).slice(2)}`,
    revision: overrides.revision ?? pending?.revision ?? 1,
    state,
  };
}

beforeEach(() => {
  resetRemote();
});

afterEach(() => {
  vi.useRealTimers();
  resetRemote();
});

describe("pushState — camino exitoso", () => {
  it("resuelve sin lanzar cuando todas las escrituras devuelven éxito", async () => {
    setup(successConfig());
    await expect(remote.pushState(testCtx(), makeState())).resolves.toBeUndefined();
  });
});

describe("pushState — perfil", () => {
  it("propaga el error de user_profiles.upsert sin tragárselo", async () => {
    const config = successConfig();
    config.user_profiles = { upsert: { error: { message: "RLS: permiso denegado" } } };
    const calls = setup(config);

    await expect(remote.pushState(testCtx(), makeState())).rejects.toThrow(/perfil.*RLS: permiso denegado/);

    // Mejor esfuerzo: el resto de tablas se intenta igualmente (son
    // independientes del perfil) — no se corta la cadena al primer fallo.
    expect(calls.some((c) => c.table === "nutrition_goals" && c.op === "upsert")).toBe(true);
    expect(calls.some((c) => c.table === "food_log" && c.op === "select")).toBe(true);
  });

  it("guarda el perfil con upsert (nunca con un update que podría no afectar ninguna fila en silencio)", async () => {
    // Antes: user_profiles.update().eq("user_id", userId). Si la fila no
    // existía todavía (o RLS filtraba el WHERE sin marcarlo como error),
    // Postgrest devuelve { error: null } con CERO filas afectadas — "éxito"
    // sin haber escrito nada. upsert(onConflict: "user_id") no tiene ese
    // resultado posible: o inserta, o actualiza, siempre queda una fila.
    const config = successConfig();
    const calls = setup(config);

    await remote.pushState(testCtx(), makeState());

    expect(calls.some((c) => c.table === "user_profiles" && c.op === "update")).toBe(false);
    const upsertCall = calls.find((c) => c.table === "user_profiles" && c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect((upsertCall!.args as { user_id: string }).user_id).toBe("user-1");
  });
});

describe("ensureBaseRows — perfil base", () => {
  it("propaga el error si el upsert de la fila base del perfil falla", async () => {
    const calls: CallRecord[] = [];
    const r = remote as unknown as { client: unknown; user: unknown };
    r.client = makeFakeClient(
      { user_profiles: { upsert: { error: { message: "RLS: permiso denegado" } } } },
      calls
    );
    r.user = { id: "user-1" };

    await expect(remote.ensureBaseRows()).rejects.toThrow(/RLS: permiso denegado/);
  });
});

describe("pushState — pesos", () => {
  it("propaga el error si el upsert de weight_log falla, y NO intenta el borrado en esa pasada", async () => {
    const config = successConfig();
    config.weight_log = { upsert: { error: { message: "constraint violada" } } };
    const calls = setup(config);
    const state = makeState({ weightLog: [{ date: "2026-08-01", kg: 80 }] });

    await expect(remote.pushState(testCtx(), state)).rejects.toThrow(/peso \(guardado\).*constraint violada/);
    expect(calls.some((c) => c.table === "weight_log" && c.op === "select")).toBe(false);
    expect(calls.some((c) => c.table === "weight_log" && c.op === "delete")).toBe(false);
  });

  it("propaga el error si la lectura previa al borrado falla", async () => {
    const config = successConfig();
    config.weight_log = { upsert: { error: null }, select: { error: { message: "timeout" } } };
    setup(config);
    const state = makeState({ weightLog: [{ date: "2026-08-01", kg: 80 }] });

    await expect(remote.pushState(testCtx(), state)).rejects.toThrow(/peso \(lectura para borrado\).*timeout/);
  });

  it("propaga el error si el borrado en sí falla", async () => {
    const config = successConfig();
    config.weight_log = {
      upsert: { error: null },
      select: { data: [{ log_date: "2026-07-01" }, { log_date: "2026-08-01" }], error: null },
      delete: { error: { message: "fk violation" } },
    };
    setup(config);
    const state = makeState({ weightLog: [{ date: "2026-08-01", kg: 80 }] }); // 2026-07-01 ya no está local

    await expect(remote.pushState(testCtx(), state)).rejects.toThrow(/peso \(borrado\).*fk violation/);
  });

  it("borrar TODAS las entradas locales SÍ se propaga al borrado remoto (antes el bloque entero se saltaba con weightLog vacío)", async () => {
    const config = successConfig();
    config.weight_log = {
      select: { data: [{ log_date: "2026-01-01" }, { log_date: "2026-01-02" }], error: null },
      delete: { error: null },
    };
    const calls = setup(config);
    const state = makeState({ weightLog: [] });

    await expect(remote.pushState(testCtx(), state)).resolves.toBeUndefined();

    expect(calls.some((c) => c.table === "weight_log" && c.op === "upsert")).toBe(false); // sin filas que subir
    expect(calls.some((c) => c.table === "weight_log" && c.op === "select")).toBe(true);
    const deleteCall = calls.find((c) => c.table === "weight_log" && c.op === "in");
    expect(deleteCall?.args).toEqual(["log_date", ["2026-01-01", "2026-01-02"]]);
  });
});

describe("pushState — objetivos nutricionales", () => {
  it("propaga el error de nutrition_goals.upsert", async () => {
    const config = successConfig();
    config.nutrition_goals = { upsert: { error: { message: "check constraint" } } };
    setup(config);

    await expect(remote.pushState(testCtx(), makeState())).rejects.toThrow(/objetivos nutricionales.*check constraint/);
  });
});

describe("pushState — eliminaciones (syncTable)", () => {
  it("un fallo en el borrado de una tabla no impide intentar las demás, pero sí se propaga al final", async () => {
    const config = successConfig();
    config.inventory_items = {
      upsert: { error: null },
      select: { data: [{ id: "11111111-1111-1111-1111-111111111111" }], error: null }, // no está en el estado local -> se intenta borrar
      delete: { error: { message: "permiso denegado" } },
    };
    const calls = setup(config);

    await expect(remote.pushState(testCtx(), makeState())).rejects.toThrow(/inventario.*permiso denegado/);

    // Mejor esfuerzo: food_log (tabla independiente, más adelante en la
    // secuencia) se intentó igualmente pese al fallo de inventario.
    expect(calls.some((c) => c.table === "food_log" && c.op === "select")).toBe(true);
  });

  it("un fallo en la lectura previa al borrado de una tabla se propaga sin intentar el delete", async () => {
    const config = successConfig();
    config.gastos = { upsert: { error: null }, select: { error: { message: "network" } } };
    const calls = setup(config);

    await expect(remote.pushState(testCtx(), makeState())).rejects.toThrow(/gastos.*network/);
    expect(calls.some((c) => c.table === "gastos" && c.op === "delete")).toBe(false);
  });
});

describe("pushState — fallos múltiples", () => {
  it("agrega todos los fallos en un único error en vez de quedarse solo con el primero", async () => {
    const config = successConfig();
    config.user_profiles = { upsert: { error: { message: "err-perfil" } } };
    config.nutrition_goals = { upsert: { error: { message: "err-objetivos" } } };
    setup(config);

    await expect(remote.pushState(testCtx(), makeState())).rejects.toThrow(/err-perfil/);
    await expect(remote.pushState(testCtx(), makeState())).rejects.toThrow(/err-objetivos/);
  });
});

describe("pushState — reintento idempotente tras éxito parcial", () => {
  it("reenviar el mismo snapshot tras arreglarse el fallo tiene éxito, sin duplicar las escrituras que ya habían funcionado", async () => {
    const config = successConfig();
    config.user_profiles = { upsert: { error: { message: "caída temporal" } } };
    const calls = setup(config);
    const state = makeState({ profile: null, nutrition: { kcal: 2000, protein: 140, carbs: 200, fat: 60, mode: "fat_loss" } });

    await expect(remote.pushState(testCtx(), state)).rejects.toThrow(/perfil/);
    const goalCallsFirstAttempt = calls.filter((c) => c.table === "nutrition_goals" && c.op === "upsert");
    expect(goalCallsFirstAttempt).toHaveLength(1);

    // Supabase se recupera: reintentar el MISMO snapshot debe tener éxito.
    config.user_profiles = { upsert: { error: null } };
    await expect(remote.pushState(testCtx(), state)).resolves.toBeUndefined();

    // nutrition_goals se reenvía con el MISMO payload que la vez anterior
    // (upsert con onConflict es idempotente) — no se duplica ni se pierde nada.
    const goalCallsSecondAttempt = calls.filter((c) => c.table === "nutrition_goals" && c.op === "upsert");
    expect(goalCallsSecondAttempt).toHaveLength(2);
    expect(goalCallsSecondAttempt[0].args).toEqual(goalCallsSecondAttempt[1].args);
  });

  it("un item con id legacy (no UUID) mantiene la MISMA id remota al reintentar — no genera una fila duplicada", async () => {
    // Antes: ensureUuid(value) llamaba a crypto.randomUUID() cada vez que
    // `value` no era un UUID — no determinista. syncTable() mutaba
    // item.id en el propio estado tras la primera pasada, pero esa
    // estabilidad dependía de reutilizar el MISMO objeto JS entre intentos;
    // ahora ensureUuid() deriva la UUID de forma determinista a partir del
    // id legacy (ver utils.ts), así que el resultado es el mismo aunque el
    // objeto de estado NO sea el mismo (recarga de página, otra sesión...).
    const config = successConfig();
    config.user_profiles = { upsert: { error: { message: "caída temporal" } } }; // fuerza el fallo parcial
    const calls = setup(config);

    const legacyItem = {
      id: "legacy-item-42", // id no-UUID, como los que venían de antes de migrar a Supabase
      name: "Pechuga de pollo",
      qty: 300,
      unit: "g",
      storage: "Nevera" as const,
      expires: "2026-09-01",
      price: 3.2,
      kcal: 165,
      protein: 31,
    };
    const state = makeState({ inventory: [legacyItem] });

    await expect(remote.pushState(testCtx(), state)).rejects.toThrow(/perfil/);
    const inventoryUpsertsFirst = calls.filter((c) => c.table === "inventory_items" && c.op === "upsert");
    expect(inventoryUpsertsFirst).toHaveLength(1);
    const idAfterFirstAttempt = ((inventoryUpsertsFirst[0].args as Array<{ id: string }>)[0]).id;

    // La misma derivación determinista, calculada de forma completamente
    // independiente (fuera de pushState) a partir del id legacy original,
    // debe coincidir con lo que se mandó a Supabase.
    const { ensureUuid } = await import("./utils");
    expect(idAfterFirstAttempt).toBe(ensureUuid("legacy-item-42"));

    // Reintento: mismo snapshot (mismo objeto de estado, como hace runPush).
    config.user_profiles = { upsert: { error: null } };
    await expect(remote.pushState(testCtx(), state)).resolves.toBeUndefined();

    const inventoryUpsertsSecond = calls.filter((c) => c.table === "inventory_items" && c.op === "upsert");
    expect(inventoryUpsertsSecond).toHaveLength(2);
    const idAfterSecondAttempt = ((inventoryUpsertsSecond[1].args as Array<{ id: string }>)[0]).id;
    expect(idAfterSecondAttempt).toBe(idAfterFirstAttempt); // MISMA id remota, no una nueva aleatoria
  });

  it("un item con id legacy mantiene la misma id remota incluso partiendo de un snapshot NUEVO (objeto distinto) — no depende de mutación en memoria", async () => {
    // Simula lo que antes rompía: la app se recarga (o es otra pestaña/
    // sesión) entre el primer intento y el reintento, así que el segundo
    // pushState() recibe un objeto de estado DISTINTO, reconstruido desde
    // localStorage con el id legacy original tal cual (la mutación en
    // memoria de la primera pasada nunca sobrevivió a la recarga).
    const config = successConfig();
    const calls = setup(config);
    const legacyItemA = { id: "legacy-item-7", name: "Avena", qty: 500, unit: "g", storage: "Despensa" as const, expires: "2026-10-01", price: 1.9, kcal: 380, protein: 13 };
    const legacyItemB = { id: "legacy-item-7", name: "Avena", qty: 500, unit: "g", storage: "Despensa" as const, expires: "2026-10-01", price: 1.9, kcal: 380, protein: 13 };

    await remote.pushState(testCtx(), makeState({ inventory: [legacyItemA] }));
    await remote.pushState(testCtx(), makeState({ inventory: [legacyItemB] })); // objeto NUEVO, mismo id legacy

    const inventoryUpserts = calls.filter((c) => c.table === "inventory_items" && c.op === "upsert");
    expect(inventoryUpserts).toHaveLength(2);
    const idA = (inventoryUpserts[0].args as Array<{ id: string }>)[0].id;
    const idB = (inventoryUpserts[1].args as Array<{ id: string }>)[0].id;
    expect(idA).toBe(idB); // misma id remota pese a ser dos objetos JS distintos
  });
});

describe("runPush (vía schedulePush) — no marca guardado en error y reintenta", () => {
  it("nunca reporta 'saved' tras un fallo, reporta 'error', y el reintento automático tiene éxito si Supabase se recupera", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    config.nutrition_goals = { upsert: { error: { message: "temporal" } } };
    setup(config);
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);

    const state = makeState();
    remote.schedulePush(testPush(state));
    expect(statuses).toEqual(["syncing"]);

    // PUSH_DEBOUNCE_MS = 400ms en data-layer.ts — dispara runPush().
    await vi.advanceTimersByTimeAsync(500);
    expect(statuses).not.toContain("saved");
    expect(statuses.at(-1)).toBe("error");

    // Supabase se recupera antes del reintento automático.
    config.nutrition_goals = { upsert: { error: null } };

    // PUSH_RETRY_MS = 10_000ms en data-layer.ts.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(statuses.at(-1)).toBe("saved");
  });
});

// Conecta un RealtimeHydrationGate real (no un mock) a remote.onStatusChange
// exactamente como lo hace state.tsx — para probar la integración completa
// runPush() -> onStatusChange() -> gate, no solo cada pieza suelta. Se usa
// en varios describe de "carrera" de más abajo.
async function bindGateLikeStateTsx() {
  const { RealtimeHydrationGate } = await import("./realtime-hydration-gate");
  const gate = new RealtimeHydrationGate();
  const statuses: string[] = [];
  let hydrateCount = 0;
  remote.onStatusChange = (status) => {
    statuses.push(status);
    if (gate.onPushStatusChange(status)) hydrateCount++;
  };
  return { gate, statuses, getHydrateCount: () => hydrateCount };
}

describe("runPush — carrera: 'saved' solo tras el ÚLTIMO snapshot, no tras cada push individual", () => {
  // B2 (revisión externa, 2026-08-22, ronda 3): "saved" se emitía en cuanto
  // ESTE push terminaba bien, sin comprobar si mientras tanto había quedado
  // otra escritura pendiente. RealtimeHydrationGate libera un refresco en
  // tiempo real diferido en cuanto ve "saved" — así que ese "saved"
  // prematuro podía disparar una hidratación que pisara una edición más
  // reciente (aún sin confirmar) con el snapshot anterior ya persistido.
  //
  // Secuencia exacta pedida: push A en curso -> llega un evento realtime
  // (se difiere) -> el usuario edita y crea el snapshot B mientras A sigue
  // en vuelo -> A termina bien (NO debe soltar el refresco: B sigue
  // pendiente) -> B termina bien (AHORA sí, una única vez).
  it("B queda en pushTimer (su debounce aún no ha disparado cuando A termina)", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    config.user_profiles = { upsert: () => gateA.then(() => ({ error: null })) };
    setup(config);
    const { gate, statuses, getHydrateCount } = await bindGateLikeStateTsx();

    // 1. Empieza push A (queda bloqueado en el gate del perfil).
    remote.schedulePush(testPush(makeState()));
    await vi.advanceTimersByTimeAsync(500); // dispara runPush(A); A sigue "en vuelo"

    // 2. Llega un evento realtime mientras A está pendiente -> se difiere.
    expect(gate.onRealtimeRefresh(remote.hasPendingPush())).toBe(false);

    // 3. El usuario edita: snapshot B. Como A sigue en curso, esto arma un
    //    nuevo pushTimer (todavía no ha pasado el debounce).
    remote.schedulePush(testPush(makeState({ weeklyBudget: 999 })));

    // 4. A termina bien.
    releaseA();
    await vi.advanceTimersByTimeAsync(50);

    // 5. Ese éxito de A NO debe emitir "saved" ni soltar el refresco
    //    diferido — B sigue sin confirmar (su pushTimer sigue pendiente).
    expect(statuses).not.toContain("saved");
    expect(getHydrateCount()).toBe(0);

    // 6. B (tras su propio debounce) termina también con éxito.
    await vi.advanceTimersByTimeAsync(500);

    // Solo AHORA, con B confirmado y nada más pendiente, se emite "saved"
    // y se procesa el refresco diferido — una única vez.
    expect(statuses.at(-1)).toBe("saved");
    expect(getHydrateCount()).toBe(1);
  });

  it("B queda en pushQueued (su debounce dispara MIENTRAS A sigue en curso)", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    config.user_profiles = { upsert: () => gateA.then(() => ({ error: null })) };
    setup(config);
    const { gate, statuses, getHydrateCount } = await bindGateLikeStateTsx();

    // 1. Empieza push A (queda bloqueado en el gate del perfil).
    remote.schedulePush(testPush(makeState()));
    await vi.advanceTimersByTimeAsync(500); // dispara runPush(A); A sigue "en vuelo"

    // 2. Evento realtime diferido.
    expect(gate.onRealtimeRefresh(remote.hasPendingPush())).toBe(false);

    // 3. Snapshot B: se programa su debounce.
    remote.schedulePush(testPush(makeState({ weeklyBudget: 999 })));

    // 4. El debounce de B dispara AHORA, con A todavía bloqueado en el gate
    //    -> runPush(B) ve this.pushing === true y lo mueve a pushQueued.
    await vi.advanceTimersByTimeAsync(500);

    // 5. A termina bien.
    releaseA();
    await vi.advanceTimersByTimeAsync(50);

    // 6. A tenía éxito, pero había un pushQueued (B) esperando -> NO se
    //    emite "saved" todavía, se encadena el push de B en su lugar.
    expect(statuses).not.toContain("saved");
    expect(getHydrateCount()).toBe(0);

    // 7. B se reprograma (nuevo debounce) y termina con éxito.
    await vi.advanceTimersByTimeAsync(500);

    expect(statuses.at(-1)).toBe("saved");
    expect(getHydrateCount()).toBe(1);
  });
});

describe("runPush — no reintenta un snapshot obsoleto si ya hay uno más reciente pendiente", () => {
  // B2 (revisión externa, 2026-08-22, ronda 4): al fallar, runPush()
  // programaba el reintento de A INCONDICIONALMENTE — el chequeo de "¿hay
  // ya algo más reciente?" solo se hacía DENTRO del propio callback del
  // reintento, 10s más tarde, nunca al programarlo. Si el snapshot más
  // reciente (B) ya estaba en pushTimer (su debounce sin disparar todavía)
  // en el momento exacto en que A fallaba, nada cancelaba ese reintento
  // mientras tanto: B se ejecutaba con éxito, y 10s después el reintento
  // de A disparaba de todos modos (pushQueued/pushTimer ya estaban limpios
  // para entonces) y reenviaba el snapshot VIEJO, sobrescribiendo a B.
  //
  // Secuencia exacta pedida: A queda bloqueado -> se programa B (queda en
  // pushTimer) -> A termina con error -> B termina correctamente -> se
  // avanza el reloj más de PUSH_RETRY_MS -> A NO debe ejecutarse una
  // tercera vez, el último payload persistido debe ser B, y "saved" +
  // la hidratación diferida solo deben producirse tras B.
  it("B en pushTimer cuando A falla: el reintento de A nunca se programa, B persiste como el último payload", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    config.user_profiles = { upsert: () => gateA.then(() => ({ error: { message: "caída temporal" } })) };
    const calls = setup(config);
    const { gate, statuses, getHydrateCount } = await bindGateLikeStateTsx();

    // 1. Empieza push A (queda bloqueado en el gate del perfil).
    remote.schedulePush(testPush(makeState({ weeklyBudget: 111 })));
    await vi.advanceTimersByTimeAsync(500); // dispara runPush(A); A sigue "en vuelo"

    expect(gate.onRealtimeRefresh(remote.hasPendingPush())).toBe(false); // evento realtime diferido

    // 2. Se programa B: queda en pushTimer (su debounce aún no ha disparado).
    remote.schedulePush(testPush(makeState({ weeklyBudget: 222 })));

    // 3. A termina con error MIENTRAS el pushTimer de B sigue pendiente.
    releaseA();
    await vi.advanceTimersByTimeAsync(50);
    expect(statuses.at(-1)).toBe("error");
    expect(getHydrateCount()).toBe(0); // el refresco sigue diferido, A no tuvo éxito

    // Supabase se recupera para el resto (B, y el reintento fantasma de A
    // que NO debería llegar a producirse).
    config.user_profiles = { upsert: { error: null } };

    // 4. B (tras su propio debounce) se ejecuta y tiene éxito.
    await vi.advanceTimersByTimeAsync(500);
    expect(statuses.at(-1)).toBe("saved");
    expect(getHydrateCount()).toBe(1); // el refresco diferido se procesa ahora, tras B

    const profileUpsertsAfterB = calls.filter((c) => c.table === "user_profiles" && c.op === "upsert");
    expect(profileUpsertsAfterB).toHaveLength(2); // A (fallido) + B (con éxito)
    const lastPayload = profileUpsertsAfterB.at(-1)!.args as { weekly_food_budget: number };
    expect(lastPayload.weekly_food_budget).toBe(222); // B, no el 111 de A

    // 5. Más de PUSH_RETRY_MS después del fallo de A: el reintento de A
    //    nunca se programó (porque B ya estaba en pushTimer cuando A
    //    falló), así que no debe haber una tercera ejecución ni una nueva
    //    transición de estado.
    const statusesBeforeWait = statuses.length;
    await vi.advanceTimersByTimeAsync(10_500);

    expect(statuses.length).toBe(statusesBeforeWait); // ningún ciclo syncing/error/saved fantasma
    const profileUpsertsFinal = calls.filter((c) => c.table === "user_profiles" && c.op === "upsert");
    expect(profileUpsertsFinal).toHaveLength(2); // sigue siendo A + B, nunca un tercer envío
    expect(getHydrateCount()).toBe(1); // no se dispara una segunda hidratación
  });

  it("B en pushQueued cuando A falla: tampoco reintenta a A (cubierto por schedulePush(queued) cancelando el retry)", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    config.user_profiles = { upsert: () => gateA.then(() => ({ error: { message: "caída temporal" } })) };
    const calls = setup(config);
    const { gate, statuses, getHydrateCount } = await bindGateLikeStateTsx();

    // 1. Empieza push A (bloqueado en el gate del perfil).
    remote.schedulePush(testPush(makeState({ weeklyBudget: 111 })));
    await vi.advanceTimersByTimeAsync(500); // runPush(A) arranca, sigue en vuelo

    expect(gate.onRealtimeRefresh(remote.hasPendingPush())).toBe(false); // evento realtime diferido

    // 2. Se programa B...
    remote.schedulePush(testPush(makeState({ weeklyBudget: 222 })));
    // ...y su debounce dispara MIENTRAS A sigue bloqueado -> runPush(B) ve
    // this.pushing === true y lo mueve a pushQueued.
    await vi.advanceTimersByTimeAsync(500);

    // 3. A termina con error, con B ya en pushQueued.
    config.user_profiles = { upsert: { error: null } }; // Supabase se recupera para B
    releaseA();
    await vi.advanceTimersByTimeAsync(50);

    // 4. B se encadena (schedulePush(queued) en el finally) y termina con éxito.
    await vi.advanceTimersByTimeAsync(500);
    expect(statuses.at(-1)).toBe("saved");
    expect(getHydrateCount()).toBe(1);

    const profileUpsertsBeforeWait = calls.filter((c) => c.table === "user_profiles" && c.op === "upsert").length;
    const statusesBeforeWait = statuses.length;

    // 5. Más de PUSH_RETRY_MS después: sin reintento fantasma de A.
    await vi.advanceTimersByTimeAsync(10_500);

    expect(calls.filter((c) => c.table === "user_profiles" && c.op === "upsert").length).toBe(profileUpsertsBeforeWait);
    expect(statuses.length).toBe(statusesBeforeWait);
  });
});

// ─── nutrition-v3.1 — round-trip real de trainingActivity vía pushState/pullState ──
// Corrección de revisión: el test anterior solo hacía
// JSON.parse(JSON.stringify(...)) + migrateLegacyTrainingActivity, sin pasar
// por pushState/pullState ni por el mapper real de data-layer.ts. Este test
// SÍ ejercita ambos: escribe con el cliente falso ya existente en este
// archivo, captura el payload jsonb exacto que se habría guardado, lo
// devuelve como si fuera la fila leída de vuelta de Supabase, y confirma que
// pullState() reconstruye el mismo TrainingActivityProfile.

interface FakeSelectResult { data: unknown; error: { message: string } | null }

/** Cliente falso de solo lectura para pullState() — reproduce las cadenas
    .select().eq()... .maybeSingle() (perfil) y .select().eq()...order()
    .limit() (el resto de tablas), sin reutilizar makeFakeClient (ese es
    de escritura, pensado para pushState). */
function makeFakePullClient(tableData: Record<string, FakeSelectResult>) {
  return {
    from(table: string) {
      const fallback: FakeSelectResult = { data: [], error: null };
      const resolved = () => Promise.resolve(tableData[table] ?? fallback);
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => resolved(),
        then: (resolve: (v: FakeSelectResult) => unknown, reject?: (e: unknown) => unknown) =>
          resolved().then(resolve, reject),
      };
      return builder;
    },
  };
}

function fullTrainingActivity(): TrainingActivityProfile {
  return {
    lifestyleActivity: "light",
    strengthDaysPerWeek: 4,
    cardioDaysPerWeek: 4,
    strengthAvgDurationMin: 70,
    cardioAvgDurationMin: 25,
    habitualSteps: 8000,
    cardioType: "row",
    cardioIntensity: "vigorous",
    strengthIntensity: "light",
    cardioOverlapDaysPerWeek: 2,
    strengthAvgDurationMinIncludesCardio: true,
    stepsIncludeCardio: true,
    isHabitual: false,
  };
}

function fullProfile(training: TrainingActivityProfile): PhysicalProfile {
  return {
    age: 24, sex: "male", heightCm: 177, weightKg: 124,
    bodyFatPct: null, activityLevel: "sedentary", goal: "recomp",
    gymDays: [1, 2, 3, 4, 5], allergies: [], excludedFoods: [],
    activityModelVersion: "lifestyle_plus_training",
    trainingActivity: training,
  };
}

describe("nutrition-v3.1 — round-trip real de trainingActivity (pushState → pullState)", () => {
  it("todos los campos nuevos sobreviven pushState (upsert real) + pullState (select + mapper real), no solo JSON.stringify", async () => {
    const training = fullTrainingActivity();
    const profile = fullProfile(training);
    const calls = setup(successConfig());

    await remote.pushState(testCtx(), makeState({ profile }));

    const upsertCall = calls.find((c) => c.table === "user_profiles" && c.op === "upsert");
    expect(upsertCall).toBeDefined();
    const payload = upsertCall!.args as Record<string, unknown>;
    const extraState = payload.extra_state as Record<string, unknown>;
    // Confirma que el payload REAL enviado a Supabase lleva el objeto
    // completo — si algún mapper de escritura lo recortara, fallaría aquí
    // antes incluso de llegar a pullState.
    expect(extraState.trainingActivity).toEqual(training);

    // Simula la fila que Supabase devolvería en la siguiente lectura: mismas
    // columnas tabulares que el upsert escribió + el mismo extra_state jsonb
    // (jsonb hace round-trip de JSON exacto, sin recortar nada por su cuenta).
    const profileRow = {
      mascot_id: "zana", weekly_food_budget: 70,
      age: payload.age, sex: payload.sex, height_cm: payload.height_cm, weight_kg: payload.weight_kg,
      body_fat_pct: payload.body_fat_pct, body_fat_source: payload.body_fat_source,
      activity_level: payload.activity_level, goal: payload.goal, gym_days: payload.gym_days,
      allergies: payload.allergies, excluded_foods: payload.excluded_foods,
      target_weight_kg: payload.target_weight_kg, experience_level: payload.experience_level,
      equipment_access: payload.equipment_access, activity_model_version: payload.activity_model_version,
      extra_state: extraState,
    };

    const r = remote as unknown as { client: unknown; shoppingListId: string | null };
    r.client = makeFakePullClient({ user_profiles: { data: profileRow, error: null } });
    r.shoppingListId = "shopping-list-1";

    const result = await remote.pullState(makeState({ profile: null }));

    expect(result.profile).not.toBeNull();
    expect(result.profile!.trainingActivity).toEqual(training);
  });
});

// ─── sync/outbox-session-safety — activePush por token, sesión A→B ─────────
describe("runPush — activePush por token (corrección de revisión: sustituye al booleano global `pushing`)", () => {
  it("push A activo → cambia la sesión a B → B guarda antes de que A termine: B se ejecuta de inmediato, no queda bloqueado en pushQueued", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    config.user_profiles = { upsert: () => gateA.then(() => ({ error: null })) };
    const calls = setup(config);

    // A: push en vuelo, bloqueado en el gate.
    const epochA = remote.sessionEpoch;
    remote.schedulePush(testPush(makeState({ weeklyBudget: 1 }), { userId: "user-a", epoch: epochA }));
    await vi.advanceTimersByTimeAsync(500); // dispara runPush(A) — sigue "en vuelo" (gateA sin liberar)

    // Cambio de sesión a B: resetSessionState() limpia activePush de inmediato.
    remote.resetSessionState();
    const epochB = remote.sessionEpoch;
    expect(epochB).not.toBe(epochA);
    (remote as unknown as { user: { id: string } }).user = { id: "user-b" };

    // B guarda ANTES de que A termine — debe ejecutarse ya, no quedar en cola.
    remote.schedulePush(testPush(makeState({ weeklyBudget: 2 }), { userId: "user-b", epoch: epochB }));
    await vi.advanceTimersByTimeAsync(500);

    const bUpsertBeforeARelease = calls.filter((c) => c.table === "user_profiles" && c.op === "upsert").length;
    expect(bUpsertBeforeARelease).toBeGreaterThan(0); // B ya escribió, sin esperar a A

    // Ahora termina A (tarde) — su finally no debe tocar nada de B.
    releaseA();
    await vi.advanceTimersByTimeAsync(50);

    const upsertsAfter = calls.filter((c) => c.table === "user_profiles" && c.op === "upsert").length;
    expect(upsertsAfter).toBe(bUpsertBeforeARelease); // A no reintenta ni añade un upsert extra bajo la sesión nueva
  });

  it("el finally de A (éxito tardío) no emite 'saved' para la sesión de B, ni le borra su outbox", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    config.user_profiles = { upsert: () => gateA.then(() => ({ error: null })) };
    setup(config);
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);

    const epochA = remote.sessionEpoch;
    const pushA = testPush(makeState({ weeklyBudget: 1 }), { userId: "user-a", epoch: epochA });
    remote.schedulePush(pushA);
    await vi.advanceTimersByTimeAsync(500);

    remote.resetSessionState();
    const epochB = remote.sessionEpoch;
    (remote as unknown as { user: { id: string } }).user = { id: "user-b" };
    outbox.recordMutation("user-b", makeState({ weeklyBudget: 5 }), "tab-b"); // B tiene su propio pendiente

    statuses.length = 0;
    releaseA();
    await vi.advanceTimersByTimeAsync(50);

    expect(statuses).not.toContain("saved"); // el éxito tardío de A no puede marcar nada como confirmado para B
    expect(outbox.hasPending("user-b")).toBe(true); // la outbox de B sigue intacta
    void epochB;
  });

  it("el finally de A (fallo tardío) no dispara el toast de error ni un retry para la sesión de B", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    config.user_profiles = { upsert: () => gateA.then(() => ({ error: { message: "caída tardía" } })) };
    setup(config);
    let notifyCount = 0;
    remote.onPushError = () => { notifyCount++; };

    const epochA = remote.sessionEpoch;
    remote.schedulePush(testPush(makeState({ weeklyBudget: 1 }), { userId: "user-a", epoch: epochA }));
    await vi.advanceTimersByTimeAsync(500);

    remote.resetSessionState(); // sesión cambia ANTES de que A falle
    releaseA();
    await vi.advanceTimersByTimeAsync(50);

    expect(notifyCount).toBe(0); // el fallo de una sesión ya cerrada no genera aviso
    await vi.advanceTimersByTimeAsync(11_000); // ni siquiera tras el plazo de reintento
    expect(notifyCount).toBe(0);
  });

  it("resetSessionState() incrementa epoch, cancela timers/retry, vacía cola y cachés", () => {
    const before = remote.sessionEpoch;
    const r = remote as unknown as {
      pushTimer: unknown; pushRetryTimer: unknown; activePush: unknown; pushQueued: unknown;
      almacenIdByName: Record<string, string>; shoppingListId: string | null;
    };
    r.pushTimer = setTimeout(() => {}, 10_000);
    r.pushRetryTimer = setTimeout(() => {}, 10_000);
    r.activePush = { token: "x", userId: "u", epoch: before, controller: new AbortController() };
    r.pushQueued = testPush(makeState());
    r.almacenIdByName = { Nevera: "abc" };
    r.shoppingListId = "list-1";

    remote.resetSessionState();

    expect(remote.sessionEpoch).toBe(before + 1);
    expect(r.pushTimer).toBeNull();
    expect(r.pushRetryTimer).toBeNull();
    expect(r.activePush).toBeNull();
    expect(r.pushQueued).toBeNull();
    expect(r.almacenIdByName).toEqual({});
    expect(r.shoppingListId).toBeNull();
  });

  it("signOut() descarta el envelope completo del usuario saliente, exista o no pending", async () => {
    setup(successConfig());
    const r = remote as unknown as { user: { id: string }; client: { auth: { signOut: () => Promise<{ error: null }> } } };
    r.user = { id: "user-out" };
    r.client.auth = { signOut: async () => ({ error: null }) };
    outbox.recordMutation("user-out", makeState({ weeklyBudget: 9 }), "tab-1");
    await remote.signOut();
    expect(outbox.readEnvelope("user-out")).toBeNull();
  });

  it("signOut() intenta borrar las CUATRO claves posibles de este usuario — envelope activo, envelope aparcado, agua activa, agua aparcada (corrección de revisión, P1, quinta ronda)", async () => {
    setup(successConfig());
    const r = remote as unknown as { user: { id: string }; client: { auth: { signOut: () => Promise<{ error: null }> } } };
    r.user = { id: "user-out" };
    r.client.auth = { signOut: async () => ({ error: null }) };

    // Las cuatro claves, todas pobladas de antemano.
    outbox.recordMutation("user-out", makeState({ weeklyBudget: 9 }), "tab-1");
    outbox.parkIfPending("user-out"); // mueve el envelope activo a aparcado...
    outbox.recordMutation("user-out", makeState({ weeklyBudget: 20 }), "tab-1"); // ...y deja también uno activo nuevo
    outbox.writeWaterPending("user-out", { "2026-08-24": 500 });
    outbox.parkWaterIfPending("user-out"); // mueve el agua activa a aparcada...
    outbox.writeWaterPending("user-out", { "2026-08-25": 250 }); // ...y deja también agua activa nueva

    const result = await remote.signOut();

    expect(result.cleanupOk).toBe(true);
    expect(outbox.readEnvelope("user-out")).toBeNull(); // envelope activo
    expect(outbox.restoreParked("user-out").value).toBeNull(); // envelope aparcado (antes NO se borraba — P1)
    expect(outbox.readWaterPending("user-out")).toEqual({}); // agua activa
    expect(outbox.restoreParkedWater("user-out").value).toBeNull(); // agua aparcada
  });

  it("REGRESIÓN (P1, séptima ronda): auth.signOut() pone remote.user a null (como en el cliente real, vía SIGNED_OUT durante _removeSession()) ANTES de resolver — las cuatro claves del usuario ORIGINAL deben borrarse igual", async () => {
    setup(successConfig());
    const r = remote as unknown as {
      user: { id: string } | null;
      client: { auth: { signOut: () => Promise<{ error: null }> } };
    };
    r.user = { id: "user-out" };

    // Las cuatro claves, todas pobladas de antemano.
    outbox.recordMutation("user-out", makeState({ weeklyBudget: 9 }), "tab-1");
    outbox.parkIfPending("user-out");
    outbox.recordMutation("user-out", makeState({ weeklyBudget: 20 }), "tab-1");
    outbox.writeWaterPending("user-out", { "2026-08-24": 500 });
    outbox.parkWaterIfPending("user-out");
    outbox.writeWaterPending("user-out", { "2026-08-25": 250 });

    // Simula el comportamiento REAL de @supabase/auth-js: _removeSession()
    // dispara SIGNED_OUT (que el callback de onAuthChange() traduce en
    // `this.user = ... ?? null`) DURANTE la propia llamada a signOut(),
    // antes de que la promesa resuelva para quien la llamó.
    r.client.auth = {
      signOut: async () => {
        r.user = null; // el equivalente al callback SIGNED_OUT síncrono
        return { error: null };
      },
    };

    const result = await remote.signOut();

    expect(result.ok).toBe(true);
    // Las cuatro claves del usuario ORIGINAL ("user-out") se borraron —
    // nunca se leyó `this.user` (ya null) para decidir qué limpiar.
    expect(outbox.readEnvelope("user-out")).toBeNull();
    expect(outbox.restoreParked("user-out").value).toBeNull();
    expect(outbox.readWaterPending("user-out")).toEqual({});
    expect(outbox.restoreParkedWater("user-out").value).toBeNull();
  });

  it("cleanupOk es false si CUALQUIERA de las cuatro limpiezas falla — signOut() no lo oculta", async () => {
    setup(successConfig());
    const r = remote as unknown as { user: { id: string }; client: { auth: { signOut: () => Promise<{ error: null }> } } };
    r.user = { id: "user-out" };
    r.client.auth = { signOut: async () => ({ error: null }) };
    outbox.recordMutation("user-out", makeState({ weeklyBudget: 9 }), "tab-1");
    outbox.parkIfPending("user-out"); // deja SOLO el envelope aparcado poblado

    const spy = vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new DOMException("blocked"); });
    const result = await remote.signOut();
    spy.mockRestore();

    expect(result.cleanupOk).toBe(false);
  });

  it("REGRESIÓN (P1, sexta ronda): si auth.signOut() devuelve error, NO se toca ningún estado local — ni el usuario, ni el epoch, ni las cuatro claves", async () => {
    setup(successConfig());
    const r = remote as unknown as {
      user: { id: string } | null;
      sessionEpoch: number;
      client: { auth: { signOut: () => Promise<{ error: unknown }> } };
    };
    r.user = { id: "user-out" };
    const epochBefore = remote.sessionEpoch;
    const authError = { message: "network down" };
    r.client.auth = { signOut: async () => ({ error: authError }) };

    // Las cuatro claves, pobladas de antemano — si el bug reapareciera
    // (limpiar ANTES de conocer el resultado remoto), desaparecerían pese
    // a que auth.signOut() falló.
    outbox.recordMutation("user-out", makeState({ weeklyBudget: 9 }), "tab-1");
    outbox.parkIfPending("user-out");
    outbox.recordMutation("user-out", makeState({ weeklyBudget: 20 }), "tab-1");
    outbox.writeWaterPending("user-out", { "2026-08-24": 500 });
    outbox.parkWaterIfPending("user-out");
    outbox.writeWaterPending("user-out", { "2026-08-25": 250 });

    const result = await remote.signOut();

    expect(result.ok).toBe(false);
    expect(result.error).toEqual(authError);

    // 1. remote.user sigue siendo el usuario original — NUNCA se puso a null.
    expect(remote.user).toEqual({ id: "user-out" });
    // 2. La sesión no se "terminó" — el epoch no cambió (resetSessionState()
    //    nunca se llamó) y explicitSignOutInProgress ya se liberó.
    expect(remote.sessionEpoch).toBe(epochBefore);
    expect(remote.explicitSignOutInProgress).toBe(false);
    // Las cuatro claves siguen intactas — nada se limpió sin confirmar el
    // cierre. Se comprueba la presencia física en localStorage en vez de
    // restoreParked()/restoreParkedWater() (que, por diseño — regla de
    // seguridad de la quinta ronda — no restauran un aparcado si ya hay
    // un activo, que es justo el caso aquí).
    expect(outbox.readEnvelope("user-out")?.state.weeklyBudget).toBe(20);
    expect(localStorage.getItem("foodos-parked-v1-user-out")).not.toBeNull();
    expect(outbox.readWaterPending("user-out")).toEqual({ "2026-08-25": 250 });
    expect(localStorage.getItem("foodos-water-parked-v1-user-out")).not.toBeNull();
  });

  it("tras un reintento correcto (auth.signOut() ya sin error), SÍ se limpian las cuatro claves y ok pasa a true", async () => {
    setup(successConfig());
    const r = remote as unknown as {
      user: { id: string } | null;
      client: { auth: { signOut: () => Promise<{ error: unknown }> } };
    };
    r.user = { id: "user-out" };
    let attempt = 0;
    r.client.auth = { signOut: async () => { attempt++; return { error: attempt === 1 ? { message: "network down" } : null }; } };
    outbox.recordMutation("user-out", makeState({ weeklyBudget: 9 }), "tab-1");

    const first = await remote.signOut();
    expect(first.ok).toBe(false);
    expect(outbox.readEnvelope("user-out")).not.toBeNull(); // sigue ahí tras el primer fallo

    r.user = { id: "user-out" }; // el caller reintenta con la sesión intacta (nunca se puso a null)
    const second = await remote.signOut();
    expect(second.ok).toBe(true);
    expect(second.cleanupOk).toBe(true);
    expect(outbox.readEnvelope("user-out")).toBeNull(); // ahora sí se limpió
    expect(remote.user).toBeNull();
  });
});

describe("setWaterTargetDurable — upsert absoluto e idempotente (bloqueante §5, corrección de revisión P0)", () => {
  // Corrección de revisión (P0, dos hallazgos): la versión anterior hacía
  // un select() filtrado por op.userId y LUEGO llamaba a
  // fn_water_increment(delta), que usa auth.uid() internamente — si la
  // sesión cambiaba de A a B mientras el select estaba en vuelo, la RPC se
  // ejecutaba bajo auth.uid()=B con el delta de A. Y leer-luego-sumar no
  // garantizaba que el resultado final fuera el objetivo si otro
  // dispositivo cambiaba el remoto entre la lectura y el envío. Ahora
  // processWaterQueue() hace un UPSERT ABSOLUTO (user_id, log_date, ml)
  // con onConflict "user_id,log_date" — nunca lee el remoto antes,
  // siempre fija el objetivo exacto, y lleva el userId capturado al
  // programarse (nunca this.user ambiente). Estos tests usan el mismo
  // cliente Supabase falso (makeFakeClient/setup) que el resto del
  // archivo, con una entrada `water_log` en la config.

  it("rechaza fecha/objetivo inválidos en la entrada PÚBLICA — NaN/Infinity/decimales/fechas imposibles nunca llegan a encolarse ni al upsert (bloqueante P2)", async () => {
    const config = successConfig();
    config.water_log = { upsert: { error: null } };
    const calls = setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };

    remote.setWaterTargetDurable("2026-08-24", Number.NaN);
    remote.setWaterTargetDurable("2026-08-24", Number.POSITIVE_INFINITY);
    remote.setWaterTargetDurable("2026-08-24", 250.5); // decimal — water_log.ml es integer
    remote.setWaterTargetDurable("2026-08-24", -100); // negativo
    remote.setWaterTargetDurable("2026-99-99", 500); // fecha imposible

    expect(remote.hasPendingWaterFor("user-1")).toBe(false); // nada se encoló (rechazo es síncrono)
    expect(calls.some((c) => c.table === "water_log")).toBe(false); // nunca llegó al upsert

    // Una llamada válida SÍ se encola con normalidad — confirma que el
    // rechazo es específico de los valores inválidos, no un bloqueo general.
    remote.setWaterTargetDurable("2026-08-24", 500);
    expect(remote.hasPendingWaterFor("user-1")).toBe(true);
  });

  it("éxito: procesa la cola y emite 'saved' cuando no queda nada más pendiente", async () => {
    const config = successConfig();
    config.water_log = { upsert: { error: null } };
    const calls = setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);

    remote.setWaterTargetDurable("2026-08-24", 250);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("saved"));
    expect(remote.hasPendingWaterFor("user-1")).toBe(false);

    const upsertCall = calls.find((c) => c.table === "water_log" && c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args).toMatchObject({ user_id: "user-1", log_date: "2026-08-24", ml: 250 });
    expect(calls.some((c) => c.table === "water_log" && c.op === "select")).toBe(false); // nunca lee el remoto antes de fijar el objetivo
  });

  it("fallo: mantiene el estado en 'error' (nunca 'saved') y reintenta hasta tener éxito", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let attempt = 0;
    config.water_log = { upsert: async () => { attempt++; return attempt === 1 ? { error: { message: "network" } } : { error: null }; } };
    setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);

    remote.setWaterTargetDurable("2026-08-24", 250);
    await vi.advanceTimersByTimeAsync(50);
    expect(statuses).toContain("error");
    expect(remote.hasPendingWaterFor("user-1")).toBe(true); // sigue pendiente — nunca se pierde en silencio

    await vi.advanceTimersByTimeAsync(11_000); // PUSH_RETRY_MS
    expect(statuses.at(-1)).toBe("saved");
    expect(remote.hasPendingWaterFor("user-1")).toBe(false);
  });

  it("recarga simulada mientras el upsert está pendiente: la cola sigue reflejando que hay algo sin confirmar hasta que se resuelve", async () => {
    const config = successConfig();
    let resolveUpsert: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resolveUpsert = resolve; });
    config.water_log = { upsert: () => gate.then(() => ({ error: null })) };
    setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };

    remote.setWaterTargetDurable("2026-08-24", 250);
    expect(remote.hasPendingWaterFor("user-1")).toBe(true); // "recarga" en este instante seguiría viendo esto como pendiente

    resolveUpsert();
    await vi.waitFor(() => expect(remote.hasPendingWaterFor("user-1")).toBe(false));
  });

  it("un fallo de agua mantiene el estado global sin confirmar aunque el snapshot genérico sí haya terminado bien", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    config.water_log = { upsert: { error: { message: "network" } } };
    setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };

    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);

    // Snapshot genérico: éxito.
    remote.schedulePush(testPush(makeState({ weeklyBudget: 1 })));
    await vi.advanceTimersByTimeAsync(500);
    expect(statuses.at(-1)).toBe("saved");

    // Agua: falla.
    statuses.length = 0;
    remote.setWaterTargetDurable("2026-08-24", 100);
    await vi.advanceTimersByTimeAsync(50);
    expect(statuses).toContain("error");
    expect(statuses).not.toContain("saved"); // NUNCA "saved" mientras el agua siga sin confirmar
  });

  it("retry tras un fallo ambiguo repite el MISMO upsert absoluto (targetMl idéntico) — nunca suma ni se desvía del objetivo", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let attempt = 0;
    config.water_log = { upsert: async () => { attempt++; return attempt === 1 ? { error: { message: "network" } } : { error: null }; } };
    const calls = setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };

    remote.setWaterTargetDurable("2026-08-24", 250);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(11_000); // PUSH_RETRY_MS
    await vi.waitFor(() => expect(remote.hasPendingWaterFor("user-1")).toBe(false));

    const upserts = calls.filter((c) => c.table === "water_log" && c.op === "upsert");
    expect(upserts).toHaveLength(2);
    expect((upserts[0].args as { ml: number }).ml).toBe(250);
    expect((upserts[1].args as { ml: number }).ml).toBe(250); // mismo objetivo absoluto en el reintento, nunca acumulado
  });

  it("otro dispositivo cambia el valor remoto entre intentos: el upsert absoluto nunca lee el remoto primero — el resultado siempre es exactamente targetMl", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let attempt = 0;
    // Sin `select`: si processWaterQueue() intentara leer el remoto antes
    // de escribir, esta config no lo soportaría — la ausencia misma de esa
    // llamada es la prueba de que ya no hay ventana de carrera con otro
    // dispositivo entre leer y escribir.
    config.water_log = { upsert: async () => { attempt++; return attempt === 1 ? { error: { message: "network" } } : { error: null }; } };
    const calls = setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };

    remote.setWaterTargetDurable("2026-08-24", 750);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(11_000);
    await vi.waitFor(() => expect(remote.hasPendingWaterFor("user-1")).toBe(false));

    const upserts = calls.filter((c) => c.table === "water_log" && c.op === "upsert");
    expect(upserts.every((c) => (c.args as { ml: number }).ml === 750)).toBe(true);
    expect(calls.some((c) => c.table === "water_log" && c.op === "select")).toBe(false);
  });

  it("select/upsert de A en vuelo → cambia la sesión a B: el payload SIEMPRE lleva el userId capturado al programarse, nunca ambient this.user — y B nunca ve tocado su propio estado por ello", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let releaseUpsert: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseUpsert = resolve; });
    config.water_log = { upsert: () => gate.then(() => ({ error: null })) };
    const calls = setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-a" };

    remote.setWaterTargetDurable("2026-08-24", 500); // se encola para A, epoch actual
    await vi.advanceTimersByTimeAsync(0); // deja que arranque processWaterQueue() y llame al upsert (gateado, todavía sin resolver)

    // Cambio de sesión a B MIENTRAS el upsert de A sigue en vuelo.
    const epochBefore = remote.sessionEpoch;
    remote.resetSessionState(); // vacía waterPending de A síncronamente
    r.user = { id: "user-b" };
    expect(remote.sessionEpoch).not.toBe(epochBefore);

    releaseUpsert();
    await vi.advanceTimersByTimeAsync(50);

    const waterUpsert = calls.find((c) => c.table === "water_log" && c.op === "upsert");
    expect(waterUpsert).toBeDefined();
    // El payload que salió llevaba el userId CAPTURADO al programarse (A),
    // nunca leído de this.user en el momento de ejecutarse (que ya era B) —
    // en producción, esto es justo lo que hace que la policy RLS
    // `water_log_own` (user_id = auth.uid()) rechace la escritura si la
    // sesión ya cambió a B (nunca se aplica ni como agua de A ni, mucho
    // menos, como agua de B) — el fake client no simula RLS, así que lo que
    // SÍ se comprueba aquí es el contrato del lado del cliente: el payload
    // nunca depende de this.user ambiente.
    expect((waterUpsert!.args as { user_id: string }).user_id).toBe("user-a");
    // Y el resultado tardío de A nunca toca el estado de B — resetSessionState()
    // ya vació waterPending de A; B nunca tuvo nada pendiente propio.
    expect(remote.hasPendingWaterFor("user-b")).toBe(false);
  });

  it("upsert de A completa TARDE tras el cambio a B, MIENTRAS el propio upsert de B (misma fecha) sigue en vuelo: el resultado tardío de A no borra el pendiente de B antes de que confirme (guard posterior al await)", async () => {
    // Nota: resetSessionState() limpia waterProcessing (a propósito — una
    // sesión nueva no debe quedar bloqueada por una bandera "en curso" de
    // la sesión anterior), así que el turno de B puede arrancar en
    // PARALELO al de A, no encolado detrás — de ahí que este test gatee
    // los DOS upserts por separado y controle el orden exacto de
    // resolución, en vez de asumir que B espera a que A termine.
    vi.useFakeTimers();
    const config = successConfig();
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    let upsertCalls = 0;
    config.water_log = { upsert: () => { upsertCalls++; return (upsertCalls === 1 ? gateA : gateB).then(() => ({ error: null })); } };
    const calls = setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-a" };

    remote.setWaterTargetDurable("2026-08-24", 500); // A programa y arranca — su upsert queda gateado (gateA, la 1ª llamada)
    await vi.advanceTimersByTimeAsync(0);

    remote.resetSessionState(); // cambio de sesión: vacía waterPending Y waterProcessing de A síncronamente
    r.user = { id: "user-b" };
    remote.setWaterTargetDurable("2026-08-24", 999); // B programa SU PROPIO pendiente para la MISMA fecha — arranca YA (no bloqueado)
    await vi.advanceTimersByTimeAsync(0); // deja que el upsert de B también quede gateado (gateB, la 2ª llamada)

    releaseA(); // el upsert TARDÍO de A resuelve MIENTRAS el de B sigue pendiente
    await vi.advanceTimersByTimeAsync(0);

    // Momento crítico: sin el guard, el `finally` de A (epoch/userId ya
    // obsoletos) borraría la fecha del mapa EN MEMORIA aquí — antes de que
    // B llegara a confirmar por su cuenta. Se inspecciona el mapa en
    // memoria directamente (no pendingWaterTargetFor, que además cae a lo
    // persistido en disco — el disco de "user-b" sigue en 999 en AMBOS
    // casos en este instante, porque el persistWaterPending() de A solo
    // toca la clave de disco de "user-a"; eso enmascararía justo la
    // corrupción que este test quiere detectar). Con el guard, A se limita
    // a devolver sin tocar nada — el mapa en memoria conserva la entrada
    // de B, todavía en vuelo.
    const waterPendingMap = (remote as unknown as { waterPending: Map<string, { userId: string }> }).waterPending;
    expect([...waterPendingMap.values()].some((op) => op.userId === "user-b")).toBe(true);

    releaseB(); // ahora sí confirma el propio intento de B
    await vi.waitFor(() => expect(remote.hasPendingWaterFor("user-b")).toBe(false));

    const waterUpserts = calls.filter((c) => c.table === "water_log" && c.op === "upsert");
    const bUpsert = waterUpserts.find((c) => (c.args as { user_id: string }).user_id === "user-b");
    expect(bUpsert).toBeDefined();
    expect((bUpsert!.args as { ml: number }).ml).toBe(999); // llegó a enviarse de verdad, con su propio objetivo
  });

  it("REGRESIÓN DETERMINISTA (P0, propiedad del worker): A=500 en vuelo → cambio de sesión → B1=999 en vuelo → termina A (tarde) → B cambia a B2=1200 MIENTRAS B1 sigue en vuelo → B2 no lanza un segundo worker concurrente → al terminar B1 se envía B2 → el último pago confirmado es 1200 y no queda nada pendiente", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    let releaseA: () => void = () => {};
    let releaseB1: () => void = () => {};
    let upsertCalls = 0;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB1 = new Promise<void>((resolve) => { releaseB1 = resolve; });
    config.water_log = {
      upsert: () => {
        upsertCalls++;
        if (upsertCalls === 1) return gateA.then(() => ({ error: null }));
        if (upsertCalls === 2) return gateB1.then(() => ({ error: null }));
        return Promise.resolve({ error: null }); // 3er intento (B2): sin gate, resuelve directo
      },
    };
    const calls = setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-a" };

    // A=500 queda en vuelo (gateA).
    remote.setWaterTargetDurable("2026-08-24", 500);
    await vi.advanceTimersByTimeAsync(0);
    expect(upsertCalls).toBe(1);

    // Cambio de sesión: resetSessionState() libera activeWaterWorker
    // SÍNCRONAMENTE — el worker de A sigue "en vuelo" (gateado), pero ya
    // no es el dueño de la exclusión mutua.
    remote.resetSessionState();
    r.user = { id: "user-b" };

    // B1=999 arranca su PROPIO worker de inmediato (activeWaterWorker
    // estaba libre) y queda en vuelo (gateB1).
    remote.setWaterTargetDurable("2026-08-24", 999);
    await vi.advanceTimersByTimeAsync(0);
    expect(upsertCalls).toBe(2);

    // Termina A (tarde) — CON el arreglo, su `finally` comprueba que ya
    // no es dueño del worker (activeWaterWorker es el de B1) y no toca
    // nada; SIN el arreglo (booleano waterProcessing sin propiedad), su
    // `finally` pondría waterProcessing/activeWaterWorker a null
    // incondicionalmente, liberando la exclusión mutua de B1 mientras su
    // propio upsert seguía en vuelo — permitiendo que un tercer worker
    // arrancara EN PARALELO con B1 más abajo.
    releaseA();
    await vi.advanceTimersByTimeAsync(0);

    // B cambia el objetivo a B2=1200 MIENTRAS B1 (999) sigue en vuelo.
    remote.setWaterTargetDurable("2026-08-24", 1200);
    await vi.advanceTimersByTimeAsync(0);

    // Momento crítico: B2 NO debe haber disparado un segundo upsert
    // concurrente — sigue habiendo solo 2 llamadas reales a upsert()
    // (la de A, gateada, y la de B1, gateada) hasta que B1 termine.
    expect(upsertCalls).toBe(2);

    // Termina B1 (999) — al confirmar, ve que el objetivo en memoria ya
    // no es 999 (es 1200, actualizado por la llamada anterior) y NO lo da
    // por confirmado — se retoma la cola de inmediato con el objetivo
    // más reciente.
    releaseB1();
    await vi.waitFor(() => expect(upsertCalls).toBe(3)); // B2 se envía en cuanto B1 libera el turno

    await vi.waitFor(() => expect(remote.hasPendingWaterFor("user-b")).toBe(false));

    const waterUpserts = calls.filter((c) => c.table === "water_log" && c.op === "upsert");
    expect(waterUpserts).toHaveLength(3); // A, B1, B2 — nunca un cuarto intento duplicado
    const last = waterUpserts.at(-1)!;
    expect((last.args as { user_id: string; ml: number }).user_id).toBe("user-b");
    expect((last.args as { ml: number }).ml).toBe(1200); // el último payload confirmado es el objetivo más reciente
  });

  it("REGRESIÓN (P0): confirmación remota (upsert=200 con éxito) seguida de un fallo al limpiar la cola durable (removeItem) — el objetivo NUNCA se pierde ni se marca 'saved' hasta que la persistencia local también lo refleje", async () => {
    vi.useFakeTimers();
    const config = successConfig();
    config.water_log = { upsert: { error: null } }; // el upsert remoto SIEMPRE confirma
    const calls = setup(config);
    const r = remote as unknown as {
      user: { id: string };
      sessionEpoch: number;
      waterPending: Map<string, { userId: string; epoch: number; date: string; targetMl: number }>;
      processWaterQueue: () => Promise<void>;
    };
    r.user = { id: "user-1" };
    // Objetivo nuevo (200) ya en memoria, como si setWaterTargetDurable ya
    // se hubiera llamado.
    r.waterPending = new Map([["2026-08-24", { userId: "user-1", epoch: r.sessionEpoch, date: "2026-08-24", targetMl: 200 }]]);

    let unsyncedCount = 0;
    remote.onUnsyncedWrite = () => { unsyncedCount++; };
    const statuses: string[] = [];
    remote.onStatusChange = (s) => statuses.push(s);

    const spy = vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new DOMException("blocked"); });
    await r.processWaterQueue();

    // El upsert remoto SÍ confirmó con el objetivo nuevo.
    const firstUpserts = calls.filter((c) => c.table === "water_log" && c.op === "upsert");
    expect(firstUpserts).toHaveLength(1);
    expect((firstUpserts[0].args as { ml: number }).ml).toBe(200);

    // Pero la cola durable no pudo reflejar la eliminación (removeItem
    // falló) — la operación NO se da por terminada: sigue pendiente EN
    // MEMORIA con el MISMO objetivo (rollback, nunca se pierde), nunca se
    // marca "saved", y se avisa del fallo de persistencia local. Si en
    // este punto la pestaña se cerrara, el objetivo recuperable seguiría
    // siendo 200 — nunca puede "reaparecer" un valor antiguo distinto,
    // porque nunca se volvió a escribir nada más que 200 en disco.
    expect(remote.pendingWaterTargetFor("user-1", "2026-08-24")).toBe(200);
    expect(remote.hasPendingWaterFor("user-1")).toBe(true);
    expect(statuses).not.toContain("saved");
    expect(unsyncedCount).toBeGreaterThan(0);

    // Con la persistencia local ya funcionando, el reintento automático sí converge.
    spy.mockRestore();
    await vi.advanceTimersByTimeAsync(11_000); // PUSH_RETRY_MS
    await vi.waitFor(() => expect(remote.hasPendingWaterFor("user-1")).toBe(false));
    const finalUpserts = calls.filter((c) => c.table === "water_log" && c.op === "upsert");
    // El reintento reenvía el MISMO objetivo (200) — idempotente, nunca "100" ni ningún otro valor.
    expect(finalUpserts.every((c) => (c.args as { ml: number }).ml === 200)).toBe(true);
  });

  it("una entrada con epoch/userId ya obsoleto en la cola nunca llega a intentar el upsert (comprobación previa, sin esperar a ningún await)", async () => {
    const config = successConfig();
    const calls = setup(config);
    const r = remote as unknown as {
      user: { id: string };
      sessionEpoch: number;
      waterPending: Map<string, { userId: string; epoch: number; date: string; targetMl: number }>;
      processWaterQueue: () => Promise<void>;
    };
    r.user = { id: "user-a" };
    r.waterPending = new Map([["2026-08-24", { userId: "user-b", epoch: r.sessionEpoch - 1, date: "2026-08-24", targetMl: 500 }]]);

    await r.processWaterQueue();

    expect(calls.some((c) => c.table === "water_log" && c.op === "upsert")).toBe(false);
  });

  it("un fallo al persistir el agua pendiente localmente dispara onUnsyncedWrite() — nunca se declara durable si la copia local no existe de verdad", () => {
    const config = successConfig();
    config.water_log = { upsert: { error: null } };
    setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };
    let unsyncedCount = 0;
    remote.onUnsyncedWrite = () => { unsyncedCount++; };
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("QuotaExceededError"); });

    remote.setWaterTargetDurable("2026-08-24", 250);

    spy.mockRestore();
    expect(unsyncedCount).toBeGreaterThan(0);
    remote.onUnsyncedWrite = null;
  });

  it("pendingWaterTargetFor() devuelve el objetivo en vuelo, y null cuando ya se confirmó", async () => {
    const config = successConfig();
    config.water_log = { upsert: { error: null } };
    setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };

    expect(remote.pendingWaterTargetFor("user-1", "2026-08-24")).toBeNull();
    remote.setWaterTargetDurable("2026-08-24", 500);
    expect(remote.pendingWaterTargetFor("user-1", "2026-08-24")).toBe(500);

    await vi.waitFor(() => expect(remote.hasPendingWaterFor("user-1")).toBe(false));
    expect(remote.pendingWaterTargetFor("user-1", "2026-08-24")).toBeNull();
  });
});

describe("waterPending — durabilidad a través de una recarga (bloqueante P0)", () => {
  it("resumePendingWaterFor() recupera un objetivo persistido por una instancia ANTERIOR (recarga simulada) y lo confirma", async () => {
    // Simula lo que habría quedado en disco de una instancia previa de
    // RemoteAdapter destruida por una recarga ANTES de confirmar — outbox.ts
    // es la única fuente de verdad, independiente de lo que haya en memoria
    // en esta instancia (resetRemote() ya la dejó "recién arrancada").
    outbox.writeWaterPending("user-1", { "2026-08-24": 750 });
    const config = successConfig();
    config.water_log = { upsert: { error: null } };
    const calls = setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };

    // Antes de resumePendingWaterFor(): ya se detecta desde disco, no hace
    // falta esperar a que el mapa en memoria se repueble (P1, hasPendingWaterFor()).
    expect(remote.hasPendingWaterFor("user-1")).toBe(true);

    remote.resumePendingWaterFor("user-1");
    await vi.waitFor(() => expect(remote.hasPendingWaterFor("user-1")).toBe(false));

    const upsertCall = calls.find((c) => c.table === "water_log" && c.op === "upsert");
    expect(upsertCall!.args).toMatchObject({ user_id: "user-1", log_date: "2026-08-24", ml: 750 });
    expect(outbox.readWaterPending("user-1")).toEqual({}); // también se limpió en disco, no solo en memoria
  });

  it("resumePendingWaterFor() con un userId distinto al de la sesión vigente no hace nada (nunca aplica agua de otra cuenta)", () => {
    outbox.writeWaterPending("user-ajeno", { "2026-08-24": 500 });
    const config = successConfig();
    config.water_log = { upsert: { error: null } };
    setup(config);
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };

    remote.resumePendingWaterFor("user-ajeno");
    expect(remote.hasPendingWaterFor("user-1")).toBe(false); // "user-1" (sesión vigente) no tenía nada pendiente
    expect(remote.hasPendingWaterFor("user-ajeno")).toBe(true); // sigue persistido, intacto, esperando a que ESE usuario vuelva
  });

  it("logout explícito descarta también el agua pendiente persistida — nunca queda esperando un reintento que ya nadie verá", async () => {
    outbox.writeWaterPending("user-out", { "2026-08-24": 300 });
    setup(successConfig());
    const r = remote as unknown as { user: { id: string }; client: { auth: { signOut: () => Promise<{ error: null }> } } };
    r.user = { id: "user-out" };
    r.client.auth = { signOut: async () => ({ error: null }) };

    await remote.signOut();
    expect(outbox.readWaterPending("user-out")).toEqual({});
  });
});

describe("hasPendingPush()/hasPendingWater() — ven lo persistido en disco, no solo temporizadores en memoria (bloqueante P1)", () => {
  it("hasPendingPush() es true justo tras una 'recarga' simulada, antes de que nada en memoria se reprograme, si el envelope persistido tiene pending", () => {
    setup(successConfig());
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };
    // Todos los temporizadores en memoria están en null (instancia "recién
    // arrancada", como tras una recarga) — el ÚNICO indicio de que hay algo
    // pendiente es el envelope persistido.
    outbox.recordMutation("user-1", makeState({ weeklyBudget: 5 }), "tab-1");

    expect(remote.hasPendingPush()).toBe(true);
  });

  it("hasPendingPush() es false si no hay ni temporizadores en memoria ni envelope persistido con pending", () => {
    setup(successConfig());
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };
    expect(remote.hasPendingPush()).toBe(false);
  });

  it("hasPendingWater() es true justo tras una 'recarga' simulada, antes de resumePendingWater(), si hay agua persistida", () => {
    setup(successConfig());
    const r = remote as unknown as { user: { id: string } };
    r.user = { id: "user-1" };
    outbox.writeWaterPending("user-1", { "2026-08-24": 500 });

    expect(remote.hasPendingWater()).toBe(true);
  });
});
