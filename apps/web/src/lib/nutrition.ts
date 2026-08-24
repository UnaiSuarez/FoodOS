import type {
  ActivityLevel,
  AdaptiveDiagnostics,
  AdaptiveTdeeResult,
  AdaptiveTdeeWarning,
  AdjustmentDecision,
  AdjustmentProfileFingerprint,
  AdjustmentProposalEvidence,
  BodyFatSource,
  CalorieBreakdownExplanation,
  CalorieVsTdeeStance,
  CardioIntensity,
  CardioType,
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
  StrengthIntensity,
  TdeeBreakdown,
  TdeeUncertainty,
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
 * - nutrition-v3.1 (ver docs/NUTRITION_V3_DECISIONES.md §11): MET de cardio
 *   por tipo × intensidad en vez de CARDIO_MET=7.0 fijo (que asumía
 *   intensidad vigorosa sin preguntar), con categoría "sin confirmar"
 *   propia (CARDIO_MET_UNCONFIRMED=4.5) para perfiles legacy en vez de
 *   heredar el 7.0 disfrazado de "other+moderate". Intensidad de fuerza
 *   opcional. Representación de solapamiento fuerza/cardio por
 *   cardioOverlapDaysPerWeek + strengthAvgDurationMinIncludesCardio, sin
 *   truncar minutos en silencio. TdeeUncertainty deriva el rango de los MET
 *   bajo/alto reales de la actividad declarada (nunca un ±% arbitrario) y
 *   nunca alcanza confidence "high" en el modelo estático. Explicación de
 *   calorías (P0) generada dinámicamente comparando target real contra TDEE
 *   real, nunca un texto fijo. Cambia el resultado numérico del TDEE para
 *   perfiles con cardio declarado — bump obligatorio, no cosmético.
 */
export const NUTRITION_ENGINE_VERSION = "nutrition-v3.1";

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

const STRENGTH_MET = 5.0; // Compendium 2024, código 02052 — ver STRENGTH_INTENSITY_MET_TABLE

// ─── MET de cardio y fuerza por tipo × intensidad (nutrition-v3.1) ─────────
// Fuente: 2024 Adult Compendium of Physical Activities, PDF oficial
// (https://pacompendium.com/wp-content/uploads/2024/02/1_2024-adult-compendium_1_2024.pdf,
// descargado y verificado en esta sesión — pacompendium.com bloquea el
// fetch normal por user-agent, pero el PDF directo sí es accesible). Cada
// valor de abajo cita el código de 5 dígitos y la descripción textual EXACTA
// de esa fila. Donde el Compendio no tiene una fila para la intensidad
// "suave" de una modalidad (elíptica, remo) o para "otro" (no es una
// modalidad real, es un cajón de sastre), el valor se marca explícitamente
// como INTERPOLACIÓN DE PRODUCTO, nunca como si fuera una fila verificada.
//
// Talk test vs. MET absoluto (limitación reconocida, no resuelta por completo):
// el talk test mide esfuerzo PERCIBIDO/relativo a la condición física de cada
// persona; el Compendio tabula MET ABSOLUTOS (gasto real por kg, igual para
// cualquiera al mismo ritmo/vatiaje). Un usuario más en forma puede llamar
// "moderado" a un ritmo que objetivamente es más intenso que el de otro con
// menos condición física — no hay corrección automática posible sin medir
// ritmo/vatiaje real. Por eso:
//   1. Cada opción de intensidad se muestra en la UI con un ejemplo
//      observable (ritmo, pendiente o vatios aproximados —
//      CARDIO_INTENSITY_EXAMPLES/STRENGTH_INTENSITY_EXAMPLES) para anclar la
//      autopercepción a algo más cercano al MET absoluto real.
//   2. estimateTdeeUncertainty() nunca trata el MET de la intensidad
//      confirmada como un punto fiable sin margen: el rango bajo/alto se
//      calcula con los MET de las filas VECINAS de la misma modalidad (no
//      con un ±% arbitrario), y el techo de confianza del estimador estático
//      SIGUE sin llegar nunca a "high" — el talk test autoinformado es una
//      de las razones, documentada explícitamente en confidenceReason.
export const CARDIO_MET_TABLE: Record<CardioType, Record<CardioIntensity, number>> = {
  // 17152 "Walking, 2.0 to 2.4 mph, level, slow pace, firm surface" = 2.8
  // 17190 "Walking, 2.8 to 3.4 mph, level, moderate pace, firm surface" = 3.8
  // 17220 "Walking, 4.0 to 4.4 mph, level, firm surface, very brisk pace" = 5.5
  walk:              { light: 2.8, moderate: 3.8, vigorous: 5.5 },
  // Sin combinación mph+pendiente directa en el Compendio para "cinta con
  // inclinación" — se usa la serie de subida de cuestas al aire libre (mismo
  // patrón fisiológico: caminar cuesta arriba a distintas pendientes), fila
  // real, no interpolada:
  // 17034 "Climbing hills, no load, 1 to 5% grade, moderate-to-brisk pace" = 5.3
  // 17035 "Climbing hills, no load, 6 to 10% grade, moderate-to-brisk pace" = 7.0
  // 17036 "Climbing hills, no load, 11 to 20% grade, slow-to-moderate pace" = 8.8
  incline_treadmill: { light: 5.3, moderate: 7.0, vigorous: 8.8 },
  // Corrección de revisión: 70-80W (moderada) a 200-229W (intensa) dejaba
  // un hueco de ~120W sin representar — un usuario a, p.ej., 130W no sabía
  // qué elegir. Filas más representativas del rango típico de bici
  // estática/spinning, más cercanas entre sí:
  // 01214 "Bicycling, stationary, 50 watts, light effort" = 4.0
  // 01224 "Bicycling, stationary, 101-125 watts" = 6.8
  // 01232 "Bicycling, stationary, 151-199 watts" = 10.3
  bike:              { light: 4.0, moderate: 6.8, vigorous: 10.3 },
  // 02048 "Elliptical trainer, moderate effort" = 5.0
  // 02049 "Elliptical trainer, vigorous effort" = 9.0
  // El Compendio NO tiene una fila "elíptica, esfuerzo suave" — light es
  // INTERPOLACIÓN DE PRODUCTO (≈80% de moderate), no una fila verificada.
  elliptical:        { light: 4.0, moderate: 5.0, vigorous: 9.0 },
  // 12026 "Jogging 2.6 to 3.7 mph" = 3.3
  // 12028 "Running, 4 to 4.2 mph (13 min/mile)" = 6.5
  // 12070 "Running, 7 mph (8.5 min/mile)" = 11.0
  run:               { light: 3.3, moderate: 6.5, vigorous: 11.0 },
  // 02071 "Rowing, stationary ergometer, general, <100 watts, moderate effort" = 5.0
  // 02072 "Rowing, stationary, 100 to 149 watts, vigorous effort" = 7.5
  // El Compendio no tiene una fila de remo por debajo de 02071 (no existe
  // "remo, esfuerzo suave" explícito) — light es INTERPOLACIÓN DE PRODUCTO
  // (≈70% de moderate), no una fila verificada.
  row:               { light: 3.5, moderate: 5.0, vigorous: 7.5 },
  // "Otro" no es una modalidad real del Compendio — moderate se ancla a
  // 02060 "Health club exercise, general (Taylor Code 160)" = 5.5 (fila real);
  // light/vigorous son INTERPOLACIÓN DE PRODUCTO alrededor de ese punto,
  // declarada como tal, para cuando el usuario no puede clasificar su
  // actividad en ninguno de los tipos concretos.
  other:             { light: 3.5, moderate: 5.5, vigorous: 8.0 },
};

/** MET usado cuando el cardio NO tiene tipo NI intensidad declarados —
    perfiles legacy incluidos. Deliberadamente NO es CARDIO_MET_TABLE.other
    .moderate (5.5): equiparar "sin datos" a "el usuario eligió genérico y
    moderado" ocultaría la misma sobreestimación bajo otra etiqueta. 4.5 es
    una INTERPOLACIÓN DE PRODUCTO explícita (no una fila del Compendio):
    caminar rápido/bici muy fácil, deliberadamente por debajo del punto medio
    de la tabla — y siempre va acompañado de confidence "low". Para el caso
    de referencia (124kg, 100min/sesión) baja el TDEE de ~4015 (MET 7 fijo
    de antes) a ~3490 (junto con el default de fuerza corregido, ver
    resolveStrengthMet), sin un descuento arbitrario no explicado — el
    número sale de MET distintos, documentados y trazables. */
export const CARDIO_MET_UNCONFIRMED = 4.5;

export const CARDIO_TYPE_LABELS: Record<CardioType, string> = {
  walk:              "Caminar",
  incline_treadmill: "Cinta con inclinación",
  bike:              "Bici (estática o spinning)",
  elliptical:        "Elíptica",
  run:               "Correr",
  row:               "Remo",
  other:             "Otro",
};

/** Ejemplo observable (ritmo/pendiente/vatiaje aproximado del Compendio) para
    anclar cada intensidad a algo más cercano al MET absoluto real, no solo
    al talk test (ver nota sobre intensidad relativa vs. MET absoluto, junto
    a CARDIO_MET_TABLE). Se muestra en la UI junto a la etiqueta del talk
    test, nunca en su lugar. */
export const CARDIO_INTENSITY_EXAMPLES: Record<CardioType, Record<CardioIntensity, string>> = {
  walk:              { light: "~2-2.4 mph, ritmo lento",        moderate: "~2.8-3.4 mph, ritmo moderado",     vigorous: "~4-4.4 mph, muy enérgico" },
  // Corrección de revisión: "1-5% de inclinación" a secas era incompleto —
  // la fila del Compendio exige TAMBIÉN un ritmo moderado-rápido; caminar
  // despacio con 5% de inclinación no llega a 5.3 MET. Ritmo incluido
  // explícitamente en cada opción.
  incline_treadmill: { light: "1-5% de inclinación, ritmo moderado-rápido", moderate: "6-10% de inclinación, ritmo moderado-rápido", vigorous: "11-20% de inclinación, ritmo lento-moderado (la pendiente compensa el ritmo más lento)" },
  // Corrección de revisión: filas más cercanas entre sí (ver CARDIO_MET_TABLE) —
  // ya no hay un tramo de ~120W sin representar entre moderada e intensa.
  bike:              { light: "~50 W, esfuerzo suave",           moderate: "~101-125 W",                        vigorous: "~151-199 W, vigoroso" },
  elliptical:        { light: "esfuerzo suave, sin resistencia",  moderate: "esfuerzo moderado",                vigorous: "esfuerzo vigoroso" },
  run:               { light: "~2.6-3.7 mph, trote muy suave",   moderate: "~4-4.2 mph (13 min/milla)",        vigorous: "~7 mph (8:30 min/milla)" },
  row:               { light: "esfuerzo suave, sin apenas resistencia", moderate: "<100 W, esfuerzo moderado", vigorous: "100-149 W, vigoroso" },
  other:             { light: "esfuerzo suave",                  moderate: "esfuerzo general de gimnasio",     vigorous: "esfuerzo vigoroso" },
};

/** Etiquetas del "talk test" — mide esfuerzo PERCIBIDO, no MET absoluto (ver
    nota junto a CARDIO_MET_TABLE): suave = conversación normal; moderada =
    se puede hablar pero con algo de dificultad; intensa = solo frases
    cortas. Mostrar siempre junto al ejemplo observable de
    CARDIO_INTENSITY_EXAMPLES, nunca solo. */
export const CARDIO_INTENSITY_LABELS: Record<CardioIntensity, string> = {
  light:    "Suave — puedes mantener una conversación normal",
  moderate: "Moderada — puedes hablar, pero con algo de dificultad",
  vigorous: "Intensa — solo te salen frases cortas",
};

/** Corrección de revisión: las etiquetas ya NO usan la escala "suave/
    moderada/intensa" tipo talk-test para fuerza — a diferencia del cardio,
    lo que separa estos tres MET en el Compendio es la ESTRUCTURA de la
    sesión (qué ejercicios, cuánto descanso), no el esfuerzo percibido, y
    llamar "moderada" a la fila general (3.5) invitaba a confundirla con la
    fila de sentadilla/peso muerto (5.0). "light" (clave interna, sin
    cambios de tipo para no romper persistencia) es ahora explícitamente el
    default "general" al no especificar intensidad. */
export const STRENGTH_INTENSITY_LABELS: Record<StrengthIntensity, string> = {
  light:    "General — varios ejercicios, series y descansos normales (por defecto, 3.5 MET)",
  moderate: "Predominio de sentadilla/peso muerto, o trabajo continuo equivalente",
  vigorous: "Powerlifting/culturismo — esfuerzo realmente vigoroso, poco descanso",
};

export const STRENGTH_INTENSITY_EXAMPLES: Record<StrengthIntensity, string> = {
  light:    "8-15 repeticiones a resistencia variada, descansos normales",
  moderate: "sentadilla/peso muerto a esfuerzo lento o explosivo",
  vigorous: "levantamiento de potencia/culturismo, esfuerzo vigoroso, poco descanso",
};

// ─── MET de fuerza por intensidad (nutrition-v3.1) ──────────────────────────
// 2024 Adult Compendium of Physical Activities, sección "Conditioning
// Exercise" — filas reales, mismos tres valores que metForMuscleGroups() ya
// usaba por grupo muscular (ver más abajo), ahora con su código de origen:
// 02054 "Resistance (weight) training, multiple exercises, 8-15 reps at varied resistance" = 3.5
// 02052 "Resistance (weight) training, squats, deadlift, slow or explosive effort" = 5.0
// 02050 "Resistance (weight lifting...), power lifting or body building, vigorous effort" = 6.0
export const STRENGTH_INTENSITY_MET_TABLE: Record<StrengthIntensity, number> = {
  light:    3.5,
  moderate: 5.0,
  vigorous: 6.0,
};

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
/** MET de cardio a usar en el cálculo — CARDIO_MET_TABLE[tipo][intensidad]
    si ambos están declarados, o CARDIO_MET_UNCONFIRMED si falta cualquiera
    de los dos (nunca "other"+"moderate" como sustituto silencioso). */
function resolveCardioMet(training: TrainingActivityProfile): number {
  if (training.cardioType && training.cardioIntensity) {
    return CARDIO_MET_TABLE[training.cardioType][training.cardioIntensity];
  }
  return CARDIO_MET_UNCONFIRMED;
}

/** MET de fuerza a usar en el cálculo — STRENGTH_INTENSITY_MET_TABLE si hay
    intensidad declarada, o el valor "general" (3.5, código 02054 —
    "múltiples ejercicios, 8-15 reps a resistencia variada") si no.
    Corrección de revisión: el default previo (STRENGTH_MET = 5.0, código
    02052 = predominio sentadilla/peso muerto) sobreestimaba una sesión sin
    especificar — 5.0 no es "esfuerzo general", es un patrón concreto más
    intenso. STRENGTH_MET (5.0) sigue existiendo para metForMuscleGroups()
    (otra función, otro propósito — estimar el MET de una sesión ya
    registrada a partir de sus grupos musculares — deliberadamente NO se
    toca aquí, para no cambiar ese comportamiento sin haberlo revisado). */
function resolveStrengthMet(training: TrainingActivityProfile): number {
  if (training.strengthIntensity) {
    return STRENGTH_INTENSITY_MET_TABLE[training.strengthIntensity];
  }
  return STRENGTH_INTENSITY_MET_TABLE.light; // 3.5 — código 02054, sesión general
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
 *
 * nutrition-v3.1: si cardioOverlapDaysPerWeek > 0 Y
 * strengthAvgDurationMinIncludesCardio es true, los días de solape se tratan
 * como UNA sola sesión (duración total = strengthAvgDurationMin, con
 * cardioAvgDurationMin de esos minutos a MET cardio y el resto a MET
 * fuerza) con UN solo baselineDisplaced sobre el total — evita contar dos
 * veces el mismo tramo horario. Si cardioAvgDurationMin > strengthAvgDurationMin
 * el dato es inconsistente: en vez de truncar minutos en silencio, esos
 * días se tratan como si el flag de solape no estuviera activo (aditivo,
 * comportamiento por defecto) y quedan marcados para revisión (ver
 * validateTrainingActivity). Los días de fuerza y cardio que NO solapan
 * siguen siendo aditivos, exactamente igual que en v3.
 */
function calcHabitualTrainingBreakdown(
  weightKg: number,
  training: TrainingActivityProfile,
  lifestyleTdeeKcal: number,
): { grossPerDay: number; baselineDisplacedPerDay: number; replacementIncrementPerDay: number } {
  return calcHabitualTrainingBreakdownWithMets(
    weightKg,
    training,
    lifestyleTdeeKcal,
    resolveStrengthMet(training),
    resolveCardioMet(training),
  );
}

/** Igual que calcHabitualTrainingBreakdown pero con los MET de fuerza/cardio
    pasados explícitamente en vez de resueltos desde `training` — extraído
    para que estimateTdeeUncertainty pueda propagar los MET bajo/alto de la
    MISMA actividad declarada a través del mismo pipeline, en vez de aplicar
    un ±% arbitrario sobre el resultado ya calculado (nutrition-v3.1). */
function calcHabitualTrainingBreakdownWithMets(
  weightKg: number,
  training: TrainingActivityProfile,
  lifestyleTdeeKcal: number,
  strengthMet: number,
  cardioMet: number,
): { grossPerDay: number; baselineDisplacedPerDay: number; replacementIncrementPerDay: number } {
  const declaredOverlapDays = Math.max(0, Math.min(
    training.cardioOverlapDaysPerWeek ?? 0,
    training.strengthDaysPerWeek,
    training.cardioDaysPerWeek,
  ));
  const overlapMinutesValid = training.cardioAvgDurationMin <= training.strengthAvgDurationMin;
  const mergeDays = training.strengthAvgDurationMinIncludesCardio === true && overlapMinutesValid
    ? declaredOverlapDays
    : 0;

  let weeklyGross = 0;
  let weeklyBaseline = 0;
  let weeklyIncrement = 0;

  // Días de solape: una sola sesión combinada, un solo baselineDisplaced.
  if (mergeDays > 0) {
    const cardioPortionMin = training.cardioAvgDurationMin;
    const strengthPortionMin = training.strengthAvgDurationMin - cardioPortionMin;
    const sessionGross =
      grossExerciseKcal(cardioMet, weightKg, cardioPortionMin) +
      grossExerciseKcal(strengthMet, weightKg, strengthPortionMin);
    const sessionBaseline = baselineDisplacedKcal(lifestyleTdeeKcal, training.strengthAvgDurationMin);
    const sessionIncrement = replacementIncrementKcal(sessionGross, lifestyleTdeeKcal, training.strengthAvgDurationMin);

    weeklyGross += mergeDays * sessionGross;
    weeklyBaseline += mergeDays * sessionBaseline;
    weeklyIncrement += mergeDays * sessionIncrement;
  }

  // Resto de días de fuerza (sin solape): bloque aditivo independiente.
  const standaloneStrengthDays = training.strengthDaysPerWeek - mergeDays;
  if (standaloneStrengthDays > 0) {
    const strengthGross = grossExerciseKcal(strengthMet, weightKg, training.strengthAvgDurationMin);
    weeklyGross += standaloneStrengthDays * strengthGross;
    weeklyBaseline += standaloneStrengthDays * baselineDisplacedKcal(lifestyleTdeeKcal, training.strengthAvgDurationMin);
    weeklyIncrement += standaloneStrengthDays * replacementIncrementKcal(strengthGross, lifestyleTdeeKcal, training.strengthAvgDurationMin);
  }

  // Resto de días de cardio (sin solape): bloque aditivo independiente.
  const standaloneCardioDays = training.cardioDaysPerWeek - mergeDays;
  if (standaloneCardioDays > 0) {
    const cardioGross = grossExerciseKcal(cardioMet, weightKg, training.cardioAvgDurationMin);
    weeklyGross += standaloneCardioDays * cardioGross;
    weeklyBaseline += standaloneCardioDays * baselineDisplacedKcal(lifestyleTdeeKcal, training.cardioAvgDurationMin);
    weeklyIncrement += standaloneCardioDays * replacementIncrementKcal(cardioGross, lifestyleTdeeKcal, training.cardioAvgDurationMin);
  }

  return {
    grossPerDay: Math.round(weeklyGross / 7),
    baselineDisplacedPerDay: Math.round(weeklyBaseline / 7),
    replacementIncrementPerDay: Math.round(weeklyIncrement / 7),
  };
}

/**
 * ¿Es internamente consistente el trainingActivity declarado? Puramente de
 * validación de entrada — no modifica ni trunca nada, solo señala qué
 * revisar (nutrition-v3.1, ver calcHabitualTrainingBreakdown). La UI debe
 * bloquear el guardado mientras haya issues, en vez de guardar un dato
 * inconsistente y dejar que el cálculo lo reinterprete en silencio.
 */
export function validateTrainingActivity(training: TrainingActivityProfile): string[] {
  const issues: string[] = [];
  const overlapDays = training.cardioOverlapDaysPerWeek ?? 0;
  if (overlapDays > Math.min(training.strengthDaysPerWeek, training.cardioDaysPerWeek)) {
    issues.push(
      "Los días de solape no pueden superar el mínimo entre días de fuerza y días de cardio.",
    );
  }
  if (
    training.strengthAvgDurationMinIncludesCardio === true &&
    training.cardioAvgDurationMin > training.strengthAvgDurationMin
  ) {
    issues.push(
      "Si el cardio está incluido en la sesión de fuerza, sus minutos no pueden superar la duración total de esa sesión — ajusta las duraciones en vez de guardar así.",
    );
  }
  return issues;
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

// ─── Incertidumbre del TDEE estático (nutrition-v3.1) ───────────────────────

/**
 * Rango de incertidumbre del "gasto medio diario estimado de la semana" —
 * nunca se presenta como cifra exacta. Con "lifestyle_plus_training", el
 * rango se deriva propagando los MET bajo/alto de la MISMA actividad
 * declarada por el mismo pipeline gross→baselineDisplaced→replacementIncrement
 * que el valor central (nunca un ±% inventado sobre el resultado ya
 * calculado). Sin desglose de entrenamiento ("legacy_total_pal"), se usa un
 * margen fijo del 15%, documentado aquí como heurística de producto — no una
 * medición.
 *
 * El techo de confianza es SIEMPRE "moderate": "high" queda reservado al
 * motor adaptativo con datos de seguimiento suficientes y consistentes (ver
 * evaluateAdaptiveState) — el estimador estático inicial nunca lo alcanza,
 * ni con tipo/intensidad/hábito confirmados. Con IMC≥30 se documenta
 * explícitamente la incertidumbre individual adicional, conocida en la
 * literatura, de las ecuaciones predictivas de TDEE en personas con
 * obesidad — no baja el techo por debajo de "moderate" (ya no hay margen
 * más bajo que dar), pero sí se refleja en confidenceReason.
 */
/** Bracket bajo/alto de MET para una intensidad concreta, usando las filas
    VECINAS de la misma tabla (no un ±% arbitrario sobre el punto elegido).
    "light"/"vigorous" llevan además un pequeño margen adicional (±15%) hacia
    afuera porque no existe una fila todavía más suave/intensa con la que
    acotar ese lado — "moderate" acota con el rango completo suave↔intenso,
    genuinamente amplio porque "moderado" por talk test es la categoría más
    ambigua de las tres (ver nota sobre intensidad relativa vs. MET absoluto
    junto a CARDIO_MET_TABLE). */
function neighborMetRange(low: number, mid: number, high: number, selected: "light" | "moderate" | "vigorous"): { low: number; high: number } {
  if (selected === "light") return { low: low * 0.85, high: mid };
  if (selected === "vigorous") return { low: mid, high: high * 1.15 };
  return { low, high };
}

export function estimateTdeeUncertainty(profile: PhysicalProfile, breakdown: TdeeBreakdown): TdeeUncertainty {
  const midKcal = breakdown.totalTdeeKcal;
  const isObese = calcIMC(profile.weightKg, profile.heightCm) >= 30;

  if (profile.activityModelVersion !== "lifestyle_plus_training" || !profile.trainingActivity) {
    const marginPct = 0.15;
    return {
      lowKcal: Math.round(midKcal * (1 - marginPct)),
      highKcal: Math.round(midKcal * (1 + marginPct)),
      midKcal,
      confidence: "low",
      confidenceReason:
        "Calculado solo con el factor de actividad clásico (PAL), sin desglosar el entrenamiento por tipo/intensidad — margen amplio por defecto.",
    };
  }

  const training = profile.trainingActivity;
  const lifestyleTdeeKcal = breakdown.lifestyleTdeeKcal;

  // Solo exigimos dato de una modalidad si esa modalidad REALMENTE participa
  // en el cálculo (días > 0) — 0 días de cardio no debería bajar la
  // confianza por "cardio sin confirmar" cuando no hay ningún cardio que
  // confirmar (nutrition-v3.1, corrección de revisión).
  const cardioMatters = training.cardioDaysPerWeek > 0;
  const strengthMatters = training.strengthDaysPerWeek > 0;
  const cardioKnown = !!(training.cardioType && training.cardioIntensity);
  const strengthKnown = !!training.strengthIntensity;

  let cardioMetLow: number;
  let cardioMetHigh: number;
  if (cardioKnown) {
    const row = CARDIO_MET_TABLE[training.cardioType as CardioType];
    ({ low: cardioMetLow, high: cardioMetHigh } = neighborMetRange(row.light, row.moderate, row.vigorous, training.cardioIntensity as CardioIntensity));
  } else {
    // Sin tipo/intensidad: no sabemos nada, bracket deliberadamente amplio
    // alrededor del MET "sin confirmar".
    cardioMetLow = CARDIO_MET_UNCONFIRMED * 0.6;
    cardioMetHigh = CARDIO_MET_UNCONFIRMED * 1.8;
  }

  let strengthMetLow: number;
  let strengthMetHigh: number;
  if (strengthKnown) {
    const t = STRENGTH_INTENSITY_MET_TABLE;
    ({ low: strengthMetLow, high: strengthMetHigh } = neighborMetRange(t.light, t.moderate, t.vigorous, training.strengthIntensity as StrengthIntensity));
  } else {
    strengthMetLow = STRENGTH_INTENSITY_MET_TABLE.light;
    strengthMetHigh = STRENGTH_INTENSITY_MET_TABLE.vigorous;
  }

  const lowTraining  = calcHabitualTrainingBreakdownWithMets(profile.weightKg, training, lifestyleTdeeKcal, strengthMetLow,  cardioMetLow);
  const highTraining = calcHabitualTrainingBreakdownWithMets(profile.weightKg, training, lifestyleTdeeKcal, strengthMetHigh, cardioMetHigh);

  // Margen adicional sobre reposo+vida cotidiana: cualquier ecuación
  // predictiva de TMB/TDEE (Mifflin-St Jeor incluida) tiene un error
  // individual conocido frente a calorimetría real, mayor en personas con
  // obesidad — limitación general documentada en la literatura, no un
  // hallazgo propio de esta app.
  const restingMarginPct = isObese ? 0.10 : 0.07;
  const lowResting  = Math.round(lifestyleTdeeKcal * (1 - restingMarginPct));
  const highResting = Math.round(lifestyleTdeeKcal * (1 + restingMarginPct));

  const lowKcal  = Math.round(lowResting  + lowTraining.replacementIncrementPerDay);
  const highKcal = Math.round(highResting + highTraining.replacementIncrementPerDay);

  const reasons: string[] = [];
  if (cardioMatters && !cardioKnown) reasons.push("tipo/intensidad de cardio sin confirmar");
  if (strengthMatters && !strengthKnown) reasons.push("intensidad de fuerza sin confirmar");
  if (training.isHabitual === false) reasons.push("entrenamiento planeado, todavía no confirmado como hábito");
  if (training.legacyDurationUnconfirmed) reasons.push("duraciones migradas de un dato antiguo, sin revisar");

  const confidence: Exclude<ConfidenceLevel, "high"> = reasons.length > 0 ? "low" : "moderate";
  // El talk test mide esfuerzo percibido, no el MET absoluto que tabula el
  // Compendio — esta limitación aplica SIEMPRE que haya cardio/fuerza
  // declarados, confirmados o no, así que se documenta incondicionalmente.
  const hasAnyTraining = cardioMatters || strengthMatters;
  const talkTestNote = hasAnyTraining
    ? " La intensidad se autoinforma con el \"talk test\" (esfuerzo percibido), no con ritmo/vatiaje medido — el MET real de tu sesión puede diferir del valor tabulado, incluso con tipo e intensidad confirmados."
    : "";
  const obesityNote = isObese
    ? " Las ecuaciones de TDEE tienen incertidumbre individual relevante, más aún en personas con obesidad — por eso el estimador inicial no supera confianza moderada."
    : " El estimador inicial no supera confianza moderada — la confianza alta solo se alcanza con datos de seguimiento reales del motor adaptativo.";
  const confidenceReason = reasons.length > 0
    ? `Confianza baja: ${reasons.join("; ")}.${talkTestNote}${obesityNote}`
    : `Tipo, intensidad y hábito de entrenamiento confirmados.${talkTestNote}${obesityNote}`;

  return { lowKcal, highKcal, midKcal, confidence, confidenceReason };
}

// ─── "¿Por qué estas calorías?" (P0 + P1, nutrition-v3.1) ───────────────────

/** ¿Un valor de kcal queda en déficit, superávit o cerca del mantenimiento
    frente al TDEE? Banda de ±3% para no etiquetar como déficit/superávit el
    ruido de redondeo. Base de toda explicación que compara calorías reales
    contra TDEE real — nunca un texto fijo que pueda contradecir las cifras. */
export function describeCalorieVsTdee(kcal: number, tdeeKcal: number): CalorieVsTdeeStance {
  if (tdeeKcal <= 0) return "near_maintenance";
  const diffPct = (kcal - tdeeKcal) / tdeeKcal;
  if (diffPct <= -0.03) return "deficit";
  if (diffPct >= 0.03) return "surplus";
  return "near_maintenance";
}

/**
 * Texto del ciclo semanal de calorías (sustituye el bloque fijo de
 * "ligero superávit los días de gym... media semanal casi neutra" que
 * NutritionView.tsx mostraba siempre para recomp, incluso cuando las cifras
 * reales eran un déficit — nutrition-v3.1 P0). Genérico para cualquier
 * objetivo: compara gymDayKcal/restDayKcal/weeklyAvgKcal contra el TDEE real
 * y compone el texto según el signo, así que NUNCA puede afirmar superávit
 * cuando el número real es un déficit.
 */
export function explainCalorieCycle(params: {
  gymDayKcal: number;
  restDayKcal: number;
  gymDaysPerWeek: number;
  tdeeKcal: number;
}): string {
  const { gymDayKcal, restDayKcal, gymDaysPerWeek, tdeeKcal } = params;
  const restDaysPerWeek = 7 - gymDaysPerWeek;
  const weeklyAvgKcal = Math.round((gymDayKcal * gymDaysPerWeek + restDayKcal * restDaysPerWeek) / 7);

  const gymStance = describeCalorieVsTdee(gymDayKcal, tdeeKcal);
  const restStance = describeCalorieVsTdee(restDayKcal, tdeeKcal);
  const avgStance = describeCalorieVsTdee(weeklyAvgKcal, tdeeKcal);

  if (gymDayKcal === restDayKcal) {
    const stanceLabel = avgStance === "deficit" ? "en déficit" : avgStance === "surplus" ? "en superávit" : "cerca del mantenimiento";
    return `Mismas calorías todos los días (${weeklyAvgKcal} kcal de media) — quedas ${stanceLabel} frente a tu gasto medio diario estimado de la semana (${tdeeKcal} kcal).`;
  }

  if (gymStance !== "surplus" && restStance !== "surplus") {
    // Nunca se llega aquí con superávit en ningún día — cubre déficit puro,
    // mezcla déficit/mantenimiento, y mantenimiento en ambos.
    if (gymStance === "deficit" && restStance === "deficit") {
      return `Mantendrás un déficit moderado durante la semana. Los días de entrenamiento recibirás algo más de energía (${gymDayKcal} kcal) que en descanso (${restDayKcal} kcal) para favorecer el rendimiento y la recuperación, pero seguirás en déficit — la media semanal (${weeklyAvgKcal} kcal) queda por debajo de tu gasto medio diario estimado de la semana (${tdeeKcal} kcal).`;
    }
    return `La media semanal (${weeklyAvgKcal} kcal) queda cerca de tu gasto medio diario estimado de la semana (${tdeeKcal} kcal) — un objetivo de mantenimiento aproximado, no un superávit.`;
  }

  if (gymStance === "surplus" && restStance !== "surplus") {
    const avgLabel = avgStance === "surplus" ? "en ligero superávit" : avgStance === "deficit" ? "en ligero déficit" : "prácticamente neutra";
    return `Los días de entrenamiento (${gymDayKcal} kcal) tendrás algo más de energía para favorecer el rendimiento y la recuperación; en descanso (${restDayKcal} kcal) bajas a ${restStance === "deficit" ? "déficit" : "mantenimiento"}. La media semanal queda ${avgLabel} frente a tu gasto medio diario estimado de la semana (${weeklyAvgKcal} kcal vs. ${tdeeKcal} kcal).`;
  }

  return `Tanto los días de entrenamiento (${gymDayKcal} kcal) como los de descanso (${restDayKcal} kcal) quedan en superávit frente a tu gasto medio diario estimado de la semana — media semanal ${weeklyAvgKcal} kcal frente a ${tdeeKcal} kcal.`;
}

/** Banda cualitativa de ritmo esperado — nunca kg/semana exactos ni deriva
    del factor 7700 kcal/kg (sigue siendo solo diagnóstico, ver
    calcAdaptiveTdee). La tendencia real la confirma el motor adaptativo. */
function expectedPaceLabel(deltaKcal: number, tdeeKcal: number): string {
  const deltaPct = tdeeKcal > 0 ? deltaKcal / tdeeKcal : 0;
  const abs = Math.abs(deltaPct);
  const sign = deltaKcal < 0 ? "Déficit" : deltaKcal > 0 ? "Superávit" : "Diferencia";
  if (abs < 0.03) {
    return `${sign} muy pequeño frente a tu gasto medio diario estimado de la semana — ritmo esperado lento, casi de mantenimiento. La tendencia real de peso la confirmará el motor adaptativo, no esta cifra sola.`;
  }
  if (abs < 0.15) {
    return `${sign} moderado frente a tu gasto medio diario estimado de la semana — ritmo esperado bajo-moderado, como objetivo inicial recomendado. El motor adaptativo lo ajustará según tu tendencia real de peso.`;
  }
  return `${sign} más pronunciado frente a tu gasto medio diario estimado de la semana — vigila adherencia y energía. El ritmo real lo confirmará el motor adaptativo con tus datos, nunca una proyección fija de kg/semana.`;
}

/**
 * Desglose para "¿Por qué estas calorías?" — puramente derivado de
 * TdeeBreakdown + el objetivo medio semanal ya calculado, nunca una fuente
 * de verdad independiente. Suma exacta: restingEnergyKcal + dailyLifeKcal +
 * habitualTrainingKcal + goalAdjustmentKcal === weeklyAverageTargetKcal —
 * invariante protegido por test.
 */
export function buildCalorieBreakdownExplanation(
  breakdown: TdeeBreakdown,
  weeklyAverageTargetKcal: number,
): CalorieBreakdownExplanation {
  const restingEnergyKcal = breakdown.restingEnergyKcal;
  const dailyLifeKcal = breakdown.lifestyleTdeeKcal - breakdown.restingEnergyKcal;
  const habitualTrainingKcal = breakdown.replacementIncrementKcalPerDay;
  const deltaVsTdeeKcal = Math.round(weeklyAverageTargetKcal - breakdown.totalTdeeKcal);
  return {
    restingEnergyKcal,
    dailyLifeKcal,
    habitualTrainingKcal,
    goalAdjustmentKcal: deltaVsTdeeKcal,
    weeklyAverageTargetKcal,
    deltaVsTdeeKcal,
    expectedPaceLabel: expectedPaceLabel(deltaVsTdeeKcal, breakdown.totalTdeeKcal),
  };
}

/** Umbral (kcal/día) a partir del cual el entrenamiento habitual contribuye
    "mucho" al TDEE — usado solo para decidir si mostrar el aviso de volumen
    planeado extremo, no para modificar ningún cálculo. */
const HIGH_VOLUME_TRAINING_KCAL_PER_DAY = 500;

/**
 * Aviso explícito cuando el entrenamiento declarado es un PLAN todavía sin
 * confirmar como hábito (isHabitual === false) y su contribución al TDEE es
 * grande (nutrition-v3.1, corrección de revisión — "no presentes 4.000-4.700
 * kcal como punto central fiable solo porque el usuario seleccionó
 * 'intenso'"). NUNCA reduce el kcal calculado — sería exactamente el
 * descuento arbitrario que este motor evita en otras partes — solo hace
 * explícito que el número presupone completar el plan tal cual, con
 * confianza baja. null si no aplica (hábito ya confirmado, o el
 * entrenamiento no es lo bastante grande para necesitar el aviso). */
export function explainPlannedVolumeRisk(
  training: TrainingActivityProfile | null | undefined,
  habitualTrainingKcalPerDay: number,
  lifestyleTdeeKcal: number,
): string | null {
  if (!training || training.isHabitual !== false) return null;
  const isHighVolume =
    habitualTrainingKcalPerDay >= HIGH_VOLUME_TRAINING_KCAL_PER_DAY ||
    habitualTrainingKcalPerDay >= lifestyleTdeeKcal * 0.3;
  if (!isHighVolume) return null;
  return "Este gasto presupone que completas el plan declarado. Como todavía no es habitual, la estimación tiene confianza baja y puede cambiar notablemente.";
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
    en ninguna fórmula (ver N8), así que cambiarlo NO debe invalidar nada.
    nutrition-v3.1: cardioType/cardioIntensity/strengthIntensity/
    cardioOverlapDaysPerWeek/strengthAvgDurationMinIncludesCardio SÍ cambian
    el MET o el reparto usado en el cálculo → decisionales, PERO solo cuando
    de verdad participan en él (corrección de revisión): cardioType/
    cardioIntensity no importan si NINGÚN lado tiene cardioDaysPerWeek > 0
    (0 días × cualquier MET = 0, el cambio es matemáticamente inerte);
    strengthIntensity no importa si NINGÚN lado tiene strengthDaysPerWeek > 0;
    cardioOverlapDaysPerWeek no importa si NINGÚN lado tiene
    strengthAvgDurationMinIncludesCardio activo (solo entra en el cálculo
    combinado con ese flag — ver calcHabitualTrainingBreakdownWithMets).
    stepsIncludeCardio e isHabitual son informativos (no tocan el kcal
    calculado, solo confianza/copy) → mismo criterio que habitualSteps, NUNCA
    se comparan aquí. */
function trainingActivityRelevantEqual(
  a: TrainingActivityProfile | null | undefined,
  b: TrainingActivityProfile | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  if (
    a.lifestyleActivity !== b.lifestyleActivity ||
    a.strengthDaysPerWeek !== b.strengthDaysPerWeek ||
    a.cardioDaysPerWeek !== b.cardioDaysPerWeek ||
    a.strengthAvgDurationMin !== b.strengthAvgDurationMin ||
    a.cardioAvgDurationMin !== b.cardioAvgDurationMin
  ) {
    return false;
  }

  // A partir de aquí a.cardioDaysPerWeek === b.cardioDaysPerWeek y lo mismo
  // para strengthDaysPerWeek (ya comparados arriba) — basta con mirar un
  // lado para saber si esa modalidad participa en el cálculo.
  const cardioMatters = b.cardioDaysPerWeek > 0;
  const strengthMatters = b.strengthDaysPerWeek > 0;

  if (cardioMatters && (a.cardioType ?? null) !== (b.cardioType ?? null)) return false;
  if (cardioMatters && (a.cardioIntensity ?? null) !== (b.cardioIntensity ?? null)) return false;
  if (strengthMatters && (a.strengthIntensity ?? null) !== (b.strengthIntensity ?? null)) return false;

  // El flag y los días de solape solo son decisionales JUNTOS — igual que en
  // calcHabitualTrainingBreakdownWithMets, ni el flag solo ni los días solos
  // cambian nada si el otro es 0/false (mergeDays sale 0 igualmente). Se
  // compara la cantidad de días REALMENTE fusionados en sesión combinada,
  // no los campos crudos por separado.
  const effectiveMergeDays = (x: TrainingActivityProfile): number =>
    x.strengthAvgDurationMinIncludesCardio ? Math.max(0, Math.min(x.cardioOverlapDaysPerWeek ?? 0, x.strengthDaysPerWeek, x.cardioDaysPerWeek)) : 0;
  if (effectiveMergeDays(a) !== effectiveMergeDays(b)) return false;

  return true;
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
    engineVersion: NUTRITION_ENGINE_VERSION,
  };
}

/**
 * ¿Sigue siendo válido aceptar una propuesta generada con `original` ahora
 * que el perfil actual es `current`? true si CUALQUIER campo relevante
 * cambió desde que se generó.
 *
 * nutrition-v3.1: también compara `engineVersion`. Una propuesta generada
 * bajo un motor distinto al actual (p.ej. "nutrition-v3" con el motor ya en
 * "nutrition-v3.1") queda obsoleta aunque el perfil no haya cambiado en
 * absoluto — un cambio de fórmula puede mover el TDEE/target recalculado
 * sin que ningún campo del perfil se haya tocado. Fingerprints de antes de
 * este campo no tienen `engineVersion` (undefined), así que también
 * difieren del motor actual y quedan obsoletas — mismo tratamiento, sin
 * caso especial aparte (correcto para la transición v3 → v3.1).
 *
 * Sin fingerprint original (`original` undefined — propuestas creadas antes
 * de PR9, previas al propio fingerprint): siempre obsoleta. Corrección de
 * revisión (ronda 3): sin fingerprint no hay forma de comprobar si peso,
 * edad, objetivo, actividad, macros u offset cambiaron desde que se generó
 * la propuesta — que `evidence.engineVersion` coincida con el motor actual
 * no dice nada sobre esos campos, solo sobre la versión de fórmula.
 * Aceptar una propuesta sin contexto verificable es exactamente el riesgo
 * que el fingerprint existe para evitar, así que no hay atajo: queda
 * obsoleta siempre, sin excepción por `engineVersion` (corrección de
 * revisión, ronda 4: el parámetro `originalEngineVersion` que existía para
 * este fallback se eliminó de la firma al quedar sin ningún uso real —
 * ver `pending.evidence.engineVersion` en el call site, que ya solo sirve
 * como evidencia auditora, no como input de esta función). Rechazar una
 * propuesta obsoleta sigue permitido siempre; esto solo bloquea aceptarla.
 */
export function isProposalStale(
  original: AdjustmentProfileFingerprint | undefined,
  current: AdjustmentProfileFingerprint,
): boolean {
  if (!original) return true;
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
    original.engineVersion !== current.engineVersion ||
    !trainingActivityRelevantEqual(original.trainingActivity, current.trainingActivity)
  );
}

/**
 * ¿Este perfil concreto queda afectado NUMÉRICAMENTE por el cambio de
 * fórmula de nutrition-v3 a nutrition-v3.1 (corrección de revisión — antes
 * applyEngineVersionTransition reiniciaba la calibración de TODOS los
 * perfiles sin lastCalculationEngineVersion, incluidos legacy_total_pal o
 * sin cardio, cuyo TDEE calculado no cambia en absoluto)?
 *
 * v3.1 cambió DOS defaults sin confirmar, no solo uno:
 * - cardio: MET fijo 7.0 → CARDIO_MET_UNCONFIRMED (4.5) cuando
 *   cardioDaysPerWeek > 0 y no hay tipo/intensidad declarados.
 * - fuerza: MET fijo 5.0 → "general" (3.5, código 02054) cuando
 *   strengthDaysPerWeek > 0 y no hay intensidad declarada.
 * (El segundo no estaba en el pedido de revisión original porque se
 * corrigió en el mismo commit que esto — dejarlo fuera habría reproducido
 * el mismo problema que se pidió arreglar, solo que para el otro default.)
 *
 * legacy_total_pal (PAL) nunca usa estos MET — un perfil así NUNCA puede
 * quedar afectado por este cambio de fórmula. Un perfil con
 * lifestyle_plus_training pero 0 días de la modalidad que cambió, tampoco.
 * En la práctica, para un perfil realmente legado (guardado antes de que
 * cardioType/strengthIntensity existieran en el formulario), "sin
 * confirmar" y "cardioDaysPerWeek > 0" son equivalentes — pero se comprueba
 * la condición completa por si esta función se reutiliza en el futuro con
 * perfiles que ya tuvieran algunos de estos campos confirmados.
 */
function isAffectedByV31FormulaChange(profile: PhysicalProfile): boolean {
  if (profile.activityModelVersion !== "lifestyle_plus_training" || !profile.trainingActivity) return false;
  const t = profile.trainingActivity;
  const cardioAffected = t.cardioDaysPerWeek > 0 && !(t.cardioType && t.cardioIntensity);
  const strengthAffected = t.strengthDaysPerWeek > 0 && !t.strengthIntensity;
  return cardioAffected || strengthAffected;
}

/**
 * Estrategia de transición nutrition-v3 → nutrition-v3.1 para perfiles ya
 * existentes (ver revisión de nutrition-v3.1 §2). Un cambio de FÓRMULA
 * (MET de cardio/fuerza por tipo/intensidad en vez de fijo) puede mover el
 * TDEE calculado de un perfil sin que el usuario haya tocado nada — a
 * diferencia de un cambio de perfil normal, esto no lo detecta
 * isRelevantCalibrationChange (compara dos PhysicalProfile, no sabe de
 * versiones de motor).
 *
 * SIEMPRE sella `lastCalculationEngineVersion` cuando no está al día — eso
 * no depende de si el perfil está afectado, solo de que el motor avanzó.
 * SOLO reinicia la ventana de calibración (adaptiveCalibrationStartedAt/
 * lastTargetChangedAt) cuando isAffectedByV31FormulaChange() es true —
 * corrección de revisión: antes se reiniciaba incondicionalmente, incluso
 * para legacy_total_pal o perfiles sin cardio/fuerza que el cambio de
 * fórmula ni siquiera toca, descartando sin motivo su ventana adaptativa ya
 * calibrada.
 *
 * Decisiones explícitas, ninguna borra información:
 * - adaptiveKcalOffsetKcal (ajuste ya aceptado por el usuario): se
 *   CONSERVA tal cual, esté o no afectado el perfil. No es una medición
 *   absoluta ligada al TDEE antiguo — es una corrección de tendencia real
 *   observada, y el motor adaptativo ya trata cualquier TDEE de fórmula
 *   como diagnóstico, nunca como verdad (ver evaluateAdaptiveState). Si la
 *   combinación offset+TDEE nuevo se desvía de la tendencia real en un
 *   perfil afectado, el propio motor lo detectará y propondrá una
 *   corrección nueva en su próximo ciclo — autocorrección ya existente, no
 *   un mecanismo nuevo.
 * - Historial de peso/ingesta ya registrado: NUNCA se borra ni se filtra de
 *   la base de datos. En perfiles afectados, se deja de usar como
 *   referencia para la ventana activa de calibración (mismo mecanismo que
 *   isRelevantCalibrationChange ya usa para cambios de objetivo/actividad —
 *   filterEntriesFromCalibrationStart sigue leyendo las filas reales, solo
 *   cambia desde qué fecha las cuenta). En perfiles NO afectados, la
 *   ventana ni se toca.
 * - Propuestas PENDIENTES (no aceptadas): se invalidan vía isProposalStale
 *   (engineVersion), no aquí — esta función solo toca el perfil.
 *
 * Devuelve null solo si el perfil ya está al día (lastCalculationEngineVersion
 * === motor actual) — si hace falta sellar la versión, SIEMPRE devuelve un
 * perfil nuevo, afectado o no. Idempotente: llamarla dos veces con el
 * resultado de la primera no vuelve a resetear nada.
 */
export function applyEngineVersionTransition(
  profile: PhysicalProfile,
  todayDateKey: string,
): PhysicalProfile | null {
  if (profile.lastCalculationEngineVersion === NUTRITION_ENGINE_VERSION) return null;
  const affected = isAffectedByV31FormulaChange(profile);
  return {
    ...profile,
    lastCalculationEngineVersion: NUTRITION_ENGINE_VERSION,
    ...(affected
      ? { adaptiveCalibrationStartedAt: todayDateKey, lastTargetChangedAt: todayDateKey }
      : {}),
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
