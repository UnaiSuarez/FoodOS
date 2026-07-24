"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import type { AppSettings, DailyTargets, FoodLogEntry, FoodOSState, GoalMode, InventoryItem, InventorySnapshot, MacroTotals, MealType, Recipe, WeightEntry } from "@foodos/types";
import { clearLocalState, flushLocalState, loadLocalState, remote, saveLocalState, saveLocalStateDebounced } from "./data-layer";
import { hasSupabaseConfig } from "./supabase";
import { DEMO_RECIPES } from "./recipes";
import { getMascot } from "./mascots";
import { calcDailyTargets, isGymDay, weeklyCycle } from "./nutrition";
import { findExactFood } from "./food-db";
import { addDaysToDateKey, dateFromKey, dateOffset, daysUntil, eur, mealTypeFromTime, namesMatch, todayMinus, todayPlus, toGrams, uid } from "./utils";

export const DEFAULT_SETTINGS: AppSettings = {
  expiryWarnDays: 3,
  waterGoalMl: 2500,
  dinnerSuggestionHour: 18,
  budgetWarnPct: 80,
  defaultStore: "Mercadona",
  lowStockThresholds: { g: 200, ml: 300, L: 0.5, kg: 0.3, ud: 2 },
  extraExpenseCategories: [],
  stepsGoal: 8000,
};

export const defaultState: FoodOSState = {
  inventory: [],
  cart: [],
  expenses: [],
  incomeSources: [],
  recurringExpenses: [],
  savingsGoalPct: 20,
  feedPosts: [],
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
  settings: DEFAULT_SETTINGS,
  dismissedSuggestions: [],
  mealPlan: {},
  plannerQuickMeals: [],
  debugDate: null,
  categoryBudgets: {},
  routines: [],
  workoutLog: [],
  stepsLog: {},
};

// Migra estados guardados con formatos antiguos (modos en español,
// ingredientes como strings) y aplica el ciclado del dia si hay perfil.
const LEGACY_MODES: Record<string, GoalMode> = {
  Recomposicion: "recomp",
  "Perdida de grasa": "fat_loss",
  "Ganancia muscular": "muscle_gain",
  Mantenimiento: "maintain",
};

export function normalizeState(state: FoodOSState): FoodOSState {
  const next = structuredClone(state);
  const legacyMode = LEGACY_MODES[next.nutrition.mode as unknown as string];
  if (legacyMode) next.nutrition.mode = legacyMode;
  next.incomeSources ||= [];
  next.recurringExpenses ||= [];
  next.savingsGoalPct ??= 20;
  next.foodLog ||= [];
  next.waterLog ||= {};
  next.weightLog ||= [];
  next.mealPlan ||= {};
  next.plannerQuickMeals ||= [];
  next.categoryBudgets ||= {};
  next.routines ||= [];
  next.workoutLog ||= [];
  next.stepsLog ||= {};
  next.settings = { ...DEFAULT_SETTINGS, ...(next.settings ?? {}), lowStockThresholds: { ...DEFAULT_SETTINGS.lowStockThresholds, ...(next.settings?.lowStockThresholds ?? {}) } };
  // Migracion: las comidas antiguas sin fecha (consumedMeals) pasan al diario datado.
  const legacy = next as FoodOSState & { consumedMeals?: Array<MacroTotals & { id: string; name: string }>; consumed?: MacroTotals };
  if (legacy.consumedMeals?.length) {
    legacy.consumedMeals.forEach((meal) => {
      next.foodLog.push({
        id: meal.id || uid(),
        date: getToday(next),
        time: "12:00",
        name: meal.name,
        qty: null,
        unit: null,
        kcal: meal.kcal,
        protein: meal.protein,
        carbs: meal.carbs,
        fat: meal.fat,
        source: "recipe",
        mealType: "lunch",
      });
    });
  }
  delete legacy.consumedMeals;
  delete legacy.consumed;
  // Migra entradas del diario sin mealType (datos guardados antes de esta version).
  next.foodLog = next.foodLog.map((entry) => ({
    ...entry,
    mealType: (entry as FoodLogEntry & { mealType?: MealType }).mealType ?? mealTypeFromTime(entry.time),
  }));
  next.customRecipes = (next.customRecipes || []).map((recipe) => ({
    ...recipe,
    ingredients: (recipe.ingredients || []).map((ing) =>
      typeof ing === "string" ? { name: ing, quantity: 100, unit: "g" } : ing
    ),
  }));
  if (next.profile) {
    const targets = calcDailyTargets(next.profile, isGymDay(next.profile, stateDate(next)));
    next.nutrition = {
      kcal: targets.kcal,
      protein: targets.protein,
      carbs: targets.carbs,
      fat: targets.fat,
      mode: next.profile.goal,
    };
  }
  return next;
}

function stateDate(state: Pick<FoodOSState, "debugDate">): Date {
  return dateFromKey(state.debugDate ?? todayPlus(0));
}

function relativeDate(state: Pick<FoodOSState, "debugDate">, days: number): string {
  return state.debugDate ? addDaysToDateKey(state.debugDate, days) : todayPlus(days);
}

export type MascotState = "idle" | "wave" | "thinking" | "celebrate" | "alert" | "suggest" | "sleep" | "success_buy" | "streak";
const LOOP_MASCOT_STATES: MascotState[] = ["idle", "thinking", "sleep"];

/** Duración de un toast con acción de deshacer. Exportado para que quien
    difiera efectos secundarios irreversibles hasta que expire la ventana de
    deshacer (ej. borrar la foto de Storage) use el mismo plazo. */
export const UNDO_TOAST_MS = 5000;

/** Acción opcional de un toast (ej. "Deshacer" tras un borrado). Mientras el
    toast tiene acción permanece visible más tiempo (UNDO_TOAST_MS) para dar
    margen a pulsarla. */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

interface FoodOSContextValue {
  state: FoodOSState;
  hydrated: boolean;
  remoteReady: boolean;
  authUser: User | null;
  /** true cuando el canal de Supabase Realtime está SUBSCRIBED */
  realtimeConnected: boolean;
  showToast: (message: string, action?: ToastAction) => void;
  setMascotMessage: (message: string) => void;
  triggerMascot: (anim: MascotState, message?: string) => void;
  mutate: (fn: (draft: FoodOSState) => void) => void;
  /** Incrementa/decrementa el agua del día de forma atómica (sin conflictos entre tabs). */
  addWater: (ml: number) => void;
  resetAll: () => void;
  seedDemo: () => void;
}

/** Estado efímero de UI (toast + mascota) en un contexto aparte: cambia
    constantemente (cada toast dispara mostrar+ocultar, la mascota reacciona a
    actividad del ratón) y en el contexto principal re-renderizaba TODOS los
    consumidores de useFoodOS() en cada parpadeo. Solo lo consumen el toast del
    shell y el widget de la mascota. */
interface FoodOSUIValue {
  toast: { message: string; action?: ToastAction } | null;
  mascotMessage: string;
  mascotState: MascotState;
}

const FoodOSContext = createContext<FoodOSContextValue | null>(null);
const FoodOSUIContext = createContext<FoodOSUIValue | null>(null);

export function FoodOSProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FoodOSState>(defaultState);
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<FoodOSUIValue["toast"]>(null);
  const [mascotMessage, setMascotMessage] = useState("Lista para organizar tu comida.");
  const [mascotState, setMascotState] = useState<MascotState>("idle");
  const mascotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [remoteReady, setRemoteReady] = useState(false);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtimeUnsubRef = useRef<(() => void) | null>(null);
  const realtimeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Con la escritura de localStorage diferida (debounce), al cerrar/recargar la
  // pestaña hay que volcar lo pendiente o se perderían los últimos ~300ms.
  useEffect(() => {
    window.addEventListener("pagehide", flushLocalState);
    return () => window.removeEventListener("pagehide", flushLocalState);
  }, []);

  // Hidratacion: primero localStorage, despues Supabase si hay sesion.
  useEffect(() => {
    setState(normalizeState(loadLocalState(defaultState)));
    setHydrated(true);

    if (!hasSupabaseConfig()) return;
    let cancelled = false;

    const hydrateRemote = async () => {
      try {
        await remote.ensureBaseRows();
        const remoteState = normalizeState(await remote.pullState(defaultState));
        if (cancelled) return;
        setState(remoteState);
        saveLocalState(remoteState);
        setMascotMessage("Datos sincronizados desde Supabase.");
      } catch (error) {
        console.warn("FoodOS: fallo hidratando desde Supabase", error);
      }
    };

    // Si hay un guardado local pendiente (debounce, en curso, o en cola), un pull
    // ahora mismo traería datos desactualizados y pisaría ese cambio antes de que
    // llegue al servidor. Reintenta un rato en vez de hidratar a ciegas; si tras el
    // margen sigue pendiente, hidrata igualmente (red de seguridad ante un guardado
    // atascado) para no dejar de sincronizar nunca.
    function scheduleHydrate(retriesLeft = 6) {
      realtimeDebounceRef.current = setTimeout(() => {
        if (cancelled) return;
        if (remote.hasPendingPush() && retriesLeft > 0) {
          scheduleHydrate(retriesLeft - 1);
          return;
        }
        void hydrateRemote();
      }, 300);
    }

    function setupRealtime() {
      realtimeUnsubRef.current?.();
      realtimeUnsubRef.current = remote.subscribeRealtime(
        () => {
          if (cancelled) return;
          // Debounce: evita re-hidrataciones en cascada cuando llegan varios eventos seguidos.
          if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
          scheduleHydrate();
        },
        (table, newRow) => {
          if (cancelled) return;
          // Parche directo: no requiere ida a Supabase → prácticamente instantáneo.
          if (table === "water_log") {
            const { log_date, ml } = newRow as { log_date: string; ml: number };
            setState((cur) => {
              const next = { ...cur, waterLog: { ...cur.waterLog, [log_date]: Number(ml) } };
              saveLocalStateDebounced(next);
              return next;
            });
          } else if (table === "weight_log") {
            const { log_date, kg } = newRow as { log_date: string; kg: number };
            setState((cur) => {
              const entries = cur.weightLog.filter((e) => e.date !== log_date);
              entries.push({ date: log_date, kg: Number(kg) });
              entries.sort((a, b) => a.date.localeCompare(b.date));
              const next = { ...cur, weightLog: entries };
              saveLocalStateDebounced(next);
              return next;
            });
          }
        },
        (connected) => {
          if (!cancelled) setRealtimeConnected(connected);
        },
      );
    }

    void remote.init().then((ok) => {
      if (cancelled || !ok) return;
      setRemoteReady(true);
      remote.onAuthChange((user) => {
        setAuthUser(user);
        // Limpia suscripcion anterior antes de cualquier cambio de sesion.
        realtimeUnsubRef.current?.();
        realtimeUnsubRef.current = null;
        if (user) {
          // Nuevo usuario: limpiar estado local para evitar mezcla entre cuentas.
          clearLocalState();
          setState(structuredClone(defaultState));
          void hydrateRemote().then(() => { if (!cancelled) setupRealtime(); });
        } else {
          // Logout: limpiar todo.
          clearLocalState();
          setState(structuredClone(defaultState));
          setRealtimeConnected(false);
        }
      });
      if (remote.user) {
        setAuthUser(remote.user);
        void hydrateRemote().then(() => { if (!cancelled) setupRealtime(); });
      }
    });

    return () => {
      cancelled = true;
      realtimeUnsubRef.current?.();
      realtimeUnsubRef.current = null;
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
    };
  }, []);

  const showToast = useCallback((message: string, action?: ToastAction) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const dismiss = () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast(null);
    };
    setToast({
      message,
      // Al pulsar la acción, además de ejecutarla se cierra el toast al momento.
      action: action ? { label: action.label, onAction: () => { dismiss(); action.onAction(); } } : undefined,
    });
    toastTimer.current = setTimeout(() => setToast(null), action ? UNDO_TOAST_MS : 2600);
  }, []);

  // Avisa si un guardado no llegó a Supabase (queda solo en este dispositivo
  // hasta que remote.schedulePush lo reintente).
  useEffect(() => {
    remote.onPushError = () => {
      showToast("No se pudo sincronizar con el servidor, reintentando…");
    };
    return () => { remote.onPushError = null; };
  }, [showToast]);

  // Toda mutacion pasa por aqui: clona, aplica, persiste (local + remoto).
  const mutate = useCallback((fn: (draft: FoodOSState) => void) => {
    setState((current) => {
      const draft = structuredClone(current);
      fn(draft);
      // Si hay perfil, los objetivos del dia siempre derivan de el.
      if (draft.profile) {
        const targets = calcDailyTargets(draft.profile, isGymDay(draft.profile, stateDate(draft)));
        draft.nutrition = {
          kcal: targets.kcal,
          protein: targets.protein,
          carbs: targets.carbs,
          fat: targets.fat,
          mode: draft.profile.goal,
        };
      }
      saveLocalStateDebounced(draft);
      remote.schedulePush(draft);
      return draft;
    });
  }, []);

  const addWater = useCallback((ml: number) => {
    // Respeta la fecha simulada (debugDate) en vez de asumir siempre "hoy" real.
    const date = state.debugDate ?? todayPlus(0);
    // Actualiza local de forma optimista para respuesta inmediata en la UI.
    setState((current) => {
      const draft = structuredClone(current);
      draft.waterLog[date] = Math.max(0, (draft.waterLog[date] ?? 0) + ml);
      saveLocalStateDebounced(draft);
      return draft;
    });
    // RPC atómica: el servidor aplica el delta, sin sobreescribir entre tabs.
    void remote.incrementWater(date, ml).catch((e) => console.warn("FoodOS: incrementWater falló", e));
  }, [state.debugDate]);

  const resetAll = useCallback(() => {
    clearLocalState();
    setState(structuredClone(defaultState));
    showToast("Datos locales borrados");
  }, [showToast]);

  const seedDemo = useCallback(() => {
    const demo = structuredClone(defaultState);
    demo.inventory = [
      { id: uid(), name: "Pechuga de pollo", qty: 260, unit: "g", storage: "Nevera", expires: todayPlus(1), price: 2.8, kcal: 165, protein: 31 },
      { id: uid(), name: "Arroz integral", qty: 500, unit: "g", storage: "Despensa", expires: todayPlus(60), price: 1.7, kcal: 360, protein: 8 },
      { id: uid(), name: "Tomate cherry", qty: 180, unit: "g", storage: "Nevera", expires: todayPlus(3), price: 1.4, kcal: 18, protein: 1 },
      { id: uid(), name: "Yogur griego", qty: 1, unit: "ud", unitSize: 125, storage: "Nevera", expires: todayPlus(2), price: 0.9, kcal: 95, protein: 10 },
      { id: uid(), name: "Huevos", qty: 6, unit: "ud", unitSize: 60, storage: "Nevera", expires: todayPlus(12), price: 1.8, kcal: 155, protein: 13 },
    ];
    demo.cart = [{ id: uid(), name: "Avena", qty: 1, unit: "ud", price: 1.4, store: "Mercadona", checked: false }];
    demo.incomeSources = [
      { id: uid(), name: "Nómina", amount: 1450, frequency: "monthly", dayOfMonth: 28, active: true },
    ];
    demo.recurringExpenses = [
      { id: uid(), name: "Alquiler", amount: 620, frequency: "monthly", category: "Vivienda", active: true },
      { id: uid(), name: "Luz + agua", amount: 65, frequency: "monthly", category: "Suministros", active: true },
      { id: uid(), name: "Internet", amount: 38, frequency: "monthly", category: "Suministros", active: true },
      { id: uid(), name: "Spotify", amount: 11.99, frequency: "monthly", category: "Suscripciones", active: true },
    ];
    demo.expenses = [
      { id: uid(), type: "expense", amount: 38.4, category: "Comida", description: "Mercadona demo", date: todayMinus(1) },
      { id: uid(), type: "expense", amount: 22.5, category: "Comida", description: "Frutería demo", date: todayMinus(5) },
      { id: uid(), type: "expense", amount: 24.2, category: "Salud", description: "Suplementos demo", date: todayMinus(10) },
      { id: uid(), type: "expense", amount: 47.9, category: "Comida", description: "Lidl demo", date: todayMinus(16) },
      { id: uid(), type: "expense", amount: 19.6, category: "Ocio", description: "Cena fuera demo", date: todayMinus(23) },
      { id: uid(), type: "expense", amount: 32.0, category: "Ocio", description: "Fin de semana demo", date: todayMinus(28) },
    ];
    demo.feedPosts = buildDemoPosts();
    // Historial demo del diario: ayer y anteayer con comidas y agua.
    demo.foodLog = [
      { id: uid(), date: todayMinus(1), time: "09:10", name: "Tostada de huevo y yogur", qty: null, unit: null, kcal: 480, protein: 32, carbs: 48, fat: 18, source: "recipe", mealType: "breakfast" },
      { id: uid(), date: todayMinus(1), time: "14:25", name: "Bowl proteico de pollo", qty: null, unit: null, kcal: 610, protein: 54, carbs: 72, fat: 12, source: "recipe", mealType: "lunch" },
      { id: uid(), date: todayMinus(1), time: "21:05", name: "Yogur griego", qty: 125, unit: "g", kcal: 119, protein: 12.5, carbs: 5, fat: 6, source: "inventory", mealType: "dinner" },
      { id: uid(), date: todayMinus(2), time: "13:40", name: "Pasta rápida con atún", qty: null, unit: null, kcal: 690, protein: 42, carbs: 96, fat: 14, source: "recipe", mealType: "lunch" },
      { id: uid(), date: todayMinus(2), time: "20:50", name: "Lentejas de despensa", qty: null, unit: null, kcal: 540, protein: 28, carbs: 92, fat: 7, source: "recipe", mealType: "dinner" },
    ];
    demo.waterLog = { [todayMinus(1)]: 2250, [todayMinus(2)]: 1750 };
    // Historial de peso demo: últimas 2 semanas con tendencia descendente ligera.
    demo.weightLog = Array.from({ length: 14 }, (_, i) => ({
      date: todayMinus(13 - i),
      kg: Math.round((78.4 - i * 0.12 + (Math.random() - 0.5) * 0.3) * 10) / 10,
    }));
    saveLocalState(demo);
    remote.schedulePush(demo);
    setState(demo);
    setMascotMessage("Datos demo cargados. Configura tu perfil en Nutrición.");
    showToast("Datos demo cargados");
  }, [showToast]);

  const triggerMascot = useCallback((anim: MascotState, message?: string) => {
    if (mascotTimer.current) clearTimeout(mascotTimer.current);
    setMascotState(anim);
    if (message) setMascotMessage(message);
    if (!LOOP_MASCOT_STATES.includes(anim)) {
      mascotTimer.current = setTimeout(() => setMascotState("idle"), 2800);
    }
  }, []);

  // Memoizado para que los cambios del contexto de UI (toast/mascota, muy
  // frecuentes) no invaliden este valor y re-rendericen a los 30+ consumidores
  // de useFoodOS(). Todos los callbacks son estables (useCallback).
  const mainValue = useMemo<FoodOSContextValue>(
    () => ({
      state,
      hydrated,
      remoteReady,
      authUser,
      realtimeConnected,
      showToast,
      setMascotMessage,
      triggerMascot,
      mutate,
      addWater,
      resetAll,
      seedDemo,
    }),
    [state, hydrated, remoteReady, authUser, realtimeConnected, showToast, triggerMascot, mutate, addWater, resetAll, seedDemo]
  );

  const uiValue = useMemo<FoodOSUIValue>(
    () => ({ toast, mascotMessage, mascotState }),
    [toast, mascotMessage, mascotState]
  );

  return (
    <FoodOSContext.Provider value={mainValue}>
      <FoodOSUIContext.Provider value={uiValue}>
        {children}
      </FoodOSUIContext.Provider>
    </FoodOSContext.Provider>
  );
}

export function useFoodOS(): FoodOSContextValue {
  const context = useContext(FoodOSContext);
  if (!context) throw new Error("useFoodOS debe usarse dentro de <FoodOSProvider>");
  return context;
}

/** Estado efímero de UI (toast + mascota). Contexto aparte a propósito:
    consumirlo desde useFoodOS() re-renderizaba toda la app en cada toast. */
export function useFoodOSUI(): FoodOSUIValue {
  const context = useContext(FoodOSUIContext);
  if (!context) throw new Error("useFoodOSUI debe usarse dentro de <FoodOSProvider>");
  return context;
}

// ---------- Selectores y helpers de dominio ----------

export function buildDemoPosts() {
  return [
    {
      id: uid(),
      recipeId: "chicken-rice",
      author: "zana",
      title: "Cena de recomposición",
      caption: "Pollo, arroz y tomate usando lo que caducaba mañana.",
      likes: 42,
      comments: [{ author: "María", text: "La voy a probar para después del gym." }],
    },
    {
      id: uid(),
      recipeId: "lentils",
      author: "volt",
      title: "Comida por menos de 2 €",
      caption: "Lentejas de despensa, saciantes y muy baratas.",
      likes: 27,
      comments: [{ author: "Carlos", text: "Esto salva semanas de presupuesto ajustado." }],
    },
  ];
}

export function allRecipes(state: FoodOSState): Recipe[] {
  return [...state.customRecipes, ...DEMO_RECIPES];
}

export function findRecipe(state: FoodOSState, recipeId: string): Recipe | undefined {
  return allRecipes(state).find((recipe) => recipe.id === recipeId);
}

/** Devuelve "hoy" teniendo en cuenta la fecha de depuración si está activa. */
export function getToday(state: FoodOSState): string {
  return state.debugDate ?? todayPlus(0);
}

/** Resuelve un ID del planificador buscando en recetas y en platos rápidos. */
export function findPlanEntry(
  state: FoodOSState,
  id: string
): { title: string; kcal: number; protein: number; carbs: number; fat: number; cost: number; image?: string } | null {
  const r = allRecipes(state).find((x) => x.id === id);
  if (r) return { title: r.title, kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, cost: r.cost, image: r.image };
  const q = (state.plannerQuickMeals ?? []).find((x) => x.id === id);
  if (q) return { title: q.name, kcal: q.kcal, protein: q.protein, carbs: q.carbs, fat: q.fat, cost: q.cost };
  return null;
}

/** Quita de plannerQuickMeals los platos rápidos que ningún slot del
    planificador referencia ya (se quitaron o se reemplazaron por otra cosa).
    Sin esto, cada plato rápido creado se quedaba para siempre en el estado,
    aunque se borrara del plan — llamar tras cualquier mutación de mealPlan. */
export function pruneOrphanedQuickMeals(draft: FoodOSState): void {
  if (!draft.plannerQuickMeals?.length) return;
  const referencedIds = new Set(
    Object.values(draft.mealPlan ?? {}).flatMap((day) => Object.values(day as Record<string, string>))
  );
  draft.plannerQuickMeals = draft.plannerQuickMeals.filter((qm) => referencedIds.has(qm.id));
}

export function getRecipeMatch(state: FoodOSState, recipe: Recipe) {
  const names = state.inventory.map((item) => item.name);
  const matches = recipe.ingredients.filter((ingredient) =>
    names.some((name) => namesMatch(name, ingredient.name))
  );
  return { matches, pct: Math.round((matches.length / Math.max(1, recipe.ingredients.length)) * 100) };
}

export function getIngredientStatus(state: FoodOSState, recipe: Recipe) {
  const names = state.inventory.map((item) => item.name);
  return recipe.ingredients.map((ingredient) => ({
    name: ingredient.name,
    quantity: ingredient.quantity,
    unit: ingredient.unit,
    has: names.some((name) => namesMatch(name, ingredient.name)),
  }));
}

export function bestRecipe(state: FoodOSState): Recipe {
  return [...allRecipes(state)].sort(
    (a, b) => getRecipeMatch(state, b).pct - getRecipeMatch(state, a).pct || b.protein - a.protein
  )[0];
}

// ---------- Diario de comidas y agua ----------

function nowTime(): string {
  return new Date().toTimeString().slice(0, 5);
}

/** Entradas del diario de hoy, ordenadas por hora. */
export function getTodayLog(state: FoodOSState): FoodLogEntry[] {
  const today = getToday(state);
  return state.foodLog
    .filter((entry) => entry.date === today)
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** Totales consumidos hoy (derivados del diario — se reinician solos cada dia). */
export function getConsumedToday(state: FoodOSState): MacroTotals {
  return getTodayLog(state).reduce(
    (totals, entry) => ({
      kcal: totals.kcal + entry.kcal,
      protein: totals.protein + entry.protein,
      carbs: totals.carbs + entry.carbs,
      fat: totals.fat + entry.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
}

export function getWaterToday(state: FoodOSState): number {
  return state.waterLog[getToday(state)] ?? 0;
}

export function getStepsToday(state: FoodOSState): number {
  return state.stepsLog?.[getToday(state)] ?? 0;
}

/** kcal quemadas en sesiones de entrenamiento registradas hoy. */
export function getKcalBurnedToday(state: FoodOSState): number {
  const today = getToday(state);
  return (state.workoutLog ?? [])
    .filter((s) => s.date === today && (s.kcalBurned ?? 0) > 0)
    .reduce((sum, s) => sum + (s.kcalBurned ?? 0), 0);
}

/** Diario agrupado por dia (mas reciente primero), con totales. */
export function getLogByDay(state: FoodOSState): Array<{
  date: string;
  entries: FoodLogEntry[];
  totals: MacroTotals;
  water: number;
}> {
  const byDate = new Map<string, FoodLogEntry[]>();
  state.foodLog.forEach((entry) => {
    const list = byDate.get(entry.date) ?? [];
    list.push(entry);
    byDate.set(entry.date, list);
  });
  Object.keys(state.waterLog).forEach((date) => {
    if (!byDate.has(date) && state.waterLog[date] > 0) byDate.set(date, []);
  });
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, entries]) => ({
      date,
      entries: entries.sort((a, b) => b.time.localeCompare(a.time)),
      totals: entries.reduce(
        (totals, entry) => ({
          kcal: totals.kcal + entry.kcal,
          protein: totals.protein + entry.protein,
          carbs: totals.carbs + entry.carbs,
          fat: totals.fat + entry.fat,
        }),
        { kcal: 0, protein: 0, carbs: 0, fat: 0 }
      ),
      water: state.waterLog[date] ?? 0,
    }));
}

/** Macros que quedan por consumir hoy.
 *  Las kcal quemadas en el entrenamiento amplían el presupuesto calórico del día:
 *  déficit real = TDEE + ejercicio − ingeridas → el usuario puede comer más sin salir del plan. */
export function getPendingMacros(state: FoodOSState): MacroTotals {
  const consumed = getConsumedToday(state);
  const burnedToday = getKcalBurnedToday(state);
  return {
    kcal: Math.max(0, state.nutrition.kcal + burnedToday - consumed.kcal),
    protein: Math.max(0, state.nutrition.protein - consumed.protein),
    carbs: Math.max(0, state.nutrition.carbs - consumed.carbs),
    fat: Math.max(0, state.nutrition.fat - consumed.fat),
  };
}

/** Macros de una cantidad concreta de un alimento del inventario.
    Carbos y grasas se estiman (el inventario solo guarda kcal y proteina por 100). */
export function macrosForQuantity(item: InventoryItem, qty: number): MacroTotals {
  const grams = toGrams(qty, item.unit, item.unitSize);
  const kcal = (item.kcal * grams) / 100;
  const protein = (item.protein * grams) / 100;
  const fat = item.fat != null
    ? (item.fat * grams) / 100
    : Math.max(0, (kcal * 0.25) / 9);
  const carbs = item.carbs != null
    ? (item.carbs * grams) / 100
    : Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
  return {
    kcal: Math.round(kcal),
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fat: Math.round(fat * 10) / 10,
  };
}

/** Busca el tamaño por unidad ("ud") que el usuario ya indicó para un producto con
    este nombre: primero en el inventario actual, si no en el historial del diario
    (snapshot guardado al consumir). Evita tener que reintroducirlo cada vez que se
    vuelve a comprar el mismo producto (ej. una lata de Monster). */
export function findRememberedUnitSize(state: FoodOSState, name: string): number | undefined {
  const key = name.toLowerCase().trim();
  if (!key) return undefined;
  const fromInventory = state.inventory.find(
    (item) => item.name.toLowerCase().trim() === key && item.unitSize != null
  );
  if (fromInventory) return fromInventory.unitSize;
  for (let i = state.foodLog.length - 1; i >= 0; i--) {
    const entry = state.foodLog[i];
    if (entry.name.toLowerCase().trim() === key && entry.inventorySnapshot?.unitSize != null) {
      return entry.inventorySnapshot.unitSize;
    }
  }
  return undefined;
}

// Traduce los tags de alérgenos de Open Food Facts (taxonomía en inglés, prefijo "en:")
// a términos en español para poder cruzarlos con profile.allergies (texto libre del usuario).
const OFF_ALLERGEN_TERMS: Record<string, string[]> = {
  "en:gluten":      ["gluten", "trigo", "cebada", "centeno"],
  "en:milk":        ["leche", "lactosa", "lácteos", "lacteos"],
  "en:eggs":        ["huevo", "huevos"],
  "en:nuts":        ["frutos secos", "almendra", "nuez", "nueces", "avellana", "anacardo", "pistacho"],
  "en:peanuts":     ["cacahuete", "cacahuetes", "maní", "mani"],
  "en:soybeans":    ["soja"],
  "en:fish":        ["pescado"],
  "en:crustaceans": ["crustáceo", "crustaceo", "marisco", "gamba", "langostino"],
  "en:molluscs":    ["molusco", "mejillón", "mejillon", "calamar", "pulpo"],
  "en:sesame-seeds":["sésamo", "sesamo"],
  "en:celery":      ["apio"],
  "en:mustard":     ["mostaza"],
  "en:sulphur-dioxide-and-sulphites": ["sulfito", "sulfitos"],
  "en:lupin":       ["altramuz", "altramuces"],
};

/** Cruza los alérgenos de un producto (tags OFF) con las alergias declaradas por el
    usuario (texto libre). Devuelve las alergias del usuario que coinciden, para avisar
    antes de guardar el producto en el inventario. */
export function matchAllergens(state: FoodOSState, allergenTags?: string[]): string[] {
  const allergies = state.profile?.allergies ?? [];
  if (!allergenTags?.length || !allergies.length) return [];
  const productTerms = allergenTags.flatMap((tag) => OFF_ALLERGEN_TERMS[tag] ?? [tag.replace(/^en:/, "")]);
  const matched = new Set<string>();
  for (const allergy of allergies) {
    const a = allergy.toLowerCase().trim();
    if (!a) continue;
    if (productTerms.some((term) => a.includes(term) || term.includes(a))) {
      matched.add(allergy);
    }
  }
  return [...matched];
}

/**
 * Sugerencia de cena para cerrar macros (PDF §9.5 + §15):
 * solo se activa entre las 18:30 y las 23:00 cuando quedan macros relevantes.
 * Prioriza recetas que usen alimentos a punto de caducar.
 */
export function getDinnerSuggestion(state: FoodOSState): {
  recipe: Recipe;
  pendingKcal: number;
  pendingProtein: number;
  usedExpiringItem: InventoryItem | undefined;
} | null {
  const now = new Date();
  const timeDecimal = now.getHours() + now.getMinutes() / 60;
  const dinnerFrom = (state.settings?.dinnerSuggestionHour ?? 18) + 0.5;
  if (timeDecimal < dinnerFrom || timeDecimal >= 23) return null;

  const pending = getPendingMacros(state);
  if (pending.kcal < 100 && pending.protein < 10) return null;

  const expiringItems = state.inventory
    .filter((item) => item.qty > 0 && daysUntil(item.expires) <= 3)
    .sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires));

  const budgetLeft = getBudgetLeft(state);

  const best = allRecipes(state)
    .filter((r) => r.cost <= Math.max(budgetLeft, 1.5))
    .map((r) => {
      const usedExpiringItem = expiringItems.find((item) =>
        r.ingredients.some((ing) => namesMatch(item.name, ing.name))
      );
      const matchPct = getRecipeMatch(state, r).pct;
      // Penalidad: cuanto más se aleja del kcal pendiente, peor puntuacion.
      const kcalDiff = Math.abs(r.kcal - pending.kcal) / Math.max(pending.kcal, 1);
      return { r, usedExpiringItem, matchPct, kcalDiff };
    })
    .filter((e) => e.matchPct >= 20 || e.usedExpiringItem)
    .sort((a, b) => {
      if (a.usedExpiringItem && !b.usedExpiringItem) return -1;
      if (!a.usedExpiringItem && b.usedExpiringItem) return 1;
      return a.kcalDiff - b.kcalDiff;
    })[0];

  if (!best) return null;
  return {
    recipe: best.r,
    pendingKcal: Math.round(pending.kcal),
    pendingProtein: Math.round(pending.protein),
    usedExpiringItem: best.usedExpiringItem,
  };
}

/** Última entrada del historial de peso, o null si no hay registros. */
export function getLatestWeight(state: FoodOSState): WeightEntry | null {
  if (!state.weightLog.length) return null;
  return [...state.weightLog].sort((a, b) => b.date.localeCompare(a.date))[0];
}

// ---------- Plan semanal automático (PDF §9.5) ----------

export interface WeeklyDayPlan {
  date: string;
  dayName: string;
  isGym: boolean;
  targets: DailyTargets;
  breakfast: Recipe | null;
  lunch: Recipe | null;
  dinner: Recipe | null;
}

/**
 * Genera un plan de 7 días: para cada día asigna 3 recetas (desayuno/comida/cena)
 * ajustadas al ciclado gym/descanso, respetando alergias y variando cada día.
 */
export function generateWeeklyPlan(state: FoodOSState): WeeklyDayPlan[] {
  if (!state.profile) return [];

  const DAY_NAMES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const excluded = [
    ...(state.profile.allergies ?? []),
    ...(state.profile.excludedFoods ?? []),
  ].map((s) => s.toLowerCase());

  const eligible = allRecipes(state).filter(
    (r) =>
      !excluded.some(
        (ex) =>
          r.title.toLowerCase().includes(ex) ||
          r.ingredients.some((ing) => ing.name.toLowerCase().includes(ex))
      )
  );

  if (!eligible.length) return [];

  const pick = (targetKcal: number, dayIndex: number, already: string[]): Recipe | null => {
    const pool = eligible.filter((r) => !already.includes(r.id));
    if (!pool.length) return eligible[dayIndex % eligible.length] ?? null;
    const sorted = [...pool].sort((a, b) => Math.abs(a.kcal - targetKcal) - Math.abs(b.kcal - targetKcal));
    return sorted[dayIndex % sorted.length] ?? sorted[0];
  };

  const planBase = state.debugDate ?? todayPlus(0);
  return Array.from({ length: 7 }, (_, i) => {
    const date = dateOffset(planBase, i);
    const dayOfWeek = new Date(date + "T12:00:00").getDay();
    const isGym = state.profile!.gymDays.includes(dayOfWeek);
    const targets = calcDailyTargets(state.profile!, isGym);

    const breakfast = pick(targets.kcal * 0.25, i, []);
    const lunch = pick(targets.kcal * 0.35, i + 1, breakfast ? [breakfast.id] : []);
    const dinner = pick(
      targets.kcal * 0.40,
      i + 2,
      [breakfast?.id, lunch?.id].filter(Boolean) as string[]
    );

    return { date, dayName: DAY_NAMES[dayOfWeek], isGym, targets, breakfast, lunch, dinner };
  });
}

// Gasto de comida de los ultimos 7 dias (ventana del presupuesto semanal).
export function getFoodSpend(state: FoodOSState): number {
  const weekAgo = dateFromKey(getToday(state));
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);
  return state.expenses
    .filter((expense) => expense.type === "expense" && expense.category === "Comida")
    .filter((expense) => dateFromKey(expense.date || getToday(state)) >= weekAgo)
    .reduce((sum, expense) => sum + Number(expense.amount), 0);
}

export function getBudgetLeft(state: FoodOSState): number {
  return Math.max(0, Number(state.weeklyBudget) - getFoodSpend(state));
}

/** ¿Sigue habiendo algún OTRO item de inventario (o lote) que use esta misma
    URL de imagen? (completeCart/moveCheckedToInventory copian imageUrl del
    lote existente al restockear, así que la misma foto de Storage puede estar
    referenciada por varios items). Comprobarlo antes de borrar de Storage: si
    se comparte, borrarla rompería la foto del/de los otros items. */
export function isImageUrlReferencedElsewhere(state: FoodOSState, url: string, excludeItemId: string): boolean {
  return state.inventory.some((item) => item.id !== excludeItemId && item.imageUrl === url);
}

/** Items del inventario casi vacíos que no están pendientes ya en el carrito. */
export function getLowStockSuggestions(state: FoodOSState): import("@foodos/types").CartItem[] {
  const thresholds = state.settings?.lowStockThresholds ?? DEFAULT_SETTINGS.lowStockThresholds;
  // Excluir tanto los pendientes como los ya marcados: si el item está en carrito
  // (comprado o no), ya se gestionó y no debe re-aparecer como sugerencia.
  const inCart = new Set(
    state.cart.map((i) => i.name.toLowerCase())
  );

  // Sumar todos los lotes del mismo alimento antes de comparar con el umbral
  const totals = new Map<string, InventoryItem & { totalQty: number }>();
  for (const item of state.inventory) {
    const key = item.name.toLowerCase();
    const existing = totals.get(key);
    if (existing) {
      existing.totalQty += item.qty;
    } else {
      totals.set(key, { ...item, totalQty: item.qty });
    }
  }

  const dismissed = new Set((state.dismissedSuggestions ?? []).map((n) => n.toLowerCase()));

  return [...totals.values()]
    .filter((item) => {
      const threshold = (thresholds as Record<string, number>)[item.unit] ?? 100;
      return item.totalQty <= threshold && !inCart.has(item.name.toLowerCase()) && !dismissed.has(item.name.toLowerCase());
    })
    .slice(0, 14)
    .map((item) => ({
      id: uid(),
      name: item.name,
      qty: item.unit === "ud" ? 3 : item.unit === "L" ? 1 : item.unit === "kg" ? 1 : 500,
      unit: item.unit,
      price: item.price,
      store: "Mercadona",
      checked: false,
      source: "lowstock" as const,
    }));
}

/** Ingredientes del plan semanal que no están cubiertos por el inventario actual. */
export function getPlanShoppingList(state: FoodOSState): import("@foodos/types").CartItem[] {
  if (!state.profile) return [];
  const plan = generateWeeklyPlan(state);
  if (!plan.length) return [];

  const inCart = new Set(
    state.cart.filter((i) => !i.checked).map((i) => i.name.toLowerCase())
  );
  const needed = new Map<string, { qty: number; unit: string; price: number }>();

  for (const day of plan) {
    for (const recipe of [day.breakfast, day.lunch, day.dinner]) {
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        const key = ing.name.toLowerCase();
        if (inCart.has(key)) continue;

        const inStock = state.inventory
          .filter((inv) => namesMatch(inv.name, key))
          .reduce((sum, inv) => sum + inv.qty, 0);

        const shortfall = Math.max(0, ing.quantity - inStock);
        if (shortfall <= 0) continue;

        const existing = needed.get(key);
        if (existing) {
          existing.qty += shortfall;
        } else {
          needed.set(key, {
            qty: shortfall,
            unit: ing.unit,
            price: Math.max(0.5, recipe.cost / Math.max(1, recipe.ingredients.length)),
          });
        }
      }
    }
  }

  return Array.from(needed.entries())
    .slice(0, 20)
    .map(([name, data]) => ({
      id: uid(),
      name,
      qty: Math.round(data.qty),
      unit: data.unit,
      price: Math.round(data.price * 100) / 100,
      store: "Mercadona",
      checked: false,
      source: "plan" as const,
    }));
}

/** Genera lista de la compra desde el mealPlan real del usuario para los días indicados. */
export function getMealPlanShoppingList(
  state: FoodOSState,
  dateKeys: string[]
): import("@foodos/types").CartItem[] {
  const inCart = new Set(
    state.cart.filter((i) => !i.checked).map((i) => i.name.toLowerCase())
  );
  const needed = new Map<string, { qty: number; unit: string; price: number }>();

  for (const dateKey of dateKeys) {
    const day = state.mealPlan?.[dateKey];
    if (!day) continue;
    for (const slotId of Object.values(day)) {
      if (!slotId) continue;
      const recipe = allRecipes(state).find((r) => r.id === slotId);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        const key = ing.name.toLowerCase();
        if (inCart.has(key)) continue;
        const inStock = state.inventory
          .filter((inv) => namesMatch(inv.name, key))
          .reduce((sum, inv) => sum + inv.qty, 0);
        const shortfall = Math.max(0, ing.quantity - inStock);
        if (shortfall <= 0) continue;
        const existing = needed.get(key);
        if (existing) {
          existing.qty += shortfall;
        } else {
          needed.set(key, {
            qty: shortfall,
            unit: ing.unit,
            price: Math.max(0.5, recipe.cost / Math.max(1, recipe.ingredients.length)),
          });
        }
      }
    }
  }

  return Array.from(needed.entries())
    .slice(0, 30)
    .map(([name, data]) => ({
      id: uid(),
      name,
      qty: Math.round(data.qty),
      unit: data.unit,
      price: Math.round(data.price * 100) / 100,
      store: state.settings?.defaultStore ?? "Mercadona",
      checked: false,
      source: "plan" as const,
    }));
}

/** Ranking de recetas por gramos de proteína por euro (optimizador §9.8). */
export function getProteinRanking(
  state: FoodOSState
): Array<{ id: string; title: string; protein: number; cost: number; proteinPerEuro: number }> {
  return allRecipes(state)
    .filter((r) => r.protein > 0 && r.cost > 0)
    .map((r) => ({
      id: r.id,
      title: r.title,
      protein: r.protein,
      cost: r.cost,
      proteinPerEuro: Math.round((r.protein / r.cost) * 10) / 10,
    }))
    .sort((a, b) => b.proteinPerEuro - a.proteinPerEuro)
    .slice(0, 6);
}

/** Número de días en los últimos 3 en que la proteína consumida fue < 80% del objetivo. */
export function countLowProteinDays(state: FoodOSState): number {
  const target = state.nutrition.protein;
  if (!target) return 0;
  let count = 0;
  const base = state.debugDate ?? todayPlus(0);
  for (let i = 1; i <= 3; i++) {
    const date = dateOffset(base, -i);
    const dayTotal = state.foodLog
      .filter((e) => e.date === date)
      .reduce((sum, e) => sum + e.protein, 0);
    if (dayTotal < target * 0.8) count++;
  }
  return count;
}

/** Movimientos agrupados por mes (últimos N meses) — solo registros explícitos en expenses. */
export function getMonthlyFinanceHistory(
  state: FoodOSState,
  months = 6
): Array<{ month: string; label: string; expenses: number; income: number; savings: number }> {
  const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const now = dateFromKey(getToday(state));
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const monthExpenses = state.expenses
      .filter((e) => e.type === "expense" && e.date.startsWith(monthKey))
      .reduce((s, e) => s + Number(e.amount), 0);
    const monthIncome = state.expenses
      .filter((e) => e.type === "income" && e.date.startsWith(monthKey))
      .reduce((s, e) => s + Number(e.amount), 0);
    return {
      month: monthKey,
      label: MONTH_LABELS[d.getMonth()],
      expenses: Math.round(monthExpenses),
      income: Math.round(monthIncome),
      savings: Math.round(monthIncome - monthExpenses),
    };
  });
}

/** Totales de macros por día en los últimos N días (para gráficas). */
export function getWeeklyMacroHistory(
  state: FoodOSState,
  days = 7
): Array<{ date: string; kcal: number; protein: number; carbs: number; fat: number }> {
  const base = state.debugDate ?? todayPlus(0);
  return Array.from({ length: days }, (_, i) => {
    const date = dateOffset(base, -(days - 1 - i));
    const entries = state.foodLog.filter((e) => e.date === date);
    return {
      date,
      kcal: Math.round(entries.reduce((s, e) => s + e.kcal, 0)),
      protein: Math.round(entries.reduce((s, e) => s + e.protein, 0)),
      carbs: Math.round(entries.reduce((s, e) => s + e.carbs, 0)),
      fat: Math.round(entries.reduce((s, e) => s + e.fat, 0)),
    };
  });
}

/** Por cada uno de los últimos N días, devuelve si se cumplieron los objetivos de macros.
 *  hit: proteína ≥80% target Y kcal entre 80–115% target.
 *  partial: se cumple uno de los dos.
 *  miss: ninguno (o sin datos). */
export function getMacroAdherenceHistory(
  state: FoodOSState,
  days = 28
): Array<{ date: string; status: "hit" | "partial" | "miss" | "empty" }> {
  const targetKcal = state.nutrition.kcal;
  const targetProtein = state.nutrition.protein;
  const base = state.debugDate ?? todayPlus(0);
  return Array.from({ length: days }, (_, i) => {
    const date = dateOffset(base, -(days - 1 - i));
    const entries = state.foodLog.filter((e) => e.date === date);
    if (!entries.length) return { date, status: "empty" };
    const kcal = entries.reduce((s, e) => s + e.kcal, 0);
    const protein = entries.reduce((s, e) => s + e.protein, 0);
    const protOk = targetProtein > 0 && protein >= targetProtein * 0.8;
    const kcalOk = targetKcal > 0 && kcal >= targetKcal * 0.8 && kcal <= targetKcal * 1.15;
    if (protOk && kcalOk) return { date, status: "hit" };
    if (protOk || kcalOk) return { date, status: "partial" };
    return { date, status: "miss" };
  });
}

/** Racha actual: días consecutivos terminando hoy con status "hit". */
export function getAdherenceStreak(state: FoodOSState): number {
  const history = getMacroAdherenceHistory(state, 60);
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].status === "hit") streak++;
    else break;
  }
  return streak;
}

export function expiryBadge(expires: string): { label: string; cls: string } {
  const days = daysUntil(expires);
  if (days < 0)  return { label: "Caducado",      cls: "red pulse" };
  if (days === 0) return { label: "Caduca hoy",   cls: "red" };
  if (days === 1) return { label: "Mañana",       cls: "red" };
  if (days <= 3)  return { label: `${days} días`, cls: "amber" };
  if (days <= 7)  return { label: `${days} días`, cls: "amber-soft" };
  return { label: `${days} días`, cls: "green" };
}

// ---------- Generador local de recetas IA (simula Gemini, PDF §15) ----------
// Usa el contexto real del usuario: inventario (priorizando lo que caduca),
// macros pendientes del dia y presupuesto. En produccion esto es una API
// route que llama a Gemini con el prompt del PDF §15.6.

export function buildAiRecipeDraft(state: FoodOSState): Recipe | null {
  const pending = getPendingMacros(state);
  const usable = state.inventory
    .filter((item) => item.qty > 0)
    .filter((item) => {
      const excluded = state.profile?.excludedFoods ?? [];
      const allergies = state.profile?.allergies ?? [];
      const name = item.name.toLowerCase();
      return ![...excluded, ...allergies].some((bad) => bad && name.includes(bad.toLowerCase()));
    })
    .sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires) || b.protein - a.protein);

  if (!usable.length) return null;

  // Fuente proteica = mayor proteina/100g; acompañantes = lo que antes caduque.
  const proteinSource = [...usable].sort((a, b) => b.protein - a.protein)[0];
  const sides = usable.filter((item) => item.id !== proteinSource.id).slice(0, 2);

  const targetProtein = pending.protein > 0 ? Math.min(pending.protein, 60) : 35;
  const targetKcal = pending.kcal > 0 ? Math.min(pending.kcal, 950) : 550;

  // Gramos de la fuente proteica para cubrir la proteina objetivo (max 300 g).
  const proteinGrams =
    proteinSource.protein > 0
      ? Math.min(300, Math.round((targetProtein / proteinSource.protein) * 100))
      : 150;

  const ingredients = [
    { name: proteinSource.name.toLowerCase(), quantity: proteinGrams, unit: "g" },
    ...sides.map((item) => ({
      name: item.name.toLowerCase(),
      quantity: item.unit === "ud" ? 1 : Math.min(150, item.qty),
      unit: item.unit === "ud" ? "ud" : "g",
    })),
  ];

  // Macros estimados desde los datos reales del inventario.
  const macrosOf = (item: typeof proteinSource, grams: number) => ({
    kcal: (item.kcal * grams) / 100,
    protein: (item.protein * grams) / 100,
  });
  let kcal = macrosOf(proteinSource, proteinGrams).kcal;
  let protein = macrosOf(proteinSource, proteinGrams).protein;
  sides.forEach((item) => {
    const grams = item.unit === "ud" ? (item.unitSize ?? 60) : Math.min(150, item.qty);
    kcal += (item.kcal * grams) / 100;
    protein += (item.protein * grams) / 100;
  });
  kcal = Math.round(Math.min(kcal, targetKcal * 1.2));
  protein = Math.round(protein);
  const fat = Math.round((kcal * 0.25) / 9);
  const carbs = Math.round(Math.max(0, kcal - protein * 4 - fat * 9) / 4);

  const cost = Math.round(
    Math.min(
      getBudgetLeft(state) || 3,
      [proteinSource, ...sides].reduce((sum, item) => sum + Math.min(item.price, 2.5), 0)
    ) * 100
  ) / 100;

  return {
    id: uid(),
    title: `${proteinSource.name} con ${sides.map((s) => s.name.toLowerCase()).join(" y ") || "guarnición"}`,
    ingredients,
    kcal,
    protein,
    carbs,
    fat,
    cost: Math.max(0.8, cost),
    image: "/images/recipe-chicken-bowl.webp",
    time: 20,
    servings: 1,
    difficulty: "IA",
    tags: ["IA", "aprovechamiento", ...(pending.protein > 30 ? ["alta proteína"] : [])],
    steps: [
      `Cocina ${proteinGrams} g de ${proteinSource.name.toLowerCase()} a la plancha con especias.`,
      sides.length
        ? `Prepara ${sides.map((s) => s.name.toLowerCase()).join(" y ")} como acompañamiento.`
        : "Añade la guarnición que prefieras de tu despensa.",
      "Emplata y ajusta la ración a tus macros pendientes.",
    ],
    aiGenerated: true,
  };
}

// ---------- Acciones de dominio (operan sobre el draft de mutate) ----------

/** Núcleo compartido de returnQtyToInventory/returnIngredientsToInventory: busca
    el item por id (si se indica) o por nombre, le suma qty, o lo recrea desde
    el snapshot si ya no existe.

    `allowRecreate` distingue las dos intenciones (ver #3 del QA):
    - BORRAR una entrada del diario = "esto no pasó" → reversión total, recrea
      el lote si se había agotado/borrado (allowRecreate=true).
    - EDITAR una entrada A LA BAJA = "comí menos de lo que apunté" → solo rellena
      lotes que aún existen; NO resucita un item que borraste a mano
      (allowRecreate=false), que sería sorprendente. */
function restoreInventoryQty(
  draft: FoodOSState,
  params: { inventoryItemId?: string; name: string; qty: number; unit: string; snapshot?: InventorySnapshot; allowRecreate?: boolean }
): boolean {
  const { inventoryItemId, name, qty, unit, snapshot, allowRecreate = true } = params;
  if (qty <= 0) return false;
  const byId = inventoryItemId ? draft.inventory.find((item) => item.id === inventoryItemId) : undefined;
  const target = byId ?? draft.inventory.find((item) => namesMatch(item.name, name));
  if (target) {
    target.qty = Math.round((target.qty + qty) * 100) / 100;
    return true;
  }
  if (allowRecreate && snapshot) {
    draft.inventory.push({ id: uid(), name, qty, unit, ...snapshot });
    return true;
  }
  return false;
}

export const actions = {
  /** Descarta una sugerencia de stock bajo; desaparece hasta que se re-añade al inventario. */
  dismissSuggestion(draft: FoodOSState, name: string) {
    draft.dismissedSuggestions ??= [];
    const lower = name.toLowerCase();
    if (!draft.dismissedSuggestions.some((n) => n.toLowerCase() === lower)) {
      draft.dismissedSuggestions.push(name);
    }
  },

  /** Registra una receta cocinada; ratio = escala de la porcion (1 = racion base). */
  cookRecipe(draft: FoodOSState, recipe: Recipe, ratio = 1, opts?: { deductIngredients?: boolean; mealType?: MealType; qtyOverrides?: Record<string, number>; date?: string }) {
    const t = nowTime();
    const consumedIngredients: NonNullable<FoodLogEntry["consumedIngredients"]> = [];

    if (opts?.deductIngredients) {
      for (const ing of recipe.ingredients) {
        const needed = opts?.qtyOverrides?.[ing.name] ?? ing.quantity * ratio;
        const matches = draft.inventory
          .filter((item) => namesMatch(item.name, ing.name))
          .sort((a, b) => a.expires.localeCompare(b.expires)); // FIFO: lotes más próximos a caducar primero
        let remaining = needed;
        for (const match of matches) {
          if (remaining <= 0) break;
          const take = Math.min(match.qty, remaining);
          match.qty = Math.round((match.qty - take) * 100) / 100;
          remaining -= take;
          consumedIngredients.push({
            inventoryItemId: match.id,
            name: match.name,
            qty: take,
            unit: match.unit,
            snapshot: {
              storage: match.storage, expires: match.expires, price: match.price,
              kcal: match.kcal, protein: match.protein, carbs: match.carbs, fat: match.fat,
              salt: match.salt, fiber: match.fiber, sugars: match.sugars, unitSize: match.unitSize,
            },
          });
        }
      }
      draft.inventory = draft.inventory.filter((item) => item.qty > 0);
    }

    draft.foodLog.push({
      id: uid(),
      date: opts?.date ?? getToday(draft),
      time: t,
      name: ratio === 1 ? recipe.title : `${recipe.title} (×${Math.round(ratio * 100) / 100})`,
      qty: null,
      unit: null,
      kcal: Math.round(recipe.kcal * ratio),
      protein: Math.round(recipe.protein * ratio * 10) / 10,
      carbs: Math.round(recipe.carbs * ratio * 10) / 10,
      fat: Math.round(recipe.fat * ratio * 10) / 10,
      source: "recipe",
      mealType: opts?.mealType ?? mealTypeFromTime(t),
      ...(consumedIngredients.length > 0 && { consumedIngredients }),
    });
  },

  /** Consume una cantidad PARCIAL de un alimento: registra en el diario y
      descuenta del inventario (si queda 0, lo elimina). */
  consumeInventoryItem(draft: FoodOSState, itemId: string, qty: number, overrideMealType?: MealType) {
    const item = draft.inventory.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const consumed = Math.min(qty, item.qty);
    const macros = macrosForQuantity(item, consumed);
    const t = nowTime();
    draft.foodLog.push({
      id: uid(),
      date: getToday(draft),
      time: t,
      name: item.name,
      qty: consumed,
      unit: item.unit,
      ...macros,
      source: "inventory",
      mealType: overrideMealType ?? mealTypeFromTime(t),
      inventoryItemId: item.id,
      inventorySnapshot: {
        storage: item.storage,
        expires: item.expires,
        price: item.price,
        kcal: item.kcal,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
        salt: item.salt,
        fiber: item.fiber,
        sugars: item.sugars,
        unitSize: item.unitSize,
      },
    });
    item.qty = Math.round((item.qty - consumed) * 100) / 100;
    if (item.qty <= 0) {
      draft.inventory = draft.inventory.filter((candidate) => candidate.id !== itemId);
    }
  },

  /** Devuelve `qty` de una entrada del diario al inventario: si el item original
      sigue existiendo se le suma; si fue eliminado por completo, se recrea desde
      el snapshot guardado al consumir. Devuelve true si pudo devolver algo. */
  returnQtyToInventory(draft: FoodOSState, entry: FoodLogEntry, qty: number, allowRecreate = true): boolean {
    if (qty <= 0) return false;
    return restoreInventoryQty(draft, {
      inventoryItemId: entry.inventoryItemId,
      name: entry.name,
      qty,
      unit: entry.unit ?? "g",
      snapshot: entry.inventorySnapshot,
      allowRecreate,
    });
  },

  /** Igual que returnQtyToInventory pero para una receta cocinada o un plato
      elaborado que descontó de varios items de inventario a la vez (uno por
      ingrediente). Devuelve true si pudo devolver al menos uno. */
  returnIngredientsToInventory(draft: FoodOSState, entry: FoodLogEntry): boolean {
    if (!entry.consumedIngredients?.length) return false;
    let any = false;
    for (const ing of entry.consumedIngredients) {
      const restored = restoreInventoryQty(draft, {
        inventoryItemId: ing.inventoryItemId,
        name: ing.name,
        qty: ing.qty,
        unit: ing.unit,
        snapshot: ing.snapshot,
      });
      any = any || restored;
    }
    return any;
  },

  /** Punto único usado al borrar/limpiar una entrada del diario: devuelve al
      inventario lo que corresponda según el tipo de entrada (consumo directo
      de un item, o receta/plato que descontó de varios). Devuelve true si
      devolvió algo. */
  returnEntryToInventory(draft: FoodOSState, entry: FoodLogEntry): boolean {
    if (entry.source === "inventory" && (entry.qty ?? 0) > 0) {
      return actions.returnQtyToInventory(draft, entry, entry.qty ?? 0);
    }
    if (entry.consumedIngredients?.length) {
      return actions.returnIngredientsToInventory(draft, entry);
    }
    return false;
  },

  addWater(draft: FoodOSState, ml: number) {
    const today = getToday(draft);
    draft.waterLog[today] = Math.max(0, (draft.waterLog[today] ?? 0) + ml);
  },

  /** Registra el peso corporal de hoy (reemplaza si ya hay una entrada para hoy). */
  logWeight(draft: FoodOSState, kg: number) {
    const today = getToday(draft);
    const idx = draft.weightLog.findIndex((e) => e.date === today);
    if (idx >= 0) {
      draft.weightLog[idx].kg = kg;
    } else {
      draft.weightLog.push({ date: today, kg });
    }
  },

  /** Registra el total de pasos de hoy (reemplaza si ya había un valor para hoy). */
  logSteps(draft: FoodOSState, steps: number) {
    const today = getToday(draft);
    draft.stepsLog ??= {};
    draft.stepsLog[today] = Math.max(0, Math.round(steps));
  },

  addRecipeToCart(draft: FoodOSState, recipe: Recipe) {
    recipe.ingredients.forEach((ingredient) => {
      const existing = draft.cart.find(
        (item) => item.name.toLowerCase() === ingredient.name.toLowerCase() && !item.checked
      );
      if (existing) {
        existing.qty += ingredient.quantity;
      } else {
        draft.cart.push({
          id: uid(),
          name: ingredient.name,
          qty: ingredient.quantity,
          unit: ingredient.unit,
          price: Math.max(0.6, recipe.cost / recipe.ingredients.length),
          store: "Mercadona",
          checked: false,
        });
      }
    });
  },

  completeCart(draft: FoodOSState): number {
    const checked = draft.cart.filter((item) => item.checked);
    const total = checked.reduce((sum, item) => sum + Number(item.price), 0);
    if (!checked.length) return 0;
    draft.expenses.push({
      id: uid(),
      type: "expense",
      amount: total,
      category: "Comida",
      description: "Compra completada desde carrito",
      date: getToday(draft),
    });
    checked.forEach((item) => {
      const foodData = findExactFood(item.name);
      const existing = draft.inventory.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
      draft.inventory.push({
        id: uid(),
        name: item.name,
        qty: item.qty,
        unit: item.unit || existing?.unit || foodData?.unit || "g",
        storage: existing?.storage ?? foodData?.storage ?? "Despensa",
        expires: addDaysToDateKey(getToday(draft), existing ? Math.max(7, foodData?.expiryDays ?? 14) : (foodData?.expiryDays ?? 14)),
        price: item.price,
        kcal: existing?.kcal ?? foodData?.kcal ?? 100,
        protein: existing?.protein ?? foodData?.protein ?? 5,
        carbs: existing?.carbs ?? foodData?.carbs,
        fat: existing?.fat ?? foodData?.fat,
        // Sin esto, un item "ud" (ej. lata de 250ml) restockeado vía carrito
        // perdía su tamaño real y volvía a caer en el default de 60.
        unitSize: item.unitSize ?? existing?.unitSize,
        salt: existing?.salt,
        fiber: existing?.fiber,
        sugars: existing?.sugars,
        brand: existing?.brand,
        imageUrl: existing?.imageUrl,
        allergenTags: existing?.allergenTags,
      });
    });
    draft.cart = draft.cart.filter((item) => !item.checked);
    return checked.length;
  },

  moveCheckedToInventory(draft: FoodOSState): number {
    const checked = draft.cart.filter((item) => item.checked);
    checked.forEach((item) => {
      const foodData = findExactFood(item.name);
      const existing = draft.inventory.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
      draft.inventory.push({
        id: uid(),
        name: item.name,
        qty: item.qty,
        unit: item.unit || existing?.unit || foodData?.unit || "g",
        storage: existing?.storage ?? foodData?.storage ?? "Despensa",
        expires: addDaysToDateKey(getToday(draft), existing ? Math.max(7, foodData?.expiryDays ?? 14) : (foodData?.expiryDays ?? 14)),
        price: item.price,
        kcal: existing?.kcal ?? foodData?.kcal ?? 100,
        protein: existing?.protein ?? foodData?.protein ?? 5,
        carbs: existing?.carbs ?? foodData?.carbs,
        fat: existing?.fat ?? foodData?.fat,
        unitSize: item.unitSize ?? existing?.unitSize,
        salt: existing?.salt,
        fiber: existing?.fiber,
        sugars: existing?.sugars,
        brand: existing?.brand,
        imageUrl: existing?.imageUrl,
        allergenTags: existing?.allergenTags,
      });
    });
    draft.cart = draft.cart.filter((item) => !item.checked);
    return checked.length;
  },
};

export function assistantMessage(state: FoodOSState, kind: "ticket" | "bank" | "week" | "optimize"): string {
  const pending = getPendingMacros(state);
  const budgetLeft = getBudgetLeft(state);
  const cheapest = [...allRecipes(state)].sort((a, b) => a.cost / a.protein - b.cost / b.protein)[0];
  const messages = {
    ticket:
      "Ticket demo leído: 18,40 € en Comida. He separado supermercado, fruta y proteína. En producción esto vendría de OCR + Gemini.",
    bank: "Banco demo sincronizado: detecté 3 cargos de supermercado esta semana y actualicé el presupuesto disponible.",
    week: `Plan semanal demo: prioriza ${cheapest.title}, pasta con atún y bowl de pollo. Objetivo: cubrir ${Math.round(pending.protein)} g de proteína pendiente sin pasar de ${eur(budgetLeft)}.`,
    optimize: `Mejor proteína/€ ahora: ${cheapest.title}. Aporta ${cheapest.protein} g por ${eur(cheapest.cost)}.`,
  };
  return messages[kind];
}

export { getMascot };
export { mealTypeFromTime };
