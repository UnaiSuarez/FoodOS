import { describe, expect, it, vi } from "vitest";
import { createIntentGuard, runGuardedIntent } from "./intent-guard";

describe("IntentGuard — claim/release", () => {
  it("la primera reclamación de un intentId tiene éxito", () => {
    const guard = createIntentGuard();
    expect(guard.claim("a")).toBe(true);
  });

  it("una segunda reclamación del MISMO intentId, sin liberar, falla", () => {
    const guard = createIntentGuard();
    expect(guard.claim("a")).toBe(true);
    expect(guard.claim("a")).toBe(false);
    expect(guard.claim("a")).toBe(false); // sigue fallando, no es de un solo uso
  });

  it("intentId DISTINTOS son independientes: una acción nueva y legítima recibe un identificador nuevo y sí puede reclamar", () => {
    const guard = createIntentGuard();
    expect(guard.claim("a")).toBe(true);
    expect(guard.claim("b")).toBe(true);
  });

  it("release() permite volver a reclamar el MISMO intentId (reintento explícito)", () => {
    const guard = createIntentGuard();
    expect(guard.claim("a")).toBe(true);
    guard.release("a");
    expect(guard.claim("a")).toBe(true);
  });

  it("release() de un intentId nunca reclamado es un no-op seguro", () => {
    const guard = createIntentGuard();
    expect(() => guard.release("nunca-reclamado")).not.toThrow();
    expect(guard.claim("nunca-reclamado")).toBe(true); // no queda en ningún estado raro
  });

  it("dos guards son independientes entre sí (sin estado compartido accidental)", () => {
    const guardA = createIntentGuard();
    const guardB = createIntentGuard();
    expect(guardA.claim("x")).toBe(true);
    expect(guardB.claim("x")).toBe(true); // "x" en guardB no está afectado por guardA
  });
});

describe("runGuardedIntent — política completa: conservar tras éxito, liberar tras fallo sin efecto", () => {
  it("perform() se llama exactamente una vez para una intención nueva, y su resultado se propaga", () => {
    const guard = createIntentGuard();
    const perform = vi.fn(() => true);
    const result = runGuardedIntent(guard, "intent-1", perform);
    expect(result).toBe(true);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("dos invocaciones INMEDIATAS con el MISMO intentId causan una sola llamada real a perform() — la segunda no produce ningún efecto", () => {
    const guard = createIntentGuard();
    const perform = vi.fn(() => true);
    const first = runGuardedIntent(guard, "intent-1", perform);
    const second = runGuardedIntent(guard, "intent-1", perform); // "doble clic": mismo intentId
    expect(first).toBe(true);
    expect(second).toBe(false); // la segunda ni siquiera llama a perform()
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("una intención NUEVA y legítima (intentId distinto) sí puede registrarse, incluso tras una intención anterior ya exitosa", () => {
    const guard = createIntentGuard();
    const performA = vi.fn(() => true);
    const performB = vi.fn(() => true);
    expect(runGuardedIntent(guard, "cocinar-receta-1", performA)).toBe(true);
    expect(runGuardedIntent(guard, "cocinar-receta-2", performB)).toBe(true); // intención distinta, no bloqueada
    expect(performA).toHaveBeenCalledTimes(1);
    expect(performB).toHaveBeenCalledTimes(1);
  });

  it("si perform() devuelve false (no aceptada — p. ej. mutate() bloqueada por mutationsBlocked()), la reclamación se libera y permite un reintento explícito con el MISMO intentId", () => {
    const guard = createIntentGuard();
    const perform = vi.fn(() => false); // simula mutate() === false (mutationsBlocked())
    const first = runGuardedIntent(guard, "intent-1", perform);
    expect(first).toBe(false);
    // Reintento explícito, mismo intentId: como el primer intento NO produjo
    // efecto, debe poder reclamar de nuevo — a diferencia del caso de éxito.
    const retryPerform = vi.fn(() => true);
    const second = runGuardedIntent(guard, "intent-1", retryPerform);
    expect(second).toBe(true);
    expect(retryPerform).toHaveBeenCalledTimes(1);
  });

  it("tras un ÉXITO, la reclamación NUNCA se libera — un reintento con el mismo intentId no vuelve a llamar a perform(), aunque se solicite explícitamente", () => {
    const guard = createIntentGuard();
    const perform = vi.fn(() => true);
    expect(runGuardedIntent(guard, "intent-1", perform)).toBe(true);
    const secondPerform = vi.fn(() => true);
    expect(runGuardedIntent(guard, "intent-1", secondPerform)).toBe(false);
    expect(secondPerform).not.toHaveBeenCalled();
  });

  it("una secuencia fallo→fallo→éxito con el mismo intentId permite reintentar tras cada fallo, y dejar de poder hacerlo tras el éxito", () => {
    const guard = createIntentGuard();
    expect(runGuardedIntent(guard, "intent-1", () => false)).toBe(false);
    expect(runGuardedIntent(guard, "intent-1", () => false)).toBe(false); // sigue pudiendo reintentar
    expect(runGuardedIntent(guard, "intent-1", () => true)).toBe(true); // por fin una llamada aceptada
    const afterSuccess = vi.fn(() => true);
    expect(runGuardedIntent(guard, "intent-1", afterSuccess)).toBe(false); // ya no se puede repetir
    expect(afterSuccess).not.toHaveBeenCalled();
  });

  it("perform() que lanza no dobla el efecto en una llamada posterior, pero SÍ propaga la excepción (no se traga silenciosamente)", () => {
    const guard = createIntentGuard();
    expect(() =>
      runGuardedIntent(guard, "intent-1", () => {
        throw new Error("fallo inesperado dentro de perform");
      }),
    ).toThrow("fallo inesperado dentro de perform");
    // La reclamación quedó hecha (claim() se ejecutó antes del throw) — un
    // caller que capture la excepción y quiera reintentar debe liberar él
    // mismo, con conocimiento de si hubo o no efecto parcial; este helper
    // no asume nada sobre un throw, solo sobre el contrato booleano.
    expect(guard.claim("intent-1")).toBe(false);
  });
});
