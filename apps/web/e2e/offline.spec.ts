import { test, expect, type Page } from "@playwright/test";

/**
 * E21-13: offline y reconexión — DashboardShell escucha los eventos nativos
 * online/offline (ver useEffect en DashboardShell.tsx) y muestra un banner
 * mientras no hay red. En modo local-only (sin Supabase, que es como corre
 * toda esta suite — ver playwright.config.ts) el guardado NUNCA depende de
 * la red: cada mutate() escribe en localStorage de inmediato
 * (saveLocalStateDebounced), así que "los cambios pendientes se
 * sincronizan una vez" se traduce aquí en "un cambio hecho sin conexión no
 * se pierde ni se corrompe, y sigue ahí al reconectar y recargar" — no hay
 * nada remoto con lo que reconciliar en este modo.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("foodos-ob-done", "1");
    window.localStorage.setItem("foodos-tour-done", "1");
  });
});

async function readState(page: Page): Promise<{ waterLog?: Record<string, number> }> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("foodos-appweb-state-v1") ?? "{}"));
}

test("el banner de sin conexión aparece offline y desaparece al reconectar (E21-13)", async ({ page, context }) => {
  await page.goto("/dashboard");
  await expect(page.locator(".offline-banner")).toBeHidden();

  await context.setOffline(true);
  await expect(page.locator(".offline-banner")).toBeVisible();
  await expect(page.locator(".offline-banner")).toHaveText("Sin conexión — mostrando datos guardados");

  await context.setOffline(false);
  await expect(page.locator(".offline-banner")).toBeHidden();
});

test("un cambio hecho sin conexión se guarda igual y sobrevive a reconectar + recargar (E21-13)", async ({ page, context }) => {
  await page.goto("/dashboard/diary");
  // Espera a que la vista esté realmente lista (no solo la cabecera): en el
  // servidor de desarrollo (npm run dev, ver playwright.config.ts) cada
  // vista es su propio chunk de webpack que se pide la primera vez que se
  // visita — cortar la red (setOffline) antes de que termine de llegar
  // sería un "Loading chunk failed" del propio dev server, no el
  // comportamiento offline real que esta prueba quiere comprobar.
  await expect(page.getByRole("button", { name: "+ Vaso (250 ml)" })).toBeVisible();
  await expect(page.locator(".offline-banner")).toBeHidden();

  await context.setOffline(true);
  await expect(page.locator(".offline-banner")).toBeVisible();

  // Añadir agua es la mutación más directa de la vista (un botón, sin
  // formulario) — bueno para comprobar que mutate()/saveLocalStateDebounced
  // no dependen de la red para nada.
  const before = (await readState(page)).waterLog ?? {};
  await page.getByRole("button", { name: "+ Vaso (250 ml)" }).click();

  await expect.poll(async () => {
    const state = await readState(page);
    const today = Object.keys(state.waterLog ?? {}).find((d) => (state.waterLog![d] ?? 0) > (before[d] ?? 0));
    return today !== undefined;
  }).toBe(true);

  await context.setOffline(false);
  await expect(page.locator(".offline-banner")).toBeHidden();

  await page.reload();
  const after = await readState(page);
  const total = Object.values(after.waterLog ?? {}).reduce((s, v) => s + v, 0);
  const totalBefore = Object.values(before).reduce((s, v) => s + v, 0);
  expect(total).toBeGreaterThan(totalBefore);
});
