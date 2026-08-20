import { afterEach, describe, expect, it, vi } from "vitest";
import { generateAIRoutine, type RoutineGenerationParams } from "./ai-provider";
import type { AIConfig } from "./ai-config";

// E21-16: rutinas IA largas — una rutina de varios días con 4-7 ejercicios
// cada uno genera bastante más JSON que una receta (ver el comentario junto
// a ROUTINE_MAX_TOKENS en ai-provider.ts) y puede rozar el límite de tokens
// del proveedor, cortando la respuesta a mitad de un array/objeto y
// rompiendo JSON.parse. Estas pruebas simulan la respuesta HTTP del
// proveedor (fetch global sustituido) para probar el parseo/validación
// real de generateAIRoutine() de punta a punta sin depender de una llamada
// de red de verdad — exactamente el mismo camino que un proveedor real,
// solo que el texto de respuesta lo controla la prueba.

const config: AIConfig = { provider: "gemini", apiKey: "test-key", model: "gemini-1.5-flash" };

function mockGeminiResponse(text: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE_PARAMS: RoutineGenerationParams = {
  goal: "muscle_gain",
  weightKg: 78,
  gymDaysCount: 6,
  splitTemplate: "push_pull_legs",
  experienceLevel: "intermediate",
  equipmentAccess: "full_gym",
  sessionMinutes: 60,
};

/** Genera un JSON de rutina "larga" de verdad: numDays días con
    exercisesPerDay ejercicios cada uno — el mismo orden de magnitud (6
    días × 6 ejercicios = 36) que dispara el límite alto de tokens en la
    app real. */
function longRoutineJSON(numDays: number, exercisesPerDay: number): string {
  const days = Array.from({ length: numDays }, (_, d) => ({
    label: `Día ${d + 1} · Grupo ${d + 1}`,
    muscleGroups: [`grupo-${d + 1}`],
    exercises: Array.from({ length: exercisesPerDay }, (_, e) => ({
      name: `Ejercicio ${d + 1}-${e + 1}`,
      exerciseId: `ai-${d + 1}-${e + 1}`,
      notes: "Controla la fase excéntrica",
      sets: [
        { reps: 10, weight: e === 0 ? null : 40 + e, rest: 60 },
        { reps: 8, weight: e === 0 ? null : 42 + e, rest: 75 },
      ],
    })),
  }));
  return JSON.stringify({ name: "Programa de fuerza 6 días", estimatedMinutes: 60, days });
}

describe("generateAIRoutine — rutinas largas (E21-16)", () => {
  it("parsea y valida una rutina de 6 días × 6 ejercicios sin perder ni un solo ejercicio", async () => {
    mockGeminiResponse(longRoutineJSON(6, 6));
    const routine = await generateAIRoutine(config, BASE_PARAMS);

    expect(routine.days).toHaveLength(6);
    for (const day of routine.days ?? []) {
      expect(day.exercises).toHaveLength(6);
    }
    // El fallback plano (routine.exercises) une TODOS los días — 6×6 = 36,
    // ni uno de menos por truncamiento silencioso.
    expect(routine.exercises).toHaveLength(36);
  });

  it("mapea sets/reps/peso/descanso de cada ejercicio tal cual venían, incluido peso corporal (null)", async () => {
    mockGeminiResponse(longRoutineJSON(2, 2));
    const routine = await generateAIRoutine(config, BASE_PARAMS);

    const firstExercise = routine.days![0].exercises[0];
    expect(firstExercise.sets[0]).toMatchObject({ reps: 10, weight: null, rest: 60 });
    expect(firstExercise.sets[1]).toMatchObject({ reps: 8, weight: null, rest: 75 });

    const secondExercise = routine.days![0].exercises[1];
    expect(secondExercise.sets[0].weight).toBe(41);
  });

  it("una respuesta truncada a mitad de JSON (límite de tokens agotado) da un error claro, no un crash silencioso", async () => {
    const full = longRoutineJSON(7, 7);
    // Simula justo lo que describe el comentario de ROUTINE_MAX_TOKENS: el
    // proveedor corta la respuesta a mitad de un array/objeto.
    const truncated = full.slice(0, Math.floor(full.length * 0.6));
    mockGeminiResponse(truncated);

    await expect(generateAIRoutine(config, BASE_PARAMS)).rejects.toThrow(
      "La IA devolvió una rutina incompleta o mal formada. Prueba con menos días de entrenamiento o inténtalo de nuevo.",
    );
  });

  it("una rutina sin campo days (proveedor que ignoró el formato) cae al fallback plano de exercises", async () => {
    mockGeminiResponse(JSON.stringify({
      name: "Rutina simple",
      estimatedMinutes: 45,
      exercises: [{ name: "Sentadilla", exerciseId: "ai-1", sets: [{ reps: 10, weight: 60, rest: 90 }] }],
    }));
    const routine = await generateAIRoutine(config, BASE_PARAMS);
    expect(routine.days).toBeUndefined();
    expect(routine.exercises).toHaveLength(1);
    expect(routine.exercises[0].name).toBe("Sentadilla");
  });
});
