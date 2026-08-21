import { describe, expect, it } from "vitest";
import type { CompletedExercise, CompletedSet, WorkoutSession } from "@foodos/types";
import { bestE1RM, estimateOneRepMax, setsByMuscle, totalVolume, weeklySetsByMuscle } from "./strength";

describe("estimateOneRepMax (Epley)", () => {
  it("con 1 repetición, el peso levantado ya es el 1RM", () => {
    expect(estimateOneRepMax(100, 1)).toBe(100);
  });

  it("100kg x 5 reps → 1RM = 100 * (1 + 5/30) ≈ 116.7 kg", () => {
    expect(estimateOneRepMax(100, 5)).toBeCloseTo(116.7, 1);
  });

  it("60kg x 10 reps → 1RM = 60 * (1 + 10/30) = 80 kg", () => {
    expect(estimateOneRepMax(60, 10)).toBe(80);
  });

  it("peso o reps a 0/negativos devuelve 0 (sin 1RM que calcular)", () => {
    expect(estimateOneRepMax(0, 5)).toBe(0);
    expect(estimateOneRepMax(60, 0)).toBe(0);
    expect(estimateOneRepMax(-10, 5)).toBe(0);
  });
});

describe("bestE1RM", () => {
  it("sin series, devuelve null", () => {
    expect(bestE1RM(undefined)).toBeNull();
    expect(bestE1RM([])).toBeNull();
  });

  it("ignora series no marcadas como hechas", () => {
    const sets: CompletedSet[] = [
      { reps: 5, weight: 100, done: false },
    ];
    expect(bestE1RM(sets)).toBeNull();
  });

  it("ignora series de peso corporal (weight null) — no dan e1RM", () => {
    const sets: CompletedSet[] = [
      { reps: 10, weight: null, done: true },
    ];
    expect(bestE1RM(sets)).toBeNull();
  });

  it("devuelve el e1RM de la MEJOR serie, no la última ni la primera", () => {
    const sets: CompletedSet[] = [
      { reps: 10, weight: 60, done: true },  // e1RM 80
      { reps: 5,  weight: 100, done: true }, // e1RM ~116.7 ← la mejor
      { reps: 8,  weight: 70, done: true },  // e1RM ~88.7
    ];
    expect(bestE1RM(sets)).toBeCloseTo(116.7, 1);
  });
});

describe("totalVolume", () => {
  it("suma peso × reps solo de las series hechas y con peso", () => {
    const sets: CompletedSet[] = [
      { reps: 10, weight: 60, done: true },   // 600
      { reps: 8,  weight: 70, done: true },   // 560
      { reps: 8,  weight: 70, done: false },  // no cuenta (no hecha)
      { reps: 12, weight: null, done: true }, // no cuenta (peso corporal)
    ];
    expect(totalVolume(sets)).toBe(1160);
  });

  it("sin series, devuelve 0", () => {
    expect(totalVolume(undefined)).toBe(0);
  });

  it("el calentamiento no cuenta como volumen de trabajo", () => {
    const sets: CompletedSet[] = [
      { reps: 10, weight: 20, done: true, type: "warmup" }, // no cuenta
      { reps: 8,  weight: 60, done: true, type: "normal" }, // 480
    ];
    expect(totalVolume(sets)).toBe(480);
  });

  it("los dropsets SÍ cuentan como volumen (no son calentamiento)", () => {
    const sets: CompletedSet[] = [
      { reps: 8, weight: 60, done: true, type: "normal" },   // 480
      { reps: 6, weight: 40, done: true, type: "dropset" },  // 240
    ];
    expect(totalVolume(sets)).toBe(720);
  });
});

describe("bestE1RM — tipos de serie y RIR", () => {
  it("el calentamiento no cuenta para el 1RM (carga deliberadamente submáxima)", () => {
    const sets: CompletedSet[] = [
      { reps: 10, weight: 130, done: true, type: "warmup" }, // e1RM alto pero descartado
      { reps: 5,  weight: 100, done: true, type: "normal" }, // e1RM ~116.7 ← esta gana
    ];
    expect(bestE1RM(sets)).toBeCloseTo(116.7, 1);
  });

  it("los dropsets no cuentan para el 1RM (post-fatiga, no representan la fuerza máxima)", () => {
    const sets: CompletedSet[] = [
      { reps: 5, weight: 100, done: true, type: "normal" },  // e1RM ~116.7 ← esta gana
      { reps: 6, weight: 90,  done: true, type: "dropset" }, // descartada
    ];
    expect(bestE1RM(sets)).toBeCloseTo(116.7, 1);
  });

  it("una serie al fallo SÍ cuenta para el 1RM", () => {
    const sets: CompletedSet[] = [
      { reps: 6, weight: 90, done: true, type: "failure" },
    ];
    expect(bestE1RM(sets)).toBeCloseTo(108, 1); // 90 * (1 + 6/30) = 108
  });

  it("el RIR sube el e1RM efectivo: 5 reps con RIR 2 equivale a ~7 reps al fallo", () => {
    const conRir: CompletedSet[] = [{ reps: 5, weight: 100, done: true, rir: 2 }];
    const sinRir: CompletedSet[] = [{ reps: 5, weight: 100, done: true, rir: 0 }];
    expect(bestE1RM(conRir)!).toBeGreaterThan(bestE1RM(sinRir)!);
    expect(bestE1RM(conRir)).toBeCloseTo(estimateOneRepMax(100, 7), 1);
  });
});

describe("setsByMuscle", () => {
  it("cuenta cada serie de trabajo una vez por cada músculo primario del ejercicio", () => {
    const exercises: CompletedExercise[] = [
      {
        exerciseId: "1", name: "Press banca", setsCompleted: 3, totalSets: 3,
        muscles: ["Chest", "Triceps"],
        sets: [
          { reps: 8, weight: 60, done: true },
          { reps: 8, weight: 60, done: true },
          { reps: 8, weight: 60, done: true },
        ],
      },
    ];
    expect(setsByMuscle(exercises)).toEqual({ Chest: 3, Triceps: 3 });
  });

  it("el calentamiento no cuenta como serie de trabajo", () => {
    const exercises: CompletedExercise[] = [
      {
        exerciseId: "1", name: "Sentadilla", setsCompleted: 2, totalSets: 2,
        muscles: ["Quads"],
        sets: [
          { reps: 10, weight: 40, done: true, type: "warmup" },
          { reps: 8,  weight: 80, done: true, type: "normal" },
        ],
      },
    ];
    expect(setsByMuscle(exercises)).toEqual({ Quads: 1 });
  });

  it("ejercicios sin músculo capturado (rutinas antiguas o manuales) no contribuyen", () => {
    const exercises: CompletedExercise[] = [
      { exerciseId: "1", name: "Ejercicio manual", setsCompleted: 3, totalSets: 3 },
    ];
    expect(setsByMuscle(exercises)).toEqual({});
  });

  it("series no marcadas como hechas no cuentan", () => {
    const exercises: CompletedExercise[] = [
      {
        exerciseId: "1", name: "Curl", setsCompleted: 0, totalSets: 1,
        muscles: ["Biceps"],
        sets: [{ reps: 10, weight: 15, done: false }],
      },
    ];
    expect(setsByMuscle(exercises)).toEqual({});
  });
});

describe("weeklySetsByMuscle", () => {
  it("agrega las series de trabajo de varias sesiones por músculo", () => {
    const mkSession = (id: string, muscles: string[], sets: number): WorkoutSession => ({
      id, routineName: "Rutina", date: "2026-08-17", durationMin: 45,
      completedExercises: [{
        exerciseId: "1", name: "Ej", setsCompleted: sets, totalSets: sets,
        muscles,
        sets: Array.from({ length: sets }, () => ({ reps: 8, weight: 60, done: true as const })),
      }],
    });
    const sessions: WorkoutSession[] = [
      mkSession("s1", ["Chest"], 3),
      mkSession("s2", ["Chest", "Triceps"], 2),
    ];
    expect(weeklySetsByMuscle(sessions)).toEqual({ Chest: 5, Triceps: 2 });
  });

  it("sin sesiones, devuelve objeto vacío", () => {
    expect(weeklySetsByMuscle(undefined)).toEqual({});
    expect(weeklySetsByMuscle([])).toEqual({});
  });
});
