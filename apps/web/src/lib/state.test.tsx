import { describe, expect, it } from "vitest";
import type { CartItem, FoodOSState, InventoryItem, PhysicalProfile, Recipe } from "@foodos/types";
import { NUTRITION_ENGINE_VERSION } from "./nutrition";
import { actions, defaultState, getIngredientStatus, getRecipeMatch, hydrateRemoteState, normalizeState } from "./state";

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
// `remote.schedulePush(localLoaded)` antes de que pullState() resolviera —
// ninguno de los dos ejecuta de verdad la secuencia asíncrona real. Estos sí:
// hydrateRemoteState() (extraída de FoodOSProvider a state.tsx, con
// dependencias inyectables) se invoca con un pullState() controlado por una
// promesa diferida, para poder inspeccionar el estado de los espías
// mientras el pull está deliberadamente bloqueado — igual que ocurriría de
// verdad al arrancar con una conexión lenta.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("hydrateRemoteState — sin push del snapshot local antiguo durante la hidratación (reproducción de la carrera)", () => {
  it("mientras pullState() está pendiente no se llama a schedulePush ni a saveLocalState; al resolver con un perfil remoto más reciente y motor antiguo, se llama a schedulePush UNA sola vez con un snapshot que conserva todos los datos remotos, y solo transiciona sello+calibración cuando corresponde", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: FoodOSState[] = [];
    const saveLocalStateCalls: FoodOSState[] = [];
    let ensureBaseRowsCalled = false;

    // "Perfil local antiguo" cargado justo antes de esta hidratación —
    // hydrateRemoteState() no lo recibe como parámetro en absoluto (no
    // puede empujarlo por error), pero lo dejamos preparado para
    // documentar el escenario exacto que describe la revisión.
    const localOld = physicalProfile({
      weightKg: 90, goal: "fat_loss", adaptiveKcalOffsetKcal: -50,
      adaptiveCalibrationStartedAt: "2026-01-01",
    });
    void localOld;

    const hydratePromise = hydrateRemoteState(defaultState, {
      ensureBaseRows: async () => { ensureBaseRowsCalled = true; },
      pullState: () => pull.promise,
      saveLocalState: (s) => saveLocalStateCalls.push(s),
      schedulePush: (s) => schedulePushCalls.push(s),
      isCancelled: () => false,
    });

    // El pull todavía no resolvió — deja que las microtasks previas al
    // await de pullState() se asienten (ensureBaseRows) sin avanzar más.
    await Promise.resolve();
    await Promise.resolve();
    expect(ensureBaseRowsCalled).toBe(true);
    expect(schedulePushCalls).toHaveLength(0);
    expect(saveLocalStateCalls).toHaveLength(0);

    // Ahora resuelve el pull: perfil remoto más reciente/distinto del
    // local, motor antiguo (sin lastCalculationEngineVersion), cardio
    // legacy (cardioDaysPerWeek > 0 sin tipo/intensidad) → SÍ afectado.
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

    expect(saveLocalStateCalls).toHaveLength(1);
    expect(schedulePushCalls).toHaveLength(1);
    const pushed = schedulePushCalls[0];

    // El snapshot empujado conserva TODOS los datos remotos — nada del
    // perfil local (peso 90, fat_loss, offset -50) se filtra, porque
    // hydrateRemoteState() nunca tuvo acceso a él.
    expect(pushed.profile!.weightKg).toBe(85);
    expect(pushed.profile!.goal).toBe("recomp");
    expect(pushed.profile!.adaptiveKcalOffsetKcal).toBe(120);
    expect(pushed.profile!.trainingActivity).toEqual(remoteProfile.trainingActivity);

    // Único cambio real: el sello de versión (siempre) y el reinicio de
    // calibración (porque este perfil SÍ está afectado por el cambio de
    // fórmula de cardio legacy).
    expect(pushed.profile!.lastCalculationEngineVersion).toBe(NUTRITION_ENGINE_VERSION);
    expect(pushed.profile!.adaptiveCalibrationStartedAt).not.toBe("2026-02-15");
    expect(pushed.profile!.adaptiveCalibrationStartedAt).not.toBe("2026-01-01"); // tampoco el del local

    expect(result).toBe(pushed); // hydrateRemoteState() devuelve exactamente lo empujado
  });

  it("perfil remoto NO afectado (legacy_total_pal): sella la versión (schedulePush SÍ se llama, hay algo nuevo que guardar), pero NO reinicia la calibración", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: FoodOSState[] = [];

    const hydratePromise = hydrateRemoteState(defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      saveLocalState: () => {},
      schedulePush: (s) => schedulePushCalls.push(s),
      isCancelled: () => false,
    });

    pull.resolve({
      ...defaultState,
      profile: physicalProfile({ activityModelVersion: "legacy_total_pal", adaptiveCalibrationStartedAt: "2026-01-10" }),
    });
    await hydratePromise;

    expect(schedulePushCalls).toHaveLength(1);
    expect(schedulePushCalls[0].profile!.lastCalculationEngineVersion).toBe(NUTRITION_ENGINE_VERSION);
    expect(schedulePushCalls[0].profile!.adaptiveCalibrationStartedAt).toBe("2026-01-10"); // sin tocar
  });

  it("perfil remoto YA al día: no llama a schedulePush en absoluto (hydrate normal, puramente de lectura)", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: FoodOSState[] = [];

    const hydratePromise = hydrateRemoteState(defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      saveLocalState: () => {},
      schedulePush: (s) => schedulePushCalls.push(s),
      isCancelled: () => false,
    });

    pull.resolve({
      ...defaultState,
      profile: physicalProfile({ lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION, weightKg: 82 }),
    });
    const result = await hydratePromise;

    expect(schedulePushCalls).toHaveLength(0);
    expect(result!.profile!.weightKg).toBe(82);
  });

  it("cancelado mientras el pull estaba en vuelo: devuelve null y no llama a saveLocalState ni a schedulePush, aunque el pull acabe resolviendo", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: FoodOSState[] = [];
    const saveLocalStateCalls: FoodOSState[] = [];
    let cancelled = false;

    const hydratePromise = hydrateRemoteState(defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      saveLocalState: (s) => saveLocalStateCalls.push(s),
      schedulePush: (s) => schedulePushCalls.push(s),
      isCancelled: () => cancelled,
    });

    cancelled = true; // p.ej. el componente se desmontó mientras el pull seguía en vuelo
    pull.resolve({ ...defaultState, profile: physicalProfile({ weightKg: 99 }) });

    const result = await hydratePromise;
    expect(result).toBeNull();
    expect(saveLocalStateCalls).toHaveLength(0);
    expect(schedulePushCalls).toHaveLength(0);
  });
});
