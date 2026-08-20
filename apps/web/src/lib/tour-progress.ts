"use client";

// E18-11: el tour avanza NAVEGANDO entre secciones (router.push, ver
// AppTour.tsx) — cada una es una ruta distinta de verdad (E01), y Next.js
// App Router remonta el componente de página (no solo re-renderiza) en
// cada navegación entre rutas, aunque compartan el mismo page.tsx
// "catch-all". Sin persistir el paso en algo que sobreviva a ese remontaje,
// tourActive/step (useState normal en DashboardShell/AppTour) volvían a su
// valor inicial en cuanto el tour navegaba a su segundo paso — el tour se
// cerraba solo, sin llamar a onDone(), un bug real que hacía el tour
// prácticamente inusable más allá del primer paso (encontrado verificando
// en vivo el trabajo de accesibilidad de este ticket).
export const TOUR_STEP_KEY = "foodos-tour-step";

export function getSavedTourStep(): number | null {
  try {
    const raw = sessionStorage.getItem(TOUR_STEP_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function saveTourStep(step: number): void {
  try {
    sessionStorage.setItem(TOUR_STEP_KEY, String(step));
  } catch {
    // sessionStorage no disponible: el tour sigue funcionando dentro de
    // una misma vista, solo se pierde el reanudar tras navegar.
  }
}

export function clearTourStep(): void {
  try {
    sessionStorage.removeItem(TOUR_STEP_KEY);
  } catch {
    // no-op
  }
}
