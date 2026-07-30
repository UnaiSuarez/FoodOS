// Tipos compartidos de FoodOS.
// Los usan apps/web hoy, y apps/mobile y apps/desktop en el futuro.
// Reflejan el modelo de datos de supabase/schema.sql (ver docs/data-model.md).

export type StorageName = "Nevera" | "Congelador" | "Despensa";

export interface InventoryItem {
  id: string;
  name: string;
  qty: number;
  unit: string;
  storage: StorageName;
  /** Fecha ISO yyyy-mm-dd */
  expires: string;
  price: number;
  /** kcal por 100 g */
  kcal: number;
  /** Proteína por 100 g */
  protein: number;
  /** Hidratos de carbono por 100 g (de OFF / USDA) */
  carbs?: number;
  /** Grasas totales por 100 g (de OFF / USDA) */
  fat?: number;
  /** Sal por 100 g en g (de OFF) */
  salt?: number;
  /** Fibra por 100 g en g (de OFF / USDA) */
  fiber?: number;
  /** Azúcares por 100 g en g (de OFF) */
  sugars?: number;
  /** Gramos/ml que representa 1 unidad cuando unit==="ud" (ej. una lata de 250 ml). Si no se indica, se asume 60. */
  unitSize?: number;
  /** Marca del producto (de OFF), si está disponible. */
  brand?: string;
  /** URL de la foto del producto (de OFF) — solo se enlaza, no se descarga ni se aloja. */
  imageUrl?: string;
  /** Tags de alérgenos de Open Food Facts (ej. "en:gluten", "en:milk"), sin traducir. */
  allergenTags?: string[];
  /**
   * Origen de los datos nutricionales (kcal/protein) de este lote.
   * "ai" = estimado por un modelo de lenguaje, no viene de una base de datos
   * verificada — mostrar como aproximado y animar a revisarlo.
   */
  dataSource?: "local" | "off" | "usda" | "ai" | "manual";
}

export interface CartItem {
  id: string;
  name: string;
  qty: number;
  unit: string;
  price: number;
  store: string;
  checked: boolean;
  /** Origen del item para mostrar badge contextual */
  source?: "manual" | "plan" | "lowstock" | "recipe";
  /** Motivo concreto por el que está en el carrito, ej. "Para: Bowl de pollo".
      Para items de receta/plan; se muestra bajo el nombre en el carrito. */
  reason?: string;
  /** Gramos/ml que representa 1 unidad cuando unit==="ud", heredado del item de inventario origen. */
  unitSize?: number;
}

export type MovementType = "expense" | "income";

export interface Movement {
  id: string;
  type: MovementType;
  amount: number;
  category: string;
  description: string;
  /** Fecha ISO yyyy-mm-dd */
  date: string;
}

export type IncomeFrequency = "weekly" | "biweekly" | "monthly" | "yearly";

/** Gasto fijo mensual recurrente (alquiler, suscripciones, suministros…). */
export interface RecurringExpense {
  id: string;
  name: string;
  amount: number;
  frequency: IncomeFrequency;
  category: string;
  active: boolean;
}

/** Fuente de ingreso recurrente (PDF §8.1). */
export interface IncomeSource {
  id: string;
  name: string;
  amount: number;
  frequency: IncomeFrequency;
  /** Dia del mes en que se cobra (1-31), opcional. */
  dayOfMonth: number | null;
  active: boolean;
}

/** Meta de ahorro con nombre propio (ej. "Viaje en agosto"), en vez de solo un % abstracto. */
export interface SavingsGoal {
  name: string;
  targetAmount: number;
  /** Fecha ISO yyyy-mm-dd objetivo, opcional. */
  targetDate: string | null;
  /** Fecha ISO en que se creó la meta — desde aquí se estima el progreso acumulado. */
  createdAt: string;
}

/** Ingrediente de receta con cantidad, para poder escalar (PDF §5.3). */
export interface RecipeIngredient {
  name: string;
  quantity: number;
  unit: string;
  /** Macros por 100 g — opcionales, se rellenan en la UI al crear/editar receta */
  kcalPer100?: number;
  proteinPer100?: number;
  carbsPer100?: number;
  fatPer100?: number;
  /** Gramos/ml por unidad cuando unit==="ud" (ej. 1 huevo = 60g). Si no se indica, se asume 60. */
  unitSize?: number;
}

export interface Recipe {
  id: string;
  title: string;
  ingredients: RecipeIngredient[];
  /** Macros POR RACION */
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Coste por racion en EUR */
  cost: number;
  image: string;
  time: number;
  servings: number;
  difficulty: string;
  tags: string[];
  steps: string[];
  /** true si la genero la IA (PDF §15.7) */
  aiGenerated?: boolean;
  /** Una frase de la IA explicando por qué esta receta encaja AHORA con el
      usuario: qué ingrediente del inventario aprovecha (sobre todo si caduca
      pronto), qué macros pendientes cubre, o cómo respeta el presupuesto
      (why_this_recipe, PDF §15). Solo en recetas generadas por IA. */
  whyThisRecipe?: string;
}

export interface FeedComment {
  author: string;
  text: string;
}

export interface FeedPost {
  id: string;
  recipeId: string;
  author: string;
  title: string;
  caption: string;
  likes: number;
  comments: FeedComment[];
}

export interface MacroTotals {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export type FoodLogSource = "recipe" | "inventory" | "manual";

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

/** Snapshot de un item de inventario en el momento de consumirlo: permite
    recrearlo si fue eliminado por completo (qty llegó a 0) y luego se
    borra/edita la entrada del diario que lo consumió. */
export interface InventorySnapshot {
  storage: StorageName;
  expires: string;
  price: number;
  kcal: number;
  protein: number;
  carbs?: number;
  fat?: number;
  salt?: number;
  fiber?: number;
  sugars?: number;
  unitSize?: number;
}

/** Entrada del diario de comidas (espejo de la tabla food_log). */
export interface FoodLogEntry extends MacroTotals {
  id: string;
  /** Fecha ISO yyyy-mm-dd */
  date: string;
  /** Hora HH:mm */
  time: string;
  name: string;
  /** Cantidad consumida (g/ml/ud), si aplica. */
  qty: number | null;
  unit: string | null;
  source: FoodLogSource;
  /** Tipo de comida: se infiere de la hora al registrar (PDF §9.5). */
  mealType: MealType;
  /** Id del item de inventario consumido, para poder localizarlo al editar/borrar. */
  inventoryItemId?: string;
  inventorySnapshot?: InventorySnapshot;
  /** Para recetas cocinadas o platos elaborados que descontaron de varios
      items de inventario: uno por ingrediente, para poder devolverlos todos
      si se borra esta entrada. */
  consumedIngredients?: Array<{
    inventoryItemId?: string;
    name: string;
    qty: number;
    unit: string;
    snapshot?: InventorySnapshot;
  }>;
}

// ---------- Perfil fisico y objetivos (PDF §9) ----------

export type Sex = "male" | "female";

export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";

export type GoalMode = "fat_loss" | "muscle_gain" | "recomp" | "maintain";

/** Entrada del historial de peso corporal. */
export interface WeightEntry {
  /** Fecha ISO yyyy-mm-dd */
  date: string;
  kg: number;
}

/** Nivel de confianza de una estimación derivada de datos del usuario
    (tendencia de peso, TDEE adaptativo...) — basado en cuántos datos válidos
    hay disponibles, no en la precisión estadística real de la estimación. */
export type ConfidenceLevel = "low" | "moderate" | "high";

/**
 * Resultado de calcWeightTrend(): peso suavizado (mediana móvil + EWMA) y su
 * pendiente diaria, calculados sobre una ventana de hasta 28 días. Solo
 * informativo — no modifica ningún objetivo por sí solo.
 */
export interface WeightTrendResult {
  /** Último peso registrado tal cual (sin suavizar). */
  latestWeightKg: number;
  /** Peso suavizado (EWMA sobre mediana móvil de 3) en el punto más reciente. */
  trendWeightKg: number;
  slopeKgPerDay: number;
  weeklyChangeKg: number;
  weeklyChangePercent: number;
  /** Cuántas entradas de peso había dentro de la ventana usada. */
  validMeasurements: number;
  confidence: ConfidenceLevel;
}

/** Cobertura de registro de ingesta en una ventana de días — cuánto se puede
    confiar en el promedio de kcal calculado sobre esos días. */
export interface IntakeCoverageResult {
  avgKcal: number;
  /** Fracción (0-1) de días de la ventana con registro suficiente. */
  coverageFraction: number;
  daysWithData: number;
  windowDays: number;
}

/** Avisos de calidad del propio cálculo adaptativo (no de seguridad del
    objetivo — ver SafetyWarning). */
export type AdaptiveTdeeWarning = "tdee_estimates_strongly_disagree";

/**
 * Resultado de calcAdaptiveTdee(): TDEE inicial (fórmula Mifflin-St Jeor +
 * actividad) combinado con el TDEE observado (ingesta real vs. tendencia de
 * peso real). Solo informativo en su primera versión — no cambia ningún
 * objetivo por sí solo.
 */
export interface AdaptiveTdeeResult {
  initialKcal: number;
  /** null si no hay suficiente tendencia de peso o cobertura de ingesta. */
  observedKcal: number | null;
  combinedKcal: number;
  confidence: ConfidenceLevel | "insufficient_data";
  /** "tdee_estimates_strongly_disagree" si el observado difiere del inicial
      en más de un 30% — señal de datos sospechosos (infrarregistro, agua,
      creatina...), no un juicio fisiológico. Vacío si no hay avisos. */
  warnings: AdaptiveTdeeWarning[];
}

/**
 * Diagnóstico interno completo del motor adaptativo — pensado para depurar
 * "por qué no me deja generar una propuesta" sin adivinar por consola.
 * A diferencia de evaluateAdjustmentProposal (que para en el primer criterio
 * que falla), ineligibilityReasons acumula TODOS los motivos a la vez.
 */
export interface AdaptiveDiagnostics {
  evaluationStart: string;
  evaluationEnd: string;
  averageLoggedCalories: number | null;
  calorieCoverage: number | null;
  weightMeasurements: number;
  /** Cambio total (kg) entre el primer y último registro crudo de la ventana. */
  rawWeightChangeKg: number | null;
  /** Cambio total (kg) que predice la pendiente suavizada en ese mismo tramo. */
  smoothedWeightChangeKg: number | null;
  regressionSlopeKgPerDay: number | null;
  initialTdeeKcal: number;
  observedTdeeKcal: number | null;
  blendedTdeeKcal: number;
  confidenceScore: number;
  confidenceLevel: ConfidenceLevel | "insufficient_data";
  proposalEligible: boolean;
  ineligibilityReasons: string[];
}

/**
 * Resultado de evaluateAdjustmentProposal(): si se cumplen los criterios
 * mínimos para proponer (nunca aplicar solo) un ajuste de calorías basado en
 * el TDEE adaptativo. shouldPropose=false siempre trae deltaKcal 0 y
 * proposedTargetKcal igual al actual — el reason explica por qué no procede.
 */
export interface AdjustmentDecision {
  shouldPropose: boolean;
  /** Entre -150 y 150 kcal cuando shouldPropose es true (ver migración de
      nutrition_adjustment_proposals) — nunca se propone un salto brusco. */
  deltaKcal: number;
  proposedTargetKcal: number;
  reason: string;
}

export type AdjustmentProposalStatus = "pending" | "accepted" | "rejected" | "expired";

/** Espejo de una fila de nutrition_adjustment_proposals — nunca se aplica
    sola, siempre requiere una decisión explícita del usuario (aceptar/rechazar). */
export interface AdjustmentProposal {
  id: string;
  currentTargetKcal: number;
  proposedTargetKcal: number;
  deltaKcal: number;
  reason: string;
  status: AdjustmentProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
}

/** Perfil fisico del usuario (PDF §9.1). Todos los campos editables. */
export interface PhysicalProfile {
  age: number;
  sex: Sex;
  heightCm: number;
  weightKg: number;
  /** % de grasa corporal, opcional — afina la proteina usando masa magra. */
  bodyFatPct: number | null;
  activityLevel: ActivityLevel;
  goal: GoalMode;
  /** Dias de gym: 0=Domingo, 1=Lunes ... 6=Sabado (ciclado calorico §9.4). */
  gymDays: number[];
  allergies: string[];
  excludedFoods: string[];
  /** Peso objetivo en kg, para la grafica de progreso. */
  targetWeightKg?: number;
  /** Nivel de experiencia entrenando — afina el volumen/complejidad que sugiere la IA. */
  experienceLevel?: ExperienceLevel;
  /** Material disponible — afina qué ejercicios puede sugerir la IA. */
  equipmentAccess?: EquipmentAccess;
  /** Qué modelo interpreta activityLevel — ver ActivityModelVersion. Por defecto "legacy_total_pal". */
  activityModelVersion?: ActivityModelVersion;
  /** Cuestionario del modelo nuevo — solo se usa (y solo hace falta rellenarlo)
      cuando activityModelVersion === "lifestyle_plus_training". */
  trainingActivity?: TrainingActivityProfile;
  /** Ajuste (kcal/día) aceptado explícitamente por el usuario a partir de una
      propuesta del motor adaptativo (PR6) — se suma al kcal calculado por la
      fórmula en calcDailyTargets. 0/undefined = sin ajuste, comportamiento
      idéntico a antes de que existiera este campo. Nunca lo escribe nada
      salvo aceptar una AdjustmentProposal explícitamente. */
  adaptiveKcalOffsetKcal?: number;
}

/**
 * Cuestionario de "lifestyle_plus_training": vida cotidiana y entrenamiento
 * declarados por separado, en vez de un único nivel combinado (activityLevel).
 */
export interface TrainingActivityProfile {
  /** Actividad cotidiana SIN contar el entrenamiento (trabajo, desplazamientos, tareas de casa). */
  lifestyleActivity: ActivityLevel;
  strengthDaysPerWeek: number;
  cardioDaysPerWeek: number;
  /** Duración media por sesión en minutos (fuerza y cardio). */
  avgSessionDurationMin: number;
  /** Pasos diarios habituales — se guarda para afinar el modelo adaptativo más
      adelante (PR5/PR6); todavía no se usa en el cálculo de TDEE. */
  habitualSteps?: number | null;
}

export type ExperienceLevel = "beginner" | "intermediate" | "advanced";

export type EquipmentAccess = "full_gym" | "home_dumbbells" | "bodyweight";

/** Plantilla de reparto de grupos musculares por día, elegible en el asistente de IA. */
export type SplitTemplate = "push_pull_legs" | "upper_lower" | "full_body" | "bro_split" | "ai_decide";

/** Objetivo diario de macros. Si hay perfil, se calcula automaticamente. */
export interface NutritionGoal extends MacroTotals {
  mode: GoalMode;
}

/** Preferencia de reparto grasa/carbohidratos dentro del rango EFSA (20-35% kcal en grasa). */
export type MacroPreference = "higher_carbohydrate" | "balanced" | "higher_fat";

/**
 * Qué modelo interpreta activityLevel/PAL:
 * - "legacy_total_pal": el único que existe hoy — el PAL representa vida
 *   cotidiana Y entrenamiento habitual juntos (ver ACTIVITY_LABELS).
 * - "lifestyle_plus_training": futuro — el PAL representaría solo vida
 *   cotidiana, con el entrenamiento asignado aparte. Requiere un cuestionario
 *   nuevo que todavía no existe; ningún perfil usa este valor por ahora.
 */
export type ActivityModelVersion = "legacy_total_pal" | "lifestyle_plus_training";

/** Avisos de seguridad que puede generar evaluateNutritionSafety(). */
export type SafetyWarning = "very_low_energy_diet" | "aggressive_energy_deficit" | "below_resting_energy";

export interface NutritionSafetyResult {
  automaticPlanAllowed: boolean;
  requiresConfirmation: boolean;
  warnings: SafetyWarning[];
}

export type SnapshotTriggerReason =
  | "initial_calculation"
  | "profile_changed"
  | "goal_changed"
  | "manual_recalculation"
  | "adaptive_review"
  | "manual_override";

/**
 * Registro inmutable de cómo se calculó un objetivo nutricional concreto —
 * ver supabase/migrations/20260730_nutrition_engine_snapshots.sql. Se crea
 * solo en eventos explícitos (guardar perfil, cambiar objetivo...), nunca
 * desde un render o efecto.
 */
export interface NutritionCalculationSnapshot {
  calculationVersion: string;
  triggerReason: SnapshotTriggerReason;
  inputSnapshot: {
    age: number;
    sex: Sex;
    heightCm: number;
    weightKg: number;
    goal: GoalMode;
    activityLevel: ActivityLevel;
    macroPreference: MacroPreference;
    activityModelVersion: ActivityModelVersion;
    trainingActivity?: TrainingActivityProfile;
  };
  restingEnergy: {
    valueKcal: number;
    method: "mifflin_st_jeor";
  };
  tdee: {
    valueKcal: number;
    /** Desglose del TDEE adaptativo (PR5) si había datos suficientes en el
        momento de guardar — ausente en la mayoría de guardados (perfiles
        nuevos, sin histórico de peso/ingesta todavía). */
    adaptive?: AdaptiveTdeeResult;
  };
  calorieTarget: {
    kcal: number;
    dayType: DayType;
  };
  macros: MacroTotals & { fiber: number };
  safety: NutritionSafetyResult;
}

export type DayType = "gym" | "rest";

export interface DailyTargets extends MacroTotals {
  dayType: DayType;
}

export interface Mascot {
  id: string;
  name: string;
  color: string;
  tagline: string;
  image: string;
  /** Texto de personalidad inyectado en el system prompt del asistente IA */
  personality?: string;
}

/** Ajustes configurables por el usuario (umbrales, metas, preferencias). */
export interface AppSettings {
  /** Días antes de caducidad para marcar item como urgente (default 3). */
  expiryWarnDays: number;
  /** Meta diaria de agua en ml (default 2500). */
  waterGoalMl: number;
  /** Hora a partir de la cual se activa la sugerencia de cena (default 18). */
  dinnerSuggestionHour: number;
  /** % de presupuesto semanal usado a partir del cual avisar (default 80). */
  budgetWarnPct: number;
  /** Tienda por defecto al añadir items al carrito (default "Mercadona"). */
  defaultStore: string;
  /** Umbrales de "stock bajo" por unidad para sugerencias de carrito. */
  lowStockThresholds: { g: number; ml: number; L: number; kg: number; ud: number };
  /** Categorías de gasto adicionales (además de las predefinidas). */
  extraExpenseCategories: string[];
  /** Meta diaria de pasos (default 8000). */
  stepsGoal: number;
  /** Notificaciones del sistema cuando algo caduca hoy/mañana (opt-in,
      default off). Opcional: los settings ya guardados no lo traen. */
  expiryNotifications?: boolean;
}

/** Una comida planificada en el planificador semanal. */
export interface MealPlanDay {
  breakfast?: string;
  almuerzo?: string;
  lunch?: string;
  merienda?: string;
  dinner?: string;
}

/** Plato rápido creado directamente en el planificador, sin receta completa. */
export interface QuickMeal {
  id: string;
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  cost: number;
}

// ---------- Ejercicios y rutinas ----------

export interface ExerciseSet {
  reps: number;
  weight?: number | null; // kg, null para ejercicios de peso corporal
  rest?: number; // segundos de descanso entre series
}

export interface RoutineExercise {
  exerciseId: string; // ID de wger o "custom-N" / "ai-N"
  name: string;
  sets: ExerciseSet[];
  notes?: string;
}

/** Un día de entrenamiento dentro de una rutina con split (ej. "Día 1 · Pecho y tríceps"). */
export interface RoutineDay {
  label: string;
  muscleGroups: string[];
  exercises: RoutineExercise[];
}

export interface Routine {
  id: string;
  name: string;
  goal: string; // fat_loss | muscle_gain | recomp | maintain | general
  /** Lista plana de ejercicios — usada por rutinas de un solo día (manuales o legacy). */
  exercises: RoutineExercise[];
  /** Si la rutina tiene split por días, los ejercicios viven aquí en vez de en `exercises`. */
  days?: RoutineDay[];
  splitTemplate?: SplitTemplate;
  estimatedMinutes: number;
  aiGenerated?: boolean;
  createdAt: string; // ISO
}

export interface CompletedExercise {
  exerciseId: string;
  name: string;
  setsCompleted: number;
  totalSets: number;
}

export interface WorkoutSession {
  id: string;
  routineId?: string;
  routineName: string;
  /** Qué día de una rutina con split se entrenó (ej. "Día 1 · Pecho y tríceps"), si aplica. */
  dayLabel?: string;
  date: string; // ISO yyyy-mm-dd
  durationMin: number;
  kcalBurned?: number;
  notes?: string;
  completedExercises?: CompletedExercise[];
}

/** Estado completo de la app. Se persiste en localStorage y se sincroniza con Supabase. */
export interface FoodOSState {
  inventory: InventoryItem[];
  cart: CartItem[];
  expenses: Movement[];
  incomeSources: IncomeSource[];
  recurringExpenses: RecurringExpense[];
  /** Meta de ahorro mensual en % sobre ingresos (por defecto 20). */
  savingsGoalPct: number;
  /** Meta de ahorro con nombre y fecha, opcional (null = no configurada). */
  savingsGoal: SavingsGoal | null;
  feedPosts: FeedPost[];
  /** Diario de comidas con fecha — la fuente de verdad de lo consumido. */
  foodLog: FoodLogEntry[];
  /** Agua bebida por dia: { "2026-06-12": 1750 } en ml. */
  waterLog: Record<string, number>;
  /** Historial de peso corporal (PDF §9.1). */
  weightLog: WeightEntry[];
  customRecipes: Recipe[];
  savedRecipeIds: string[];
  /** null hasta completar el onboarding de nutricion. */
  profile: PhysicalProfile | null;
  nutrition: NutritionGoal;
  weeklyBudget: number;
  bankSynced: boolean;
  mascotId: string;
  recipeTag: string;
  /** Preferencia de reparto grasa/carbos, opcional (por defecto "balanced" — no cambia el % actual por objetivo). */
  macroPreference?: MacroPreference;
  settings: AppSettings;
  /** Nombres de sugerencias de stock bajo descartadas manualmente por el usuario. */
  dismissedSuggestions?: string[];
  /** Planificador semanal: key = "yyyy-mm-dd". */
  mealPlan: Record<string, MealPlanDay>;
  /** Platos rápidos creados directamente en el planificador. */
  plannerQuickMeals: QuickMeal[];
  /** Fecha de depuración (YYYY-MM-DD). Sustituye "hoy" en toda la app cuando está activa. */
  debugDate?: string | null;
  /** Presupuesto mensual por categoría (€), editable por el usuario. Clave = nombre de categoría. */
  categoryBudgets: Record<string, number>;
  /** Rutinas de entrenamiento guardadas. */
  routines: Routine[];
  /** Historial de sesiones de entrenamiento. */
  workoutLog: WorkoutSession[];
  /** Pasos registrados por dia (manual): { "2026-07-01": 6500 }. */
  stepsLog: Record<string, number>;
  /** Propuesta de ajuste adaptativo pendiente de decisión (null si no hay
      ninguna, o si la última ya fue aceptada/rechazada) — viene de
      nutrition_adjustment_proposals, se refresca en cada pull remoto. */
  pendingAdjustmentProposal?: AdjustmentProposal | null;
  /** Fecha ISO (yyyy-mm-dd) de la última propuesta resuelta (aceptada o
      rechazada) — cooldown para no volver a proponer inmediatamente después. */
  lastAdjustmentDecisionAt?: string | null;
}
