import { defineConfig, devices } from "@playwright/test";

/**
 * E21-01: configuración de Playwright para los flujos críticos de FoodOS.
 *
 * Corre siempre en modo "local-only": sin NEXT_PUBLIC_SUPABASE_URL/ANON_KEY
 * definidas, hasSupabaseConfig() devuelve false y la app funciona sin
 * autenticación, guardando todo en localStorage — así los tests no
 * necesitan una cuenta de prueba real ni credenciales de Supabase en CI, y
 * cada test arranca desde un estado limpio (contexto de navegador nuevo).
 * En CI esto pasa "gratis" porque esas variables de entorno nunca se
 * definen para el job; en local, evitar tener un .env.local activo al
 * lanzar `npm run test:e2e` (o usar `env -u` / un perfil sin esas vars).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Vacías a propósito: fuerza modo local-only aunque exista un
      // .env.local con credenciales reales en la máquina donde se lance.
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    },
  },
});
