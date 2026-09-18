import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import type {
  ExercisePerformanceEvaluated,
  ExercisePerformanceExercise,
  ExercisePerformanceInput,
  ExercisePerformanceInvalidInput,
  ExercisePerformanceSession,
  ExercisePerformanceSet,
} from "@foodos/types";
import { evaluateExercisePerformance } from "./exercise-performance-kernel";
import * as engineBarrel from "./index";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function baseSet(overrides: Partial<ExercisePerformanceSet> = {}): ExercisePerformanceSet {
  return { reps: 8, externalLoadKg: 50, done: true, type: "normal", rir: null, ...overrides };
}

function baseExercise(overrides: Partial<ExercisePerformanceExercise> = {}): ExercisePerformanceExercise {
  return {
    exerciseId: "bench-press",
    sets: [baseSet()],
    primaryMuscles: ["Chest"],
    secondaryMuscles: ["Triceps"],
    ...overrides,
  };
}

function baseSession(overrides: Partial<ExercisePerformanceSession> = {}): ExercisePerformanceSession {
  return {
    sessionId: "s1",
    dateKey: "2026-09-10",
    durationMin: 45,
    exercises: [baseExercise()],
    ...overrides,
  };
}

function baseInput(overrides: Partial<ExercisePerformanceInput> = {}): ExercisePerformanceInput {
  return {
    startDateKey: "2026-09-01",
    endDateKey: "2026-09-30",
    sessions: [baseSession()],
    ...overrides,
  };
}

function expectEvaluated(result: ReturnType<typeof evaluateExercisePerformance>): ExercisePerformanceEvaluated {
  if (result.status !== "evaluated") throw new Error(`esperado evaluated, recibido ${JSON.stringify(result)}`);
  return result;
}

function expectInvalid(result: ReturnType<typeof evaluateExercisePerformance>): ExercisePerformanceInvalidInput {
  if (result.status !== "invalid_input") throw new Error(`esperado invalid_input, recibido ${JSON.stringify(result)}`);
  return result;
}

// ─── Fase 1 — forma superior y ventana ─────────────────────────────────────

describe("fase 1 — forma superior del input y de la ventana", () => {
  it("null/undefined/string/número/array como input entero -> invalid_input/input_object_invalid, nunca lanza", () => {
    const garbage: unknown[] = [null, undefined, "x", 42, []];
    for (const g of garbage) {
      expect(() => evaluateExercisePerformance(g as unknown as ExercisePerformanceInput)).not.toThrow();
      expect(evaluateExercisePerformance(g as unknown as ExercisePerformanceInput)).toEqual({
        status: "invalid_input",
        reasons: ["input_object_invalid"],
      });
    }
  });

  it("startDateKey ausente/no fecha real -> start_date_key_invalid", () => {
    const result = evaluateExercisePerformance(baseInput({ startDateKey: "no-es-fecha" }));
    expect(expectInvalid(result).reasons).toEqual(["start_date_key_invalid"]);
  });

  it("endDateKey con calendario imposible (2026-02-30) -> end_date_key_invalid, sin normalización de Date", () => {
    const result = evaluateExercisePerformance(baseInput({ endDateKey: "2026-02-30" }));
    expect(expectInvalid(result).reasons).toEqual(["end_date_key_invalid"]);
  });

  it("29 de febrero en año bisiesto (2028) es válido; en no bisiesto (2026) no lo es", () => {
    expect(evaluateExercisePerformance(baseInput({ startDateKey: "2028-02-29", endDateKey: "2028-02-29", sessions: [] })).status).toBe(
      "evaluated",
    );
    expect(expectInvalid(evaluateExercisePerformance(baseInput({ startDateKey: "2026-02-29", endDateKey: "2026-02-29" }))).reasons).toEqual([
      "start_date_key_invalid",
      "end_date_key_invalid",
    ]);
  });

  it("startDateKey > endDateKey -> date_window_order_invalid", () => {
    const result = evaluateExercisePerformance(baseInput({ startDateKey: "2026-09-30", endDateKey: "2026-09-01" }));
    expect(expectInvalid(result).reasons).toEqual(["date_window_order_invalid"]);
  });

  it("sessions no es array -> sessions_not_array", () => {
    const result = evaluateExercisePerformance({ ...baseInput(), sessions: "no-array" } as unknown as ExercisePerformanceInput);
    expect(expectInvalid(result).reasons).toEqual(["sessions_not_array"]);
  });

  it("varios problemas de fase 1 a la vez -> canonicalizados, no solo el primero encontrado", () => {
    const result = evaluateExercisePerformance({ startDateKey: "bogus", endDateKey: "bogus", sessions: "bogus" } as unknown as ExercisePerformanceInput);
    expect(expectInvalid(result).reasons).toEqual(["start_date_key_invalid", "end_date_key_invalid", "sessions_not_array"]);
  });
});

// ─── Fase 2 — sessionId/dateKey superficiales, siempre invalidan ───────────

describe("fase 2 — identidad y fecha superficial de cada sesión (invalida siempre, sin importar ventana)", () => {
  it("sesión que no es objeto plano -> session_object_invalid", () => {
    const result = evaluateExercisePerformance(baseInput({ sessions: ["no-objeto"] as unknown as readonly ExercisePerformanceSession[] }));
    expect(expectInvalid(result).reasons).toEqual(["session_object_invalid"]);
  });

  it("sessionId vacío -> session_id_invalid", () => {
    const result = evaluateExercisePerformance(baseInput({ sessions: [baseSession({ sessionId: "" })] }));
    expect(expectInvalid(result).reasons).toEqual(["session_id_invalid"]);
  });

  it("sessionId con solo espacios -> session_id_invalid (no se recorta silenciosamente)", () => {
    const result = evaluateExercisePerformance(baseInput({ sessions: [baseSession({ sessionId: "   " })] }));
    expect(expectInvalid(result).reasons).toEqual(["session_id_invalid"]);
  });

  it("sessionId con espacio inicial/final -> session_id_invalid, aunque el contenido no sea solo espacios", () => {
    const result = evaluateExercisePerformance(baseInput({ sessions: [baseSession({ sessionId: " s1" })] }));
    expect(expectInvalid(result).reasons).toEqual(["session_id_invalid"]);
    const result2 = evaluateExercisePerformance(baseInput({ sessions: [baseSession({ sessionId: "s1 " })] }));
    expect(expectInvalid(result2).reasons).toEqual(["session_id_invalid"]);
  });

  it("dateKey de sesión inválido invalida SIEMPRE, incluso si conceptualmente la sesión caería fuera de la ventana solicitada", () => {
    // Fecha imposible, muy anterior a la ventana — no importa que "debería" quedar fuera:
    // sin fecha válida no se puede decidir su pertenencia, así que invalida toda la llamada.
    const result = evaluateExercisePerformance(
      baseInput({
        startDateKey: "2026-09-01",
        endDateKey: "2026-09-30",
        sessions: [baseSession({ dateKey: "2020-13-99" })],
      }),
    );
    expect(expectInvalid(result).reasons).toEqual(["session_date_key_invalid"]);
  });

  it("varias sesiones con distintos problemas superficiales -> todas las razones acumuladas, no solo la primera", () => {
    const result = evaluateExercisePerformance(
      baseInput({
        sessions: [baseSession({ sessionId: "" }), baseSession({ sessionId: "s2", dateKey: "bogus" })],
      }),
    );
    expect(expectInvalid(result).reasons).toEqual(["session_id_invalid", "session_date_key_invalid"]);
  });
});

// ─── Fase 3 — selección por ventana ─────────────────────────────────────────

describe("fase 3 — una sesión fuera de ventana con contenido profundo corrupto NUNCA invalida la llamada", () => {
  it("sessionId/dateKey válidos, fuera de ventana, con set de tipo desconocido dentro -> evaluated, esa sesión simplemente no cuenta", () => {
    const outOfWindowCorrupt = {
      sessionId: "fuera",
      dateKey: "2026-08-01", // antes de la ventana 2026-09-01..2026-09-30
      durationMin: 30,
      exercises: [{ exerciseId: "x", sets: [{ ...baseSet(), type: "bogus" }], primaryMuscles: [], secondaryMuscles: [] }],
    } as unknown as ExercisePerformanceSession;
    const result = expectEvaluated(evaluateExercisePerformance(baseInput({ sessions: [outOfWindowCorrupt] })));
    expect(result.windowSessionCount).toBe(0);
  });

  it("mismo sessionId fuera y dentro de ventana -> NO se detecta como duplicado (fase 4 solo compara dentro de ventana)", () => {
    const outOfWindow = baseSession({ sessionId: "dup", dateKey: "2026-08-01" });
    const inWindow = baseSession({ sessionId: "dup", dateKey: "2026-09-10" });
    const result = expectEvaluated(evaluateExercisePerformance(baseInput({ sessions: [outOfWindow, inWindow] })));
    expect(result.windowSessionCount).toBe(1);
  });

  it("ventana de un solo día incluye esa fecha exacta (inclusiva en ambos extremos)", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({ startDateKey: "2026-09-10", endDateKey: "2026-09-10", sessions: [baseSession({ dateKey: "2026-09-10" })] }),
      ),
    );
    expect(result.windowSessionCount).toBe(1);
  });
});

// ─── Fase 4 — validación profunda, solo de sesiones en ventana ─────────────

describe("fase 4 — validación profunda de sesiones en ventana", () => {
  it("sessionId duplicado DENTRO de la ventana -> invalid_input/session_id_duplicate", () => {
    const result = evaluateExercisePerformance(
      baseInput({ sessions: [baseSession({ sessionId: "dup" }), baseSession({ sessionId: "dup", dateKey: "2026-09-11" })] }),
    );
    expect(expectInvalid(result).reasons).toEqual(["session_id_duplicate"]);
  });

  it("durationMin negativo o no finito -> session_duration_invalid; null sigue siendo válido", () => {
    expect(expectInvalid(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ durationMin: -1 })] }))).reasons).toEqual([
      "session_duration_invalid",
    ]);
    expect(expectInvalid(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ durationMin: Number.NaN })] }))).reasons).toEqual([
      "session_duration_invalid",
    ]);
    expect(expectInvalid(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ durationMin: Infinity })] }))).reasons).toEqual([
      "session_duration_invalid",
    ]);
    expect(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ durationMin: null })] })).status).toBe("evaluated");
  });

  it("exercises no es array -> exercises_not_array", () => {
    const result = evaluateExercisePerformance(
      baseInput({ sessions: [{ ...baseSession(), exercises: "bogus" } as unknown as ExercisePerformanceSession] }),
    );
    expect(expectInvalid(result).reasons).toEqual(["exercises_not_array"]);
  });

  it("exerciseId vacío o con espacios externos -> exercise_id_invalid", () => {
    expect(
      expectInvalid(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ exerciseId: "" })] })] })))
        .reasons,
    ).toEqual(["exercise_id_invalid"]);
    expect(
      expectInvalid(
        evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ exerciseId: " bench" })] })] })),
      ).reasons,
    ).toEqual(["exercise_id_invalid"]);
  });

  it("primaryMuscles/secondaryMuscles no son array -> muscle_list_invalid", () => {
    const result = evaluateExercisePerformance(
      baseInput({ sessions: [baseSession({ exercises: [{ ...baseExercise(), primaryMuscles: "bogus" } as unknown as ExercisePerformanceExercise] })] }),
    );
    expect(expectInvalid(result).reasons).toEqual(["muscle_list_invalid"]);
  });

  it("nombre de músculo vacío o con espacios externos -> muscle_list_invalid", () => {
    expect(
      expectInvalid(
        evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ primaryMuscles: [""] })] })] })),
      ).reasons,
    ).toEqual(["muscle_list_invalid"]);
    expect(
      expectInvalid(
        evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ primaryMuscles: [" Chest"] })] })] })),
      ).reasons,
    ).toEqual(["muscle_list_invalid"]);
  });

  it("sets no es array -> sets_not_array", () => {
    const result = evaluateExercisePerformance(
      baseInput({ sessions: [baseSession({ exercises: [{ ...baseExercise(), sets: "bogus" } as unknown as ExercisePerformanceExercise] })] }),
    );
    expect(expectInvalid(result).reasons).toEqual(["sets_not_array"]);
  });

  it("set que no es objeto plano -> set_object_invalid", () => {
    const result = evaluateExercisePerformance(
      baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: ["bogus"] as unknown as readonly ExercisePerformanceSet[] })] })] }),
    );
    expect(expectInvalid(result).reasons).toEqual(["set_object_invalid"]);
  });

  it("done no estrictamente booleano (número, string, ausente) -> set_done_invalid, nunca truthiness", () => {
    for (const bogusDone of [1, 0, "true", "false", undefined, null]) {
      const result = evaluateExercisePerformance(
        baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), done: bogusDone as unknown as boolean }] })] })] }),
      );
      expect(expectInvalid(result).reasons).toEqual(["set_done_invalid"]);
    }
  });

  it("type desconocido -> set_type_unknown (tipo ausente no se prueba aquí: pertenece al futuro adaptador, no al contrato normalizado)", () => {
    const result = evaluateExercisePerformance(
      baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), type: "isometric" as unknown as ExercisePerformanceSet["type"] }] })] })] }),
    );
    expect(expectInvalid(result).reasons).toEqual(["set_type_unknown"]);
  });

  it("reps negativas, no enteras, NaN o Infinity -> set_reps_invalid; reps:0 sigue siendo válido", () => {
    for (const bogusReps of [-1, 3.5, Number.NaN, Infinity]) {
      const result = evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), reps: bogusReps }] })] })] }));
      expect(expectInvalid(result).reasons).toEqual(["set_reps_invalid"]);
    }
    expect(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), reps: 0 }] })] })] })).status).toBe(
      "evaluated",
    );
  });

  it("externalLoadKg negativo, NaN o Infinity -> set_external_load_invalid; null y 0 siguen siendo válidos", () => {
    for (const bogusLoad of [-1, Number.NaN, Infinity]) {
      const result = evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), externalLoadKg: bogusLoad }] })] })] }));
      expect(expectInvalid(result).reasons).toEqual(["set_external_load_invalid"]);
    }
    expect(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), externalLoadKg: null }] })] })] })).status).toBe("evaluated");
    expect(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), externalLoadKg: 0 }] })] })] })).status).toBe("evaluated");
  });

  it("rir negativo, >10, NaN o Infinity -> set_rir_invalid; 0 y null siguen siendo válidos", () => {
    for (const bogusRir of [-1, 11, Number.NaN, Infinity]) {
      const result = evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), rir: bogusRir }] })] })] }));
      expect(expectInvalid(result).reasons).toEqual(["set_rir_invalid"]);
    }
    expect(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), rir: 0 }] })] })] })).status).toBe("evaluated");
    expect(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), rir: null }] })] })] })).status).toBe("evaluated");
  });
});

// ─── Canonicalización ────────────────────────────────────────────────────

describe("canonicalización de razones — independiente del orden de aparición", () => {
  it("mismas violaciones en sesiones en orden distinto -> mismo array de reasons, mismo orden, deduplicado", () => {
    const sessionA = baseSession({ sessionId: "a", exercises: [baseExercise({ sets: [{ ...baseSet(), reps: -1 }] })] });
    const sessionB = baseSession({ sessionId: "b", dateKey: "2026-09-11", exercises: [baseExercise({ sets: [{ ...baseSet(), externalLoadKg: -1 }] })] });
    const r1 = evaluateExercisePerformance(baseInput({ sessions: [sessionA, sessionB] }));
    const r2 = evaluateExercisePerformance(baseInput({ sessions: [sessionB, sessionA] }));
    expect(expectInvalid(r1).reasons).toEqual(["set_reps_invalid", "set_external_load_invalid"]);
    expect(expectInvalid(r2).reasons).toEqual(expectInvalid(r1).reasons);
  });
});

// ─── Cobertura por señal ─────────────────────────────────────────────────

describe("cobertura — cero sesiones en ventana", () => {
  it("todas las señales insufficient_data/no_sessions_in_window, windowSessionCount 0", () => {
    const result = expectEvaluated(evaluateExercisePerformance(baseInput({ sessions: [] })));
    expect(result.windowSessionCount).toBe(0);
    expect(result.sessionDurationCoverage).toEqual({ status: "insufficient_data", coverage: { unit: "sessions", eligibleCount: 0, observedCount: 0 }, reasons: ["no_sessions_in_window"] });
    expect(result.estimatedOneRepMaxObservations.status).toBe("insufficient_data");
    expect(result.externalLoadTonnage.status).toBe("insufficient_data");
    expect(result.muscleSetCounts.status).toBe("insufficient_data");
    expect(result.rirObservations.status).toBe("insufficient_data");
    for (const signal of [result.estimatedOneRepMaxObservations, result.externalLoadTonnage, result.muscleSetCounts, result.rirObservations]) {
      if (signal.status === "insufficient_data") expect(signal.reasons).toEqual(["no_sessions_in_window"]);
    }
  });
});

describe("cobertura — no_eligible_sets (sesiones existen, sin ningún ejercicio)", () => {
  it("sesión sin exercises -> duración disponible, resto no_eligible_sets", () => {
    const result = expectEvaluated(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [] })] })));
    expect(result.sessionDurationCoverage.status).toBe("available");
    expect(result.estimatedOneRepMaxObservations).toEqual({ status: "insufficient_data", coverage: { unit: "sets", eligibleCount: 0, observedCount: 0 }, reasons: ["no_eligible_sets"] });
    expect(result.externalLoadTonnage.status).toBe("insufficient_data");
    expect(result.muscleSetCounts.status).toBe("insufficient_data");
    expect(result.rirObservations.status).toBe("insufficient_data");
  });
});

describe("cobertura — eligible > 0 y observado = 0, razón específica del dato ausente", () => {
  it("duración: sesiones existen, ninguna con durationMin -> no_session_duration_recorded", () => {
    const result = expectEvaluated(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ durationMin: null })] })));
    expect(result.sessionDurationCoverage).toEqual({
      status: "insufficient_data",
      coverage: { unit: "sessions", eligibleCount: 1, observedCount: 0 },
      reasons: ["no_session_duration_recorded"],
    });
  });

  it("e1RM y tonelaje: series elegibles existen, ninguna con carga positiva -> no_positive_external_load", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), externalLoadKg: null }] })] })] })),
    );
    expect(result.estimatedOneRepMaxObservations).toEqual({
      status: "insufficient_data",
      coverage: { unit: "sets", eligibleCount: 1, observedCount: 0 },
      reasons: ["no_positive_external_load"],
    });
    expect(result.externalLoadTonnage).toEqual({
      status: "insufficient_data",
      coverage: { unit: "sets", eligibleCount: 1, observedCount: 0 },
      reasons: ["no_positive_external_load"],
    });
  });

  it("músculo: series de trabajo existen, ningún ejercicio con metadata -> no_muscle_metadata", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ primaryMuscles: [], secondaryMuscles: [] })] })] })),
    );
    expect(result.muscleSetCounts).toEqual({
      status: "insufficient_data",
      coverage: { unit: "sets", eligibleCount: 1, observedCount: 0 },
      reasons: ["no_muscle_metadata"],
    });
  });

  it("RIR: series de trabajo existen, ninguna con rir registrado -> no_rir_recorded", () => {
    const result = expectEvaluated(evaluateExercisePerformance(baseInput({ sessions: [baseSession()] })));
    expect(result.rirObservations).toEqual({
      status: "insufficient_data",
      coverage: { unit: "sets", eligibleCount: 1, observedCount: 0 },
      reasons: ["no_rir_recorded"],
    });
  });

  it("un ejercicio con metadata muscular y otro sin ella -> cobertura parcial real (0 < observado < elegible)", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({
          sessions: [
            baseSession({
              exercises: [
                baseExercise({ exerciseId: "con-musculo", primaryMuscles: ["Chest"], secondaryMuscles: [] }),
                baseExercise({ exerciseId: "sin-musculo", primaryMuscles: [], secondaryMuscles: [] }),
              ],
            }),
          ],
        }),
      ),
    );
    if (result.muscleSetCounts.status !== "available") throw new Error("esperado available");
    expect(result.muscleSetCounts.coverage).toEqual({ unit: "sets", eligibleCount: 2, observedCount: 1 });
  });
});

// ─── e1RM — fórmula y método ─────────────────────────────────────────────

describe("e1RM — fórmula Epley documentada, sin RIR", () => {
  it("reps=8, carga=50 -> 50*(1+8/30), method epley, con procedencia por índices", () => {
    const result = expectEvaluated(evaluateExercisePerformance(baseInput()));
    if (result.estimatedOneRepMaxObservations.status !== "available") throw new Error("esperado available");
    const [obs] = result.estimatedOneRepMaxObservations.value;
    const expected = 50 * (1 + 8 / 30);
    expect(obs).toEqual({
      sessionId: "s1",
      dateKey: "2026-09-10",
      exerciseId: "bench-press",
      exerciseOccurrenceIndex: 0,
      setIndex: 0,
      externalLoadKg: 50,
      reps: 8,
      rir: null,
      method: "epley",
      estimatedOneRepMaxKg: expected,
    });
  });
});

describe("e1RM — variante con RIR (regla de producto, no evidencia externa)", () => {
  it("reps=5, rir=2, carga=100 -> 100*(1+7/30), method epley_rir_adjusted", () => {
    const set = { reps: 5, externalLoadKg: 100, done: true, type: "normal" as const, rir: 2 };
    const result = expectEvaluated(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [set] })] })] })));
    if (result.estimatedOneRepMaxObservations.status !== "available") throw new Error("esperado available");
    const expected = 100 * (1 + (5 + 2) / 30);
    expect(result.estimatedOneRepMaxObservations.value[0].estimatedOneRepMaxKg).toBeCloseTo(expected, 9);
    expect(result.estimatedOneRepMaxObservations.value[0].method).toBe("epley_rir_adjusted");
  });

  it("rir:0 sigue siendo epley_rir_adjusted, aunque numéricamente coincida con epley puro", () => {
    const setWithRirZero = { reps: 8, externalLoadKg: 50, done: true, type: "normal" as const, rir: 0 };
    const result = expectEvaluated(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [setWithRirZero] })] })] })));
    if (result.estimatedOneRepMaxObservations.status !== "available") throw new Error("esperado available");
    const obs = result.estimatedOneRepMaxObservations.value[0];
    expect(obs.method).toBe("epley_rir_adjusted");
    expect(obs.rir).toBe(0);
    expect(obs.estimatedOneRepMaxKg).toBeCloseTo(50 * (1 + 8 / 30), 9); // mismo valor numérico que epley puro
  });

  it("warmup y dropset nunca cuentan para e1RM; failure sí", () => {
    const sets = [
      { ...baseSet(), type: "warmup" as const },
      { ...baseSet(), type: "dropset" as const },
      { ...baseSet(), type: "failure" as const },
    ];
    const result = expectEvaluated(evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets })] })] })));
    if (result.estimatedOneRepMaxObservations.status !== "available") throw new Error("esperado available");
    expect(result.estimatedOneRepMaxObservations.coverage).toEqual({ unit: "sets", eligibleCount: 1, observedCount: 1 });
    expect(result.estimatedOneRepMaxObservations.value).toHaveLength(1);
  });
});

// ─── Tonelaje ────────────────────────────────────────────────────────────

describe("externalLoadTonnage — solo carga externa × repeticiones, agregado por sesión+ejercicio", () => {
  it("dos bloques del mismo exerciseId en la misma sesión -> una sola entrada, tonelaje sumado", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({
          sessions: [
            baseSession({
              exercises: [
                baseExercise({ exerciseId: "bench-press", sets: [{ ...baseSet(), reps: 8, externalLoadKg: 50 }] }),
                baseExercise({ exerciseId: "bench-press", sets: [{ ...baseSet(), reps: 8, externalLoadKg: 50 }] }),
              ],
            }),
          ],
        }),
      ),
    );
    if (result.externalLoadTonnage.status !== "available") throw new Error("esperado available");
    expect(result.externalLoadTonnage.value).toEqual([
      { sessionId: "s1", dateKey: "2026-09-10", exerciseId: "bench-press", tonnageKgReps: 800, contributingSetCount: 2 },
    ]);
  });

  it("dropset SÍ cuenta para tonelaje (solo warmup se excluye)", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), type: "dropset" }] })] })] })),
    );
    if (result.externalLoadTonnage.status !== "available") throw new Error("esperado available");
    expect(result.externalLoadTonnage.value[0].tonnageKgReps).toBe(400);
  });

  // Regresión: la clave interna de agregación NUNCA debe poder colisionar
  // entre dos pares (sessionId, exerciseId) distintos. El separador real
  // usado en la implementación actual es U+0000 (NUL) — no un espacio: un
  // espacio literal en sessionId/exerciseId NO colisiona (verificado), pero
  // NUL sí, porque String.prototype.trim() no lo considera whitespace y por
  // tanto pasa la validación de identificador sin recortarse. sessionId
  // "workout" + exerciseId "A B" y sessionId "workout A" +
  // exerciseId "B" producen la misma clave concatenada con NUL como
  // separador — deben quedar como dos entradas totalmente independientes
  // bajo cualquier separador, precisamente porque una estructura anidada
  // nunca concatena en primer lugar.
  it("REGRESIÓN — dos pares (sessionId, exerciseId) con NUL embebido que colisionarían por concatenación producen entradas independientes", () => {
    const NUL = String.fromCharCode(0);
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({
          sessions: [
            baseSession({
              sessionId: "workout",
              dateKey: "2026-09-10",
              exercises: [baseExercise({ exerciseId: `A${NUL}B`, sets: [{ ...baseSet(), reps: 5, externalLoadKg: 60 }] })],
            }),
            baseSession({
              sessionId: `workout${NUL}A`,
              dateKey: "2026-09-11",
              exercises: [baseExercise({ exerciseId: "B", sets: [{ ...baseSet(), reps: 10, externalLoadKg: 20 }] })],
            }),
          ],
        }),
      ),
    );
    if (result.externalLoadTonnage.status !== "available") throw new Error("esperado available");
    expect(result.externalLoadTonnage.value).toEqual([
      { sessionId: "workout", dateKey: "2026-09-10", exerciseId: `A${NUL}B`, tonnageKgReps: 300, contributingSetCount: 1 },
      { sessionId: `workout${NUL}A`, dateKey: "2026-09-11", exerciseId: "B", tonnageKgReps: 200, contributingSetCount: 1 },
    ]);
  });

  // Regresión: observedCount debe contar SERIES observadas, nunca entradas
  // agregadas — con varias series del mismo ejercicio/sesión, el tonelaje
  // se agrega en una sola entrada de `value`, pero la cobertura debe seguir
  // reflejando las 3 series reales que contribuyeron, no 1.
  it("REGRESIÓN — observedCount cuenta series observadas, no entradas agregadas (cobertura real 100%, value.length === 1)", () => {
    const threeWorkingSets = [
      { ...baseSet(), reps: 8, externalLoadKg: 50 },
      { ...baseSet(), reps: 8, externalLoadKg: 50 },
      { ...baseSet(), reps: 8, externalLoadKg: 50 },
    ];
    const result = expectEvaluated(
      evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: threeWorkingSets })] })] })),
    );
    if (result.externalLoadTonnage.status !== "available") throw new Error("esperado available");
    expect(result.externalLoadTonnage.coverage).toEqual({ unit: "sets", eligibleCount: 3, observedCount: 3 });
    expect(result.externalLoadTonnage.value).toHaveLength(1);
    expect(result.externalLoadTonnage.value[0].contributingSetCount).toBe(3);
  });

  it("invariante — sum(value[].contributingSetCount) === coverage.observedCount, con varios ejercicios, bloques repetidos y sesiones", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({
          sessions: [
            baseSession({
              sessionId: "s1",
              dateKey: "2026-09-10",
              exercises: [
                baseExercise({ exerciseId: "bench-press", sets: [{ ...baseSet() }, { ...baseSet() }] }),
                baseExercise({ exerciseId: "bench-press", sets: [{ ...baseSet() }] }), // bloque repetido, mismo exerciseId
                baseExercise({ exerciseId: "squat", sets: [{ ...baseSet() }] }),
              ],
            }),
            baseSession({
              sessionId: "s2",
              dateKey: "2026-09-11",
              exercises: [baseExercise({ exerciseId: "deadlift", sets: [{ ...baseSet() }, { ...baseSet(), externalLoadKg: null }] })],
            }),
          ],
        }),
      ),
    );
    if (result.externalLoadTonnage.status !== "available") throw new Error("esperado available");
    const sumContributing = result.externalLoadTonnage.value.reduce((sum, e) => sum + e.contributingSetCount, 0);
    expect(sumContributing).toBe(result.externalLoadTonnage.coverage.observedCount);
    expect(result.externalLoadTonnage.coverage.observedCount).toBe(5); // 2+1+1 (s1) + 1 (s2, la de externalLoadKg:null no observa)
  });
});

// ─── Reps cero ───────────────────────────────────────────────────────────

describe("reps:0 — estructuralmente válido, excluido de eligibleCount de e1RM y tonelaje, no de músculo/RIR", () => {
  it("reps:0 nunca vuelve disponible una señal de tonelaje con valor 0", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), reps: 0 }] })] })] })),
    );
    expect(result.estimatedOneRepMaxObservations).toEqual({
      status: "insufficient_data",
      coverage: { unit: "sets", eligibleCount: 0, observedCount: 0 },
      reasons: ["no_eligible_sets"],
    });
    expect(result.externalLoadTonnage.status).toBe("insufficient_data");
    if (result.externalLoadTonnage.status === "insufficient_data") expect(result.externalLoadTonnage.coverage.eligibleCount).toBe(0);
    // músculo y RIR no exigen reps>0: la serie SÍ es elegible para ellos.
    expect(result.muscleSetCounts.status).toBe("available");
  });
});

// ─── null vs. 0 de carga externa ─────────────────────────────────────────

describe("externalLoadKg — null y 0 no son sinónimos, pero comparten el mismo efecto de cobertura", () => {
  it("ambos excluidos de observedCount por el mismo criterio (> 0), sin afirmar igualdad total", () => {
    const withNull = expectEvaluated(
      evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), externalLoadKg: null }] })] })] })),
    );
    const withZero = expectEvaluated(
      evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), externalLoadKg: 0 }] })] })] })),
    );
    expect(withNull.estimatedOneRepMaxObservations.coverage).toEqual(withZero.estimatedOneRepMaxObservations.coverage);
    expect(withNull.externalLoadTonnage.coverage).toEqual(withZero.externalLoadTonnage.coverage);
    // Sin comparar el resultado completo: solo el efecto de cobertura coincide, no se afirma equivalencia semántica.
  });
});

// ─── Músculo — primario/secundario ───────────────────────────────────────

describe("muscleSetCounts — primario/secundario, deduplicación, sin ponderación", () => {
  it("una serie suma +1 a CADA músculo primario listado (puede superar el total de series)", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({ sessions: [baseSession({ exercises: [baseExercise({ primaryMuscles: ["Chest", "Shoulders"], secondaryMuscles: [] })] })] }),
      ),
    );
    if (result.muscleSetCounts.status !== "available") throw new Error("esperado available");
    const byMuscle = Object.fromEntries(result.muscleSetCounts.value.map((e) => [e.muscle, e]));
    expect(byMuscle["Chest"]).toEqual({ muscle: "Chest", primaryCount: 1, secondaryCount: 0 });
    expect(byMuscle["Shoulders"]).toEqual({ muscle: "Shoulders", primaryCount: 1, secondaryCount: 0 });
  });

  it("secundario nunca se suma a primaryCount, ni se pondera", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({ sessions: [baseSession({ exercises: [baseExercise({ primaryMuscles: ["Chest"], secondaryMuscles: ["Triceps"] })] })] }),
      ),
    );
    if (result.muscleSetCounts.status !== "available") throw new Error("esperado available");
    const byMuscle = Object.fromEntries(result.muscleSetCounts.value.map((e) => [e.muscle, e]));
    expect(byMuscle["Triceps"]).toEqual({ muscle: "Triceps", primaryCount: 0, secondaryCount: 1 });
  });

  it("el mismo músculo repetido dos veces en primaryMuscles del mismo ejercicio cuenta una sola vez por serie", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({ sessions: [baseSession({ exercises: [baseExercise({ primaryMuscles: ["Chest", "Chest"], secondaryMuscles: [] })] })] }),
      ),
    );
    if (result.muscleSetCounts.status !== "available") throw new Error("esperado available");
    expect(result.muscleSetCounts.value).toEqual([{ muscle: "Chest", primaryCount: 1, secondaryCount: 0 }]);
  });

  it("mismo músculo en primaria Y secundaria del mismo ejercicio -> ambas contribuciones se conservan por separado", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({ sessions: [baseSession({ exercises: [baseExercise({ primaryMuscles: ["Chest"], secondaryMuscles: ["Chest"] })] })] }),
      ),
    );
    if (result.muscleSetCounts.status !== "available") throw new Error("esperado available");
    expect(result.muscleSetCounts.value).toEqual([{ muscle: "Chest", primaryCount: 1, secondaryCount: 1 }]);
  });

  it("warmup no cuenta como serie de trabajo para músculo", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), type: "warmup" }] })] })] }),
      ),
    );
    expect(result.muscleSetCounts.status).toBe("insufficient_data");
    if (result.muscleSetCounts.status === "insufficient_data") expect(result.muscleSetCounts.coverage.eligibleCount).toBe(0);
  });
});

// ─── RIR — procedencia completa ──────────────────────────────────────────

describe("rirObservations — observaciones tipadas con procedencia, sin withoutRirCount redundante", () => {
  it("solo las series con rir no nulo aparecen, con sessionId/dateKey/exerciseId/índices", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), rir: 3 }, { ...baseSet(), rir: null }] })] })] }),
      ),
    );
    if (result.rirObservations.status !== "available") throw new Error("esperado available");
    expect(result.rirObservations.value).toEqual([
      { sessionId: "s1", dateKey: "2026-09-10", exerciseId: "bench-press", exerciseOccurrenceIndex: 0, setIndex: 0, rir: 3 },
    ]);
    // Invariante documentado: eligibleCount - observedCount = "sin RIR" (2 - 1 = 1), sin campo duplicado.
    expect(result.rirObservations.coverage.eligibleCount - result.rirObservations.coverage.observedCount).toBe(1);
  });

  it("rir:0 SÍ es una observación de RIR presente (distinto de rir:null)", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), rir: 0 }] })] })] })),
    );
    if (result.rirObservations.status !== "available") throw new Error("esperado available");
    expect(result.rirObservations.value[0].rir).toBe(0);
  });
});

// ─── Identidad — bloques repetidos ───────────────────────────────────────

describe("identidad — bloques repetidos del mismo exerciseId con índices distintos", () => {
  it("dos bloques idénticos (mismas reps/carga) del mismo exerciseId -> exerciseOccurrenceIndex distinto", () => {
    const identicalSet = { ...baseSet(), reps: 5, externalLoadKg: 60 };
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({
          sessions: [
            baseSession({
              exercises: [
                baseExercise({ exerciseId: "squat", sets: [identicalSet] }),
                baseExercise({ exerciseId: "squat", sets: [identicalSet] }),
              ],
            }),
          ],
        }),
      ),
    );
    if (result.estimatedOneRepMaxObservations.status !== "available") throw new Error("esperado available");
    const [first, second] = result.estimatedOneRepMaxObservations.value;
    expect(first.exerciseOccurrenceIndex).toBe(0);
    expect(second.exerciseOccurrenceIndex).toBe(1);
    expect(first.setIndex).toBe(0);
    expect(second.setIndex).toBe(0);
  });
});

// ─── Dos sesiones el mismo día ────────────────────────────────────────────

describe("dos sesiones válidas el mismo día — ambas se procesan íntegras", () => {
  it("no se fusionan ni se descarta ninguna", () => {
    const result = expectEvaluated(
      evaluateExercisePerformance(
        baseInput({ sessions: [baseSession({ sessionId: "a", dateKey: "2026-09-10" }), baseSession({ sessionId: "b", dateKey: "2026-09-10" })] }),
      ),
    );
    expect(result.windowSessionCount).toBe(2);
  });
});

// ─── Seguridad numérica ───────────────────────────────────────────────────

describe("seguridad numérica — ningún resultado evaluated contiene NaN/Infinity/contador inseguro", () => {
  it("suma de duración finita que desborda -> invalid_input/derived_numeric_result_invalid", () => {
    const huge = 9e307; // finito (< Number.MAX_VALUE), pero la suma de dos desborda
    const result = evaluateExercisePerformance(
      baseInput({
        sessions: [
          baseSession({ sessionId: "a", dateKey: "2026-09-10", durationMin: huge, exercises: [] }),
          baseSession({ sessionId: "b", dateKey: "2026-09-11", durationMin: huge, exercises: [] }),
        ],
      }),
    );
    expect(expectInvalid(result).reasons).toEqual(["derived_numeric_result_invalid"]);
  });

  it("carga y reps finitas cuyo producto de tonelaje desborda, sin que e1RM desborde -> invalid_input, verificado que el producto realmente excede Number.MAX_VALUE", () => {
    const load = Number.MAX_VALUE / 9; // finito
    expect(Number.isFinite(load)).toBe(true);
    expect(load * 10).toBeGreaterThan(Number.MAX_VALUE); // confirma el desbordamiento matemático independientemente del kernel
    const result = evaluateExercisePerformance(
      baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), externalLoadKg: load, reps: 10 }] })] })] }),
    );
    expect(expectInvalid(result).reasons).toEqual(["derived_numeric_result_invalid"]);
  });

  it("e1RM derivado no finito por el factor (1+reps/30), con reps=1 y carga extrema -> invalid_input", () => {
    const load = Number.MAX_VALUE / 1.02; // finito
    expect(Number.isFinite(load)).toBe(true);
    expect(load * (1 + 1 / 30)).toBeGreaterThan(Number.MAX_VALUE); // confirma el desbordamiento independientemente del kernel
    const result = evaluateExercisePerformance(
      baseInput({ sessions: [baseSession({ exercises: [baseExercise({ sets: [{ ...baseSet(), externalLoadKg: load, reps: 1 }] })] })] }),
    );
    expect(expectInvalid(result).reasons).toEqual(["derived_numeric_result_invalid"]);
  });
});

// ─── Orden determinista completo ──────────────────────────────────────────

describe("determinismo — reordenar sesiones válidas produce el resultado COMPLETO idéntico", () => {
  it("comparación profunda del objeto entero, no de longitudes o subconjuntos", () => {
    const sessions = [
      baseSession({ sessionId: "b", dateKey: "2026-09-15", exercises: [baseExercise({ exerciseId: "squat", sets: [{ ...baseSet(), rir: 2 }] })] }),
      baseSession({ sessionId: "a", dateKey: "2026-09-10", exercises: [baseExercise({ exerciseId: "bench-press" })] }),
    ];
    const resultA = evaluateExercisePerformance(baseInput({ sessions }));
    const resultB = evaluateExercisePerformance(baseInput({ sessions: [...sessions].reverse() }));
    expect(resultA).toEqual(resultB);
  });
});

// ─── Inmutabilidad ────────────────────────────────────────────────────────

describe("inmutabilidad — evaluateExercisePerformance nunca muta la entrada", () => {
  it("el input y sus arrays anidados permanecen intactos tras la llamada", () => {
    const input = baseInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    evaluateExercisePerformance(input);
    expect(input).toEqual(snapshot);
  });
});

// ─── Guardas de robustez runtime amplias ──────────────────────────────────

describe("guarda total — nunca lanza para una combinación amplia de valores estructuralmente inválidos", () => {
  it("ninguno de estos valores provoca una excepción", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      0,
      "x",
      [],
      {},
      { startDateKey: "bogus" },
      { sessions: "bogus" },
      { startDateKey: "2026-09-01", endDateKey: "2026-09-30", sessions: [{}] },
      { startDateKey: "2026-09-01", endDateKey: "2026-09-30", sessions: [{ sessionId: "s", dateKey: "2026-09-10", exercises: "bogus" }] },
    ];
    for (const g of garbage) {
      expect(() => evaluateExercisePerformance(g as unknown as ExercisePerformanceInput)).not.toThrow();
    }
  });
});

// ─── API pública del barrel ────────────────────────────────────────────────

describe("API público del barrel — packages/engine/src/index.ts", () => {
  it("expone evaluateExercisePerformance y ninguno de los helpers internos de PR4", () => {
    const barrel = engineBarrel as Record<string, unknown>;
    expect(typeof barrel.evaluateExercisePerformance).toBe("function");
    // Lista exhaustiva: los 26 nombres de función privada + 1 clase privada
    // (sin `export`) que existen hoy en exercise-performance-kernel.ts —
    // recalculada desde el archivo final tras retirar assertNever (código
    // muerto, sin ningún switch exhaustivo que lo necesite) e incluyendo
    // isLeapYear y NonFiniteDerivedValueError, ausentes de una versión
    // anterior de esta lista. Mantenerla sincronizada con las declaraciones
    // `function`/`class` del kernel.
    const forbiddenNames = [
      "isPlainRecord",
      "isLeapYear",
      "isValidCalendarDateKey",
      "compareStrings",
      "isStrictNonEmptyTrimmedString",
      "isKnownSetType",
      "isFiniteNonNegative",
      "isSafeNonNegativeInteger",
      "isValidRir",
      "canonicalizeInvalidReasons",
      "invalidInput",
      "NonFiniteDerivedValueError",
      "assertFinite",
      "validateMuscleList",
      "validateDeepSet",
      "validateDeepExercise",
      "validateShallow",
      "selectAndValidateDeep",
      "insufficiencyReasonsFor",
      "buildSignalResult",
      "compareByDateThenSession",
      "compareByDateSessionExercise",
      "compareByFiveKeys",
      "isE1rmEligible",
      "isTonnageEligible",
      "isWorkingSet",
      "computeEvaluated",
    ];
    for (const name of forbiddenNames) expect(barrel[name]).toBeUndefined();
  });

  it("evaluateExercisePerformance importado desde el barrel se comporta igual que el import directo", () => {
    const input = baseInput();
    expect(engineBarrel.evaluateExercisePerformance(input)).toEqual(evaluateExercisePerformance(input));
  });
});

// ─── Pureza (AST real, no regex) ──────────────────────────────────────────
//
// Alcance declarado con honestidad: este visitor detecta ACCESOS DIRECTOS
// prohibidos (new Date, Date.now, Math.random, process.env) e
// IDENTIFICADORES GLOBALES SUELTOS prohibidos (fetch, localStorage, etc.)
// tal como aparecen escritos en el código — no es un análisis de flujo de
// datos y NO detecta alias ni desestructuración (p. ej. `const { random } =
// Math; random()` no dispara ninguna de las tres ramas de abajo). Extender
// el visitor para perseguir cualquier forma posible de alias exigiría un
// mini análisis de flujo de datos — exactamente el "parser casero frágil"
// que se decidió no construir. La import-check de más abajo cubre, en
// cambio, con certeza total (no heurística) que el kernel no importa nada
// de apps/web, Supabase, red, filesystem ni ninguna API con efectos: ahí
// SÍ basta con inspeccionar los especificadores de módulo declarados.

function findForbiddenDirectRuntimeReferences(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const bareForbiddenNames = new Set(["fetch", "localStorage", "sessionStorage", "globalThis", "setTimeout", "setInterval"]);
  const violations: string[] = [];
  function describeNode(node: ts.Node): string {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${node.getText(sourceFile)} (línea ${line + 1})`;
  }
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
      violations.push(describeNode(node));
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const objectName = node.expression.text;
      const propertyName = node.name.text;
      if (
        (objectName === "Date" && propertyName === "now") ||
        (objectName === "Math" && propertyName === "random") ||
        (objectName === "process" && propertyName === "env")
      ) {
        violations.push(describeNode(node));
      }
    } else if (ts.isIdentifier(node) && bareForbiddenNames.has(node.text)) {
      violations.push(describeNode(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

/** Certeza total, no heurística: enumera los especificadores de módulo de
    TODAS las declaraciones import del archivo — si esta lista no contiene
    nada de apps/web, Supabase, red, filesystem o similar, el kernel no
    puede haber importado ninguno de esos módulos, sin importar cómo los
    use internamente. */
function collectImportModuleSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

describe("pureza — accesos directos prohibidos e imports prohibidos (AST real, alcance declarado)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fileName = join(here, "exercise-performance-kernel.ts");
  const source = readFileSync(fileName, "utf-8");

  it("el AST no contiene ningún acceso directo prohibido a Date/reloj/red/almacenamiento/estado global", () => {
    expect(findForbiddenDirectRuntimeReferences(source, fileName)).toEqual([]);
  });

  it("el único import del archivo es de tipos de @foodos/types — nada de apps/web, Supabase, red, filesystem ni APIs con efectos", () => {
    const specifiers = collectImportModuleSpecifiers(source, fileName);
    expect(specifiers).toEqual(["@foodos/types"]);
    for (const spec of specifiers) {
      expect(spec).not.toMatch(/apps\/web|supabase|node:fs|node:http|node:https|node:net|node:dgram|undici|cross-fetch|axios/i);
    }
  });
});
