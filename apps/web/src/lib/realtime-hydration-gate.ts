// Decide cuándo es seguro hidratar el estado desde un refresco en tiempo
// real de Supabase frente a un push local sin confirmar (B2, revisión
// externa, 2026-08-22).
//
// Antes, state.tsx reintentaba hasta 6 veces (300ms cada una = 1.8s) y
// LUEGO hidrataba de todos modos como "red de seguridad ante un guardado
// atascado" — pero un push fallido reintenta en PUSH_RETRY_MS (10s, ver
// data-layer.ts), así que esa red de seguridad se disparaba sistemáticamente
// ANTES de que el reintento pudiera siquiera empezar: un refresco en tiempo
// real de OTRA fila podía disparar una hidratación completa que pisara el
// estado local con el resultado A MEDIAS del push que aún no se había
// reintentado (éxito parcial: perfil guardado, pesos no, por ejemplo).
//
// Esta clase es lógica pura, sin React ni temporizadores propios, para
// poder testearla sin renderizar el árbol de componentes (no hay
// @testing-library en este proyecto y no es tarea de esta rama añadirlo).
// state.tsx es un envoltorio fino alrededor de esto: consulta
// remote.hasPendingPush() al llegar un evento de refresco y llama con cada
// transición de remote.onStatusChange.
export class RealtimeHydrationGate {
  private pending = false;

  /** Llamar cuando llega un refresco en tiempo real (tras su propio
      debounce). `hasPendingPush` es remote.hasPendingPush() en ese momento.
      Devuelve true si es seguro hidratar YA; false si se difirió porque
      había un push local sin confirmar. */
  onRealtimeRefresh(hasPendingPush: boolean): boolean {
    if (hasPendingPush) {
      this.pending = true;
      return false;
    }
    return true;
  }

  /** Llamar en CADA transición de remote.onStatusChange. Devuelve true
      solo si status es "saved" Y había un refresco diferido esperando —
      la única condición bajo la que hay que hidratar tras diferir. Un
      "error" NO limpia lo diferido: el push sigue sin confirmarse y
      seguirá reintentando, así que el refresco se sigue difiriendo hasta
      que de verdad se guarde (nunca por un margen de tiempo fijo). */
  onPushStatusChange(status: "syncing" | "saved" | "error"): boolean {
    if (status === "saved" && this.pending) {
      this.pending = false;
      return true;
    }
    return false;
  }

  get hasDeferred(): boolean {
    return this.pending;
  }
}
