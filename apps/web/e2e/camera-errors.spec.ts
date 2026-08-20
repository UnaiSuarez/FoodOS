import { test, expect, type Page } from "@playwright/test";

/**
 * E21-17: errores de cámara — BarcodeScannerModal (InventoryView, botón
 * "📷 Código de barras") distingue varios fallos de getUserMedia() con un
 * mensaje propio para cada uno (permiso denegado, sin cámara, cámara
 * ocupada, navegador sin soporte, error genérico) en vez de un "no
 * funciona" plano — cada mensaje le dice al usuario qué hacer. No había
 * ninguna prueba automática de que cada rama realmente muestra SU mensaje.
 *
 * navigator.mediaDevices.getUserMedia se sustituye vía addInitScript antes
 * de cualquier script de la página — no hay forma de forzar cada tipo de
 * fallo con una cámara real en CI, y no hace falta: BarcodeScannerModal
 * solo mira err.name (DOMException), así que sustituir la API por una que
 * rechaza con el DOMException exacto prueba la misma rama de código que
 * probaría un fallo real.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("foodos-ob-done", "1");
    window.localStorage.setItem("foodos-tour-done", "1");
  });
});

async function openScanner(page: Page) {
  await page.goto("/dashboard/inventory");
  await page.getByRole("button", { name: "📷 Código de barras" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("navegador sin soporte de cámara muestra su propio aviso (E21-17)", async ({ page }) => {
  await page.addInitScript(() => {
    // navigator.mediaDevices es de solo lectura en el IDL del navegador —
    // "navigator.mediaDevices = x" falla en silencio sin Object.defineProperty
    // (no lanza, simplemente no hace nada, dejando la API real intacta).
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  });
  await openScanner(page);
  await page.getByRole("button", { name: /Activar cámara/i }).click();
  await expect(page.getByText("Este navegador no permite acceder a la cámara. Introduce el código manualmente.")).toBeVisible();
});

const ERROR_CASES: Array<{ domName: string; expectedText: string }> = [
  {
    domName: "NotAllowedError",
    expectedText: "Permiso de cámara denegado. Revisa los permisos del sitio en los ajustes de tu navegador (icono de candado/cámara junto a la URL) y vuelve a intentarlo.",
  },
  {
    domName: "NotFoundError",
    expectedText: "No se encontró ninguna cámara en este dispositivo. Introduce el código manualmente.",
  },
  {
    domName: "OverconstrainedError",
    expectedText: "No se encontró ninguna cámara en este dispositivo. Introduce el código manualmente.",
  },
  {
    domName: "NotReadableError",
    expectedText: "La cámara ya está en uso por otra app o pestaña. Cierra esa app y vuelve a intentarlo.",
  },
  {
    domName: "AbortError",
    expectedText: "No se pudo acceder a la cámara. Introduce el código manualmente.",
  },
];

for (const { domName, expectedText } of ERROR_CASES) {
  test(`getUserMedia rechaza con ${domName} muestra el mensaje correcto (E21-17)`, async ({ page }) => {
    await page.addInitScript((name) => {
      // Object.defineProperty, no asignación directa — ver el comentario del
      // primer test de este archivo (navigator.mediaDevices es de solo lectura).
      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: () => Promise.reject(new DOMException("simulado en pruebas", name)) },
        configurable: true,
      });
    }, domName);
    await openScanner(page);
    await page.getByRole("button", { name: /Activar cámara/i }).click();
    await expect(page.getByText(expectedText)).toBeVisible();
  });
}

test("tras un error, el código se puede seguir introduciendo a mano (E21-17)", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: () => Promise.reject(new DOMException("simulado", "NotFoundError")) },
      configurable: true,
    });
  });
  await openScanner(page);
  await page.getByRole("button", { name: /Activar cámara/i }).click();
  await expect(page.getByText("No se encontró ninguna cámara en este dispositivo. Introduce el código manualmente.")).toBeVisible();

  // El fallo de cámara no debe bloquear la vía manual — sigue habiendo un
  // campo de texto utilizable para el código de barras.
  const manualInput = page.getByLabel("Código de barras");
  await expect(manualInput).toBeEditable();
  await manualInput.fill("8410188052028");
  await expect(manualInput).toHaveValue("8410188052028");
});
