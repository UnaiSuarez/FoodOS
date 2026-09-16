import { test, expect, type Page } from "@playwright/test";

/**
 * Borrado de recetas personalizadas — flujo completo de UI/persistencia.
 *
 * IMPORTANTE (ver playwright.config.ts): este proyecto ejecuta TODO su e2e
 * en modo local-only — NEXT_PUBLIC_SUPABASE_URL/ANON_KEY se fijan vacías a
 * propósito en el webServer, así que hasSupabaseConfig() es siempre false y
 * la app persiste únicamente en localStorage (clave
 * "foodos-appweb-state-v1"), sin sesión, sin outbox ni push a Supabase.
 * Estos tests verifican por tanto el flujo de UI y la persistencia LOCAL
 * (creación → planificación → borrado → recarga del navegador), no que la
 * sincronización remota real contra Supabase se comporte igual. Esa
 * verificación con la cuenta QA se hace aparte, manualmente, tras el
 * despliegue.
 *
 * Las tres acciones (crear, planificar, eliminar) se realizan las tres a
 * través de la interfaz real — nada se inyecta directamente en
 * localStorage salvo las dos claves de "onboarding ya visto" del
 * beforeEach (necesarias para no chocar con el tour la primera vez).
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("foodos-ob-done", "1");
    window.localStorage.setItem("foodos-tour-done", "1");
  });
});

const RECIPE_TITLE = "FOODOS_E2E_RECETA_BORRAR";

async function createCustomRecipe(page: Page) {
  await page.goto("/dashboard/recipes");
  await page.getByRole("button", { name: "+ Crear receta" }).click();
  const modal = page.getByRole("dialog", { name: "Crear receta" });
  await modal.getByLabel("Nombre de la receta").fill(RECIPE_TITLE);
  await modal.getByRole("button", { name: "Guardar receta" }).click();
  await expect(page.locator(".toast")).toHaveText("Receta guardada");

  // La persistencia local está debounced (LOCAL_SAVE_DEBOUNCE_MS=300ms en
  // data-layer.ts) — el toast solo promete que la operación fue aceptada
  // localmente, no que ya esté escrita; el badge de sincronización es quien
  // comunica el estado real de persistencia. Como el siguiente paso navega
  // (planificador) y una navegación en este modo no pierde el estado en
  // memoria de React, esperar aquí a que la escritura real ocurra evita una
  // condición de carrera si algo más tarde depende de leerla de disco.
  await page.waitForFunction((title) => {
    const raw = JSON.parse(localStorage.getItem("foodos-appweb-state-v1") ?? "{}");
    return (raw.customRecipes ?? []).some((r: { title: string }) => r.title === title);
  }, RECIPE_TITLE);
}

/** Planifica la receta en la comida de HOY (columna marcada con la clase
    "today" en la cabecera del planificador — así el test no depende de
    calcular a mano qué día de la semana es hoy, ni de que "mañana" caiga
    dentro de la semana visible si hoy es domingo) mediante la interfaz
    real: buscarla en el panel lateral, seleccionarla, y tocar la celda de
    "Comida" de la columna de hoy. */
async function planRecipeForToday(page: Page) {
  await page.goto("/dashboard/planner");

  await page.getByLabel("Buscar recetas").fill(RECIPE_TITLE);
  await page.locator(".planner-recipe-card", { hasText: RECIPE_TITLE }).click();

  const todayIndex = await page.locator(".planner-day-head").evaluateAll(
    (heads) => heads.findIndex((h) => h.classList.contains("today"))
  );
  expect(todayIndex).toBeGreaterThanOrEqual(0);

  const lunchRow = page.locator(".planner-meal-row", { hasText: "Comida" });
  const todayLunchCell = lunchRow.locator(".planner-cell").nth(todayIndex);
  await todayLunchCell.locator("button").click();

  // Confirma que la UI realmente colocó la receta antes de seguir — si el
  // clic no hubiera registrado, mejor fallar aquí con un mensaje claro que
  // seguir adelante sobre una premisa falsa.
  await expect(todayLunchCell.locator(".planner-cell-name")).toHaveText(RECIPE_TITLE);
}

test("crear, planificar hoy y eliminar una receta personalizada limpia el hueco del planificador tras recargar (E21-XX)", async ({ page }) => {
  await createCustomRecipe(page);
  await planRecipeForToday(page);

  await page.goto("/dashboard/recipes");
  const card = page.locator(".recipe-card", { hasText: RECIPE_TITLE });
  await expect(card).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: `Eliminar receta ${RECIPE_TITLE}` }).click();

  await expect(page.locator(".toast")).toHaveText(`"${RECIPE_TITLE}" eliminada`);
  await expect(page.locator(".recipe-card", { hasText: RECIPE_TITLE })).toHaveCount(0);

  // Recarga completa: la receta sigue sin existir, y el hueco de hoy en el
  // planificador vuelve a estar vacío — nunca un ID huérfano que ya no
  // resuelve a nada.
  await page.reload();
  await expect(page.locator(".recipe-card", { hasText: RECIPE_TITLE })).toHaveCount(0);

  await page.goto("/dashboard/planner");
  // evaluateAll() no auto-espera como el resto de acciones de Playwright —
  // a diferencia de planRecipeForToday() (donde ya se esperó a rellenar el
  // buscador antes de leer las cabeceras, garantizando que la grilla ya
  // había montado), aquí no hay ninguna otra acción previa que lo
  // garantice tras un page.goto() recién hecho — sin esto, evaluateAll()
  // podía ejecutarse contra una grilla todavía sin renderizar y devolver
  // una lista vacía (índice -1) que parecía "columna no encontrada" sin
  // serlo de verdad.
  await expect(page.locator(".planner-day-head").first()).toBeVisible();
  const todayIndexAfter = await page.locator(".planner-day-head").evaluateAll(
    (heads) => heads.findIndex((h) => h.classList.contains("today"))
  );
  // Corrección de revisión: sin esto, un -1 (columna "today" no encontrada)
  // pasaría desapercibido — Playwright interpreta .nth(-1) como "el último
  // elemento", no como "ningún elemento", así que el test seguiría
  // comprobando UNA celda cualquiera en vez de fallar con un mensaje claro.
  expect(todayIndexAfter).toBeGreaterThanOrEqual(0);
  const lunchRowAfter = page.locator(".planner-meal-row", { hasText: "Comida" });
  const todayLunchCellAfter = lunchRowAfter.locator(".planner-cell").nth(todayIndexAfter);
  await expect(todayLunchCellAfter.locator(".planner-cell-plus")).toBeVisible(); // vacío otra vez, no huérfano
});

test("cancelar el diálogo nativo de borrado conserva la receta tras recargar (E21-XX)", async ({ page }) => {
  await createCustomRecipe(page);

  await page.goto("/dashboard/recipes");
  const card = page.locator(".recipe-card", { hasText: RECIPE_TITLE });

  page.once("dialog", (dialog) => dialog.dismiss());
  await card.getByRole("button", { name: `Eliminar receta ${RECIPE_TITLE}` }).click();

  // Nada se llegó a mutar: ni toast, ni desaparición.
  await expect(card).toBeVisible();

  await page.reload();
  await expect(page.locator(".recipe-card", { hasText: RECIPE_TITLE })).toBeVisible();
});
