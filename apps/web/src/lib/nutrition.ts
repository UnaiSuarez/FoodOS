import type {
  ActivityLevel,
  AdaptiveDiagnostics,
  AdaptiveTdeeResult,
  AdaptiveTdeeWarning,
  AdjustmentDecision,
  AdjustmentProfileFingerprint,
  AdjustmentProposalEvidence,
  ConfidenceLevel,
  DailyTargets,
  EquipmentAccess,
  ExperienceLevel,
  GoalMode,
  IntakeCoverageResult,
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

/**
 * Versión del motor de cálculo nutricional — única fuente de verdad para
 * calculationVersion en snapshots, nutrition_goals y propuestas. Súbela cada
 * vez que cambie una fórmula, un guardarraíl o el criterio de una propuesta
 * de forma que afecte al resultado (no por cambios puramente cosméticos de UI).
 *
 * Historial:
 * - nutrition-v1: TMB (Mifflin-St Jeor) + TDEE por factor de actividad,
 *   macros por objetivo, ciclado gym/descanso, fibra, guardarraíles de
 *   seguridad básicos.
 * - nutrition-v2: añade modelo de actividad lifestyle_plus_training, tendencia
 *   de peso suavizada (mediana+EWMA+regresión), TDEE adaptativo combinado,
 *   propuestas de ajuste explícitas con guardarraíl de discrepancia >30%,
 *   diagnóstico completo, y aceptación transaccional vía RPC (PR8).
 */
export const NUTRITION_ENGINE_VERSION = "nutrition-v2";

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

// ─── MET por grupo muscular predominante de la sesión ───────────────────────
// Compendium of Physical Activities 2024: 3.5 MET = fuerza ligera/aislamiento,
// 5.0 MET = fuerza moderada/general (el valor por defecto de siempre), 6.0 MET
// = fuerza vigorosa/compuesta multiarticular. La comparación directa entre
// ejercicios confirma que el coste energético real de un compuesto de pierna
// (ej. sentadilla) es sistemáticamente mayor que el de un aislamiento (ej.
// curl de bíceps) a intensidad percibida equivalente — no es solo cuestión
// de cuánto peso se mueve. Ver docs/INVESTIGACION_VISION_Y_ENTRENAMIENTO.md §2.5.
const VIGOROUS_MUSCLE_KEYWORDS = ["pierna", "gluteo", "glúteo", "cuadricep", "isquio", "espalda", "cuerpo completo", "full body"];
const LIGHT_MUSCLE_KEYWORDS    = ["brazo", "bicep", "bíceps", "tricep", "tríceps", "abdomen", "abs", "antebrazo"];

/**
 * Deriva el MET de una sesión a partir de los grupos musculares del día
 * (`RoutineDay.muscleGroups`, en español libre — solo lo rellenan hoy las
 * rutinas generadas por IA). Sin señal suficiente (rutina manual sin split,
 * o mezcla de grupos vigorosos y ligeros) cae al MET moderado de siempre.
 */
export function metForMuscleGroups(muscleGroups: string[] | undefined | null): number {
  if (!muscleGroups || muscleGroups.length === 0) return STRENGTH_MET;
  const text = muscleGroups.join(" ").toLowerCase();
  const isVigorous = VIGOROUS_MUSCLE_KEYWORDS.some((k) => text.includes(k));
  const isLight    = LIGHT_MUSCLE_KEYWORDS.some((k) => text.includes(k));
  if (isVigorous && !isLight) return 6.0;
  if (isLight && !isVigorous) return 3.5;
  return STRENGTH_MET;
}

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
  // adaptiveKcalOffsetKcal: ajuste aceptado explícitamente por el usuario a
  // partir de una AdjustmentProposal (PR6) — 0/undefined no cambia nada de
  // lo que había antes de que existiera este campo.
  const rawKcal = tdee * kcalFactor(profile.goal, gymDay, imc) + (profile.adaptiveKcalOffsetKcal ?? 0);
  const kcal = Math.max(1200, Math.round(rawKcal));

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

/**
 * PR10b (N7): antes `confidence` dependía solo del número de mediciones
 * (3-6 baja, 7-13 moderada, 14+ alta) — 14 mediciones registradas en 3 días
 * seguidos (viaje, enfermedad, un usuario compulsivo con la báscula) pasaban
 * como "alta confianza" igual que 14 mediciones bien repartidas en 4
 * semanas, aunque las primeras dicen mucho menos sobre la tendencia real.
 *
 * qualityScore (0-1) combina, a partes iguales:
 *   - cantidad:          nº de mediciones, satura en TREND_QUALITY_QUANTITY_TARGET
 *   - cobertura temporal: días de calendario reales cubiertos (detecta
 *                         mediciones agrupadas — E11-23), satura en
 *                         TREND_QUALITY_SPAN_TARGET_DAYS
 *   - regularidad:        1 − coeficiente de variación de los huecos entre
 *                         mediciones consecutivas (huecos parejos = mejor)
 *   - ajuste estadístico: R² de la regresión sobre la serie EWMA (cuánto
 *                         explica la recta frente al ruido residual)
 *
 * Pesos iguales por simplicidad y transparencia — no hay evidencia todavía
 * de que un factor deba pesar más que otro; revisar con datos reales de uso,
 * igual que la constante 7700 en calcAdaptiveTdee (ver N11-26 del backlog).
 */
const TREND_QUALITY_QUANTITY_TARGET = 14;
const TREND_QUALITY_SPAN_TARGET_DAYS = 21;
const TREND_QUALITY_HIGH = 0.85;
const TREND_QUALITY_MODERATE = 0.65;

function calcWeightTrendQualityScore(params: {
  x: number[];
  y: number[];
  slopeKgPerDay: number;
  xMean: number;
  yMean: number;
  /** Días entre la primera y la última medición de la ventana (x[n-1], ya que x[0]=0). */
  spanDays: number;
}): number {
  const { x, y, slopeKgPerDay, xMean, yMean, spanDays } = params;
  const n = x.length;

  const quantityScore = Math.min(1, n / TREND_QUALITY_QUANTITY_TARGET);
  const temporalCoverageScore = Math.min(1, spanDays / TREND_QUALITY_SPAN_TARGET_DAYS);

  // Regularidad: coeficiente de variación de los huecos entre mediciones
  // consecutivas. Huecos idénticos (registro diario o cada X días fijo) dan
  // CV=0 → score 1. Huecos muy dispares (varias mediciones el mismo día de
  // viaje y luego dos semanas de silencio) dan CV alto → score bajo.
  const gaps = x.slice(1).map((xi, i) => xi - x[i]);
  const meanGap = spanDays / (n - 1);
  const gapVariance = gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / gaps.length;
  const gapStdDev = Math.sqrt(gapVariance);
  const regularityScore = meanGap > 0 ? Math.max(0, 1 - gapStdDev / meanGap) : 1;

  // Ajuste (R²) de la recta de regresión sobre la serie EWMA ya suavizada:
  // cuánta de la variación de y explica la tendencia lineal frente al ruido
  // residual. Con y prácticamente constante (peso plano) SS_tot≈0 y la recta
  // explica toda la (poca) variación que hay — se trata como ajuste perfecto.
  const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
  let fitScore = 1;
  if (ssTot > 1e-6) {
    const ssRes = x.reduce((s, xi, i) => {
      const predicted = yMean + slopeKgPerDay * (xi - xMean);
      return s + (y[i] - predicted) ** 2;
    }, 0);
    const rSquared = 1 - ssRes / ssTot;
    fitScore = Math.max(0, Math.min(1, rSquared));
  }

  return (quantityScore + temporalCoverageScore + regularityScore + fitScore) / 4;
}

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

function subtractDaysFromDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00`);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
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

  const qualityScore = calcWeightTrendQualityScore({ x, y, slopeKgPerDay, xMean, yMean, spanDays: x[n - 1] });
  const confidence: ConfidenceLevel =
    qualityScore >= TREND_QUALITY_HIGH ? "high" : qualityScore >= TREND_QUALITY_MODERATE ? "moderate" : "low";

  return {
    latestWeightKg,
    trendWeightKg,
    slopeKgPerDay: Math.round(slopeKgPerDay * 10000) / 10000,
    weeklyChangeKg,
    weeklyChangePercent,
    validMeasurements: sorted.length,
    confidence,
    qualityScore,
  };
}

// ─── TDEE adaptativo pasivo (solo informativo, PR5) ──────────────────────────

/** Umbral bajo el cual un día se considera "sin registro fiable" — mismo
    criterio que ya usaba el panel de proyección de peso: un día con <500 kcal
    registradas normalmente significa que el usuario no anotó todo, no que
    comió muy poco. Es un suelo ABSOLUTO (atrapa días vacíos u olvidados) —
    ver INTAKE_COVERAGE_MIN_RELATIVE_FRACTION para el suelo RELATIVO. */
const INTAKE_COVERAGE_MIN_KCAL = 500;

/**
 * PR10 (N6): el umbral absoluto de 500 kcal no detecta un registro parcial
 * en un objetivo alto — con un objetivo de 2600 kcal, un día con solo
 * desayuno y comida (1200 kcal, ya por encima de 500) se contaba como
 * "completo" y el TDEE observado interpretaba que el usuario había comido
 * de verdad solo 1200 kcal ese día, desviando el resultado. Este suelo
 * relativo exige además llegar a un % del objetivo del día — no penaliza un
 * déficit deliberado (un objetivo de 1500 kcal cumplido al 100% sigue
 * contando), solo un registro que se queda muy corto respecto a lo esperado.
 */
const INTAKE_COVERAGE_MIN_RELATIVE_FRACTION = 0.6;

/**
 * Cobertura de registro de ingesta en una ventana de días: promedio de kcal
 * de los días con datos fiables, y qué fracción de la ventana tiene esos
 * datos (cuanta menos cobertura, menos se puede confiar en ese promedio).
 * `dailyKcal` debe venir ya agregado (una entrada por fecha).
 *
 * `targetKcal` es opcional (y retrocompatible: sin él, el criterio es
 * exactamente el de antes de PR10, solo el suelo absoluto) — cuando se
 * pasa, un día también necesita llegar al 60% del objetivo de ESE día para
 * contar como "con datos fiables" (ver INTAKE_COVERAGE_MIN_RELATIVE_FRACTION).
 */
export function calcIntakeCoverage(
  dailyKcal: Array<{ date: string; kcal: number }>,
  referenceDate: string,
  windowDays: number,
  targetKcal?: number,
): IntakeCoverageResult | null {
  const relativeFloor = targetKcal != null ? targetKcal * INTAKE_COVERAGE_MIN_RELATIVE_FRACTION : 0;
  const withData = dailyKcal.filter(
    (d) =>
      d.date <= referenceDate &&
      daysBetweenDates(d.date, referenceDate) < windowDays &&
      d.kcal >= INTAKE_COVERAGE_MIN_KCAL &&
      d.kcal >= relativeFloor
  );
  if (withData.length === 0) return null;

  const avgKcal = Math.round(withData.reduce((sum, d) => sum + d.kcal, 0) / withData.length);
  return {
    avgKcal,
    coverageFraction: Math.round((withData.length / windowDays) * 100) / 100,
    daysWithData: withData.length,
    windowDays,
  };
}

/** Cuánto peso (0-1) recibe el TDEE observado frente al inicial en la media
    ponderada — nunca reemplaza el inicial por completo, ni con confianza
    alta: una ventana de semanas siempre es más ruidosa que la fórmula base. */
export const ADAPTIVE_CONFIDENCE_WEIGHTS: Record<ConfidenceLevel, number> = {
  low: 0.2,
  moderate: 0.4,
  high: 0.6,
};

/**
 * TDEE adaptativo pasivo — combina el TDEE inicial (fórmula) con el TDEE
 * observado (ingesta real medida contra el cambio de peso real):
 *
 *   TDEE_observado = ingesta_media − pendiente_kg/día × 7700
 *   TDEE_combinado = (1−w)·TDEE_inicial + w·TDEE_observado
 *
 * w depende de la confianza de la tendencia de peso (ADAPTIVE_CONFIDENCE_WEIGHTS).
 * Sin tendencia de peso o sin ingesta registrada, devuelve el inicial tal
 * cual con confidence "insufficient_data". Puramente informativo en esta
 * versión: no modifica ningún objetivo de calorías por sí solo (PR6 es quien
 * podría proponer, nunca aplicar solo, un ajuste basado en esto).
 */
/** Si el TDEE observado difiere del inicial en más de este % del inicial,
    algo en los datos es sospechoso (infrarregistro, agua, creatina, ciclo,
    enfermedad...) — no es una ley fisiológica, es un guardarraíl de calidad
    de datos configurable. */
const TDEE_DISAGREEMENT_THRESHOLD = 0.30;

export function calcAdaptiveTdee(params: {
  initialTdeeKcal: number;
  avgIntakeKcal: number | null;
  weightTrend: WeightTrendResult | null;
}): AdaptiveTdeeResult {
  const initialKcal = Math.round(params.initialTdeeKcal);
  if (!params.weightTrend || params.avgIntakeKcal == null) {
    return { initialKcal, observedKcal: null, combinedKcal: initialKcal, confidence: "insufficient_data", warnings: [] };
  }

  const observedKcal = Math.round(params.avgIntakeKcal - params.weightTrend.slopeKgPerDay * 7700);
  const w = ADAPTIVE_CONFIDENCE_WEIGHTS[params.weightTrend.confidence];
  const combinedKcal = Math.round((1 - w) * initialKcal + w * observedKcal);

  const warnings: AdaptiveTdeeWarning[] = [];
  if (Math.abs(observedKcal - initialKcal) > initialKcal * TDEE_DISAGREEMENT_THRESHOLD) {
    warnings.push("tdee_estimates_strongly_disagree");
  }

  return { initialKcal, observedKcal, combinedKcal, confidence: params.weightTrend.confidence, warnings };
}

// ─── Propuestas de ajuste adaptativo (PR6) ───────────────────────────────────

/** Umbral de confianza mínima (misma escala que ADAPTIVE_CONFIDENCE_WEIGHTS)
    para considerar una propuesta — equivale a exigir confianza "high", ya que
    "moderate" pesa 0.4 y "low" 0.2 en esa tabla. */
const ADJUSTMENT_MIN_CONFIDENCE_SCORE = 0.6;
const ADJUSTMENT_MIN_COVERAGE = 0.85;
const ADJUSTMENT_MIN_EVALUATION_DAYS = 14;
const ADJUSTMENT_MIN_DELTA_KCAL = 50;
const ADJUSTMENT_MAX_DELTA_KCAL = 150; // igual al check constraint de la tabla

function noAdjustmentProposal(currentTargetKcal: number, reason: string): AdjustmentDecision {
  return { shouldPropose: false, deltaKcal: 0, proposedTargetKcal: currentTargetKcal, reason };
}

/**
 * Decide si el TDEE adaptativo justifica PROPONER (nunca aplicar solo) un
 * ajuste del objetivo de calorías. Todos los criterios deben cumplirse:
 *
 *   confianza >= 0.6 (alta) && cobertura de ingesta >= 85% && >= 14 días
 *   evaluados && |diferencia| >= 50 kcal
 *
 * El delta se recorta a ±150 kcal (nunca un salto brusco de una vez, aunque
 * la diferencia real sea mayor) y se redondea a la decena más cercana.
 */
export function evaluateAdjustmentProposal(params: {
  currentTargetKcal: number;
  adaptive: AdaptiveTdeeResult;
  weightTrend: WeightTrendResult | null;
  intakeCoverage: IntakeCoverageResult | null;
}): AdjustmentDecision {
  const { currentTargetKcal, adaptive, weightTrend, intakeCoverage } = params;

  if (!weightTrend || !intakeCoverage || adaptive.confidence === "insufficient_data") {
    return noAdjustmentProposal(currentTargetKcal, "Todavía no hay suficiente historial de peso e ingesta.");
  }
  if (adaptive.warnings.includes("tdee_estimates_strongly_disagree")) {
    return noAdjustmentProposal(
      currentTargetKcal,
      "El TDEE observado y el de la fórmula discrepan demasiado (>30%) — puede haber registros incompletos, retención de agua u otro factor puntual. Esperamos a que los datos se estabilicen."
    );
  }

  const confidenceScore = ADAPTIVE_CONFIDENCE_WEIGHTS[weightTrend.confidence];
  if (confidenceScore < ADJUSTMENT_MIN_CONFIDENCE_SCORE) {
    return noAdjustmentProposal(currentTargetKcal, "La confianza de tu tendencia de peso todavía es baja o moderada.");
  }
  if (intakeCoverage.coverageFraction < ADJUSTMENT_MIN_COVERAGE) {
    return noAdjustmentProposal(currentTargetKcal, "Te faltan días de registro de comidas para confiar en el promedio.");
  }
  if (weightTrend.validMeasurements < ADJUSTMENT_MIN_EVALUATION_DAYS) {
    return noAdjustmentProposal(currentTargetKcal, "Todavía no se han evaluado suficientes días.");
  }

  // OJO: el delta se basa en cuánto se ha desplazado la ESTIMACIÓN de
  // mantenimiento (combinado vs. fórmula inicial) — nunca en la diferencia
  // entre el combinado y el objetivo actual. El objetivo actual ya es,
  // A PROPÓSITO, un déficit o superávit sobre el mantenimiento (ese es el
  // sentido de tener un goal de pérdida/ganancia) — compararlo directamente
  // contra el combinado propondría siempre "subir hacia el mantenimiento" en
  // cualquier déficit razonable, incluso cuando la fórmula y la realidad
  // coinciden perfectamente. Lo que sí debe trasladarse al objetivo es CUÁNTO
  // ha cambiado la estimación de mantenimiento respecto a la fórmula.
  const tdeeShift = adaptive.combinedKcal - adaptive.initialKcal;
  if (Math.abs(tdeeShift) < ADJUSTMENT_MIN_DELTA_KCAL) {
    return noAdjustmentProposal(currentTargetKcal, "Tu mantenimiento real coincide con la estimación de la fórmula — no hay motivo para tocar tu objetivo.");
  }

  const clamped = Math.sign(tdeeShift) * Math.min(ADJUSTMENT_MAX_DELTA_KCAL, Math.abs(tdeeShift));
  const deltaKcal = Math.round(clamped / 10) * 10;
  const proposedTargetKcal = currentTargetKcal + deltaKcal;

  const reason =
    deltaKcal > 0
      ? `Tu mantenimiento real estimado (${adaptive.combinedKcal} kcal) es mayor de lo que asumía la fórmula (${adaptive.initialKcal} kcal) — subir ${deltaKcal} kcal/día mantendría el mismo ritmo que buscas, ajustado a tu caso real.`
      : `Tu mantenimiento real estimado (${adaptive.combinedKcal} kcal) es menor de lo que asumía la fórmula (${adaptive.initialKcal} kcal) — bajar ${Math.abs(deltaKcal)} kcal/día mantendría el mismo ritmo que buscas, ajustado a tu caso real.`;

  return { shouldPropose: true, deltaKcal, proposedTargetKcal, reason };
}

/** Días de espera tras aceptar O rechazar una propuesta antes de permitir
    generar otra — evita bombardear al usuario con revisiones repetidas. */
export const ADJUSTMENT_COOLDOWN_DAYS = 14;

/** ¿Sigue activo el cooldown desde la última decisión (aceptar/rechazar)?
    lastDecisionDateKey null significa que nunca hubo una decisión previa. */
export function isAdjustmentCooldownActive(
  lastDecisionDateKey: string | null,
  referenceDate: string,
  cooldownDays: number = ADJUSTMENT_COOLDOWN_DAYS,
): boolean {
  if (!lastDecisionDateKey) return false;
  return daysBetweenDates(lastDecisionDateKey, referenceDate) < cooldownDays;
}

/** Días que faltan para que termine el cooldown (0 si ya terminó o nunca empezó). */
export function adjustmentCooldownDaysLeft(
  lastDecisionDateKey: string | null,
  referenceDate: string,
  cooldownDays: number = ADJUSTMENT_COOLDOWN_DAYS,
): number {
  if (!lastDecisionDateKey) return 0;
  return Math.max(0, cooldownDays - daysBetweenDates(lastDecisionDateKey, referenceDate));
}

/**
 * Diagnóstico completo del motor adaptativo para un momento dado — a
 * diferencia de evaluateAdjustmentProposal (que para en el primer criterio
 * que falla), aquí se acumulan TODOS los motivos de bloqueo a la vez. Pensado
 * para responder "¿por qué no me deja generar una propuesta?" sin adivinar
 * por consola. proposalEligible usa evaluateAdjustmentProposal como única
 * fuente de verdad — este diagnóstico nunca puede contradecirlo.
 */
export function getAdaptiveDiagnostics(params: {
  weightLog: WeightEntry[];
  dailyKcal: Array<{ date: string; kcal: number }>;
  referenceDate: string;
  initialTdeeKcal: number;
  currentTargetKcal: number;
  windowDays?: number;
  /** PR9: si hubo un reinicio de calibración más reciente que el inicio de la
      ventana estándar (referenceDate - windowDays), el periodo evaluado
      "real" empieza ahí — aunque weightLog/dailyKcal ya vengan pre-filtrados
      por el caller, evaluationStart necesita este dato aparte para mostrarlo
      correctamente (no se puede deducir solo de qué entradas sobrevivieron). */
  calibrationStartedAt?: string | null;
}): AdaptiveDiagnostics {
  const windowDays = params.windowDays ?? 28;
  const { weightLog, dailyKcal, referenceDate, initialTdeeKcal, currentTargetKcal } = params;
  const standardWindowStart = subtractDaysFromDateKey(referenceDate, windowDays);
  const effectiveEvaluationStart =
    params.calibrationStartedAt && params.calibrationStartedAt > standardWindowStart
      ? params.calibrationStartedAt
      : standardWindowStart;

  const weightTrend = calcWeightTrend(weightLog, referenceDate, windowDays);
  const coverage = calcIntakeCoverage(dailyKcal, referenceDate, windowDays);
  const adaptive = calcAdaptiveTdee({ initialTdeeKcal, avgIntakeKcal: coverage?.avgKcal ?? null, weightTrend });
  const decision = evaluateAdjustmentProposal({ currentTargetKcal, adaptive, weightTrend, intakeCoverage: coverage });

  const inWindow = weightLog
    .filter((e) => e.date <= referenceDate && daysBetweenDates(e.date, referenceDate) <= windowDays)
    .sort((a, b) => a.date.localeCompare(b.date));

  let rawWeightChangeKg: number | null = null;
  let smoothedWeightChangeKg: number | null = null;
  if (inWindow.length >= 2) {
    const first = inWindow[0];
    const last = inWindow[inWindow.length - 1];
    rawWeightChangeKg = Math.round((last.kg - first.kg) * 100) / 100;
    if (weightTrend) {
      const spanDays = daysBetweenDates(first.date, last.date);
      smoothedWeightChangeKg = Math.round(weightTrend.slopeKgPerDay * spanDays * 100) / 100;
    }
  }

  const ineligibilityReasons: string[] = [];
  if (!weightTrend) {
    ineligibilityReasons.push(
      `Peso: solo ${inWindow.length} mediciones en los últimos ${windowDays} días (mínimo 3 para calcular tendencia).`
    );
  }
  if (!coverage) {
    ineligibilityReasons.push(`Ingesta: sin días con registro fiable en los últimos ${windowDays} días.`);
  }
  if (weightTrend && coverage) {
    const confidenceScore = ADAPTIVE_CONFIDENCE_WEIGHTS[weightTrend.confidence];
    if (confidenceScore < ADJUSTMENT_MIN_CONFIDENCE_SCORE) {
      ineligibilityReasons.push(`Confianza de tendencia: ${weightTrend.confidence} (se necesita alta).`);
    }
    if (coverage.coverageFraction < ADJUSTMENT_MIN_COVERAGE) {
      ineligibilityReasons.push(
        `Cobertura de ingesta: ${Math.round(coverage.coverageFraction * 100)}% (mínimo ${Math.round(ADJUSTMENT_MIN_COVERAGE * 100)}%).`
      );
    }
    if (weightTrend.validMeasurements < ADJUSTMENT_MIN_EVALUATION_DAYS) {
      ineligibilityReasons.push(
        `Días evaluados: ${weightTrend.validMeasurements} (mínimo ${ADJUSTMENT_MIN_EVALUATION_DAYS}).`
      );
    }
    if (Math.abs(adaptive.combinedKcal - adaptive.initialKcal) < ADJUSTMENT_MIN_DELTA_KCAL) {
      ineligibilityReasons.push(
        `Desplazamiento de la estimación de mantenimiento: ${Math.round(adaptive.combinedKcal - adaptive.initialKcal)} kcal frente a la fórmula (mínimo ${ADJUSTMENT_MIN_DELTA_KCAL} kcal).`
      );
    }
  }
  if (adaptive.warnings.includes("tdee_estimates_strongly_disagree")) {
    ineligibilityReasons.push("El TDEE observado y el de la fórmula discrepan más de un 30% — posible dato sospechoso.");
  }

  return {
    evaluationStart: effectiveEvaluationStart,
    evaluationEnd: referenceDate,
    averageLoggedCalories: coverage?.avgKcal ?? null,
    calorieCoverage: coverage?.coverageFraction ?? null,
    weightMeasurements: weightTrend?.validMeasurements ?? inWindow.length,
    rawWeightChangeKg,
    smoothedWeightChangeKg,
    regressionSlopeKgPerDay: weightTrend?.slopeKgPerDay ?? null,
    initialTdeeKcal: adaptive.initialKcal,
    observedTdeeKcal: adaptive.observedKcal,
    blendedTdeeKcal: adaptive.combinedKcal,
    confidenceScore: weightTrend ? ADAPTIVE_CONFIDENCE_WEIGHTS[weightTrend.confidence] : 0,
    confidenceLevel: adaptive.confidence,
    weightTrendQualityScore: weightTrend?.qualityScore ?? null,
    proposalEligible: decision.shouldPropose,
    ineligibilityReasons,
  };
}

/**
 * Construye la evidencia completa que se guarda junto a una propuesta de
 * ajuste (columna evidence, jsonb) a partir del mismo AdaptiveDiagnostics que
 * ya se calculó para decidir si procedía proponer — nunca recalcula nada, así
 * la evidencia nunca puede desincronizarse del diagnóstico mostrado en la UI.
 * Sin esto la propuesta quedaba con evidence:{} y era imposible auditar por
 * qué se propuso un ajuste concreto una vez pasado el momento (ver N13).
 */
export function buildAdjustmentEvidence(
  diagnostics: AdaptiveDiagnostics,
  adaptiveWarnings: AdaptiveTdeeWarning[],
  engineVersion: string = NUTRITION_ENGINE_VERSION,
): AdjustmentProposalEvidence {
  return {
    evaluationWindow: { start: diagnostics.evaluationStart, end: diagnostics.evaluationEnd },
    intakeCoverage: diagnostics.calorieCoverage,
    averageIntakeKcal: diagnostics.averageLoggedCalories,
    weightMeasurements: diagnostics.weightMeasurements,
    regressionSlopeKgPerDay: diagnostics.regressionSlopeKgPerDay,
    confidence: diagnostics.confidenceLevel,
    weightTrendQualityScore: diagnostics.weightTrendQualityScore,
    initialTdeeKcal: diagnostics.initialTdeeKcal,
    observedTdeeKcal: diagnostics.observedTdeeKcal,
    combinedTdeeKcal: diagnostics.blendedTdeeKcal,
    warnings: adaptiveWarnings,
    engineVersion,
  };
}

// ─── Ciclo de calibración adaptativa y propuestas obsoletas (PR9) ──────────

/** Solo los campos de TrainingActivityProfile que de verdad afectan al
    cálculo — habitualSteps se guarda para referencia pero todavía no entra
    en ninguna fórmula (ver N8), así que cambiarlo NO debe invalidar nada. */
function trainingActivityRelevantEqual(
  a: TrainingActivityProfile | null | undefined,
  b: TrainingActivityProfile | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.lifestyleActivity === b.lifestyleActivity &&
    a.strengthDaysPerWeek === b.strengthDaysPerWeek &&
    a.cardioDaysPerWeek === b.cardioDaysPerWeek &&
    a.avgSessionDurationMin === b.avgSessionDurationMin
  );
}

/**
 * ¿Este guardado de perfil cambia algo que invalida el histórico anterior
 * como referencia para el motor adaptativo? Solo objetivo, actividad y
 * modelo de actividad — NO peso (fluctúa día a día sin ser un cambio de
 * "régimen") ni preferencia de macros (no afecta al TDEE). prev=null (primer
 * perfil) nunca cuenta como cambio: no hay calibración previa que invalidar.
 */
export function isRelevantCalibrationChange(prev: PhysicalProfile | null, next: PhysicalProfile): boolean {
  if (!prev) return false;
  return (
    prev.goal !== next.goal ||
    prev.activityLevel !== next.activityLevel ||
    (prev.activityModelVersion ?? "legacy_total_pal") !== (next.activityModelVersion ?? "legacy_total_pal") ||
    !trainingActivityRelevantEqual(prev.trainingActivity, next.trainingActivity)
  );
}

/** Solo conserva las entradas con date >= calibrationStartedAt. Sin fecha de
    calibración (null/undefined — el caso normal antes de PR9 o cuando nunca
    ha habido un cambio relevante), no filtra nada: mismo comportamiento que
    siempre ha tenido el motor. */
export function filterEntriesFromCalibrationStart<T extends { date: string }>(
  entries: T[],
  calibrationStartedAt: string | null | undefined,
): T[] {
  if (!calibrationStartedAt) return entries;
  return entries.filter((e) => e.date >= calibrationStartedAt);
}

/** Instantánea de los campos del perfil que importan para decidir si una
    propuesta sigue vigente — ver AdjustmentProfileFingerprint y N4. */
export function buildAdjustmentProfileFingerprint(
  profile: PhysicalProfile,
  macroPreference: MacroPreference,
): AdjustmentProfileFingerprint {
  return {
    goal: profile.goal,
    weightKg: profile.weightKg,
    activityLevel: profile.activityLevel,
    activityModelVersion: profile.activityModelVersion ?? "legacy_total_pal",
    trainingActivity: profile.trainingActivity ?? null,
    macroPreference,
    adaptiveKcalOffsetKcal: profile.adaptiveKcalOffsetKcal ?? 0,
  };
}

/**
 * ¿Sigue siendo válido aceptar una propuesta generada con `original` ahora
 * que el perfil actual es `current`? true si CUALQUIER campo relevante
 * cambió desde que se generó — sin fingerprint original (propuestas creadas
 * antes de PR9), se asume vigente para no romper propuestas ya pendientes.
 */
export function isProposalStale(
  original: AdjustmentProfileFingerprint | undefined,
  current: AdjustmentProfileFingerprint,
): boolean {
  if (!original) return false;
  return (
    original.goal !== current.goal ||
    original.weightKg !== current.weightKg ||
    original.activityLevel !== current.activityLevel ||
    original.activityModelVersion !== current.activityModelVersion ||
    original.macroPreference !== current.macroPreference ||
    original.adaptiveKcalOffsetKcal !== current.adaptiveKcalOffsetKcal ||
    !trainingActivityRelevantEqual(original.trainingActivity, current.trainingActivity)
  );
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
