import type { CompletedExercise, CompletedSet, WorkoutSession } from "@foodos/types";

/**
 * 1RM estimado (fórmula de Epley, 1985): 1RM = peso × (1 + reps/30).
 * Es el default más usado por las apps de entrenamiento serias (Fitbod lo
 * cita explícitamente) y funciona bien en series duras de ~2-8 repeticiones
 * sin llegar al fallo. Con 1 repetición, el peso levantado YA es el 1RM.
 * Ver docs/INVESTIGACION_VISION_Y_ENTRENAMIENTO.md §2.4.
 */
export function estimateOneRepMax(weightKg: number, reps: number): number {
  if (reps <= 0 || weightKg <= 0) return 0;
  if (reps === 1) return Math.round(weightKg * 10) / 10;
  return Math.round(weightKg * (1 + reps / 30) * 10) / 10;
}

/**
 * Repeticiones "efectivas" para el cálculo de 1RM: 5 reps con RIR 2 no
 * equivale a 5 reps al fallo — la fórmula de Epley asume que la serie se
 * hizo al fallo (o casi), así que hay que sumar el RIR para no infravalorar
 * el 1RM de alguien que deja reps en el tanque a propósito.
 * Ver docs/INVESTIGACION_VISION_Y_ENTRENAMIENTO.md §2.4.
 */
function effectiveReps(s: CompletedSet): number {
  return s.reps + (s.rir ?? 0);
}

/** ¿Cuenta esta serie para estimar el 1RM? Calentamiento y dropsets no son
    representativos de la fuerza máxima real (post-fatiga o con carga
    reducida a propósito) — solo series normales y al fallo cuentan. */
function countsForE1RM(s: CompletedSet): boolean {
  const type = s.type ?? "normal";
  return type === "normal" || type === "failure";
}

/** ¿Cuenta esta serie como volumen de trabajo? El calentamiento no cuenta
    (es preparación, no estímulo) — todo lo demás sí, incluidos dropsets. */
function countsForVolume(s: CompletedSet): boolean {
  return (s.type ?? "normal") !== "warmup";
}

/**
 * El e1RM más alto entre las series completadas "de trabajo" de una lista
 * (una sola serie buena ya indica la fuerza real, no hace falta promediar).
 * Series de peso corporal (weight null/0), de calentamiento o dropsets no
 * se usan — ver countsForE1RM.
 */
export function bestE1RM(sets: CompletedSet[] | undefined | null): number | null {
  if (!sets?.length) return null;
  const values = sets
    .filter((s) => s.done && s.weight != null && s.weight > 0 && s.reps > 0 && countsForE1RM(s))
    .map((s) => estimateOneRepMax(s.weight as number, effectiveReps(s)));
  if (values.length === 0) return null;
  return Math.max(...values);
}

/** Volumen total (peso × reps reales, sin ajustar por RIR) de las series
    completadas con peso registrado, excluyendo calentamiento. */
export function totalVolume(sets: CompletedSet[] | undefined | null): number {
  if (!sets?.length) return 0;
  return sets
    .filter((s) => s.done && s.weight != null && s.weight > 0 && countsForVolume(s))
    .reduce((sum, s) => sum + (s.weight as number) * s.reps, 0);
}

/**
 * Series de trabajo (no calentamiento) por músculo, de una lista de
 * ejercicios completados de UNA sesión. Cada serie cuenta una vez por cada
 * músculo primario listado en `ex.muscles` — igual que la métrica "sets per
 * muscle group per week" de Hevy/Fitbod (conteo de series, no kg de
 * volumen; así los ejercicios de peso corporal también cuentan).
 * Ver docs/INVESTIGACION_VISION_Y_ENTRENAMIENTO.md §2.4.
 *
 * Ejercicios sin músculo capturado (rutinas creadas antes de este campo, o
 * ejercicios manuales/generados por IA sin pasar por el explorador de wger)
 * no contribuyen — es una limitación conocida de cobertura de datos, no un
 * error de cálculo.
 */
export function setsByMuscle(exercises: CompletedExercise[] | undefined | null): Record<string, number> {
  const result: Record<string, number> = {};
  if (!exercises?.length) return result;
  for (const ex of exercises) {
    if (!ex.muscles?.length) continue;
    const workingSets = (ex.sets ?? []).filter((s) => s.done && countsForVolume(s)).length;
    if (workingSets === 0) continue;
    for (const muscle of ex.muscles) {
      result[muscle] = (result[muscle] ?? 0) + workingSets;
    }
  }
  return result;
}

/** Igual que setsByMuscle pero agregado sobre varias sesiones (ej. las de
    la semana en curso) — la unidad natural para un gráfico semanal. */
export function weeklySetsByMuscle(sessions: WorkoutSession[] | undefined | null): Record<string, number> {
  const result: Record<string, number> = {};
  if (!sessions?.length) return result;
  for (const session of sessions) {
    for (const [muscle, count] of Object.entries(setsByMuscle(session.completedExercises))) {
      result[muscle] = (result[muscle] ?? 0) + count;
    }
  }
  return result;
}
