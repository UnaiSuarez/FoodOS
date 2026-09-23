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
 * Reconstruye el status de un campo cargado desde almacenamiento que
 * puede venir de datos anteriores a esta entrega (sin `nutrientStatus`
 * guardado): si el registro ya trae un status explícito, se respeta tal
 * cual. Si no, pero el NÚMERO sí está presente, se trata como dato
 * heredado sin procedencia verificable — mismo criterio que el catálogo
 * local, nunca `known_*`. Si ni el status ni el número están presentes,
 * es `"unknown"`. Pensado para el segundo punto de colapso de una receta
 * (recarga al editar) y para un ingrediente tomado del inventario cuando
 * ese `InventoryItem` no trae su propio `nutrientStatus`.
 */
export function legacyOrUnknown(savedStatus: NutrientStatus | undefined, rawValue: number | null | undefined): NutrientStatus {
  if (savedStatus) return savedStatus;
  return localCatalogStatusFromValue(rawValue);
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Coincidencia de PALABRA/FRASE COMPLETA, no subcadena — `"strawberry"` no
 * debe leer `"raw"` dentro de sí misma. `\p{L}`/`\p{N}` (Unicode) en vez de
 * `\b` (ASCII) para que una tilde/ñ siga contando como parte de la palabra
 * y no cree un límite falso a mitad de un término en español.
 */
function containsWholeWord(haystack: string, phrase: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "u");
  return pattern.test(haystack);
}

function includesAny(haystack: string, words: readonly string[]): boolean {
  return words.some((w) => containsWholeWord(haystack, w));
}

/**
 * Léxico fijo, español + inglés, por palabra/frase COMPLETA (nunca
 * subcadena — ver `containsWholeWord`). Sin ninguna coincidencia →
 * `"unspecified"`. Dos o más categorías distintas a la vez (ej. "sopa
 * deshidratada para preparar" declara "dry" Y "reconstituted") →
 * `"ambiguous"`: sin una regla de reducción verificable y calibrada, no es
 * seguro elegir una sobre la otra solo por el orden en que se comprueban
 * las listas — así que no se elige ninguna. No interpreta sinónimos fuera
 * de esta lista ni hace ningún análisis semántico — es exactamente lo que
 * el documento de diseño pide: "no construir un clasificador semántico
 * completo".
 */
export function extractDeclaredState(text: string): DeclaredFoodState {
  const normalized = text.toLowerCase();
  const matched = new Set<Exclude<DeclaredFoodState, "unspecified" | "ambiguous">>();
  if (includesAny(normalized, RAW_WORDS)) matched.add("raw");
  if (includesAny(normalized, COOKED_WORDS)) matched.add("cooked");
  if (includesAny(normalized, DRY_WORDS)) matched.add("dry");
  if (includesAny(normalized, RECONSTITUTED_WORDS)) matched.add("reconstituted");
  if (includesAny(normalized, DRAINED_WORDS)) matched.add("drained");
  if (matched.size === 0) return "unspecified";
  if (matched.size > 1) return "ambiguous";
  const [only] = matched;
  return only;
}

/** true si el estado no es una base fiable para comparar (ausente o en conflicto). */
function isUnreliableState(state: DeclaredFoodState): boolean {
  return state === "unspecified" || state === "ambiguous";
}

/**
 * Búsqueda genérica por texto (OFF, USDA, catálogo local): compara lo que
 * el usuario buscó con el nombre/descripción de la referencia encontrada.
 * Cualquiera de los dos sin estado declarado, o con un estado ambiguo
 * (varias bases en conflicto) → `"unknown"` (el caso mayoritario hoy).
 * Ambos declaran el mismo estado único → `"confirmed"`. Declaran estados
 * distintos → `"incompatible"` — nunca se cuenta como fiable, ni siquiera
 * con un nutriente `known_*`.
 */
export function resolveFoodStateConfidenceForGenericMatch(queryText: string, referenceText: string): FoodStateConfidence {
  const queryState = extractDeclaredState(queryText);
  const referenceState = extractDeclaredState(referenceText);
  if (isUnreliableState(queryState) || isUnreliableState(referenceState)) return "unknown";
  return queryState === referenceState ? "confirmed" : "incompatible";
}

/**
 * Producto identificado (código de barras u otra referencia de producto
 * concreto). El valor que llega aquí es siempre una referencia por 100 g
 * — los sitios de captura que llaman a esta función (`food-lookup.ts`,
 * `BarcodeScannerModal.tsx`) solo extraen campos `_100g` — así que NUNCA
 * representa ya el total tal como se consume, y `not_applicable` no es
 * alcanzable con las señales disponibles hoy: exigiría una prueba
 * estructural VERIFICABLE de que el número es un total cerrado (p. ej. un
 * campo de OFF que declare `nutrition_data_per: "serving"` con una ración
 * = el envase entero), que ningún sitio de captura actual extrae todavía.
 *
 * `hasSeparatePreparedBasis` en `true` es una ambigüedad real (la propia
 * fuente declara una base "preparado" distinta, ej. `*_prepared_100g` de
 * OFF) → `"unknown"`. Su AUSENCIA no es evidencia de lo contrario — un
 * producto puede requerir cocción perfectamente sin que OFF tenga cargado
 * ese campo, o incluso sin tener ficha nutricional preparada en absoluto
 * — así que la ausencia de esa señal deja igual de `"unknown"`, nunca
 * `"not_applicable"` por descarte. Un nombre que además declara un
 * estado (ej. "Pasta cocida") tampoco sube a `"confirmed"`: no hay un
 * segundo lado independiente (lo que el usuario realmente consumió) con
 * el que contrastarlo — sigue siendo `"unknown"`.
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
 * "preparado" (`*_prepared_100g`) distinta de la base "tal cual" — hecho
 * real y verificable sobre la fuente, útil por sí mismo (ej. para avisar
 * de la ambigüedad en la interfaz) aunque hoy ningún resolutor de
 * `foodStateConfidence` lo consuma: su ausencia NO demuestra que el
 * producto no requiera preparación (ver `resolveFoodStateConfidenceForProduct`),
 * así que no hay ninguna decisión segura que tomar únicamente a partir de
 * este booleano todavía.
 */
export function offHasSeparatePreparedBasis(nutriments: Record<string, unknown> | null | undefined): boolean {
  if (!nutriments) return false;
  return OFF_PREPARED_BASIS_KEYS.some((k) => nutriments[k] != null);
}

export function resolveFoodStateConfidenceForProduct(): FoodStateConfidence {
  return "unknown";
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
 * con la que contrastar) si declara un ÚNICO estado sin ambigüedad,
 * `"unknown"` si no declara ninguno o si declara varios en conflicto.
 */
export function resolveFoodStateConfidenceForDirectEntry(
  kind: "whole_intake_total" | "per_unit_reference",
  nameText?: string,
): FoodStateConfidence {
  if (kind === "whole_intake_total") return "not_applicable";
  return isUnreliableState(extractDeclaredState(nameText ?? "")) ? "unknown" : "confirmed";
}
