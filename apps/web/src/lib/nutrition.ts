import type {
  ActivityLevel,
  DailyTargets,
  GoalMode,
  MacroTotals,
  PhysicalProfile,
  Recipe,
} from "@foodos/types";

// ─── TMB / TDEE (Mifflin-St Jeor) ───────────────────────────────────────────

/** Metabolismo basal. Mifflin-St Jeor: la más precisa sin laboratorio. */
export function calcTMB(
  weightKg: number,
  heightCm: number,
  age: number,
  sex: "male" | "female",
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(sex === "male" ? base + 5 : base - 161);
}

/**
 * Factores de actividad ajustados.
 * Los factores clásicos (1.2–1.9) sobreestiman en personas sedentarias con
 * algo de ejercicio. Se reducen ligeramente para compensar.
 */
export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary:   1.2,   // Oficina, sin ejercicio real
  light:       1.375, // 1-3 días/semana de ejercicio suave
  moderate:    1.45,  // 3-5 días/semana + vida poco activa fuera del gym
  active:      1.65,  // 6-7 días/semana o trabajo físico + gym
  very_active: 1.9,   // Trabajo físico intenso + ejercicio diario
};

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary:   "Sedentario (oficina, sin ejercicio)",
  light:       "Ligero (1-3 días/semana)",
  moderate:    "Moderado (3-5 días/semana)",
  active:      "Activo (6-7 días/semana o trabajo físico)",
  very_active: "Muy activo (trabajo físico + ejercicio diario)",
};

export function calcTDEE(tmb: number, activityLevel: ActivityLevel): number {
  return Math.round(tmb * ACTIVITY_FACTORS[activityLevel]);
}

// ─── IMC ─────────────────────────────────────────────────────────────────────

export function calcIMC(weightKg: number, heightCm: number): number {
  const h = heightCm / 100;
  return Math.round((weightKg / (h * h)) * 10) / 10;
}

export function imcLabel(imc: number): string {
  if (imc < 18.5) return "Bajo peso";
  if (imc < 25)   return "Normopeso";
  if (imc < 30)   return "Sobrepeso";
  if (imc < 35)   return "Obesidad I";
  if (imc < 40)   return "Obesidad II";
  return "Obesidad III";
}

// ─── Peso base para proteína (ESPEN + ISSN) ──────────────────────────────────

/**
 * Calcula el peso de referencia para proteína:
 * - Con % grasa conocido: masa magra (Katch-McArdle style)
 * - Con obesidad (peso > IMC 25 × 1.25): peso ajustado ESPEN
 *   adjusted = peso_ideal + (peso_actual - peso_ideal) × 0.33
 * - En los demás casos: peso actual
 *
 * Si hay peso objetivo sensato, se usa el mínimo entre ajustado y objetivo.
 */
export function calcProteinBase(profile: PhysicalProfile): number {
  if (profile.bodyFatPct != null) {
    return profile.weightKg * (1 - profile.bodyFatPct / 100);
  }

  const heightM = profile.heightCm / 100;
  const idealWeight = 25 * heightM * heightM; // IMC 25

  if (profile.weightKg > idealWeight * 1.25) {
    const adjusted = idealWeight + (profile.weightKg - idealWeight) * 0.33;
    if (
      profile.targetWeightKg &&
      profile.targetWeightKg >= idealWeight * 0.85 &&
      profile.targetWeightKg < profile.weightKg
    ) {
      return Math.min(profile.targetWeightKg, adjusted);
    }
    return adjusted;
  }

  return profile.weightKg;
}

// ─── Modos de objetivo ───────────────────────────────────────────────────────

export const GOAL_LABELS: Record<GoalMode, string> = {
  fat_loss:    "Pérdida de grasa",
  muscle_gain: "Ganancia muscular",
  recomp:      "Recomposición",
  maintain:    "Mantenimiento",
};

export const GOAL_DESCRIPTIONS: Record<GoalMode, string> = {
  fat_loss:    "−20% kcal · proteína alta · ~−0,5–1 kg/semana",
  muscle_gain: "+8% kcal · proteína alta · ~+0,25 kg/semana",
  recomp:      "−10% días gym / −20% descanso · proteína muy alta",
  maintain:    "Kcal de mantenimiento · sin cambio esperado",
};

interface GoalConfig {
  /** Multiplicador sobre el TDEE. Sustituye al delta fijo anterior. */
  kcalFactor: (isGymDay: boolean) => number;
  /** g/kg aplicado sobre calcProteinBase(). */
  proteinPerKg: number;
  /** Fracción de kcal totales destinada a grasa (20–30%). */
  fatPct: number;
}

/**
 * Configuración por objetivo.
 *
 * fat_loss:    80% TDEE  → déficit ~20% → ~0.5–1 kg/semana
 * muscle_gain: 108% TDEE → superávit ~8%
 * recomp:      ciclado: 90% días gym / 80% descanso
 * maintain:    100% TDEE
 *
 * Proteína sobre peso AJUSTADO para obesidad (calcProteinBase).
 */
const GOAL_CONFIG: Record<GoalMode, GoalConfig> = {
  fat_loss:    { kcalFactor: ()      => 0.80,       proteinPerKg: 2.2, fatPct: 0.25 },
  muscle_gain: { kcalFactor: ()      => 1.08,       proteinPerKg: 2.0, fatPct: 0.25 },
  recomp:      { kcalFactor: (gym)   => gym ? 0.90 : 0.80, proteinPerKg: 2.2, fatPct: 0.25 },
  maintain:    { kcalFactor: ()      => 1.0,        proteinPerKg: 1.8, fatPct: 0.28 },
};

/** ¿Es hoy (o la fecha dada) día de gym según el perfil? 0=Dom … 6=Sáb. */
export function isGymDay(profile: PhysicalProfile, date: Date = new Date()): boolean {
  return (profile.gymDays ?? []).includes(date.getDay());
}

/**
 * Objetivos diarios según perfil y tipo de día.
 *
 * Orden de prioridad:
 *   1. Calorías = TDEE × kcalFactor (% del mantenimiento)
 *   2. Proteína = calcProteinBase × proteinPerKg (ESPEN para obesidad)
 *   3. Grasa    = kcal × fatPct
 *   4. Carbos   = resto (calorías - proteína kcal - grasa kcal)
 */
export function calcDailyTargets(profile: PhysicalProfile, gymDay: boolean): DailyTargets {
  const config = GOAL_CONFIG[profile.goal];
  const tmb  = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
  const tdee = calcTDEE(tmb, profile.activityLevel);
  const kcal = Math.max(1200, Math.round(tdee * config.kcalFactor(gymDay)));

  // Peso de referencia para proteína (masa magra o peso ajustado en obesidad)
  const protBase = calcProteinBase(profile);
  // Si la base es lean mass (bodyFatPct conocido), el g/kg efectivo es mayor
  // porque lean mass es menor que el peso total.
  const proteinG = Math.round(config.proteinPerKg * protBase);

  const proteinKcal = proteinG * 4;
  const fatKcal     = Math.round(kcal * config.fatPct);
  const carbKcal    = Math.max(0, kcal - proteinKcal - fatKcal);

  return {
    kcal,
    protein: proteinG,
    carbs: Math.round(carbKcal / 4),
    fat:   Math.round(fatKcal / 9),
    dayType: gymDay ? "gym" : "rest",
  };
}

/** Resumen de cálculo para mostrar en la UI. */
export function calcSummary(profile: PhysicalProfile) {
  const tmb  = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
  const tdee = calcTDEE(tmb, profile.activityLevel);
  const imc  = calcIMC(profile.weightKg, profile.heightCm);
  const protBase = calcProteinBase(profile);
  return { tmb, tdee, imc, protBase };
}

/** Vista previa del ciclo semanal (7 días empezando en lunes). */
export function weeklyCycle(
  profile: PhysicalProfile,
): Array<{ day: string; targets: DailyTargets }> {
  const names = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  return names.map((day, index) => {
    const weekday = (index + 1) % 7; // lunes=1 … domingo=0
    return {
      day,
      targets: calcDailyTargets(profile, (profile.gymDays ?? []).includes(weekday)),
    };
  });
}

// ─── Estimación kcal quemadas por ejercicio (MET) ────────────────────────────

/**
 * Estimación neta de kcal quemadas (excluyendo gasto basal).
 * Usa MET 5.0 para entrenamiento de fuerza moderado.
 * Fórmula: (MET − 1) × 3.5 × peso_kg / 200 × minutos
 */
export function estimateWorkoutKcal(weightKg: number, durationMin: number, met = 5.0): number {
  return Math.round((met - 1) * 3.5 * weightKg / 200 * durationMin);
}

// ─── Escalado de recetas (§5.3) ──────────────────────────────────────────────

export interface ScaledRecipe {
  ratio: number;
  servings: number;
  ingredients: Array<{ name: string; quantity: number; unit: string }>;
  macros: MacroTotals;
  cost: number;
}

export function scaleByServings(recipe: Recipe, servings: number): ScaledRecipe {
  return scaleByRatio(recipe, servings / 1);
}

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
      kcal:    Math.round(recipe.kcal * safe),
      protein: Math.round(recipe.protein * safe * 10) / 10,
      carbs:   Math.round(recipe.carbs  * safe * 10) / 10,
      fat:     Math.round(recipe.fat    * safe * 10) / 10,
    },
    cost: Math.round(recipe.cost * safe * 100) / 100,
  };
}

// ─── Proyección de ahorro (§8.6) ─────────────────────────────────────────────

export interface SavingsProjection {
  months6: number;
  year1: number;
  years5Bank: number;
  years5Fund: number;
  years10Fund: number;
  emergencyFundMonths: number | null;
}

export function projectSavings(
  monthlyAmount: number,
  monthlyExpenses: number,
  annualRate = 0.07,
): SavingsProjection {
  const fv = (m: number, n: number, r: number) =>
    r === 0 ? m * n : m * ((Math.pow(1 + r / 12, n) - 1) / (r / 12));
  return {
    months6:          Math.round(fv(monthlyAmount, 6,   0)),
    year1:            Math.round(fv(monthlyAmount, 12,  0)),
    years5Bank:       Math.round(fv(monthlyAmount, 60,  0)),
    years5Fund:       Math.round(fv(monthlyAmount, 60,  annualRate)),
    years10Fund:      Math.round(fv(monthlyAmount, 120, annualRate)),
    emergencyFundMonths:
      monthlyAmount > 0 ? Math.ceil((monthlyExpenses * 3) / monthlyAmount) : null,
  };
}

export function monthlyAmountOf(
  frequency: "weekly" | "biweekly" | "monthly" | "yearly",
  amount: number,
): number {
  switch (frequency) {
    case "weekly":   return (amount * 52)  / 12;
    case "biweekly": return (amount * 26)  / 12;
    case "yearly":   return amount / 12;
    default:         return amount;
  }
}
