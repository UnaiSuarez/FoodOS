import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

/**
 * E21-18: comprobación Axe automatizada — antes todo el trabajo de
 * accesibilidad de esta sesión (E18-06 a E18-14) se verificaba a mano en
 * cada PR, sin nada que impidiera que un cambio futuro reintrodujera un
 * error grave sin que nadie se enterara hasta que alguien lo notara con un
 * lector de pantalla real.
 *
 * Solo bloquea por violaciones "critical"/"serious" (no "moderate"/"minor")
 * — igual que la mayoría de integraciones de Axe en CI: los niveles bajos
 * suelen incluir advertencias subjetivas o casos límite que conviene
 * revisar a mano de vez en cuando (E18-17/E18-18), no en cada PR; bloquear
 * por esos desde el día uno haría el check tan ruidoso que se acabaría
 * ignorando o desactivando.
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

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  if (serious.length > 0) {
    const detail = serious
      .map((v) => `- [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} elemento/s)\n  ${v.helpUrl}`)
      .join("\n");
    throw new Error(`Violaciones Axe graves en ${page.url()}:\n${detail}`);
  }
}

const VIEWS = [
  "/dashboard",
  "/dashboard/diary",
  "/dashboard/inventory",
  "/dashboard/recipes",
  "/dashboard/cart",
  "/dashboard/nutrition",
  "/dashboard/finance",
  "/dashboard/stats",
  "/dashboard/planner",
  "/dashboard/ejercicios",
  "/dashboard/assistant",
  "/dashboard/settings",
];

for (const path of VIEWS) {
  test(`sin violaciones Axe graves en ${path}`, async ({ page }) => {
    await seedDemo(page);
    await page.goto(path);
    await expectNoSeriousViolations(page);
  });
}

test("sin violaciones Axe graves con un modal abierto (LogMealModal)", async ({ page }) => {
  await seedDemo(page);
  await page.goto("/dashboard/diary");
  await page.getByRole("button", { name: "¿Qué has comido?" }).click();
  await expect(page.getByRole("dialog", { name: "¿Qué has comido?" })).toBeVisible();
  await expectNoSeriousViolations(page);
});
