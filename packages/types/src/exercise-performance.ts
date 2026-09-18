// Nutrition Engine v4, PR4 — Exercise Engine v2: contrato de entrada
// normalizado propio (nunca WorkoutSession de v3.1) y salida de señales de
// rendimiento con suficiencia por señal. El adaptador desde el modelo
// legacy de apps/web queda fuera de este PR — ver
// docs/NUTRITION_V4_EXERCISE_V2_ROADMAP.md.
//
// PR4 produce observaciones auditables y cobertura, nunca una conclusión de
// rendimiento: ninguna noción de progreso, tendencia, adherencia o calidad
// se calcula aquí.

// ─── Entrada ────────────────────────────────────────────────────────────

export type ExternalLoadSetType = "normal" | "warmup" | "dropset" | "failure";

export interface ExercisePerformanceSet {
  reps: number;
  /** null = carga externa no disponible/aplicable (el adaptador futuro
      decide por qué: peso corporal, dato no migrado, etc.). 0 = carga
      externa registrada explícitamente como cero. Son datos de entrada
      distintos — en las señales de salida ambos quedan fuera de
      "observado" por la misma condición aritmética (> 0), sin que eso los
      convierta en semánticamente idénticos. */
  externalLoadKg: number | null;
  done: boolean;
  type: ExternalLoadSetType;
  /** null = no registrado. Válido en [0, 10] — ver guardas runtime del
      kernel (rango de la propia investigación de mercado ya citada en el
      proyecto, no un umbral clínico). */
  rir: number | null;
}

/** Sin `name`: no participa en ninguna señal: el kernel puro no lo recibe.
    El adaptador futuro puede conservarlo para UI fuera del motor. */
export interface ExercisePerformanceExercise {
  exerciseId: string;
  sets: readonly ExercisePerformanceSet[];
  primaryMuscles: readonly string[];
  secondaryMuscles: readonly string[];
}

export interface ExercisePerformanceSession {
  sessionId: string;
  /** YYYY-MM-DD, calendario real — validado por el kernel sin `new Date()`. */
  dateKey: string;
  durationMin: number | null;
  exercises: readonly ExercisePerformanceExercise[];
}

export interface ExercisePerformanceInput {
  startDateKey: string;
  endDateKey: string; // inclusive
  sessions: readonly ExercisePerformanceSession[];
}

// ─── Salida — identidad y procedencia completas ────────────────────────

export type EstimatedOneRepMaxMethod = "epley" | "epley_rir_adjusted";

/** epley: estimatedOneRepMaxKg = externalLoadKg × (1 + reps / 30) (Epley,
 *  1985). epley_rir_adjusted: estimatedOneRepMaxKg = externalLoadKg ×
 *  (1 + (reps + rir) / 30) — fórmula ya usada hoy en apps/web/src/lib/
 *  strength.ts, documentada aquí como regla de producto, no como
 *  corrección validada externamente. El método se decide por si se
 *  registró RIR (rir !== null), nunca por si cambia el resultado —
 *  rir:0 sigue siendo "epley_rir_adjusted" aunque coincida numéricamente
 *  con "epley". Nunca redondeado. */
export interface EstimatedOneRepMaxObservation {
  sessionId: string;
  dateKey: string;
  exerciseId: string;
  /** Posición del bloque de este ejercicio dentro de `exercises` de la
      sesión — distingue bloques repetidos del mismo exerciseId. */
  exerciseOccurrenceIndex: number;
  /** Posición de la serie dentro de `sets` de ese bloque. */
  setIndex: number;
  externalLoadKg: number;
  reps: number;
  rir: number | null;
  method: EstimatedOneRepMaxMethod;
  estimatedOneRepMaxKg: number;
}

/** Tonelaje externo (peso × reps), agregado por sesión + ejercicio — nunca
    "volumen total de entrenamiento" ni "estímulo hipertrófico". Varios
    bloques del mismo exerciseId en la misma sesión se suman en una sola
    entrada; `contributingSetCount` cuenta las series que aportaron. */
export interface ExternalLoadTonnageEntry {
  sessionId: string;
  dateKey: string;
  exerciseId: string;
  tonnageKgReps: number;
  contributingSetCount: number;
}

/** Conteo de series de trabajo por músculo. Una serie puede sumar a varios
    músculos primarios a la vez (mismo comportamiento que setsByMuscle de
    v3.1) — la suma de todos los primaryCount puede superar el total de
    series de trabajo; no representa series únicas globales.
    secondaryCount nunca se suma a primaryCount ni se pondera. */
export interface MuscleSetCountEntry {
  muscle: string; // string opaco, sin normalizar — comparación exacta
  primaryCount: number;
  secondaryCount: number;
}

export interface RirObservation {
  sessionId: string;
  dateKey: string;
  exerciseId: string;
  exerciseOccurrenceIndex: number;
  setIndex: number;
  rir: number;
}

export interface SessionDurationCoverageValue {
  totalMin: number;
  perSession: readonly { sessionId: string; dateKey: string; durationMin: number }[];
}

// ─── Cobertura y resultado ──────────────────────────────────────────────

export type SignalUnit = "sessions" | "sets";

export interface SignalCoverage {
  unit: SignalUnit;
  eligibleCount: number;
  /** Invariante: observedCount <= eligibleCount. status:"available" del
      SignalResult que envuelve esta cobertura ⇔ observedCount > 0. */
  observedCount: number;
}

export type SignalInsufficiencyReason =
  | "no_sessions_in_window"
  | "no_eligible_sets"
  | "no_session_duration_recorded"
  | "no_positive_external_load"
  | "no_muscle_metadata"
  | "no_rir_recorded";
export type NonEmptySignalInsufficiencyReasons = [SignalInsufficiencyReason, ...SignalInsufficiencyReason[]];

export type SignalResult<T> =
  | { status: "available"; coverage: SignalCoverage; value: T }
  | { status: "insufficient_data"; coverage: SignalCoverage; reasons: NonEmptySignalInsufficiencyReasons };

export interface ExercisePerformanceEvaluated {
  status: "evaluated";
  windowSessionCount: number;
  sessionDurationCoverage: SignalResult<SessionDurationCoverageValue>;
  estimatedOneRepMaxObservations: SignalResult<readonly EstimatedOneRepMaxObservation[]>;
  externalLoadTonnage: SignalResult<readonly ExternalLoadTonnageEntry[]>;
  muscleSetCounts: SignalResult<readonly MuscleSetCountEntry[]>;
  rirObservations: SignalResult<readonly RirObservation[]>;
}

export type ExercisePerformanceInvalidReason =
  | "input_object_invalid"
  | "start_date_key_invalid"
  | "end_date_key_invalid"
  | "date_window_order_invalid"
  | "sessions_not_array"
  | "session_object_invalid"
  | "session_id_invalid"
  | "session_date_key_invalid"
  | "session_id_duplicate"
  | "session_duration_invalid"
  | "exercises_not_array"
  | "exercise_object_invalid"
  | "exercise_id_invalid"
  | "muscle_list_invalid"
  | "sets_not_array"
  | "set_object_invalid"
  | "set_reps_invalid"
  | "set_external_load_invalid"
  | "set_type_unknown"
  | "set_rir_invalid"
  | "set_done_invalid"
  | "derived_numeric_result_invalid";
export type NonEmptyExercisePerformanceInvalidReasons = [ExercisePerformanceInvalidReason, ...ExercisePerformanceInvalidReason[]];

export interface ExercisePerformanceInvalidInput {
  status: "invalid_input";
  /** Deduplicadas y ordenadas por el orden canónico fijo del kernel —
      nunca el orden de descubrimiento. */
  reasons: NonEmptyExercisePerformanceInvalidReasons;
}

export type ExercisePerformanceResult = ExercisePerformanceEvaluated | ExercisePerformanceInvalidInput;
