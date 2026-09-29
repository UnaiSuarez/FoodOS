// PR3 — guarda de INVENTARIO de escritores de `foodLog`. El diseño (§1.4) llegó a
// afirmar «solo 2 escritores» antes de encontrar 8, y esta auditoría encontró un
// noveno (`seedDemo`). Esta prueba recorre el código de producción de
// apps/web/src y falla si aparece cualquier camino NUEVO que cree entradas del
// diario sin haber pasado por el etiquetado de procedencia — así el inventario
// no depende de que alguien se acuerde de volver a buscarlos.
//
// No sustituye a las pruebas de comportamiento de cada escritor
// (state.food-log-provenance.test.tsx, food-log-writers.integration.test.tsx):
// comprueba que no hay otros y que cada uno pasa por un constructor de
// procedencia.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Quita comentarios (sin tocar cadenas con `//` que no sigan a un espacio o al inicio). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[\s;,{}(])\/\/[^\n]*/g, (_m, pre) => pre);
}

function rel(file: string): string {
  return relative(SRC, file).replace(/\\/g, "/");
}

/** Texto de los argumentos de la llamada cuyo `(` está en `openIndex`. */
function callArgs(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return source.slice(openIndex + 1);
}

const files = walk(SRC).map((file) => ({ file: rel(file), source: stripComments(readFileSync(file, "utf8")) }));

/** Cada `foodLog.push(...)`: archivo → nº esperado y lo que su argumento debe contener. */
const PUSH_SITES: Record<string, { count: number; mustContain: RegExp }> = {
  "lib/state.tsx": { count: 3, mustContain: /legacyTotalProvenance\(\)|recipeTotalProvenance\(|inventoryConsumptionProvenance\(|\bprovenance\b/ },
  "components/dashboard/LogMealModal.tsx": { count: 2, mustContain: /buildDishLogEntry\(|buildExternalLogEntry\(/ },
  "components/dashboard/views/HomeView.tsx": { count: 1, mustContain: /buildPlanLogEntry\(/ },
  "components/dashboard/views/PlannerView.tsx": { count: 1, mustContain: /buildPlanLogEntry\(/ },
  "components/dashboard/views/SettingsView.tsx": { count: 1, mustContain: /syntheticSeedMealsForDate\(/ },
};

/** Asignaciones `x.foodLog = <rhs>`: solo estas formas de rhs, y las que CREAN están enumeradas. */
const NON_CREATING_RHS = [/^(draft|next|state)\.foodLog\.(filter|map)\(/, /^structuredClone\(/];
const CREATING_ASSIGNMENTS: Array<{ file: string; rhs: RegExp; why: string }> = [
  { file: "lib/state.tsx", rhs: /^buildDemoFoodLog\(/, why: "'Cargar datos demo': todas las filas synthetic:true" },
  { file: "lib/data-layer.ts", rhs: /^\(logRes\.data/, why: "hidratación desde Supabase: restaura la procedencia guardada en client_meta" },
];

describe("inventario de escritores de foodLog (AC17 + el noveno escritor)", () => {
  it("los `foodLog.push(...)` de producción son exactamente los esperados, y cada uno pasa por un constructor de procedencia", () => {
    const found: Record<string, number> = {};
    for (const { file, source } of files) {
      for (const m of source.matchAll(/\bfoodLog\s*\.\s*(push|unshift|splice|concat)\s*\(/g)) {
        found[file] = (found[file] ?? 0) + 1;
        const site = PUSH_SITES[file];
        expect(site, `Nuevo escritor de foodLog sin cubrir en ${file} (${m[1]}): etiquétalo con food-log-provenance.ts y añádelo aquí`).toBeDefined();
        const args = callArgs(source, m.index! + m[0].length - 1);
        expect(args, `${file}: este foodLog.${m[1]}(...) no pasa por un constructor de procedencia`).toMatch(site.mustContain);
      }
    }
    for (const [file, { count }] of Object.entries(PUSH_SITES)) {
      expect(found[file], `${file}: se esperaban ${count} escritor(es) de foodLog`).toBe(count);
    }
    // 3 (state.tsx) + 2 (LogMealModal) + HomeView + PlannerView + SettingsView = los 8 del diseño (§1.4).
    expect(Object.values(found).reduce((a, b) => a + b, 0)).toBe(8);
  });

  it("las asignaciones a foodLog solo filtran/restauran, o son una de las dos que crean entradas y están enumeradas", () => {
    const creating: string[] = [];
    for (const { file, source } of files) {
      for (const m of source.matchAll(/\bfoodLog\s*=(?!=)\s*/g)) {
        const rhs = source.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
        if (NON_CREATING_RHS.some((r) => r.test(rhs))) continue;
        const allowed = CREATING_ASSIGNMENTS.find((a) => a.file === file && a.rhs.test(rhs));
        expect(allowed, `Asignación nueva a foodLog en ${file}: «${rhs.trim().slice(0, 50)}…» — ¿crea entradas sin procedencia?`).toBeDefined();
        creating.push(`${file}: ${allowed!.why}`);
      }
    }
    expect(creating.sort()).toEqual([
      "lib/data-layer.ts: hidratación desde Supabase: restaura la procedencia guardada en client_meta",
      "lib/state.tsx: 'Cargar datos demo': todas las filas synthetic:true",
    ]);
  });

  it("ningún literal de objeto crea un foodLog con contenido (solo el estado inicial vacío)", () => {
    for (const { file, source } of files) {
      for (const m of source.matchAll(/\bfoodLog\s*:\s*\[/g)) {
        const after = source.slice(m.index! + m[0].length, m.index! + m[0].length + 2).trim();
        expect(after.startsWith("]"), `${file}: literal foodLog: [ ... ] con contenido`).toBe(true);
      }
    }
  });

  it("la migración de consumedMeals y el historial demo etiquetan cada fila que crean", () => {
    const state = files.find((f) => f.file === "lib/state.tsx")!.source;
    // migración: el push dentro de normalizeState lleva legacyTotalProvenance()
    const migration = state.slice(state.indexOf("legacy.consumedMeals.forEach"), state.indexOf("delete legacy.consumedMeals"));
    expect(migration).toMatch(/legacyTotalProvenance\(\)/);
    // demo: buildDemoFoodLog marca synthetic en todas
    const demo = state.slice(state.indexOf("export function buildDemoFoodLog"), state.indexOf("export function normalizeState"));
    expect(demo).toMatch(/SYNTHETIC_FOOD_LOG_FIELDS/);
  });

  it("la sincronización con Supabase persiste la procedencia (sin esto `synthetic` se perdería en el primer viaje)", () => {
    const layer = files.find((f) => f.file === "lib/data-layer.ts")!.source;
    expect((layer.match(/sanitizeFoodLogProvenance\(/g) ?? []).length).toBe(2); // lectura y escritura
  });
});
