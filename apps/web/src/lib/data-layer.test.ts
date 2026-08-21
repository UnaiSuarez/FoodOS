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
import type { AppSettings, FoodOSState } from "@foodos/types";
import { remote } from "./data-layer";

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
    pushTimer: ReturnType<typeof setTimeout> | null;
    pushRetryTimer: ReturnType<typeof setTimeout> | null;
    pushing: boolean;
    pushQueued: unknown;
    lastPushErrorNotifiedAt: number;
  };
  if (r.pushTimer) clearTimeout(r.pushTimer);
  if (r.pushRetryTimer) clearTimeout(r.pushRetryTimer);
  r.client = null;
  r.user = null;
  r.almacenIdByName = {};
  r.shoppingListId = "shopping-list-1";
  r.pushTimer = null;
  r.pushRetryTimer = null;
  r.pushing = false;
  r.pushQueued = null;
  r.lastPushErrorNotifiedAt = 0;
  remote.onPushError = null;
  remote.onStatusChange = null;
}

function setup(config: Record<string, FakeTableConfig>): CallRecord[] {
  const calls: CallRecord[] = [];
  const r = remote as unknown as { client: unknown; user: unknown };
  r.client = makeFakeClient(config, calls);
  r.user = { id: "user-1" };
  return calls;
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
    await expect(remote.pushState(makeState())).resolves.toBeUndefined();
  });
});

describe("pushState — perfil", () => {
  it("propaga el error de user_profiles.upsert sin tragárselo", async () => {
    const config = successConfig();
    config.user_profiles = { upsert: { error: { message: "RLS: permiso denegado" } } };
    const calls = setup(config);

    await expect(remote.pushState(makeState())).rejects.toThrow(/perfil.*RLS: permiso denegado/);

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

    await remote.pushState(makeState());

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

    await expect(remote.pushState(state)).rejects.toThrow(/peso \(guardado\).*constraint violada/);
    expect(calls.some((c) => c.table === "weight_log" && c.op === "select")).toBe(false);
    expect(calls.some((c) => c.table === "weight_log" && c.op === "delete")).toBe(false);
  });

  it("propaga el error si la lectura previa al borrado falla", async () => {
    const config = successConfig();
    config.weight_log = { upsert: { error: null }, select: { error: { message: "timeout" } } };
    setup(config);
    const state = makeState({ weightLog: [{ date: "2026-08-01", kg: 80 }] });

    await expect(remote.pushState(state)).rejects.toThrow(/peso \(lectura para borrado\).*timeout/);
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

    await expect(remote.pushState(state)).rejects.toThrow(/peso \(borrado\).*fk violation/);
  });

  it("borrar TODAS las entradas locales SÍ se propaga al borrado remoto (antes el bloque entero se saltaba con weightLog vacío)", async () => {
    const config = successConfig();
    config.weight_log = {
      select: { data: [{ log_date: "2026-01-01" }, { log_date: "2026-01-02" }], error: null },
      delete: { error: null },
    };
    const calls = setup(config);
    const state = makeState({ weightLog: [] });

    await expect(remote.pushState(state)).resolves.toBeUndefined();

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

    await expect(remote.pushState(makeState())).rejects.toThrow(/objetivos nutricionales.*check constraint/);
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

    await expect(remote.pushState(makeState())).rejects.toThrow(/inventario.*permiso denegado/);

    // Mejor esfuerzo: food_log (tabla independiente, más adelante en la
    // secuencia) se intentó igualmente pese al fallo de inventario.
    expect(calls.some((c) => c.table === "food_log" && c.op === "select")).toBe(true);
  });

  it("un fallo en la lectura previa al borrado de una tabla se propaga sin intentar el delete", async () => {
    const config = successConfig();
    config.gastos = { upsert: { error: null }, select: { error: { message: "network" } } };
    const calls = setup(config);

    await expect(remote.pushState(makeState())).rejects.toThrow(/gastos.*network/);
    expect(calls.some((c) => c.table === "gastos" && c.op === "delete")).toBe(false);
  });
});

describe("pushState — fallos múltiples", () => {
  it("agrega todos los fallos en un único error en vez de quedarse solo con el primero", async () => {
    const config = successConfig();
    config.user_profiles = { upsert: { error: { message: "err-perfil" } } };
    config.nutrition_goals = { upsert: { error: { message: "err-objetivos" } } };
    setup(config);

    await expect(remote.pushState(makeState())).rejects.toThrow(/err-perfil/);
    await expect(remote.pushState(makeState())).rejects.toThrow(/err-objetivos/);
  });
});

describe("pushState — reintento idempotente tras éxito parcial", () => {
  it("reenviar el mismo snapshot tras arreglarse el fallo tiene éxito, sin duplicar las escrituras que ya habían funcionado", async () => {
    const config = successConfig();
    config.user_profiles = { upsert: { error: { message: "caída temporal" } } };
    const calls = setup(config);
    const state = makeState({ profile: null, nutrition: { kcal: 2000, protein: 140, carbs: 200, fat: 60, mode: "fat_loss" } });

    await expect(remote.pushState(state)).rejects.toThrow(/perfil/);
    const goalCallsFirstAttempt = calls.filter((c) => c.table === "nutrition_goals" && c.op === "upsert");
    expect(goalCallsFirstAttempt).toHaveLength(1);

    // Supabase se recupera: reintentar el MISMO snapshot debe tener éxito.
    config.user_profiles = { upsert: { error: null } };
    await expect(remote.pushState(state)).resolves.toBeUndefined();

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

    await expect(remote.pushState(state)).rejects.toThrow(/perfil/);
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
    await expect(remote.pushState(state)).resolves.toBeUndefined();

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

    await remote.pushState(makeState({ inventory: [legacyItemA] }));
    await remote.pushState(makeState({ inventory: [legacyItemB] })); // objeto NUEVO, mismo id legacy

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
    remote.schedulePush(state);
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
    remote.schedulePush(makeState());
    await vi.advanceTimersByTimeAsync(500); // dispara runPush(A); A sigue "en vuelo"

    // 2. Llega un evento realtime mientras A está pendiente -> se difiere.
    expect(gate.onRealtimeRefresh(remote.hasPendingPush())).toBe(false);

    // 3. El usuario edita: snapshot B. Como A sigue en curso, esto arma un
    //    nuevo pushTimer (todavía no ha pasado el debounce).
    remote.schedulePush(makeState({ weeklyBudget: 999 }));

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
    remote.schedulePush(makeState());
    await vi.advanceTimersByTimeAsync(500); // dispara runPush(A); A sigue "en vuelo"

    // 2. Evento realtime diferido.
    expect(gate.onRealtimeRefresh(remote.hasPendingPush())).toBe(false);

    // 3. Snapshot B: se programa su debounce.
    remote.schedulePush(makeState({ weeklyBudget: 999 }));

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
    remote.schedulePush(makeState({ weeklyBudget: 111 }));
    await vi.advanceTimersByTimeAsync(500); // dispara runPush(A); A sigue "en vuelo"

    expect(gate.onRealtimeRefresh(remote.hasPendingPush())).toBe(false); // evento realtime diferido

    // 2. Se programa B: queda en pushTimer (su debounce aún no ha disparado).
    remote.schedulePush(makeState({ weeklyBudget: 222 }));

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
    remote.schedulePush(makeState({ weeklyBudget: 111 }));
    await vi.advanceTimersByTimeAsync(500); // runPush(A) arranca, sigue en vuelo

    expect(gate.onRealtimeRefresh(remote.hasPendingPush())).toBe(false); // evento realtime diferido

    // 2. Se programa B...
    remote.schedulePush(makeState({ weeklyBudget: 222 }));
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
