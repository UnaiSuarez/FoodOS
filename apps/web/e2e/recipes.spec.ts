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

/** Planifica la receta en la comida de HOY con la interfaz real y sin depender de la
    distribución (semana o día): buscarla en la biblioteca, «Colocar…», elegir franja
    «Comida» (el día que propone el diálogo es el mostrado, hoy) y confirmar. */
async function planRecipeForToday(page: Page) {
  await page.goto("/dashboard/planner");

  await page.getByLabel("Buscar recetas").fill(RECIPE_TITLE);
  await page.getByRole("button", { name: new RegExp(`^Colocar ${RECIPE_TITLE}`) }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Franja").selectOption("lunch");
  await dialog.getByRole("button", { name: "Colocar", exact: true }).click();

  // Confirma que la UI realmente colocó la receta antes de seguir.
  await expect(page.getByRole("button", { name: new RegExp(`^Cambiar ${RECIPE_TITLE} en Comida del`) })).toBeVisible();
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
  // El hueco de hoy vuelve a estar vacío: ninguna entrada con esa receta (ni ID huérfano)
  // y el «Añadir» de la franja Comida sigue disponible.
  await expect(page.getByRole("button", { name: /^Añadir comida: Comida del/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^Cambiar ${RECIPE_TITLE}`) })).toHaveCount(0);
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
