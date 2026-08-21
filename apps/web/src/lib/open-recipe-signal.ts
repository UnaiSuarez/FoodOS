"use client";

// E04-10: el buscador global navega a /dashboard/recipes al elegir un
// resultado de receta, pero solo llegar a la SECCIÓN no es mucho mejor que
// pulsar "Recetas" en el nav — el valor real de un buscador es abrir el
// resultado concreto. openRecipeId vive en DashboardShell (useState
// normal) y Next.js remonta el componente de página en cada navegación
// entre rutas (mismo caso que el tour, ver tour-progress.ts) — sin
// persistir qué receta abrir en algo que sobreviva a ese remontaje, la
// navegación llegaría a la lista pero nunca abriría el detalle.
const KEY = "foodos-open-recipe-signal";

export function setOpenRecipeSignal(recipeId: string): void {
  try {
    sessionStorage.setItem(KEY, recipeId);
  } catch {
    // sessionStorage no disponible: la navegación a la sección sigue
    // funcionando, solo se pierde el abrir la receta automáticamente.
  }
}

/** Consume la señal si hay una — la borra siempre que la lee, para que no
    quede pegada a una visita futura a Recetas que no vino del buscador. */
export function consumeOpenRecipeSignal(): string | null {
  try {
    const value = sessionStorage.getItem(KEY);
    if (value === null) return null;
    sessionStorage.removeItem(KEY);
    return value;
  } catch {
    return null;
  }
}
