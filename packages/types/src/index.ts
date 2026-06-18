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

export type IncomeFrequency = "weekly" | "biweekly" | "monthly" | "yearly";

/** Fuente de ingreso recurrente (PDF §8.1). */
export interface IncomeSource {
  id: string;
  name: string;
  amount: number;
  frequency: IncomeFrequency;
  /** Dia del mes en que se cobra (1-31), opcional. */
  dayOfMonth: number | null;
  active: boolean;
}

/** Ingrediente de receta con cantidad, para poder escalar (PDF §5.3). */
export interface RecipeIngredient {
  name: string;
  quantity: number;
  unit: string;
}

export interface Recipe {
  id: string;
  title: string;
  ingredients: RecipeIngredient[];
  /** Macros POR RACION */
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Coste por racion en EUR */
  cost: number;
  image: string;
  time: number;
  servings: number;
  difficulty: string;
  tags: string[];
  steps: string[];
  /** true si la genero la IA (PDF §15.7) */
  aiGenerated?: boolean;
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

export type FoodLogSource = "recipe" | "inventory" | "manual";

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

/** Entrada del diario de comidas (espejo de la tabla food_log). */
export interface FoodLogEntry extends MacroTotals {
  id: string;
  /** Fecha ISO yyyy-mm-dd */
  date: string;
  /** Hora HH:mm */
  time: string;
  name: string;
  /** Cantidad consumida (g/ml/ud), si aplica. */
  qty: number | null;
  unit: string | null;
  source: FoodLogSource;
  /** Tipo de comida: se infiere de la hora al registrar (PDF §9.5). */
  mealType: MealType;
}

// ---------- Perfil fisico y objetivos (PDF §9) ----------

export type Sex = "male" | "female";

export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";

export type GoalMode = "fat_loss" | "muscle_gain" | "recomp" | "maintain";

/** Perfil fisico del usuario (PDF §9.1). Todos los campos editables. */
export interface PhysicalProfile {
  age: number;
  sex: Sex;
  heightCm: number;
  weightKg: number;
  /** % de grasa corporal, opcional — afina la proteina usando masa magra. */
  bodyFatPct: number | null;
  activityLevel: ActivityLevel;
  goal: GoalMode;
  /** Dias de gym: 0=Domingo, 1=Lunes ... 6=Sabado (ciclado calorico §9.4). */
  gymDays: number[];
  allergies: string[];
  excludedFoods: string[];
}

/** Objetivo diario de macros. Si hay perfil, se calcula automaticamente. */
export interface NutritionGoal extends MacroTotals {
  mode: GoalMode;
}

export type DayType = "gym" | "rest";

export interface DailyTargets extends MacroTotals {
  dayType: DayType;
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
  incomeSources: IncomeSource[];
  feedPosts: FeedPost[];
  /** Diario de comidas con fecha — la fuente de verdad de lo consumido. */
  foodLog: FoodLogEntry[];
  /** Agua bebida por dia: { "2026-06-12": 1750 } en ml. */
  waterLog: Record<string, number>;
  customRecipes: Recipe[];
  savedRecipeIds: string[];
  /** null hasta completar el onboarding de nutricion. */
  profile: PhysicalProfile | null;
  nutrition: NutritionGoal;
  weeklyBudget: number;
  activeStorage: StorageName | "Todos";
  inventorySearch: string;
  bankSynced: boolean;
  mascotId: string;
  recipeTag: string;
}
