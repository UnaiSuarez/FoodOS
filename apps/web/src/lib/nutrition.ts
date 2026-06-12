import type {
  ActivityLevel,
  DailyTargets,
  GoalMode,
  MacroTotals,
  PhysicalProfile,
  Recipe,
} from "@foodos/types";

// Calculos nutricionales de FoodOS (PDF §9) y escalado de recetas (§5.3).
// Estas formulas son el contrato del producto: no cambiarlas sin actualizar el PDF.

// ---------- TMB y TDEE (§9.2) ----------

/** Formula Mifflin-St Jeor — la mas precisa sin pruebas de laboratorio. */
export function calcTMB(weightKg: number, heightCm: number, age: number, sex: "male" | "female"): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(sex === "male" ? base + 5 : base - 161);
}

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2, // Sin ejercicio, trabajo de oficina
  light: 1.375, // Ejercicio 1-3 dias/semana
  moderate: 1.55, // Ejercicio 3-5 dias/semana (lo mas comun)
  active: 1.725, // Ejercicio intenso 6-7 dias/semana
  very_active: 1.9, // Trabajo fisico + ejercicio diario
};

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: "Sedentario (oficina, sin ejercicio)",
  light: "Ligero (1-3 días/semana)",
  moderate: "Moderado (3-5 días/semana)",
  active: "Activo (6-7 días/semana)",
  very_active: "Muy activo (trabajo físico + ejercicio)",
};

export function calcTDEE(tmb: number, activityLevel: ActivityLevel): number {
  return Math.round(tmb * ACTIVITY_FACTORS[activityLevel]);
}

// ---------- Modos de objetivo (§9.3) ----------

export const GOAL_LABELS: Record<GoalMode, string> = {
  fat_loss: "Pérdida de grasa",
  muscle_gain: "Ganancia muscular",
  recomp: "Recomposición",
  maintain: "Mantenimiento",
};

export const GOAL_DESCRIPTIONS: Record<GoalMode, string> = {
  fat_loss: "−400 kcal/día · ~−0,5 kg de grasa por semana",
  muscle_gain: "+250 kcal/día · ~+0,3 kg de músculo por semana",
  recomp: "Ciclado: +100 kcal días de gym, −200 en descanso",
  maintain: "Calorías de mantenimiento, sin cambio esperado",
};

interface GoalConfig {
  kcalDelta: (isGymDay: boolean) => number;
  proteinPerKg: number;
  fatPct: number;
}

const GOAL_CONFIG: Record<GoalMode, GoalConfig> = {
  fat_loss: { kcalDelta: () => -400, proteinPerKg: 1.8, fatPct: 0.3 },
  muscle_gain: { kcalDelta: () => 250, proteinPerKg: 2.0, fatPct: 0.25 },
  recomp: { kcalDelta: (gym) => (gym ? 100 : -200), proteinPerKg: 2.2, fatPct: 0.25 },
  maintain: { kcalDelta: () => 0, proteinPerKg: 1.6, fatPct: 0.3 },
};

/** ¿Es hoy (o la fecha dada) dia de gym segun el perfil? 0=Dom ... 6=Sab. */
export function isGymDay(profile: PhysicalProfile, date: Date = new Date()): boolean {
  return profile.gymDays.includes(date.getDay());
}

/**
 * Objetivos diarios segun perfil y tipo de dia (§9.3-9.4).
 * La proteina es fija y prioritaria; las grasas son un % del total
 * y los carbohidratos absorben el resto.
 */
export function calcDailyTargets(profile: PhysicalProfile, gymDay: boolean): DailyTargets {
  const config = GOAL_CONFIG[profile.goal];
  const tmb = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
  const tdee = calcTDEE(tmb, profile.activityLevel);
  const kcal = Math.max(1200, tdee + config.kcalDelta(gymDay));

  // Con % graso conocido se afina usando masa magra (PDF §9.1):
  // mas g/kg pero sobre menos kilos — converge al mismo orden de proteina.
  const proteinG =
    profile.bodyFatPct != null
      ? Math.round((config.proteinPerKg + 0.3) * profile.weightKg * (1 - profile.bodyFatPct / 100))
      : Math.round(config.proteinPerKg * profile.weightKg);

  const proteinKcal = proteinG * 4;
  const fatKcal = Math.round(kcal * config.fatPct);
  const carbKcal = Math.max(0, kcal - proteinKcal - fatKcal);

  return {
    kcal,
    protein: proteinG,
    carbs: Math.round(carbKcal / 4),
    fat: Math.round(fatKcal / 9),
    dayType: gymDay ? "gym" : "rest",
  };
}

/** Resumen de calculo para mostrar en la UI. */
export function calcSummary(profile: PhysicalProfile) {
  const tmb = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
  const tdee = calcTDEE(tmb, profile.activityLevel);
  return { tmb, tdee };
}

/** Vista previa del ciclo semanal (7 dias empezando en lunes). */
export function weeklyCycle(profile: PhysicalProfile): Array<{ day: string; targets: DailyTargets }> {
  const names = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  return names.map((day, index) => {
    const weekday = (index + 1) % 7; // lunes=1 ... domingo=0
    return { day, targets: calcDailyTargets(profile, profile.gymDays.includes(weekday)) };
  });
}

// ---------- Escalado de recetas (§5.3) ----------

export interface ScaledRecipe {
  ratio: number;
  servings: number;
  ingredients: Array<{ name: string; quantity: number; unit: string }>;
  macros: MacroTotals;
  cost: number;
}

/** Escala una receta por numero de raciones. */
export function scaleByServings(recipe: Recipe, servings: number): ScaledRecipe {
  return scaleByRatio(recipe, servings / 1);
}

/** Escala una receta a unas kcal objetivo ("necesito 600 kcal en la cena"). */
export function scaleByCalories(recipe: Recipe, targetKcal: number): ScaledRecipe {
  if (recipe.kcal <= 0) return scaleByRatio(recipe, 1);
  return scaleByRatio(recipe, targetKcal / recipe.kcal);
}

export function scaleByRatio(recipe: Recipe, ratio: number): ScaledRecipe {
  const safe = Math.max(0.1, Math.min(6, ratio));
  return {
    ratio: safe,
    servings: Math.round(safe * 100) / 100,
    ingredients: recipe.ingredients.map((ing) => ({
      ...ing,
      quantity: Math.round(ing.quantity * safe * 10) / 10,
    })),
    macros: {
      kcal: Math.round(recipe.kcal * safe),
      protein: Math.round(recipe.protein * safe * 10) / 10,
      carbs: Math.round(recipe.carbs * safe * 10) / 10,
      fat: Math.round(recipe.fat * safe * 10) / 10,
    },
    cost: Math.round(recipe.cost * safe * 100) / 100,
  };
}

// ---------- Proyeccion de ahorro (§8.6) ----------

export interface SavingsProjection {
  months6: number;
  year1: number;
  years5Bank: number; // cuenta corriente (0% interes)
  years5Fund: number; // fondo indexado (~7% anual estimado)
  years10Fund: number;
  /** Meses hasta alcanzar un fondo de emergencia de 3 meses de gastos. */
  emergencyFundMonths: number | null;
}

export function projectSavings(
  monthlyAmount: number,
  monthlyExpenses: number,
  annualRate = 0.07
): SavingsProjection {
  const fv = (m: number, n: number, r: number) =>
    r === 0 ? m * n : m * ((Math.pow(1 + r / 12, n) - 1) / (r / 12));
  return {
    months6: Math.round(fv(monthlyAmount, 6, 0)),
    year1: Math.round(fv(monthlyAmount, 12, 0)),
    years5Bank: Math.round(fv(monthlyAmount, 60, 0)),
    years5Fund: Math.round(fv(monthlyAmount, 60, annualRate)),
    years10Fund: Math.round(fv(monthlyAmount, 120, annualRate)),
    emergencyFundMonths:
      monthlyAmount > 0 ? Math.ceil((monthlyExpenses * 3) / monthlyAmount) : null,
  };
}

/** Importe mensualizado de una fuente de ingreso. */
export function monthlyAmountOf(frequency: "weekly" | "biweekly" | "monthly" | "yearly", amount: number): number {
  switch (frequency) {
    case "weekly":
      return (amount * 52) / 12;
    case "biweekly":
      return (amount * 26) / 12;
    case "yearly":
      return amount / 12;
    default:
      return amount;
  }
}
