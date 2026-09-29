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
 * `synthetic` lo escriben (PR3) únicamente `seedHistorico` ("Sembrar 7 días de
 * historial") y "Cargar datos demo": filas FICTICIAS que no representan
 * ninguna ingesta real. Se descartan aquí, a nivel de ENTRADA y antes de
 * agrupar por día — nunca se elimina un día de la ventana: un día que solo
 * tenía filas sintéticas queda sin entradas reales y el kernel lo cuenta como
 * día sin registrar, sin reducir `windowDays`. Solo el booleano `true` cuenta
 * (un `"true"` o un `1` no lo son).
 */
function isSyntheticEntry(entry: FoodLogEntry): boolean {
  return entry.synthetic === true;
}

/**
 * Traduce una `FoodLogEntry` real a una `DailyIntegrityEntry` (el tipo de
 * entrada que el contrato de PR1 exige), con la clasificación más
 * conservadora que el diseño permite:
 *
 * - Cada uno de los 4 macros guardados se etiqueta `"legacy_unlabeled"`
 *   — NUNCA `"known_nonzero"`/`"known_zero"`, sea cual sea el valor
 *   numérico guardado (incluido 0).
 * - `quantityConfidence: "low"` y `foodStateConfidence: "unknown"`,
 *   `energyConsistency: "not_evaluable"`: sin una base leída, no se afirma
 *   ninguna confianza que no se haya ganado.
 *
 * DECISIÓN DELIBERADA (PR3): desde PR3 los escritores del diario SÍ adjuntan
 * `nutrientStatus`/`foodStateConfidence`/`quantityConfidence` a cada entrada
 * nueva (ver food-log-provenance.ts y el documento de diseño, §18), pero este
 * adaptador NO los lee todavía y sigue tratando toda entrada como
 * `legacy_unlabeled`. Leerlos es trabajo del PR de integración posterior:
 * convertir el estado guardado en un `NutrientValue` exige reconciliarlo con el
 * número (el kernel rechaza la ventana entera ante un `known_nonzero` con valor
 * 0, o un `unknown` con valor) y decidir cómo se traduce cada eje — no es una
 * copia de campos, y hacerlo aquí, sin ese cuidado, sería la "inferencia de
 * datos" que se pidió evitar. Hasta entonces la lectura es más conservadora
 * que la escritura, nunca menos.
 *
 * Ninguna entrada se descarta por su contenido (p. ej. por tener kcal 0,
 * o por parecer "poco fiable" de antemano): ese juicio es exclusivamente
 * del kernel de PR1 cuando se conecte, nunca de este adaptador. Descartar
 * aquí una entrada "sin kcal ponderable" repetiría exactamente el error
 * que PR1 corrigió (una comida de magnitud incierta desapareciendo del
 * denominador) — con el agravante de esconderlo antes de que el kernel
 * llegue a verla. La única excepción son las filas `synthetic:true` (ver
 * `isSyntheticEntry`): no son ingesta.
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
