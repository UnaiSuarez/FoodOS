import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    // E21-01: e2e/*.spec.ts son tests de Playwright, no de vitest — el
    // patrón por defecto de vitest (**/*.{test,spec}.ts) los recogía
    // igualmente e intentaba ejecutarlos con su propio runner, donde
    // test.beforeEach()/page no existen igual (falla con un error de
    // "did not expect test.beforeEach() to be called here"). Se parte de
    // la lista por defecto de vitest (fijarla a mano la sustituye entera,
    // no la extiende) y se añade e2e/.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier,playwright}.config.*",
      "**/e2e/**",
    ],
  },
});
