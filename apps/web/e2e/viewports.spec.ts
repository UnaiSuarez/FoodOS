import { test, expect, type Page } from "@playwright/test";

/**
 * E21-12: viewports móviles — 320/375/390/430 (los anchos de CSS más
 * habituales entre iPhone SE, iPhone 12-15 estándar/Pro Max y Android
 * medios) y una tablet en retrato (768). Comprueba lo que un audit manual
 * de layout no puede dejar como regresión: que ninguna vista fuerza scroll
 * horizontal de página completa (síntoma clásico de un ancho fijo que se
 * escapó de algún componente) y que la navegación móvil (barra inferior)
 * aparece en los anchos de teléfono y desaparece en tablet, donde el
 * sidebar de escritorio ya cabe.
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

const PHONE_WIDTHS = [320, 375, 390, 430];
const VIEWS = ["/dashboard", "/dashboard/inventory", "/dashboard/recipes", "/dashboard/cart", "/dashboard/nutrition", "/dashboard/finance"];

for (const width of PHONE_WIDTHS) {
  test.describe(`${width}px de ancho`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const path of VIEWS) {
      test(`${path} no fuerza scroll horizontal (E21-12)`, async ({ page }) => {
        await seedDemo(page);
        await page.goto(path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${path} a ${width}px: scrollWidth desborda ${overflow}px de innerWidth`).toBeLessThanOrEqual(1);
      });
    }

    test(`la barra de navegación inferior está visible a ${width}px (E21-12)`, async ({ page }) => {
      await seedDemo(page);
      await page.goto("/dashboard");
      await expect(page.locator(".bottom-tab-bar")).toBeVisible();
    });
  });
}

test.describe("tablet en retrato (768px)", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  for (const path of VIEWS) {
    test(`${path} no fuerza scroll horizontal (E21-12)`, async ({ page }) => {
      await seedDemo(page);
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} a 768px: scrollWidth desborda ${overflow}px de innerWidth`).toBeLessThanOrEqual(1);
    });
  }

  test("la barra de navegación inferior NO está visible a 768px — cabe el sidebar (E21-12)", async ({ page }) => {
    await seedDemo(page);
    await page.goto("/dashboard");
    await expect(page.locator(".bottom-tab-bar")).toBeHidden();
  });
});
