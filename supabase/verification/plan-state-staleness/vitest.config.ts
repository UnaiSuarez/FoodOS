// Config de Vitest SOLO para esta verificación (no es la de apps/web). Ejecuta el código REAL de
// apps/web/src/lib (data-layer, nutrition, state) contra un Postgres aislado; ver README.md.
import { defineConfig } from "vitest/config";
import path from "node:path";

const here = import.meta.dirname;
const web = path.resolve(here, "../../../apps/web");

export default defineConfig({
  root: here,
  resolve: { alias: { "@": path.join(web, "src") } },
  oxc: { jsx: { runtime: "automatic" } },
  server: { fs: { strict: false } },
  test: {
    environment: "node",
    setupFiles: [path.join(web, "vitest.setup.ts")],
    include: ["*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
