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
interface FakeTableConfig {
  update?: PGResult;
  upsert?: PGResult;
  select?: PGResult;
  delete?: PGResult;
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
          const result: PGResult = (op ? cfg[op] : undefined) ?? { data: null, error: null };
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
