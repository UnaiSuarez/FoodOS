import type {
  ActivityLevel,
  DailyTargets,
  EquipmentAccess,
  ExperienceLevel,
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

// ─── Nivel de experiencia / material (perfil, asistente de rutinas IA) ──────

export const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = {
  beginner:     "Principiante",
  intermediate: "Intermedio",
  advanced:     "Avanzado",
};

export const EQUIPMENT_LABELS: Record<EquipmentAccess, string> = {
  full_gym:       "Gimnasio completo",
  home_dumbbells: "Casa (mancuernas)",
  bodyweight:     "Sin material",
};

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
 * Peso de referencia para calcular proteína (ESPEN + ISSN).
 *
 * Prioridad:
 * 1. Con % grasa conocido → masa magra (más preciso)
 * 2. Obesidad (peso > IMC-25 × 1.25) → peso ajustado ESPEN:
 *      adjusted = ideal_IMC25 + (actual − ideal) × 0.33
 *    NO usamos targetWeightKg aquí: el objetivo es para calorías y
 *    proyecciones, no para proteína. El peso ajustado ya es conservador.
 * 3. En los demás casos → peso actual
 *
 * Ejemplo: 120 kg, 177 cm
 *   ideal = 25 × 1.77² = 78.3 kg
 *   adjusted = 78.3 + (120 − 78.3) × 0.33 = 92.1 kg  ← base proteína
 *   protein (fat_loss 2.0 g/kg) = 92.1 × 2.0 = 184 g  ✓ rango 180-200 g
 */
/** ¿Se le aplica a este perfil el peso ajustado ESPEN para proteína (en vez
    del peso real)? Se dispara cuando el peso supera en un 25% el peso ideal
    a IMC 25 (~IMC 31.25). Extraído para que la UI (p.ej. la etiqueta "peso
    ajustado ESPEN") no reimplemente el umbral por su cuenta y quede
    desincronizada si este cambia. Solo aplica sin % graso conocido: con
    bodyFatPct, calcProteinBase usa directamente la masa magra. */
export function usesEspenAdjustedWeight(profile: PhysicalProfile): boolean {
  if (profile.bodyFatPct != null) return false;
  const heightM     = profile.heightCm / 100;
  const idealWeight = 25 * heightM * heightM; // IMC 25
  return profile.weightKg > idealWeight * 1.25;
}

export function calcProteinBase(profile: PhysicalProfile): number {
  if (profile.bodyFatPct != null) {
    return profile.weightKg * (1 - profile.bodyFatPct / 100);
  }

  const heightM     = profile.heightCm / 100;
  const idealWeight = 25 * heightM * heightM; // IMC 25

  if (usesEspenAdjustedWeight(profile)) {
    return idealWeight + (profile.weightKg - idealWeight) * 0.33;
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
  fat_loss:    "−20% kcal · proteína 2.0 g/kg · ~−0,5–1 kg/semana",
  muscle_gain: "+5% kcal (solo si IMC<27) · proteína 1.8 g/kg",
  recomp:      "IMC≥30: −17-20% · IMC<30: −10-17% · proteína 2.0 g/kg",
  maintain:    "100% kcal mantenimiento · proteína 1.8 g/kg",
};

interface GoalConfig {
  /** g/kg sobre calcProteinBase() — ver comentario en calcDailyTargets. */
  proteinPerKg: number;
  /** Fracción de kcal para grasa. */
  fatPct: number;
}

const GOAL_CONFIG: Record<GoalMode, GoalConfig> = {
  fat_loss:    { proteinPerKg: 2.0, fatPct: 0.25 },
  muscle_gain: { proteinPerKg: 1.8, fatPct: 0.25 },
  recomp:      { proteinPerKg: 2.0, fatPct: 0.25 },
  maintain:    { proteinPerKg: 1.8, fatPct: 0.28 },
};

/**
 * Factor kcal según objetivo, IMC y tipo de día.
 *
 * fat_loss:    0.80 siempre (−20%)
 * muscle_gain: 1.05 si IMC<27 / 0.90 si IMC≥27 (no superávit en obesidad)
 * recomp:      IMC≥30 → 0.83 gym / 0.80 descanso
 *              IMC<30  → 0.90 gym / 0.83 descanso
 * maintain:    1.0
 */
function kcalFactor(goal: GoalMode, gymDay: boolean, imc: number): number {
  switch (goal) {
    case "fat_loss":
      return 0.80;
    case "muscle_gain":
      return imc >= 27 ? 0.90 : 1.05;
    case "recomp":
      return imc >= 30
        ? (gymDay ? 0.83 : 0.80)
        : (gymDay ? 0.90 : 0.83);
    case "maintain":
    default:
      return 1.0;
  }
}

/** ¿Es hoy (o la fecha dada) día de gym según el perfil? 0=Dom … 6=Sáb. */
export function isGymDay(profile: PhysicalProfile, date: Date = new Date()): boolean {
  return (profile.gymDays ?? []).includes(date.getDay());
}

/**
 * Objetivos diarios según perfil y tipo de día.
 *
 * 1. Calorías = TDEE × kcalFactor(goal, gymDay, IMC)
 * 2. Proteína = calcProteinBase × proteinPerKg
 *    - En obesidad: adjusted_ESPEN = ideal_IMC25 + (actual − ideal) × 0.33
 *    - Multiplier: 2.0 fat_loss/recomp · 1.8 maintain/muscle_gain
 * 3. Grasa = kcal × fatPct
 * 4. Carbos = resto
 */
export function calcDailyTargets(profile: PhysicalProfile, gymDay: boolean): DailyTargets {
  const config = GOAL_CONFIG[profile.goal];
  const tmb  = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
  const tdee = calcTDEE(tmb, profile.activityLevel);
  const imc  = calcIMC(profile.weightKg, profile.heightCm);
  const kcal = Math.max(1200, Math.round(tdee * kcalFactor(profile.goal, gymDay, imc)));

  const protBase = calcProteinBase(profile);
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
  const tmb      = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
  const tdee     = calcTDEE(tmb, profile.activityLevel);
  const imc      = calcIMC(profile.weightKg, profile.heightCm);
  const protBase = calcProteinBase(profile);
  return { tmb, tdee, imc, protBase };
}

/**
 * Rango de proteína en 5 puntos.
 *
 * broadMin / broadMax (×1.6 / ×2.4): rango amplio de seguridad — útil para
 * validaciones, sliders, alertas de adherencia semanal. No mostrar en UI principal.
 *
 * recommendedMin / recommendedMax (×1.8 / ×2.2): rango clínico recomendado —
 * este es el que el usuario ve. Está dentro del óptimo para fat_loss / recomp.
 *
 * target (×2.0): objetivo diario de la app.
 *
 * Ejemplo: base ESPEN 92.1 kg
 *   broad:       147–221 g  (interno)
 *   recommended: 166–203 g  (UI)
 *   target:      184 g      (UI, número principal)
 */
export function calcProteinRange(profile: PhysicalProfile): {
  broadMin:       number;
  recommendedMin: number;
  target:         number;
  recommendedMax: number;
  broadMax:       number;
} {
  const base = calcProteinBase(profile);
  return {
    broadMin:       Math.round(base * 1.6),
    recommendedMin: Math.round(base * 1.8),
    target:         Math.round(base * 2.0),
    recommendedMax: Math.round(base * 2.2),
    broadMax:       Math.round(base * 2.4),
  };
}

/** ¿Debería la app avisar de que el objetivo muscle_gain no es óptimo? */
export function shouldWarnMuscleGain(profile: PhysicalProfile): boolean {
  return profile.goal === "muscle_gain" && calcIMC(profile.weightKg, profile.heightCm) >= 27;
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
