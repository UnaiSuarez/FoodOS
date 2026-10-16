import { defineConfig, devices } from "@playwright/test";

/**
 * Validación de C0 contra un stack Supabase local DESECHABLE (Supabase CLI + Docker en CI). A diferencia de
 * playwright.config.ts (modo local-only, sin Supabase), aquí la aplicación SÍ se construye con la URL y la clave
 * pública del stack: navegador → supabase-js → Auth/PostgREST → Postgres.
 * Variables (las fija el workflow; nunca se imprimen): STACK_API_URL, STACK_ANON_KEY, STACK_SERVICE_KEY.
 * Un solo worker y en serie: la política de transición es global del stack y las pruebas la cambian.
 */
export default defineConfig({
  testDir: "./e2e-stack",
  testMatch: /.*\.stack\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never", outputFolder: "playwright-stack-report" }]] : "list",
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.STACK_API_URL ?? "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.STACK_ANON_KEY ?? "",
      // Las cuentas QA sintéticas (dominio .invalid, sin buzón) son «admin» SOLO en este servidor desechable: el botón
      // «Cargar datos demo» de Ajustes solo existe para administradores y es la forma de sembrar un perfil sintético.
      NEXT_PUBLIC_ADMIN_EMAILS: ["p", "a1", "b1", "d1", "e1", "f1", "f2"].map((l) => `qa-c0-${process.env.STACK_RUN_ID ?? ""}-${l}@example.invalid`).join(","),
    },
  },
});
