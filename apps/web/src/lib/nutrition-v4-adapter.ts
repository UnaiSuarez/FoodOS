// Nutrition Engine v4, PR2 — traduce el diario real (`FoodLogEntry` de
// state.tsx) al contrato público de PR1 (`DailyIntegrityWindowInput`, del
// paquete de tipos compartido), sin llamar a `evaluateNutrientCoverage`
// ni importar nada del paquete de kernels puros de Nutrition Engine v4.
//
// Corrección de alcance (PR2, segunda ronda): la primera versión de este
// archivo SÍ llamaba a `evaluateNutrientCoverage`, lo que exigía añadir
// ese paquete de kernels como dependencia de apps/web/package.json. Al
// ejecutar la suite del paquete de kernels, seis motores distintos (PR1,
// PR2A, PR2B, PR3, PR5B, y el de aplicabilidad de propuestas) llevan cada
// uno su propia copia de una prueba estructural que falla si CUALQUIER
// archivo de apps/web/src menciona ese paquete por nombre o por ruta —
// una regla arquitectónica deliberada y reafirmada en cada kernel
// mergeado hasta hoy (ver nutrition-evidence-classifier.ts: ese paquete
// "no está conectado a ningún flujo real" todavía), no un accidente de
// PR1. Cruzar esa frontera no es una decisión de este PR — queda para un
// PR de integración posterior, después de PR3a y PR3. Este archivo se
// quedó corto a propósito: PREPARA el input que PR1 ya sabe evaluar, no
// lo evalúa. (Nota deliberada: este comentario evita escribir el nombre
// exacto del paquete/ruta en cuestión — la propia prueba estructural
// referida arriba escanea el TEXTO de cada archivo de apps/web/src en
// busca de esas dos cadenas literales, comentarios incluidos; escribirlas
// aquí para explicar por qué se evitan sería, en sí mismo, la violación.)
//
// Responsabilidad ÚNICA de este módulo: traducir `FoodLogEntry[]` real al
// contrato normalizado que PR1 exige, de la forma más conservadora que el
// diseño permite — nunca inventar procedencia, nunca inferir "known_*" ni
// "confirmed" de un número o un nombre guardado. No activa nada: ninguna
// propuesta adaptativa se genera ni se acepta aquí, y ningún objetivo
// nutricional que ve el usuario cambia por esto.
//
// docs/NUTRITION_V4_DATA_INTEGRITY_DESIGN.md, §1.6/§1.7/§7 para el
// contexto completo de cada decisión comentada abajo.

import type {
  DailyIntegrityWindowInput,
  FoodLogEntry,
  DailyIntegrityEntry as KernelEntry,
  NutrientKey,
  NutrientValue,
} from "@foodos/types";

export interface NutritionV4AdapterWindow {
  /** `YYYY-MM-DD`, mismo formato que `FoodLogEntry.date` y que el
   *  contrato de PR1 — sin conversión de por medio. */
  startDateKey: string;
  /** Inclusive, igual criterio que el kernel de PR1. */
  endDateKey: string;
}

export interface NutritionV4AdapterThresholds {
  /** Sin valor por defecto A PROPÓSITO — ver PR1: el documento de diseño
   *  deja este umbral explícitamente sin calibrar, y este adaptador no
   *  debe fijarlo por su cuenta más de lo que ya lo hace el kernel. Se
   *  transporta tal cual al `DailyIntegrityWindowInput` resultante. */
  dailyReliabilityThreshold: number;
  provisionalKcalFractionThreshold: number;
}

/** Los únicos cuatro nutrientes que `FoodLogEntry` guarda hoy (extiende
    `MacroTotals`) — fiber/sugars/salt no existen en el diario real
    todavía (sí en `InventorySnapshot`, pero eso es otro dato, no lo que
    efectivamente se registró como consumido). Se omiten del todo del
    `nutrients` de salida en vez de inventarles un status: `Partial<...>`
    ya representa correctamente "no tenemos este dato" con la ausencia de
    la clave. */
const DIARY_MACRO_KEYS = ["kcal", "protein", "carbs", "fat"] as const satisfies readonly NutrientKey[];

/**
 * `synthetic` NO existe todavía en `FoodLogEntry` — lo añade PR3, y hoy
 * ninguna entrada real lo tiene. Esta comprobación es deliberadamente
 * defensiva/adelantada: implementa YA el filtro que PR2 debe aplicar
 * ("filtrar las entradas marcadas synthetic:true antes de construir la
 * entrada del kernel"), sin esperar a que packages/types declare el
 * campo. Con los datos de hoy, esto nunca encuentra nada que filtrar —
 * eso es correcto, no un fallo silencioso: `seedHistorico()`
 * (SettingsView.tsx) no marca sus filas de ninguna forma todavía (esa
 * marca es, a su vez, trabajo de PR3).
 */
function isSyntheticEntry(entry: FoodLogEntry): boolean {
  return (entry as { synthetic?: unknown }).synthetic === true;
}

/**
 * Traduce una `FoodLogEntry` real a una `DailyIntegrityEntry` (el tipo de
 * entrada que el contrato de PR1 exige), con la clasificación más
 * conservadora que el diseño permite:
 *
 * - Cada uno de los 4 macros guardados se etiqueta `"legacy_unlabeled"`
 *   — NUNCA `"known_nonzero"`/`"known_zero"`, sea cual sea el valor
 *   numérico guardado (incluido 0): ningún camino de escritura actual
 *   (`actions.cookRecipe`/`actions.consumeInventoryItem` en state.tsx, ni
 *   los otros 6 escritores reales del diario — ver el documento de
 *   diseño §1.4) adjunta todavía ningún metadato de procedencia. Un
 *   número histórico no demuestra por sí solo su procedencia.
 * - `quantityConfidence: "low"` — no existe hoy ningún cálculo real de
 *   resolución de cantidad (densidad, unitSize) que este adaptador pueda
 *   leer; asumir "high" sin esa base sería inventar una confianza que no
 *   se ha ganado.
 * - `foodStateConfidence: "unknown"` — nunca `"confirmed"` ni
 *   `"not_applicable"`. Sería tentador inferir `"not_applicable"` para
 *   `source === "manual"` (asumiendo que es un total ya consumido) o para
 *   `source === "inventory"` (asumiendo que es una referencia por 100 g
 *   escalada), pero `FoodLogSource` no distingue una estimación de IA de
 *   comida completa (que SÍ sería `"not_applicable"`, ver el documento de
 *   diseño §1.6) de una entrada manual de un ingrediente genérico por
 *   100 g (que NO lo sería) — ambas llegan como `"manual"` hoy (hallazgo
 *   P6 de la auditoría: `LogMealModal.tsx` fuerza `source:"manual"` para
 *   estimaciones de IA por foto). Deducir el eje de estado del alimento a
 *   partir de `source` sería exactamente la "inferencia de datos" que se
 *   pidió evitar — se deja `"unknown"` de forma uniforme hasta que PR3a
 *   capture esta distinción con un metadato real, no adivinado.
 * - `energyConsistency: "not_evaluable"` — no existe hoy ningún cálculo
 *   de energía declarada vs. reconstruida (4P+4C+9G) sobre el diario real
 *   que este adaptador pueda leer (eso también es PR3a).
 *
 * Ninguna entrada se descarta por su contenido (p. ej. por tener kcal 0,
 * o por parecer "poco fiable" de antemano): ese juicio es exclusivamente
 * del kernel de PR1 cuando se conecte, nunca de este adaptador. Descartar
 * aquí una entrada "sin kcal ponderable" repetiría exactamente el error
 * que PR1 corrigió (una comida de magnitud incierta desapareciendo del
 * denominador) — con el agravante de esconderlo antes de que el kernel
 * llegue a verla.
 */
function toKernelEntry(entry: FoodLogEntry): KernelEntry {
  const nutrients: Partial<Record<NutrientKey, NutrientValue>> = {};
  for (const key of DIARY_MACRO_KEYS) {
    nutrients[key] = { status: "legacy_unlabeled", value: entry[key] };
  }
  return {
    dateKey: entry.date,
    nutrients,
    quantityConfidence: "low",
    foodStateConfidence: "unknown",
    energyConsistency: "not_evaluable",
  };
}

/**
 * Punto de entrada público de PR2: construye el `DailyIntegrityWindowInput`
 * que el kernel puro de PR1 (`evaluateNutrientCoverage`) ya sabe evaluar
 * — sin llamarlo. Conectar esta pieza con el kernel real
 * en un flujo de la web es responsabilidad de un PR de integración
 * posterior, después de PR3a y PR3 (ver la nota de cabecera del archivo).
 *
 * `startDateKey`/`endDateKey`/los dos umbrales se transportan tal cual,
 * sin tocarlos: la ventana nunca se acorta aquí, y ningún umbral se fija
 * por decisión de este adaptador.
 */
export function buildDiaryIntegrityInput(
  entries: readonly FoodLogEntry[],
  window: NutritionV4AdapterWindow,
  thresholds: NutritionV4AdapterThresholds,
): DailyIntegrityWindowInput {
  const nonSynthetic = entries.filter((entry) => !isSyntheticEntry(entry));
  return {
    startDateKey: window.startDateKey,
    endDateKey: window.endDateKey,
    entries: nonSynthetic.map(toKernelEntry),
    dailyReliabilityThreshold: thresholds.dailyReliabilityThreshold,
    provisionalKcalFractionThreshold: thresholds.provisionalKcalFractionThreshold,
  };
}
