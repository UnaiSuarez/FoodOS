import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CartItem, FoodOSState, InventoryItem, PhysicalProfile, Recipe } from "@foodos/types";
import { remote } from "./data-layer";
import { NUTRITION_ENGINE_VERSION } from "./nutrition";
import * as outbox from "./outbox";
import {
  actions,
  applyWaterTarget,
  classifyAuthTransition,
  computeSyncStatus,
  createHydrationCoordinator,
  defaultState,
  flushPendingOrTimeout,
  getIngredientStatus,
  getRecipeMatch,
  normalizeState,
  reportCleanupIssue,
  resolveInitialStateForSession,
  resolveSignOutChoice,
} from "./state";

function inv(overrides: Partial<InventoryItem>): InventoryItem {
  return {
    id: overrides.id ?? "inv-1",
    name: overrides.name ?? "Pollo",
    qty: overrides.qty ?? 100,
    unit: overrides.unit ?? "g",
    storage: overrides.storage ?? "Nevera",
    expires: overrides.expires ?? "2099-01-01",
    price: overrides.price ?? 1,
    kcal: overrides.kcal ?? 100,
    protein: overrides.protein ?? 20,
    ...overrides,
  };
}

function recipe(ingredients: Recipe["ingredients"]): Recipe {
  return {
    id: "r-1",
    title: "Receta de prueba",
    ingredients,
    kcal: 500,
    protein: 40,
    carbs: 50,
    fat: 15,
    cost: 3,
    image: "",
    time: 20,
    servings: 1,
    difficulty: "fácil",
    tags: [],
    steps: [],
  };
}

// E08-06: getRecipeMatch/getIngredientStatus consideran cantidad, no solo si
// existe algo con ese nombre en inventario.
describe("getRecipeMatch — cantidad, no solo nombre (E08-06)", () => {
  it("no cuenta un ingrediente como disponible si hay menos cantidad de la que pide la receta", () => {
    const state = { ...defaultState, inventory: [inv({ name: "Pollo", qty: 50, unit: "g" })] };
    const r = recipe([{ name: "Pollo", quantity: 500, unit: "g" }]);
    const match = getRecipeMatch(state, r);
    expect(match.matches).toHaveLength(0);
    expect(match.pct).toBe(0);
  });

  it("cuenta el ingrediente como disponible cuando la cantidad alcanza (sumando varios lotes)", () => {
    const state = {
      ...defaultState,
      inventory: [
        inv({ id: "a", name: "Pollo", qty: 300, unit: "g" }),
        inv({ id: "b", name: "Pollo", qty: 250, unit: "g" }),
      ],
    };
    const r = recipe([{ name: "Pollo", quantity: 500, unit: "g" }]);
    const match = getRecipeMatch(state, r);
    expect(match.matches).toHaveLength(1);
    expect(match.pct).toBe(100);
  });

  it("convierte unidades (kg de inventario vs g de la receta) antes de comparar", () => {
    const state = { ...defaultState, inventory: [inv({ name: "Arroz", qty: 1, unit: "kg" })] };
    const r = recipe([{ name: "Arroz", quantity: 200, unit: "g" }]);
    expect(getRecipeMatch(state, r).pct).toBe(100);
  });
});

describe("getIngredientStatus — mismo criterio por ingrediente (E08-05/06)", () => {
  it("marca has:false si la cantidad disponible no llega, aunque el nombre exista en inventario", () => {
    const state = { ...defaultState, inventory: [inv({ name: "Leche", qty: 50, unit: "ml" })] };
    const r = recipe([{ name: "Leche", quantity: 200, unit: "ml" }]);
    const status = getIngredientStatus(state, r);
    expect(status).toEqual([{ name: "Leche", quantity: 200, unit: "ml", has: false }]);
  });
});

function cartItem(overrides: Partial<CartItem>): CartItem {
  return {
    id: overrides.id ?? "cart-1",
    name: overrides.name ?? "Yogur",
    qty: overrides.qty ?? 1,
    unit: overrides.unit ?? "ud",
    price: overrides.price ?? 1,
    store: overrides.store ?? "Mercadona",
    checked: overrides.checked ?? true,
    ...overrides,
  };
}

// E10-03/05/07: repasar una compra antes de aplicarla — precio real
// (distinto del estimado del carrito), tienda y caducidad quedan en manos
// de lo que se confirme en el repaso, no de lo que llevaba el carrito.
describe("proposePurchaseReview / completePurchase (E10-03/05/07)", () => {
  it("propone solo los items marcados, con estimatedPrice y price iguales al del carrito", () => {
    const state = {
      ...defaultState,
      cart: [
        cartItem({ id: "a", name: "Pan", price: 1.2, checked: true }),
        cartItem({ id: "b", name: "Sin marcar", price: 9, checked: false }),
      ],
    };
    const proposal = actions.proposePurchaseReview(state);
    expect(proposal).toHaveLength(1);
    expect(proposal[0].name).toBe("Pan");
    expect(proposal[0].price).toBe(1.2);
    expect(proposal[0].estimatedPrice).toBe(1.2);
  });

  it("registra el gasto con el precio REVISADO, no el estimado del carrito", () => {
    const state = { ...defaultState, cart: [cartItem({ id: "a", name: "Pan", price: 1.2 })] };
    const proposal = actions.proposePurchaseReview(state);
    const reviewed = [{ ...proposal[0], price: 2.5 }]; // el usuario corrige el precio real
    const draft = structuredClone(state);
    actions.completePurchase(draft, reviewed);
    expect(draft.expenses).toHaveLength(1);
    expect(draft.expenses[0].amount).toBe(2.5);
  });

  it("da de alta el producto en inventario con la caducidad/tienda/almacén confirmados y vacía el carrito revisado", () => {
    const state = { ...defaultState, cart: [cartItem({ id: "a", name: "Pan", price: 1.2 })] };
    const proposal = actions.proposePurchaseReview(state);
    const reviewed = [{ ...proposal[0], expires: "2030-05-05", store: "Lidl", storage: "Despensa" as const }];
    const draft = structuredClone(state);
    actions.completePurchase(draft, reviewed);
    expect(draft.inventory).toHaveLength(1);
    expect(draft.inventory[0]).toMatchObject({ name: "Pan", expires: "2030-05-05", storage: "Despensa" });
    expect(draft.cart).toHaveLength(0);
  });
});

// E21-15: normalizeState es el punto único por el que pasa CUALQUIER estado
// cargado (local o importado a mano desde Ajustes) antes de usarse — si un
// formato antiguo no migra bien aquí, un usuario que importe un backup de
// hace tiempo puede acabar con datos corruptos o silenciosamente perdidos.
// Los objetos de entrada usan campos ausentes/con forma antigua a propósito
// (as unknown as FoodOSState) — así es como llega de verdad un JSON.parse
// de un archivo exportado hace tiempo, el tipo FoodOSState solo describe el
// formato ACTUAL.
describe("normalizeState — migración de estados antiguos (E21-15)", () => {
  it("migra los modos en español al enum actual", () => {
    const legacy = { ...defaultState, nutrition: { ...defaultState.nutrition, mode: "Perdida de grasa" } };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.nutrition.mode).toBe("fat_loss");
  });

  it("rellena arrays/objetos ausentes de versiones antiguas sin tocar el resto del estado", () => {
    const legacy = { ...defaultState, inventory: [inv({ name: "Pollo" })] } as unknown as Record<string, unknown>;
    delete legacy.incomeSources;
    delete legacy.recurringExpenses;
    delete legacy.waterLog;
    delete legacy.weightLog;
    delete legacy.routines;
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.incomeSources).toEqual([]);
    expect(next.recurringExpenses).toEqual([]);
    expect(next.waterLog).toEqual({});
    expect(next.weightLog).toEqual([]);
    expect(next.routines).toEqual([]);
    // Lo que SÍ traía el estado antiguo no se pierde en el proceso.
    expect(next.inventory).toHaveLength(1);
    expect(next.inventory[0].name).toBe("Pollo");
  });

  it("migra consumedMeals (formato pre-diario datado) a foodLog con fecha de hoy, y borra el campo legacy", () => {
    const legacy = {
      ...defaultState,
      consumedMeals: [{ id: "old-1", name: "Tortilla", kcal: 300, protein: 18, carbs: 5, fat: 20, fiber: 0 }],
    };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.foodLog).toHaveLength(1);
    expect(next.foodLog[0]).toMatchObject({ id: "old-1", name: "Tortilla", kcal: 300, source: "recipe" });
    expect((next as unknown as Record<string, unknown>).consumedMeals).toBeUndefined();
  });

  it("infiere mealType para entradas del diario antiguas que no lo tenían", () => {
    const legacy = {
      ...defaultState,
      foodLog: [{ id: "e1", date: "2025-01-01", time: "08:30", name: "Café con leche", qty: null, unit: null, kcal: 60, protein: 3, carbs: 6, fat: 2, source: "manual" }],
    };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.foodLog[0].mealType).toBe("breakfast");
  });

  it("convierte ingredientes de receta guardados como string plano a {name, quantity, unit}", () => {
    const legacy = {
      ...defaultState,
      customRecipes: [{ ...recipe(["Arroz", "Pollo"] as unknown as Recipe["ingredients"]) }],
    };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.customRecipes[0].ingredients).toEqual([
      { name: "Arroz", quantity: 100, unit: "g" },
      { name: "Pollo", quantity: 100, unit: "g" },
    ]);
  });

  it("fusiona settings parciales antiguos con los valores por defecto, sin perder el resto (incluido lowStockThresholds anidado)", () => {
    const legacy = { ...defaultState, settings: { waterGoalMl: 3000 } };
    const next = normalizeState(legacy as unknown as typeof defaultState);
    expect(next.settings.waterGoalMl).toBe(3000); // lo que traía el import se respeta
    expect(next.settings.expiryWarnDays).toBe(defaultState.settings.expiryWarnDays); // lo que faltaba, se rellena
    expect(next.settings.lowStockThresholds).toEqual(defaultState.settings.lowStockThresholds);
  });

  it("es idempotente: aplicarlo dos veces seguidas no duplica ni corrompe nada", () => {
    const legacy = {
      ...defaultState,
      consumedMeals: [{ id: "old-1", name: "Tortilla", kcal: 300, protein: 18, carbs: 5, fat: 20, fiber: 0 }],
      nutrition: { ...defaultState.nutrition, mode: "Recomposicion" },
    };
    const once = normalizeState(legacy as unknown as typeof defaultState);
    const twice = normalizeState(once);
    expect(twice.foodLog).toHaveLength(1); // no se duplica la comida migrada
    expect(twice.nutrition.mode).toBe("recomp");
    expect(twice).toEqual(once);
  });
});

// ─── nutrition-v3.1 — transición de motor sin riesgo de carrera en el arranque ──
// Corrección de revisión: ProfileSummary (componente visual) disparaba
// applyEngineVersionTransition() en un useEffect y llamaba a mutate(), que
// guarda el snapshot completo y programa un push. Al arrancar, el estado
// LOCAL se carga primero (síncrono) y el remoto se hidrata después (async,
// red) — si ese efecto corría con el perfil local todavía no confirmado
// por el servidor, podía programarse un push del snapshot local antiguo
// mientras la hidratación remota autoritativa seguía en curso, con riesgo
// de que uno pisara al otro según cuál terminara antes. La transición se
// movió a normalizeState() — capa de estado pura, sin efectos secundarios
// propios — llamada tanto sobre el estado local como sobre el remoto recién
// hidratado, cada uno de forma completamente independiente (nunca se
// fusionan). Quien llama (FoodOSProvider) decide cuándo persistir cada
// resultado.
function physicalProfile(overrides: Partial<PhysicalProfile> = {}): PhysicalProfile {
  return {
    age: 30, sex: "male", heightCm: 178, weightKg: 78, bodyFatPct: null,
    activityLevel: "sedentary", goal: "maintain", gymDays: [1, 3, 5],
    allergies: [], excludedFoods: [],
    ...overrides,
  };
}

describe("normalizeState — transición de motor v3.1 (sin contaminación entre estado local y remoto)", () => {
  it("perfil local antiguo + perfil remoto más reciente, ambos con motor desactualizado: normalizeState(remoto) conserva TODOS los datos remotos, solo sella la versión y reinicia calibración — nunca mezcla con el local", () => {
    // "Local antiguo": lo que había en localStorage antes de que el usuario
    // recalibrara su plan en otro dispositivo.
    const localState: FoodOSState = {
      ...defaultState,
      profile: physicalProfile({
        weightKg: 90, goal: "fat_loss",
        activityModelVersion: "lifestyle_plus_training",
        trainingActivity: {
          lifestyleActivity: "sedentary", strengthDaysPerWeek: 3, cardioDaysPerWeek: 2,
          strengthAvgDurationMin: 45, cardioAvgDurationMin: 30, habitualSteps: null,
        },
        adaptiveKcalOffsetKcal: -50,
        adaptiveCalibrationStartedAt: "2026-01-01",
        lastTargetChangedAt: "2026-01-01",
        // sin lastCalculationEngineVersion — perfil de antes de v3.1
      }),
    };

    // "Remoto más reciente": el usuario cambió de peso y objetivo desde
    // otro dispositivo DESPUÉS de guardar el snapshot local — sigue sin
    // lastCalculationEngineVersion (tampoco pasó por v3.1 todavía), y su
    // cardio es legacy (cardioDaysPerWeek > 0, sin tipo/intensidad) → SÍ
    // queda afectado por el cambio de fórmula.
    const remoteState: FoodOSState = {
      ...defaultState,
      profile: physicalProfile({
        weightKg: 85, goal: "recomp", // distinto del local — la prueba de que no se mezclan
        activityModelVersion: "lifestyle_plus_training",
        trainingActivity: {
          lifestyleActivity: "light", strengthDaysPerWeek: 4, cardioDaysPerWeek: 3,
          strengthAvgDurationMin: 60, cardioAvgDurationMin: 40, habitualSteps: 9000,
        },
        adaptiveKcalOffsetKcal: 120, // distinto del local
        adaptiveCalibrationStartedAt: "2026-02-15",
        lastTargetChangedAt: "2026-02-15",
      }),
    };

    const normalizedRemote = normalizeState(remoteState);
    const p = normalizedRemote.profile!;

    // Todos los datos REMOTOS se conservan exactamente — nada del perfil
    // local (peso 90, fat_loss, offset -50, fecha 2026-01-01) se filtra.
    expect(p.weightKg).toBe(85);
    expect(p.goal).toBe("recomp");
    expect(p.adaptiveKcalOffsetKcal).toBe(120);
    expect(p.trainingActivity).toEqual(remoteState.profile!.trainingActivity);

    // Único cambio: el sello de versión (siempre) y el reinicio de
    // calibración (porque este perfil remoto SÍ está afectado — cardio
    // legacy con cardioDaysPerWeek > 0 y sin tipo/intensidad).
    expect(p.lastCalculationEngineVersion).toBe(NUTRITION_ENGINE_VERSION);
    expect(p.adaptiveCalibrationStartedAt).not.toBe("2026-02-15");
    expect(p.adaptiveCalibrationStartedAt).not.toBe("2026-01-01"); // tampoco el del local

    // normalizeState(local) es una llamada TOTALMENTE independiente — no
    // recibe ni puede ver remoteState en ningún momento.
    const normalizedLocal = normalizeState(localState);
    expect(normalizedLocal.profile!.weightKg).toBe(90);
    expect(normalizedLocal.profile!.goal).toBe("fat_loss");
  });

  it("perfil remoto YA al día (lastCalculationEngineVersion == motor actual): normalizeState no toca nada de calibración, aunque el local esté desactualizado", () => {
    const remoteState: FoodOSState = {
      ...defaultState,
      profile: physicalProfile({
        weightKg: 82,
        lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION,
        adaptiveCalibrationStartedAt: "2026-03-01",
      }),
    };
    const normalized = normalizeState(remoteState);
    expect(normalized.profile!.adaptiveCalibrationStartedAt).toBe("2026-03-01");
    expect(normalized.profile!.weightKg).toBe(82);
  });

  it("perfil remoto legacy_total_pal con motor desactualizado: sella la versión pero NO reinicia calibración (esa fórmula no cambió)", () => {
    const remoteState: FoodOSState = {
      ...defaultState,
      profile: physicalProfile({
        activityModelVersion: "legacy_total_pal",
        adaptiveCalibrationStartedAt: "2026-01-10",
      }),
    };
    const normalized = normalizeState(remoteState);
    expect(normalized.profile!.lastCalculationEngineVersion).toBe(NUTRITION_ENGINE_VERSION);
    expect(normalized.profile!.adaptiveCalibrationStartedAt).toBe("2026-01-10");
  });
});

// ─── Reproducción EJECUTABLE de la carrera asíncrona (corrección de revisión) ──
// Los tests anteriores (normalizeState llamado por separado, o inspección
// de texto fuente) podían pasar aunque reapareciera un
// hydrateRemoteState() (la función original de una fase anterior) se
// sustituyó por createHydrationCoordinator() — con identidad de instancia
// (bloqueante §8 de la revisión) y ya sin recibir saveLocalState como
// dependencia inyectada: ahora escribe directamente el envelope de la
// outbox (outbox.writeEnvelope), la misma persistencia real que usa
// mutate(). deps.schedulePush recibe un PendingPush completo
// (userId/epoch/mutationId/revision/state), no un FoodOSState pelado.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const TEST_USER = "user-hydrate-1";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("createHydrationCoordinator — sin push del snapshot local antiguo durante la hidratación (reproducción de la carrera)", () => {
  it("mientras pullState() está pendiente no se llama a schedulePush; al resolver con un perfil remoto más reciente y motor antiguo, se llama a schedulePush UNA sola vez con un snapshot que conserva todos los datos remotos, y solo transiciona sello+calibración cuando corresponde", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: Array<{ userId: string; epoch: number; mutationId: string; revision: number; state: FoodOSState }> = [];
    let ensureBaseRowsCalled = false;
    const coordinator = createHydrationCoordinator();

    // "Perfil local antiguo" en OTRO usuario — documenta que la outbox del
    // usuario que se está hidratando (TEST_USER) empieza vacía; el
    // coordinador no tiene forma de ver datos de otro usuario en absoluto.
    void physicalProfile({ weightKg: 90, goal: "fat_loss", adaptiveKcalOffsetKcal: -50 });

    const hydratePromise = coordinator.hydrate(TEST_USER, 0, defaultState, {
      ensureBaseRows: async () => { ensureBaseRowsCalled = true; },
      pullState: () => pull.promise,
      schedulePush: (op) => schedulePushCalls.push(op),
      epochChanged: () => false,
      waitForMutationConfirmed: async () => "confirmed",
    });

    // El pull todavía no resolvió — deja que las microtasks previas al
    // await de pullState() se asienten (ensureBaseRows) sin avanzar más.
    await Promise.resolve();
    await Promise.resolve();
    expect(ensureBaseRowsCalled).toBe(true);
    expect(schedulePushCalls).toHaveLength(0);

    // Ahora resuelve el pull: perfil remoto, motor antiguo (sin
    // lastCalculationEngineVersion), cardio legacy (cardioDaysPerWeek > 0
    // sin tipo/intensidad) → SÍ afectado.
    const remoteProfile = physicalProfile({
      weightKg: 85, goal: "recomp",
      activityModelVersion: "lifestyle_plus_training",
      trainingActivity: {
        lifestyleActivity: "light", strengthDaysPerWeek: 4, cardioDaysPerWeek: 3,
        strengthAvgDurationMin: 60, cardioAvgDurationMin: 40, habitualSteps: 9000,
      },
      adaptiveKcalOffsetKcal: 120,
      adaptiveCalibrationStartedAt: "2026-02-15",
      lastTargetChangedAt: "2026-02-15",
    });
    pull.resolve({ ...defaultState, profile: remoteProfile });

    const result = await hydratePromise;

    expect(schedulePushCalls).toHaveLength(1);
    const pushed = schedulePushCalls[0];
    expect(pushed.userId).toBe(TEST_USER);

    // El snapshot empujado conserva TODOS los datos remotos.
    expect(pushed.state.profile!.weightKg).toBe(85);
    expect(pushed.state.profile!.goal).toBe("recomp");
    expect(pushed.state.profile!.adaptiveKcalOffsetKcal).toBe(120);
    expect(pushed.state.profile!.trainingActivity).toEqual(remoteProfile.trainingActivity);

    // Único cambio real: el sello de versión (siempre) y el reinicio de
    // calibración (porque este perfil SÍ está afectado).
    expect(pushed.state.profile!.lastCalculationEngineVersion).toBe(NUTRITION_ENGINE_VERSION);
    expect(pushed.state.profile!.adaptiveCalibrationStartedAt).not.toBe("2026-02-15");

    expect(result).toEqual(pushed.state);

    // La outbox real quedó escrita con exactamente ese mutationId — es lo
    // que runPush() usará para el compare-and-delete al confirmar.
    const envelope = outbox.readEnvelope(TEST_USER);
    expect(envelope?.pending?.mutationId).toBe(pushed.mutationId);
  });

  it("perfil remoto NO afectado (legacy_total_pal): sella la versión (schedulePush SÍ se llama, hay algo nuevo que guardar), pero NO reinicia la calibración", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: Array<{ state: FoodOSState }> = [];
    const coordinator = createHydrationCoordinator();

    const hydratePromise = coordinator.hydrate(TEST_USER, 0, defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      schedulePush: (op) => schedulePushCalls.push(op),
      epochChanged: () => false,
      waitForMutationConfirmed: async () => "confirmed",
    });

    pull.resolve({
      ...defaultState,
      profile: physicalProfile({ activityModelVersion: "legacy_total_pal", adaptiveCalibrationStartedAt: "2026-01-10" }),
    });
    await hydratePromise;

    expect(schedulePushCalls).toHaveLength(1);
    expect(schedulePushCalls[0].state.profile!.lastCalculationEngineVersion).toBe(NUTRITION_ENGINE_VERSION);
    expect(schedulePushCalls[0].state.profile!.adaptiveCalibrationStartedAt).toBe("2026-01-10"); // sin tocar
  });

  it("perfil remoto YA al día: no llama a schedulePush en absoluto (hydrate normal, puramente de lectura)", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: unknown[] = [];
    const coordinator = createHydrationCoordinator();

    const hydratePromise = coordinator.hydrate(TEST_USER, 0, defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      schedulePush: (op) => schedulePushCalls.push(op),
      epochChanged: () => false,
      waitForMutationConfirmed: async () => "confirmed",
    });

    pull.resolve({
      ...defaultState,
      profile: physicalProfile({ lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION, weightKg: 82 }),
    });
    const result = await hydratePromise;

    expect(schedulePushCalls).toHaveLength(0);
    expect(result!.profile!.weightKg).toBe(82);
  });

  it("epoch cambiado mientras el pull estaba en vuelo: devuelve null y no llama a schedulePush, aunque el pull acabe resolviendo", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: unknown[] = [];
    let changed = false;
    const coordinator = createHydrationCoordinator();

    const hydratePromise = coordinator.hydrate(TEST_USER, 0, defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      schedulePush: (op) => schedulePushCalls.push(op),
      epochChanged: () => changed,
      waitForMutationConfirmed: async () => "confirmed",
    });

    changed = true; // p.ej. la sesión cambió mientras el pull seguía en vuelo
    pull.resolve({ ...defaultState, profile: physicalProfile({ weightKg: 99 }) });

    const result = await hydratePromise;
    expect(result).toBeNull();
    expect(schedulePushCalls).toHaveLength(0);
    expect(outbox.readEnvelope(TEST_USER)).toBeNull(); // tampoco se escribió nada
  });

  it("hay un pendiente local ANTES de pedir a Supabase: el remoto se descarta para la UI, gana el pendiente (política documentada, no es fusión real)", async () => {
    const written = outbox.recordMutation(TEST_USER, { ...defaultState, weeklyBudget: 555 }, "tab-1");
    expect(written.ok).toBe(true);
    const schedulePushCalls: Array<{ mutationId: string }> = [];
    const coordinator = createHydrationCoordinator();

    const result = await coordinator.hydrate(TEST_USER, 0, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => ({ ...defaultState, weeklyBudget: 111 }), // "más reciente" en el servidor
      schedulePush: (op) => schedulePushCalls.push(op),
      epochChanged: () => false,
      waitForMutationConfirmed: async () => "timeout",
    });

    expect(result).toBeNull(); // el remoto NUNCA se aplica a la UI mientras haya algo local pendiente
    expect(schedulePushCalls).toHaveLength(1);
    expect(schedulePushCalls[0].mutationId).toBe((written as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId);
  });

  it("dos llamadas para el mismo userId+epoch comparten la misma promesa (dedup real — corrige el bug de doble hidratación inicial); otro usuario obtiene una petición aparte", async () => {
    const coordinator = createHydrationCoordinator();
    let pullCallsForA = 0;
    let pullCallsForB = 0;

    const promiseA1 = coordinator.hydrate("user-a", 0, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => { pullCallsForA++; return { ...defaultState, weeklyBudget: 1 }; },
      schedulePush: () => {},
      epochChanged: () => false,
      waitForMutationConfirmed: async () => "confirmed",
    });
    const promiseA2 = coordinator.hydrate("user-a", 0, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => { pullCallsForA++; return { ...defaultState, weeklyBudget: 2 }; },
      schedulePush: () => {},
      epochChanged: () => false,
      waitForMutationConfirmed: async () => "confirmed",
    });
    expect(promiseA1).toBe(promiseA2); // misma promesa exacta — la segunda llamada nunca ejecuta su propio pullState

    const promiseB = coordinator.hydrate("user-b", 0, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => { pullCallsForB++; return { ...defaultState, weeklyBudget: 3 }; },
      schedulePush: () => {},
      epochChanged: () => false,
      waitForMutationConfirmed: async () => "confirmed",
    });

    await Promise.all([promiseA1, promiseB]);
    expect(pullCallsForA).toBe(1); // solo la primera llamada disparó pullState de verdad
    expect(pullCallsForB).toBe(1);
  });
});

describe("resolveInitialStateForSession — el envelope activo se aplica a React SIN esperar a nada remoto (P0, hallazgo de mayor severidad de esta ronda)", () => {
  it("con un envelope activo pendiente (recarga tras una edición reciente): devuelve el estado del envelope, nunca defaultState", () => {
    outbox.recordMutation(TEST_USER, { ...defaultState, weeklyBudget: 777, inventory: [inv({ name: "Pollo", qty: 300 })] }, "tab-1");

    const result = resolveInitialStateForSession(TEST_USER, defaultState);

    expect(result.weeklyBudget).toBe(777);
    expect(result.inventory).toHaveLength(1);
    expect(result.inventory[0].name).toBe("Pollo");
  });

  it("una mutación posterior parte del envelope recuperado, no de defaultState — conserva todos sus campos previos", () => {
    outbox.recordMutation(TEST_USER, { ...defaultState, weeklyBudget: 777, mascotId: "zana", savingsGoalPct: 33 }, "tab-1");

    const resolved = resolveInitialStateForSession(TEST_USER, defaultState);
    // Mismo patrón que mutate() en FoodOSProvider: clona el estado ACTUAL
    // (que debe ser `resolved`, no defaultState) y aplica el cambio encima.
    const draft = structuredClone(resolved);
    draft.weeklyBudget = 900;
    const written = outbox.recordMutation(TEST_USER, draft, "tab-1");

    expect(written.ok).toBe(true);
    const envelope = outbox.readEnvelope(TEST_USER);
    expect(envelope?.state.weeklyBudget).toBe(900);
    expect(envelope?.state.mascotId).toBe("zana"); // conservado — nunca se perdió por partir de defaultState
    expect(envelope?.state.savingsGoalPct).toBe(33);
  });

  it("con un aparcado por expulsión involuntaria del MISMO usuario: lo restaura y lo aplica, nunca defaultState", () => {
    outbox.recordMutation(TEST_USER, { ...defaultState, weeklyBudget: 42 }, "tab-1");
    outbox.parkIfPending(TEST_USER); // simula la expulsión: aparca y limpia el activo
    expect(outbox.readEnvelope(TEST_USER)).toBeNull(); // confirma que, sin restaurar, se vería defaultState

    const result = resolveInitialStateForSession(TEST_USER, defaultState);

    expect(result.weeklyBudget).toBe(42);
    expect(outbox.readEnvelope(TEST_USER)).not.toBeNull(); // restoreParked() ya lo dejó como activo
  });

  it("sin ningún envelope ni aparcado: devuelve defaultState normalizado", () => {
    const result = resolveInitialStateForSession(TEST_USER, defaultState);
    expect(result).toEqual(normalizeState(defaultState));
  });

  it("FLUJO COMPUESTO: envelope activo con pending y datos distintivos → estado inicial resuelto desde el envelope → hidratación remota antigua no lo pisa → una edición posterior conserva los datos distintivos (mismo orden que usa FoodOSProvider, sin renderizar React)", async () => {
    outbox.recordMutation(TEST_USER, { ...defaultState, weeklyBudget: 4242, mascotId: "distintivo" as FoodOSState["mascotId"] }, "tab-1");

    // 1-3: inicialización de sesión — mismo orden que el efecto de
    // hidratación en FoodOSProvider (state.tsx): resolveInitialStateForSession()
    // se llama ANTES de tocar nada remoto.
    const initialState = resolveInitialStateForSession(TEST_USER, defaultState);
    expect(initialState.weeklyBudget).toBe(4242); // el estado inicial YA viene del envelope, nunca de defaultState

    // 4: hidratación remota "antigua" (un snapshot desactualizado en el
    // servidor) — createHydrationCoordinator la reprograma para reenvío y
    // descarta el pull para la UI mientras siga habiendo un pendiente.
    const scheduled: Array<{ mutationId: string; state: FoodOSState }> = [];
    const coordinator = createHydrationCoordinator();
    const result = await coordinator.hydrate(TEST_USER, 0, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => ({ ...defaultState, weeklyBudget: 111 }), // "remoto antiguo" — nunca debe llegar a la UI
      schedulePush: (op) => scheduled.push(op),
      epochChanged: () => false,
      waitForMutationConfirmed: async () => "timeout", // el push sigue reintentando en segundo plano; esta hidratación no bloquea
    });
    expect(result).toBeNull(); // el remoto antiguo NUNCA se aplicó a la UI
    expect(scheduled).toHaveLength(1); // sí reprogramó el reenvío de lo pendiente

    // 5: nueva edición ANTES de confirmar — parte del envelope actual
    // (leído de disco, que es lo que React ya está mostrando desde el paso
    // 1-3), nunca de defaultState — mismo patrón que mutate().
    const current = outbox.readEnvelope(TEST_USER)!.state;
    const draft = structuredClone(current);
    draft.weeklyBudget = 5000;
    const written2 = outbox.recordMutation(TEST_USER, draft, "tab-1");

    // 6: el nuevo snapshot conserva los datos distintivos del envelope
    // original — nunca se perdieron, ni con el remoto antiguo de por medio.
    expect(written2.ok).toBe(true);
    const finalEnvelope = outbox.readEnvelope(TEST_USER);
    expect(finalEnvelope?.state.weeklyBudget).toBe(5000);
    expect(finalEnvelope?.state.mascotId).toBe("distintivo");
  });
});

describe("applyWaterTarget — puro, sin efectos secundarios (P1: side effects fuera del updater de React)", () => {
  it("invocarla dos veces con los mismos argumentos (lo que Strict Mode le haría al updater que la envuelve) da el mismo resultado y NUNCA toca remote/outbox", () => {
    let remoteCalls = 0;
    const original = remote.setWaterTargetDurable.bind(remote);
    (remote as unknown as { setWaterTargetDurable: unknown }).setWaterTargetDurable = () => { remoteCalls++; };
    try {
      const base = { ...defaultState, waterLog: { "2026-08-24": 250 } };
      const draft1 = applyWaterTarget(base, "2026-08-24", 500);
      const draft2 = applyWaterTarget(base, "2026-08-24", 500); // Strict Mode invocaría el updater una segunda vez
      expect(draft1).toEqual(draft2);
      expect(draft1.waterLog["2026-08-24"]).toBe(500);
      expect(remoteCalls).toBe(0); // la función que vive DENTRO del updater nunca toca remote — el efecto real vive fuera, en el callback que la envuelve (ver addWater/setWaterAbsolute)
      expect(base.waterLog["2026-08-24"]).toBe(250); // tampoco muta el estado de entrada
    } finally {
      (remote as unknown as { setWaterTargetDurable: unknown }).setWaterTargetDurable = original;
    }
  });

  it("nunca deja el objetivo por debajo de 0", () => {
    const result = applyWaterTarget(defaultState, "2026-08-24", -100);
    expect(result.waterLog["2026-08-24"]).toBe(0);
  });
});

describe("computeSyncStatus — fuentes de 'unsynced' independientes (P1, cuarta ronda: antes un único booleano compartido)", () => {
  const base = { hasSupabaseConfig: true, isOnline: true, hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: false, pushStatus: "saved" as const };

  it("sin Supabase configurado: siempre 'local', pase lo que pase con las demás fuentes", () => {
    expect(computeSyncStatus({ ...base, hasSupabaseConfig: false, hadUnsyncedWaterWrite: true })).toBe("local");
  });

  it("offline manda sobre 'unsynced' (ambos son problemas reales, pero offline es más específico sobre la causa)", () => {
    expect(computeSyncStatus({ ...base, isOnline: false, hadUnsyncedEnvelopeWrite: true })).toBe("offline");
  });

  it("un guardado genérico correcto (hadUnsyncedEnvelopeWrite: false) NO limpia un fallo durable del agua sin resolver — sigue 'unsynced'", () => {
    expect(computeSyncStatus({ ...base, hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: true })).toBe("unsynced");
  });

  it("simétricamente: una persistencia de agua correcta no limpia un fallo durable del envelope genérico sin resolver", () => {
    expect(computeSyncStatus({ ...base, hadUnsyncedEnvelopeWrite: true, hadUnsyncedWaterWrite: false })).toBe("unsynced");
  });

  it("una persistencia correcta POSTERIOR del agua sí limpia su propia fuente — con la otra también en false, sale de 'unsynced'", () => {
    // Simula la secuencia real: ambas fuentes fallan en algún momento...
    expect(computeSyncStatus({ ...base, hadUnsyncedEnvelopeWrite: true, hadUnsyncedWaterWrite: true })).toBe("unsynced");
    // ...el envelope se recupera primero (sigue en unsynced por el agua)...
    expect(computeSyncStatus({ ...base, hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: true })).toBe("unsynced");
    // ...y solo cuando el agua TAMBIÉN se recupera, sale de "unsynced".
    expect(computeSyncStatus({ ...base, hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: false })).toBe("saved");
  });

  it("nunca aparece 'saved' (ni ningún otro pushStatus) mientras CUALQUIERA de las dos fuentes durables siga pendiente", () => {
    (["saved", "syncing", "error"] as const).forEach((pushStatus) => {
      expect(computeSyncStatus({ ...base, pushStatus, hadUnsyncedEnvelopeWrite: true, hadUnsyncedWaterWrite: false })).toBe("unsynced");
      expect(computeSyncStatus({ ...base, pushStatus, hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: true })).toBe("unsynced");
    });
  });

  it("sin ninguna fuente durable pendiente, el resultado es exactamente pushStatus (saved/syncing/error)", () => {
    (["saved", "syncing", "error"] as const).forEach((pushStatus) => {
      expect(computeSyncStatus({ ...base, pushStatus })).toBe(pushStatus);
    });
  });
});

describe("Aislamiento de hadUnsyncedEnvelopeWrite/hadUnsyncedWaterWrite por sesión (P1, quinta ronda)", () => {
  // Simula exactamente la decisión que toma el efecto de auth en
  // FoodOSProvider (state.tsx): los flags efímeros de UI se reinician
  // SOLO cuando classifyAuthTransition() dice "real_change" — nunca en un
  // TOKEN_REFRESHED/USER_UPDATED/SIGNED_IN del mismo usuario. No hay
  // @testing-library en este proyecto para renderizar el efecto completo
  // con sus dos useState; esto prueba la REGLA que lo gobierna, que es lo
  // único con lógica propia — el resto son dos setState de fontanería.
  function simulateAuthTransition(
    current: { hadUnsyncedEnvelopeWrite: boolean; hadUnsyncedWaterWrite: boolean },
    prevUserId: string | null,
    newUserId: string | null,
    event: Parameters<typeof classifyAuthTransition>[2],
  ) {
    if (classifyAuthTransition(prevUserId, newUserId, event) === "real_change") {
      return { hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: false };
    }
    return current;
  }

  it("fallo de agua de A no contamina a B: un cambio real de sesión reinicia hadUnsyncedWaterWrite antes de que B haga nada", () => {
    const afterTransition = simulateAuthTransition({ hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: true }, "user-a", "user-b", "SIGNED_OUT");
    expect(afterTransition.hadUnsyncedWaterWrite).toBe(false);
    expect(computeSyncStatus({ hasSupabaseConfig: true, isOnline: true, ...afterTransition, pushStatus: "saved" })).toBe("saved"); // B no aparece "unsynced" sin haber fallado nada él
  });

  it("fallo de envelope de A no contamina a B", () => {
    const afterTransition = simulateAuthTransition({ hadUnsyncedEnvelopeWrite: true, hadUnsyncedWaterWrite: false }, "user-a", "user-b", "SIGNED_OUT");
    expect(afterTransition.hadUnsyncedEnvelopeWrite).toBe(false);
  });

  it("un TOKEN_REFRESHED del mismo usuario conserva el estado — nunca reinicia flags de un fallo real todavía sin resolver", () => {
    const current = { hadUnsyncedEnvelopeWrite: true, hadUnsyncedWaterWrite: true };
    expect(simulateAuthTransition(current, "user-a", "user-a", "TOKEN_REFRESHED")).toEqual(current);
    expect(simulateAuthTransition(current, "user-a", "user-a", "USER_UPDATED")).toEqual(current);
    expect(simulateAuthTransition(current, "user-a", "user-a", "SIGNED_IN")).toEqual(current);
  });

  it("un cambio real de sesión reinicia AMBAS fuentes juntas (nunca una sí y la otra no) — el reinicio es por sesión; el limpiado posterior por éxito de cada fuente SÍ es independiente (ver computeSyncStatus)", () => {
    const afterTransition = simulateAuthTransition({ hadUnsyncedEnvelopeWrite: true, hadUnsyncedWaterWrite: true }, "user-a", "user-b", "SIGNED_OUT");
    expect(afterTransition).toEqual({ hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: false });
  });

  it("logout→login del MISMO usuario (SIGNED_OUT es siempre real_change) también reinicia — el estado persistido (outbox/aparcado), no este flag efímero, es quien lleva la cuenta real entre sesiones", () => {
    const afterTransition = simulateAuthTransition({ hadUnsyncedEnvelopeWrite: true, hadUnsyncedWaterWrite: true }, "user-a", "user-a", "SIGNED_OUT");
    expect(afterTransition).toEqual({ hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: false });
  });
});

describe("classifyAuthTransition — bloqueante §7 (TOKEN_REFRESHED del mismo usuario no cancela el push)", () => {
  it("mismo usuario + TOKEN_REFRESHED/USER_UPDATED/SIGNED_IN: same_session", () => {
    expect(classifyAuthTransition("u1", "u1", "TOKEN_REFRESHED")).toBe("same_session");
    expect(classifyAuthTransition("u1", "u1", "USER_UPDATED")).toBe("same_session");
    expect(classifyAuthTransition("u1", "u1", "SIGNED_IN")).toBe("same_session");
  });

  it("usuario distinto (incluido el primer login desde null): real_change, incluso con TOKEN_REFRESHED", () => {
    expect(classifyAuthTransition(null, "u1", "SIGNED_IN")).toBe("real_change");
    expect(classifyAuthTransition("u1", "u2", "SIGNED_IN")).toBe("real_change");
    expect(classifyAuthTransition("u1", "u2", "TOKEN_REFRESHED")).toBe("real_change");
  });

  it("SIGNED_OUT siempre es real_change, incluso si por algún motivo llegara con el mismo id", () => {
    expect(classifyAuthTransition("u1", "u1", "SIGNED_OUT")).toBe("real_change");
    expect(classifyAuthTransition("u1", null, "SIGNED_OUT")).toBe("real_change");
  });
});

describe("flushPendingOrTimeout / resolveSignOutChoice — logout explícito (bloqueante §4)", () => {
  beforeEach(() => {
    localStorage.clear();
    const r = remote as unknown as {
      client: unknown; user: unknown; sessionEpoch: number;
      pushTimer: unknown; pushRetryTimer: unknown; activePush: unknown; pushQueued: unknown;
    };
    r.client = null;
    r.user = null;
    r.sessionEpoch = 0;
    r.pushTimer = null; r.pushRetryTimer = null; r.activePush = null; r.pushQueued = null;
    remote.onStatusChange = null;
  });

  it("sin nada pendiente: flushPendingOrTimeout resuelve 'confirmed' de inmediato", async () => {
    await expect(flushPendingOrTimeout("user-1", 1000)).resolves.toBe("confirmed");
  });

  it("con SOLO agua pendiente (sin outbox genérica): no resuelve 'confirmed' hasta que el agua también se confirme — un logout no puede salir en silencio con solo agua sin sincronizar (corrección de revisión, P1)", async () => {
    (remote as unknown as { user: { id: string } | null }).user = { id: "user-1" };
    outbox.writeWaterPending("user-1", { "2026-08-24": 500 });

    const result = flushPendingOrTimeout("user-1", 5000);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // la outbox genérica está vacía, pero el agua NO — sigue sin confirmar

    outbox.discardWaterPending("user-1"); // simula que la RPC de agua confirmó
    (remote as unknown as { notifyStatus: (s: "syncing" | "saved" | "error") => void }).notifyStatus("saved");
    await expect(result).resolves.toBe("confirmed");
  });

  it("flushPendingOrTimeout(A) nunca consulta pendientes de B — aunque B sea la sesión ACTIVA en remote.user en este momento (corrección de revisión, P1)", async () => {
    // B es la sesión vigente (remote.user) y tiene agua pendiente propia —
    // si flushPendingOrTimeout(A) mirara remote.hasPendingWater() (implícito,
    // sesión vigente) en vez de hasPendingWaterFor(A) explícito, vería el
    // agua de B y nunca resolvería "confirmed" para A, aunque A no tenga
    // nada pendiente.
    (remote as unknown as { user: { id: string } | null }).user = { id: "user-b" };
    outbox.writeWaterPending("user-b", { "2026-08-24": 999 });

    await expect(flushPendingOrTimeout("user-a", 1000)).resolves.toBe("confirmed"); // A no tiene nada — B es irrelevante para A
    expect(outbox.readWaterPending("user-b")).toEqual({ "2026-08-24": 999 }); // y no se tocó nada de B por consultar A
  });

  it("con pendiente y sin que nadie emita 'saved': 'esperar y salir' NO cierra sesión — vence en timeout", async () => {
    vi.useFakeTimers();
    outbox.recordMutation("user-1", { ...defaultState }, "tab-1");
    let signOutCalled = false;
    (remote as unknown as { client: { auth: { signOut: () => Promise<unknown> } } }).client = {
      auth: { signOut: async () => { signOutCalled = true; return { error: null }; } },
    };

    const resultPromise = resolveSignOutChoice("user-1", "wait");
    await vi.advanceTimersByTimeAsync(15_100);
    const result = await resultPromise;

    expect(result.status).toBe("cancelled_timeout");
    expect(signOutCalled).toBe(false); // NUNCA cierra sesión si el timeout venció sin confirmar
    vi.useRealTimers();
  });

  it("con pendiente y remote.onStatusChange emite 'saved' tras vaciar la outbox: 'esperar y salir' SÍ cierra sesión", async () => {
    const written = outbox.recordMutation("user-1", { ...defaultState }, "tab-1");
    const mutationId = (written as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId;
    let signOutCalled = false;
    (remote as unknown as { client: { auth: { signOut: () => Promise<unknown> } }; user: { id: string } }).client = {
      auth: { signOut: async () => { signOutCalled = true; return { error: null }; } },
    };

    const resultPromise = resolveSignOutChoice("user-1", "wait");
    // Simula que el push confirmó de verdad: la outbox se vacía y SOLO
    // ENTONCES se notifica "saved" — el mismo orden que runPush() respeta.
    // flushPendingOrTimeout() escucha vía addStatusListener() (nunca
    // remote.onStatusChange, que es el canal exclusivo de la UI principal
    // — ver la corrección de revisión en data-layer.ts) — se dispara aquí
    // con el mismo método privado notifyStatus() que usa runPush() de verdad.
    outbox.deleteIfMatches("user-1", mutationId);
    (remote as unknown as { notifyStatus: (s: "syncing" | "saved" | "error") => void }).notifyStatus("saved");

    const result = await resultPromise;
    expect(result.status).toBe("signed_out");
    expect(result.cleanupOk).toBe(true); // discard() del envelope tuvo éxito (nada simulado que falle aquí)
    expect(signOutCalled).toBe(true);
  });

  it("'cancelar' nunca cierra sesión", async () => {
    let signOutCalled = false;
    (remote as unknown as { client: { auth: { signOut: () => Promise<unknown> } } }).client = {
      auth: { signOut: async () => { signOutCalled = true; return { error: null }; } },
    };
    const result = await resolveSignOutChoice("user-1", "cancel");
    expect(result.status).toBe("cancelled");
    expect(signOutCalled).toBe(false);
  });

  it("'salir y descartar' cierra sesión y borra el envelope completo, aunque el push nunca haya confirmado", async () => {
    outbox.recordMutation("user-1", { ...defaultState }, "tab-1");
    (remote as unknown as { client: { auth: { signOut: () => Promise<unknown> } }; user: { id: string } }).client = {
      auth: { signOut: async () => ({ error: null }) },
    };
    (remote as unknown as { user: { id: string } }).user = { id: "user-1" };

    const result = await resolveSignOutChoice("user-1", "discard");
    expect(result.status).toBe("signed_out");
    expect(result.cleanupOk).toBe(true);
    expect(outbox.readEnvelope("user-1")).toBeNull(); // logout confirmado o descarte explícito borra TODO
  });

  it("cleanupOk es false si discard() no pudo borrar el envelope de verdad — el caller (requestSignOut en state.tsx) puede avisar en vez de afirmar una limpieza que no ocurrió (corrección de revisión, P1, cuarta ronda)", async () => {
    outbox.recordMutation("user-1", { ...defaultState }, "tab-1");
    (remote as unknown as { client: { auth: { signOut: () => Promise<unknown> } }; user: { id: string } }).client = {
      auth: { signOut: async () => ({ error: null }) },
    };
    (remote as unknown as { user: { id: string } }).user = { id: "user-1" };

    const spy = vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new DOMException("blocked"); });
    const result = await resolveSignOutChoice("user-1", "discard");
    spy.mockRestore();

    expect(result.status).toBe("signed_out"); // la sesión SÍ se cierra igualmente (best effort)
    expect(result.cleanupOk).toBe(false); // pero la limpieza local no se pudo confirmar
  });

  it("REGRESIÓN (P1, sexta ronda): con auth.signOut() devolviendo error, resolveSignOutChoice() NUNCA devuelve 'signed_out' — expone 'sign_out_failed' y el envelope no se toca", async () => {
    const written = outbox.recordMutation("user-1", { ...defaultState, weeklyBudget: 42 }, "tab-1");
    const mutationId = (written as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId;
    const authError = { message: "network down" };
    (remote as unknown as { client: { auth: { signOut: () => Promise<unknown> } }; user: { id: string } | null }).client = {
      auth: { signOut: async () => ({ error: authError }) },
    };
    (remote as unknown as { user: { id: string } | null }).user = { id: "user-1" };
    outbox.deleteIfMatches("user-1", mutationId); // simula que el push ya había confirmado — sin pending, "discard" ya no espera nada

    const result = await resolveSignOutChoice("user-1", "discard");

    expect(result.status).toBe("sign_out_failed"); // NUNCA "signed_out" cuando Supabase no confirmó el cierre
    expect(result.authError).toEqual(authError);
    // El envelope NUNCA se tocó — remote.signOut() no limpia nada si auth.signOut() falla.
    expect(outbox.readEnvelope("user-1")?.state.weeklyBudget).toBe(42);
    // remote.user tampoco se puso a null — la sesión sigue activa.
    expect((remote as unknown as { user: { id: string } | null }).user).toEqual({ id: "user-1" });
  });

  it("reportCleanupIssue() solo avisa cuando cleanupOk es false — nunca duplica el mensaje de fallo remoto (ese lo gestiona 'sign_out_failed' aparte, con su propio texto)", () => {
    const messages: string[] = [];
    const showToast = (message: string) => messages.push(message);

    reportCleanupIssue(showToast, false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/datos locales/i);

    messages.length = 0;
    reportCleanupIssue(showToast, true);
    expect(messages).toHaveLength(0);
  });
});
