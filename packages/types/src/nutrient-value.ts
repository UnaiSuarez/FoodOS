// Nutrition Engine v4 — taxonomía de valores nutricionales. Nace de
// docs/NUTRITION_V4_DATA_INTEGRITY_DESIGN.md (§4): antes de esta pieza,
// ningún tipo del repositorio distinguía un nutriente ausente de un
// nutriente declarado en cero, y ningún consumidor podía saber si la
// referencia de un alimento describía el estado (crudo/cocido/seco...)
// realmente consumido.
//
// Complementa, sin sustituir ni modificar, IntakeLoggingCoverageResult
// (PR5A, intake-logging-coverage.ts): PR5A mide SI y CUÁNTO se registró
// (`loggingPresenceFraction`, `plausibleCoverageFraction`) y deja
// explícitamente sin resolver la EXACTITUD de lo registrado —
// `intakeAccuracy` es siempre el literal "unknown" ahí, también con
// cobertura completa y plausible (ver intake-logging-coverage.ts:1-9 y
// NUTRITION_V4_EXERCISE_V2_ROADMAP.md, "Cobertura de registro no es
// exactitud de ingesta"). El mismo hueco limita hoy a PR5B: su
// `confidence` nunca pasa de "moderate" precisamente porque no valida
// exactitud (roadmap, "Alcance de PR5B").
//
// Esta taxonomía y el kernel de nutrient-coverage.ts son la base para
// llenar ese hueco — no lo llenan todavía. Ningún archivo existente de
// PR5A ni de PR5B se modifica en esta entrega, y cablear esta pieza con
// ellos queda fuera de alcance (ver
// el documento de diseño, fases PR2/PR3a/PR3/PR9 — numeración propia del
// documento de diseño, deliberadamente SIN reclamar un hueco en la
// secuencia PR1–PR5B ya asignada en este repositorio: esa decisión de
// producto no corresponde a esta entrega).

export type NutrientKey = "kcal" | "protein" | "carbs" | "fat" | "fiber" | "sugars" | "salt";

/**
 * Procedencia declarada de un valor nutricional concreto — nunca deducible
 * del número en sí:
 * - "known_nonzero" / "known_zero": medido o declarado por una fuente NO-IA,
 *   con el signo del valor coincidiendo con el nombre del estado.
 * - "estimated": derivado de otro dato conocido de la MISMA fila (p. ej.
 *   grasa por diferencia de kcal), o cualquier valor de IA presente —
 *   nunca "known_*", una IA infiere, no mide.
 * - "recipe_derived": agregado desde los ingredientes de una receta.
 * - "imputed": relleno por una política explícita y documentada — el tipo
 *   solo deja la puerta abierta, ningún flujo actual lo produce.
 * - "unknown": el dato no existe (`value` es `null`).
 * - "legacy_unlabeled": hay un número, pero no hay garantía de que
 *   represente una medición real — puede venir de un `?? 0` de una fuente
 *   externa, de una estimación silenciosa o de datos anteriores al
 *   etiquetado de procedencia. Nunca equivale a "known_*".
 */
export type NutrientStatus =
  | "known_nonzero"
  | "known_zero"
  | "estimated"
  | "recipe_derived"
  | "imputed"
  | "unknown"
  | "legacy_unlabeled";

export interface NutrientValue {
  status: NutrientStatus;
  /** `null` si y solo si `status === "unknown"`. Para "legacy_unlabeled" el
   *  número SÍ existe (el valor histórico tal cual se guardó en su
   *  momento) pero nunca se trata como equivalente a "known_*". Para
   *  "known_zero" el valor es exactamente 0; para "known_nonzero" es
   *  estrictamente positivo; para el resto de estados con valor, es un
   *  número finito no negativo. */
  value: number | null;
}

export type EnergyConsistency = "match" | "mismatch" | "not_evaluable";

export type QuantityLowConfidenceReason =
  | "missing_density"
  | "missing_unit_size"
  | "overrides_ignored"
  | "legacy_unlabeled";

export type QuantityResolution =
  | { status: "resolved"; grams: number }
  | { status: "unresolved"; reason: QuantityLowConfidenceReason };

export type DeclaredFoodState = "raw" | "cooked" | "dry" | "reconstituted" | "drained" | "unspecified";

/**
 * Eje INDEPENDIENTE de `NutrientStatus` — ninguno sustituye al otro. Un
 * valor puede ser a la vez "known_nonzero" (el número es real y declarado
 * por la fuente) y "foodStateConfidence: unknown" (no hay garantía de que
 * esa fuente describa el alimento en el estado en que se consumió, p. ej.
 * pollo crudo resuelto cuando el usuario pesó pollo cocinado).
 * - "confirmed": la referencia y la ingesta declaran el mismo estado.
 * - "unknown": no hay suficiente información para confirmar ni descartar
 *   una incompatibilidad (el caso mayoritario hoy en coincidencias
 *   genéricas).
 * - "incompatible": ambos lados declaran estados distintos y contrarios.
 * - "not_applicable": el valor ya representa la cantidad TOTAL tal como se
 *   consumió (no una referencia por 100 g/ración escalable), así que no
 *   existe una referencia externa con estado propio con la que pueda
 *   haber una incompatibilidad.
 */
export type FoodStateConfidence = "confirmed" | "unknown" | "incompatible" | "not_applicable";
