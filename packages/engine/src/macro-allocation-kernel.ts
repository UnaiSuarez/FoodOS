import type {
  EnergyReconstruction,
  MacroAllocationInfeasible,
  MacroAllocationInvalidInput,
  MacroAllocationInvalidReason,
  MacroAllocationOk,
  MacroAllocationRequest,
  MacroAllocationResult,
  MacroAllocationUnresolvedInput,
  MacroPolicyRequirement,
  NonEmptyMacroPolicyRequirements,
} from "@foodos/types";

/*
 * Núcleo matemático puro de asignación diaria de macros — PR2A. Ver el
 * comentario de cabecera de nutrition-macro-allocation.ts para el porqué:
 * corrige el doble redondeo de grasa y el `Math.max(0, carbs)` silencioso
 * de v3.1, sin tocar v3.1 ni conectarse a apps/web. Sigue inerte.
 */

const INVALID_REASON_ORDER: readonly MacroAllocationInvalidReason[] = [
  "request_status_invalid",
  "kcal_target_invalid",
  "kcal_target_rounds_to_zero",
  "protein_target_invalid",
  "fat_target_invalid",
  "numeric_range_unsafe",
  "unresolved_reasons_missing",
  "unresolved_reason_invalid",
];

const POLICY_REQUIREMENT_ORDER: readonly MacroPolicyRequirement[] = [
  "kcal_target_not_resolved",
  "protein_target_not_resolved",
  "fat_target_not_resolved",
];
const KNOWN_POLICY_REQUIREMENTS: ReadonlySet<string> = new Set(POLICY_REQUIREMENT_ORDER);

/** Detalle interno de construcción del resultado — SIN `export` a propósito:
    con `export`, cualquier consumidor podría hacer un deep import
    (`@foodos/engine/src/macro-allocation-kernel`) y saltarse el barrel por
    completo, sin importar lo que reexporte packages/engine/src/index.ts. Su
    comportamiento (sin duplicados, orden canónico, sin mutar `reasons`) se
    prueba únicamente a través del resultado público de allocateDailyMacros. */
function dedupeAndOrderInvalidReasons(
  reasons: readonly MacroAllocationInvalidReason[],
): MacroAllocationInvalidReason[] {
  const present = new Set(reasons);
  return INVALID_REASON_ORDER.filter((reason) => present.has(reason));
}

/** Detalle interno — ver dedupeAndOrderInvalidReasons. Sin duplicados,
    orden canónico fijo, nunca muta `reasons`. */
function dedupeAndOrderPolicyRequirements(reasons: readonly MacroPolicyRequirement[]): MacroPolicyRequirement[] {
  const present = new Set(reasons);
  return POLICY_REQUIREMENT_ORDER.filter((reason) => present.has(reason));
}

function isUsableNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Punto de entrada del kernel. Ver nutrition-macro-allocation.ts para el
    contrato completo y la prueba algebraica de los límites de error.
    Validación runtime COMPLETA, nunca a medias: TypeScript garantiza la
    forma de `request` en código bien tipado, pero un caller no-TS, JSON, o
    un simple `as` puede colar cualquier cosa — el kernel nunca confía
    ciegamente en el tipo declarado. */
export function allocateDailyMacros(request: MacroAllocationRequest): MacroAllocationResult {
  // Guarda total sobre `request` en sí — tratado como `unknown`, nunca
  // confiando en que de verdad tenga la forma que TypeScript promete.
  // Cubre null, undefined, strings/números/booleanos, y arrays (que son
  // "object" mas nunca tienen una propiedad `status` propia): ninguno debe
  // lanzar al leer `.status`, solo degradar a invalid_input.
  const rawRequest: unknown = request;
  if (typeof rawRequest !== "object" || rawRequest === null) {
    return invalidInput(["request_status_invalid"]);
  }
  const rawStatus = (rawRequest as { status?: unknown }).status;
  if (rawStatus !== "resolved" && rawStatus !== "unresolved") {
    // status ausente (objeto sin la clave), o distinto de los dos literales
    // conocidos — colado en runtime pese al tipo. Se comprueba ANTES que
    // cualquier otra cosa: sin esto, un status desconocido caería en la
    // rama "resolved" de abajo e informaría un motivo equivocado (p. ej.
    // "kcal_target_invalid" cuando el problema real es el status).
    return invalidInput(["request_status_invalid"]);
  }

  if (request.status === "unresolved") {
    const rawReasons: unknown = request.reasons;
    if (!Array.isArray(rawReasons)) {
      // Ni siquiera un array — llegó así en runtime pese al tipo
      // NonEmptyMacroPolicyRequirements (caller no-TS, JSON, cast). Distinto
      // de "vacío" (unresolved_reasons_missing): aquí el propio VALOR es del
      // tipo equivocado, no solo una lista sin contenido.
      return invalidInput(["unresolved_reason_invalid"]);
    }
    if (rawReasons.length === 0) {
      // Vacío — una declaración de "no resuelto" sin ningún motivo utilizable
      // es inválida, nunca un unresolved_input mudo.
      return invalidInput(["unresolved_reasons_missing"]);
    }
    if (rawReasons.some((reason) => !KNOWN_POLICY_REQUIREMENTS.has(reason as string))) {
      // Al menos un elemento no pertenece a MacroPolicyRequirement — nunca
      // se descarta en silencio para quedarse con los válidos: un solo
      // motivo ilegítimo invalida toda la petición, para no devolver un
      // unresolved_input que parezca completo sin serlo.
      return invalidInput(["unresolved_reason_invalid"]);
    }
    const canonical = dedupeAndOrderPolicyRequirements(rawReasons as MacroPolicyRequirement[]);
    const result: MacroAllocationUnresolvedInput = {
      status: "unresolved_input",
      reasons: canonical as NonEmptyMacroPolicyRequirements,
    };
    return result;
  }

  const { kcalTarget, proteinTargetG, fatTargetG } = request;

  // ─── Fase 1: validez del valor CRUDO — puede acumular varios motivos a la vez.
  const invalid: MacroAllocationInvalidReason[] = [];
  if (!Number.isFinite(kcalTarget) || kcalTarget <= 0) invalid.push("kcal_target_invalid");
  if (!isUsableNonNegative(proteinTargetG)) invalid.push("protein_target_invalid");
  if (!isUsableNonNegative(fatTargetG)) invalid.push("fat_target_invalid");
  if (invalid.length > 0) return invalidInput(invalid);

  // ─── Fase 2: redondeo + degeneración a cero (0 < kcalTarget < 0.5 -> round=0).
  const roundedTargetKcal = Math.round(kcalTarget);
  if (roundedTargetKcal <= 0) return invalidInput(["kcal_target_rounds_to_zero"]);

  const proteinG = Math.round(proteinTargetG);
  const fatG = Math.round(fatTargetG);
  const proteinKcal = proteinG * 4;
  const fatKcal = fatG * 9;
  const usedKcal = proteinKcal + fatKcal;

  // ─── Fase 3: primer barrido de rango entero seguro.
  if (
    !Number.isSafeInteger(roundedTargetKcal) ||
    !Number.isSafeInteger(proteinG) ||
    !Number.isSafeInteger(fatG) ||
    !Number.isSafeInteger(proteinKcal) ||
    !Number.isSafeInteger(fatKcal) ||
    !Number.isSafeInteger(usedKcal)
  ) {
    return invalidInput(["numeric_range_unsafe"]);
  }

  // ─── Fase 4: factibilidad sobre valores YA redondeados.
  if (usedKcal > roundedTargetKcal) {
    const result: MacroAllocationInfeasible = {
      status: "infeasible",
      reasons: ["protein_and_fat_exceed_rounded_kcal_target"],
      requestedKcal: kcalTarget,
      requestedProteinG: proteinTargetG,
      requestedFatG: fatTargetG,
      roundedTargetKcal,
      proteinG,
      fatG,
      exceedsRoundedTargetByKcal: usedKcal - roundedTargetKcal,
    };
    return result;
  }

  // ─── Fase 5: carbohidratos — SEGUNDO barrido de rango seguro. Un valor
  // cercano a Number.MAX_SAFE_INTEGER puede pasar la fase 3 (los valores de
  // partida son seguros) y romperse igualmente aquí: redondear el residuo
  // a gramos y multiplicar por 4 puede desbordar el límite seguro por muy
  // poco (ver el test con kcalTarget = Number.MAX_SAFE_INTEGER).
  const remainingKcal = roundedTargetKcal - usedKcal;
  const carbsG = Math.round(remainingKcal / 4);
  const carbsKcal = carbsG * 4;
  const reconstructedKcal = usedKcal + carbsKcal;

  if (
    !Number.isSafeInteger(remainingKcal) ||
    !Number.isSafeInteger(carbsG) ||
    !Number.isSafeInteger(carbsKcal) ||
    !Number.isSafeInteger(reconstructedKcal)
  ) {
    return invalidInput(["numeric_range_unsafe"]);
  }

  const energy: EnergyReconstruction = {
    requestedKcal: kcalTarget,
    roundedTargetKcal,
    inputRoundingDeltaKcal: roundedTargetKcal - kcalTarget,
    reconstructedKcal,
    macroRoundingDeltaKcal: reconstructedKcal - roundedTargetKcal,
    // Resta directa contra requestedKcal — nunca la suma de los dos deltas
    // anteriores, para no acumular dos errores de representación en coma
    // flotante en vez de uno (ver el comentario del campo en el contrato).
    totalDeltaFromRequestedKcal: reconstructedKcal - kcalTarget,
  };

  const result: MacroAllocationOk = {
    status: "ok",
    protein: { requestedG: proteinTargetG, assignedG: proteinG, deltaG: proteinG - proteinTargetG },
    fat: { requestedG: fatTargetG, assignedG: fatG, deltaG: fatG - fatTargetG },
    carbs: { assignedG: carbsG },
    kcal: reconstructedKcal,
    energy,
  };
  return result;
}

function invalidInput(reasons: MacroAllocationInvalidReason[]): MacroAllocationInvalidInput {
  return { status: "invalid_input", reasons: dedupeAndOrderInvalidReasons(reasons) };
}
