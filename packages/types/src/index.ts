// Tipos compartidos de FoodOS.
// Los usan apps/web hoy, y apps/mobile y apps/desktop en el futuro.
// Reflejan el modelo de datos de supabase/schema.sql (ver docs/data-model.md).

export type StorageName = "Nevera" | "Congelador" | "Despensa";

export interface InventoryItem {
  id: string;
  name: string;
  qty: number;
  unit: string;
  storage: StorageName;
  /** Fecha ISO yyyy-mm-dd */
  expires: string;
  price: number;
  /** kcal por 100 g */
  kcal: number;
  /** Proteina por 100 g */
  protein: number;
}

export interface CartItem {
  id: string;
  name: string;
  qty: number;
  unit: string;
  price: number;
  store: string;
  checked: boolean;
}

export type MovementType = "expense" | "income";

export interface Movement {
  id: string;
  type: MovementType;
  amount: number;
  category: string;
  description: string;
  /** Fecha ISO yyyy-mm-dd */
  date: string;
}

export interface Recipe {
  id: string;
  title: string;
  ingredients: string[];
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  cost: number;
  image: string;
  time: number;
  servings: number;
  difficulty: string;
  tags: string[];
  steps: string[];
}

export interface FeedComment {
  author: string;
  text: string;
}

export interface FeedPost {
  id: string;
  recipeId: string;
  author: string;
  title: string;
  caption: string;
  likes: number;
  comments: FeedComment[];
}

export interface MacroTotals {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface ConsumedMeal extends MacroTotals {
  id: string;
  icon: string;
  name: string;
}

export type NutritionMode =
  | "Recomposicion"
  | "Perdida de grasa"
  | "Ganancia muscular"
  | "Mantenimiento";

export interface NutritionGoal extends MacroTotals {
  mode: NutritionMode;
}

export interface Mascot {
  id: string;
  name: string;
  color: string;
  tagline: string;
  image: string;
}

/** Estado completo de la app. Se persiste en localStorage y se sincroniza con Supabase. */
export interface FoodOSState {
  inventory: InventoryItem[];
  cart: CartItem[];
  expenses: Movement[];
  feedPosts: FeedPost[];
  consumed: MacroTotals;
  consumedMeals: ConsumedMeal[];
  customRecipes: Recipe[];
  savedRecipeIds: string[];
  nutrition: NutritionGoal;
  weeklyBudget: number;
  activeStorage: StorageName | "Todos";
  inventorySearch: string;
  bankSynced: boolean;
  mascotId: string;
  recipeTag: string;
}
