// Texto compartido por las rutas que cocinan/registran una receta en el diario
// (CookModal, RecipeDetailModal, AiRecipeModal, AssistantView, Planificador).
// Solo presentación: ninguna función de aquí escribe estado ni calcula macros.
import type { MealType } from "@foodos/types";
import { dateFromKey, mealTypeFromTime } from "@/lib/utils";

/** Mismos nombres que usa el Registro (DiaryView: «Snack» para el tipo snack). */
export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "Desayuno",
  lunch: "Comida",
  snack: "Snack",
  dinner: "Cena",
};

export interface LogTarget {
  /** Fecha real (YYYY-MM-DD) donde se escribirá la entrada. */
  date: string;
  isToday: boolean;
  /** «hoy» o «miércoles, 15 de octubre». */
  dateLabel: string;
  mealType: MealType;
  mealLabel: string;
  /** true si el tipo de comida sale del reloj (no lo fijó quien llama). */
  mealFromClock: boolean;
}

/**
 * Dónde se registrará la entrada, con los mismos criterios que `cookRecipe`
 * (`opts.date ?? getToday(draft)` y `opts.mealType ?? mealTypeFromTime(hora)`).
 * Nunca asume «hoy, Comida»: si llega fecha o tipo, se usan esos.
 */
export function describeLogTarget(input: {
  today: string;
  date?: string;
  mealType?: MealType;
  /** HH:MM; por defecto, la hora actual del dispositivo. */
  time?: string;
}): LogTarget {
  const date = input.date ?? input.today;
  const isToday = date === input.today;
  const time = input.time ?? new Date().toTimeString().slice(0, 5);
  const mealType = input.mealType ?? mealTypeFromTime(time);
  return {
    date,
    isToday,
    dateLabel: isToday
      ? "hoy"
      : dateFromKey(date).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }),
    mealType,
    mealLabel: MEAL_TYPE_LABELS[mealType],
    mealFromClock: input.mealType === undefined,
  };
}

/** «1 ración», «2 raciones», «1,5 raciones». */
export function servingsLabel(servings: number): string {
  const text = String(Math.round(servings * 100) / 100).replace(".", ",");
  return `${text} ${servings === 1 ? "ración" : "raciones"}`;
}

/** «registrada» / «registradas» según el número de raciones. */
export function registeredWord(servings: number): string {
  return servings === 1 ? "registrada" : "registradas";
}

/**
 * Totales que `actions.cookRecipe` persiste para `ratio` raciones: los de la
 * receta × ratio, con el mismo redondeo que el escritor. NUNCA se derivan de
 * los ingredientes ni de las cantidades editadas. Solo presentación: el
 * escritor es la autoridad y una prueba compara ambos.
 */
export function registeredTotals(recipe: { kcal: number; protein: number; carbs: number; fat: number }, ratio: number) {
  return {
    kcal: Math.round(recipe.kcal * ratio),
    protein: Math.round(recipe.protein * ratio * 10) / 10,
    carbs: Math.round(recipe.carbs * ratio * 10) / 10,
    fat: Math.round(recipe.fat * ratio * 10) / 10,
  };
}

/**
 * Cierre del aviso tras cocinar. Describe la acción pedida con el stock que se
 * veía al confirmar; NO afirma un resultado que el actualizador de React aún no
 * haya producido (el stock puede cambiar por mutaciones encoladas).
 */
export function inventoryOutcome(input: {
  deduct: boolean;
  /** Ingredientes cuyo stock no llegaba (parcial o inexistente) al confirmar. */
  shortCount: number;
}): string {
  if (!input.deduct) return "inventario sin cambios";
  if (input.shortCount > 0) {
    return `se descuenta solo lo disponible (${input.shortCount} ${input.shortCount === 1 ? "ingrediente sin stock suficiente" : "ingredientes sin stock suficiente"})`;
  }
  return "se descuentan los ingredientes del inventario";
}
