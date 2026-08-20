import { test, expect, type Page } from "@playwright/test";

/**
 * E21-02 a E21-08: los flujos conectados que hacen diferencial a FoodOS —
 * cocinar descuenta inventario, borrar una comida se puede deshacer del
 * todo, el plan solo añade lo que falta a la lista, una compra llega
 * consistente a inventario y finanzas, y los guardarraíles de seguridad
 * nutricional (< 800 kcal, déficit agresivo) no tienen atajo.
 *
 * Mismo patrón que demo-data.spec.ts: marca el onboarding/tour como ya
 * vistos para que no se disparen solos, y parte de los datos demo
 * (seedDemo) en vez de construir estado a mano en cada test.
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
  // E04-07 añadió otro role="status" persistente en la cabecera (el
  // indicador de sincronización) — getByRole("status") a secas ya no es
  // único, se acota a la clase del toast.
  await expect(page.locator(".toast")).toHaveText("Datos demo cargados");
}

test("cocinar una receta descuenta la cantidad correcta de cada ingrediente (E21-02)", async ({ page }) => {
  await seedDemo(page);

  // Bowl proteico de pollo pide 180g pechuga, 80g arroz integral y 100g
  // tomate cherry — los datos demo tienen 260g/500g/180g de cada uno.
  await page.goto("/dashboard/recipes");
  const card = page.locator(".recipe-card", { hasText: "Bowl proteico de pollo" });
  await card.getByRole("button", { name: "Cocinar" }).click();

  const modal = page.getByRole("dialog", { name: "Cocinar: Bowl proteico de pollo" });
  await expect(modal.getByRole("checkbox", { name: "Descontar ingredientes del inventario al cocinar" })).toBeChecked();
  await modal.getByRole("button", { name: "Cocinar 1 ración" }).click();

  await expect(page.locator(".toast")).toHaveText("Bowl proteico de pollo cocinado (1 ración)");

  await page.goto("/dashboard/inventory");
  await expect(page.locator(".card", { hasText: "Pechuga de pollo" }).locator("small")).toContainText("80g");
  await expect(page.locator(".card", { hasText: "Arroz integral" }).locator("small")).toContainText("420g");
  await expect(page.locator(".card", { hasText: "Tomate cherry" }).locator("small")).toContainText("80g");

  // El diario refleja la comida recién cocinada con las macros de la receta.
  await page.goto("/dashboard/diary");
  await expect(page.getByText("Bowl proteico de pollo").first()).toBeVisible();
});

/** Lee la cantidad actual de un producto directamente del estado
    persistido, sin navegar — navegar (page.goto) es una recarga completa
    del navegador y se llevaría por delante el toast de "Deshacer", que
    solo vive en memoria de React. */
async function inventoryQty(page: Page, name: string): Promise<number | undefined> {
  return page.evaluate((itemName) => {
    const raw = JSON.parse(localStorage.getItem("foodos-appweb-state-v1") ?? "{}");
    return raw.inventory?.find((i: { name: string }) => i.name === itemName)?.qty;
  }, name);
}

test("borrar una comida y deshacer restaura diario e inventario juntos (E21-03)", async ({ page }) => {
  await seedDemo(page);

  // Registra 100g de pechuga de pollo desde inventario (260g -> 160g).
  await page.goto("/dashboard/diary");
  await page.getByRole("button", { name: "¿Qué has comido?" }).click();
  const modal = page.getByRole("dialog", { name: "¿Qué has comido?" });
  await modal.getByLabel("Filtrar alimentos").fill("Pechuga");
  const row = modal.locator(".lm-inv-row", { hasText: "Pechuga de pollo" });
  await row.click();
  await row.locator(".lm-inv-qty input").fill("100");
  await modal.getByRole("button", { name: /Registrar/ }).click();

  await expect.poll(() => inventoryQty(page, "Pechuga de pollo")).toBe(160);
  await expect(page.locator("li", { hasText: "Pechuga de pollo" })).toBeVisible();

  // Borra la entrada — sin navegar entretanto, para no perder el toast.
  const entryRow = page.locator("li", { hasText: "Pechuga de pollo" }).first();
  await entryRow.getByRole("button", { name: /^Borrar/ }).click();

  // E04-07 añadió otro role="status" persistente en la cabecera — se acota
  // al toast por clase para no chocar con él.
  const undoToast = page.locator(".toast");
  await expect(undoToast).toContainText("Comida eliminada");
  await expect(page.locator("li", { hasText: "Pechuga de pollo" })).toHaveCount(0);
  // El borrado ya devuelve la cantidad al inventario, sin necesitar deshacer.
  await expect.poll(() => inventoryQty(page, "Pechuga de pollo")).toBe(260);

  // Deshacer debe restaurar AMBAS cosas a como estaban justo antes de
  // borrar: la entrada de vuelta en el diario y el inventario a 160g otra
  // vez (no a 260g, que sería perder la comida registrada).
  await undoToast.getByRole("button", { name: "Deshacer" }).click();
  await expect(page.locator("li", { hasText: "Pechuga de pollo" })).toBeVisible();
  await expect.poll(() => inventoryQty(page, "Pechuga de pollo")).toBe(160);
});

test("la lista de compra del plan solo añade lo que falta de verdad (E21-04)", async ({ page }) => {
  // El plan semanal automático (generateWeeklyPlan) depende de un perfil
  // físico; en vez de rellenar el formulario completo (mucha superficie
  // para lo que este test comprueba), se inyecta el mínimo necesario junto
  // a un inventario controlado: mucho arroz (para que NUNCA falte, pase lo
  // que pase el plan de esa semana) y nada de pollo (para que SIEMPRE
  // falte, dado que solo hay 4 recetas fijas en recipes.ts y "Bowl
  // proteico de pollo" — la única con pollo — acaba entrando en cualquier
  // semana de 21 comidas cicladas entre esas 4).
  await page.addInitScript(() => {
    const state = {
      inventory: [
        { id: "arroz", name: "Arroz integral", qty: 50000, unit: "g", storage: "Despensa", expires: "2099-01-01", price: 1.7, kcal: 360, protein: 8 },
      ],
      cart: [],
      profile: {
        age: 30, sex: "male", heightCm: 178, weightKg: 78, bodyFatPct: null,
        activityLevel: "moderate", goal: "maintain", gymDays: [1, 3, 5],
        allergies: [], excludedFoods: [],
      },
    };
    window.localStorage.setItem("foodos-appweb-state-v1", JSON.stringify(state));
  });

  await page.goto("/dashboard/cart");
  // El panel de sugerencias arranca ya abierto (suggestOpen=true por
  // defecto) — solo hace falta cambiar a la pestaña del plan.
  await page.getByRole("button", { name: "📅 Del plan semanal" }).click();

  const suggestList = page.locator(".suggest-list");
  await expect(suggestList.locator(".suggest-name", { hasText: "pechuga de pollo" })).toBeVisible();
  await expect(suggestList.locator(".suggest-name", { hasText: "arroz integral" })).toHaveCount(0);
});

test("completar una compra llega consistente a inventario y finanzas (E21-05)", async ({ page }) => {
  await seedDemo(page);

  // Los datos demo traen "Avena" en el carrito, sin marcar.
  await page.goto("/dashboard/cart");
  const avenaRow = page.locator(".card", { hasText: "Avena" });
  await avenaRow.getByRole("button", { name: "Marcar" }).click();
  await page.getByRole("button", { name: "Completar compra" }).click();

  // Repaso (E10-03): confirma el precio real, distinto del estimado.
  const review = page.getByRole("dialog", { name: "Revisar compra" });
  await expect(review.locator(".review-purchase-name", { hasText: "Avena" })).toBeVisible();
  await review.locator(".review-purchase-row input[type=number]").fill("2.10");
  await review.getByRole("button", { name: "Confirmar compra" }).click();

  await expect(page.locator(".toast")).toHaveText("Compra completada");

  // El carrito ya no tiene el item comprado.
  await expect(page.locator(".card", { hasText: "Avena" })).toHaveCount(0);

  // Inventario y Finanzas reciben el precio REAL confirmado, no el
  // estimado — expect.poll porque el guardado en localStorage está
  // debounced (saveLocalStateDebounced), no es síncrono con el mutate.
  async function readState() {
    return page.evaluate(() => JSON.parse(localStorage.getItem("foodos-appweb-state-v1") ?? "{}"));
  }
  await expect.poll(async () => (await readState()).inventory.some((i: { name: string }) => i.name === "Avena")).toBe(true);
  const state = await readState();
  const avenaInInventory = state.inventory.find((i: { name: string }) => i.name === "Avena");
  expect(avenaInInventory.price).toBe(2.1);
  const lastExpense = state.expenses[state.expenses.length - 1];
  expect(lastExpense.amount).toBe(2.1);
  expect(lastExpense.category).toBe("Comida");

  await page.goto("/dashboard/inventory");
  await expect(page.locator(".card", { hasText: "Avena" })).toBeVisible();

  await page.goto("/dashboard/finance");
  await expect(page.getByText("Compra completada desde carrito").first()).toBeVisible();
});

test("cambiar el perfil nutricional recalcula y muestra los nuevos objetivos (E21-06)", async ({ page }) => {
  await page.goto("/dashboard/nutrition");

  await page.getByLabel("Edad").fill("30");
  await page.getByLabel("Sexo biológico").selectOption("male");
  await page.getByLabel("Altura (cm)").fill("178");
  await page.getByLabel("Peso (kg)").fill("78");
  await page.getByLabel("Nivel de actividad").selectOption("moderate");
  await page.getByRole("button", { name: /Mantenimiento/ }).click();
  await page.getByRole("button", { name: "Calcular mis objetivos" }).click();

  await expect(page.getByText("Tu plan diario")).toBeVisible();
  const objetivoKcal = page.locator('span:text-is("Objetivo hoy")').locator("xpath=following-sibling::strong");
  const beforeKcal = await objetivoKcal.textContent();
  expect(Number(beforeKcal)).toBeGreaterThan(1200);

  // Cambiar el peso recalcula el objetivo mostrado (TMB/TDEE ya no son los
  // mismos que antes del cambio).
  await page.getByRole("button", { name: "Editar perfil" }).click();
  await page.getByLabel("Peso (kg)").fill("95");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  const afterKcal = await objetivoKcal.textContent();
  expect(afterKcal).not.toBe(beforeKcal);
});

test("un déficit agresivo pide confirmación explícita antes de guardar (E21-08)", async ({ page }) => {
  // El factor automático (kcalFactor) nunca resta más de un 20% del TDEE
  // por sí solo — para reproducir un déficit >30% (el guardarraíl real,
  // ya cubierto a nivel de unidad en nutrition.test.ts) hace falta un
  // ajuste adicional. adaptiveKcalOffsetKcal es justo ese campo: un ajuste
  // en kcal/día que el perfil ya conserva (ver el comentario de save() en
  // NutritionView.tsx) aunque todavía no haya UI para fijarlo a mano — se
  // inyecta aquí para probar el camino real formulario -> guardarraíl.
  await page.addInitScript(() => {
    const state = {
      profile: {
        age: 30, sex: "male", heightCm: 178, weightKg: 78, bodyFatPct: null,
        activityLevel: "moderate", goal: "maintain", gymDays: [1, 3, 5],
        allergies: [], excludedFoods: [], adaptiveKcalOffsetKcal: -900,
      },
    };
    window.localStorage.setItem("foodos-appweb-state-v1", JSON.stringify(state));
  });

  await page.goto("/dashboard/nutrition");
  await page.getByRole("button", { name: "Editar perfil" }).click();
  // Reenvía el formulario tal cual (mismos datos) para disparar el
  // recálculo con el ajuste ya cargado.
  await page.getByRole("button", { name: "Guardar cambios" }).click();

  const confirmDialog = page.getByRole("dialog", { name: "Revisa tu déficit antes de continuar" });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText("déficit");

  // Cancelar no debe aplicar el cambio ni romper nada. El formulario de
  // edición sigue abierto detrás del diálogo (cerrar el diálogo no lo
  // cierra a él), así que "Guardar cambios" sigue ahí para reintentar.
  await confirmDialog.getByRole("button", { name: "← Revisar los datos" }).click();
  await expect(confirmDialog).toBeHidden();

  // Confirmar explícitamente sí lo aplica.
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await page.getByRole("dialog", { name: "Revisa tu déficit antes de continuar" })
    .getByRole("button", { name: "Guardar de todos modos" })
    .click();
  await expect(page.getByRole("dialog", { name: "Revisa tu déficit antes de continuar" })).toBeHidden();
  await expect(page.getByText("Tu plan diario")).toBeVisible();
});
