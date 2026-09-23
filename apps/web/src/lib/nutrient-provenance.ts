// Nutrition Engine v4, PR3a — provenance en el punto de captura. Nace de
// docs/NUTRITION_V4_DATA_INTEGRITY_DESIGN.md (§1.3/§1.6): antes de esta
// pieza, ningún camino de captura (búsqueda OFF/USDA, escáner, recetas,
// IA, catálogo local) distinguía un campo ausente de un campo declarado
// en cero, ni conservaba si la referencia usada describe el alimento en
// el estado (crudo/cocido/...) realmente consumido.
//
// Responsabilidad de este módulo: dado un valor numérico y su contexto de
// origen, decidir el NutrientStatus/FoodStateConfidence correctos — nunca
// decidir el NÚMERO en sí (eso lo sigue calculando cada sitio de captura
// exactamente igual que hoy, con su propio "?? 0" para lo que se
// muestra). El número visible no cambia en esta entrega; el metadato que
// lo acompaña, sí.
//
// PR3a NO etiqueta entradas del diario (FoodLogEntry) — eso es PR3. Este
// módulo alimenta InventoryItem/RecipeIngredient únicamente.

import type { DeclaredFoodState, FoodStateConfidence, NutrientStatus } from "@foodos/types";

// ─── Estado de un nutriente a partir de un valor numérico ──────────────────

/**
 * `value` presente y finito → `known_zero` (si es exactamente 0) o
 * `known_nonzero` (si no) — la base de medida se da por confirmada porque
 * la propia fuente la declaró en un campo cuyo NOMBRE garantiza esa base
 * (p. ej. un campo sufijado "_100g" de Open Food Facts, o un valor de
 * USDA FoodData Central para sus tipos Foundation/SR Legacy, que ese
 * conjunto de datos siempre reporta por 100 g). `value` ausente o no
 * finito → `unknown`.
 */
export function knownStatusFromValue(value: number | null | undefined): NutrientStatus {
  return typeof value === "number" && Number.isFinite(value) ? (value === 0 ? "known_zero" : "known_nonzero") : "unknown";
}

/**
 * Igual que `knownStatusFromValue`, pero para un campo cuya base de
 * medida NO está confirmada por su propio nombre — p. ej. un campo de OFF
 * sin el sufijo "_100g" (podría ser por ración, por envase, o cualquier
 * otra base; OFF no lo distingue en ese nombre de campo). El número
 * puede seguir usándose para lo que se muestra (compatibilidad con el
 * comportamiento actual), pero como su base no está verificada, el
 * status más alto que puede alcanzar es `"estimated"`, nunca `known_*`.
 */
export function estimatedStatusFromValue(value: number | null | undefined): NutrientStatus {
  return typeof value === "number" && Number.isFinite(value) ? "estimated" : "unknown";
}

/**
 * Un número inferido por un modelo de IA nunca es `known_*`, esté o no
 * presente en la respuesta — una IA infiere, no mide (ver el documento de
 * diseño §A). Presente y finito → `"estimated"`. Ausente → `"unknown"`.
 */
export function aiStatusFromValue(value: number | null | undefined): NutrientStatus {
  return estimatedStatusFromValue(value);
}

/**
 * El catálogo local (food-db.ts) atribuye sus ~200 fichas EN CONJUNTO a
 * "BEDCA / USDA / valores estándar", sin identificar la fuente de CADA
 * ficha por separado — no hay forma de saber, para una fila concreta, si
 * su carbs/fat viene de una tabla de composición real o es un "valor
 * estándar" aproximado. Un campo numérico presente (siempre lo está: el
 * tipo `FoodEntry` no admite `carbs`/`fat` opcionales) no demuestra por sí
 * solo su procedencia — tener un número no hace fiable su origen. Se
 * clasifica como `"legacy_unlabeled"`: existe un valor, pero su
 * procedencia por ficha no es verificable con la estructura actual del
 * catálogo (mismo criterio que un dato histórico sin etiquetar, aunque
 * aquí la causa no sea la antigüedad sino la ausencia de trazabilidad por
 * fila desde el origen).
 *
 * CORRECCIÓN de una decisión provisional del documento de diseño: la
 * versión anterior (§1.3/§11) trataba el catálogo local como `known_*`
 * por defecto, razonando que es un dataset "curado a mano, no una API que
 * pueda omitir un campo en tiempo de ejecución". Ese razonamiento
 * confundía "quién escribió el número" con "si sabemos de qué ficha de
 * qué fuente salió" — son preguntas distintas, y la segunda es la que
 * importa para decidir si Nutrition v4 puede confiar en el valor. Se
 * revierte aquí; el documento de diseño se actualiza para reflejarlo.
 *
 * Elevar esto en el futuro exigiría una auditoría manual, ficha a ficha,
 * añadiendo un campo de origen real (p. ej. `source: "bedca:12345"`) a
 * cada entrada de `FOOD_DB` — trabajo de catalogación, no de este PR.
 */
export function localCatalogStatusFromValue(value: number | null | undefined): NutrientStatus {
  return typeof value === "number" && Number.isFinite(value) ? "legacy_unlabeled" : "unknown";
}

/**
 * Entrada manual: `wasExplicitlyEntered` es una señal que decide el
 * LLAMADOR (nunca este módulo) — normalmente "¿ha disparado el usuario un
 * evento de cambio sobre este campo concreto?", nunca "¿el número es
 * distinto de su valor por defecto?" (un usuario puede teclear
 * deliberadamente el mismo número que ya había). Sin esa señal explícita,
 * un campo sin rellenar nunca se convierte en `known_zero` solo porque su
 * valor de interfaz sea 0 — se queda en `"unknown"`.
 */
export function manualStatusFromValue(value: number | null | undefined, wasExplicitlyEntered: boolean): NutrientStatus {
  if (!wasExplicitlyEntered) return "unknown";
  return knownStatusFromValue(value);
}

// ─── Resolutores por niveles: Open Food Facts / USDA ────────────────────────
//
// El NÚMERO mostrado lo sigue calculando cada sitio de captura con su
// propia cadena `??`, EXACTAMENTE igual que hoy — estas funciones no la
// tocan. Solo deciden, mirando la MISMA prioridad de campos en el MISMO
// orden, qué NutrientStatus le corresponde al valor que esa cadena acabó
// usando. Por eso comprueban presencia (`!= null`, igual que `??`) antes
// que "es un número finito": si un campo está presente pero no es un
// número limpio, la cadena `??` de todos modos lo habría usado (y
// probablemente producido un NaN visible, un bug ya existente e
// independiente de esta entrega) — aquí solo se evita reclamar
// `known_*`/`estimated` para ese valor, sin fingir que la siguiente
// prioridad "hubiera ganado" cuando en la cadena real no lo haría.

function isFieldPresent(raw: unknown): boolean {
  return raw !== null && raw !== undefined;
}

function statusForConfirmedField(raw: unknown): NutrientStatus {
  return typeof raw === "number" && Number.isFinite(raw) ? knownStatusFromValue(raw) : "unknown";
}

function statusForUnconfirmedField(raw: unknown): NutrientStatus {
  return typeof raw === "number" && Number.isFinite(raw) ? "estimated" : "unknown";
}

/**
 * Kcal de OFF: 3 niveles, mismo orden que la cadena existente
 * (`n["energy-kcal_100g"] ?? n["energy-kcal"] ?? n.energy_100g/4.184`).
 * `confirmed100g` y `confirmedViaKj` declaran base 100 g por el propio
 * nombre del campo → `known_*`. `bareUnconfirmed` (`energy-kcal`, sin
 * sufijo) no declara base → como mucho `"estimated"`, aunque sea el valor
 * que acabe mostrándose.
 */
export function resolveOffKcalStatus(confirmed100g: unknown, bareUnconfirmed: unknown, confirmedViaKj: unknown): NutrientStatus {
  if (isFieldPresent(confirmed100g)) return statusForConfirmedField(confirmed100g);
  if (isFieldPresent(bareUnconfirmed)) return statusForUnconfirmedField(bareUnconfirmed);
  if (isFieldPresent(confirmedViaKj)) return statusForConfirmedField(confirmedViaKj);
  return "unknown";
}

/**
 * Campo de OFF con 2 niveles (proteína/carbohidratos/grasa): un campo
 * sufijado "_100g" declara base 100 g → `known_*`; el campo sin sufijo no
 * la declara → como mucho `"estimated"`.
 */
export function resolveOffTieredStatus(confirmed100g: unknown, bareUnconfirmed: unknown): NutrientStatus {
  if (isFieldPresent(confirmed100g)) return statusForConfirmedField(confirmed100g);
  if (isFieldPresent(bareUnconfirmed)) return statusForUnconfirmedField(bareUnconfirmed);
  return "unknown";
}

/**
 * Campo de OFF con un único nivel confirmado (sal/fibra/azúcares: hoy
 * `parseOFFProduct` solo lee el sufijo "_100g", sin fallback a un campo
 * sin sufijo) → `known_*` si está presente, `"unknown"` si no.
 */
export function resolveOffConfirmedOnlyStatus(confirmed100g: unknown): NutrientStatus {
  return isFieldPresent(confirmed100g) ? statusForConfirmedField(confirmed100g) : "unknown";
}

/**
 * USDA FoodData Central, tipos Foundation/SR Legacy: por convención de
 * ese dataset (no verificada campo a campo, a diferencia de OFF) esos dos
 * `dataType` siempre reportan por 100 g — `searchUSDA` fija
 * `dataType=Foundation,SR%20Legacy` en la consulta, así que aquí no existe
 * la ambigüedad de "campo sin sufijo" que sí tiene OFF. Si la búsqueda se
 * extiende algún día a otros `dataType` de USDA, esta asunción debe
 * revisarse antes de reutilizar esta función para ellos.
 */
export function resolveUsdaStatus(value: unknown): NutrientStatus {
  return statusForConfirmedField(value);
}

// ─── Estado del alimento (crudo/cocido/...) — salvaguarda mínima ───────────
// NO es un clasificador semántico: comparación de palabras clave contra un
// léxico fijo, nunca inferencia. Ver el documento de diseño §1.6 para el
// razonamiento completo de por qué not_applicable no se asigna nunca por
// el origen (código de barras / manual) sino por el TIPO de número.

const RAW_WORDS = ["crudo", "cruda", "raw"];
const COOKED_WORDS = ["cocido", "cocida", "cocinado", "cocinada", "asado", "asada", "frito", "frita", "hervido", "hervida", "cooked", "roasted", "grilled", "boiled"];
const DRY_WORDS = ["seco", "seca", "deshidratado", "deshidratada", "instantáneo", "instantanea", "instantánea", "en polvo", "dry", "dehydrated", "instant", "powder", "powdered"];
const RECONSTITUTED_WORDS = ["reconstituido", "reconstituida", "hidratado", "hidratada", "para preparar", "reconstituted", "rehydrated"];
const DRAINED_WORDS = ["escurrido", "escurrida", "drained"];

function includesAny(haystack: string, words: readonly string[]): boolean {
  return words.some((w) => haystack.includes(w));
}

/**
 * Léxico fijo, español + inglés. Sin coincidencia → `"unspecified"`. No
 * interpreta sinónimos fuera de esta lista ni hace ningún análisis
 * semántico — es exactamente lo que el documento de diseño pide: "no
 * construir un clasificador semántico completo".
 */
export function extractDeclaredState(text: string): DeclaredFoodState {
  const normalized = text.toLowerCase();
  // Orden de comprobación: los estados más específicos (seco/reconstituido/
  // escurrido) antes que crudo/cocido, para que "puré instantáneo" no se
  // lea nunca como "cocido" por casualidad de alguna palabra compartida.
  if (includesAny(normalized, DRAINED_WORDS)) return "drained";
  if (includesAny(normalized, RECONSTITUTED_WORDS)) return "reconstituted";
  if (includesAny(normalized, DRY_WORDS)) return "dry";
  if (includesAny(normalized, COOKED_WORDS)) return "cooked";
  if (includesAny(normalized, RAW_WORDS)) return "raw";
  return "unspecified";
}

/**
 * Búsqueda genérica por texto (OFF, USDA, catálogo local): compara lo que
 * el usuario buscó con el nombre/descripción de la referencia encontrada.
 * Cualquiera de los dos sin estado declarado → `"unknown"` (el caso
 * mayoritario hoy). Ambos declaran el mismo estado → `"confirmed"`.
 * Declaran estados distintos → `"incompatible"` — nunca se cuenta como
 * fiable, ni siquiera con un nutriente `known_*`.
 */
export function resolveFoodStateConfidenceForGenericMatch(queryText: string, referenceText: string): FoodStateConfidence {
  const queryState = extractDeclaredState(queryText);
  const referenceState = extractDeclaredState(referenceText);
  if (queryState === "unspecified" || referenceState === "unspecified") return "unknown";
  return queryState === referenceState ? "confirmed" : "incompatible";
}

/**
 * Producto identificado (código de barras u otra referencia de producto
 * concreto). `hasSeparatePreparedBasis` es true cuando la fuente declara
 * TAMBIÉN una base "preparado" distinta de la base "tal cual" (p. ej.
 * existe algún campo `*_prepared_100g` en `nutriments` de OFF) — en ese
 * caso hay una ambigüedad estructural real y no hay forma hoy de saber
 * qué base se usó al registrar el consumo, así que nunca es
 * `not_applicable`.
 *
 * `not_applicable` se reserva para cuando NI la fuente declara una base
 * preparada separada NI el propio nombre del producto sugiere ninguna
 * preparación (p. ej. una lata de refresco) — no hay ningún indicio de
 * que el consumo directo difiera de la base declarada. Nunca se asigna
 * `not_applicable` por el mero hecho de venir de un código de barras.
 */
const OFF_PREPARED_BASIS_KEYS = [
  "energy-kcal_prepared_100g",
  "proteins_prepared_100g",
  "carbohydrates_prepared_100g",
  "fat_prepared_100g",
  "salt_prepared_100g",
  "fiber_prepared_100g",
  "sugars_prepared_100g",
];

/**
 * true cuando el `nutriments` de OFF declara TAMBIÉN alguna base
 * "preparado" (`*_prepared_100g`) distinta de la base "tal cual" — señal
 * de que existe una ambigüedad real sobre qué base se usó al registrar el
 * consumo. Pensado como entrada de `hasSeparatePreparedBasis` para
 * `resolveFoodStateConfidenceForProduct`.
 */
export function offHasSeparatePreparedBasis(nutriments: Record<string, unknown> | null | undefined): boolean {
  if (!nutriments) return false;
  return OFF_PREPARED_BASIS_KEYS.some((k) => nutriments[k] != null);
}

export function resolveFoodStateConfidenceForProduct(productText: string, hasSeparatePreparedBasis: boolean): FoodStateConfidence {
  if (hasSeparatePreparedBasis) return "unknown";
  return extractDeclaredState(productText) === "unspecified" ? "not_applicable" : "unknown";
}

/**
 * Entrada directa: `"whole_intake_total"` cuando el número YA representa
 * la cantidad total tal como se consume (sin una referencia por 100 g
 * detrás que escalar) — siempre `not_applicable`, porque no existe
 * ninguna referencia externa con estado propio con la que pueda haber una
 * incompatibilidad. `"per_unit_reference"` cuando el número SÍ es una
 * referencia por 100 g/ración (una entrada manual de un ingrediente
 * genérico, o una estimación de IA de un alimento por 100 g): se compara
 * el propio nombre tecleado/identificado contra el léxico — `"confirmed"`
 * (débil: un solo lado declara, no hay una segunda fuente independiente
 * con la que contrastar) si declara un estado, `"unknown"` si no.
 */
export function resolveFoodStateConfidenceForDirectEntry(
  kind: "whole_intake_total" | "per_unit_reference",
  nameText?: string,
): FoodStateConfidence {
  if (kind === "whole_intake_total") return "not_applicable";
  return extractDeclaredState(nameText ?? "") === "unspecified" ? "unknown" : "confirmed";
}
