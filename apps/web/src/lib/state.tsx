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
import type { FoodOSState, Recipe } from "@foodos/types";
import { clearLocalState, loadLocalState, remote, saveLocalState } from "./data-layer";
import { hasSupabaseConfig } from "./supabase";
import { DEMO_RECIPES } from "./recipes";
import { getMascot } from "./mascots";
import { daysUntil, eur, todayMinus, todayPlus, uid } from "./utils";

export const defaultState: FoodOSState = {
  inventory: [],
  cart: [],
  expenses: [],
  feedPosts: [],
  consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  consumedMeals: [],
  customRecipes: [],
  savedRecipeIds: [],
  nutrition: { kcal: 2200, protein: 150, carbs: 225, fat: 70, mode: "Recomposicion" },
  weeklyBudget: 70,
  activeStorage: "Todos",
  inventorySearch: "",
  bankSynced: false,
  mascotId: "zana",
  recipeTag: "todos",
};

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
    setState(loadLocalState(defaultState));
    setHydrated(true);

    if (!hasSupabaseConfig()) return;
    let cancelled = false;

    const hydrateRemote = async () => {
      try {
        await remote.ensureBaseRows();
        const remoteState = await remote.pullState(defaultState);
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
    ];
    demo.cart = [{ id: uid(), name: "Huevos", qty: 6, unit: "ud", price: 2.2, store: "Mercadona", checked: false }];
    demo.expenses = [
      { id: uid(), type: "income", amount: 1200, category: "Ahorro", description: "Nómina demo", date: todayPlus(0) },
      { id: uid(), type: "expense", amount: 38.4, category: "Comida", description: "Mercadona demo", date: todayMinus(1) },
      { id: uid(), type: "expense", amount: 22.5, category: "Comida", description: "Frutería demo", date: todayMinus(5) },
      { id: uid(), type: "expense", amount: 24.2, category: "Salud", description: "Suplementos demo", date: todayMinus(10) },
      { id: uid(), type: "expense", amount: 47.9, category: "Comida", description: "Lidl demo", date: todayMinus(16) },
      { id: uid(), type: "expense", amount: 19.6, category: "Ocio", description: "Cena fuera demo", date: todayMinus(23) },
    ];
    demo.feedPosts = buildDemoPosts();
    saveLocalState(demo);
    remote.schedulePush(demo);
    setState(demo);
    setMascotMessage("Datos demo cargados. Prueba a cocinar o completar el carrito.");
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
  const matches = recipe.ingredients.filter((ingredient) => names.some((name) => name.includes(ingredient)));
  return { matches, pct: Math.round((matches.length / recipe.ingredients.length) * 100) };
}

export function getIngredientStatus(state: FoodOSState, recipe: Recipe) {
  const names = state.inventory.map((item) => item.name.toLowerCase());
  return recipe.ingredients.map((ingredient) => ({
    name: ingredient,
    has: names.some((name) => name.includes(ingredient) || ingredient.includes(name.split(" ")[0])),
  }));
}

export function bestRecipe(state: FoodOSState): Recipe {
  return [...allRecipes(state)].sort(
    (a, b) => getRecipeMatch(state, b).pct - getRecipeMatch(state, a).pct || b.protein - a.protein
  )[0];
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

export function expiryBadge(expires: string): { label: string; cls: string } {
  const days = daysUntil(expires);
  if (days < 0) return { label: "Caducado", cls: "red" };
  if (days <= 1) return { label: "Urgente", cls: "red" };
  if (days <= 3) return { label: `${days} días`, cls: "amber" };
  return { label: "OK", cls: "green" };
}

// ---------- Acciones de dominio (operan sobre el draft de mutate) ----------

export const actions = {
  cookRecipe(draft: FoodOSState, recipe: Recipe) {
    draft.consumed.kcal += recipe.kcal;
    draft.consumed.protein += recipe.protein;
    draft.consumed.carbs += recipe.carbs;
    draft.consumed.fat += recipe.fat;
    draft.consumedMeals.push({
      id: uid(),
      icon: "🍽",
      name: recipe.title,
      kcal: recipe.kcal,
      protein: recipe.protein,
      carbs: recipe.carbs,
      fat: recipe.fat,
    });
  },

  addRecipeToCart(draft: FoodOSState, recipe: Recipe) {
    recipe.ingredients.forEach((ingredient) => {
      const existing = draft.cart.find(
        (item) => item.name.toLowerCase() === ingredient.toLowerCase() && !item.checked
      );
      if (existing) {
        existing.qty += 1;
      } else {
        draft.cart.push({
          id: uid(),
          name: ingredient,
          qty: 1,
          unit: "ud",
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

  generateAiRecipe(draft: FoodOSState) {
    const top = draft.inventory.slice(0, 3);
    const names = top.map((item) => item.name).join(", ") || "ingredientes disponibles";
    draft.customRecipes.unshift({
      id: uid(),
      title: `Receta rápida con ${names}`,
      ingredients: top.map((item) => item.name.toLowerCase().split(" ")[0]).filter(Boolean),
      kcal: 520,
      protein: 38,
      carbs: 55,
      fat: 16,
      cost: 2.6,
      image: "/images/recipe-chicken-bowl.webp",
      time: 18,
      servings: 1,
      difficulty: "IA local",
      tags: ["IA", "rápida", "aprovechamiento"],
      steps: [
        "Revisa los ingredientes detectados en tu inventario.",
        "Saltea la base proteica con verduras.",
        "Ajusta la porción y guarda la receta si te encaja.",
      ],
    });
  },
};

export function assistantMessage(state: FoodOSState, kind: "ticket" | "bank" | "week" | "optimize"): string {
  const proteinLeft = Math.max(0, state.nutrition.protein - state.consumed.protein);
  const budgetLeft = getBudgetLeft(state);
  const cheapest = [...allRecipes(state)].sort((a, b) => a.cost / a.protein - b.cost / b.protein)[0];
  const messages = {
    ticket:
      "Ticket demo leído: 18,40 € en Comida. He separado supermercado, fruta y proteína. En producción esto vendría de OCR + Gemini.",
    bank: "Banco demo sincronizado: detecté 3 cargos de supermercado esta semana y actualicé el presupuesto disponible.",
    week: `Plan semanal demo: prioriza ${cheapest.title}, pasta con atún y bowl de pollo. Objetivo: cubrir ${Math.round(proteinLeft)} g de proteína pendiente sin pasar de ${eur(budgetLeft)}.`,
    optimize: `Mejor proteína/€ ahora: ${cheapest.title}. Aporta ${cheapest.protein} g por ${eur(cheapest.cost)}.`,
  };
  return messages[kind];
}

export { getMascot };
