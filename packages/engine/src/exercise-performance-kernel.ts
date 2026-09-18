import type {
  EstimatedOneRepMaxMethod,
  EstimatedOneRepMaxObservation,
  ExercisePerformanceEvaluated,
  ExercisePerformanceInput,
  ExercisePerformanceInvalidInput,
  ExercisePerformanceInvalidReason,
  ExercisePerformanceResult,
  ExternalLoadSetType,
  ExternalLoadTonnageEntry,
  MuscleSetCountEntry,
  NonEmptyExercisePerformanceInvalidReasons,
  NonEmptySignalInsufficiencyReasons,
  RirObservation,
  SignalCoverage,
  SignalInsufficiencyReason,
  SignalResult,
  SignalUnit,
} from "@foodos/types";

// ─── Guardas de forma ───────────────────────────────────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Fechas YYYY-MM-DD estrictas, sin new Date() ────────────────────────

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidCalendarDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── Validación de identificadores/nombres normalizados ─────────────────
// Sin recorte silencioso: un string con espacios externos se rechaza, no
// se limpia. Sin normalización de mayúsculas/acentos/idioma.

function isStrictNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

const KNOWN_SET_TYPES: ReadonlySet<string> = new Set<ExternalLoadSetType>(["normal", "warmup", "dropset", "failure"]);

function isKnownSetType(value: unknown): value is ExternalLoadSetType {
  return typeof value === "string" && KNOWN_SET_TYPES.has(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidRir(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10;
}

// ─── Canonicalización de razones inválidas ──────────────────────────────

const INVALID_REASON_ORDER: readonly ExercisePerformanceInvalidReason[] = [
  "input_object_invalid",
  "start_date_key_invalid",
  "end_date_key_invalid",
  "date_window_order_invalid",
  "sessions_not_array",
  "session_object_invalid",
  "session_id_invalid",
  "session_date_key_invalid",
  "session_id_duplicate",
  "session_duration_invalid",
  "exercises_not_array",
  "exercise_object_invalid",
  "exercise_id_invalid",
  "muscle_list_invalid",
  "sets_not_array",
  "set_object_invalid",
  "set_reps_invalid",
  "set_external_load_invalid",
  "set_type_unknown",
  "set_rir_invalid",
  "set_done_invalid",
  "derived_numeric_result_invalid",
];

function canonicalizeInvalidReasons(reasons: Iterable<ExercisePerformanceInvalidReason>): NonEmptyExercisePerformanceInvalidReasons {
  const found = new Set(reasons);
  const ordered = INVALID_REASON_ORDER.filter((r) => found.has(r));
  return ordered as NonEmptyExercisePerformanceInvalidReasons;
}

function invalidInput(reasons: Iterable<ExercisePerformanceInvalidReason>): ExercisePerformanceInvalidInput {
  return { status: "invalid_input", reasons: canonicalizeInvalidReasons(reasons) };
}

// ─── Desbordamiento de valores derivados ────────────────────────────────
// Sentinela interno: nunca escapa de evaluateExercisePerformance. Ningún
// límite fisiológico inventado — solo seguridad aritmética de IEEE754.

class NonFiniteDerivedValueError extends Error {}

function assertFinite(value: number): number {
  if (!Number.isFinite(value)) throw new NonFiniteDerivedValueError();
  return value;
}

// ─── Estructuras internas tras validación profunda ──────────────────────

interface DeepSet {
  readonly done: boolean;
  readonly type: ExternalLoadSetType;
  readonly reps: number;
  readonly externalLoadKg: number | null;
  readonly rir: number | null;
}

interface DeepExercise {
  readonly exerciseId: string;
  readonly sets: readonly DeepSet[];
  readonly primaryMuscles: readonly string[];
  readonly secondaryMuscles: readonly string[];
}

interface DeepSession {
  readonly sessionId: string;
  readonly dateKey: string;
  readonly durationMin: number | null;
  readonly exercises: readonly DeepExercise[];
}

function validateMuscleList(raw: unknown, reasons: Set<ExercisePerformanceInvalidReason>): string[] {
  if (!Array.isArray(raw)) {
    reasons.add("muscle_list_invalid");
    return [];
  }
  const result: string[] = [];
  for (const item of raw) {
    if (!isStrictNonEmptyTrimmedString(item)) {
      reasons.add("muscle_list_invalid");
      return [];
    }
    result.push(item);
  }
  return result;
}

function validateDeepSet(raw: unknown, reasons: Set<ExercisePerformanceInvalidReason>): DeepSet | null {
  if (!isPlainRecord(raw)) {
    reasons.add("set_object_invalid");
    return null;
  }
  if (typeof raw.done !== "boolean") {
    reasons.add("set_done_invalid");
    return null;
  }
  if (!isKnownSetType(raw.type)) {
    reasons.add("set_type_unknown");
    return null;
  }
  if (!isSafeNonNegativeInteger(raw.reps)) {
    reasons.add("set_reps_invalid");
    return null;
  }
  let externalLoadKg: number | null;
  if (raw.externalLoadKg === null) {
    externalLoadKg = null;
  } else if (isFiniteNonNegative(raw.externalLoadKg)) {
    externalLoadKg = raw.externalLoadKg;
  } else {
    reasons.add("set_external_load_invalid");
    return null;
  }
  let rir: number | null;
  if (raw.rir === null) {
    rir = null;
  } else if (isValidRir(raw.rir)) {
    rir = raw.rir;
  } else {
    reasons.add("set_rir_invalid");
    return null;
  }
  return { done: raw.done, type: raw.type, reps: raw.reps, externalLoadKg, rir };
}

function validateDeepExercise(raw: unknown, reasons: Set<ExercisePerformanceInvalidReason>): DeepExercise | null {
  if (!isPlainRecord(raw)) {
    reasons.add("exercise_object_invalid");
    return null;
  }
  if (!isStrictNonEmptyTrimmedString(raw.exerciseId)) {
    reasons.add("exercise_id_invalid");
    return null;
  }
  const primaryMuscles = validateMuscleList(raw.primaryMuscles, reasons);
  const secondaryMuscles = validateMuscleList(raw.secondaryMuscles, reasons);
  if (!Array.isArray(raw.sets)) {
    reasons.add("sets_not_array");
    return null;
  }
  const sets: DeepSet[] = [];
  for (const rawSet of raw.sets) {
    const set = validateDeepSet(rawSet, reasons);
    if (set) sets.push(set);
  }
  return { exerciseId: raw.exerciseId, sets, primaryMuscles, secondaryMuscles };
}

// ─── Fase 1+2: forma superior, ventana, y sesiones superficialmente ─────

interface ShallowSession {
  readonly raw: Record<string, unknown>;
  readonly sessionId: string;
  readonly dateKey: string;
}

function validateShallow(input: unknown): ExercisePerformanceInvalidInput | { startDateKey: string; endDateKey: string; shallow: ShallowSession[] } {
  if (!isPlainRecord(input)) return invalidInput(["input_object_invalid"]);

  const phase1: ExercisePerformanceInvalidReason[] = [];
  const startOk = isValidCalendarDateKey(input.startDateKey);
  if (!startOk) phase1.push("start_date_key_invalid");
  const endOk = isValidCalendarDateKey(input.endDateKey);
  if (!endOk) phase1.push("end_date_key_invalid");
  if (startOk && endOk && compareStrings(input.startDateKey as string, input.endDateKey as string) > 0) {
    phase1.push("date_window_order_invalid");
  }
  if (!Array.isArray(input.sessions)) phase1.push("sessions_not_array");
  if (phase1.length > 0) return invalidInput(phase1);

  const startDateKey = input.startDateKey as string;
  const endDateKey = input.endDateKey as string;
  const rawSessions = input.sessions as unknown[];

  // Fase 2: sessionId/dateKey superficiales de TODAS las sesiones — una
  // fecha o id inválidos aquí invalidan SIEMPRE, sin importar si la sesión
  // caería dentro o fuera de la ventana: sin esto no se puede decidir
  // pertenencia.
  const phase2 = new Set<ExercisePerformanceInvalidReason>();
  const shallow: ShallowSession[] = [];
  for (const rawSession of rawSessions) {
    if (!isPlainRecord(rawSession)) {
      phase2.add("session_object_invalid");
      continue;
    }
    const idOk = isStrictNonEmptyTrimmedString(rawSession.sessionId);
    if (!idOk) phase2.add("session_id_invalid");
    const dateOk = isValidCalendarDateKey(rawSession.dateKey);
    if (!dateOk) phase2.add("session_date_key_invalid");
    if (idOk && dateOk) {
      shallow.push({ raw: rawSession, sessionId: rawSession.sessionId as string, dateKey: rawSession.dateKey as string });
    }
  }
  if (phase2.size > 0) return invalidInput(phase2);

  return { startDateKey, endDateKey, shallow };
}

// ─── Fase 3+4: selección por ventana y validación profunda ──────────────

function selectAndValidateDeep(
  startDateKey: string,
  endDateKey: string,
  shallow: readonly ShallowSession[],
): ExercisePerformanceInvalidInput | DeepSession[] {
  // Fase 3: solo dateKey (ya validado) decide pertenencia. Las sesiones
  // fuera de ventana no se tocan más — su contenido, por corrupto que
  // esté, nunca se valida ni se lee.
  const inWindow = shallow.filter((s) => s.dateKey >= startDateKey && s.dateKey <= endDateKey);

  // Fase 4: validación profunda, solo de las sesiones en ventana.
  // session_id_duplicate se comprueba únicamente entre estas.
  const phase4 = new Set<ExercisePerformanceInvalidReason>();
  const seenIds = new Set<string>();
  const deepSessions: DeepSession[] = [];

  for (const s of inWindow) {
    if (seenIds.has(s.sessionId)) phase4.add("session_id_duplicate");
    seenIds.add(s.sessionId);

    let durationMin: number | null;
    const rawDuration = s.raw.durationMin;
    if (rawDuration === null) {
      durationMin = null;
    } else if (isFiniteNonNegative(rawDuration)) {
      durationMin = rawDuration;
    } else {
      phase4.add("session_duration_invalid");
      durationMin = null;
    }

    const rawExercises = s.raw.exercises;
    if (!Array.isArray(rawExercises)) {
      phase4.add("exercises_not_array");
      deepSessions.push({ sessionId: s.sessionId, dateKey: s.dateKey, durationMin, exercises: [] });
      continue;
    }

    const exercises: DeepExercise[] = [];
    for (const rawEx of rawExercises) {
      const ex = validateDeepExercise(rawEx, phase4);
      if (ex) exercises.push(ex);
    }
    deepSessions.push({ sessionId: s.sessionId, dateKey: s.dateKey, durationMin, exercises });
  }

  if (phase4.size > 0) return invalidInput(phase4);
  return deepSessions;
}

// ─── Fase 5+6: señales derivadas, con verificación de rango seguro ──────

function insufficiencyReasonsFor(
  windowSessionCount: number,
  eligibleCount: number,
  specific: SignalInsufficiencyReason,
): NonEmptySignalInsufficiencyReasons {
  if (windowSessionCount === 0) return ["no_sessions_in_window"];
  if (eligibleCount === 0) return ["no_eligible_sets"];
  return [specific];
}

function buildSignalResult<T>(
  unit: SignalUnit,
  eligibleCount: number,
  observedCount: number,
  reasonsIfInsufficient: NonEmptySignalInsufficiencyReasons,
  value: T,
): SignalResult<T> {
  const coverage: SignalCoverage = { unit, eligibleCount, observedCount };
  if (observedCount > 0) return { status: "available", coverage, value };
  return { status: "insufficient_data", coverage, reasons: reasonsIfInsufficient };
}

function compareByDateThenSession(a: { dateKey: string; sessionId: string }, b: { dateKey: string; sessionId: string }): number {
  return compareStrings(a.dateKey, b.dateKey) || compareStrings(a.sessionId, b.sessionId);
}

function compareByDateSessionExercise(
  a: { dateKey: string; sessionId: string; exerciseId: string },
  b: { dateKey: string; sessionId: string; exerciseId: string },
): number {
  return compareByDateThenSession(a, b) || compareStrings(a.exerciseId, b.exerciseId);
}

function compareByFiveKeys(
  a: { dateKey: string; sessionId: string; exerciseId: string; exerciseOccurrenceIndex: number; setIndex: number },
  b: { dateKey: string; sessionId: string; exerciseId: string; exerciseOccurrenceIndex: number; setIndex: number },
): number {
  return (
    compareByDateSessionExercise(a, b) ||
    a.exerciseOccurrenceIndex - b.exerciseOccurrenceIndex ||
    a.setIndex - b.setIndex
  );
}

function isE1rmEligible(set: DeepSet): boolean {
  return set.done && (set.type === "normal" || set.type === "failure") && set.reps > 0;
}

function isTonnageEligible(set: DeepSet): boolean {
  return set.done && set.type !== "warmup" && set.reps > 0;
}

function isWorkingSet(set: DeepSet): boolean {
  return set.done && set.type !== "warmup";
}

function computeEvaluated(deepSessions: readonly DeepSession[]): ExercisePerformanceEvaluated {
  const windowSessionCount = deepSessions.length;

  // ── Duración ──
  let totalMin = 0;
  const perSession: { sessionId: string; dateKey: string; durationMin: number }[] = [];
  for (const s of deepSessions) {
    if (s.durationMin != null) {
      totalMin = assertFinite(totalMin + s.durationMin);
      perSession.push({ sessionId: s.sessionId, dateKey: s.dateKey, durationMin: s.durationMin });
    }
  }
  perSession.sort(compareByDateThenSession);

  // ── e1RM ──
  let e1rmEligible = 0;
  const e1rmObservations: EstimatedOneRepMaxObservation[] = [];

  // ── Tonelaje ──
  // Clave anidada sessionId -> exerciseId -> entrada: la identidad se
  // conserva estructuralmente (comparación de igualdad de string en cada
  // nivel), nunca por concatenación con un separador — ningún carácter,
  // por "improbable" que sea (incluido U+0000), puede hacer colisionar dos
  // pares (sessionId, exerciseId) distintos.
  let tonnageEligible = 0;
  let tonnageObserved = 0;
  const tonnageMap = new Map<string, Map<string, ExternalLoadTonnageEntry>>();

  // ── Músculo ──
  let muscleEligible = 0;
  let muscleObserved = 0;
  const muscleMap = new Map<string, { primaryCount: number; secondaryCount: number }>();

  // ── RIR ──
  let rirEligible = 0;
  const rirObservations: RirObservation[] = [];

  for (const s of deepSessions) {
    s.exercises.forEach((ex, exerciseOccurrenceIndex) => {
      const hasMuscleMetadata = ex.primaryMuscles.length > 0 || ex.secondaryMuscles.length > 0;
      const primarySet = new Set(ex.primaryMuscles);
      const secondarySet = new Set(ex.secondaryMuscles);

      ex.sets.forEach((set, setIndex) => {
        // e1RM
        if (isE1rmEligible(set)) {
          e1rmEligible++;
          if (set.externalLoadKg != null && set.externalLoadKg > 0) {
            const rirPart = set.rir != null ? set.rir : 0;
            const effectiveReps = set.reps + rirPart;
            const estimatedOneRepMaxKg = assertFinite(set.externalLoadKg * (1 + effectiveReps / 30));
            const method: EstimatedOneRepMaxMethod = set.rir != null ? "epley_rir_adjusted" : "epley";
            e1rmObservations.push({
              sessionId: s.sessionId,
              dateKey: s.dateKey,
              exerciseId: ex.exerciseId,
              exerciseOccurrenceIndex,
              setIndex,
              externalLoadKg: set.externalLoadKg,
              reps: set.reps,
              rir: set.rir,
              method,
              estimatedOneRepMaxKg,
            });
          }
        }

        // Tonelaje — observedCount cuenta series, no entradas agregadas:
        // debe coincidir con sum(value[].contributingSetCount).
        if (isTonnageEligible(set)) {
          tonnageEligible++;
          if (set.externalLoadKg != null && set.externalLoadKg > 0) {
            tonnageObserved++;
            const contribution = assertFinite(set.externalLoadKg * set.reps);
            let bySessionExercise = tonnageMap.get(s.sessionId);
            if (!bySessionExercise) {
              bySessionExercise = new Map<string, ExternalLoadTonnageEntry>();
              tonnageMap.set(s.sessionId, bySessionExercise);
            }
            const existing = bySessionExercise.get(ex.exerciseId);
            if (existing) {
              existing.tonnageKgReps = assertFinite(existing.tonnageKgReps + contribution);
              existing.contributingSetCount += 1;
            } else {
              bySessionExercise.set(ex.exerciseId, {
                sessionId: s.sessionId,
                dateKey: s.dateKey,
                exerciseId: ex.exerciseId,
                tonnageKgReps: contribution,
                contributingSetCount: 1,
              });
            }
          }
        }

        // Músculo — universo elegible: cualquier serie de trabajo,
        // pertenezca o no a un ejercicio con metadata muscular.
        if (isWorkingSet(set)) {
          muscleEligible++;
          if (hasMuscleMetadata) {
            muscleObserved++;
            for (const m of primarySet) {
              const entry = muscleMap.get(m) ?? { primaryCount: 0, secondaryCount: 0 };
              entry.primaryCount += 1;
              muscleMap.set(m, entry);
            }
            for (const m of secondarySet) {
              const entry = muscleMap.get(m) ?? { primaryCount: 0, secondaryCount: 0 };
              entry.secondaryCount += 1;
              muscleMap.set(m, entry);
            }
          }
        }

        // RIR
        if (isWorkingSet(set)) {
          rirEligible++;
          if (set.rir != null) {
            rirObservations.push({
              sessionId: s.sessionId,
              dateKey: s.dateKey,
              exerciseId: ex.exerciseId,
              exerciseOccurrenceIndex,
              setIndex,
              rir: set.rir,
            });
          }
        }
      });
    });
  }

  e1rmObservations.sort(compareByFiveKeys);
  rirObservations.sort(compareByFiveKeys);
  // Aplanar el mapa anidado a la lista pública — el orden final nunca
  // depende del orden de inserción de los Map, siempre del sort explícito.
  const tonnageEntries: ExternalLoadTonnageEntry[] = [];
  for (const bySessionExercise of tonnageMap.values()) {
    for (const entry of bySessionExercise.values()) tonnageEntries.push(entry);
  }
  tonnageEntries.sort(compareByDateSessionExercise);
  const muscleEntries: MuscleSetCountEntry[] = [...muscleMap.entries()]
    .map(([muscle, counts]) => ({ muscle, ...counts }))
    .sort((a, b) => compareStrings(a.muscle, b.muscle));

  return {
    status: "evaluated",
    windowSessionCount,
    sessionDurationCoverage: buildSignalResult(
      "sessions",
      windowSessionCount,
      perSession.length,
      insufficiencyReasonsFor(windowSessionCount, windowSessionCount, "no_session_duration_recorded"),
      { totalMin, perSession },
    ),
    estimatedOneRepMaxObservations: buildSignalResult(
      "sets",
      e1rmEligible,
      e1rmObservations.length,
      insufficiencyReasonsFor(windowSessionCount, e1rmEligible, "no_positive_external_load"),
      e1rmObservations,
    ),
    externalLoadTonnage: buildSignalResult(
      "sets",
      tonnageEligible,
      tonnageObserved,
      insufficiencyReasonsFor(windowSessionCount, tonnageEligible, "no_positive_external_load"),
      tonnageEntries,
    ),
    muscleSetCounts: buildSignalResult(
      "sets",
      muscleEligible,
      muscleObserved,
      insufficiencyReasonsFor(windowSessionCount, muscleEligible, "no_muscle_metadata"),
      muscleEntries,
    ),
    rirObservations: buildSignalResult(
      "sets",
      rirEligible,
      rirObservations.length,
      insufficiencyReasonsFor(windowSessionCount, rirEligible, "no_rir_recorded"),
      rirObservations,
    ),
  };
}

// ─── API pública ─────────────────────────────────────────────────────────

export function evaluateExercisePerformance(input: ExercisePerformanceInput): ExercisePerformanceResult {
  const shallowResult = validateShallow(input);
  if ("status" in shallowResult) return shallowResult;

  const deepResult = selectAndValidateDeep(shallowResult.startDateKey, shallowResult.endDateKey, shallowResult.shallow);
  if (!Array.isArray(deepResult)) return deepResult;

  try {
    return computeEvaluated(deepResult);
  } catch (err) {
    if (err instanceof NonFiniteDerivedValueError) return invalidInput(["derived_numeric_result_invalid"]);
    throw err;
  }
}
