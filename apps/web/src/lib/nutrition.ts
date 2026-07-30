import type {
  ActivityLevel,
  ConfidenceLevel,
  DailyTargets,
  EquipmentAccess,
  ExperienceLevel,
  GoalMode,
  MacroPreference,
  MacroTotals,
  NutritionSafetyResult,
  PhysicalProfile,
  Recipe,
  SafetyWarning,
  TrainingActivityProfile,
  WeightEntry,
  WeightTrendResult,
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

/**
 * Factores de "solo vida cotidiana" (sin entrenamiento) para el modelo
 * lifestyle_plus_training. Son más bajos que ACTIVITY_FACTORS porque ahí el
 * entrenamiento habitual ya iba incluido en el multiplicador — aquí se suma
 * aparte vía calcHabitualTrainingAllowanceKcal, así que el factor solo cubre
 * trabajo, desplazamientos y tareas del día a día.
 */
export const LIFESTYLE_ONLY_FACTORS: Record<ActivityLevel, number> = {
  sedentary:   1.2,
  light:       1.3,
  moderate:    1.4,
  active:      1.6,
  very_active: 1.8,
};

const STRENGTH_MET = 5.0; // Compendium of Physical Activities: fuerza general, esfuerzo moderado-alto
const CARDIO_MET    = 7.0; // Compendium: carrera/bici a ritmo moderado

/** kcal/min de una actividad según su MET (fórmula estándar del Compendium). */
function metKcalPerMin(met: number, weightKg: number): number {
  return (met * 3.5 * weightKg) / 200;
}

/**
 * Gasto medio diario (kcal) que aporta el entrenamiento declarado en
 * trainingActivity, repartido sobre los 7 días de la semana — se suma al
 * TDEE de "solo vida cotidiana" en el modelo lifestyle_plus_training.
 */
export function calcHabitualTrainingAllowanceKcal(
  weightKg: number,
  training: TrainingActivityProfile,
): number {
  const strengthWeekly = training.strengthDaysPerWeek * training.avgSessionDurationMin * metKcalPerMin(STRENGTH_MET, weightKg);
  const cardioWeekly   = training.cardioDaysPerWeek   * training.avgSessionDurationMin * metKcalPerMin(CARDIO_MET, weightKg);
  return Math.round((strengthWeekly + cardioWeekly) / 7);
}

/**
 * TDEE según el modelo de actividad del perfil (ver ActivityModelVersion):
 * - "legacy_total_pal" (por defecto): TMB × ACTIVITY_FACTORS[activityLevel],
 *   donde el PAL ya mezcla vida cotidiana y entrenamiento habitual.
 * - "lifestyle_plus_training": TMB × LIFESTYLE_ONLY_FACTORS[lifestyleActivity]
 *   + el gasto medio diario del entrenamiento declarado, calculado aparte.
 *   Si el perfil dice usar este modelo pero no ha rellenado trainingActivity
 *   todavía (transición a medias), cae de vuelta al cálculo legacy.
 */
export function calcTDEE(profile: PhysicalProfile, tmb: number): number {
  if (profile.activityModelVersion === "lifestyle_plus_training" && profile.trainingActivity) {
    const lifestyleTdee = tmb * LIFESTYLE_ONLY_FACTORS[profile.trainingActivity.lifestyleActivity];
    const trainingAllowance = calcHabitualTrainingAllowanceKcal(profile.weightKg, profile.trainingActivity);
    return Math.round(lifestyleTdee + trainingAllowance);
  }
  return Math.round(tmb * ACTIVITY_FACTORS[profile.activityLevel]);
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
 * Desplazamiento sobre el % de grasa por defecto de cada objetivo, según la
 * preferencia de reparto del usuario. "balanced" no cambia nada — así el
 * comportamiento por defecto (sin que el usuario toque el ajuste) es idéntico
 * al de antes de introducir esta preferencia. El resultado final se recorta
 * al rango EFSA de grasa total (20-35% de la energía).
 */
const FAT_PCT_DELTA: Record<MacroPreference, number> = {
  higher_carbohydrate: -0.05,
  balanced: 0,
  higher_fat: 0.05,
};

const FAT_PCT_MIN = 0.20; // EFSA: 20-35% de la energía en grasa
const FAT_PCT_MAX = 0.35;

export const MACRO_PREFERENCE_LABELS: Record<MacroPreference, string> = {
  higher_carbohydrate: "Más carbohidratos",
  balanced: "Equilibrado (recomendado)",
  higher_fat: "Más grasa",
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

// ─── Guardarraíles de seguridad ──────────────────────────────────────────────

/**
 * Evalúa si un objetivo calórico concreto es razonable para el modo automático.
 *
 * - <800 kcal: bloqueo total. NICE (NG246) reserva las dietas de muy baja
 *   energía a servicios especializados con supervisión clínica — nunca un
 *   plan generado sin más por una app generalista.
 * - <70% del TDEE estimado: aviso que requiere confirmación explícita (déficit
 *   agresivo y sostenido).
 * - Por debajo de la TMB: aviso informativo. La TMB es el gasto estimado en
 *   reposo, no un "mínimo obligatorio de ingesta" — es una señal de
 *   precaución, no un límite médico universal, así que no bloquea nada.
 *
 * calcDailyTargets() ya nunca baja de 1200 kcal automáticamente, así que el
 * bloqueo <800 no debería dispararse hoy — existe para cuando exista una
 * vía de override manual o de ajuste adaptativo que pueda proponer cifras
 * más bajas.
 */
export function evaluateNutritionSafety(params: {
  targetKcal: number;
  estimatedTdeeKcal: number;
  restingEnergyKcal: number;
}): NutritionSafetyResult {
  if (params.targetKcal < 800) {
    return { automaticPlanAllowed: false, requiresConfirmation: false, warnings: ["very_low_energy_diet"] };
  }

  const warnings: SafetyWarning[] = [];
  if (params.targetKcal < params.estimatedTdeeKcal * 0.70) warnings.push("aggressive_energy_deficit");
  if (params.targetKcal < params.restingEnergyKcal) warnings.push("below_resting_energy");

  return {
    automaticPlanAllowed: true,
    requiresConfirmation: warnings.includes("aggressive_energy_deficit"),
    warnings,
  };
}

/**
 * Objetivos diarios según perfil y tipo de día.
 *
 * 1. Calorías = TDEE × kcalFactor(goal, gymDay, IMC)
 * 2. Proteína = calcProteinBase × proteinPerKg
 *    - En obesidad: adjusted_ESPEN = ideal_IMC25 + (actual − ideal) × 0.33
 *    - Multiplier: 2.0 fat_loss/recomp · 1.8 maintain/muscle_gain
 * 3. Grasa = kcal × fatPct (fatPct del objetivo, desplazado por macroPreference
 *    y recortado al rango EFSA 20-35%; "balanced"/sin especificar no cambia nada)
 * 4. Carbos = resto
 */
export function calcDailyTargets(
  profile: PhysicalProfile,
  gymDay: boolean,
  macroPreference: MacroPreference = "balanced",
): DailyTargets {
  const config = GOAL_CONFIG[profile.goal];
  const tmb  = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
  const tdee = calcTDEE(profile, tmb);
  const imc  = calcIMC(profile.weightKg, profile.heightCm);
  const kcal = Math.max(1200, Math.round(tdee * kcalFactor(profile.goal, gymDay, imc)));

  const protBase = calcProteinBase(profile);
  const proteinG = Math.round(config.proteinPerKg * protBase);

  const fatPct = Math.min(FAT_PCT_MAX, Math.max(FAT_PCT_MIN, config.fatPct + FAT_PCT_DELTA[macroPreference]));
  const proteinKcal = proteinG * 4;
  const fatKcal     = Math.round(kcal * fatPct);
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
  const tdee     = calcTDEE(profile, tmb);
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
  macroPreference: MacroPreference = "balanced",
): Array<{ day: string; targets: DailyTargets }> {
  const names = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  return names.map((day, index) => {
    const weekday = (index + 1) % 7; // lunes=1 … domingo=0
    return {
      day,
      targets: calcDailyTargets(profile, (profile.gymDays ?? []).includes(weekday), macroPreference),
    };
  });
}

// ─── Fibra ────────────────────────────────────────────────────────────────

/**
 * Objetivo de fibra diaria. EFSA considera 25 g/día una ingesta adecuada para
 * la función intestinal normal en adultos — es el suelo, no un mínimo estricto
 * por persona. El escalado por encima de 25g (14g/1000kcal, tope 45g) es una
 * regla de producto, no una recomendación clínica universal.
 */
export function calculateFiberTarget(caloriesKcal: number): number {
  const scaled = (caloriesKcal / 1000) * 14;
  return Math.round(Math.min(45, Math.max(25, scaled)));
}

// ─── Tendencia de peso (suavizado, sin efecto en calorías) ───────────────────

const TREND_WINDOW_DAYS = 28;
/** Peso del punto más reciente en el EWMA. 0.2 es un punto intermedio típico
    en apps de peso suavizado (más reactivo que el 0.1 de "Hacker's Diet",
    menos ruidoso que seguir el peso crudo). No es un valor clínico, es un
    parámetro de suavizado — ajustable si en producción resulta muy/poco reactivo. */
const TREND_EWMA_ALPHA = 0.2;
const TREND_MIN_MEASUREMENTS = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function daysBetweenDates(fromDateKey: string, toDateKey: string): number {
  const from = new Date(`${fromDateKey}T12:00:00`).getTime();
  const to = new Date(`${toDateKey}T12:00:00`).getTime();
  return Math.round((to - from) / 86_400_000);
}

/**
 * Tendencia de peso suavizada — nunca cambia ningún objetivo por sí sola,
 * solo informa (ver WeightTrendResult). Pipeline:
 *
 * 1. Filtra registros válidos dentro de la ventana (por defecto 28 días).
 * 2. Mediana móvil de 3 (ventana centrada, recortada en los extremos) — quita
 *    picos aislados de un día (agua, sal, ciclo menstrual...).
 * 3. EWMA sobre la serie de medianas — la curva de "peso tendencia" que se
 *    muestra al usuario.
 * 4. Regresión lineal (mínimos cuadrados) de la serie EWMA frente a días
 *    transcurridos → pendiente diaria.
 *
 * Devuelve null si no hay datos suficientes (< 3 registros en la ventana) —
 * igual que el resto de paneles de peso/proyección de esta vista.
 */
export function calcWeightTrend(
  entries: WeightEntry[],
  referenceDate: string,
  windowDays: number = TREND_WINDOW_DAYS,
): WeightTrendResult | null {
  const sorted = entries
    .filter((e) => e.date <= referenceDate && daysBetweenDates(e.date, referenceDate) <= windowDays)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sorted.length < TREND_MIN_MEASUREMENTS) return null;

  const medianSmoothed = sorted.map((entry, i) => {
    const windowVals = [sorted[i - 1]?.kg, entry.kg, sorted[i + 1]?.kg].filter(
      (v): v is number => v != null
    );
    return { date: entry.date, kg: median(windowVals) };
  });

  let ewma = medianSmoothed[0].kg;
  const ewmaSeries = medianSmoothed.map((point, i) => {
    if (i === 0) return { date: point.date, kg: ewma };
    ewma = TREND_EWMA_ALPHA * point.kg + (1 - TREND_EWMA_ALPHA) * ewma;
    return { date: point.date, kg: ewma };
  });

  const x = ewmaSeries.map((p) => daysBetweenDates(ewmaSeries[0].date, p.date));
  const y = ewmaSeries.map((p) => p.kg);
  const n = x.length;
  const xMean = x.reduce((s, v) => s + v, 0) / n;
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const num = x.reduce((s, xi, i) => s + (xi - xMean) * (y[i] - yMean), 0);
  const den = x.reduce((s, xi) => s + (xi - xMean) ** 2, 0);
  const slopeKgPerDay = den === 0 ? 0 : num / den;

  const trendWeightKg = Math.round(ewmaSeries[ewmaSeries.length - 1].kg * 10) / 10;
  const latestWeightKg = sorted[sorted.length - 1].kg;
  const weeklyChangeKg = Math.round(slopeKgPerDay * 7 * 100) / 100;
  const weeklyChangePercent = Math.round((weeklyChangeKg / trendWeightKg) * 1000) / 10;

  const confidence: ConfidenceLevel =
    sorted.length >= 14 ? "high" : sorted.length >= 7 ? "moderate" : "low";

  return {
    latestWeightKg,
    trendWeightKg,
    slopeKgPerDay: Math.round(slopeKgPerDay * 10000) / 10000,
    weeklyChangeKg,
    weeklyChangePercent,
    validMeasurements: sorted.length,
    confidence,
  };
}

// ─── Reparto semanal de calorías (gym vs. descanso) ──────────────────────────

export interface WeeklyCalorieDistribution {
  trainingDayKcal: number;
  restDayKcal: number;
  weeklyBudget: number;
}

/**
 * Reparte un objetivo medio diario entre días de entrenamiento y descanso
 * SIN cambiar el total semanal — el ciclado mueve cuándo se comen las
 * calorías, nunca añade calorías nuevas. Invariante protegido por test:
 * trainingDayKcal × trainingDays + restDayKcal × restDays == averageDailyKcal × 7.
 *
 * No sustituye el ciclado por porcentaje que ya usa calcDailyTargets/kcalFactor
 * (ese ciclado tiene sus propios valores ya verificados) — es una utilidad
 * nueva e independiente, pensada para cuando el motor adaptativo necesite
 * redistribuir un objetivo medio calculado dinámicamente.
 */
export function distributeWeeklyCalories(params: {
  averageDailyKcal: number;
  trainingDays: number;
  trainingDayDeltaKcal: number;
}): WeeklyCalorieDistribution {
  const { averageDailyKcal, trainingDays, trainingDayDeltaKcal } = params;
  const weeklyBudget = averageDailyKcal * 7;

  if (trainingDays <= 0 || trainingDays >= 7) {
    return {
      trainingDayKcal: Math.round(averageDailyKcal),
      restDayKcal: Math.round(averageDailyKcal),
      weeklyBudget: Math.round(weeklyBudget),
    };
  }

  const restDays = 7 - trainingDays;
  const trainingDayKcal = averageDailyKcal + trainingDayDeltaKcal;
  const restDayKcal = (weeklyBudget - trainingDayKcal * trainingDays) / restDays;

  return {
    trainingDayKcal: Math.round(trainingDayKcal),
    restDayKcal: Math.round(restDayKcal),
    weeklyBudget: Math.round(weeklyBudget),
  };
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
