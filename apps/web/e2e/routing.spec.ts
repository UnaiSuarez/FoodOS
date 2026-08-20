import { test, expect } from "@playwright/test";

/**
 * E21-09: navegación por rutas — cada sección del dashboard tiene su
 * propia URL (E01), así que recargar, usar Atrás/Adelante del navegador o
 * entrar directamente por un enlace profundo debe llevar a la misma vista
 * que muestra el nav, no siempre a "Panel".
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("foodos-ob-done", "1");
    window.localStorage.setItem("foodos-tour-done", "1");
  });
});

test("un enlace profundo entra directamente en esa vista (E21-09)", async ({ page }) => {
  await page.goto("/dashboard/inventory");
  await expect(page).toHaveURL(/\/dashboard\/inventory$/);
  await expect(page.getByRole("heading", { name: "Inventario", level: 1 })).toBeVisible();
  // El nav marca la sección activa — confirma que no es solo la URL la que
  // cambió, la propia app sabe en qué vista está.
  const nav = page.getByRole("navigation", { name: "Navegación de la app" });
  await expect(nav.getByRole("button", { name: "Inventario" })).toHaveAttribute("aria-current", "page");
});

test("recargar mantiene la misma vista, no vuelve a Panel (E21-09)", async ({ page }) => {
  await page.goto("/dashboard/finance");
  await expect(page.getByRole("heading", { name: "Finanzas", level: 1 })).toBeVisible();

  await page.reload();

  await expect(page).toHaveURL(/\/dashboard\/finance$/);
  await expect(page.getByRole("heading", { name: "Finanzas", level: 1 })).toBeVisible();
});

test("Atrás/Adelante del navegador funcionan entre vistas (E21-09)", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Panel diario", level: 1 })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Navegación de la app" });
  await nav.getByRole("button", { name: "Inventario" }).click();
  await expect(page).toHaveURL(/\/dashboard\/inventory$/);

  await nav.getByRole("button", { name: "Recetas" }).click();
  await expect(page).toHaveURL(/\/dashboard\/recipes$/);

  // Atrás: Recetas -> Inventario -> Panel
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard\/inventory$/);
  await expect(page.getByRole("heading", { name: "Inventario", level: 1 })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Panel diario", level: 1 })).toBeVisible();

  // Adelante: Panel -> Inventario -> Recetas
  await page.goForward();
  await expect(page).toHaveURL(/\/dashboard\/inventory$/);

  await page.goForward();
  await expect(page).toHaveURL(/\/dashboard\/recipes$/);
  await expect(page.getByRole("heading", { name: "Recetas", level: 1 })).toBeVisible();
});

test("Ajustes tiene su propia URL y título, fuera del listado de VIEWS (E21-09)", async ({ page }) => {
  await page.goto("/dashboard/settings");
  await expect(page).toHaveURL(/\/dashboard\/settings$/);
  await expect(page.getByRole("heading", { name: "Ajustes de la app", level: 1 })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/dashboard\/settings$/);
  await expect(page.getByRole("heading", { name: "Ajustes de la app", level: 1 })).toBeVisible();
});

test("una URL de sección desconocida cae a Panel en vez de romperse (E21-09)", async ({ page }) => {
  await page.goto("/dashboard/esto-no-existe");
  // DashboardShell resuelve cualquier segmento fuera de VIEWS/"settings" a
  // "dashboard" (ver ViewId en DashboardShell.tsx) — no debe quedar en
  // blanco ni lanzar un error.
  await expect(page.getByRole("heading", { name: "Panel diario", level: 1 })).toBeVisible();
});
