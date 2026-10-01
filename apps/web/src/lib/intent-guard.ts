// Nutrition Engine v4, PR2 — guard síncrono contra doble-ingesta por una
// misma intención de usuario (docs/NUTRITION_V4_DATA_INTEGRITY_DESIGN.md,
// §1.7/§5 invariante 7). Corrige una garantía que la v2 del documento de
// diseño describía como insuficiente: un `disabled` de React no basta,
// porque `setState` no actualiza el DOM de forma síncrona respecto a
// eventos de click ya despachados — dos clics disparados antes del primer
// repintado pueden llegar los dos al manejador con `disabled` todavía en
// `false`.
//
// `claim()`/`release()` son síncronos: la comprobación y el registro
// ocurren en la misma línea, sin ningún `await` de por medio, así que dos
// invocaciones del mismo manejador dentro de la misma tarea de JavaScript
// no pueden colarse las dos — JavaScript es de un solo hilo, y ninguna de
// las dos funciones cede el control antes de terminar.
//
// Vive en memoria, por sesión de pestaña — no persiste entre recargas ni
// se comparte entre pestañas o dispositivos. Es deliberado y basta para el
// caso que cierra (doble clic/doble toque en la misma sesión, la ventana
// de riesgo real); el caso multi-dispositivo o de recarga a mitad de una
// intención es una garantía más fuerte (persistida) que el documento de
// diseño deja explícitamente para una fase posterior (PR5), no para esta.
//
// GARANTÍA EXACTA que este guard ofrece — y ninguna más (corrección de
// revisión, PR2 segunda ronda: la versión anterior de este comentario
// sobreclamaba lo que sigue):
//
//   Dos invocaciones de la MISMA intención (mismo intentId) producen como
//   mucho UNA llamada realmente ACEPTADA a `perform()` en esta sesión de
//   pestaña. "Aceptada" significa "perform() se llamó y devolvió `true`"
//   — nada más.
//
// Lo que `perform() === true` NO garantiza en este código base, y que
// este guard por tanto tampoco garantiza:
//
//   - No confirma sincronización remota. `mutate()` (state.tsx) devuelve
//     `true` en cuanto la mutación SUPERA el gate de hidratación
//     (`mutationsBlocked()`) y ENTRA al pipeline de persistencia local —
//     antes de que React re-renderice (`setState` es asíncrono) y mucho
//     antes de que Supabase confirme nada. Es el propio contrato
//     documentado de `mutate()` en state.tsx ("Corrección de revisión
//     (contrato booleano de mutate())"), no una limitación nueva de este
//     guard.
//
//   - Para `actions.consumeInventoryItem` específicamente, `mutate() ===
//     true` TAMPOCO garantiza que se añadiera una fila al diario:
//     `consumeInventoryItem` (state.tsx:3007-3009) hace
//     `if (!item) return;` en cuanto no encuentra el `itemId` en el
//     inventario del draft — un caso real y alcanzable si ese lote ya se
//     consumió o se eliminó por otra pestaña/acción entre que se abrió
//     ConsumeModal y que el usuario confirmó. `mutate()` no distingue ese
//     "no-op silencioso" de una mutación real: solo comprueba el gate de
//     hidratación, nunca si la función que recibió cambió algo, así que
//     devuelve `true` en ambos casos por igual.
//
//     `actions.cookRecipe` (state.tsx:2969-3003), en cambio, SIEMPRE
//     empuja una entrada al diario al final de su cuerpo — no tiene
//     ningún `return` anticipado, así que esta asimetría concreta no
//     existe para el camino de cocinar.
//
//   Cerrar esta asimetría (p. ej. que `consumeInventoryItem` señalizara
//   "no hice nada" de forma distinguible de `mutationsBlocked()`) no es
//   responsabilidad de este guard ni de esta entrega — se documenta aquí
//   para que ningún código futuro asuma, a partir de `mutate() === true`,
//   una garantía ("se creó la ingesta") que este código base no ofrece
//   todavía.

export interface IntentGuard {
  /** `true` = intentId reclamado ahora, el llamador puede proceder.
   *  `false` = ya estaba reclamado (con una llamada aceptada anterior, o
   *  todavía en curso) — el llamador debe abortar sin llamar a
   *  `perform()`. */
  claim(intentId: string): boolean;
  /** Libera una reclamación para permitir un reintento explícito con el
   *  MISMO intentId. Llamar solo cuando la operación protegida devolvió
   *  `false` (p. ej. `mutate()` de state.tsx devolvió `false` porque
   *  `mutationsBlocked()` cortó la operación) — nunca después de que
   *  devolviera `true`. Ver la nota de cabecera de este archivo: `true`
   *  no siempre significa que el efecto de negocio esperado (una fila
   *  nueva en el diario) haya ocurrido — solo que la operación superó el
   *  gate y quedó aceptada localmente. */
  release(intentId: string): void;
}

export function createIntentGuard(): IntentGuard {
  const claimed = new Set<string>();
  return {
    claim(intentId: string): boolean {
      if (claimed.has(intentId)) return false;
      claimed.add(intentId);
      return true;
    },
    release(intentId: string): void {
      claimed.delete(intentId);
    },
  };
}

/** Instancia única, compartida por toda la app — los intentId son UUID
 *  (uid() de utils.ts), así que no hay riesgo real de colisión entre
 *  CookModal, ConsumeModal ni ningún futuro llamador compartiendo este
 *  mismo registro. */
export const intentGuard: IntentGuard = createIntentGuard();

/**
 * Ejecuta `perform` protegido por `guard`, con la política de conservar
 * la reclamación tras éxito y liberarla tras un fallo sin efecto,
 * definida en un único sitio para que CookModal y ConsumeModal (y
 * cualquier acción futura que registre una ingesta) la compartan en vez
 * de reimplementarla cada una por su cuenta:
 *
 * 1. Si `guard.claim(intentId)` devuelve `false` (segunda invocación de la
 *    MISMA intención), `perform` NUNCA se llama — cero llamadas
 *    adicionales, se devuelve `false`.
 * 2. Si `perform()` devuelve `false` (la propia operación señala que no
 *    fue aceptada — p. ej. `mutate()` bloqueada por
 *    `mutationsBlocked()`), la reclamación se libera: un reintento
 *    explícito posterior con el MISMO intentId podrá reclamar de nuevo.
 * 3. Si `perform()` devuelve `true`, la reclamación se conserva para
 *    siempre — esa intención ya obtuvo una llamada ACEPTADA y no puede
 *    volver a dispararla, ni siquiera si el intentId se reutilizara por
 *    error. Ver la nota de cabecera del archivo: `true` no demuestra por
 *    sí solo que el efecto de negocio esperado (una fila nueva en el
 *    diario) haya ocurrido, solo que la operación quedó aceptada
 *    localmente — este helper protege contra una SEGUNDA llamada
 *    aceptada, no contra que la primera haya sido, además, la operación
 *    de negocio completa que el usuario esperaba.
 *
 * Devuelve lo mismo que `perform()` cuando se llega a invocarla; `false`
 * si ni siquiera se llegó a invocar por estar ya reclamada.
 */
export function runGuardedIntent(guard: IntentGuard, intentId: string, perform: () => boolean): boolean {
  if (!guard.claim(intentId)) return false;
  const applied = perform();
  if (!applied) guard.release(intentId);
  return applied;
}

/**
 * §20 — misma política que `runGuardedIntent`, pero para un `perform` que
 * devuelve un RESULTADO DE NEGOCIO propio (p. ej. `ConsumeInventoryResult`)
 * en vez de un booleano plano — para un llamador que, precisamente, no
 * puede decidir "se aceptó" mirando solo el booleano de `mutate()` (ver la
 * nota de cabecera de este archivo). `isAccepted` decide, a partir de ese
 * resultado, si la reclamación se conserva (aceptado: no puede repetirse)
 * o se libera (no aceptado: un reintento explícito con el MISMO intentId
 * puede volver a intentarlo).
 *
 * Devuelve `{ claimed: false }` si ni siquiera se llegó a invocar `perform`
 * (ya reclamado) — nunca confundible con un resultado real de `perform`,
 * que el llamador debe tipar sin un campo `claimed`.
 */
export function runGuardedIntentResult<T>(
  guard: IntentGuard,
  intentId: string,
  perform: () => T,
  isAccepted: (result: T) => boolean,
): T | { claimed: false } {
  if (!guard.claim(intentId)) return { claimed: false };
  const result = perform();
  if (!isAccepted(result)) guard.release(intentId);
  return result;
}
