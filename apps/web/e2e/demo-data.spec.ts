import { test, expect } from "@playwright/test";

/**
 * E21-01: primer test end-to-end, sirve para probar que el pipeline entero
 * funciona (webServer en modo local-only, sin necesidad de credenciales de
 * Supabase) antes de escribir los flujos críticos de E21-02 y siguientes.
 *
 * Marca "foodos-ob-done" antes de cargar la página: sin perfil de nutrición
 * (seedDemo no lo crea a propósito, ver su comentario en lib/state.tsx) el
 * onboarding se dispara solo, y no es lo que este test comprueba.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("foodos-ob-done", "1");
  });
});

test("cargar datos demo puebla inventario y muestra confirmación", async ({ page }) => {
  await page.goto("/dashboard/settings");

  await page.getByRole("button", { name: "Cargar datos demo" }).click();
  // E04-07 añadió otro role="status" persistente en la cabecera (el
  // indicador de sincronización) — getByRole("status") a secas ya no es
  // único, se acota a la clase del toast.
  await expect(page.locator(".toast")).toHaveText("Datos demo cargados");

  await page.goto("/dashboard/inventory");
  await expect(page.getByText("Pechuga de pollo")).toBeVisible();
  await expect(page.getByText("Arroz integral")).toBeVisible();
});

test("la navegación por dominios agrupa las secciones (E04-01)", async ({ page }) => {
  await page.goto("/dashboard");

  const nav = page.getByRole("navigation", { name: "Navegación de la app" });
  await expect(nav.locator(".nav-group-label")).toHaveText(["Comida", "Finanzas", "Progreso", "Asistente"]);

  await nav.getByRole("button", { name: "Inventario", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/inventory$/);
  await expect(nav.getByRole("button", { name: "Inventario", exact: true })).toHaveAttribute("aria-current", "page");
});
