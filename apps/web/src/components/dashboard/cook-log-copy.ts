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

/** Cierre del aviso tras cocinar, según la opción elegida y lo que faltaba. */
export function inventoryOutcome(input: {
  deduct: boolean;
  /** Ingredientes cuyo stock no llegaba (parcial o inexistente) al confirmar. */
  shortCount: number;
  /** Lotes del inventario que `cookRecipe` realmente tocó. */
  lotsTouched: number;
}): string {
  if (!input.deduct) return "inventario sin cambios";
  if (input.shortCount > 0) {
    return `descontado solo lo disponible (${input.shortCount} ${input.shortCount === 1 ? "ingrediente sin stock suficiente" : "ingredientes sin stock suficiente"})`;
  }
  if (input.lotsTouched === 0) return "no había ingredientes que descontar";
  return "ingredientes descontados";
}
