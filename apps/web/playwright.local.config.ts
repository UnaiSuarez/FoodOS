import { defineConfig, devices } from "@playwright/test";

// Solo local (no se commitea): Edge instalado + servidor de producción ya construido.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://localhost:3061", trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "msedge" } }],
  webServer: {
    command: "node node_modules/next/dist/bin/next start -p 3061",
    url: "http://localhost:3061",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" },
  },
});
