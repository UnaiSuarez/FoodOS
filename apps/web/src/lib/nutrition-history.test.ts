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
import {
  adherenceFreshnessNote,
  describeEvaluableFraction,
  isNeutralAdherenceStatus,
  maskRangeStateForScope,
  reduceNutritionGoalsRangeState,
  resetLastGoodForScope,
  type ScopedRangeState,
} from "./nutrition-history";
import * as fs from "node:fs";
import * as path from "node:path";

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

// ─── Ronda de revisión: P1, P2, P3, P4, P5 (nutrition-history.ts) ──────────

describe("[revisión P1] reduceNutritionGoalsRangeState — el error conserva el último resultado bueno", () => {
  it("ready -> refetch (loading) -> error conserva el último goalsByDate válido, NUNCA un Map vacío", () => {
    const goodMap = new Map([["2026-09-01", remoteRow()]]);

    // 1. Primera carga correcta con objetivos.
    let step = reduceNutritionGoalsRangeState(new Map(), { type: "fetch-success", goalsByDate: goodMap });
    expect(step.next).toEqual({ status: "ready", goalsByDate: goodMap });

    // 2. Cambia el rango/fecha y empieza una recarga.
    step = reduceNutritionGoalsRangeState(step.lastGood, { type: "fetch-start" });
    expect(step.next).toEqual({ status: "loading" });

    // 3. La recarga falla.
    step = reduceNutritionGoalsRangeState(step.lastGood, { type: "fetch-error", error: "network down" });

    // El resultado queda en "error" CONSERVANDO el último goalsByDate válido
    // — el bug corregido devolvía aquí un Map vacío porque inspeccionaba el
    // `prev` de React (ya en "loading", sin datos) en vez de un valor que
    // sobreviviera esa transición.
    expect(step.next).toEqual({ status: "error", error: "network down", goalsByDate: goodMap });
    expect((step.next as { goalsByDate: Map<string, unknown> }).goalsByDate.size).toBe(1);
  });

  it("un error en la CARGA INICIAL (sin ready previo) conserva un Map vacío, no lanza ni inventa datos", () => {
    let step = reduceNutritionGoalsRangeState(new Map(), { type: "fetch-start" });
    step = reduceNutritionGoalsRangeState(step.lastGood, { type: "fetch-error", error: "timeout" });
    expect(step.next).toEqual({ status: "error", error: "timeout", goalsByDate: new Map() });
  });

  it("tras un error, una recarga posterior con éxito reemplaza el goalsByDate por el nuevo (no acumula el viejo)", () => {
    const oldMap = new Map([["2026-08-01", remoteRow({ kcal: 2000 })]]);
    let step = reduceNutritionGoalsRangeState(new Map(), { type: "fetch-success", goalsByDate: oldMap });
    step = reduceNutritionGoalsRangeState(step.lastGood, { type: "fetch-start" });
    step = reduceNutritionGoalsRangeState(step.lastGood, { type: "fetch-error", error: "network down" });
    const newMap = new Map([["2026-09-01", remoteRow({ kcal: 2400 })]]);
    step = reduceNutritionGoalsRangeState(step.lastGood, { type: "fetch-success", goalsByDate: newMap });
    expect(step.next).toEqual({ status: "ready", goalsByDate: newMap });
  });
});

describe("[revisión P2] adherenceFreshnessNote — loading y error son distinguibles, ready no tiene nota", () => {
  it("loading y error nunca comparten el mismo texto", () => {
    const loadingNote = adherenceFreshnessNote("loading");
    const errorNote = adherenceFreshnessNote("error");
    expect(loadingNote).not.toBeNull();
    expect(errorNote).not.toBeNull();
    expect(loadingNote).not.toBe(errorNote);
  });

  it("ready no muestra ninguna nota (las cifras ya son completas)", () => {
    expect(adherenceFreshnessNote("ready")).toBeNull();
  });
});

describe("[revisión P3] describeEvaluableFraction — cero días evaluables nunca produce una fracción /7 (ni ninguna otra)", () => {
  it("cero días evaluables -> '—', hasEvaluableDays:false (nunca '0/7')", () => {
    const result = describeEvaluableFraction(0, 0);
    expect(result).toEqual({ label: "—", hasEvaluableDays: false });
    expect(result.label).not.toMatch(/\/7/);
  });

  it("con días evaluables, el denominador es el conteo REAL, no un 7 fijo", () => {
    expect(describeEvaluableFraction(2, 3)).toEqual({ label: "2/3", hasEvaluableDays: true });
    expect(describeEvaluableFraction(0, 7)).toEqual({ label: "0/7", hasEvaluableDays: true }); // 0 hits pero SÍ 7 evaluables — válido, distinto de "0 evaluables"
  });
});

describe("[revisión P5] isNeutralAdherenceStatus — unlogged nunca se trata como 0%/fallo", () => {
  it("unknown_target y unlogged son neutros", () => {
    expect(isNeutralAdherenceStatus("unknown_target")).toBe(true);
    expect(isNeutralAdherenceStatus("unlogged")).toBe(true);
  });
  it("hit/partial/miss NO son neutros — solo esos muestran porcentajes evaluados", () => {
    expect(isNeutralAdherenceStatus("hit")).toBe(false);
    expect(isNeutralAdherenceStatus("partial")).toBe(false);
    expect(isNeutralAdherenceStatus("miss")).toBe(false);
  });
});

describe("[revisión P4] NutritionView — MacroWeekChart y MacroAdherencePanel comparten una única consulta", () => {
  // Este proyecto no tiene infraestructura de renderizado de React en los
  // tests (entorno vitest "node", sin jsdom/@testing-library — ver
  // vitest.config.ts) y añadirla queda fuera del alcance de esta corrección
  // puntual. La garantía verificable sin renderizar es ESTRUCTURAL: ninguno
  // de los dos paneles llama a useAdherenceWindow/useNutritionGoalsRangeState
  // por su cuenta (ambos reciben `adherence` ya resuelto por props), y el
  // único punto que sí llama al hook (NutritionTodayAdherence) lo hace una
  // sola vez y reparte el MISMO resultado a los dos — por semántica de
  // React, un valor pasado por prop nunca duplica la llamada al hook que lo
  // produjo. Este test falla si alguno de los dos paneles reintrodujera su
  // propia llamada al hook (la regresión concreta reportada).
  const source = fs.readFileSync(
    path.resolve(__dirname, "../components/dashboard/views/NutritionView.tsx"),
    "utf-8",
  );

  function bodyOf(fnName: string): string {
    const start = source.indexOf(`function ${fnName}(`);
    expect(start, `no se encontró function ${fnName}(`).toBeGreaterThan(-1);
    // Recorta hasta el cierre de la función siguiente ("\n}\n") — suficiente
    // para estas funciones concretas, todas definidas a nivel de módulo.
    const end = source.indexOf("\n}\n", start);
    return source.slice(start, end);
  }

  it("MacroWeekChart no llama a useAdherenceWindow ni a useNutritionGoalsRangeState", () => {
    const body = bodyOf("MacroWeekChart");
    expect(body).not.toMatch(/useAdherenceWindow\(/);
    expect(body).not.toMatch(/useNutritionGoalsRangeState\(/);
  });

  it("MacroAdherencePanel no llama a useAdherenceWindow ni a useNutritionGoalsRangeState", () => {
    const body = bodyOf("MacroAdherencePanel");
    expect(body).not.toMatch(/useAdherenceWindow\(/);
    expect(body).not.toMatch(/useNutritionGoalsRangeState\(/);
  });

  it("NutritionTodayAdherence llama a useAdherenceWindow EXACTAMENTE una vez y pasa el mismo resultado a ambos paneles", () => {
    const body = bodyOf("NutritionTodayAdherence");
    const hookCalls = body.match(/useAdherenceWindow\(/g) ?? [];
    expect(hookCalls).toHaveLength(1);
    expect(body).toMatch(/<MacroWeekChart adherence=\{adherence\}/);
    expect(body).toMatch(/<MacroAdherencePanel adherence=\{adherence\}/);
  });
});

// ─── Segunda ronda de revisión: P1 (aislamiento por cuenta), P2 (HomeView) ──

describe("[revisión 2, P1] resetLastGoodForScope — aislamiento del histórico por cuenta", () => {
  it("A ready -> cambio DIRECTO a B (misma fecha/ventana) -> B loading/error/success nunca muestra el mapa de A", () => {
    const aMap = new Map([["2026-09-01", remoteRow({ kcal: 1800 })]]);
    // A está "ready" con su propio mapa.
    let scoped = { scopeKey: "user-A", goalsByDate: aMap };

    // Supabase cambia DIRECTAMENTE de sesión A->B (p.ej. sincronización de
    // auth entre pestañas) — misma fecha/ventana, solo cambia scopeKey.
    scoped = resetLastGoodForScope(scoped, "user-B");
    expect(scoped.scopeKey).toBe("user-B");
    expect(scoped.goalsByDate.size).toBe(0); // el mapa de A ya no está disponible

    // B: loading — nunca lleva datos de A (el estado "loading" no tiene
    // campo goalsByDate en absoluto).
    let step = reduceNutritionGoalsRangeState(scoped.goalsByDate, { type: "fetch-start" });
    expect(step.next).toEqual({ status: "loading" });

    // B: si la consulta falla, el fallback tampoco puede ser el mapa de A.
    let failed = reduceNutritionGoalsRangeState(step.lastGood, { type: "fetch-error", error: "network down" });
    expect(failed.next).toEqual({ status: "error", error: "network down", goalsByDate: new Map() });
    expect((failed.next as { goalsByDate: Map<string, unknown> }).goalsByDate.has("2026-09-01")).toBe(false);

    // B: si la consulta tiene éxito, es con SU propio mapa — nunca el de A,
    // aunque comparta la misma clave de fecha.
    const bMap = new Map([["2026-09-01", remoteRow({ kcal: 2600 })]]);
    const succeeded = reduceNutritionGoalsRangeState(failed.lastGood, { type: "fetch-success", goalsByDate: bMap });
    expect(succeeded.next).toEqual({ status: "ready", goalsByDate: bMap });
    const readyState = succeeded.next as { goalsByDate: Map<string, SanitizedRemoteGoalRow> };
    expect(readyState.goalsByDate.get("2026-09-01")?.kcal).toBe(2600); // nunca 1800 (el de A)
  });

  it("mismo scopeKey no resetea nada — devuelve la MISMA referencia (conserva el mapa entre recargas de la misma cuenta)", () => {
    const map = new Map([["2026-09-01", remoteRow()]]);
    const current = { scopeKey: "user-A", goalsByDate: map };
    const result = resetLastGoodForScope(current, "user-A");
    expect(result).toBe(current);
  });

  it("de local ('local', sin sesión) a una cuenta real también resetea — un guest no puede heredar ni contaminar el histórico de la cuenta", () => {
    const guestMap = new Map([["2026-09-01", remoteRow({ kcal: 1500 })]]);
    const result = resetLastGoodForScope({ scopeKey: "local", goalsByDate: guestMap }, "user-A");
    expect(result.scopeKey).toBe("user-A");
    expect(result.goalsByDate.size).toBe(0);
  });
});

describe("[revisión 2, P1 — estructural] useNutritionGoalsRangeState depara scopeKey como dependencia real del efecto", () => {
  // No hay infraestructura de renderizado de React en este proyecto (ver el
  // bloque [revisión P4] más abajo) — se verifica que el array de
  // dependencias del useEffect incluye `scopeKey` literalmente, que es lo
  // que garantiza que un cambio de cuenta (sin cambiar fecha/ventana)
  // vuelve a disparar el efecto.
  const source = fs.readFileSync(path.resolve(__dirname, "./nutrition-history.ts"), "utf-8");

  it("el useEffect de useNutritionGoalsRangeState depende de [scopeKey, referenceDate, windowDays]", () => {
    expect(source).toMatch(/\}, \[scopeKey, referenceDate, windowDays\]\);/);
  });

  it("useNutritionGoalsRangeState resetea lastGoodRef vía resetLastGoodForScope dentro del efecto, antes de cualquier fetch", () => {
    const start = source.indexOf("export function useNutritionGoalsRangeState(");
    const effectStart = source.indexOf("useEffect(() => {", start);
    const resetCall = source.indexOf("resetLastGoodForScope(lastGoodRef.current, scopeKey)", effectStart);
    const fetchCall = source.indexOf("getNutritionGoalsRangeWithStatus(", effectStart);
    expect(resetCall).toBeGreaterThan(effectStart);
    expect(resetCall).toBeLessThan(fetchCall);
  });

  it("[revisión 3] el valor DEVUELTO por el hook pasa por maskRangeStateForScope — el aislamiento no depende solo del efecto", () => {
    // Corrección del fallo de timing: modificar el ref dentro del efecto no
    // protege el primer render tras un cambio de scopeKey, porque ese
    // render lee `useState`, no el ref. La corrección real está en el
    // `return` del hook, no en el efecto — este test falla si alguien
    // revierte a `return scopedRangeState.value` (o similar) sin pasar por
    // la máscara.
    const start = source.indexOf("export function useNutritionGoalsRangeState(");
    const end = source.indexOf("\n}\n", start);
    const body = source.slice(start, end);
    expect(body).toMatch(/return maskRangeStateForScope\(scopedRangeState, scopeKey\);/);
  });
});

describe("[revisión 3, P1] enmascarado por ámbito EN EL RENDER — el primer render tras un cambio de cuenta nunca expone el estado anterior", () => {
  it("estado interno ready(A) + ámbito solicitado B => el valor visible es 'loading', SIN que haya corrido ningún efecto", () => {
    // Reproduce exactamente el escenario del fallo reportado: React ya
    // renderiza con scopeKey="user-B" (la prop/deps cambiaron), pero
    // useEffect todavía no se ha ejecutado — el estado interno de
    // useState sigue siendo el `ready` de A. maskRangeStateForScope es lo
    // que se evalúa en ESE render exacto, antes de cualquier efecto.
    const mapA = new Map([["2026-09-01", remoteRow({ kcal: 1800 })]]);
    const internalStateStillA: ScopedRangeState = {
      scopeKey: "user-A",
      value: { status: "ready", goalsByDate: mapA },
    };
    const visibleForB = maskRangeStateForScope(internalStateStillA, "user-B");
    expect(visibleForB).toEqual({ status: "loading" });
  });

  it("B error SIN resultado previo propio => mapa vacío, nunca el mapa de A (secuencia completa: reset -> fetch-start -> fetch-error -> máscara)", () => {
    const mapA = new Map([["2026-09-01", remoteRow({ kcal: 1800 })]]);
    let lastGood = { scopeKey: "user-A", goalsByDate: mapA };
    let internal: ScopedRangeState = { scopeKey: "user-A", value: { status: "ready", goalsByDate: mapA } };

    // Render transitorio (justo tras el cambio de cuenta, antes del efecto).
    expect(maskRangeStateForScope(internal, "user-B")).toEqual({ status: "loading" });

    // El efecto de B corre: resetea el fallback interno de A...
    lastGood = resetLastGoodForScope(lastGood, "user-B");
    // ...arranca en loading (mismo scopeKey ya)...
    const started = reduceNutritionGoalsRangeState(lastGood.goalsByDate, { type: "fetch-start" });
    internal = { scopeKey: "user-B", value: started.next };
    expect(maskRangeStateForScope(internal, "user-B")).toEqual({ status: "loading" });

    // ...y la consulta de B falla, sin ningún resultado previo PROPIO de B.
    const failed = reduceNutritionGoalsRangeState(lastGood.goalsByDate, { type: "fetch-error", error: "network down" });
    internal = { scopeKey: "user-B", value: failed.next };
    const visible = maskRangeStateForScope(internal, "user-B");
    expect(visible).toEqual({ status: "error", error: "network down", goalsByDate: new Map() });
    expect((visible as { goalsByDate: Map<string, unknown> }).goalsByDate.has("2026-09-01")).toBe(false); // nunca el 1800 de A
  });

  it("un estado interno obsoleto etiquetado como 'user-A' queda enmascarado al pedir 'user-B', y no borra el ready de B ya establecido", () => {
    // IMPORTANTE sobre lo que este test prueba y lo que NO prueba: es un
    // test puro sobre maskRangeStateForScope, no un test end-to-end del
    // ciclo de efectos de React. No ejecuta useEffect, no simula una
    // promesa en vuelo ni su cleanup — solo construye a mano un
    // ScopedRangeState ya etiquetado "user-A" (como si, hipotéticamente,
    // hubiera quedado ahí) y comprueba que la máscara lo descarta al pedir
    // "user-B". La protección real contra que una respuesta tardía de A
    // LLEGUE A ESCRIBIR ese estado es el cleanup `cancelled` dentro del
    // useEffect del hook (no cubierto por este test, que no renderiza
    // React) — lo que este test aporta es la garantía complementaria: aun
    // si algo dejara un estado obsoleto ahí, la máscara en el render
    // impide que se muestre.
    const mapB = new Map([["2026-09-01", remoteRow({ kcal: 2600 })]]);
    const stateAfterBReady: ScopedRangeState = { scopeKey: "user-B", value: { status: "ready", goalsByDate: mapB } };
    expect(maskRangeStateForScope(stateAfterBReady, "user-B")).toEqual({ status: "ready", goalsByDate: mapB });

    const staleInternalStateFromA: ScopedRangeState = {
      scopeKey: "user-A",
      value: { status: "ready", goalsByDate: new Map([["2026-09-01", remoteRow({ kcal: 9999 })]]) },
    };
    expect(maskRangeStateForScope(staleInternalStateFromA, "user-B")).toEqual({ status: "loading" });
    // Y el B ya establecido, pedido de nuevo, sigue intacto.
    expect(maskRangeStateForScope(stateAfterBReady, "user-B")).toEqual({ status: "ready", goalsByDate: mapB });
  });

  it("misma cuenta A durante una recarga (refetch) SÍ puede conservar y mostrar su último resultado bueno", () => {
    const mapA = new Map([["2026-09-01", remoteRow({ kcal: 1800 })]]);
    const stateReadyA: ScopedRangeState = { scopeKey: "user-A", value: { status: "ready", goalsByDate: mapA } };
    // Pedir la máscara para el MISMO scopeKey nunca oculta nada — devuelve
    // exactamente el mismo `value` (misma referencia).
    expect(maskRangeStateForScope(stateReadyA, "user-A")).toBe(stateReadyA.value);
  });
});

describe("[revisión 2, P2] HomeView — el error es visible, no solo en el atributo title", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../components/dashboard/views/HomeView.tsx"),
    "utf-8",
  );

  it("renderiza adherenceFreshness como contenido VISIBLE de un elemento, no solo dentro de title=", () => {
    // Antes de esta corrección, adherenceFreshness solo aparecía dentro de
    // un `title={...}` — invisible en móvil (sin hover). Ahora debe
    // aparecer también como children de un elemento (fuera de un atributo).
    expect(source).toMatch(/>\s*\{adherenceFreshness\}\s*<\/p>/);
  });

  it("usa role=\"alert\" específicamente cuando remoteStatus es \"error\" (no en loading)", () => {
    expect(source).toMatch(/role=\{adherence\.remoteStatus === "error" \? "alert" : "status"\}/);
  });

  it("adherenceFreshnessNote (compartida) sigue distinguiendo loading de error con textos distintos", () => {
    expect(adherenceFreshnessNote("loading")).not.toBe(adherenceFreshnessNote("error"));
    expect(adherenceFreshnessNote("ready")).toBeNull();
  });
});
