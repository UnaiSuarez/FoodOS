import type {
  ActivityLevel,
  AdaptiveDiagnostics,
  AdaptiveTdeeResult,
  AdaptiveTdeeWarning,
  AdjustmentDecision,
  AdjustmentProfileFingerprint,
  AdjustmentProposalEvidence,
  BodyFatSource,
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
  TdeeBreakdown,
  TrainingActivityProfile,
  WeightEntry,
  WeightTrajectoryAssessment,
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
 * - nutrition-v3 (ver docs/NUTRITION_V3_DECISIONES.md): duración fuerza/
 *   cardio separada, edad mínima 18, cobertura histórica por fecha real,
 *   proteína por base+tipo (peso real/ajustado/masa magra, tabla propia
 *   por objetivo) — PR1. Controlador adaptativo por RITMO
 *   (weeklyChangePercent contra banda por objetivo) sustituyendo el uso
 *   decisorio de 7700 kcal/kg, que pasa a diagnóstico puro — PR2. TDEE de
 *   entrenamiento habitual vía replacementIncrementKcal (gross − baseline
 *   desplazado por el lifestyle, nunca el gasto bruto) en vez del doble
 *   conteo de v2, con calcTdeeBreakdown como fuente única para
 *   calcTDEE() y la UI — PR3. Los tres PR ya estaban implementados antes
 *   de subir este identificador (deuda reconocida en su momento, no
 *   oculta) — el bump se hizo aquí, al cerrar PR3, cuando por fin
 *   significa exactamente lo que promete el documento de decisiones.
 */
export const NUTRITION_ENGINE_VERSION = "nutrition-v3";

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

// ─── grossKcal / netAboveRestKcal / replacementIncrementKcal (PR3 —────────
// ver docs/NUTRITION_V3_DECISIONES.md §2.5/§3) ─────────────────────────────
//
// Tres preguntas distintas, tres campos distintos — nunca confundir uno
// por otro:
//   grossKcal                 ¿cuánta energía estimamos que gastó la sesión?
//   netAboveRestKcal          ¿cuánto por encima de estar en reposo?
//   replacementIncrementKcal  ¿cuánto añade esto al mantenimiento, que ya
//                             incluía parte de ese tiempo vía lifestyleTdee?
// grossKcal/netAboveRestKcal son independientes del lifestyle por
// construcción (no reciben lifestyleTdee como parámetro — la firma
// misma impide que dependan de él). Solo replacementIncrementKcal
// depende del lifestyle, porque es la única pregunta que necesita saber
// qué había ya "reservado" ese tiempo.

/** Gasto total estimado (MET estándar, sin ajustar) de un intervalo de
    ejercicio. Independiente del lifestyle. */
function grossExerciseKcal(met: number, weightKg: number, minutes: number): number {
  return metKcalPerMin(met, weightKg) * minutes;
}

/** grossKcal por encima de 1 MET de reposo estándar durante esos mismos
    minutos — "cuánto gastó la sesión por encima de estar sentado".
    Independiente del lifestyle. Uso: mostrar el gasto de UNA sesión
    concreta (módulo Ejercicios) — NUNCA para modificar el mantenimiento
    nutricional, esa es una pregunta distinta (replacementIncrementKcal). */
function netAboveRestKcal(met: number, weightKg: number, minutes: number): number {
  const gross = grossExerciseKcal(met, weightKg, minutes);
  const restKcal = metKcalPerMin(1, weightKg) * minutes;
  return Math.max(0, gross - restKcal);
}

/** kcal que lifestyleTdee ya asignaba a esos minutos, asumiendo reparto
    uniforme sobre 1440 min/día. CONVENCIÓN CONTABLE para evitar doble
    conteo entre el modelo de actividad cotidiana y el ejercicio explícito
    — NO una medición del gasto contrafactual real de esa hora concreta
    (mezcla sueño, trabajo, desplazamientos repartidos uniformemente; una
    hora de gimnasio normalmente sustituye una hora despierta, no una
    fracción proporcional del día completo). Depende del lifestyle: a
    mismo ejercicio, más lifestyle → más baseline ya "reservado" → menos
    incremento real que aporta la sesión. */
function baselineDisplacedKcal(lifestyleTdeeKcal: number, minutes: number): number {
  return (lifestyleTdeeKcal / 1440) * minutes;
}

/** Lo único que debe modificar el mantenimiento estimado — nunca negativo:
    si el baseline ya "reservado" para esos minutos supera el gasto bruto
    de la sesión (lifestyle muy activo, sesión muy ligera), el incremento
    es 0, no negativo — un entrenamiento nunca debe BAJAR el TDEE. */
function replacementIncrementKcal(grossKcal: number, lifestyleTdeeKcal: number, minutes: number): number {
  return Math.max(0, grossKcal - baselineDisplacedKcal(lifestyleTdeeKcal, minutes));
}

/**
 * Desglose medio diario (kcal) del entrenamiento declarado en
 * trainingActivity, repartido sobre los 7 días de la semana — fuente única
 * interna para calcHabitualTrainingAllowanceKcal Y calcTdeeBreakdown, así
 * nunca hay dos implementaciones de la misma suma semanal fuerza+cardio
 * (el mismo tipo de duplicación que motivó todo el §3.2 de
 * docs/NUTRITION_V3_DECISIONES.md). replacementIncrementPerDay es la suma
 * de replacementIncrementKcal de cada sesión semanal, cada una clampada a
 * >=0 ANTES de sumar — una sesión con incremento 0 nunca "resta" al
 * incremento real de otra sesión distinta.
 */
function calcHabitualTrainingBreakdown(
  weightKg: number,
  training: TrainingActivityProfile,
  lifestyleTdeeKcal: number,
): { grossPerDay: number; baselineDisplacedPerDay: number; replacementIncrementPerDay: number } {
  const strengthGross = grossExerciseKcal(STRENGTH_MET, weightKg, training.strengthAvgDurationMin);
  const cardioGross   = grossExerciseKcal(CARDIO_MET, weightKg, training.cardioAvgDurationMin);
  const strengthBaseline = baselineDisplacedKcal(lifestyleTdeeKcal, training.strengthAvgDurationMin);
  const cardioBaseline   = baselineDisplacedKcal(lifestyleTdeeKcal, training.cardioAvgDurationMin);

  const weeklyGross = training.strengthDaysPerWeek * strengthGross + training.cardioDaysPerWeek * cardioGross;
  const weeklyBaseline = training.strengthDaysPerWeek * strengthBaseline + training.cardioDaysPerWeek * cardioBaseline;
  // Cada sesión se clampa a >=0 INDIVIDUALMENTE antes de sumar — de ahí
  // llamar a replacementIncrementKcal() por sesión en vez de restar los
  // totales semanales ya sumados (weeklyGross - weeklyBaseline sería
  // incorrecto: una sesión con incremento 0 no debe "restar" al
  // incremento real de otra sesión distinta).
  const weeklyIncrement =
    training.strengthDaysPerWeek * replacementIncrementKcal(strengthGross, lifestyleTdeeKcal, training.strengthAvgDurationMin) +
    training.cardioDaysPerWeek * replacementIncrementKcal(cardioGross, lifestyleTdeeKcal, training.cardioAvgDurationMin);

  return {
    grossPerDay: Math.round(weeklyGross / 7),
    baselineDisplacedPerDay: Math.round(weeklyBaseline / 7),
    replacementIncrementPerDay: Math.round(weeklyIncrement / 7),
  };
}

/**
 * Gasto medio diario (kcal) que aporta el entrenamiento declarado en
 * trainingActivity — solo el incremento real (replacementIncrementKcal),
 * lo único que se suma al TDEE de "solo vida cotidiana" en el modelo
 * lifestyle_plus_training. Ver calcTdeeBreakdown para el desglose
 * completo (gross/baseline/incremento).
 */
export function calcHabitualTrainingAllowanceKcal(
  weightKg: number,
  training: TrainingActivityProfile,
  lifestyleTdeeKcal: number,
): number {
  return calcHabitualTrainingBreakdown(weightKg, training, lifestyleTdeeKcal).replacementIncrementPerDay;
}

/**
 * Migra un `trainingActivity` con la forma legacy v2 (un único
 * `avgSessionDurationMin` compartido entre fuerza y cardio — ver
 * docs/NUTRITION_V3_DECISIONES.md §2.1/§10) a la forma v3. Copia el mismo
 * valor a `strengthAvgDurationMin`/`cardioAvgDurationMin` como punto de
 * partida — NUNCA como dato confirmado: marca `legacyDurationUnconfirmed:
 * true` para que la UI pida revisión antes de tratarlo como definitivo.
 * Si el objeto ya viene en forma v3 (tiene `strengthAvgDurationMin`), lo
 * devuelve tal cual, sin tocar `legacyDurationUnconfirmed`.
 */
export function migrateLegacyTrainingActivity(
  raw: Record<string, unknown>,
): TrainingActivityProfile {
  if (typeof raw.strengthAvgDurationMin === "number" && typeof raw.cardioAvgDurationMin === "number") {
    return raw as unknown as TrainingActivityProfile;
  }
  const legacyDuration = Number(raw.avgSessionDurationMin) || 0;
  return {
    lifestyleActivity: raw.lifestyleActivity as TrainingActivityProfile["lifestyleActivity"],
    strengthDaysPerWeek: Number(raw.strengthDaysPerWeek) || 0,
    cardioDaysPerWeek: Number(raw.cardioDaysPerWeek) || 0,
    strengthAvgDurationMin: legacyDuration,
    cardioAvgDurationMin: legacyDuration,
    habitualSteps: (raw.habitualSteps as number | null | undefined) ?? null,
    legacyDurationUnconfirmed: true,
  };
}

/**
 * Desglose completo del TDEE — FUENTE ÚNICA (nutrition-v3 §3.2): antes la
 * UI (NutritionView.tsx) reconstruía "vida diaria + entreno" llamando por
 * su cuenta a LIFESTYLE_ONLY_FACTORS/calcHabitualTrainingAllowanceKcal —
 * dos implementaciones del mismo cálculo, un bug preparado para el día en
 * que una cambiara y la otra no. Ahora calcTDEE() es un wrapper delgado
 * sobre esto, y la UI consume calcTdeeBreakdown() directamente.
 *
 * - "legacy_total_pal" (por defecto): TMB × ACTIVITY_FACTORS[activityLevel],
 *   donde el PAL ya mezcla vida cotidiana y entrenamiento habitual — no hay
 *   desglose que mostrar, así que lifestyleTdeeKcal === totalTdeeKcal y los
 *   campos de entreno quedan a 0.
 * - "lifestyle_plus_training": TMB × LIFESTYLE_ONLY_FACTORS[lifestyleActivity]
 *   + replacementIncrementKcalPerDay del entrenamiento declarado. Si el
 *   perfil dice usar este modelo pero no ha rellenado trainingActivity
 *   todavía (transición a medias), cae de vuelta al cálculo legacy.
 */
export function calcTdeeBreakdown(profile: PhysicalProfile, restingEnergyKcal: number): TdeeBreakdown {
  if (profile.activityModelVersion === "lifestyle_plus_training" && profile.trainingActivity) {
    const training = profile.trainingActivity;
    const lifestyleTdeeKcal = Math.round(restingEnergyKcal * LIFESTYLE_ONLY_FACTORS[training.lifestyleActivity]);
    const breakdown = calcHabitualTrainingBreakdown(profile.weightKg, training, lifestyleTdeeKcal);
    return {
      restingEnergyKcal,
      lifestyleTdeeKcal,
      habitualTrainingGrossKcalPerDay: breakdown.grossPerDay,
      baselineDisplacedKcalPerDay: breakdown.baselineDisplacedPerDay,
      replacementIncrementKcalPerDay: breakdown.replacementIncrementPerDay,
      totalTdeeKcal: lifestyleTdeeKcal + breakdown.replacementIncrementPerDay,
    };
  }

  const totalTdeeKcal = Math.round(restingEnergyKcal * ACTIVITY_FACTORS[profile.activityLevel]);
  return {
    restingEnergyKcal,
    lifestyleTdeeKcal: totalTdeeKcal,
    habitualTrainingGrossKcalPerDay: 0,
    baselineDisplacedKcalPerDay: 0,
    replacementIncrementKcalPerDay: 0,
    totalTdeeKcal,
  };
}

export function calcTDEE(profile: PhysicalProfile, tmb: number): number {
  return calcTdeeBreakdown(profile, tmb).totalTdeeKcal;
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

/** Etiquetas de BodyFatSource para el <select> del formulario — ver
    docs/NUTRITION_V3_DECISIONES.md §2.4/§9. El orden refleja fiabilidad
    decreciente, de más a menos precisa. */
export const BODY_FAT_SOURCE_LABELS: Record<BodyFatSource, string> = {
  dxa:              "DEXA / DXA",
  bia_professional: "Báscula/analizador profesional (clínica, gimnasio)",
  smart_scale:      "Báscula inteligente doméstica",
  skinfold:         "Plicómetro / pliegues cutáneos",
  visual_estimate:  "Estimación visual",
  other:            "Otro método",
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

/**
 * Qué tipo de peso de referencia se usó para proteína — nutrition-v3
 * (ver docs/NUTRITION_V3_DECISIONES.md §2.4/§4): antes calcProteinBase
 * devolvía un `number` desnudo y calcDailyTargets aplicaba EL MISMO
 * multiplicador g/kg a las tres bases indiscriminadamente. Efecto
 * observable del bug: introducir el % de grasa (un dato "más preciso")
 * podía BAJAR la proteína recomendada, porque 2.0 g/kg de masa magra da un
 * número mucho menor que 2.0 g/kg de peso ajustado/real. resolveProteinBase
 * nunca pierde de qué tipo es la base antes de aplicar el multiplicador —
 * ver PROTEIN_PER_KG_BY_BASE_AND_GOAL, que tiene una fila propia para
 * fat_free_mass.
 */
export type ProteinBaseKind = "actual_weight" | "adjusted_weight" | "fat_free_mass";

export interface ProteinBase {
  kind: ProteinBaseKind;
  kg: number;
}

export function resolveProteinBase(profile: PhysicalProfile): ProteinBase {
  if (profile.bodyFatPct != null) {
    return { kind: "fat_free_mass", kg: profile.weightKg * (1 - profile.bodyFatPct / 100) };
  }

  const heightM     = profile.heightCm / 100;
  const idealWeight = 25 * heightM * heightM; // IMC 25

  if (usesEspenAdjustedWeight(profile)) {
    return { kind: "adjusted_weight", kg: idealWeight + (profile.weightKg - idealWeight) * 0.33 };
  }

  return { kind: "actual_weight", kg: profile.weightKg };
}

/** Compatibilidad: solo el kg de la base, sin el tipo — usar
    resolveProteinBase() en código nuevo que necesite ramificar por tipo. */
export function calcProteinBase(profile: PhysicalProfile): number {
  return resolveProteinBase(profile).kg;
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
  muscle_gain: "+5% kcal (mantenimiento si IMC≥27, nunca déficit) · proteína 1.8 g/kg",
  recomp:      "IMC≥30: −17-20% · IMC<30: −10-17% · proteína 2.0 g/kg",
  maintain:    "100% kcal mantenimiento · proteína 1.8 g/kg",
};

interface GoalConfig {
  /** Fracción de kcal para grasa. */
  fatPct: number;
}

const GOAL_CONFIG: Record<GoalMode, GoalConfig> = {
  fat_loss:    { fatPct: 0.25 },
  muscle_gain: { fatPct: 0.25 },
  recomp:      { fatPct: 0.25 },
  maintain:    { fatPct: 0.28 },
};

/**
 * g/kg de proteína por (tipo de base × objetivo) — nutrition-v3, ver
 * docs/NUTRITION_V3_DECISIONES.md §2.4/§4. Heurísticas de producto con
 * distinto grado de respaldo directo en literatura, documentado fila por
 * fila para no venderlas todas como igual de "científicas":
 *
 * actual_weight / adjusted_weight — conservan los multiplicadores de v2
 * como decisión de compatibilidad y heurística de producto, no como una
 * equivalencia validada. El ajuste ESPEN (0.33, ver resolveProteinBase)
 * reduce el riesgo de sobreestimar necesidades en perfiles con obesidad,
 * pero ese coeficiente procede de contextos clínicos (obesidad, enfermedad
 * renal, hospitalización) — no hay respaldo para afirmar que se diseñó
 * específicamente para poder reutilizar sin más el multiplicador deportivo
 * de 2.0 g/kg de esta app. Comparten fila porque es una decisión de FoodOS
 * de mantener continuidad con v2, no porque ESPEN certifique esa cifra.
 *
 * fat_free_mass — la fila nueva, con respaldo desigual (jerarquía explícita,
 *   de más a menos anclada en evidencia directa):
 *   - fat_loss (2.6): EXTRAPOLACIÓN CONSERVADORA dentro de evidencia
 *     específica. Helms et al. 2014 sitúa 2.3–3.1 g/kg FFM para atletas de
 *     fuerza NATURALES, MAGROS y EN RESTRICCIÓN CALÓRICA — y dentro de ese
 *     rango, recomienda subir hacia el extremo alto cuanto menor sea el %
 *     graso, mayor el déficit y mayor la prioridad de preservar masa magra.
 *     Eso respalda que la rama FFM de fat_loss use un valor más alto que
 *     las ramas por peso corporal — NO que 2.6 sea la recomendación
 *     universal para cualquier usuario que seleccione "pérdida de grasa"
 *     (la mayoría no es un atleta de fuerza magro en ese contexto
 *     específico). 2.6 se eligió en la mitad-baja del rango, no en el
 *     extremo alto (3.1), para no convertir una cifra de ese contexto
 *     concreto en el default de cualquier perfil con un dato de grasa
 *     corporal.
 *   - recomp (2.4): HEURÍSTICA DE PRODUCTO, explícitamente no una cifra
 *     prescrita por ninguna guía — interpolación deliberada entre
 *     mantenimiento y el déficit más marcado de fat_loss, para un objetivo
 *     que por diseño cicla entre ambos (ver kcalFactor).
 *   - muscle_gain / maintain (2.0): REGLA PRAGMÁTICA DEL MOTOR, no una
 *     conversión directa desde ninguna recomendación por peso corporal. El
 *     ISSN sitúa 1.4–2.0 g/kg de PESO CORPORAL para población activa en
 *     general, pero ese rango no se puede trasladar sin más a g/kg de FFM
 *     — son denominadores distintos (FFM < peso total). 2.0 es un punto
 *     conservador elegido para esta base, no una traducción del rango ISSN.
 *
 * No hay garantía matemática de que fat_free_mass produzca siempre un
 * resultado ≥ el que darían actual_weight/adjusted_weight para un % de
 * grasa cualquiera (se comprobó en extremos >45% de grasa corporal y no se
 * sostiene siempre) — y no se fuerza subiendo más los multiplicadores: en
 * esos extremos, un % de grasa fiable es más preciso que la aproximación
 * ESPEN que sustituye, así que un resultado más bajo ahí no es
 * necesariamente el mismo bug que motivó este cambio. El caso que sí motivó
 * el cambio (90 kg, 20% grasa, recomp: 144 g con la tabla vieja vs. 180 g
 * — igual que sin declarar % de grasa — con esta tabla) queda resuelto.
 */
export const PROTEIN_PER_KG_BY_BASE_AND_GOAL: Record<ProteinBaseKind, Record<GoalMode, number>> = {
  actual_weight:   { fat_loss: 2.0, recomp: 2.0, muscle_gain: 1.8, maintain: 1.8 },
  adjusted_weight: { fat_loss: 2.0, recomp: 2.0, muscle_gain: 1.8, maintain: 1.8 },
  fat_free_mass:   { fat_loss: 2.6, recomp: 2.4, muscle_gain: 2.0, maintain: 2.0 },
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
 * muscle_gain: 1.05 si IMC<27 / 1.0 (mantenimiento) si IMC≥27 — nunca por
 *              debajo de 1.0 (PR4, ver docs/NUTRITION_V3_DECISIONES.md
 *              §2.6): antes de PR4 este caso devolvía 0.90 (déficit real
 *              de ~10%) con el objetivo etiquetado "ganancia muscular" —
 *              la decisión de §2.6 quedó documentada como cerrada en la
 *              primera sesión de diseño de v3 pero nunca se implementó
 *              hasta la auditoría final. No hay superávit forzado con
 *              adiposidad alta (por eso 1.0 y no 1.05), pero tampoco
 *              déficit encubierto — el aviso de shouldWarnMuscleGain()
 *              sigue recomendando recomp/pérdida de grasa, nunca cambia
 *              el objetivo por debajo del usuario.
 *
 *              ALCANCE DEL INVARIANTE (auditoría PR4, corregido tras
 *              revisión externa): "muscle_gain nunca déficit" se refiere
 *              a ESTE factor base — kcalFactor("muscle_gain", ...) >= 1.0
 *              siempre. NO es una promesa sobre calcDailyTargets().kcal
 *              final, que además suma adaptiveKcalOffsetKcal. Un offset
 *              negativo ACEPTADO EXPLÍCITAMENTE por el usuario (Adaptive
 *              v3, ver §6) SÍ puede bajar el target final por debajo del
 *              TDEE de la fórmula — eso no es el bug de §2.6 reaparecido:
 *              evaluateAdaptiveState() no recibe ni recalcula el TDEE —
 *              es el controlador corrigiendo el OBJETIVO respecto al
 *              modelo estimado, con datos reales y aceptación explícita,
 *              igual que para cualquier otro objetivo. Forzar un clamp aquí
 *              (Math.max(tdee, rawKcal)) haría que las propuestas
 *              negativas del adaptativo fueran inertes solo para
 *              muscle_gain, rompiendo la universalidad del controlador
 *              frente a los otros tres objetivos.
 * recomp:      IMC≥30 → 0.83 gym / 0.80 descanso
 *              IMC<30  → 0.90 gym / 0.83 descanso
 * maintain:    1.0
 */
function kcalFactor(goal: GoalMode, gymDay: boolean, imc: number): number {
  switch (goal) {
    case "fat_loss":
      return 0.80;
    case "muscle_gain":
      return imc >= 27 ? 1.0 : 1.05;
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
 * 2. Proteína = resolveProteinBase(profile).kg × PROTEIN_PER_KG_BY_BASE_AND_GOAL[base.kind][goal]
 *    - El tipo de base (peso real / ajustado ESPEN / masa magra) decide qué
 *      fila de la tabla se usa — nunca se pierde el tipo antes de aplicar
 *      el multiplicador (ver docs/NUTRITION_V3_DECISIONES.md §2.4/§4).
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

  const proteinBase = resolveProteinBase(profile);
  const proteinPerKg = PROTEIN_PER_KG_BY_BASE_AND_GOAL[proteinBase.kind][profile.goal];
  const proteinG = Math.round(proteinPerKg * proteinBase.kg);

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
 * Rango de proteína en 5 puntos, centrado en el target real de
 * PROTEIN_PER_KG_BY_BASE_AND_GOAL[base.kind][profile.goal] — nutrition-v3
 * (ver docs/NUTRITION_V3_DECISIONES.md §2.4/§4). Antes el rango usaba
 * offsets fijos [1.6...2.4] sin importar de qué base venía el número
 * central; con fat_free_mass en fat_loss (2.6) eso habría puesto el target
 * POR ENCIMA del broadMax (2.4) — un rango que no contiene su propio punto
 * central. Los offsets (±0.2 recomendado, ±0.4 amplio) son los mismos que
 * antes, pero aplicados alrededor del target de cada base/objetivo, no
 * como una escala absoluta fija.
 *
 * broadMin / broadMax (target ∓0.4): rango amplio de seguridad — útil para
 * validaciones, sliders, alertas de adherencia semanal. No mostrar en UI
 * principal.
 *
 * recommendedMin / recommendedMax (target ∓0.2): rango que el usuario ve.
 *
 * target: PROTEIN_PER_KG_BY_BASE_AND_GOAL[base.kind][profile.goal] × base.kg.
 *
 * Ejemplo: fat_free_mass, fat_loss, base 72 kg (90 kg, 20% grasa)
 *   target: 72 × 2.6 = 187 g
 *   recommended: 72×2.4=173 – 72×2.8=202 g
 *   broad:       72×2.2=158 – 72×3.0=216 g (contenido en el 2.3–3.1 de Helms,
 *                sin vender 3.1 como objetivo rutinario)
 */
export function calcProteinRange(profile: PhysicalProfile): {
  broadMin:       number;
  recommendedMin: number;
  target:         number;
  recommendedMax: number;
  broadMax:       number;
} {
  const base = resolveProteinBase(profile);
  const perKg = PROTEIN_PER_KG_BY_BASE_AND_GOAL[base.kind][profile.goal];
  return {
    broadMin:       Math.round((perKg - 0.4) * base.kg),
    recommendedMin: Math.round((perKg - 0.2) * base.kg),
    target:         Math.round(perKg * base.kg),
    recommendedMax: Math.round((perKg + 0.2) * base.kg),
    broadMax:       Math.round((perKg + 0.4) * base.kg),
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
 * `targetKcalByDate` es opcional (y retrocompatible: sin él, el criterio es
 * exactamente el de antes de PR10, solo el suelo absoluto) — cuando se pasa,
 * un día también necesita llegar al 60% de SU PROPIO objetivo vigente ese
 * día para contar como "con datos fiables" (ver
 * INTAKE_COVERAGE_MIN_RELATIVE_FRACTION).
 *
 * nutrition-v3 (ver docs/NUTRITION_V3_DECISIONES.md §2.3): antes se recibía
 * un único `targetKcal` escalar (normalmente el objetivo de HOY) y se
 * aplicaba a los ~28 días de la ventana por igual — si hoy es día de gym y
 * el histórico incluye días de descanso (o el perfil cambió desde
 * entonces), el suelo relativo se calculaba con el objetivo equivocado. El
 * mapa por fecha resuelve esto usando el objetivo real vigente cada día
 * (nutrition_goals, ver getNutritionGoalsRange en data-layer.ts). Un día
 * sin entrada en el mapa (sin fila nutrition_goals para esa fecha) NO
 * inventa un objetivo con el perfil actual — simplemente no aplica suelo
 * relativo ese día (se comporta como si targetKcalByDate no existiera para
 * esa fecha concreta), igual que el fallback histórico sin mapa en
 * absoluto.
 */
export function calcIntakeCoverage(
  dailyKcal: Array<{ date: string; kcal: number }>,
  referenceDate: string,
  windowDays: number,
  targetKcalByDate?: Map<string, number>,
): IntakeCoverageResult | null {
  const withData = dailyKcal.filter((d) => {
    if (d.date > referenceDate) return false;
    if (daysBetweenDates(d.date, referenceDate) >= windowDays) return false;
    if (d.kcal < INTAKE_COVERAGE_MIN_KCAL) return false;
    const targetForDate = targetKcalByDate?.get(d.date);
    const relativeFloor = targetForDate != null ? targetForDate * INTAKE_COVERAGE_MIN_RELATIVE_FRACTION : 0;
    return d.kcal >= relativeFloor;
  });
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

// ─── Controlador adaptativo por ritmo (Adaptive v3 / PR2) ────────────────────
// Ver docs/NUTRITION_V3_DECISIONES.md §6 — diseño cerrado ANTES de este
// código. Sustituye evaluateAdjustmentProposal (que decidía vía 7700/
// TDEE observado) por evaluateAdaptiveState: compara weeklyChangePercent
// contra una banda por objetivo. calcAdaptiveTdee/7700 se conservan
// exclusivamente como diagnóstico — ver test "no cambia con avgIntakeKcal"
// en nutrition.test.ts, que es la prueba ejecutable del desacoplamiento.

interface WeeklyRateBandPct {
  minPct: number;
  maxPct: number;
}

/**
 * Bandas semanales (%/semana), congeladas en docs/NUTRITION_V3_DECISIONES.md
 * §6.3 — bordes inclusivos, recomp deliberadamente asimétrica. Ver §6.2 de
 * ese documento para la clasificación evidencia/heurística/guardarraíl de
 * cada fila; no repetido aquí para no desincronizarse de la fuente.
 */
export const GOAL_RATE_BAND_PCT_PER_WEEK: Record<GoalMode, WeeklyRateBandPct> = {
  fat_loss:    { minPct: -1.00, maxPct: -0.50 },
  muscle_gain: { minPct: +0.25, maxPct: +0.50 },
  maintain:    { minPct: -0.25, maxPct: +0.25 },
  recomp:      { minPct: -0.50, maxPct:  0.00 },
};

/**
 * Posición del ritmo observado respecto a la banda del objetivo — variable
 * decisoria EXCLUSIVA: weeklyChangePercent, nunca slopeKgPerDay (ver
 * docs/NUTRITION_V3_DECISIONES.md §6.4 — 0.5 kg/semana no significa lo
 * mismo a 55 kg que a 130 kg; las bandas están en % a propósito).
 */
export function assessWeightTrajectory(goal: GoalMode, weeklyChangePercent: number): WeightTrajectoryAssessment {
  const band = GOAL_RATE_BAND_PCT_PER_WEEK[goal];
  if (weeklyChangePercent < band.minPct) return "below";
  if (weeklyChangePercent > band.maxPct) return "above";
  return "inside";
}

/** Paso fijo — ver docs/NUTRITION_V3_DECISIONES.md §6.8. El controlador
    normal SOLO puede seleccionar -100/0/+100; 150 es un hard cap de
    esquema/seguridad que este código nunca alcanza por sí mismo. */
export const DEFAULT_ADJUSTMENT_STEP_KCAL = 100;
export const MAX_ADJUSTMENT_STEP_KCAL = 150; // igual al check constraint de la tabla

/**
 * delta a partir de la trayectoria — regla ÚNICA e independiente del goal:
 * "above" la banda (el peso sube más rápido / baja más despacio de lo
 * esperado, en términos numéricos de weeklyChangePercent) siempre implica
 * bajar kcal; "below" siempre implica subir. Esto no es una coincidencia:
 * las cuatro bandas comparten el mismo convenio de signo (más negativo =
 * perder peso), así que la regla de signo emerge sola sin ramificar por
 * goal — ver docs/NUTRITION_V3_DECISIONES.md §6.9 para la tabla completa
 * de invariantes de dirección por objetivo, que este código debe satisfacer
 * como propiedad derivada, no como ifs explícitos por goal.
 */
function suggestedDeltaForTrajectory(trajectory: WeightTrajectoryAssessment): number {
  switch (trajectory) {
    case "above": return -DEFAULT_ADJUSTMENT_STEP_KCAL;
    case "below": return  DEFAULT_ADJUSTMENT_STEP_KCAL;
    case "inside": return 0;
  }
}

const ADJUSTMENT_MIN_COVERAGE = 0.85;
/**
 * Guardarraíl de producto — ver docs/NUTRITION_V3_DECISIONES.md §6.7.
 * Ninguna evidencia clínica establece 21 días como el mínimo único
 * correcto para PROPONER un ajuste (frente a solo diagnosticar/mostrar
 * tendencia, que no exige este mínimo). Se eligió para equilibrar
 * estabilidad de la tendencia y capacidad de respuesta del controlador —
 * revisar con datos reales de producción antes de tratarlo como cerrado.
 * No es una cifra "científica" — no la cites como tal en ningún sitio.
 * Exportada para que los tests la referencien en vez de hardcodear 21 en
 * varios sitios.
 */
export const ADJUSTMENT_MIN_EVALUATION_DAYS = 21;

function blockedAdaptiveState(currentTargetKcal: number, blockingReasons: string[]): AdjustmentDecision {
  return {
    shouldPropose: false,
    deltaKcal: 0,
    proposedTargetKcal: currentTargetKcal,
    reason: blockingReasons[0] ?? "No hay motivo para proponer un ajuste.",
    trajectory: null,
    blockingReasons,
  };
}

/**
 * Fuente única de verdad del motor adaptativo (Adaptive v3) — sustituye a
 * evaluateAdjustmentProposal Y a la lógica que getAdaptiveDiagnostics
 * reimplementaba en paralelo (el bug de doble fuente detectado en el mapeo
 * de esta sesión: dos invocaciones de la decisión con inputs
 * potencialmente distintos). Tanto generateProposal() (UI) como el panel de
 * diagnóstico deben consumir el resultado de ESTA función, nunca recalcular
 * por su cuenta.
 *
 * Arquitectura en tres capas (ver docs/NUTRITION_V3_DECISIONES.md §6.5):
 *   1. trajectory     — SOLO depende de goal + weeklyChangePercent
 *   2. deltaKcal       — SOLO depende de trajectory (regla de signo única)
 *   3. shouldPropose   — depende de deltaKcal!=0 + TODOS los gates de
 *                        calidad + cooldown — acumula TODOS los motivos de
 *                        bloqueo a la vez (no para en el primero), así una
 *                        propuesta puede tener trajectory="above" con
 *                        deltaKcal=-100 pero shouldPropose=false por
 *                        cooldown activo — esa información no se pierde.
 *
 * Gates: confianza de tendencia === "high" (gate semántico directo, NO vía
 * ADAPTIVE_CONFIDENCE_WEIGHTS — esa tabla pertenece al blending de
 * calcAdaptiveTdee/diagnóstico, no a esta decisión); cobertura de ingesta
 * >=85% (gate de INTERPRETABILIDAD del registro, no de "adherencia" — ver
 * docs/NUTRITION_V3_DECISIONES.md §6.6); días evaluados >= mínimo
 * provisional; cooldown inactivo.
 */
export function evaluateAdaptiveState(params: {
  goal: GoalMode;
  currentTargetKcal: number;
  weightTrend: WeightTrendResult | null;
  intakeCoverage: IntakeCoverageResult | null;
  lastAdjustmentDecisionAt: string | null;
  referenceDate: string;
}): AdjustmentDecision {
  const { goal, currentTargetKcal, weightTrend, intakeCoverage, lastAdjustmentDecisionAt, referenceDate } = params;

  const blockingReasons: string[] = [];
  if (!weightTrend) {
    blockingReasons.push("Todavía no hay suficiente historial de peso.");
  }
  if (!intakeCoverage) {
    blockingReasons.push("Todavía no hay suficiente historial de ingesta.");
  }
  if (weightTrend && weightTrend.confidence !== "high") {
    blockingReasons.push("La confianza de tu tendencia de peso todavía no es alta.");
  }
  if (intakeCoverage && intakeCoverage.coverageFraction < ADJUSTMENT_MIN_COVERAGE) {
    blockingReasons.push("Te faltan días de registro de comidas para confiar en el promedio (cobertura insuficiente para interpretar la tendencia).");
  }
  if (weightTrend && weightTrend.validMeasurements < ADJUSTMENT_MIN_EVALUATION_DAYS) {
    blockingReasons.push(`Todavía no se han evaluado suficientes días (mínimo provisional: ${ADJUSTMENT_MIN_EVALUATION_DAYS}).`);
  }
  if (isAdjustmentCooldownActive(lastAdjustmentDecisionAt, referenceDate)) {
    blockingReasons.push(`Toca esperar — hay un periodo de espera de ${ADJUSTMENT_COOLDOWN_DAYS} días entre decisiones.`);
  }

  // Capa 1 y 2: solo se pueden calcular con weightTrend real — si no lo
  // hay, no hay trajectory que evaluar (no se inventa "inside" por defecto).
  if (!weightTrend) {
    return blockedAdaptiveState(currentTargetKcal, blockingReasons);
  }

  const trajectory = assessWeightTrajectory(goal, weightTrend.weeklyChangePercent);
  const deltaKcal = suggestedDeltaForTrajectory(trajectory);

  if (deltaKcal === 0) {
    blockingReasons.push("Tu ritmo observado ya está dentro del rango esperado para tu objetivo — no hay motivo para tocarlo.");
  }

  if (blockingReasons.length > 0) {
    return {
      shouldPropose: false,
      deltaKcal: 0,
      proposedTargetKcal: currentTargetKcal,
      reason: blockingReasons[0],
      trajectory,
      blockingReasons,
    };
  }

  const band = GOAL_RATE_BAND_PCT_PER_WEEK[goal];
  const proposedTargetKcal = currentTargetKcal + deltaKcal;
  const reason =
    trajectory === "below"
      ? `Tu ritmo observado (${weightTrend.weeklyChangePercent}%/semana) está por debajo del rango esperado para tu objetivo (${band.minPct}% a ${band.maxPct}%/semana) — subir ${deltaKcal} kcal/día ayudaría a acercarte al ritmo esperado.`
      : `Tu ritmo observado (${weightTrend.weeklyChangePercent}%/semana) está por encima del rango esperado para tu objetivo (${band.minPct}% a ${band.maxPct}%/semana) — bajar ${Math.abs(deltaKcal)} kcal/día ayudaría a acercarte al ritmo esperado.`;

  return { shouldPropose: true, deltaKcal, proposedTargetKcal, reason, trajectory, blockingReasons: [] };
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
 * Diagnóstico completo del motor adaptativo para un momento dado.
 * proposalEligible/ineligibilityReasons vienen SIEMPRE de
 * evaluateAdaptiveState() — fuente única, nunca se recalcula la decisión
 * por separado aquí (ese era exactamente el bug de doble fuente detectado
 * en el mapeo de esta sesión: esta función y el panel de UI llamaban por
 * su cuenta a la lógica de decisión, con inputs que podían divergir).
 * calcAdaptiveTdee (7700) se sigue calculando para los campos de
 * diagnóstico (initialTdeeKcal/observedTdeeKcal/blendedTdeeKcal) — nunca
 * para decidir si se propone ni cuánto.
 */
export function getAdaptiveDiagnostics(params: {
  goal: GoalMode;
  weightLog: WeightEntry[];
  dailyKcal: Array<{ date: string; kcal: number }>;
  referenceDate: string;
  initialTdeeKcal: number;
  currentTargetKcal: number;
  lastAdjustmentDecisionAt: string | null;
  windowDays?: number;
  /** PR9: si hubo un reinicio de calibración más reciente que el inicio de la
      ventana estándar (referenceDate - windowDays), el periodo evaluado
      "real" empieza ahí — aunque weightLog/dailyKcal ya vengan pre-filtrados
      por el caller, evaluationStart necesita este dato aparte para mostrarlo
      correctamente (no se puede deducir solo de qué entradas sobrevivieron). */
  calibrationStartedAt?: string | null;
}): AdaptiveDiagnostics {
  const windowDays = params.windowDays ?? 28;
  const { goal, weightLog, dailyKcal, referenceDate, initialTdeeKcal, currentTargetKcal, lastAdjustmentDecisionAt } = params;
  const standardWindowStart = subtractDaysFromDateKey(referenceDate, windowDays);
  const effectiveEvaluationStart =
    params.calibrationStartedAt && params.calibrationStartedAt > standardWindowStart
      ? params.calibrationStartedAt
      : standardWindowStart;

  const weightTrend = calcWeightTrend(weightLog, referenceDate, windowDays);
  const coverage = calcIntakeCoverage(dailyKcal, referenceDate, windowDays);
  // Diagnóstico únicamente (7700) — nunca alimenta evaluateAdaptiveState.
  const adaptive = calcAdaptiveTdee({ initialTdeeKcal, avgIntakeKcal: coverage?.avgKcal ?? null, weightTrend });
  const decision = evaluateAdaptiveState({
    goal, currentTargetKcal, weightTrend, intakeCoverage: coverage, lastAdjustmentDecisionAt, referenceDate,
  });

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

  const ineligibilityReasons: string[] = [...decision.blockingReasons];
  if (adaptive.warnings.includes("tdee_estimates_strongly_disagree")) {
    ineligibilityReasons.push("El TDEE observado y el de la fórmula discrepan más de un 30% — posible dato sospechoso (informativo; ya no bloquea la decisión por ritmo).");
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
    decision,
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
    a.strengthAvgDurationMin === b.strengthAvgDurationMin &&
    a.cardioAvgDurationMin === b.cardioAvgDurationMin
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
    heightCm: profile.heightCm,
    age: profile.age,
    sex: profile.sex,
    bodyFatPct: profile.bodyFatPct,
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
    original.heightCm !== current.heightCm ||
    original.age !== current.age ||
    original.sex !== current.sex ||
    original.bodyFatPct !== current.bodyFatPct ||
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

// ─── Estimación kcal de una sesión de Ejercicios (MET) ───────────────────────
// Pipeline B (ver docs/NUTRITION_V3_DECISIONES.md §3.1) — separada de la
// pipeline de Nutrición (calcTdeeBreakdown). Estas kcal NUNCA se suman de
// vuelta al presupuesto de hoy (getPendingMacros en state.tsx) ni a
// calcTDEE — solo describen el gasto estimado de una sesión ya registrada.

/**
 * Estimación neta de kcal quemadas por una sesión registrada, excluyendo
 * el gasto basal equivalente (netAboveRestKcal — ver definición completa
 * junto a grossExerciseKcal, más arriba). Usa MET 5.0 por defecto
 * (entrenamiento de fuerza moderado). Se mantiene como wrapper de
 * compatibilidad para ExercisesView.tsx; el nombre "estimateWorkoutKcal"
 * es legado — su significado real es netAboveRestKcal, nunca grossKcal ni
 * replacementIncrementKcal (esos son conceptos de la pipeline de
 * Nutrición, no de esta).
 */
export function estimateWorkoutKcal(weightKg: number, durationMin: number, met = 5.0): number {
  return Math.round(netAboveRestKcal(met, weightKg, durationMin));
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
