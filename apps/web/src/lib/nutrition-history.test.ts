// PR A — coherencia histórica nutricional: tests del ledger local
// (sanitización/retención), el resolver puro y la clasificación de
// adherencia. Ver el diseño aprobado para el detalle de cada regla; aquí
// solo se listan los casos obligatorios y las correcciones de las rondas
// de revisión.
import { describe, expect, it } from "vitest";
import type { NutritionGoalLedgerEntry, NutritionGoalsLedger, SanitizedRemoteGoalRow } from "@foodos/types";
import {
  classifyDayAdherence,
  getAdherenceStats,
  getAdherenceStreakFromStatuses,
  resolveHistoricalGoal,
  sanitizeNutritionGoalsLedger,
  sanitizeRemoteGoalRow,
} from "./nutrition";
import { addDaysToDateKey, isValidCalendarDateKey } from "./utils";

function entry(overrides: Partial<NutritionGoalLedgerEntry> = {}): NutritionGoalLedgerEntry {
  return {
    kcal: 2200, protein: 150, carbs: 225, fat: 70,
    mode: "recomp",
    calculationVersion: "nutrition-v3.1",
    recordedAt: "2026-09-10T08:00:00.000Z",
    ...overrides,
  };
}

function remoteRow(overrides: Partial<SanitizedRemoteGoalRow> = {}): SanitizedRemoteGoalRow {
  return { kcal: 2200, protein: 150, carbs: 225, fat: 70, mode: "recomp", calculationVersion: "nutrition-v3.1", ...overrides };
}

// ─── resolveHistoricalGoal ──────────────────────────────────────────────────

describe("resolveHistoricalGoal", () => {
  it("1) cambiar el objetivo ACTUAL no modifica el resultado de un día pasado con fila remota — el resolver ni siquiera recibe el perfil actual", () => {
    const remote = new Map([["2026-09-05", remoteRow({ kcal: 1900, protein: 140 })]]);
    // No hay forma de "cambiar el objetivo actual" en la firma de esta
    // función — es la prueba misma de que no puede recolorear el pasado:
    // solo puede leer lo que hay en remoteByDate/localHistory para esa fecha.
    const result = resolveHistoricalGoal("2026-09-05", "2026-09-10", remote, {});
    expect(result).toEqual({ status: "known", targets: { kcal: 1900, protein: 140, carbs: 225, fat: 70 }, mode: "recomp", source: "remote", calculationVersion: "nutrition-v3.1" });
  });

  it("3) un día sin objetivo histórico (ni remoto ni local) es 'unknown', nunca se rellena con nada", () => {
    const result = resolveHistoricalGoal("2026-09-05", "2026-09-10", new Map(), {});
    expect(result).toEqual({ status: "unknown", targets: null, mode: null, source: null, calculationVersion: null });
  });

  it("4) conflicto local/remoto en el PASADO: remoto gana siempre que exista fila, sin importar el local", () => {
    const remote = new Map([["2026-09-05", remoteRow({ kcal: 2000 })]]);
    const local: NutritionGoalsLedger = { "2026-09-05": entry({ kcal: 2600 }) };
    const result = resolveHistoricalGoal("2026-09-05", "2026-09-10", remote, local);
    expect(result.source).toBe("remote");
    expect(result.targets?.kcal).toBe(2000);
  });

  it("5) recomp: dos fechas consecutivas (una gym, una descanso) conservan sus propios números aunque el perfil cambie después — sin carry-forward entre ellas", () => {
    const remote = new Map([
      ["2026-09-01", remoteRow({ kcal: 2500, mode: "recomp" })], // lunes, gym
      ["2026-09-02", remoteRow({ kcal: 2100, mode: "recomp" })], // martes, descanso
    ]);
    const gymDay = resolveHistoricalGoal("2026-09-01", "2026-09-10", remote, {});
    const restDay = resolveHistoricalGoal("2026-09-02", "2026-09-10", remote, {});
    expect(gymDay.targets?.kcal).toBe(2500);
    expect(restDay.targets?.kcal).toBe(2100);
    expect(gymDay.targets?.kcal).not.toBe(restDay.targets?.kcal);
  });

  it("6) modo local/offline (sin ninguna fila remota) conserva su historial vía el ledger local", () => {
    const local: NutritionGoalsLedger = { "2026-09-05": entry({ kcal: 1800 }) };
    const result = resolveHistoricalGoal("2026-09-05", "2026-09-10", new Map(), local);
    expect(result).toEqual({ status: "known", targets: { kcal: 1800, protein: 150, carbs: 225, fat: 70 }, mode: "recomp", source: "local", calculationVersion: "nutrition-v3.1" });
  });

  it("9) fecha futura: lanza — el resolver histórico no incluye proyecciones (usar weeklyCycle/calcDailyTargets aparte)", () => {
    expect(() => resolveHistoricalGoal("2026-09-15", "2026-09-10", new Map(), {})).toThrow(/futura/);
  });

  it("10) es puro: no muta remoteByDate ni localHistory al resolver", () => {
    const remote = new Map([["2026-09-05", remoteRow()]]);
    const local: NutritionGoalsLedger = { "2026-09-04": entry() };
    const remoteSnapshot = new Map(remote);
    const localSnapshot = structuredClone(local);
    resolveHistoricalGoal("2026-09-05", "2026-09-10", remote, local);
    expect(remote).toEqual(remoteSnapshot);
    expect(local).toEqual(localSnapshot);
  });

  describe("HOY: prioridad distinta del pasado (ronda de revisión — no 'remoto siempre gana')", () => {
    it("local difiere del remoto para HOY → gana el local, sin consultar ninguna señal de sincronización", () => {
      const remote = new Map([["2026-09-10", remoteRow({ kcal: 2200 })]]); // valor anterior, aún no sobrescrito
      const local: NutritionGoalsLedger = { "2026-09-10": entry({ kcal: 2400 }) }; // recién calculado
      const result = resolveHistoricalGoal("2026-09-10", "2026-09-10", remote, local);
      expect(result).toEqual({ status: "known", targets: { kcal: 2400, protein: 150, carbs: 225, fat: 70 }, mode: "recomp", source: "local", calculationVersion: "nutrition-v3.1" });
    });

    it("local y remoto coinciden en TODO (incluido el modo) para HOY → gana remoto (sin preferencia forzada, ver ronda 3 punto 1)", () => {
      const remote = new Map([["2026-09-10", remoteRow()]]);
      const local: NutritionGoalsLedger = { "2026-09-10": entry() };
      const result = resolveHistoricalGoal("2026-09-10", "2026-09-10", remote, local);
      expect(result.source).toBe("remote");
    });

    it("[ronda 3, punto 4] mismos macros pero MODO distinto para HOY → SÍ se considera divergente, el local gana", () => {
      const remote = new Map([["2026-09-10", remoteRow({ mode: "maintain" })]]);
      const local: NutritionGoalsLedger = { "2026-09-10": entry({ mode: "recomp" }) }; // mismos macros, modo distinto
      const result = resolveHistoricalGoal("2026-09-10", "2026-09-10", remote, local);
      expect(result.source).toBe("local");
      expect(result.mode).toBe("recomp");
    });

    it("[ronda 3, punto 1] un gasto/agua pendiente sin relación no hace ganar a un objetivo local desactualizado — la función no recibe ninguna señal de outbox, así que no hay forma de que la afecte", () => {
      // Mismo valor en ambos lados: no hay divergencia real que forzar,
      // pase lo que pase con cualquier mutación ajena en curso.
      const remote = new Map([["2026-09-10", remoteRow({ kcal: 2200 })]]);
      const local: NutritionGoalsLedger = { "2026-09-10": entry({ kcal: 2200 }) };
      const result = resolveHistoricalGoal("2026-09-10", "2026-09-10", remote, local);
      expect(result.source).toBe("remote");
    });

    it("sin remoto todavía para HOY, con local → usa el local", () => {
      const local: NutritionGoalsLedger = { "2026-09-10": entry({ kcal: 2300 }) };
      const result = resolveHistoricalGoal("2026-09-10", "2026-09-10", new Map(), local);
      expect(result.source).toBe("local");
      expect(result.targets?.kcal).toBe(2300);
    });
  });
});

// ─── classifyDayAdherence / getAdherenceStats / getAdherenceStreakFromStatuses ──

describe("classifyDayAdherence", () => {
  it("2) un día que cumplió su objetivo histórico sigue 'hit' sin importar el perfil actual (la función no recibe perfil, solo el resultado ya resuelto)", () => {
    const resolved = resolveHistoricalGoal("2026-09-05", "2026-09-10", new Map([["2026-09-05", remoteRow({ kcal: 2000, protein: 150 })]]), {});
    const status = classifyDayAdherence(resolved, { kcal: 1900, protein: 140, carbs: 200, fat: 60 });
    expect(status).toBe("hit");
  });

  it("3) sin objetivo histórico → 'unknown_target', nunca 'miss'", () => {
    const resolved = resolveHistoricalGoal("2026-09-05", "2026-09-10", new Map(), {});
    expect(classifyDayAdherence(resolved, { kcal: 0, protein: 0, carbs: 0, fat: 0 })).toBe("unknown_target");
    expect(classifyDayAdherence(resolved, null)).toBe("unknown_target");
  });

  it("[ronda 3, punto 6] objetivo conocido sin ingesta → 'unlogged', nunca 'miss'", () => {
    const resolved = resolveHistoricalGoal("2026-09-05", "2026-09-10", new Map([["2026-09-05", remoteRow()]]), {});
    expect(classifyDayAdherence(resolved, null)).toBe("unlogged");
  });

  it("umbrales sin cambios respecto a la implementación previa: proteína ≥80%, kcal entre 80–115%", () => {
    const resolved = resolveHistoricalGoal("2026-09-05", "2026-09-10", new Map([["2026-09-05", remoteRow({ kcal: 2000, protein: 150 })]]), {});
    expect(classifyDayAdherence(resolved, { kcal: 2000, protein: 120, carbs: 0, fat: 0 })).toBe("hit"); // 120/150=0.8 exacto
    expect(classifyDayAdherence(resolved, { kcal: 2300, protein: 150, carbs: 0, fat: 0 })).toBe("hit"); // 2300/2000=1.15 exacto
    expect(classifyDayAdherence(resolved, { kcal: 2301, protein: 150, carbs: 0, fat: 0 })).toBe("partial"); // kcal se pasa, prot ok
    expect(classifyDayAdherence(resolved, { kcal: 1000, protein: 10, carbs: 0, fat: 0 })).toBe("miss");
  });
});

describe("8) getAdherenceStats / getAdherenceStreakFromStatuses — porcentaje y racha (tests separados, ronda 3 punto 4)", () => {
  it("getAdherenceStats excluye 'unknown_target' Y 'unlogged' del numerador Y del denominador", () => {
    const stats = getAdherenceStats(["hit", "hit", "miss", "unlogged", "unlogged", "unknown_target", "unknown_target"]);
    expect(stats).toEqual({ hitDays: 2, evaluableDays: 3, totalDays: 7, pct: 2 / 3 });
  });

  it("getAdherenceStats devuelve pct=null (nunca un falso 0%) cuando no hay ningún día evaluable", () => {
    const stats = getAdherenceStats(["unknown_target", "unlogged", "unknown_target"]);
    expect(stats.pct).toBeNull();
    expect(stats.evaluableDays).toBe(0);
  });

  it("getAdherenceStreakFromStatuses corta con 'unknown_target' — no se puede saltar una semana sin objetivos y presentar una racha continua", () => {
    expect(getAdherenceStreakFromStatuses(["hit", "unknown_target", "hit", "hit"])).toBe(2);
  });

  it("getAdherenceStreakFromStatuses corta con 'unlogged' igual que con 'miss' — ninguno es fracaso, pero ambos cortan la continuidad verificable", () => {
    expect(getAdherenceStreakFromStatuses(["hit", "hit", "unlogged", "hit"])).toBe(1);
    expect(getAdherenceStreakFromStatuses(["hit", "hit", "miss", "hit"])).toBe(1);
  });

  it("racha de 0 cuando el día más reciente no es 'hit'", () => {
    expect(getAdherenceStreakFromStatuses(["hit", "hit", "partial"])).toBe(0);
  });
});

// ─── sanitizeNutritionGoalsLedger ───────────────────────────────────────────

describe("sanitizeNutritionGoalsLedger", () => {
  it("7) nunca añade la entrada de hoy — solo sanea/retiene lo que ya existía (contrato de pureza)", () => {
    const raw = { "2026-09-01": entry() };
    const result = sanitizeNutritionGoalsLedger(raw, "2026-09-10");
    expect(Object.keys(result)).toEqual(["2026-09-01"]);
    expect(result["2026-09-10"]).toBeUndefined();
  });

  it("descarta fechas con formato inválido y fechas de calendario imposibles (no una regex simple: '2026-02-30' rueda en silencio a 03-02)", () => {
    const raw = {
      "2026-02-30": entry(), // no existe
      "not-a-date": entry(),
      "2026-9-1": entry(), // sin ceros — inválido para este contrato estricto
      "2026-09-01": entry(),
    };
    const result = sanitizeNutritionGoalsLedger(raw, "2026-09-10");
    expect(Object.keys(result)).toEqual(["2026-09-01"]);
    expect(isValidCalendarDateKey("2026-02-30")).toBe(false);
    expect(isValidCalendarDateKey("2026-09-01")).toBe(true);
  });

  it("descarta filas con números no finitos, negativos o fuera de rango razonable", () => {
    const raw = {
      "2026-09-01": entry({ kcal: Number.NaN }),
      "2026-09-02": entry({ kcal: -100 }),
      "2026-09-03": entry({ kcal: 999999 }),
      "2026-09-04": entry({ kcal: Infinity }),
      "2026-09-05": entry(), // válida
    };
    const result = sanitizeNutritionGoalsLedger(raw, "2026-09-10");
    expect(Object.keys(result)).toEqual(["2026-09-05"]);
  });

  it("un 'mode' no reconocido degrada a null — NUNCA se reetiqueta como 'recomp' u otro valor inventado", () => {
    const raw = { "2026-09-01": { ...entry(), mode: "bulking_agresivo" } };
    const result = sanitizeNutritionGoalsLedger(raw, "2026-09-10");
    expect(result["2026-09-01"].mode).toBeNull();
    // los números siguen siendo válidos y usables — no se descarta la fila entera por el modo
    expect(result["2026-09-01"].kcal).toBe(2200);
  });

  it("un 'recordedAt' no parseable degrada a null sin invalidar la fila (metadato, no el número)", () => {
    const raw = { "2026-09-01": { ...entry(), recordedAt: "no-es-una-fecha" } };
    const result = sanitizeNutritionGoalsLedger(raw, "2026-09-10");
    expect(result["2026-09-01"].recordedAt).toBeNull();
    expect(result["2026-09-01"].kcal).toBe(2200);
  });

  it("una 'calculationVersion' no-string o demasiado larga degrada a null sin invalidar la fila", () => {
    const raw = { "2026-09-01": { ...entry(), calculationVersion: "x".repeat(200) } };
    const result = sanitizeNutritionGoalsLedger(raw, "2026-09-10");
    expect(result["2026-09-01"].calculationVersion).toBeNull();
  });

  it("8) retención exacta: [hoy-59, hoy] inclusive — ni un día menos, ni uno más", () => {
    const raw = {
      "2026-07-13": entry(), // hoy(2026-09-10) - 59 días exactos → dentro
      "2026-07-12": entry(), // un día antes del límite → fuera
      "2026-09-10": entry(), // hoy → dentro
      "2026-09-11": entry(), // futuro → fuera (nunca se acepta una entrada futura del ledger)
    };
    const result = sanitizeNutritionGoalsLedger(raw, "2026-09-10");
    expect(Object.keys(result).sort()).toEqual(["2026-07-13", "2026-09-10"]);
  });

  it("8) la retención usa SIEMPRE el reloj real recibido explícitamente — simular otra fecha (debugDate) no debe poder borrar historial real fuera de esa ventana simulada", () => {
    // Si alguien pasara por error debugDate="2020-01-01" como `realTodayKey`,
    // esto SÍ borraría el historial de 2026 — la responsabilidad de pasar
    // SIEMPRE todayPlus(0) (nunca debugDate) es de quien llama
    // (normalizeState), documentado explícitamente. Este test fija el
    // contrato: con el reloj real correcto, nada de 2026 desaparece.
    const raw = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [addDaysToDateKey("2026-08-12", i), entry()])
    );
    const result = sanitizeNutritionGoalsLedger(raw, "2026-09-10");
    expect(Object.keys(result)).toHaveLength(30);
  });

  it("raw no-objeto (undefined, array, null) devuelve un ledger vacío sin lanzar", () => {
    expect(sanitizeNutritionGoalsLedger(undefined, "2026-09-10")).toEqual({});
    expect(sanitizeNutritionGoalsLedger(null, "2026-09-10")).toEqual({});
    expect(sanitizeNutritionGoalsLedger([{ date: "2026-09-01" }], "2026-09-10")).toEqual({});
  });
});

// ─── sanitizeRemoteGoalRow ───────────────────────────────────────────────────

describe("sanitizeRemoteGoalRow", () => {
  it("acepta una fila válida y conserva sus números tal cual", () => {
    const result = sanitizeRemoteGoalRow({
      goal_date: "2026-09-01", kcal_target: 2200, protein_target_g: 150, carbs_target_g: 225, fat_target_g: 70,
      mode: "recomp", calculation_version: "nutrition-v1",
    });
    expect(result).toEqual({ goalDate: "2026-09-01", kcal: 2200, protein: 150, carbs: 225, fat: 70, mode: "recomp", calculationVersion: "nutrition-v1" });
  });

  it("[ronda 3, punto 7] una versión 'legacy' (nutrition-v1 por defecto, nunca actualizada) NO invalida la fila — sus números se usan tal cual, la versión queda como metadato no fiable", () => {
    const result = sanitizeRemoteGoalRow({
      goal_date: "2026-06-01", kcal_target: 2100, protein_target_g: 140, carbs_target_g: 200, fat_target_g: 65,
      mode: "recomp", calculation_version: "nutrition-v1", // default heredado, probablemente no refleja el motor real que corrió ese día
    });
    expect(result?.kcal).toBe(2100); // el número se usa igual
    expect(result?.calculationVersion).toBe("nutrition-v1"); // se conserva, no se "corrige" ni se adivina
  });

  it("descarta la fila si la fecha no es válida", () => {
    const result = sanitizeRemoteGoalRow({
      goal_date: "2026-02-30", kcal_target: 2200, protein_target_g: 150, carbs_target_g: 225, fat_target_g: 70,
      mode: "recomp", calculation_version: "nutrition-v1",
    });
    expect(result).toBeNull();
  });

  it("descarta la fila si algún macro no es un número finito no-negativo", () => {
    const result = sanitizeRemoteGoalRow({
      goal_date: "2026-09-01", kcal_target: "no-numero", protein_target_g: 150, carbs_target_g: 225, fat_target_g: 70,
      mode: "recomp", calculation_version: "nutrition-v1",
    });
    expect(result).toBeNull();
  });

  it("mode desconocido degrada a null sin descartar la fila", () => {
    const result = sanitizeRemoteGoalRow({
      goal_date: "2026-09-01", kcal_target: 2200, protein_target_g: 150, carbs_target_g: 225, fat_target_g: 70,
      mode: "algo_raro", calculation_version: "nutrition-v1",
    });
    expect(result?.mode).toBeNull();
    expect(result?.kcal).toBe(2200);
  });
});
