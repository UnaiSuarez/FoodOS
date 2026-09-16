import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CartItem, FoodOSState, InventoryItem, PhysicalProfile, Recipe } from "@foodos/types";
import { remote } from "./data-layer";
import { NUTRITION_ENGINE_VERSION } from "./nutrition";
import * as outbox from "./outbox";
import {
  actions,
  applyWaterTarget,
  availableForIngredient,
  canAcceptRemoteMutations,
  classifyAuthTransition,
  computeSyncStatus,
  countLowProteinDays,
  countUpcomingMealPlanUsages,
  defaultState,
  flushPendingOrTimeout,
  getFoodSpend,
  getIngredientStatus,
  getMealPlanShoppingList,
  getRecipeMatch,
  type HydrationScope,
  normalizeState,
  recordTodayNutritionGoal,
  removeCustomRecipeFromDraft,
  reportCleanupIssue,
  resolveHydrationUiMode,
  resolveInitialStateForSession,
  resolveSignOutChoice,
  runHydrationAttempt,
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

// ─── PR A: recordTodayNutritionGoal — separación estricta de normalizeState ──

describe("recordTodayNutritionGoal / normalizeState — separación (PR A, punto 1)", () => {
  it("normalizeState() NUNCA añade la entrada de hoy, aunque el perfil esté completo y no exista ninguna entrada previa", () => {
    const state: FoodOSState = { ...defaultState, profile: physicalProfile(), debugDate: "2026-09-10" };
    const normalized = normalizeState(state);
    expect(normalized.nutritionGoalsHistory).toEqual({});
  });

  it("recordTodayNutritionGoal() sin perfil devuelve la MISMA referencia (no-op)", () => {
    const state: FoodOSState = { ...defaultState, profile: null };
    expect(recordTodayNutritionGoal(state)).toBe(state);
  });

  it("recordTodayNutritionGoal() con perfil añade la entrada de hoy, con calculationVersion = NUTRITION_ENGINE_VERSION", () => {
    const state: FoodOSState = { ...defaultState, profile: physicalProfile(), debugDate: "2026-09-10" };
    const result = recordTodayNutritionGoal(state, () => "2026-09-10T08:00:00.000Z");
    expect(result).not.toBe(state);
    const entry = result.nutritionGoalsHistory["2026-09-10"];
    expect(entry).toBeDefined();
    expect(entry.calculationVersion).toBe(NUTRITION_ENGINE_VERSION);
    expect(entry.mode).toBe("maintain"); // physicalProfile() por defecto
    expect(entry.recordedAt).toBe("2026-09-10T08:00:00.000Z");
  });

  it("recordTodayNutritionGoal() es idempotente: una segunda llamada con el MISMO perfil devuelve la MISMA referencia (no crea una entrada distinta, no dispara push)", () => {
    const state: FoodOSState = { ...defaultState, profile: physicalProfile(), debugDate: "2026-09-10" };
    const once = recordTodayNutritionGoal(state);
    const twice = recordTodayNutritionGoal(once);
    expect(twice).toBe(once);
  });

  it("recordTodayNutritionGoal() nunca toca una fecha ya pasada del ledger", () => {
    const state: FoodOSState = {
      ...defaultState,
      profile: physicalProfile(),
      debugDate: "2026-09-10",
      nutritionGoalsHistory: {
        "2026-09-01": { kcal: 1800, protein: 130, carbs: 180, fat: 55, mode: "fat_loss", calculationVersion: "nutrition-v1", recordedAt: null },
      },
    };
    const result = recordTodayNutritionGoal(state);
    expect(result.nutritionGoalsHistory["2026-09-01"]).toEqual(state.nutritionGoalsHistory["2026-09-01"]);
  });

  it("recordTodayNutritionGoal() actualiza la entrada de hoy si el perfil cambió respecto a la ya registrada (no es un no-op)", () => {
    const state: FoodOSState = { ...defaultState, profile: physicalProfile({ weightKg: 70 }), debugDate: "2026-09-10" };
    const first = recordTodayNutritionGoal(state);
    const changed: FoodOSState = { ...first, profile: physicalProfile({ weightKg: 95, goal: "muscle_gain" }) };
    const second = recordTodayNutritionGoal(changed);
    expect(second).not.toBe(changed);
    expect(second.nutritionGoalsHistory["2026-09-10"].mode).toBe("muscle_gain");
  });
});

// ─── Reproducción EJECUTABLE de la carrera asíncrona (corrección de revisión) ──
// createHydrationCoordinator() (con su Map interno de promesas en vuelo)
// desapareció en el diseño v5: la deduplicación por identidad de sesión
// ahora vive en FoodOSProvider (attemptRef/generación — ver
// state.tsx/requestHydration/replaceHydration), no en esta función pura.
// runHydrationAttempt() ejecuta SIEMPRE de principio a fin — su cobertura
// aquí es sobre el CONTRATO de un intento (HydrateOutcome) y la lógica de
// negocio (ledger, pendiente local, transición de motor); la deduplicación
// real entre llamadas concurrentes, el ownership del AbortController y el
// backoff se prueban en el test del provider real (ver
// foodos-provider.test.tsx, jsdom). deps.schedulePush recibe un PendingPush
// completo (userId/epoch/mutationId/revision/state), no un FoodOSState
// pelado.
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

describe("runHydrationAttempt — sin push del snapshot local antiguo durante la hidratación (reproducción de la carrera)", () => {
  it("mientras pullState() está pendiente no se llama a schedulePush; al resolver con un perfil remoto más reciente y motor antiguo, se llama a schedulePush UNA sola vez con un snapshot que conserva todos los datos remotos, y solo transiciona sello+calibración cuando corresponde", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: Array<{ userId: string; epoch: number; mutationId: string; revision: number; state: FoodOSState }> = [];
    let ensureBaseRowsCalled = false;

    // "Perfil local antiguo" en OTRO usuario — documenta que la outbox del
    // usuario que se está hidratando (TEST_USER) empieza vacía; el intento
    // no tiene forma de ver datos de otro usuario en absoluto.
    void physicalProfile({ weightKg: 90, goal: "fat_loss", adaptiveKcalOffsetKcal: -50 });

    const outcomePromise = runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => { ensureBaseRowsCalled = true; },
      pullState: () => pull.promise,
      schedulePush: (op) => schedulePushCalls.push(op),
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

    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("applied");

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

    expect(outcome.kind === "applied" && outcome.state).toEqual(pushed.state);

    // La outbox real quedó escrita con exactamente ese mutationId — es lo
    // que runPush() usará para el compare-and-delete al confirmar.
    const envelope = outbox.readEnvelope(TEST_USER);
    expect(envelope?.pending?.mutationId).toBe(pushed.mutationId);
  });

  it("perfil remoto NO afectado (legacy_total_pal): sella la versión (schedulePush SÍ se llama, hay algo nuevo que guardar), pero NO reinicia la calibración", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: Array<{ state: FoodOSState }> = [];

    const outcomePromise = runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      schedulePush: (op) => schedulePushCalls.push(op),
      waitForMutationConfirmed: async () => "confirmed",
    });

    pull.resolve({
      ...defaultState,
      profile: physicalProfile({ activityModelVersion: "legacy_total_pal", adaptiveCalibrationStartedAt: "2026-01-10" }),
    });
    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("applied");

    expect(schedulePushCalls).toHaveLength(1);
    expect(schedulePushCalls[0].state.profile!.lastCalculationEngineVersion).toBe(NUTRITION_ENGINE_VERSION);
    expect(schedulePushCalls[0].state.profile!.adaptiveCalibrationStartedAt).toBe("2026-01-10"); // sin tocar
  });

  it("perfil remoto YA al día (motor): la primera hidratación registra el objetivo de hoy (PR A) — una segunda hidratación con el mismo perfil ya no empuja nada", async () => {
    // PR A: sin transición de motor pendiente, la ÚNICA razón para empujar
    // en la primera hidratación es registrar por primera vez el objetivo
    // de hoy en el ledger — exactamente la escritura durable que pide el
    // diseño ("primer arranque del día crea una sola escritura"). Una
    // segunda hidratación con el MISMO perfil no produce una entrada
    // distinta ⇒ cero escrituras adicionales ("segunda recarga con entrada
    // idéntica").
    const remoteProfile = physicalProfile({ lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION, weightKg: 82 });

    const pull1 = deferred<FoodOSState>();
    const schedulePushCalls1: unknown[] = [];
    const outcomePromise1 = runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull1.promise,
      schedulePush: (op) => schedulePushCalls1.push(op),
      waitForMutationConfirmed: async () => "confirmed",
    });
    pull1.resolve({ ...defaultState, profile: remoteProfile });
    const outcome1 = await outcomePromise1;
    expect(outcome1.kind).toBe("applied");

    expect(schedulePushCalls1).toHaveLength(1);
    expect(outcome1.kind === "applied" && outcome1.state.profile!.weightKg).toBe(82);

    // Simula que el push de la primera hidratación SE CONFIRMÓ de verdad
    // (compare-and-delete real, no solo el mock de waitForMutationConfirmed
    // que no toca la outbox) — sin esto, la segunda hidratación vería
    // `pending` todavía puesto y reintentaría por esa razón, ajena al ledger.
    const mutationId1 = (schedulePushCalls1[0] as { mutationId: string }).mutationId;
    expect(outbox.deleteIfMatches(TEST_USER, mutationId1)).toBe(true);

    const pull2 = deferred<FoodOSState>();
    const schedulePushCalls2: unknown[] = [];
    const outcomePromise2 = runHydrationAttempt(TEST_USER, 1, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull2.promise,
      schedulePush: (op) => schedulePushCalls2.push(op),
      waitForMutationConfirmed: async () => "confirmed",
    });
    pull2.resolve({ ...defaultState, profile: remoteProfile });
    const outcome2 = await outcomePromise2;
    expect(outcome2.kind).toBe("applied");

    expect(schedulePushCalls2).toHaveLength(0);
    expect(outcome2.kind === "applied" && outcome2.state.profile!.weightKg).toBe(82);
  });

  it("[ronda 3, punto 2] tras registrar el objetivo de hoy, el envelope queda con `pending` — listo para el mecanismo de reintento genérico ya existente (no se inventa uno nuevo)", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: Array<{ mutationId: string }> = [];
    const outcomePromise = runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      schedulePush: (op) => schedulePushCalls.push(op),
      waitForMutationConfirmed: async () => "confirmed",
    });
    pull.resolve({ ...defaultState, profile: physicalProfile({ lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION }) });
    await outcomePromise;

    expect(schedulePushCalls).toHaveLength(1);
    // El reintento en sí (temporizador, backoff) es el mecanismo YA
    // existente de remote.schedulePush()/runPush() (ver data-layer.test.ts,
    // "no marca guardado en error y reintenta") — aquí solo se prueba que
    // esta escritura entra correctamente en él (envelope con `pending`
    // apuntando exactamente a la mutación programada).
    const envelope = outbox.readEnvelope(TEST_USER);
    expect(envelope?.pending?.mutationId).toBe(schedulePushCalls[0].mutationId);
  });

  it("[ronda 3, punto 3] aislamiento por cuenta: el ledger de A nunca aparece en la hidratación de B, ni se persiste ni se empuja desde B; al volver a A reaparece el suyo desde su propia clave local", async () => {
    const userA = "user-A-aislamiento";
    const userB = "user-B-aislamiento";
    // lastCalculationEngineVersion ya al día en ambos perfiles: la única
    // razón de empujar en la primera hidratación debe ser la población del
    // ledger (PR A), no una transición de motor no relacionada con este test.
    const profileA = physicalProfile({ weightKg: 70, goal: "fat_loss", lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION });
    const profileB = physicalProfile({ weightKg: 95, goal: "muscle_gain", lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION });

    // A hidrata primero — su ledger queda escrito bajo la clave de outbox de A.
    const pullA = deferred<FoodOSState>();
    const pushA: unknown[] = [];
    const outcomeAPromise = runHydrationAttempt(userA, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {}, pullState: () => pullA.promise, schedulePush: (op) => pushA.push(op),
      waitForMutationConfirmed: async () => "confirmed",
    });
    pullA.resolve({ ...defaultState, profile: profileA });
    const outcomeA = await outcomeAPromise;
    expect(outcomeA.kind).toBe("applied");
    const resultA = outcomeA.kind === "applied" ? outcomeA.state : null;
    const ledgerAKeys = Object.keys(resultA!.nutritionGoalsHistory);
    expect(ledgerAKeys).toHaveLength(1);
    const ledgerAEntry = resultA!.nutritionGoalsHistory[ledgerAKeys[0]];

    // B hidrata — usuario DISTINTO, cuya clave de outbox nunca se ha
    // tocado. El intento no tiene forma de ver el ledger de A.
    const pullB = deferred<FoodOSState>();
    const pushB: unknown[] = [];
    const outcomeBPromise = runHydrationAttempt(userB, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {}, pullState: () => pullB.promise, schedulePush: (op) => pushB.push(op),
      waitForMutationConfirmed: async () => "confirmed",
    });
    pullB.resolve({ ...defaultState, profile: profileB });
    const outcomeB = await outcomeBPromise;
    expect(outcomeB.kind).toBe("applied");
    const resultB = outcomeB.kind === "applied" ? outcomeB.state : null;
    const ledgerBKeys = Object.keys(resultB!.nutritionGoalsHistory);
    expect(ledgerBKeys).toHaveLength(1);
    const ledgerBEntry = resultB!.nutritionGoalsHistory[ledgerBKeys[0]];

    // B nunca ve la entrada de A (ni siquiera coincide por valor: perfiles
    // distintos ⇒ targets distintos).
    expect(ledgerBEntry).not.toEqual(ledgerAEntry);

    // El envelope de A en disco sigue intacto — B no lo tocó ni lo pisó.
    const envelopeA = outbox.readEnvelope(userA);
    expect(envelopeA?.state.nutritionGoalsHistory).toEqual(resultA!.nutritionGoalsHistory);
    // Tampoco se persistió ni se empujó nada de B bajo la clave de A.
    expect(envelopeA?.state.profile?.weightKg).toBe(70);

    // Simula que el push de A se confirmó de verdad (compare-and-delete
    // real) antes de la segunda hidratación — igual que en el test de
    // "perfil remoto ya al día", sin esto el mock de
    // waitForMutationConfirmed no limpia `pending` y la segunda
    // hidratación reintentaría por esa razón, ajena al ledger.
    expect(pushA).toHaveLength(1);
    const mutationIdA = (pushA[0] as { mutationId: string }).mutationId;
    expect(outbox.deleteIfMatches(userA, mutationIdA)).toBe(true);

    // Volver a A: reaparece SU propio ledger desde SU propia clave — no
    // algo mezclado con B, y como nada cambió, ya no hace falta empujar.
    const pullA2 = deferred<FoodOSState>();
    const pushA2: unknown[] = [];
    const outcomeA2Promise = runHydrationAttempt(userA, 1, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {}, pullState: () => pullA2.promise, schedulePush: (op) => pushA2.push(op),
      waitForMutationConfirmed: async () => "confirmed",
    });
    pullA2.resolve({ ...defaultState, profile: profileA });
    const outcomeA2 = await outcomeA2Promise;
    expect(outcomeA2.kind).toBe("applied");

    expect(outcomeA2.kind === "applied" && outcomeA2.state.nutritionGoalsHistory).toEqual(resultA!.nutritionGoalsHistory);
    expect(pushA2).toHaveLength(0);
  });

  it("signal.aborted mientras el pull estaba en vuelo: devuelve {kind:\"stale-session\"} y no llama a schedulePush, aunque el pull acabe resolviendo (clasificación por signal, diseño v5 §2)", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: unknown[] = [];
    const controller = new AbortController();

    const outcomePromise = runHydrationAttempt(TEST_USER, 0, controller.signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      schedulePush: (op) => schedulePushCalls.push(op),
      waitForMutationConfirmed: async () => "confirmed",
    });

    controller.abort(); // p.ej. sustituido por una generación nueva mientras el pull seguía en vuelo
    pull.resolve({ ...defaultState, profile: physicalProfile({ weightKg: 99 }) });

    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: "stale-session" });
    expect(schedulePushCalls).toHaveLength(0);
    expect(outbox.readEnvelope(TEST_USER)).toBeNull(); // tampoco se escribió nada
  });

  it("una excepción inesperada de pullState() se clasifica como {kind:\"failed\"} (nunca lanza — corrección §1: contrato inequívoco, sin rejection sin manejar)", async () => {
    const outcome = await runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => { throw new Error("fallo de red simulado"); },
      schedulePush: () => {},
      waitForMutationConfirmed: async () => "confirmed",
    });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && (outcome.error as Error).message).toBe("fallo de red simulado");
  });

  it("hay un pendiente local ANTES de pedir a Supabase que confirma a tiempo: sigue adelante y pide el pull (gana `confirmed`, no `deferred`)", async () => {
    const written = outbox.recordMutation(TEST_USER, { ...defaultState, weeklyBudget: 555 }, "tab-1");
    expect(written.ok).toBe(true);
    const mutationId = (written as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId;
    const schedulePushCalls: Array<{ mutationId: string }> = [];

    const outcome = await runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => ({ ...defaultState, weeklyBudget: 111 }),
      schedulePush: (op) => schedulePushCalls.push(op),
      // "confirmed" de verdad significa que el compare-and-delete YA
      // ocurrió (lo hace runPush() en producción) — el mock lo simula
      // explícitamente; si no lo hiciera, envelopeAfter seguiría viendo el
      // mismo pending y esto degradaría a "deferred" (ver el siguiente test).
      waitForMutationConfirmed: async () => { outbox.deleteIfMatches(TEST_USER, mutationId); return "confirmed"; },
    });

    expect(outcome.kind).toBe("applied");
    expect(outcome.kind === "applied" && outcome.state.weeklyBudget).toBe(111); // el remoto SÍ se aplicó — el pendiente original ya se había confirmado
    // Un único schedulePush: el reenvío INCONDICIONAL del pendiente
    // original al detectarlo (antes de esperar su confirmación) — sin
    // perfil (defaultState.profile es null) no hay objetivo de hoy que
    // registrar ni transición de motor, así que nada más se empuja tras
    // aplicar el remoto.
    expect(schedulePushCalls).toHaveLength(1);
    expect(schedulePushCalls[0].mutationId).toBe(mutationId);
  });

  it("hay un pendiente local que NUNCA confirma (timeout de waitForMutationConfirmed): {kind:\"deferred\", reason:\"pending-timeout\"} — el remoto NUNCA se aplica a la UI mientras haya algo local sin resolver (política documentada, no es fusión real)", async () => {
    const written = outbox.recordMutation(TEST_USER, { ...defaultState, weeklyBudget: 555 }, "tab-1");
    expect(written.ok).toBe(true);
    const schedulePushCalls: Array<{ mutationId: string }> = [];
    let pullCalled = false;

    const outcome = await runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => { pullCalled = true; return { ...defaultState, weeklyBudget: 111 }; },
      schedulePush: (op) => schedulePushCalls.push(op),
      waitForMutationConfirmed: async () => "timeout",
    });

    expect(outcome).toEqual({ kind: "deferred", reason: "pending-timeout" });
    expect(pullCalled).toBe(false); // ni siquiera se pide el pull — se descartaría igualmente
    expect(schedulePushCalls).toHaveLength(1);
    expect(schedulePushCalls[0].mutationId).toBe((written as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId);
  });

  it("una mutación NUEVA sustituye a la que se estaba esperando (superseded): {kind:\"deferred\", reason:\"pending-superseded\"}, sin pedir el pull", async () => {
    outbox.recordMutation(TEST_USER, { ...defaultState, weeklyBudget: 555 }, "tab-1");

    const outcome = await runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => ({ ...defaultState, weeklyBudget: 111 }),
      schedulePush: () => {},
      waitForMutationConfirmed: async () => "superseded",
    });

    expect(outcome).toEqual({ kind: "deferred", reason: "pending-superseded" });
  });

  it("aparece un pendiente NUEVO mientras el pull SÍ estaba en vuelo: {kind:\"deferred\", reason:\"pending-superseded\"} — gana el local, el remoto se descarta para esta UI", async () => {
    const pull = deferred<FoodOSState>();
    const schedulePushCalls: Array<{ mutationId: string }> = [];

    const outcomePromise = runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: () => pull.promise,
      schedulePush: (op) => schedulePushCalls.push(op),
      waitForMutationConfirmed: async () => "confirmed",
    });

    // Dos microtasks: una para que se asiente el `await ensureBaseRows()`,
    // otra para que el código llegue a comprobar `envelopeBefore` (vacío) y
    // quede realmente suspendido dentro de `await pullState()` — sin esto,
    // el recordMutation de abajo se ejecutaría ANTES de que
    // runHydrationAttempt() hubiera llegado siquiera a mirar la outbox por
    // primera vez (ambas líneas comparten el mismo tick sin este `await`),
    // y el escenario dejaría de ser "aparece MIENTRAS el pull está en
    // vuelo" para convertirse en "ya estaba antes de empezar".
    await Promise.resolve();
    await Promise.resolve();

    // Mientras el pull está en vuelo, el usuario edita algo — la outbox
    // recibe un pending NUEVO que runHydrationAttempt() no podía conocer
    // al empezar.
    const written = outbox.recordMutation(TEST_USER, { ...defaultState, weeklyBudget: 999 }, "tab-1");
    expect(written.ok).toBe(true);

    pull.resolve({ ...defaultState, weeklyBudget: 111 });
    const outcome = await outcomePromise;

    expect(outcome).toEqual({ kind: "deferred", reason: "pending-superseded" });
    expect(schedulePushCalls).toHaveLength(1);
    expect(schedulePushCalls[0].mutationId).toBe((written as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId);
  });
});

describe("canAcceptRemoteMutations / resolveHydrationUiMode — derivación única del gate y del modo de UI (diseño v5)", () => {
  const base: HydrationScope = { userId: TEST_USER, epoch: 0, generation: 1, phase: "loading", hasLocalBaseline: false };

  // Corrección de revisión (bloqueante P1, "política contradictoria con
  // baseline"): antes canAcceptRemoteMutations() exigía phase==="ready" sin
  // excepción, mientras resolveHydrationUiMode() YA mostraba un dashboard
  // editable con baseline en loading/error — dos políticas distintas para
  // la misma pantalla. Ahora es una única decisión: canAcceptRemoteMutations
  // === (resolveHydrationUiMode() === "dashboard"), sin excepción.
  // hasSupabaseConfig() lee process.env UNA vez al cargar el módulo — en
  // este proceso de test nunca hay NEXT_PUBLIC_SUPABASE_URL/ANON_KEY
  // definidas, así que aquí siempre se comporta como "modo local puro". El
  // caso complementario (scope null CON Supabase configurado — p.ej. justo
  // tras un logout, donde debe dar FALSE) se prueba en
  // foodos-provider.test.tsx, que sí mockea hasSupabaseConfig()===true.
  it("canAcceptRemoteMutations: null en modo local puro (sin Supabase configurado) siempre true — se hereda el mismo dashboard editable de siempre", () => {
    expect(canAcceptRemoteMutations(null)).toBe(true);
  });

  it("canAcceptRemoteMutations: CON baseline, true también en loading/error — mismo comportamiento offline ya aceptado en el resto de la app", () => {
    expect(canAcceptRemoteMutations({ ...base, hasLocalBaseline: true, phase: "loading" })).toBe(true);
    expect(canAcceptRemoteMutations({ ...base, hasLocalBaseline: true, phase: "error" })).toBe(true);
    expect(canAcceptRemoteMutations({ ...base, hasLocalBaseline: true, phase: "ready" })).toBe(true);
  });

  it("canAcceptRemoteMutations: SIN baseline, false en loading/error (recovery-screen: ni el dashboard se muestra) — true en cuanto llega a ready", () => {
    expect(canAcceptRemoteMutations({ ...base, hasLocalBaseline: false, phase: "loading" })).toBe(false);
    expect(canAcceptRemoteMutations({ ...base, hasLocalBaseline: false, phase: "error" })).toBe(false);
    expect(canAcceptRemoteMutations({ ...base, hasLocalBaseline: false, phase: "ready" })).toBe(true);
  });

  it("resolveHydrationUiMode: sin scope (local puro o sesión aún sin empezar) siempre dashboard", () => {
    expect(resolveHydrationUiMode(null)).toBe("dashboard");
  });

  it("resolveHydrationUiMode: con hasLocalBaseline, dashboard SIEMPRE — incluso en loading o error", () => {
    expect(resolveHydrationUiMode({ ...base, hasLocalBaseline: true, phase: "loading" })).toBe("dashboard");
    expect(resolveHydrationUiMode({ ...base, hasLocalBaseline: true, phase: "error" })).toBe("dashboard");
    expect(resolveHydrationUiMode({ ...base, hasLocalBaseline: true, phase: "ready" })).toBe("dashboard");
  });

  it("resolveHydrationUiMode: sin baseline, recovery-screen en loading Y en error — nunca un loading distinto sin controles (§5)", () => {
    expect(resolveHydrationUiMode({ ...base, hasLocalBaseline: false, phase: "loading" })).toBe("recovery-screen");
    expect(resolveHydrationUiMode({ ...base, hasLocalBaseline: false, phase: "error" })).toBe("recovery-screen");
  });

  it("resolveHydrationUiMode: sin baseline pero ya ready, dashboard", () => {
    expect(resolveHydrationUiMode({ ...base, hasLocalBaseline: false, phase: "ready" })).toBe("dashboard");
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
    // servidor) — runHydrationAttempt() reprograma su reenvío y descarta el
    // pull para la UI mientras siga habiendo un pendiente.
    const scheduled: Array<{ mutationId: string; state: FoodOSState }> = [];
    const outcome = await runHydrationAttempt(TEST_USER, 0, new AbortController().signal, defaultState, {
      ensureBaseRows: async () => {},
      pullState: async () => ({ ...defaultState, weeklyBudget: 111 }), // "remoto antiguo" — nunca debe llegar a la UI
      schedulePush: (op) => scheduled.push(op),
      waitForMutationConfirmed: async () => "timeout", // el push sigue reintentando en segundo plano; esta hidratación no bloquea
    });
    expect(outcome).toEqual({ kind: "deferred", reason: "pending-timeout" }); // el remoto antiguo NUNCA se aplicó a la UI
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
  const base = { hasSupabaseConfig: true, isOnline: true, hadUnsyncedEnvelopeWrite: false, hadUnsyncedWaterWrite: false, pushStatus: "saved" as const, hydrationError: false };

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

  // Corrección de revisión (bloqueante P0, "el badge todavía puede decir
  // 'Guardado'"): antes computeSyncStatus() ni siquiera recibía
  // hydrationScope — un fallo de pullState() podía quedar completamente
  // oculto detrás de un push "saved", que es exactamente el bug original
  // que motivó todo este diseño.
  it("un error de hidratación con el push en 'saved' produce 'hydration-error' — NUNCA 'saved'", () => {
    expect(computeSyncStatus({ ...base, pushStatus: "saved", hydrationError: true })).toBe("hydration-error");
  });

  it("un error de hidratación con el push 'syncing' también produce 'hydration-error' (nunca 'syncing')", () => {
    expect(computeSyncStatus({ ...base, pushStatus: "syncing", hydrationError: true })).toBe("hydration-error");
  });

  it("precedencia acordada: unsynced > error de push > hydration-error > syncing/saved", () => {
    // unsynced gana a un error de hidratación.
    expect(computeSyncStatus({ ...base, hadUnsyncedEnvelopeWrite: true, pushStatus: "saved", hydrationError: true })).toBe("unsynced");
    // Un error de PUSH real gana a un error de hidratación.
    expect(computeSyncStatus({ ...base, pushStatus: "error", hydrationError: true })).toBe("error");
    // offline gana a todo lo demás, incluido un error de hidratación.
    expect(computeSyncStatus({ ...base, isOnline: false, pushStatus: "saved", hydrationError: true })).toBe("offline");
    // Sin ningún error de push/unsynced/offline, el error de hidratación sí se ve.
    expect(computeSyncStatus({ ...base, pushStatus: "saved", hydrationError: true })).toBe("hydration-error");
    // Y cuando hydrationError es false, el pushStatus real vuelve a mandar.
    expect(computeSyncStatus({ ...base, pushStatus: "saved", hydrationError: false })).toBe("saved");
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
    expect(computeSyncStatus({ hasSupabaseConfig: true, isOnline: true, ...afterTransition, pushStatus: "saved", hydrationError: false })).toBe("saved"); // B no aparece "unsynced" sin haber fallado nada él
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

// ── Auditoría 2026-09: ventanas de tiempo en selectores de dominio ─────────
describe("countLowProteinDays — los días sin registro no cuentan (auditoría 2026-09)", () => {
  it("una cuenta sin diario no muestra '3/3 días de baja proteína'", () => {
    const state = structuredClone(defaultState);
    state.nutrition.protein = 150;
    expect(countLowProteinDays(state)).toBe(0);
  });

  it("sí cuenta un día CON registro que se queda por debajo del 80% del objetivo", () => {
    const state = structuredClone(defaultState);
    state.nutrition.protein = 150;
    state.debugDate = "2026-01-10";
    state.foodLog.push({
      id: "e1", date: "2026-01-09", time: "12:00", name: "Comida floja",
      qty: null, unit: null, kcal: 400, protein: 20, carbs: 10, fat: 10,
      source: "manual", mealType: "lunch",
    });
    expect(countLowProteinDays(state)).toBe(1);
  });
});

describe("getFoodSpend — ventana de 7 días de calendario exactos (auditoría 2026-09)", () => {
  it("incluye hoy-6 y excluye hoy-7 (antes contaba 8 días)", () => {
    const state = structuredClone(defaultState);
    state.debugDate = "2026-01-10";
    state.expenses = [
      { id: "a", type: "expense", amount: 10, category: "Comida", description: "", date: "2026-01-04" }, // hoy-6 → dentro
      { id: "b", type: "expense", amount: 99, category: "Comida", description: "", date: "2026-01-03" }, // hoy-7 → fuera
    ];
    expect(getFoodSpend(state)).toBe(10);
  });
});

// ── Auditoría 2026-09: unidades y ventanas de tiempo en selectores de dominio ──
// Los descuentos/faltantes de inventario comparaban la cantidad de la receta
// (p.ej. "200 g") contra la qty CRUDA de cada lote sin convertir su unidad —
// un lote de "1 kg" contaba como "1". hasEnoughForIngredient ya convertía con
// toGrams desde E08-06; estos tests fijan que el resto de rutas (cocinar,
// listas de la compra del plan) usan la misma conversión.

describe("cookRecipe — descuento FIFO consciente de unidades (auditoría 2026-09)", () => {
  it("cocinar 200 g descuenta 0.2 de un lote de 1 kg, no el kilo entero", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [inv({ id: "kg-lot", name: "Arroz", qty: 1, unit: "kg" })];
    const r = recipe([{ name: "Arroz", quantity: 200, unit: "g" }]);
    actions.cookRecipe(draft, r, 1, { deductIngredients: true });
    expect(draft.inventory).toHaveLength(1);
    expect(draft.inventory[0].qty).toBeCloseTo(0.8, 2);
    const entry = draft.foodLog[draft.foodLog.length - 1];
    expect(entry.consumedIngredients).toEqual([
      expect.objectContaining({ qty: 0.2, unit: "kg" }),
    ]);
  });

  it("se comporta igual que siempre cuando receta y lote comparten unidad", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [inv({ id: "g-lot", name: "Pollo", qty: 500, unit: "g" })];
    const r = recipe([{ name: "Pollo", quantity: 200, unit: "g" }]);
    actions.cookRecipe(draft, r, 1, { deductIngredients: true });
    expect(draft.inventory[0].qty).toBe(300);
  });

  it("con lotes 'ud' usa unitSize + unitSizeUnit para convertir (2 ud de 125 g cubren 250 g)", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [inv({ id: "ud-lot", name: "Yogur", qty: 2, unit: "ud", unitSize: 125, unitSizeUnit: "g" })];
    const r = recipe([{ name: "Yogur", quantity: 250, unit: "g" }]);
    actions.cookRecipe(draft, r, 1, { deductIngredients: true });
    expect(draft.inventory).toHaveLength(0); // 250 g = las 2 ud completas
  });

  // Ronda de corrección: unitSize sin unitSizeUnit no dice si es masa o
  // volumen — antes "ud" cruzaba a cualquiera de las dos con el mismo
  // número. Estos tres casos fijan que ahora eso es imposible.
  it("con lotes 'ud' líquidos (unitSizeUnit: 'ml') cubre un ingrediente en ml, pero NUNCA en g", () => {
    const draftMl = structuredClone(defaultState);
    // 2 latas de 250 ml = 500 ml disponibles.
    draftMl.inventory = [inv({ id: "ud-lata", name: "Refresco", qty: 2, unit: "ud", unitSize: 250, unitSizeUnit: "ml" })];
    const rMl = recipe([{ name: "Refresco", quantity: 300, unit: "ml" }]);
    actions.cookRecipe(draftMl, rMl, 1, { deductIngredients: true });
    expect(draftMl.inventory[0].qty).toBe(0.8); // quedan 200 ml = 0.8 latas

    const draftG = structuredClone(defaultState);
    draftG.inventory = [inv({ id: "ud-lata", name: "Refresco", qty: 2, unit: "ud", unitSize: 250, unitSizeUnit: "ml" })];
    const rG = recipe([{ name: "Refresco", quantity: 200, unit: "g" }]); // mismatch: se pide en masa
    actions.cookRecipe(draftG, rG, 1, { deductIngredients: true });
    expect(draftG.inventory[0].qty).toBe(2); // intacto — declarado como ml, no g
  });

  it("un lote 'ud' con unitSizeUnit legacy ausente no se descuenta ni contra g ni contra ml", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [inv({ id: "ud-legacy", name: "Yogur", qty: 2, unit: "ud", unitSize: 125 })]; // sin unitSizeUnit
    const r = recipe([{ name: "Yogur", quantity: 250, unit: "g" }]);
    actions.cookRecipe(draft, r, 1, { deductIngredients: true });
    expect(draft.inventory[0].qty).toBe(2); // intacto — unitSize sin dimensión declarada no cuenta
  });
});

describe("getMealPlanShoppingList — faltantes conscientes de unidades (auditoría 2026-09)", () => {
  it("1 kg en despensa cubre una receta que pide 200 g — no sugiere comprar", () => {
    const r = recipe([{ name: "Arroz", quantity: 200, unit: "g" }]);
    const state: FoodOSState = {
      ...structuredClone(defaultState),
      customRecipes: [r],
      inventory: [inv({ name: "Arroz", qty: 1, unit: "kg" })],
      mealPlan: { "2026-01-05": { lunch: "r-1" } },
    };
    expect(getMealPlanShoppingList(state, ["2026-01-05"])).toHaveLength(0);
  });

  it("expresa el déficit en la unidad del ingrediente y nunca sugiere cantidad 0", () => {
    const r = recipe([{ name: "Arroz", quantity: 500, unit: "g" }]);
    const state: FoodOSState = {
      ...structuredClone(defaultState),
      customRecipes: [r],
      inventory: [inv({ name: "Arroz", qty: 0.2, unit: "kg" })], // 200 g reales
      mealPlan: { "2026-01-05": { lunch: "r-1" } },
    };
    const list = getMealPlanShoppingList(state, ["2026-01-05"]);
    expect(list).toHaveLength(1);
    expect(list[0].qty).toBe(300);
    expect(list[0].unit).toBe("g");
  });
});

describe("removeCustomRecipeFromDraft / countUpcomingMealPlanUsages — borrado de recetas personalizadas", () => {
  it("removeCustomRecipeFromDraft borra solo la receta indicada de customRecipes", () => {
    const a = { ...recipe([]), id: "custom-a", title: "A" };
    const b = { ...recipe([]), id: "custom-b", title: "B" };
    const draft: FoodOSState = { ...structuredClone(defaultState), customRecipes: [a, b] };
    removeCustomRecipeFromDraft(draft, "custom-a");
    expect(draft.customRecipes.map((r) => r.id)).toEqual(["custom-b"]);
  });

  it("no-op seguro si el id no está en customRecipes (p.ej. un id del catálogo)", () => {
    const a = { ...recipe([]), id: "custom-a" };
    const draft: FoodOSState = { ...structuredClone(defaultState), customRecipes: [a] };
    expect(() => removeCustomRecipeFromDraft(draft, "demo-catalogo-1")).not.toThrow();
    expect(draft.customRecipes).toEqual([a]);
  });

  it("limpia todos los slots de mealPlan que apunten a la receta borrada, incluida una fecha pasada", () => {
    const target = { ...recipe([]), id: "custom-target" };
    const draft: FoodOSState = {
      ...structuredClone(defaultState),
      customRecipes: [target],
      mealPlan: {
        "2020-01-01": { lunch: "custom-target", dinner: "custom-target" }, // fecha pasada
        "2099-06-15": { breakfast: "custom-target" }, // fecha futura
      },
    };
    removeCustomRecipeFromDraft(draft, "custom-target");
    expect(draft.mealPlan["2020-01-01"]).toEqual({});
    expect(draft.mealPlan["2099-06-15"]).toEqual({});
  });

  it("deja intactos los slots que apuntan a otra receta o a un plannerQuickMeals id", () => {
    const target = { ...recipe([]), id: "custom-target" };
    const draft: FoodOSState = {
      ...structuredClone(defaultState),
      customRecipes: [target],
      mealPlan: { "2099-06-15": { breakfast: "custom-target", lunch: "otra-receta", dinner: "quickmeal-1" } },
      plannerQuickMeals: [{ id: "quickmeal-1", name: "Rápido", kcal: 300, protein: 20, carbs: 30, fat: 10, cost: 1 }],
    };
    removeCustomRecipeFromDraft(draft, "custom-target");
    expect(draft.mealPlan["2099-06-15"]).toEqual({ lunch: "otra-receta", dinner: "quickmeal-1" });
    expect(draft.plannerQuickMeals).toEqual([{ id: "quickmeal-1", name: "Rápido", kcal: 300, protein: 20, carbs: 30, fat: 10, cost: 1 }]);
  });

  it("filtra el id de savedRecipeIds", () => {
    const target = { ...recipe([]), id: "custom-target" };
    const draft: FoodOSState = {
      ...structuredClone(defaultState),
      customRecipes: [target],
      savedRecipeIds: ["custom-target", "otra-receta"],
    };
    removeCustomRecipeFromDraft(draft, "custom-target");
    expect(draft.savedRecipeIds).toEqual(["otra-receta"]);
  });

  it("nunca toca foodLog, cart, inventory ni plannerQuickMeals no referenciados", () => {
    const target = { ...recipe([]), id: "custom-target" };
    const foodLogEntry = { id: "log-1", date: "2026-01-01", time: "12:00", name: "Bowl de pollo", qty: null, unit: null, kcal: 500, protein: 40, carbs: 50, fat: 15, source: "recipe" as const, mealType: "lunch" as const };
    const cartItem: CartItem = { id: "cart-1", name: "Pollo", qty: 200, unit: "g", price: 1.2, store: "Mercadona", checked: false, source: "recipe", reason: "Para: Bowl de pollo" };
    const invItem = inv({ id: "inv-1" });
    const draft: FoodOSState = {
      ...structuredClone(defaultState),
      customRecipes: [target],
      foodLog: [foodLogEntry],
      cart: [cartItem],
      inventory: [invItem],
      plannerQuickMeals: [{ id: "quickmeal-1", name: "Rápido", kcal: 300, protein: 20, carbs: 30, fat: 10, cost: 1 }],
    };
    removeCustomRecipeFromDraft(draft, "custom-target");
    expect(draft.foodLog).toEqual([foodLogEntry]);
    expect(draft.cart).toEqual([cartItem]);
    expect(draft.inventory).toEqual([invItem]);
    expect(draft.plannerQuickMeals).toEqual([{ id: "quickmeal-1", name: "Rápido", kcal: 300, protein: 20, carbs: 30, fat: 10, cost: 1 }]);
  });

  it("countUpcomingMealPlanUsages: 0 sin uso, cuenta correcta con varias ocurrencias, excluye una fecha pasada", () => {
    const state: FoodOSState = {
      ...structuredClone(defaultState),
      mealPlan: {
        "2020-01-01": { lunch: "custom-target" }, // pasada — no cuenta
        "2026-06-15": { breakfast: "custom-target", dinner: "custom-target" }, // === todayKey (hoy), 2 usos — SÍ cuenta
        "2026-06-16": { lunch: "otra-receta" }, // no es la receta buscada
      },
    };
    expect(countUpcomingMealPlanUsages(state, "no-usada", "2026-06-15")).toBe(0);
    expect(countUpcomingMealPlanUsages(state, "custom-target", "2026-06-15")).toBe(2);
  });

  // Corrección de revisión: la semántica es fecha >= todayKey, HOY
  // INCLUIDO — una planificación de hoy también se borra junto con la
  // receta, así que también debe figurar en el aviso ("hoy o en los
  // próximos días", nunca solo "futuras"). Casos límite explícitos con
  // fechas consecutivas para que no quede ambigüedad.
  it("countUpcomingMealPlanUsages — casos límite consecutivos: ayer no cuenta, hoy sí, mañana sí", () => {
    const todayKey = "2026-06-15";
    const yesterdayOnly: FoodOSState = {
      ...structuredClone(defaultState),
      mealPlan: { "2026-06-14": { lunch: "custom-target" } },
    };
    const todayOnly: FoodOSState = {
      ...structuredClone(defaultState),
      mealPlan: { "2026-06-15": { lunch: "custom-target" } },
    };
    const tomorrowOnly: FoodOSState = {
      ...structuredClone(defaultState),
      mealPlan: { "2026-06-16": { lunch: "custom-target" } },
    };

    expect(countUpcomingMealPlanUsages(yesterdayOnly, "custom-target", todayKey)).toBe(0);
    expect(countUpcomingMealPlanUsages(todayOnly, "custom-target", todayKey)).toBe(1);
    expect(countUpcomingMealPlanUsages(tomorrowOnly, "custom-target", todayKey)).toBe(1);
  });
});

// ── Ronda de cierre: mezclas dimensionales en los flujos de inventario ─────
describe("deducción/disponibilidad — impedir mezclas dimensionales (ronda de cierre)", () => {
  it("cocinar un ingrediente en g NUNCA descuenta de un lote en ml (masa↔volumen sin densidad)", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [
      inv({ id: "ml-lot", name: "Leche", qty: 500, unit: "ml", expires: "2099-01-01" }),
      inv({ id: "g-lot", name: "Leche", qty: 300, unit: "g", expires: "2099-01-02" }),
    ];
    const r = recipe([{ name: "Leche", quantity: 200, unit: "g" }]);
    actions.cookRecipe(draft, r, 1, { deductIngredients: true });
    const mlLot = draft.inventory.find((i) => i.id === "ml-lot");
    const gLot = draft.inventory.find((i) => i.id === "g-lot");
    expect(mlLot?.qty).toBe(500); // intacto — no convertible sin densidad
    expect(gLot?.qty).toBe(100);  // los 200 g salen del lote convertible
  });

  it("un lote 'ud' SIN unitSize válido no se descuenta contra un ingrediente en g (nunca el 60 por defecto)", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = [inv({ id: "ud-lot", name: "Huevos", qty: 6, unit: "ud" })]; // sin unitSize
    const r = recipe([{ name: "Huevos", quantity: 120, unit: "g" }]);
    actions.cookRecipe(draft, r, 1, { deductIngredients: true });
    expect(draft.inventory[0].qty).toBe(6); // intacto
    const entry = draft.foodLog[draft.foodLog.length - 1];
    expect(entry.consumedIngredients).toBeUndefined();
  });

  it("hasEnough/getRecipeMatch: un lote en ml no cubre un ingrediente en g", () => {
    const state = { ...structuredClone(defaultState), inventory: [inv({ name: "Caldo", qty: 1000, unit: "ml" })] };
    const r = recipe([{ name: "Caldo", quantity: 200, unit: "g" }]);
    expect(getRecipeMatch(state, r).pct).toBe(0);
  });

  it("availableForIngredient: un lote 'ud' líquido no cuenta para un ingrediente en g, y viceversa", () => {
    const state = {
      ...structuredClone(defaultState),
      inventory: [inv({ name: "Aceite", qty: 1, unit: "ud", unitSize: 500, unitSizeUnit: "ml" as const })],
    };
    expect(availableForIngredient(state, "Aceite", "ml")).toBe(500); // declarado en ml: cuenta
    expect(availableForIngredient(state, "Aceite", "g")).toBe(0);    // pedido en g: no cuenta
  });

  it("availableForIngredient ignora lotes con cantidades corruptas (NaN/negativas)", () => {
    const state = {
      ...structuredClone(defaultState),
      inventory: [
        inv({ id: "bad-1", name: "Arroz", qty: Number.NaN, unit: "g" }),
        inv({ id: "bad-2", name: "Arroz", qty: -50, unit: "g" }),
        inv({ id: "ok", name: "Arroz", qty: 300, unit: "g" }),
      ],
    };
    expect(availableForIngredient(state, "Arroz", "g")).toBe(300);
  });

  it("ingrediente en 'ud' se cubre por conteo directo con lotes 'ud', sin necesitar unitSize", () => {
    const state = { ...structuredClone(defaultState), inventory: [inv({ name: "Huevos", qty: 6, unit: "ud" })] };
    const r = recipe([{ name: "Huevos", quantity: 2, unit: "ud" }]);
    expect(getRecipeMatch(state, r).pct).toBe(100);
  });

  // Revisión exhaustiva de persistencia (ronda de separación db/app): todo
  // snapshot de inventario (InventorySnapshot) debe llevar unitSizeUnit para
  // que, si el item original ya no existe, restoreInventoryQty lo recree con
  // su dimensión intacta — no solo con el número desnudo de unitSize. Este
  // contrato es compartido por los 3 sitios que construyen un snapshot
  // (deductFromInventoryFIFO, consumeInventoryItem, LogMealModal.confirmDish);
  // se fija aquí a través de la vía genérica de restauración.
  it("returnIngredientsToInventory recrea un item borrado conservando unitSizeUnit del snapshot", () => {
    const draft = structuredClone(defaultState);
    draft.inventory = []; // el item original ya no existe: fuerza el camino de recreación
    const entry: FoodOSState["foodLog"][number] = {
      id: "e1", date: "2026-01-05", time: "12:00", name: "Refresco en lata",
      qty: null, unit: null, kcal: 140, protein: 0, carbs: 35, fat: 0,
      source: "manual", mealType: "lunch",
      consumedIngredients: [{
        inventoryItemId: "ya-no-existe",
        name: "Refresco en lata",
        qty: 1,
        unit: "ud",
        snapshot: {
          storage: "Nevera", expires: "2026-02-01", price: 0.9,
          kcal: 140, protein: 0, carbs: 35, fat: 0,
          unitSize: 330, unitSizeUnit: "ml",
        },
      }],
    };
    draft.foodLog = [entry];
    actions.returnIngredientsToInventory(draft, entry);
    const restored = draft.inventory.find((i) => i.name === "Refresco en lata");
    expect(restored?.unitSize).toBe(330);
    expect(restored?.unitSizeUnit).toBe("ml"); // no solo el número: también su magnitud
  });
});
