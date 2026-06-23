"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import type { AppSettings, DailyTargets, FoodLogEntry, FoodOSState, GoalMode, InventoryItem, MacroTotals, MealType, Recipe, WeightEntry } from "@foodos/types";
import { clearLocalState, loadLocalState, remote, saveLocalState } from "./data-layer";
import { hasSupabaseConfig } from "./supabase";
import { DEMO_RECIPES } from "./recipes";
import { getMascot } from "./mascots";
import { calcDailyTargets, isGymDay, weeklyCycle } from "./nutrition";
import { daysUntil, eur, mealTypeFromTime, todayMinus, todayPlus, uid } from "./utils";

export const DEFAULT_SETTINGS: AppSettings = {
  expiryWarnDays: 3,
  waterGoalMl: 2500,
  dinnerSuggestionHour: 18,
  budgetWarnPct: 80,
  defaultStore: "Mercadona",
  lowStockThresholds: { g: 200, ml: 300, L: 0.5, kg: 0.3, ud: 2 },
  extraExpenseCategories: [],
};

export const defaultState: FoodOSState = {
  inventory: [],
  cart: [],
  expenses: [],
  incomeSources: [],
  feedPosts: [],
  foodLog: [],
  waterLog: {},
  weightLog: [],
  customRecipes: [],
  savedRecipeIds: [],
  profile: null,
  nutrition: { kcal: 2200, protein: 150, carbs: 225, fat: 70, mode: "recomp" },
  weeklyBudget: 70,
  activeStorage: "Todos",
  inventorySearch: "",
  bankSynced: false,
  mascotId: "zana",
  recipeTag: "todos",
  settings: DEFAULT_SETTINGS,
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
  next.foodLog ||= [];
  next.waterLog ||= {};
  next.weightLog ||= [];
  next.settings = { ...DEFAULT_SETTINGS, ...(next.settings ?? {}), lowStockThresholds: { ...DEFAULT_SETTINGS.lowStockThresholds, ...(next.settings?.lowStockThresholds ?? {}) } };
  // Migracion: las comidas antiguas sin fecha (consumedMeals) pasan al diario datado.
  const legacy = next as FoodOSState & { consumedMeals?: Array<MacroTotals & { id: string; name: string }>; consumed?: MacroTotals };
  if (legacy.consumedMeals?.length) {
    legacy.consumedMeals.forEach((meal) => {
      next.foodLog.push({
        id: meal.id || uid(),
        date: todayPlus(0),
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
    const targets = calcDailyTargets(next.profile, isGymDay(next.profile));
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

interface FoodOSContextValue {
  state: FoodOSState;
  hydrated: boolean;
  toast: string;
  mascotMessage: string;
  remoteReady: boolean;
  authUser: User | null;
  showToast: (message: string) => void;
  setMascotMessage: (message: string) => void;
  mutate: (fn: (draft: FoodOSState) => void) => void;
  resetAll: () => void;
  seedDemo: () => void;
}

const FoodOSContext = createContext<FoodOSContextValue | null>(null);

export function FoodOSProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FoodOSState>(defaultState);
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState("");
  const [mascotMessage, setMascotMessage] = useState("Lista para organizar tu comida.");
  const [remoteReady, setRemoteReady] = useState(false);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    void remote.init().then((ok) => {
      if (cancelled || !ok) return;
      setRemoteReady(true);
      remote.onAuthChange((user) => {
        setAuthUser(user);
        if (user) void hydrateRemote();
      });
      if (remote.user) {
        setAuthUser(remote.user);
        void hydrateRemote();
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  }, []);

  // Toda mutacion pasa por aqui: clona, aplica, persiste (local + remoto).
  const mutate = useCallback((fn: (draft: FoodOSState) => void) => {
    setState((current) => {
      const draft = structuredClone(current);
      fn(draft);
      // Si hay perfil, los objetivos del dia siempre derivan de el.
      if (draft.profile) {
        const targets = calcDailyTargets(draft.profile, isGymDay(draft.profile));
        draft.nutrition = {
          kcal: targets.kcal,
          protein: targets.protein,
          carbs: targets.carbs,
          fat: targets.fat,
          mode: draft.profile.goal,
        };
      }
      saveLocalState(draft);
      remote.schedulePush(draft);
      return draft;
    });
  }, []);

  const resetAll = useCallback(() => {
    clearLocalState();
    setState(structuredClone(defaultState));
    showToast("Datos locales borrados");
  }, [showToast]);

  const seedDemo = useCallback(() => {
    const demo = structuredClone(defaultState);
    demo.inventory = [
      { id: uid(), name: "Pechuga de pollo", qty: 260, unit: "g", storage: "Nevera", expires: todayPlus(1), price: 2.8, kcal: 120, protein: 23 },
      { id: uid(), name: "Arroz integral", qty: 500, unit: "g", storage: "Despensa", expires: todayPlus(60), price: 1.7, kcal: 360, protein: 8 },
      { id: uid(), name: "Tomate cherry", qty: 180, unit: "g", storage: "Nevera", expires: todayPlus(3), price: 1.4, kcal: 18, protein: 1 },
      { id: uid(), name: "Yogur griego", qty: 1, unit: "ud", storage: "Nevera", expires: todayPlus(2), price: 0.9, kcal: 95, protein: 10 },
      { id: uid(), name: "Huevos", qty: 6, unit: "ud", storage: "Nevera", expires: todayPlus(12), price: 1.8, kcal: 155, protein: 13 },
    ];
    demo.cart = [{ id: uid(), name: "Avena", qty: 1, unit: "ud", price: 1.4, store: "Mercadona", checked: false }];
    demo.incomeSources = [
      { id: uid(), name: "Nómina", amount: 1450, frequency: "monthly", dayOfMonth: 28, active: true },
    ];
    demo.expenses = [
      { id: uid(), type: "expense", amount: 38.4, category: "Comida", description: "Mercadona demo", date: todayMinus(1) },
      { id: uid(), type: "expense", amount: 22.5, category: "Comida", description: "Frutería demo", date: todayMinus(5) },
      { id: uid(), type: "expense", amount: 24.2, category: "Salud", description: "Suplementos demo", date: todayMinus(10) },
      { id: uid(), type: "expense", amount: 47.9, category: "Comida", description: "Lidl demo", date: todayMinus(16) },
      { id: uid(), type: "expense", amount: 19.6, category: "Ocio", description: "Cena fuera demo", date: todayMinus(23) },
      { id: uid(), type: "expense", amount: 620, category: "Vivienda", description: "Alquiler demo", date: todayMinus(12) },
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

  return (
    <FoodOSContext.Provider
      value={{
        state,
        hydrated,
        toast,
        mascotMessage,
        remoteReady,
        authUser,
        showToast,
        setMascotMessage,
        mutate,
        resetAll,
        seedDemo,
      }}
    >
      {children}
    </FoodOSContext.Provider>
  );
}

export function useFoodOS(): FoodOSContextValue {
  const context = useContext(FoodOSContext);
  if (!context) throw new Error("useFoodOS debe usarse dentro de <FoodOSProvider>");
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

export function getRecipeMatch(state: FoodOSState, recipe: Recipe) {
  const names = state.inventory.map((item) => item.name.toLowerCase());
  const matches = recipe.ingredients.filter((ingredient) =>
    names.some((name) => name.includes(ingredient.name.split(" ")[0]) || ingredient.name.includes(name.split(" ")[0]))
  );
  return { matches, pct: Math.round((matches.length / Math.max(1, recipe.ingredients.length)) * 100) };
}

export function getIngredientStatus(state: FoodOSState, recipe: Recipe) {
  const names = state.inventory.map((item) => item.name.toLowerCase());
  return recipe.ingredients.map((ingredient) => ({
    name: ingredient.name,
    quantity: ingredient.quantity,
    unit: ingredient.unit,
    has: names.some(
      (name) => name.includes(ingredient.name.split(" ")[0]) || ingredient.name.includes(name.split(" ")[0])
    ),
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
  const today = todayPlus(0);
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
  return state.waterLog[todayPlus(0)] ?? 0;
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
      entries: entries.sort((a, b) => a.time.localeCompare(b.time)),
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

/** Macros que quedan por consumir hoy. */
export function getPendingMacros(state: FoodOSState): MacroTotals {
  const consumed = getConsumedToday(state);
  return {
    kcal: Math.max(0, state.nutrition.kcal - consumed.kcal),
    protein: Math.max(0, state.nutrition.protein - consumed.protein),
    carbs: Math.max(0, state.nutrition.carbs - consumed.carbs),
    fat: Math.max(0, state.nutrition.fat - consumed.fat),
  };
}

/** Macros de una cantidad concreta de un alimento del inventario.
    Carbos y grasas se estiman (el inventario solo guarda kcal y proteina por 100). */
export function macrosForQuantity(item: InventoryItem, qty: number): MacroTotals {
  const grams = item.unit === "kg" ? qty * 1000 : item.unit === "ud" ? qty * 60 : qty;
  const kcal = (item.kcal * grams) / 100;
  const protein = (item.protein * grams) / 100;
  const fat = Math.max(0, (kcal * 0.25) / 9);
  const carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
  return {
    kcal: Math.round(kcal),
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fat: Math.round(fat * 10) / 10,
  };
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
        r.ingredients.some(
          (ing) =>
            item.name.toLowerCase().includes(ing.name.split(" ")[0]) ||
            ing.name.includes(item.name.toLowerCase().split(" ")[0])
        )
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

  return Array.from({ length: 7 }, (_, i) => {
    const date = todayPlus(i);
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
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);
  return state.expenses
    .filter((expense) => expense.type === "expense" && expense.category === "Comida")
    .filter((expense) => new Date(expense.date || Date.now()) >= weekAgo)
    .reduce((sum, expense) => sum + Number(expense.amount), 0);
}

export function getBudgetLeft(state: FoodOSState): number {
  return Math.max(0, Number(state.weeklyBudget) - getFoodSpend(state));
}

/** Items del inventario casi vacíos que no están pendientes ya en el carrito. */
export function getLowStockSuggestions(state: FoodOSState): import("@foodos/types").CartItem[] {
  const thresholds = state.settings?.lowStockThresholds ?? DEFAULT_SETTINGS.lowStockThresholds;
  const inCart = new Set(
    state.cart.filter((i) => !i.checked).map((i) => i.name.toLowerCase())
  );
  return state.inventory
    .filter((item) => {
      const threshold = (thresholds as Record<string, number>)[item.unit] ?? 100;
      return item.qty <= threshold && !inCart.has(item.name.toLowerCase());
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
          .filter((inv) => {
            const n = inv.name.toLowerCase();
            return n.includes(key.split(" ")[0]) || key.includes(n.split(" ")[0]);
          })
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

export function expiryBadge(expires: string): { label: string; cls: string } {
  const days = daysUntil(expires);
  if (days < 0) return { label: "Caducado", cls: "red" };
  if (days <= 1) return { label: "Urgente", cls: "red" };
  if (days <= 3) return { label: `${days} días`, cls: "amber" };
  return { label: "OK", cls: "green" };
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
    const grams = item.unit === "ud" ? 60 : Math.min(150, item.qty);
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

export const actions = {
  /** Registra una receta cocinada; ratio = escala de la porcion (1 = racion base). */
  cookRecipe(draft: FoodOSState, recipe: Recipe, ratio = 1) {
    const t = nowTime();
    draft.foodLog.push({
      id: uid(),
      date: todayPlus(0),
      time: t,
      name: ratio === 1 ? recipe.title : `${recipe.title} (×${Math.round(ratio * 100) / 100})`,
      qty: null,
      unit: null,
      kcal: Math.round(recipe.kcal * ratio),
      protein: Math.round(recipe.protein * ratio * 10) / 10,
      carbs: Math.round(recipe.carbs * ratio * 10) / 10,
      fat: Math.round(recipe.fat * ratio * 10) / 10,
      source: "recipe",
      mealType: mealTypeFromTime(t),
    });
  },

  /** Consume una cantidad PARCIAL de un alimento: registra en el diario y
      descuenta del inventario (si queda 0, lo elimina). */
  consumeInventoryItem(draft: FoodOSState, itemId: string, qty: number) {
    const item = draft.inventory.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const consumed = Math.min(qty, item.qty);
    const macros = macrosForQuantity(item, consumed);
    const t = nowTime();
    draft.foodLog.push({
      id: uid(),
      date: todayPlus(0),
      time: t,
      name: item.name,
      qty: consumed,
      unit: item.unit,
      ...macros,
      source: "inventory",
      mealType: mealTypeFromTime(t),
    });
    item.qty = Math.round((item.qty - consumed) * 100) / 100;
    if (item.qty <= 0) {
      draft.inventory = draft.inventory.filter((candidate) => candidate.id !== itemId);
    }
  },

  addWater(draft: FoodOSState, ml: number) {
    const today = todayPlus(0);
    draft.waterLog[today] = Math.max(0, (draft.waterLog[today] ?? 0) + ml);
  },

  /** Registra el peso corporal de hoy (reemplaza si ya hay una entrada para hoy). */
  logWeight(draft: FoodOSState, kg: number) {
    const today = todayPlus(0);
    const idx = draft.weightLog.findIndex((e) => e.date === today);
    if (idx >= 0) {
      draft.weightLog[idx].kg = kg;
    } else {
      draft.weightLog.push({ date: today, kg });
    }
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
      date: todayPlus(0),
    });
    checked.forEach((item) => {
      draft.inventory.push({
        id: uid(),
        name: item.name,
        qty: item.qty,
        unit: item.unit,
        storage: "Despensa",
        expires: todayPlus(14),
        price: item.price,
        kcal: 100,
        protein: 5,
      });
    });
    draft.cart = draft.cart.filter((item) => !item.checked);
    return checked.length;
  },

  moveCheckedToInventory(draft: FoodOSState): number {
    const checked = draft.cart.filter((item) => item.checked);
    checked.forEach((item) => {
      draft.inventory.push({
        id: uid(),
        name: item.name,
        qty: item.qty,
        unit: item.unit,
        storage: "Despensa",
        expires: todayPlus(14),
        price: item.price,
        kcal: 100,
        protein: 5,
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
