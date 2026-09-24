// Nutrition Engine v4, PR3 — constructores de las entradas de `foodLog` que
// escriben los componentes (LogMealModal, HomeView, PlannerView, SettingsView).
// Cada uno reproduce EXACTAMENTE el objeto que el componente construía antes
// (mismos campos, mismos números) y añade solo la procedencia decidida en
// food-log-provenance.ts. Viven aquí, puros y sin React, para poder probar cada
// escritor sin montar el componente; el componente sigue decidiendo el id, la
// fecha y la hora (mismo comportamiento que antes).

import type { FoodLogEntry, MacroTotals, MealType, NutrientKey, NutrientStatus } from "@foodos/types";
import { aiWholeMealProvenance, legacyTotalProvenance, SYNTHETIC_FOOD_LOG_FIELDS } from "./food-log-provenance";

/** Plato compuesto por ingredientes ("Plato" de LogMealModal, `confirmDish`).
    El total de un plato compuesto no conserva la procedencia por ingrediente en
    el estado del formulario: legacy_unlabeled, sin derivarla de ellos (§16.4). */
export function buildDishLogEntry(input: {
  id: string;
  date: string;
  time: string;
  name: string;
  macros: MacroTotals;
  mealType: MealType;
  consumedIngredients: NonNullable<FoodLogEntry["consumedIngredients"]>;
}): FoodLogEntry {
  return {
    id: input.id,
    date: input.date,
    time: input.time,
    name: input.name,
    qty: null,
    unit: null,
    kcal: Math.round(input.macros.kcal),
    protein: Math.round(input.macros.protein * 10) / 10,
    carbs: Math.round(input.macros.carbs * 10) / 10,
    fat: Math.round(input.macros.fat * 10) / 10,
    source: "manual",
    mealType: input.mealType,
    ...(input.consumedIngredients.length > 0 && { consumedIngredients: input.consumedIngredients }),
    ...legacyTotalProvenance(),
  };
}

/** Comida estimada por IA ("Externa" de LogMealModal, `confirmExternal`): total
    de comida completa, nutrientes `estimated`/`unknown` — nunca `known_*`. */
export function buildExternalLogEntry(input: {
  id: string;
  date: string;
  time: string;
  name: string;
  macros: MacroTotals;
  mealType: MealType;
  /** Estados por macro que declaró el estimador (ver ai-inventory.ts) y macros
      que la persona ajustó a mano después (siguen siendo `estimated`). */
  estimate?: { nutrientStatus?: Partial<Record<NutrientKey, NutrientStatus>>; editedFields?: readonly NutrientKey[] };
}): FoodLogEntry {
  return {
    id: input.id,
    date: input.date,
    time: input.time,
    name: input.name,
    qty: null,
    unit: null,
    kcal: input.macros.kcal,
    protein: input.macros.protein,
    carbs: input.macros.carbs,
    fat: input.macros.fat,
    source: "manual",
    mealType: input.mealType,
    ...aiWholeMealProvenance(input.estimate),
  };
}

/** Entrada del planificador registrada en el diario (HomeView "Plan de hoy" y
    el "plato rápido" de PlannerView): receta o plato rápido. Ni `Recipe` ni
    `QuickMeal` conservan de dónde salen sus totales (`macroOverride`, suma
    parcial, ingredientes sin procedencia): legacy_unlabeled. */
export function buildPlanLogEntry(input: {
  id: string;
  date: string;
  time: string;
  title: string;
  macros: MacroTotals;
  mealType: MealType;
}): FoodLogEntry {
  return {
    id: input.id,
    date: input.date,
    time: input.time,
    name: input.title,
    qty: null,
    unit: null,
    kcal: input.macros.kcal,
    protein: input.macros.protein,
    carbs: input.macros.carbs,
    fat: input.macros.fat,
    source: "recipe",
    mealType: input.mealType,
    ...legacyTotalProvenance(),
  };
}

/** Comidas FICTICIAS de `seedHistorico` ("📊 Sembrar 7 días de historial"). */
export const HISTORICAL_SEED_MEALS = [
  { name: "Avena con proteína", kcal: 380, protein: 28, carbs: 52, fat: 8, mealType: "breakfast" as const },
  { name: "Pechuga de pollo con arroz", kcal: 520, protein: 42, carbs: 65, fat: 9, mealType: "lunch" as const },
  { name: "Salmón con verduras", kcal: 440, protein: 38, carbs: 18, fat: 22, mealType: "dinner" as const },
] as const;

const HISTORICAL_SEED_TIMES = ["08:30", "13:30", "20:30"] as const;

/**
 * Entradas a añadir para UNA fecha del historial de demostración. Mismas
 * comidas, horas y guarda de deduplicación por (fecha, nombre) que antes. Todas
 * llevan `synthetic: true` y NINGÚN `nutrientStatus` (design §1.5): son datos
 * inventados por el propio código, no una ingesta real — no aportan
 * nutrientes ni cobertura, y el filtrado por entrada del adaptador las descarta
 * sin reducir la ventana.
 */
export function syntheticSeedMealsForDate(date: string, existing: readonly FoodLogEntry[], newId: () => string): FoodLogEntry[] {
  const out: FoodLogEntry[] = [];
  HISTORICAL_SEED_MEALS.forEach((meal, idx) => {
    if (existing.some((entry) => entry.date === date && entry.name === meal.name)) return;
    out.push({
      id: newId(),
      date,
      time: HISTORICAL_SEED_TIMES[idx],
      qty: null,
      unit: null,
      source: "manual",
      ...meal,
      ...SYNTHETIC_FOOD_LOG_FIELDS,
    });
  });
  return out;
}
