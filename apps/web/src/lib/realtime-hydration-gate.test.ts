// B2 (revisión externa, 2026-08-22): un refresco en tiempo real llegado
// mientras hay un push local sin confirmar (éxito parcial incluido) NO debe
// hidratar el estado — eso pisaría el snapshot local con un remoto
// incompleto antes de que el reintento tenga ocasión de completarlo. Solo
// debe hidratar cuando el push que lo bloqueaba termina con éxito ("saved").
import { describe, expect, it } from "vitest";
import { RealtimeHydrationGate } from "./realtime-hydration-gate";

describe("RealtimeHydrationGate", () => {
  it("hidrata inmediatamente si no hay ningún push pendiente", () => {
    const gate = new RealtimeHydrationGate();
    expect(gate.onRealtimeRefresh(false)).toBe(true);
    expect(gate.hasDeferred).toBe(false);
  });

  it("difiere el refresco si hay un push pendiente en ese momento", () => {
    const gate = new RealtimeHydrationGate();
    expect(gate.onRealtimeRefresh(true)).toBe(false);
    expect(gate.hasDeferred).toBe(true);
  });

  it("caso central: fallo parcial + evento realtime — el estado local NO se reemplaza hasta que el push tiene éxito", () => {
    const gate = new RealtimeHydrationGate();

    // Un push está en curso/pendiente (éxito parcial en camino) cuando llega
    // un refresco en tiempo real de otra fila.
    expect(gate.onRealtimeRefresh(true)).toBe(false); // NO hidratar todavía

    // El push falla (p.ej. el perfil no se guardó) — sigue sin confirmarse.
    expect(gate.onPushStatusChange("error")).toBe(false); // sigue diferido
    expect(gate.hasDeferred).toBe(true);

    // Llega OTRO evento realtime mientras se espera el reintento — sigue diferido.
    expect(gate.onRealtimeRefresh(true)).toBe(false);

    // Transiciones intermedias del reintento tampoco deben disparar nada.
    expect(gate.onPushStatusChange("syncing")).toBe(false);
    expect(gate.hasDeferred).toBe(true);

    // El reintento por fin tiene éxito: AHORA sí toca hidratar.
    expect(gate.onPushStatusChange("saved")).toBe(true);
    expect(gate.hasDeferred).toBe(false);
  });

  it("un 'saved' sin nada diferido no dispara una hidratación de más", () => {
    const gate = new RealtimeHydrationGate();
    expect(gate.onPushStatusChange("saved")).toBe(false);
  });

  it("tras resolverse un diferido, un 'saved' posterior sin nuevo evento no vuelve a disparar", () => {
    const gate = new RealtimeHydrationGate();
    gate.onRealtimeRefresh(true);
    expect(gate.onPushStatusChange("saved")).toBe(true);
    expect(gate.onPushStatusChange("saved")).toBe(false); // ya se consumió
  });

  it("un refresco que llega cuando ya no hay push pendiente hidrata, aunque antes hubiera habido uno diferido y resuelto", () => {
    const gate = new RealtimeHydrationGate();
    gate.onRealtimeRefresh(true);
    gate.onPushStatusChange("saved");
    expect(gate.onRealtimeRefresh(false)).toBe(true);
  });
});
