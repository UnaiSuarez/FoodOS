// @vitest-environment jsdom
//
// Diseño v5 de hidratación — test REAL de FoodOSProvider (react-dom/client +
// act + jsdom). Corrección de revisión validada por el usuario: este
// proyecto no tiene @testing-library ni jsdom hasta esta ronda — se añade
// jsdom como devDependency (ver package.json) y este archivo usa el pragma
// `// @vitest-environment jsdom` de arriba, SIN tocar el `environment:"node"`
// global de vitest.config.ts (el resto de la suite sigue en "node").
//
// A diferencia de los tests puros de runHydrationAttempt() en state.test.tsx
// (que prueban el CONTRATO de un intento aislado), este archivo monta el
// árbol de React de verdad y prueba el ownership real: generación única,
// deduplicación de requestHydration() frente a una ráfaga de eventos, que un
// backoff automático obsoleto no aborte un reintento manual más reciente, y
// que un `deferred` sin resolver nunca deje un loading indefinido.
//
// remote (RemoteAdapter) es un singleton de módulo — persiste entre tests de
// este archivo. resetRemoteForTest() replica el mismo patrón de caja blanca
// que data-layer.test.ts usa en su resetRemote() (cast a los campos privados
// relevantes) para que cada test arranque desde un estado limpio y conocido.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defaultState, FoodOSProvider, useFoodOS } from "./state";
import { remote, type RemoteMutationResult } from "./data-layer";
import * as outbox from "./outbox";

// React 19 exige declarar explícitamente que este entorno soporta act() —
// sin esto, cada act() emite "The current testing environment is not
// configured to support act(...)" aunque funcione igualmente.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Mock de ./supabase — hasSupabaseConfig()/getSupabase() ────────────────
// clientHolder vive fuera del factory de vi.mock (que se hoistea por encima
// de este módulo) para poder sustituir el cliente falso en cada test sin
// tener que re-mockear el módulo entero. supabaseConfigHolder sigue el mismo
// patrón para poder simular "modo local" (sin Supabase configurado) en un
// test puntual sin afectar al resto — por defecto true, como antes.
const clientHolder: { client: unknown } = vi.hoisted(() => ({ client: null }));
const supabaseConfigHolder: { value: boolean } = vi.hoisted(() => ({ value: true }));
vi.mock("./supabase", () => ({
  hasSupabaseConfig: () => supabaseConfigHolder.value,
  getSupabase: () => clientHolder.client,
}));

// ─── Cliente Supabase falso — mínimo necesario para ensureBaseRows()/
// pullState()/auth/Realtime. A diferencia del fake de data-layer.test.ts
// (que distingue el verbo exacto de cada tabla para probar pushState()), este
// no necesita esa granularidad: solo hace falta que ensureBaseRows() vea
// almacenes/lista de compra YA EXISTENTES (para no ejercitar su rama de
// inserción, irrelevante aquí) y que las 10 consultas de pullState()
// devuelvan datos vacíos válidos. `gate`, si se pasa, es una promesa que
// TODAS las consultas esperan antes de resolver — permite controlar
// exactamente cuándo "termina la red" en cada test.
type PGResult = { data?: unknown; error?: unknown };

function makeFakeClient(opts: {
  initialSession?: { user: { id: string; email?: string } } | null;
  tableData?: Record<string, PGResult>;
  /** Holder mutable (no una promesa suelta): cada consulta lee
      `gate.current` en el momento en que la ALCANZA, no en el momento en
      que se creó el cliente — así un test puede sustituir la promesa de
      espera ENTRE dos intentos distintos (p.ej. "A se queda esperando para
      siempre, B usa una ya resuelta") sin que eso reescriba lo que A, ya
      suspendido, está esperando de verdad. */
  gate?: { current: Promise<void> };
} = {}) {
  // Mutable y expuesto (ver el valor de retorno más abajo): remote.client
  // se fija UNA sola vez en remote.init(), al montar — un test que necesite
  // que una tabla "se arregle" a mitad de camino (p.ej. para un reintento
  // manual que SÍ debe prosperar) muta este objeto en vez de sustituir el
  // cliente completo, que ya no tendría ningún efecto sobre remote.client.
  const tableData: Record<string, PGResult> = {
    user_profiles: { data: null, error: null },
    almacenes: {
      data: [
        { id: "a1", name: "Nevera", type: "fridge" },
        { id: "a2", name: "Congelador", type: "freezer" },
        { id: "a3", name: "Despensa", type: "pantry" },
      ],
      error: null,
    },
    shopping_lists: { data: [{ id: "list-1" }], error: null },
    inventory_items: { data: [], error: null },
    shopping_items: { data: [], error: null },
    gastos: { data: [], error: null },
    ingresos_fuentes: { data: [], error: null },
    nutrition_goals: { data: [], error: null },
    food_log: { data: [], error: null },
    water_log: { data: [], error: null },
    weight_log: { data: [], error: null },
    nutrition_adjustment_proposals: { data: [], error: null },
    ...opts.tableData,
  };

  let authCb: ((event: string, session: { user: { id: string; email?: string } } | null) => void) | null = null;
  // Mutable, expuesto abajo — a diferencia de `tableData` (qué devuelve cada
  // tabla), esto simula "las ESCRITURAS dejan de llegar al servidor" sin
  // tocar las lecturas: necesario para que ensureBaseRows()/pullState()
  // puedan seguir funcionando mientras el ciclo de push (runPush→
  // pushState(), disparado internamente por schedulePush) falla de verdad —
  // el único modo de que un pendiente local NUNCA se confirme sin también
  // romper la propia hidratación.
  const writesState = { failWrites: false };

  function makeBuilder(table: string) {
    let sawWrite = false;
    const builder: Record<string, unknown> = {
      upsert: () => { sawWrite = true; return builder; },
      update: () => { sawWrite = true; return builder; },
      insert: () => { sawWrite = true; return builder; },
      delete: () => { sawWrite = true; return builder; },
      select: () => builder,
      eq: () => builder,
      gte: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => builder,
      single: () => builder,
      then(resolve: (v: PGResult) => unknown, reject?: (e: unknown) => unknown) {
        const run = async () => {
          if (opts.gate) await opts.gate.current;
          if (sawWrite && writesState.failWrites) return { data: null, error: { message: "escritura simulada sin conexión" } };
          return tableData[table] ?? { data: [], error: null };
        };
        return run().then(resolve, reject);
      },
    };
    return builder;
  }

  // Handlers de postgres_changes capturados por tabla — expuestos abajo vía
  // __emitPostgresChange() para poder disparar un refresco de Realtime DE
  // VERDAD (mismo camino que produce remote.subscribeRealtime() en
  // producción), no solo un sustituto vía el evento `online`.
  const realtimeHandlersByTable: Record<string, () => void> = {};
  // Contadores expuestos para los tests de arranque en frío/transiciones de
  // sesión (ronda 3, diseño v5 §Realtime) — NO se usaban antes de esta
  // ronda; ningún test existente los consulta, así que añadirlos aquí es
  // puramente aditivo. A diferencia del fake de data-layer.test.ts, este NO
  // necesita deduplicar por topic (subscribeRealtime() real ya lo garantiza
  // por construcción con topics únicos por generación) — aquí solo importa
  // CUÁNTAS VECES se llamó a channel()/removeChannel(), para comprobar
  // "exactamente un canal" / "ningún canal nuevo" a este nivel de integración.
  let channelCallCount = 0;
  let removeChannelCallCount = 0;

  const client = {
    from: (table: string) => makeBuilder(table),
    channel: (_name: string) => {
      channelCallCount++;
      const channelObj = {
        on: (_event: string, filter: { table?: string }, handler: () => void) => {
          if (filter?.table) realtimeHandlersByTable[filter.table] = handler;
          return channelObj;
        },
        subscribe: (cb: (status: string) => void) => {
          queueMicrotask(() => cb("SUBSCRIBED"));
          return channelObj;
        },
      };
      return channelObj;
    },
    removeChannel: async () => { removeChannelCallCount++; },
    __getChannelCallCount: () => channelCallCount,
    __getRemoveChannelCallCount: () => removeChannelCallCount,
    __emitPostgresChange: (table: string) => realtimeHandlersByTable[table]?.(),
    auth: {
      getSession: async () => ({ data: { session: opts.initialSession ?? null } }),
      onAuthStateChange: (cb: (event: string, session: { user: { id: string; email?: string } } | null) => void) => {
        authCb = cb;
        // Replica el comportamiento real de supabase-js: dispara
        // INITIAL_SESSION de inmediato con lo que getSession() devolvería.
        queueMicrotask(() => authCb?.("INITIAL_SESSION", opts.initialSession ?? null));
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signOut: async () => ({ error: null }),
    },
    // Expuesto para que los tests disparen manualmente un cambio de sesión
    // (login/logout) más allá del INITIAL_SESSION automático de arriba.
    __emitAuth: (event: string, session: { user: { id: string; email?: string } } | null) => authCb?.(event, session),
  };
  return { client, tableData, writesState };
}

function resetRemoteForTest() {
  const r = remote as unknown as {
    client: unknown;
    user: unknown;
    sessionEpoch: number;
    almacenIdByName: Record<string, string>;
    shoppingListId: string | null;
    pushTimer: ReturnType<typeof setTimeout> | null;
    pushRetryTimer: ReturnType<typeof setTimeout> | null;
    activePush: unknown;
    pushQueued: unknown;
    explicitSignOutInProgress: boolean;
    userMutationsAllowed: boolean;
    waterPending: Map<string, unknown>;
    waterRetryTimer: ReturnType<typeof setTimeout> | null;
    activeWaterWorker: unknown;
    waterHasError: boolean;
    realtimeGeneration: number;
    realtimePendingTeardown: Promise<void>;
  };
  if (r.pushTimer) clearTimeout(r.pushTimer);
  if (r.pushRetryTimer) clearTimeout(r.pushRetryTimer);
  if (r.waterRetryTimer) clearTimeout(r.waterRetryTimer);
  r.client = null;
  r.user = null;
  r.sessionEpoch = 0;
  r.almacenIdByName = {};
  r.shoppingListId = null;
  r.pushTimer = null;
  r.pushRetryTimer = null;
  r.activePush = null;
  r.pushQueued = null;
  r.explicitSignOutInProgress = false;
  r.userMutationsAllowed = false;
  r.waterPending = new Map();
  r.waterRetryTimer = null;
  r.activeWaterWorker = null;
  r.waterHasError = false;
  r.realtimeGeneration = 0;
  r.realtimePendingTeardown = Promise.resolve();
  remote.onPushError = null;
  remote.onStatusChange = null;
  remote.onUnsyncedWrite = null;
  localStorage.clear();
  sessionStorage.clear();
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Captura el valor de contexto más reciente en un objeto externo mutable —
    sin @testing-library, es la forma más simple de leer useFoodOS() desde
    fuera del árbol de React. */
type CapturedContext = ReturnType<typeof useFoodOS>;
function makeCapture() {
  const holder: { current: CapturedContext | null } = { current: null };
  function Capture() {
    const ctx = useFoodOS();
    holder.current = ctx;
    return null;
  }
  return { Capture, holder };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  resetRemoteForTest();
  supabaseConfigHolder.value = true;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    act(() => { root!.unmount(); });
    root = null;
  }
  container.remove();
  vi.useRealTimers();
  resetRemoteForTest();
});

const USER_ID = "user-provider-1";

describe("FoodOSProvider — ownership único del intento de hidratación (diseño v5)", () => {
  it("el gate de mutaciones directas empieza cerrado y solo se abre cuando la hidratación llega a 'ready'", async () => {
    const pullGate = deferred<void>();
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } }, gate: { current: pullGate.promise } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve();
    });

    // La hidratación está genuinamente suspendida en la red (pullGate sin
    // resolver) — el gate de mutaciones directas debe seguir cerrado.
    expect(holder.current?.hydrationScope?.phase).toBe("loading");
    const blockedResult = await remote.saveNutritionSnapshot({} as never);
    expect((blockedResult as RemoteMutationResult<void>).kind).toBe("blocked");

    // Deja que ensureBaseRows()+pullState() terminen de verdad.
    pullGate.resolve();
    await act(async () => {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    expect(holder.current?.remoteHydrated).toBe(true);

    const okResult = await remote.saveNutritionSnapshot({} as never);
    // Con el gate abierto, ya no es "blocked" — puede seguir siendo "error"
    // si el snapshot en sí falla contra el fake client sin insert() real,
    // pero NUNCA "blocked": eso es lo único que este test verifica.
    expect((okResult as RemoteMutationResult<void>).kind).not.toBe("blocked");
  });

  it("dos eventos de Realtime durante 'loading' deduplican vía requestHydration() — un solo intento, ninguna generación nueva (corrección §3/§10)", async () => {
    vi.useFakeTimers();
    const pullGate = deferred<void>();
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } }, gate: { current: pullGate.promise } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await vi.advanceTimersByTimeAsync(0);
    });

    // La hidratación inicial está en curso, bloqueada en el gate de red.
    expect(holder.current?.hydrationScope?.phase).toBe("loading");
    const generationDuringLoad = holder.current?.hydrationScope?.generation;

    // Ráfaga REAL de Realtime: dos cambios de Postgres en "inventory_items"
    // — el mismo camino de producción (remote.subscribeRealtime() →
    // scheduleHydrate(), debounce de 300ms → requestHydration()). A
    // diferencia del evento `online` (que solo actúa si phase==="error"),
    // este disparador es incondicional — es el escenario real que
    // requestHydration() existe para deduplicar (§3): una ráfaga durante
    // "loading" nunca debe abortar la petición vigente ni crear
    // generaciones de más.
    (client as unknown as { __emitPostgresChange: (t: string) => void }).__emitPostgresChange("inventory_items");
    (client as unknown as { __emitPostgresChange: (t: string) => void }).__emitPostgresChange("inventory_items");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350); // vence el debounce de scheduleHydrate() UNA sola vez (se reinicia con cada evento)
    });

    // Sigue siendo la MISMA generación — ninguno de los dos eventos abortó
    // ni sustituyó el intento vigente (el pull SIGUE bloqueado en el gate).
    expect(holder.current?.hydrationScope?.generation).toBe(generationDuringLoad);
    expect(holder.current?.hydrationScope?.phase).toBe("loading");

    // Deja que la red "termine" — una sola aplicación real.
    pullGate.resolve();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    expect(holder.current?.hydrationScope?.generation).toBe(generationDuringLoad); // nunca se sustituyó
  });

  it("un backoff automático programado tras un fallo NO aborta un reintento manual posterior más reciente (corrección §2)", async () => {
    vi.useFakeTimers();
    const { client, tableData } = makeFakeClient({
      initialSession: { user: { id: USER_ID } },
      tableData: { user_profiles: { data: null, error: { message: "fallo simulado" } } },
    });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    // pullState() falla (user_profiles devuelve error) → phase:"error" y se
    // programa un backoff automático (HYDRATION_BACKOFF_MS[0] = 2000ms).
    expect(holder.current?.hydrationScope?.phase).toBe("error");
    const failedGeneration = holder.current?.hydrationScope?.generation;

    // Reintento MANUAL a los 500ms — mucho antes de que el backoff
    // automático (2000ms) llegara a dispararse.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // "La red se arregla" — remote.client es el MISMO objeto desde
    // remote.init() (fijado una vez al montar), así que un reintento
    // manual que deba prosperar necesita mutar los datos de ESE cliente,
    // nunca sustituirlo por uno nuevo (eso no tendría ningún efecto).
    tableData.user_profiles = { data: null, error: null };
    await act(async () => {
      holder.current?.retryHydrationNow();
      await Promise.resolve(); await Promise.resolve();
    });
    const manualGeneration = holder.current?.hydrationScope?.generation;
    expect(manualGeneration).not.toBe(failedGeneration); // generación nueva y deliberada

    // Avanza el reloj hasta bien pasado el momento en que el backoff
    // automático ANTIGUO habría disparado (2000ms desde el fallo original,
    // ya pasaron 500ms, así que faltan ~1500ms) — si el backoff obsoleto
    // sobreviviera, aquí llamaría a replaceHydration() con el cliente que
    // ya falla otra vez sustituido, o (peor) abortaría el intento manual en
    // curso.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // El intento manual (con el cliente bueno) debe haber prosperado, y la
    // generación debe seguir siendo la del reintento manual — el backoff
    // viejo no debe haber sustituido nada.
    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    expect(holder.current?.hydrationScope?.generation).toBe(manualGeneration);
  });

  it("deferred/pending-timeout nunca deja un loading indefinido — termina en un estado recuperable visible con motivo específico", async () => {
    vi.useFakeTimers();
    // Pendiente local YA existente para este usuario ANTES de que arranque
    // la hidratación — runHydrationAttempt() lo reenvía (schedulePush) y
    // espera su confirmación (waitForMutationConfirmed, PENDING_
    // CONFIRMATION_TIMEOUT_MS=8000ms dentro de la hidratación — menor que
    // HYDRATION_TIMEOUT_MS=12000ms A PROPÓSITO, ver el comentario en
    // state.tsx: si no, el watchdog genérico siempre ganaría la carrera y
    // "pending-timeout" nunca podría producirse de verdad).
    outbox.recordMutation(USER_ID, { ...defaultState, weeklyBudget: 555 }, "tab-1");

    const { client, writesState } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await vi.advanceTimersByTimeAsync(0);
    });

    // Con baseline local (había un pendiente propio de este dispositivo) y
    // todavía sin confirmar, sigue "loading".
    expect(holder.current?.hydrationScope?.phase).toBe("loading");

    // A partir de aquí, toda escritura falla — simula que el reenvío del
    // pendiente (runPush → pushState, disparado por el propio
    // schedulePush() de arriba) nunca llega a confirmarse de verdad. Se
    // activa DESPUÉS de que ensureBaseRows() ya completó (arriba) para no
    // romper la propia hidratación por el camino.
    writesState.failWrites = true;

    // Agota el plazo específico de confirmación (8000ms) sin que llegue
    // ningún "saved" real — el reenvío sigue reintentando en segundo plano
    // (PUSH_RETRY_MS), pero nunca confirma.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_500);
    });

    expect(holder.current?.hydrationScope?.phase).toBe("error");
    expect(holder.current?.hydrationScope?.errorReason).toBe("waiting-for-local-save");
  });

  it("resetAll() cierra el gate de mutaciones directas de forma síncrona, ANTES incluso de que termine de re-render con defaultState (corrección §7/§8)", async () => {
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope?.phase).toBe("ready"); // gate abierto antes de resetAll()

    act(() => {
      holder.current?.resetAll();
    });

    // Comprobado SÍNCRONAMENTE (sin ningún await de por medio): el gate ya
    // debe estar cerrado en el mismo tick en que resetAll() se ejecutó,
    // antes de que cualquier promesa (incluida esta aserción) tenga
    // oportunidad de correr.
    const blockedResult = await remote.saveNutritionSnapshot({} as never);
    expect((blockedResult as RemoteMutationResult<void>).kind).toBe("blocked");
    expect(holder.current?.hydrationScope?.hasLocalBaseline).toBe(false);
  });

  it("un intento VIEJO que resuelve tarde nunca limpia ni pisa la identidad del intento NUEVO vigente (corrección §4/§10)", async () => {
    // Nota (corrección de revisión, P1 "botón activo durante loading"):
    // retryHydrationNow() ahora es defensivo y NUNCA sustituye un intento
    // que sigue "loading" — así que la sustitución de A→B aquí debe venir
    // de un mecanismo AUTOMÁTICO/interno (el watchdog + el backoff que
    // programa a continuación), nunca de un clic manual mientras A sigue
    // en curso.
    vi.useFakeTimers();
    const gateHolder = { current: deferred<void>().promise };
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } }, gate: gateHolder });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    // Intento A: se queda esperando PARA SIEMPRE (su propio gate, capturado
    // en el momento en que ensureBaseRows()/pullState() lo alcanzan —
    // sustituir gateHolder.current MÁS TARDE no le afecta, ver el
    // comentario grande sobre `gate` en makeFakeClient).
    const gateA = deferred<void>();
    gateHolder.current = gateA.promise;

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(holder.current?.hydrationScope?.phase).toBe("loading");
    const generationA = holder.current?.hydrationScope?.generation;

    // Deja que la red "se arregle" para cualquier intento FUTURO (B usará
    // esta promesa ya resuelta) — A sigue colgado de gateA, capturada antes
    // de este punto, así que esto no le afecta.
    gateHolder.current = Promise.resolve();

    // El watchdog de A (HYDRATION_TIMEOUT_MS=12000ms) dispara: invalida A,
    // pasa a "error" y programa el backoff automático
    // (HYDRATION_BACKOFF_MS[0]=2000ms) — generación B arranca SOLA, sin
    // ningún clic manual de por medio.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000 + 2_000);
    });
    const generationB = holder.current?.hydrationScope?.generation;
    expect(generationB).not.toBe(generationA);
    expect(holder.current?.hydrationScope?.phase).toBe("ready"); // B ya terminó de verdad (gate ya resuelto)

    // AHORA resuelve el gate de A — su ensureBaseRows()/pullState(),
    // suspendidos desde el principio, por fin completan y su propio
    // runHydrationAttempt() resuelve con {kind:"applied"}. Como
    // attemptRef.current ya no es el suyo (isCurrent() falla), su limpieza
    // debe descartarse por completo: nunca debe tocar attemptRef.current
    // (que es de B) ni volver a aplicar hydrationScope con la generación A.
    gateA.resolve();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(holder.current?.hydrationScope?.generation).toBe(generationB); // sigue siendo B — A nunca lo pisó
    expect(holder.current?.hydrationScope?.phase).toBe("ready");
  });

  it("el watchdog de B sobrevive a que A (más viejo) resuelva tarde — la limpieza de A está identificada por generación (corrección §2/§10)", async () => {
    // Reproduce EXACTAMENTE el bug descrito en la revisión: si la limpieza
    // de un intento (clearHydrationWatchdog() sin comprobar identidad)
    // corriera ANTES de comprobar `attemptRef.current?.generation !==
    // generation`, un A que resuelve tarde borraría el watchdog de B — B se
    // quedaría sin ninguna protección de timeout, "loading" para siempre,
    // sin que nada lo detectara.
    vi.useFakeTimers();
    // AMBOS intentos (A y B) se quedan colgados para siempre en la misma
    // promesa sin resolver — no hace falta diferenciarlos, cada uno tiene
    // su PROPIO watchdog por generación de todos modos.
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } }, gate: { current: deferred<void>().promise } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(holder.current?.hydrationScope?.phase).toBe("loading");
    const generationA = holder.current?.hydrationScope?.generation;

    // El watchdog de A dispara a los 12000ms → error → backoff a los
    // 2000ms → arranca B (generación nueva), con su PROPIO watchdog de
    // 12000ms armado desde ESTE momento (t≈14000ms).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000 + 2_000);
    });
    const generationB = holder.current?.hydrationScope?.generation;
    expect(generationB).not.toBe(generationA);
    expect(holder.current?.hydrationScope?.phase).toBe("loading"); // B también está colgado — su watchdog sigue contando

    // Nada más resuelve la promesa de A NUNCA — pero su ciclo de limpieza
    // ya no tiene forma de "terminar" sin que alguien más lo dispare. En su
    // lugar, avanzamos justo lo suficiente para que, SI el bug estuviera
    // presente (limpieza de A borrando el watchdog de B sin comprobar
    // generación), el watchdog de B jamás dispararía — y si NO está
    // presente, el watchdog de B (armado en t≈14000ms, con su propio plazo
    // de 12000ms) debe disparar sobre t≈26000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000 + 100);
    });

    expect(holder.current?.hydrationScope?.generation).toBe(generationB);
    expect(holder.current?.hydrationScope?.phase).toBe("error"); // el watchdog de B SÍ disparó — nunca fue borrado por A
    expect(holder.current?.hydrationScope?.errorReason).toBe("timeout");
  });

  it("una rejection inesperada (fallo de red crudo, no un {error} de postgrest) nunca escapa como unhandledRejection (corrección §1/§10)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      // A diferencia de los demás tests (que devuelven {data:null, error:{...}}
      // — el modo normal en que postgrest-js reporta un fallo), aquí la
      // propia promesa de red RECHAZA — el equivalente a una excepción de
      // fetch/TypeError real, el caso que runHydrationAttempt() debe
      // convertir a {kind:"failed"} en vez de dejar escapar.
      const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
      const originalFrom = client.from.bind(client);
      (client as unknown as { from: typeof client.from }).from = (table: string) => {
        if (table === "user_profiles") {
          return { then: (_resolve: unknown, reject: (e: unknown) => void) => reject(new TypeError("fallo de red simulado")) } as never;
        }
        return originalFrom(table);
      };
      clientHolder.client = client;
      const { Capture, holder } = makeCapture();

      root = createRoot(container);
      await act(async () => {
        root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      });

      // Se convirtió en un estado de error visible — normal, gestionado —
      // nunca en una rejection sin capturar.
      expect(holder.current?.hydrationScope?.phase).toBe("error");
      expect(holder.current?.hydrationScope?.errorReason).toBe("failed");
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("el gate de mutaciones directas vuelve a cerrarse al desmontar el provider (corrección §7/§10)", async () => {
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope?.phase).toBe("ready"); // gate abierto

    act(() => { root!.unmount(); });
    root = null; // ya desmontado — afterEach no debe volver a desmontarlo

    const blockedResult = await remote.saveNutritionSnapshot({} as never);
    expect((blockedResult as RemoteMutationResult<void>).kind).toBe("blocked");
  });

  it("el gate de mutaciones directas vuelve a cerrarse al perder la sesión (logout / expulsión involuntaria) — corrección §7/§10", async () => {
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope?.phase).toBe("ready"); // gate abierto

    await act(async () => {
      (client as unknown as { __emitAuth: (e: string, s: null) => void }).__emitAuth("SIGNED_OUT", null);
      await Promise.resolve(); await Promise.resolve();
    });

    expect(holder.current?.hydrationScope).toBeNull(); // sin sesión, sin scope de hidratación
    const blockedResult = await remote.saveNutritionSnapshot({} as never);
    expect((blockedResult as RemoteMutationResult<void>).kind).toBe("blocked");
  });

  it("mutate()/addWater()/setWaterAbsolute()/seedDemo() son NO-OP TOTAL cuando el gate está cerrado — llamadas a las funciones públicas reales, no a una simulación pura (corrección bloqueante P0/P10)", async () => {
    // Sin baseline y con el pull bloqueado para siempre → recovery-screen →
    // canAcceptRemoteMutations()===false. Exactamente el escenario original
    // del bug: "sin baseline o después de resetAll(), una acción puede
    // clonar defaultState, escribir la outbox y programar un snapshot
    // completo".
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } }, gate: { current: deferred<void>().promise } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope?.phase).toBe("loading");
    expect(holder.current?.hydrationScope?.hasLocalBaseline).toBe(false); // recovery-screen — gate cerrado

    const stateBefore = holder.current?.state;

    // Corrección de revisión (contrato booleano de mutate()): con el gate
    // cerrado, mutate() debe devolver `false` — es la única señal que un
    // caller (p.ej. borrar una receta) puede usar para decidir si mostrar
    // éxito, en vez de reimplementar su propia comprobación de
    // canAcceptRemoteMutations()/hydrationScope por separado.
    let mutateResult: boolean | undefined;
    act(() => { mutateResult = holder.current?.mutate((draft) => { draft.weeklyBudget = 999999; }); });
    act(() => { holder.current?.addWater(500); });
    act(() => { holder.current?.setWaterAbsolute("2026-09-15", 1234); });
    act(() => { holder.current?.seedDemo(); });

    expect(mutateResult).toBe(false);

    // React ni siquiera re-renderizó con un estado distinto — mismo objeto
    // de referencia que antes de las cuatro llamadas (setState() nunca se
    // llamó, ver el guard mutationsBlocked() al principio de cada función).
    expect(holder.current?.state).toBe(stateBefore);
    expect(holder.current?.state.weeklyBudget).not.toBe(999999);
    expect(holder.current?.state.waterLog).toEqual({});
    expect(holder.current?.state.inventory).toEqual([]); // seedDemo() nunca llegó a construir `demo`

    // Tampoco se escribió NADA en la outbox de este usuario — ni el snapshot
    // completo que mutate()/seedDemo() habrían programado.
    expect(outbox.readEnvelope(USER_ID)).toBeNull();
  });

  it("mutate() devuelve true y aplica el cambio en modo local (sin Supabase configurado) — corrección del contrato booleano", async () => {
    // Sin configuración de Supabase, canAcceptRemoteMutations(null) ===
    // !hasSupabaseConfig() === true: el gate está abierto desde el
    // principio, sin necesidad de sesión ni de hidratación alguna — este es
    // el modo "app sin cuenta" normal, no un caso raro.
    supabaseConfigHolder.value = false;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope).toBeNull(); // sin Supabase, nunca hay intento de hidratación

    let mutateResult: boolean | undefined;
    act(() => { mutateResult = holder.current?.mutate((draft) => { draft.weeklyBudget = 42; }); });

    expect(mutateResult).toBe(true);
    expect(holder.current?.state.weeklyBudget).toBe(42);
  });
});

// ─── Arranque en frío y transiciones de sesión con Realtime (diseño v5
// §Realtime, ronda 3 de revisión) ───────────────────────────────────────────
// A diferencia del resto del archivo (ownership de la HIDRATACIÓN), este
// bloque verifica el otro riesgo que la ronda 3 pidió demostrar con
// FoodOSProvider real: que classifyAuthTransition() puramente por identidad
// no rompe el arranque en frío (authUserRef empieza en null de verdad, nunca
// "A" antes de que llegue el primer INITIAL_SESSION(A) — ver el comentario
// grande de classifyAuthTransition en state.tsx) y que setupRealtime() crea
// exactamente un canal por cambio real de sesión, nunca de más ni de menos.
// __getChannelCallCount()/__getRemoveChannelCallCount() (añadidos al fake
// client más arriba) son contadores GLOBALES del cliente — suficientes aquí
// porque cada test usa su propio cliente fresco.
function channelCalls(client: unknown) {
  return (client as { __getChannelCallCount: () => number }).__getChannelCallCount();
}
function removeChannelCalls(client: unknown) {
  return (client as { __getRemoveChannelCallCount: () => number }).__getRemoveChannelCallCount();
}
function emitAuth(client: unknown, event: string, session: { user: { id: string } } | null) {
  (client as { __emitAuth: (e: string, s: { user: { id: string } } | null) => void }).__emitAuth(event, session);
}

describe("FoodOSProvider — arranque en frío y transiciones de sesión con Realtime (diseño v5 §Realtime, ronda 3)", () => {
  it("arranque en frío CON sesión persistida A: hidrata exactamente una vez, crea exactamente un canal Realtime, y termina con el scope perteneciendo a A", async () => {
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    // Si authUserRef.current NO estuviera garantizado null antes del primer
    // INITIAL_SESSION(A), classifyAuthTransition(prevId="A", newId="A")
    // devolvería "same_session" — ni replaceHydration() ni setupRealtime()
    // llegarían a ejecutarse nunca, y esto se quedaría en "loading" para
    // siempre (o, peor, sin ningún hydrationScope). Que termine en "ready"
    // con exactamente un canal ES la prueba de que el arranque en frío sigue
    // siendo "real_change", tal y como concluyó la verificación de la
    // ronda 3 (authUserRef solo se escribe dentro de este mismo callback).
    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    expect(holder.current?.hydrationScope?.userId).toBe(USER_ID);
    expect(holder.current?.authUser?.id).toBe(USER_ID);
    expect(channelCalls(client)).toBe(1);
  });

  it("arranque en frío SIN sesión: no hidrata y no crea ningún canal Realtime", async () => {
    const { client } = makeFakeClient({ initialSession: null });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(holder.current?.hydrationScope).toBeNull();
    expect(holder.current?.authUser).toBeNull();
    expect(channelCalls(client)).toBe(0);
  });

  it("primer login null→A: hidrata y se suscribe a Realtime exactamente una vez", async () => {
    const { client } = makeFakeClient({ initialSession: null });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope).toBeNull();
    expect(channelCalls(client)).toBe(0);

    await act(async () => {
      emitAuth(client, "SIGNED_IN", { user: { id: USER_ID } });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    expect(holder.current?.hydrationScope?.userId).toBe(USER_ID);
    expect(channelCalls(client)).toBe(1);
  });

  it("tras A ya inicializado, varios eventos con el MISMO UUID no reinician la hidratación, no crean un canal nuevo y no avanzan la generación", async () => {
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    const generationAfterColdStart = holder.current?.hydrationScope?.generation;
    const channelCallsAfterColdStart = channelCalls(client);
    expect(channelCallsAfterColdStart).toBe(1);

    await act(async () => {
      // TOKEN_REFRESHED/USER_UPDATED/INITIAL_SESSION del MISMO usuario — los
      // tres deben clasificar como "same_session" bajo la regla puramente
      // por identidad, exactamente igual que un SIGNED_IN eco de la propia
      // sesión (no solo la lista blanca de eventos que existía antes).
      emitAuth(client, "TOKEN_REFRESHED", { user: { id: USER_ID } });
      emitAuth(client, "USER_UPDATED", { user: { id: USER_ID } });
      emitAuth(client, "INITIAL_SESSION", { user: { id: USER_ID } });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    expect(holder.current?.hydrationScope?.generation).toBe(generationAfterColdStart); // ninguna generación nueva
    expect(channelCalls(client)).toBe(channelCallsAfterColdStart); // ningún canal nuevo
  });

  it("A→B (cambio de cuenta): crea una nueva propiedad de sesión — generación nueva y un canal Realtime nuevo", async () => {
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    const generationA = holder.current?.hydrationScope?.generation;
    const channelCallsAfterA = channelCalls(client);
    expect(channelCallsAfterA).toBe(1);

    await act(async () => {
      emitAuth(client, "SIGNED_IN", { user: { id: "user-b" } });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    expect(holder.current?.hydrationScope?.userId).toBe("user-b");
    expect(holder.current?.hydrationScope?.generation).not.toBe(generationA);
    expect(channelCalls(client)).toBe(channelCallsAfterA + 1); // un canal nuevo para B
    expect(removeChannelCalls(client)).toBeGreaterThanOrEqual(1); // el de A se desmontó
  });

  it("A→null (logout): desmonta el canal Realtime de la sesión saliente y no crea ninguno nuevo", async () => {
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    const channelCallsAfterA = channelCalls(client);
    expect(channelCallsAfterA).toBe(1);

    await act(async () => {
      emitAuth(client, "SIGNED_OUT", null);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(holder.current?.hydrationScope).toBeNull();
    expect(holder.current?.authUser).toBeNull();
    expect(channelCalls(client)).toBe(channelCallsAfterA); // ningún canal nuevo (no hay usuario nuevo)
    expect(removeChannelCalls(client)).toBeGreaterThanOrEqual(1); // el de A se desmontó
  });

  it("logout→login RÁPIDO del MISMO usuario A: crea una nueva propiedad de sesión (generación y canal nuevos), nunca reutiliza la anterior", async () => {
    const { client } = makeFakeClient({ initialSession: { user: { id: USER_ID } } });
    clientHolder.client = client;
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    const generationA1 = holder.current?.hydrationScope?.generation;
    const channelCallsAfterA1 = channelCalls(client);
    expect(channelCallsAfterA1).toBe(1);

    await act(async () => {
      // Logout y login del MISMO usuario disparados seguidos, sin esperar
      // entre medias — replica un logout→login real (p. ej.
      // reautenticación tras un token caducado) sin dar tiempo a que nada
      // "se asiente" entre ambos eventos.
      emitAuth(client, "SIGNED_OUT", null);
      emitAuth(client, "SIGNED_IN", { user: { id: USER_ID } });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(holder.current?.hydrationScope?.phase).toBe("ready");
    expect(holder.current?.hydrationScope?.userId).toBe(USER_ID);
    expect(holder.current?.hydrationScope?.generation).not.toBe(generationA1); // nueva propiedad de sesión, no la reutiliza
    expect(channelCalls(client)).toBe(channelCallsAfterA1 + 1); // canal nuevo, no el mismo objeto reutilizado
    expect(removeChannelCalls(client)).toBeGreaterThanOrEqual(1); // el de la primera A se desmontó
  });
});
