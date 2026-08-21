import { test, expect } from "@playwright/test";

/**
 * E18-17: flujos principales realizables sin ratón. locator.focus() sitúa
 * el foco en el punto de partida (equivalente a "el usuario ya llegó aquí
 * tabulando" — comprobar el ORDEN exacto de tabulación de toda la app es
 * una auditoría aparte, más exhaustiva); desde ahí, cada interacción que
 * de verdad importa (activar, cerrar, moverse dentro de un widget) se hace
 * con page.keyboard.press(...), eventos de teclado reales, no clics.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("foodos-ob-done", "1");
    window.localStorage.setItem("foodos-tour-done", "1");
  });
});

test("navegar entre secciones del nav solo con Tab/Enter (E18-17)", async ({ page }) => {
  await page.goto("/dashboard");
  const nav = page.getByRole("navigation", { name: "Navegación de la app" });

  await nav.getByRole("button", { name: "Inventario", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard\/inventory$/);
  await expect(nav.getByRole("button", { name: "Inventario", exact: true })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("button", { name: "Recetas", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard\/recipes$/);
});

test("abrir y cerrar un modal solo con teclado devuelve el foco a quien lo abrió (E18-17)", async ({ page }) => {
  await page.goto("/dashboard/diary");
  const openButton = page.getByRole("button", { name: "¿Qué has comido?" });

  await openButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "¿Qué has comido?" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "¿Qué has comido?" })).toBeHidden();
  // Modal.tsx devuelve el foco al elemento que abrió el diálogo (E18-03) —
  // sin esto, cerrar con Escape deja al usuario de teclado "perdido" en el
  // documento, sin saber dónde está el foco.
  await expect(openButton).toBeFocused();
});

test("las pestañas ARIA de Nutrición se navegan con flechas, no solo con Tab (E18-17)", async ({ page }) => {
  await page.goto("/dashboard/nutrition");
  await page.addInitScript(() => {
    const state = {
      profile: {
        age: 30, sex: "male", heightCm: 178, weightKg: 78, bodyFatPct: null,
        activityLevel: "moderate", goal: "maintain", gymDays: [1, 3, 5],
        allergies: [], excludedFoods: [],
      },
    };
    window.localStorage.setItem("foodos-appweb-state-v1", JSON.stringify(state));
  });
  await page.reload();

  const tablist = page.getByRole("tablist", { name: "Secciones de Nutrición" });
  const hoyTab = tablist.getByRole("tab", { name: "Hoy" });
  await expect(hoyTab).toHaveAttribute("aria-selected", "true");

  await hoyTab.focus();
  await page.keyboard.press("ArrowRight");

  const pesoTab = tablist.getByRole("tab", { name: "Peso" });
  await expect(pesoTab).toHaveAttribute("aria-selected", "true");
  await expect(pesoTab).toBeFocused();
  await expect(page.getByRole("tabpanel", { name: "Peso" })).toBeVisible();
});
