// Helper COMPARTIDO de prueba (nunca exportado desde el barrel público del
// paquete — solo lo importan archivos *.test.ts) que confirma que
// apps/web/src no cruza la frontera hacia este paquete de kernels puros,
// salvo por una lista explícita y corta de excepciones autorizadas.
//
// Antes de esta extracción, seis archivos de kernel llevaban cada uno su
// propia copia LITERAL de este escaneo (mismo `walkSourceFiles`, mismo
// `offenders`, sin un lugar único donde editarlos todos a la vez) — un
// riesgo real en el momento en que hacía falta añadir la MISMA excepción a
// las seis a la vez: una copia desincronizada del resto habría dejado un
// hueco silencioso. Esta es la única implementación; cada *-kernel.test.ts
// (incluido nutrient-coverage-kernel.test.ts, que hasta ahora no tenía
// ninguna copia de esta prueba) la llama con la misma lista de excepciones.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_PACKAGE_NAME_PATTERN = /@foodos\/engine/;
export const ENGINE_RELATIVE_PATH_PATTERN = /packages\/engine/;

/**
 * Raíz del repositorio a partir de `import.meta.url` de un archivo de test
 * en packages/engine/src — mismo cálculo que ya hacía cada copia dispersa
 * (`dirname(fileURLToPath(import.meta.url))` + subir tres niveles).
 */
export function repoRootFrom(testFileUrl: string): string {
  const here = dirname(fileURLToPath(testFileUrl));
  return join(here, "..", "..", "..");
}

export function walkSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Rutas (relativas a apps/web/src, con "/" como separador, p. ej.
 * "lib/nutrition-v4-coverage-gateway.ts") autorizadas a mencionar el
 * paquete — hoy, exactamente una: el gateway explícito de Nutrition v4.
 * Un archivo fuera de esta lista que mencione el paquete sigue fallando
 * exactamente igual que antes de esta excepción.
 */
export const WEB_ENGINE_ALLOWLIST: readonly string[] = ["lib/nutrition-v4-coverage-gateway.ts"];

/**
 * Archivos de apps/web/src que mencionan el paquete de kernels COMO
 * SUBCADENA DE TEXTO, excluyendo los de `allowlist`. Cubre imports
 * estáticos, `import()` dinámico, `require()`, y cualquier alias cuyo
 * destino real se escriba con una de esas dos cadenas — no analiza la
 * sintaxis de cada archivo por separado.
 *
 * LÍMITES EXPLÍCITOS (heredados de las copias originales): no ejecuta el
 * resolutor de módulos real de Node/TypeScript/Next, así que un mecanismo
 * de resolución suficientemente indirecto (nombre de paquete construido en
 * tiempo de ejecución, leído de una variable de entorno) podría escapar a
 * esta búsqueda por texto. Es una fotografía del estado actual del
 * repositorio, no una frontera técnica infalible — complementa, no
 * sustituye, a las pruebas de comportamiento del gateway y del panel.
 */
export function findWebSrcBoundaryOffenders(repoRoot: string, allowlist: readonly string[] = WEB_ENGINE_ALLOWLIST): string[] {
  const webSrcPath = join(repoRoot, "apps", "web", "src");
  const allowedSet = new Set(allowlist);
  const files = walkSourceFiles(webSrcPath);
  return files.filter((f) => {
    const relPath = relative(webSrcPath, f).split(sep).join("/");
    if (allowedSet.has(relPath)) return false;
    const content = readFileSync(f, "utf-8");
    return ENGINE_PACKAGE_NAME_PATTERN.test(content) || ENGINE_RELATIVE_PATH_PATTERN.test(content);
  });
}
