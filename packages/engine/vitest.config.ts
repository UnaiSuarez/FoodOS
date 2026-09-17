import { defineConfig } from "vitest/config";

// Paquete de logica pura (sin DOM, sin React) — entorno "node" simple,
// sin setupFiles ni transformacion JSX, a diferencia de apps/web/vitest.config.ts.
export default defineConfig({
  test: {
    environment: "node",
  },
});
