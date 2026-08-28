import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FoodOSState } from "@foodos/types";
import {
  deleteIfMatches,
  discard,
  discardParkedWater,
  discardWaterPending,
  envelopeKey,
  getTabClientId,
  hasPending,
  parkIfPending,
  parkWaterIfPending,
  purgeExpiredParked,
  purgeExpiredParkedWater,
  readEnvelope,
  readWaterPending,
  recordMutation,
  resetTabClientIdCacheForTests,
  resolveInvoluntaryLoss,
  restoreParked,
  restoreParkedWater,
  writeEnvelope,
  writeWaterPending,
  PARKED_TTL_MS,
} from "./outbox";

function state(overrides: Partial<FoodOSState> = {}): FoodOSState {
  return {
    inventory: [], cart: [], expenses: [], incomeSources: [], recurringExpenses: [],
    savingsGoalPct: 20, savingsGoal: null, foodLog: [], waterLog: {}, weightLog: [],
    customRecipes: [], savedRecipeIds: [], profile: null,
    nutrition: { kcal: 2200, protein: 150, carbs: 225, fat: 70, mode: "recomp" },
    weeklyBudget: 70, bankSynced: false, mascotId: "zana", recipeTag: "todos",
    macroPreference: "balanced",
    settings: { expiryWarnDays: 3, waterGoalMl: 2500, dinnerSuggestionHour: 18, budgetWarnPct: 80, defaultStore: "Mercadona", lowStockThresholds: { g: 200, ml: 300, L: 0.5, kg: 0.3, ud: 2 }, extraExpenseCategories: [], stepsGoal: 8000 },
    dismissedSuggestions: [], mealPlan: {}, plannerQuickMeals: [], debugDate: null,
    categoryBudgets: {}, routines: [], workoutLog: [], stepsLog: {},
    pendingAdjustmentProposal: null, lastAdjustmentDecisionAt: null,
    ...overrides,
  } as FoodOSState;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetTabClientIdCacheForTests();
  vi.useRealTimers();
});

describe("outbox — envelope atómico (bloqueante §1 de la revisión)", () => {
  it("readEnvelope() devuelve null si no existe — LOCAL_KEY sin propietario NUNCA se copia automáticamente a la outbox de un usuario", () => {
    localStorage.setItem("foodos-appweb-state-v1", JSON.stringify(state({ weeklyBudget: 999 })));
    expect(readEnvelope("user-1")).toBeNull();
  });

  it("recordMutation() escribe estado+pendiente en UNA sola llamada a localStorage.setItem (imposible que queden desacoplados por un crash a medias)", () => {
    const spy = vi.spyOn(localStorage, "setItem");
    recordMutation("user-1", state({ weeklyBudget: 42 }), "tab-1");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("el envelope leído de vuelta contiene el mismo estado y un mutationId nuevo", () => {
    const result = recordMutation("user-1", state({ weeklyBudget: 42 }), "tab-1");
    expect(result.ok).toBe(true);
    const envelope = readEnvelope("user-1");
    expect(envelope?.state.weeklyBudget).toBe(42);
    expect(envelope?.pending?.mutationId).toBeTruthy();
    expect(envelope?.pending?.clientId).toBe("tab-1");
  });

  it("revision es monótona: cada recordMutation() sucesivo del mismo usuario incrementa sobre la anterior", () => {
    const first = recordMutation("user-1", state({ weeklyBudget: 1 }), "tab-1");
    const second = recordMutation("user-1", state({ weeklyBudget: 2 }), "tab-1");
    expect(first.ok && second.ok).toBe(true);
    expect((second as { ok: true; envelope: { pending: { revision: number } } }).envelope.pending.revision)
      .toBeGreaterThan((first as { ok: true; envelope: { pending: { revision: number } } }).envelope.pending.revision);
  });

  it("compare-and-delete (deleteIfMatches) solo borra si mutationId coincide exactamente — una mutación más reciente sobrevive", () => {
    const first = recordMutation("user-1", state({ weeklyBudget: 1 }), "tab-1");
    const firstMutationId = (first as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId;
    // Aparece una mutación MÁS RECIENTE antes de que la primera confirme.
    const second = recordMutation("user-1", state({ weeklyBudget: 2 }), "tab-1");
    const secondMutationId = (second as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId;

    // El push de la primera (obsoleta) termina bien — su compare-and-delete
    // NO debe borrar la segunda.
    expect(deleteIfMatches("user-1", firstMutationId)).toBe(false);
    expect(hasPending("user-1")).toBe(true);
    expect(readEnvelope("user-1")?.pending?.mutationId).toBe(secondMutationId);

    // El push de la segunda (la de verdad vigente) sí borra.
    expect(deleteIfMatches("user-1", secondMutationId)).toBe(true);
    expect(hasPending("user-1")).toBe(false);
  });

  it("discard() borra el envelope completo, exista o no pending — logout explícito nunca deja datos personales atrás", () => {
    recordMutation("user-1", state({ weeklyBudget: 1 }), "tab-1");
    discard("user-1");
    expect(readEnvelope("user-1")).toBeNull();

    // También funciona sin pending (perfil ya confirmado).
    writeEnvelope("user-1", (env) => ({ ...env, userId: "user-1", state: state(), pending: null }));
    discard("user-1");
    expect(readEnvelope("user-1")).toBeNull();
  });

  it("dos usuarios en el mismo dispositivo tienen envelopes completamente independientes", () => {
    recordMutation("user-a", state({ weeklyBudget: 1 }), "tab-1");
    recordMutation("user-b", state({ weeklyBudget: 2 }), "tab-1");
    expect(readEnvelope("user-a")?.state.weeklyBudget).toBe(1);
    expect(readEnvelope("user-b")?.state.weeklyBudget).toBe(2);
    discard("user-a");
    expect(readEnvelope("user-a")).toBeNull();
    expect(readEnvelope("user-b")?.state.weeklyBudget).toBe(2); // ajeno, no lo toca
  });

  it("deleteIfMatches() devuelve false (nunca true) si la escritura del borrado falla — no puede darse un compare-and-delete por confirmado si no se persistió de verdad (corrección de revisión, P1)", () => {
    const written = recordMutation("user-1", state({ weeklyBudget: 1 }), "tab-1");
    const mutationId = (written as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId;

    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(deleteIfMatches("user-1", mutationId)).toBe(false);
    spy.mockRestore();

    // El pending sigue en disco — la escritura del borrado nunca llegó a persistirse.
    expect(readEnvelope("user-1")?.pending?.mutationId).toBe(mutationId);
  });

  it("dos 'pestañas' (dos mutationId distintos) generan mutaciones simultáneas — ninguna borra el pending de la otra por error (bloqueante §5, concurrencia real)", () => {
    const tabA = recordMutation("user-1", state({ weeklyBudget: 10 }), "tab-a");
    const mutationIdA = (tabA as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId;
    // "Pestaña B" escribe DESPUÉS, con su propio clientId — el último
    // setItem físico gana (documentado, no resuelto: ver §5 del diseño).
    const tabB = recordMutation("user-1", state({ weeklyBudget: 20 }), "tab-b");
    const mutationIdB = (tabB as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId;
    expect(mutationIdA).not.toBe(mutationIdB);

    // El push de A (que ya estaba en vuelo desde antes de que B escribiera)
    // termina y confirma — pero como la outbox ya no tiene el mutationId de
    // A (B lo sustituyó), su compare-and-delete no borra nada de B.
    expect(deleteIfMatches("user-1", mutationIdA)).toBe(false);
    expect(readEnvelope("user-1")?.pending?.mutationId).toBe(mutationIdB); // B sigue intacto, pendiente de su propio push
    expect(readEnvelope("user-1")?.state.weeklyBudget).toBe(20); // el estado de B (el último físico) es el que se ve

    // El push de B sí puede confirmar el suyo cuando le toque.
    expect(deleteIfMatches("user-1", mutationIdB)).toBe(true);
    expect(hasPending("user-1")).toBe(false);
  });
});

describe("outbox — aparcado temporal por expulsión involuntaria (bloqueante §4)", () => {
  it("parkIfPending() no hace nada si no hay pending", () => {
    writeEnvelope("user-1", (env) => ({ ...env, userId: "user-1", state: state(), pending: null }));
    parkIfPending("user-1");
    expect(readEnvelope("user-1")).not.toBeNull(); // sigue el envelope activo, no se movió a ningún lado
  });

  it("con pending: aparca y limpia el envelope activo; restoreParked() del MISMO usuario lo recupera íntegro", () => {
    const written = recordMutation("user-1", state({ weeklyBudget: 77 }), "tab-1");
    const mutationId = (written as { ok: true; envelope: { pending: { mutationId: string } } }).envelope.pending.mutationId;

    parkIfPending("user-1");
    expect(readEnvelope("user-1")).toBeNull(); // el activo se limpió

    const restored = restoreParked("user-1");
    expect(restored.value?.state.weeklyBudget).toBe(77);
    expect(restored.value?.pending?.mutationId).toBe(mutationId);
    expect(restored.cleanupOk).toBe(true);
    expect(readEnvelope("user-1")?.pending?.mutationId).toBe(mutationId); // restoreParked ya lo deja como activo
  });

  it("restoreParked() de un usuario DISTINTO al que aparcó devuelve value:null — nunca se asigna a otra cuenta", () => {
    recordMutation("user-a", state({ weeklyBudget: 1 }), "tab-1");
    parkIfPending("user-a");
    expect(restoreParked("user-b").value).toBeNull();
  });

  it("TTL: un aparcado vencido no se restaura", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordMutation("user-1", state({ weeklyBudget: 1 }), "tab-1");
    parkIfPending("user-1");

    vi.setSystemTime(new Date(Date.now() + PARKED_TTL_MS + 1000));
    expect(restoreParked("user-1").value).toBeNull();
    vi.useRealTimers();
  });

  it("purgeExpiredParked() borra aparcados vencidos de CUALQUIER usuario sin tocar los vigentes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordMutation("user-old", state(), "tab-1");
    parkIfPending("user-old");

    vi.setSystemTime(new Date(Date.now() + PARKED_TTL_MS + 1000));
    recordMutation("user-new", state(), "tab-1");
    parkIfPending("user-new");

    purgeExpiredParked();
    expect(restoreParked("user-old").value).toBeNull(); // vencido, purgado
    expect(restoreParked("user-new").value).not.toBeNull(); // recién aparcado, sigue vivo
    vi.useRealTimers();
  });

  it("REGRESIÓN (P1, sexta ronda): purgeExpiredParked() borra un parkedAt CORRUPTO o FUTURO — no solo el vencido normal", () => {
    localStorage.setItem("foodos-parked-v1-user-corrupt", JSON.stringify({
      schemaVersion: 2, userId: "user-corrupt", state: state(), pending: null,
      parkedAt: "no-es-una-fecha", reason: "involuntary_session_loss",
    }));
    localStorage.setItem("foodos-parked-v1-user-future", JSON.stringify({
      schemaVersion: 2, userId: "user-future", state: state(), pending: null,
      parkedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h, más allá de la tolerancia de reloj
      reason: "involuntary_session_loss",
    }));
    // Un usuario DISTINTO, vigente de verdad, no debe verse afectado.
    recordMutation("user-active", state(), "tab-1");
    parkIfPending("user-active");

    purgeExpiredParked();

    expect(localStorage.getItem("foodos-parked-v1-user-corrupt")).toBeNull();
    expect(localStorage.getItem("foodos-parked-v1-user-future")).toBeNull();
    expect(restoreParked("user-active").value).not.toBeNull(); // el de un usuario distinto, vigente, no se tocó
  });

  it("restoreParked() conserva el aparcado si escribir el envelope activo falla — nunca se pierde la ÚNICA copia por un fallo de cuota (corrección de revisión, P1)", () => {
    recordMutation("user-1", state({ weeklyBudget: 88 }), "tab-1");
    parkIfPending("user-1");
    expect(readEnvelope("user-1")).toBeNull(); // solo queda aparcado

    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const result = restoreParked("user-1"); // no se pudo restaurar de verdad
    expect(result.value).toBeNull();
    expect(result.cleanupOk).toBe(false);
    spy.mockRestore();

    // El aparcado NO se borró (orden corregido: escribir el activo PRIMERO,
    // borrar el aparcado solo si eso tuvo éxito) — sigue recuperable.
    expect(readEnvelope("user-1")).toBeNull(); // tampoco quedó a medias como activo
    const retried = restoreParked("user-1"); // ahora sin el fallo simulado
    expect(retried.value?.state.weeklyBudget).toBe(88);
    expect(retried.cleanupOk).toBe(true);
  });

  it("REGRESIÓN (P1, quinta ronda): un aparcado que quedó huérfano tras un fallo de removeItem() nunca revierte un activo que evolucionó después", () => {
    // 1. Se aparca un pending inicial.
    recordMutation("user-1", state({ weeklyBudget: 50 }), "tab-1");
    parkIfPending("user-1");
    expect(readEnvelope("user-1")).toBeNull();

    // 2. Se restaura — la escritura del activo tiene éxito, pero el
    //    removeItem() del aparcado falla: quedan las DOS copias vivas.
    const spy = vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new DOMException("blocked"); });
    const first = restoreParked("user-1");
    spy.mockRestore();
    expect(first.value?.state.weeklyBudget).toBe(50);
    expect(first.cleanupOk).toBe(false); // avisa: la limpieza no se completó
    expect(readEnvelope("user-1")?.state.weeklyBudget).toBe(50); // pero la restauración en sí SÍ se aplicó

    // 3. La copia activa evoluciona a un valor MÁS RECIENTE.
    recordMutation("user-1", state({ weeklyBudget: 999 }), "tab-1");

    // 4. Una restauración posterior (p.ej. otra sesión en este mismo
    //    dispositivo) NUNCA debe recuperar el valor antiguo (50) — el
    //    aparcado obsoleto se ignora porque ya hay un activo.
    const second = restoreParked("user-1");
    expect(second.value).toBeNull(); // no se restauró nada — regla de seguridad
    expect(readEnvelope("user-1")?.state.weeklyBudget).toBe(999); // el activo NUNCA se tocó
  });

  it("resolveInvoluntaryLoss(): con pending, aparca (delega en parkIfPending); sin pending, borra el envelope activo — nunca lo deja indefinidamente sin TTL (corrección de revisión, P1)", () => {
    // Caso con pending: se comporta como parkIfPending (ya cubierto arriba
    // en detalle) — solo se confirma que SÍ aparca.
    recordMutation("user-a", state({ weeklyBudget: 5 }), "tab-1");
    resolveInvoluntaryLoss("user-a");
    expect(readEnvelope("user-a")).toBeNull(); // se aparcó, no se dejó como activo
    expect(restoreParked("user-a").value).not.toBeNull();

    // Caso SIN pending: antes esto no hacía nada — el FoodOSState completo
    // se quedaba en localStorage sin TTL, sin ninguna razón para seguir en
    // este dispositivo. Ahora se borra.
    writeEnvelope("user-b", (env) => ({ ...env, userId: "user-b", state: state({ weeklyBudget: 9 }), pending: null }));
    resolveInvoluntaryLoss("user-b");
    expect(readEnvelope("user-b")).toBeNull();
    expect(restoreParked("user-b").value).toBeNull(); // tampoco se aparcó: no había nada pendiente que recuperar
  });

  it("resolveInvoluntaryLoss() también aparca el agua pendiente con TTL (P1) — incluso sin ningún envelope genérico pendiente", () => {
    // Puede haber agua pendiente sin que exista ningún envelope todavía
    // (setWaterTargetDurable no depende de que mutate() se haya llamado
    // antes) — resolveInvoluntaryLoss() debe aparcarla igual.
    writeWaterPending("user-c", { "2026-08-24": 500 });
    resolveInvoluntaryLoss("user-c");
    expect(readWaterPending("user-c")).toEqual({}); // ya no queda activa...
    expect(restoreParkedWater("user-c").value).toEqual({ "2026-08-24": 500 }); // ...quedó aparcada, recuperable
  });
});

describe("outbox — agua pendiente persistida (bloqueante P0, durabilidad a través de una recarga)", () => {
  it("writeWaterPending()/readWaterPending() sobreviven de forma independiente al envelope genérico, por usuario", () => {
    writeWaterPending("user-1", { "2026-08-24": 500, "2026-08-25": 250 });
    writeWaterPending("user-2", { "2026-08-24": 100 });
    expect(readWaterPending("user-1")).toEqual({ "2026-08-24": 500, "2026-08-25": 250 });
    expect(readWaterPending("user-2")).toEqual({ "2026-08-24": 100 }); // ajeno, no se mezcla
  });

  it("writeWaterPending() con un objeto vacío borra la clave — no deja un rastro vacío en disco", () => {
    writeWaterPending("user-1", { "2026-08-24": 500 });
    writeWaterPending("user-1", {});
    expect(readWaterPending("user-1")).toEqual({});
    expect(localStorage.getItem("foodos-water-pending-v1-user-1")).toBeNull();
  });

  it("discardWaterPending() borra el agua pendiente sin tocar el envelope genérico del mismo usuario", () => {
    recordMutation("user-1", state({ weeklyBudget: 3 }), "tab-1");
    writeWaterPending("user-1", { "2026-08-24": 500 });
    discardWaterPending("user-1");
    expect(readWaterPending("user-1")).toEqual({});
    expect(readEnvelope("user-1")?.state.weeklyBudget).toBe(3); // el envelope genérico no se tocó
  });

  it("envelopeKey() es la misma clave física que usa readEnvelope/writeEnvelope — para que el listener de `storage` entre pestañas reconozca los eventos correctos", () => {
    writeEnvelope("user-1", (env) => ({ ...env, userId: "user-1", state: state(), pending: null }));
    expect(localStorage.getItem(envelopeKey("user-1"))).not.toBeNull();
  });

  it("readWaterPending() descarta entradas corruptas de forma segura, sin romper la lectura completa por una sola entrada mala (bloqueante P1)", () => {
    localStorage.setItem("foodos-water-pending-v1-user-1", JSON.stringify({
      "2026-08-24": 500, // válida
      "no-es-una-fecha": 100, // clave sin forma YYYY-MM-DD
      "2026-08-25": "500", // valor no numérico
      "2026-08-26": -10, // negativo
      "2026-08-27": Number.NaN, // no finito
      "2026-08-28": 999_999, // fuera de cualquier límite plausible
      "2026-08-29": 1200, // válida
    }));
    expect(readWaterPending("user-1")).toEqual({ "2026-08-24": 500, "2026-08-29": 1200 });
  });

  it("readWaterPending() rechaza fechas de calendario IMPOSIBLES aunque tengan la forma correcta, y valores decimales (bloqueante P2)", () => {
    localStorage.setItem("foodos-water-pending-v1-user-1", JSON.stringify({
      "2026-08-24": 500, // válida
      "2026-99-99": 100, // mes/día imposibles, pero con la forma YYYY-MM-DD
      "2026-02-30": 200, // febrero nunca tiene 30 días
      "2026-13-01": 300, // mes 13 no existe
      "2026-08-25": 250.5, // water_log.ml es integer — un decimal no debe pasar
      "2026-08-26": Infinity, // no finito
      "2026-08-29": 1200, // válida
    }));
    expect(readWaterPending("user-1")).toEqual({ "2026-08-24": 500, "2026-08-29": 1200 });
  });

  it("readWaterPending() con un JSON que no es un objeto (array, string, número) devuelve vacío en vez de lanzar", () => {
    localStorage.setItem("foodos-water-pending-v1-user-1", JSON.stringify([1, 2, 3]));
    expect(readWaterPending("user-1")).toEqual({});
    localStorage.setItem("foodos-water-pending-v1-user-1", JSON.stringify("agua"));
    expect(readWaterPending("user-1")).toEqual({});
  });

  it("discard()/discardWaterPending() devuelven WriteResult — informan si el removeItem falló de verdad en vez de tragárselo en silencio (bloqueante P1)", () => {
    recordMutation("user-1", state({ weeklyBudget: 3 }), "tab-1");
    writeWaterPending("user-1", { "2026-08-24": 500 });

    expect(discard("user-1")).toEqual({ ok: true });
    expect(discardWaterPending("user-1")).toEqual({ ok: true });

    const spy = vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new DOMException("blocked"); });
    recordMutation("user-1", state({ weeklyBudget: 3 }), "tab-1");
    const result = discard("user-1");
    spy.mockRestore();
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: unknown }).error).toBeDefined();
  });
});

describe("outbox — aparcado del agua pendiente con TTL (bloqueante P1, misma política que el envelope genérico)", () => {
  it("parkWaterIfPending() no hace nada si no hay agua pendiente", () => {
    parkWaterIfPending("user-1");
    expect(restoreParkedWater("user-1").value).toBeNull();
  });

  it("con agua pendiente: aparca y limpia la activa; restoreParkedWater() del MISMO usuario la recupera íntegra", () => {
    writeWaterPending("user-1", { "2026-08-24": 500, "2026-08-25": 250 });
    parkWaterIfPending("user-1");
    expect(readWaterPending("user-1")).toEqual({}); // la activa se limpió

    const restored = restoreParkedWater("user-1");
    expect(restored.value).toEqual({ "2026-08-24": 500, "2026-08-25": 250 });
    expect(restored.cleanupOk).toBe(true);
    expect(readWaterPending("user-1")).toEqual({ "2026-08-24": 500, "2026-08-25": 250 }); // restoreParkedWater ya lo deja activo
  });

  it("restoreParkedWater() de un usuario DISTINTO al que aparcó devuelve value:null — nunca se asigna a otra cuenta", () => {
    writeWaterPending("user-a", { "2026-08-24": 500 });
    parkWaterIfPending("user-a");
    expect(restoreParkedWater("user-b").value).toBeNull();
  });

  it("TTL: agua aparcada vencida no se restaura", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    writeWaterPending("user-1", { "2026-08-24": 500 });
    parkWaterIfPending("user-1");

    vi.setSystemTime(new Date(Date.now() + PARKED_TTL_MS + 1000));
    expect(restoreParkedWater("user-1").value).toBeNull();
    vi.useRealTimers();
  });

  it("purgeExpiredParkedWater() borra agua aparcada vencida de CUALQUIER usuario sin tocar la vigente", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    writeWaterPending("user-old", { "2026-08-24": 100 });
    parkWaterIfPending("user-old");

    vi.setSystemTime(new Date(Date.now() + PARKED_TTL_MS + 1000));
    writeWaterPending("user-new", { "2026-08-24": 200 });
    parkWaterIfPending("user-new");

    purgeExpiredParkedWater();
    expect(restoreParkedWater("user-old").value).toBeNull(); // vencido, purgado
    expect(restoreParkedWater("user-new").value).not.toBeNull(); // recién aparcado, sigue vivo
    vi.useRealTimers();
  });

  it("REGRESIÓN (P1, sexta ronda): purgeExpiredParkedWater() borra un parkedAt CORRUPTO o FUTURO — no solo el vencido normal", () => {
    localStorage.setItem("foodos-water-parked-v1-user-corrupt", JSON.stringify({
      parkedAt: "no-es-una-fecha", pending: { "2026-08-24": 500 },
    }));
    localStorage.setItem("foodos-water-parked-v1-user-future", JSON.stringify({
      parkedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      pending: { "2026-08-24": 500 },
    }));
    // Un usuario DISTINTO, vigente de verdad, no debe verse afectado.
    writeWaterPending("user-active", { "2026-08-24": 900 });
    parkWaterIfPending("user-active");

    purgeExpiredParkedWater();

    expect(localStorage.getItem("foodos-water-parked-v1-user-corrupt")).toBeNull();
    expect(localStorage.getItem("foodos-water-parked-v1-user-future")).toBeNull();
    expect(restoreParkedWater("user-active").value).not.toBeNull(); // el de un usuario distinto, vigente, no se tocó
  });

  it("discardParkedWater() borra el agua aparcada explícitamente (logout tras una expulsión involuntaria anterior nunca resuelta) y devuelve WriteResult", () => {
    writeWaterPending("user-1", { "2026-08-24": 500 });
    parkWaterIfPending("user-1");
    expect(discardParkedWater("user-1")).toEqual({ ok: true });
    expect(restoreParkedWater("user-1").value).toBeNull();
  });

  it("restoreParkedWater() descarta un `parkedAt` corrupto (no-fecha) como si no existiera, en vez de dejar pasar un TTL calculado con NaN (bloqueante P1)", () => {
    localStorage.setItem("foodos-water-parked-v1-user-1", JSON.stringify({ parkedAt: "no-es-una-fecha", pending: { "2026-08-24": 500 } }));
    expect(restoreParkedWater("user-1").value).toBeNull();
    expect(localStorage.getItem("foodos-water-parked-v1-user-1")).toBeNull(); // se limpió, no quedó corrupto en disco
  });

  it("restoreParkedWater() rechaza un `parkedAt` implausiblemente futuro (más allá de la tolerancia de reloj) en vez de aceptarlo como 'recién aparcado' (bloqueante P2)", () => {
    const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h, muy por encima de la tolerancia de 5 min
    localStorage.setItem("foodos-water-parked-v1-user-1", JSON.stringify({ parkedAt: farFuture, pending: { "2026-08-24": 500 } }));
    expect(restoreParkedWater("user-1").value).toBeNull();
  });

  it("restoreParkedWater() sanea las entradas de `pending` corruptas antes de restaurarlas como activas (bloqueante P1)", () => {
    localStorage.setItem("foodos-water-parked-v1-user-1", JSON.stringify({
      parkedAt: new Date().toISOString(),
      pending: { "2026-08-24": 500, "fecha-mala": 100, "2026-08-25": -5 },
    }));
    const restored = restoreParkedWater("user-1");
    expect(restored.value).toEqual({ "2026-08-24": 500 });
    expect(readWaterPending("user-1")).toEqual({ "2026-08-24": 500 }); // nunca llegó basura al activo
  });

  it("restoreParkedWater() NUNCA sobrescribe agua activa ya existente — regla de seguridad (bloqueante P1, quinta ronda)", () => {
    writeWaterPending("user-1", { "2026-08-24": 500 });
    parkWaterIfPending("user-1"); // aparca el 500

    // Entre tanto, este dispositivo generó actividad NUEVA: agua activa
    // más reciente para la MISMA fecha, con un objetivo distinto.
    writeWaterPending("user-1", { "2026-08-24": 1200 });

    const restored = restoreParkedWater("user-1");
    expect(restored.value).toBeNull(); // no se restauró nada — ya había una activa
    expect(readWaterPending("user-1")).toEqual({ "2026-08-24": 1200 }); // la activa NUNCA se tocó
  });

  it("REGRESIÓN (P1, quinta ronda): agua aparcada huérfana tras un fallo de removeItem() nunca revierte un objetivo más reciente", () => {
    // 1. Se aparca un objetivo inicial.
    writeWaterPending("user-1", { "2026-08-24": 300 });
    parkWaterIfPending("user-1");
    expect(readWaterPending("user-1")).toEqual({});

    // 2. Se restaura — la escritura activa tiene éxito, pero el
    //    removeItem() del aparcado falla: quedan las DOS copias vivas.
    const spy = vi.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new DOMException("blocked"); });
    const first = restoreParkedWater("user-1");
    spy.mockRestore();
    expect(first.value).toEqual({ "2026-08-24": 300 });
    expect(first.cleanupOk).toBe(false);
    expect(readWaterPending("user-1")).toEqual({ "2026-08-24": 300 }); // la restauración en sí SÍ se aplicó

    // 3. El objetivo activo evoluciona a uno MÁS RECIENTE.
    writeWaterPending("user-1", { "2026-08-24": 1500 });

    // 4. Una restauración posterior nunca recupera el valor antiguo (300).
    const second = restoreParkedWater("user-1");
    expect(second.value).toBeNull();
    expect(readWaterPending("user-1")).toEqual({ "2026-08-24": 1500 }); // nunca revertido
  });
});

describe("outbox — clientId por pestaña (bloqueante §5, varias pestañas)", () => {
  it("es estable dentro de la misma 'pestaña' (mismo sessionStorage) entre llamadas", () => {
    const a = getTabClientId();
    const b = getTabClientId();
    expect(a).toBe(b);
  });

  it("vive en sessionStorage, no en localStorage — una 'pestaña' nueva (sessionStorage vacío) genera uno distinto", () => {
    const first = getTabClientId();
    sessionStorage.clear();
    resetTabClientIdCacheForTests();
    const second = getTabClientId();
    expect(second).not.toBe(first);
  });
});
