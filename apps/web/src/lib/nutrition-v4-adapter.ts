// Nutrition Engine v4, PR2 (esqueleto) / PR4 (lectura real de procedencia)
// — traduce el diario real (`FoodLogEntry` de state.tsx) al contrato
// público de PR1 (`DailyIntegrityWindowInput`, del paquete de tipos
// compartido), sin llamar a `evaluateNutrientCoverage` ni importar nada
// del paquete de kernels puros de Nutrition Engine v4.
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
// contrato normalizado que PR1 exige. Desde PR4 lee la procedencia
// REALMENTE guardada por los escritores de PR3 (`nutrientStatus`,
// `quantityConfidence`, `foodStateConfidence` — ver food-log-provenance.ts
// y toKernelEntry más abajo) y la reconcilia con el número guardado antes
// de traducirla — nunca una copia directa del campo, nunca "known_*" ni
// "confirmed" inferido del número o del nombre por sí solo; ante metadatos
// ausentes, inválidos o contradictorios, degrada de forma conservadora
// (ver toNutrientValue). No activa nada: ninguna propuesta adaptativa se
// genera ni se acepta aquí, y ningún objetivo nutricional que ve el
// usuario cambia por esto.
//
// docs/NUTRITION_V4_DATA_INTEGRITY_DESIGN.md, §1.6/§1.7/§7 para el
// contexto completo de cada decisión comentada abajo.

import type {
  DailyIntegrityWindowInput,
  FoodLogEntry,
  DailyIntegrityEntry as KernelEntry,
  NutrientKey,
  NutrientStatus,
  NutrientValue,
} from "@foodos/types";
import { sanitizeFoodStateConfidence, sanitizeNutrientStatusMap } from "./food-log-provenance";

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
 * Traduce el par (estado guardado, número guardado) de UN macro a un
 * `NutrientValue`, reconciliando ambos ANTES de construirlo — nunca una
 * copia directa del estado. Reglas, en orden:
 *
 * 1. Un número no finito O NEGATIVO no es un dato utilizable bajo NINGÚN
 *    estado: el kernel de PR1 (`isValidNutrientValue`) exige `raw >= 0`
 *    para `estimated`/`recipe_derived`/`imputed`/`legacy_unlabeled`,
 *    `raw > 0` para `known_nonzero`, `raw === 0` para `known_zero` y
 *    `raw === null` para `unknown` — ninguna variante admite un negativo.
 *    Un macro con un número negativo (no debería producirse nunca en la
 *    app, pero esta función no lo asume) se trata como si no existiera:
 *    `unknown`/`null`, cualquiera que sea el estado declarado — nunca
 *    `"estimated"` con ese negativo dentro, que el kernel rechazaría junto
 *    con la ventana entera.
 * 2. Estado ausente = entrada anterior a PR3 o de una migración (ver el
 *    comentario de `FoodLogEntry.nutrientStatus`): `"legacy_unlabeled"`,
 *    nunca `"known_*"`. Esto es lo que impide "mejorar" el histórico
 *    anterior al etiquetado con solo leerlo de nuevo.
 * 3. `"unknown"` produce SIEMPRE `value: null` — el contrato de
 *    `NutrientValue` lo exige, y un resto numérico bajo un estado
 *    explícitamente "unknown" (posible tras una sincronización con
 *    metadatos parciales) no es una medición: es ruido de una versión
 *    anterior del dato, y no se expone.
 * 4. `"known_zero"`/`"known_nonzero"` son afirmaciones verificables contra
 *    el propio número: el kernel exige cero exacto para el primero y
 *    estrictamente positivo para el segundo. Si el número guardado (ya no
 *    negativo, filtrado en el paso 1) ya no sostiene la afirmación — cero
 *    declarado pero número no-cero, o número cero bajo un `known_nonzero`
 *    — la entrada deja de afirmar una medición y pasa a `"estimated"`, el
 *    mismo destino que ya elige `reconcileStatusesWithValues`
 *    (food-log-provenance.ts) ante la misma contradicción al escribir: una
 *    entrada que era coherente al guardarse y deja de serlo más tarde
 *    (migración, edición manual del dato guardado) no debe tratarse
 *    distinto solo por el momento en que se detecta la contradicción.
 * 5. Cualquier otro estado (`estimated`, `recipe_derived`, `imputed`,
 *    `legacy_unlabeled`) no tiene más restricción numérica que la del paso
 *    1 (ya aplicada): pasa tal cual, con el número guardado.
 */
function toNutrientValue(status: NutrientStatus | undefined, rawValue: number): NutrientValue {
  if (!Number.isFinite(rawValue) || rawValue < 0) return { status: "unknown", value: null };

  const resolved = status ?? "legacy_unlabeled";
  if (resolved === "unknown") return { status: "unknown", value: null };
  if (resolved === "known_zero") {
    return rawValue === 0 ? { status: "known_zero", value: 0 } : { status: "estimated", value: rawValue };
  }
  if (resolved === "known_nonzero") {
    return rawValue > 0 ? { status: "known_nonzero", value: rawValue } : { status: "estimated", value: rawValue };
  }
  return { status: resolved, value: rawValue };
}

/**
 * `quantityConfidence` de una `FoodLogEntry`: solo `"high"` cuando el campo
 * lo declara explícitamente así. Ausente, o cualquier otra cosa, es
 * `"low"` — nunca el valor por defecto optimista. No es una elección
 * arbitraria de este adaptador: ningún constructor de
 * food-log-provenance.ts escribe jamás `level: "high"` (solo lo omiten, o
 * ponen `"low"` con un motivo) precisamente porque, según su propio
 * comentario, "PR3 nunca afirma 'high' sin una comprobación positiva, y su
 * ausencia se lee como baja". Leerlo distinto aquí inventaría una confianza
 * que ni siquiera la escritura se atribuye a sí misma.
 */
function quantityConfidenceOf(entry: FoodLogEntry): "high" | "low" {
  return entry.quantityConfidence?.level === "high" ? "high" : "low";
}

/**
 * Traduce una `FoodLogEntry` real a una `DailyIntegrityEntry` (el tipo de
 * entrada que el contrato de PR1 exige), leyendo la procedencia
 * REALMENTE guardada por los escritores de PR3 (ver food-log-provenance.ts)
 * en vez de tratar toda entrada como `legacy_unlabeled` — la lectura
 * conservadora por defecto de PR2. Cada macro se reconcilia contra su
 * propio número guardado con `toNutrientValue`; `quantityConfidence`, con
 * `quantityConfidenceOf`.
 *
 * `nutrientStatus`/`foodStateConfidence` se sanean AQUÍ, con los mismos
 * saneadores que ya usa la sincronización remota
 * (`sanitizeNutrientStatusMap`/`sanitizeFoodStateConfidence`,
 * food-log-provenance.ts), antes de leerlos — no se asume que ya llegan
 * válidos solo porque el tipo de `FoodLogEntry` lo declare así.
 * `pullState()` sanea la procedencia remota antes de construir cada
 * `FoodLogEntry` (`sanitizeFoodLogProvenance`, data-layer.ts), pero
 * `loadLocalState()`/`normalizeState()` (arranque en modo local, o mientras
 * la hidratación remota no ha completado) leen `localStorage` con
 * `JSON.parse` crudo y no vuelven a sanear los campos de procedencia del
 * diario — solo migran forma (p. ej. `mealType`). Un valor técnicamente
 * inválido en tiempo de ejecución puede llegar así, directo, a este
 * adaptador. Saneado, un valor inválido cae a "ausente", con el mismo
 * destino conservador que la ausencia real: `legacy_unlabeled` para el
 * macro correspondiente, `"unknown"` para `foodStateConfidence` — nunca se
 * propaga un estado que no es uno de los reconocidos.
 *
 * `energyConsistency` sigue siendo siempre `"not_evaluable"`: no existe hoy
 * ninguna señal independiente (un kcal declarado por separado del
 * calculado a partir de los macros) que leer — calcularla aquí sería
 * inventar una comprobación nueva, fuera del alcance de "traducir lo ya
 * guardado".
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
  const nutrientStatus = sanitizeNutrientStatusMap(entry.nutrientStatus);
  const foodStateConfidence = sanitizeFoodStateConfidence(entry.foodStateConfidence) ?? "unknown";

  const nutrients: Partial<Record<NutrientKey, NutrientValue>> = {};
  for (const key of DIARY_MACRO_KEYS) {
    nutrients[key] = toNutrientValue(nutrientStatus?.[key], entry[key]);
  }
  return {
    dateKey: entry.date,
    nutrients,
    quantityConfidence: quantityConfidenceOf(entry),
    foodStateConfidence,
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
