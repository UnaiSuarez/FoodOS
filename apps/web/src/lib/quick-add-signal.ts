"use client";

// E04-04: acción universal "Añadir" — deja una señal de una sola vez para
// que la vista de destino, tras el router.push, sepa que debe abrir/enfocar
// su formulario de alta nada más montar. Sin esto, "Añadir" solo navegaría,
// dejando al usuario en la vista correcta pero con el mismo trabajo de
// encontrar el formulario que si hubiera navegado a mano.
//
// sessionStorage en vez de un query param (?quickAdd=...): un query param
// leído con next/navigation's useSearchParams() exige envolver el
// componente en <Suspense> (regla de Next.js App Router) en las ~4 vistas
// de destino — sessionStorage no tiene esa exigencia, es igual de
// resistente a que router.push desmonte/remonte el árbol, y como todas las
// mutaciones de esta app pasan por localStorage de todas formas, el patrón
// ya es familiar en el código.
const KEY = "foodos-quick-add-signal";

export type QuickAddType = "meal" | "food" | "weight" | "expense" | "session";

export function setQuickAddSignal(type: QuickAddType): void {
  try {
    sessionStorage.setItem(KEY, type);
  } catch {
    // sessionStorage no disponible (modo privado agresivo, cuota...): la
    // navegación sigue funcionando, solo se pierde el auto-abrir/enfocar.
  }
}

/** Consume la señal si coincide con `type` — la borra SIEMPRE que la lee,
    coincida o no, para que no quede pegada a una visita futura distinta
    (ej. entrar en Nutrición sin pasar por "Añadir" no debe heredar una
    señal de "gasto" que se dejó pendiente en otra pestaña). */
export function consumeQuickAddSignal(type: QuickAddType): boolean {
  try {
    const value = sessionStorage.getItem(KEY);
    if (value === null) return false;
    sessionStorage.removeItem(KEY);
    return value === type;
  } catch {
    return false;
  }
}
