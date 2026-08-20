import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

/**
 * E21-10: tema claro y oscuro — la app tiene los dos (alternable desde
 * Ajustes, persistido en localStorage["foodos-theme"], aplicado como
 * document.documentElement.dataset.theme, ver DashboardShell.tsx). Un color
 * fijo (hex hardcodeado en vez de var(--...)) que se ve bien en un tema
 * puede quedar sin contraste suficiente — o directamente invisible, texto
 * del mismo color que su fondo — en el otro. axe-core con la regla
 * color-contrast sola (más rápido que un escaneo completo, y es
 * exactamente el tipo de fallo que un color fijo incompatible produce) en
 * un puñado de vistas representativas, en AMBOS temas.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("foodos-ob-done", "1");
    window.localStorage.setItem("foodos-tour-done", "1");
  });
});

async function seedDemo(page: Page) {
  await page.goto("/dashboard/settings");
  await page.getByRole("button", { name: "Cargar datos demo" }).click();
  await expect(page.locator(".toast")).toHaveText("Datos demo cargados");
}

async function expectNoContrastViolations(page: Page, theme: "dark" | "light") {
  const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  if (results.violations.length > 0) {
    const detail = results.violations
      .map((v) => `- ${v.help} (${v.nodes.length} elemento/s)\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`)
      .join("\n");
    throw new Error(`Contraste insuficiente en tema ${theme}, ${page.url()}:\n${detail}`);
  }
}

const VIEWS = ["/dashboard", "/dashboard/inventory", "/dashboard/recipes", "/dashboard/finance", "/dashboard/nutrition", "/dashboard/settings", "/dashboard/ejercicios"];

for (const theme of ["dark", "light"] as const) {
  test.describe(`tema ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => {
        window.localStorage.setItem("foodos-theme", t);
      }, theme);
    });

    for (const path of VIEWS) {
      test(`sin problemas de contraste en ${path} (E21-10)`, async ({ page }) => {
        await seedDemo(page);
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expectNoContrastViolations(page, theme);
      });
    }
  });
}

test("el interruptor de tema cambia data-theme y persiste tras recargar (E21-10)", async ({ page }) => {
  await page.goto("/dashboard/settings");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "☀ Claro" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
