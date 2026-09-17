import { allocateDailyMacros } from "./macro-allocation-kernel";
import type {
  DayLabel,
  DayMacroPolicyRequirement,
  MacroAllocationRequest,
  NonEmptyDayMacroIssues,
  NonEmptyDayMacroPolicyRequirements,
  NonEmptyStructuralInvalidReasons,
  NonEmptyWeeklyPlanInfeasibleReasons,
  NonEmptyWeeklyPolicyRequirements,
  WeeklyEnergyAudit,
  WeeklyPlanDailyAllocationInvalidReason,
  WeeklyPlanInfeasible,
  WeeklyPlanInfeasibleDayResult,
  WeeklyPlanInfeasibleReason,
  WeeklyPlanInvalidDailyAllocationError,
  WeeklyPlanInvalidInput,
  WeeklyPlanInvalidRequestError,
  WeeklyPlanOk,
  WeeklyPlanOkDayResult,
  WeeklyPlanOkDays,
  WeeklyPlanPartialDayDiagnostic,
  WeeklyPlanPartialDayDiagnosticKind,
  WeeklyPlanRequest,
  WeeklyPlanResult,
  WeeklyPlanStructuralInvalidReason,
  WeeklyPlanUnresolvedInput,
  WeeklyPolicyRequirement,
} from "@foodos/types";

/*
 * Núcleo matemático puro de reparto semanal — PR2B. Reparte un total
 * energético semanal YA DECIDIDO entre 7 días según una política de
 * reparto explícita, y llama una vez por día a allocateDailyMacros
 * (PR2A) — sin reimplementar ni un ápice de su aritmética ni de su
 * validación numérica. Ver el comentario de cabecera de
 * nutrition-weekly-plan.ts para el contrato completo. Sigue inerte.
 *
 * Orden de precedencia (deliberado, ver contrato): 1) toda la estructura
 * y todo lo ya declarado como "resolved" (incluida la política energética
 * COMPLETA: target, tipo de reparto, mapas, cobertura, suma, seguridad
 * numérica previa al reparto) — un día con macros pendientes NUNCA
 * enmascara una política resuelta pero malformada; 2) cualquier invalidez
 * encontrada en (1) → invalid_input; 3) solo entonces, si algo seguía
 * pendiente → unresolved_input; 4) reparto; 5) ejecución diaria vía
 * allocateDailyMacros; 6) veredicto final, donde un rechazo de PR2A
 * (invalid_input) siempre gana sobre una inviabilidad nutricional.
 */

// ─── Utilidades genéricas ────────────────────────────────────────────

/** true solo para un objeto plano (no null, no array) — las claves se leen
    siempre con Object.keys(), nunca con `for...in`, para no confiar jamás
    en propiedades heredadas de la cadena de prototipos. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Nutrition Engine v4 — rama inalcanzable: ${JSON.stringify(value)}`);
}

// ─── Fechas — sin Date, sin reloj, sin red ─────────────────────────────

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// Cota de plausibilidad de calendario, no clínica — solo para descartar
// entradas disparatadas (año 0, año 9999...) sin pretender validar nada
// sobre la vida real del usuario.
const MIN_ADMITTED_YEAR = 1900;
const MAX_ADMITTED_YEAR = 2999;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

interface ParsedDateKey {
  year: number;
  month: number;
  day: number;
}

function parseDateKeyFormat(dateKey: unknown): ParsedDateKey | null {
  if (typeof dateKey !== "string") return null;
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function isCalendarDateInRange(parsed: ParsedDateKey): boolean {
  if (parsed.year < MIN_ADMITTED_YEAR || parsed.year > MAX_ADMITTED_YEAR) return false;
  if (parsed.month < 1 || parsed.month > 12) return false;
  if (parsed.day < 1 || parsed.day > daysInMonth(parsed.year, parsed.month)) return false;
  return true;
}

/** Conversión pura fecha-civil → número de día (algoritmo days_from_civil
    de Howard Hinnant, verificado durante el diseño incluyendo un cambio de
    año). Nunca usa Date ni el reloj del sistema — solo aritmética entera. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// ─── Vocabularios conocidos y su orden canónico ────────────────────────

const KNOWN_DAY_LABELS: ReadonlySet<string> = new Set(["strength", "rest", "cardio", "mixed", "unclassified"]);
const WEIGHTABLE_DAY_LABELS: ReadonlySet<string> = new Set(["strength", "rest", "cardio", "mixed"]);

const KNOWN_WEEKLY_POLICY_REQUIREMENTS: ReadonlySet<string> = new Set([
  "weekly_kcal_target_not_resolved",
  "distribution_policy_not_resolved",
]);
const WEEKLY_POLICY_REQUIREMENT_ORDER: readonly WeeklyPolicyRequirement[] = [
  "weekly_kcal_target_not_resolved",
  "distribution_policy_not_resolved",
];

const KNOWN_DAY_MACRO_POLICY_REQUIREMENTS: ReadonlySet<string> = new Set([
  "protein_target_not_resolved",
  "fat_target_not_resolved",
]);
const DAY_MACRO_POLICY_REQUIREMENT_ORDER: readonly DayMacroPolicyRequirement[] = [
  "protein_target_not_resolved",
  "fat_target_not_resolved",
];

const DAILY_ALLOCATION_INVALID_REASON_ORDER: readonly WeeklyPlanDailyAllocationInvalidReason[] = [
  "daily_macro_allocation_invalid",
  "daily_macro_allocation_unexpected_unresolved",
];

const WEEKLY_INFEASIBLE_REASON_ORDER: readonly WeeklyPlanInfeasibleReason[] = [
  "distributed_kcal_target_non_positive",
  "macro_allocation_infeasible",
];

// Mismo orden que la unión declarada en nutrition-weekly-plan.ts.
const STRUCTURAL_REASON_ORDER: readonly WeeklyPlanStructuralInvalidReason[] = [
  "request_object_invalid",
  "energy_policy_status_invalid",
  "energy_policy_reasons_invalid",
  "days_not_array",
  "days_count_invalid",
  "day_object_invalid",
  "date_key_format_invalid",
  "date_key_out_of_range",
  "duplicate_date_key",
  "date_keys_not_consecutive",
  "day_label_invalid",
  "day_macro_status_invalid",
  "day_macro_reasons_invalid",
  "weekly_kcal_target_invalid",
  "weekly_kcal_target_rounds_to_zero",
  "weekly_kcal_target_unsafe",
  "distribution_kind_invalid",
  "distribution_weights_invalid",
  "distribution_weights_all_zero",
  "distribution_weights_numeric_range_unsafe",
  "weight_key_unknown_label",
  "weight_missing_for_label",
  "weight_missing_for_date",
  "weight_present_for_unknown_date",
  "unclassified_incompatible_with_weighted_by_label",
  "explicit_daily_targets_invalid",
  "explicit_daily_targets_missing_for_date",
  "explicit_daily_targets_extra_date",
  "explicit_daily_targets_sum_mismatch",
  "distribution_result_unsafe",
];

/** Detalle interno de canonicalización — SIN `export`, igual que en
    macro-allocation-kernel.ts: sin duplicados, orden fijo, nunca muta el
    array recibido. Probado solo indirectamente a través de planWeek(). */
function canonicalizeStructuralReasons(
  reasons: readonly WeeklyPlanStructuralInvalidReason[],
): NonEmptyStructuralInvalidReasons {
  const present = new Set(reasons);
  const ordered = STRUCTURAL_REASON_ORDER.filter((reason) => present.has(reason));
  return ordered as NonEmptyStructuralInvalidReasons;
}

function canonicalizeWeeklyPolicyReasons(
  reasons: readonly WeeklyPolicyRequirement[],
): NonEmptyWeeklyPolicyRequirements {
  const present = new Set(reasons);
  return WEEKLY_POLICY_REQUIREMENT_ORDER.filter((reason) => present.has(reason)) as NonEmptyWeeklyPolicyRequirements;
}

function canonicalizeDayMacroReasons(
  reasons: readonly DayMacroPolicyRequirement[],
): NonEmptyDayMacroPolicyRequirements {
  const present = new Set(reasons);
  return DAY_MACRO_POLICY_REQUIREMENT_ORDER.filter((reason) =>
    present.has(reason),
  ) as NonEmptyDayMacroPolicyRequirements;
}

function canonicalizeDailyAllocationReasons(
  reasons: readonly WeeklyPlanDailyAllocationInvalidReason[],
): [WeeklyPlanDailyAllocationInvalidReason, ...WeeklyPlanDailyAllocationInvalidReason[]] {
  const present = new Set(reasons);
  return DAILY_ALLOCATION_INVALID_REASON_ORDER.filter((reason) => present.has(reason)) as [
    WeeklyPlanDailyAllocationInvalidReason,
    ...WeeklyPlanDailyAllocationInvalidReason[],
  ];
}

function canonicalizeInfeasibleReasons(
  reasons: readonly WeeklyPlanInfeasibleReason[],
): NonEmptyWeeklyPlanInfeasibleReasons {
  const present = new Set(reasons);
  return WEEKLY_INFEASIBLE_REASON_ORDER.filter((reason) => present.has(reason)) as NonEmptyWeeklyPlanInfeasibleReasons;
}

// ─── Clasificación estructural de un día individual ────────────────────

type DayMacroClassification =
  | { kind: "resolved"; proteinTargetG: unknown; fatTargetG: unknown }
  | { kind: "unresolved"; reasons: NonEmptyDayMacroPolicyRequirements }
  | { kind: "invalid"; reason: "day_macro_status_invalid" | "day_macro_reasons_invalid" };

function classifyDayMacros(rawMacros: unknown): DayMacroClassification {
  if (!isPlainRecord(rawMacros)) return { kind: "invalid", reason: "day_macro_status_invalid" };
  const status = rawMacros.status;
  if (status !== "resolved" && status !== "unresolved") {
    return { kind: "invalid", reason: "day_macro_status_invalid" };
  }
  if (status === "resolved") {
    return { kind: "resolved", proteinTargetG: rawMacros.proteinTargetG, fatTargetG: rawMacros.fatTargetG };
  }
  const rawReasons: unknown = rawMacros.reasons;
  if (!Array.isArray(rawReasons) || rawReasons.length === 0) {
    return { kind: "invalid", reason: "day_macro_reasons_invalid" };
  }
  if (rawReasons.some((reason) => !KNOWN_DAY_MACRO_POLICY_REQUIREMENTS.has(reason as string))) {
    return { kind: "invalid", reason: "day_macro_reasons_invalid" };
  }
  return { kind: "unresolved", reasons: canonicalizeDayMacroReasons(rawReasons as DayMacroPolicyRequirement[]) };
}

interface ParsedDay {
  dateKey: string;
  label: DayLabel;
  macros: DayMacroClassification & ({ kind: "resolved" } | { kind: "unresolved" });
}

/** Un día "usable" solo si objeto/dateKey/label/macros son estructuralmente
    correctos por separado — null en cualquier otro caso. Los motivos
    correspondientes ya quedaron acumulados en `reasonsOut` por el llamador. */
function parseDayStructure(rawDay: unknown, reasonsOut: WeeklyPlanStructuralInvalidReason[]): ParsedDay | null {
  if (!isPlainRecord(rawDay)) {
    reasonsOut.push("day_object_invalid");
    return null;
  }
  let usable = true;

  const parsedDate = parseDateKeyFormat(rawDay.dateKey);
  if (parsedDate === null) {
    reasonsOut.push("date_key_format_invalid");
    usable = false;
  } else if (!isCalendarDateInRange(parsedDate)) {
    reasonsOut.push("date_key_out_of_range");
    usable = false;
  }

  const rawLabel = rawDay.label;
  if (typeof rawLabel !== "string" || !KNOWN_DAY_LABELS.has(rawLabel)) {
    reasonsOut.push("day_label_invalid");
    usable = false;
  }

  const macros = classifyDayMacros(rawDay.macros);
  if (macros.kind === "invalid") {
    reasonsOut.push(macros.reason);
    usable = false;
  }

  if (!usable) return null;
  return {
    dateKey: rawDay.dateKey as string,
    label: rawLabel as DayLabel,
    macros: macros as DayMacroClassification & ({ kind: "resolved" } | { kind: "unresolved" }),
  };
}

// ─── Validación de mapas de pesos / targets explícitos ────────────────

interface WeightsMapValidation {
  reasons: WeeklyPlanStructuralInvalidReason[];
  valuesByKey: Map<string, number> | null;
}

function validateNumericWeightsMap(
  rawWeights: unknown,
  requiredKeys: readonly string[],
  isKnownKey: (key: string) => boolean,
  unknownKeyReason: WeeklyPlanStructuralInvalidReason,
  missingKeyReason: WeeklyPlanStructuralInvalidReason,
): WeightsMapValidation {
  if (!isPlainRecord(rawWeights)) {
    return { reasons: ["distribution_weights_invalid"], valuesByKey: null };
  }
  const reasons: WeeklyPlanStructuralInvalidReason[] = [];
  const valuesByKey = new Map<string, number>();
  let sawInvalidValue = false;
  // Solo propiedades propias enumerables — nunca `for...in`, para no
  // confiar en nada heredado de la cadena de prototipos.
  for (const key of Object.keys(rawWeights)) {
    if (!isKnownKey(key)) {
      reasons.push(unknownKeyReason);
      continue;
    }
    const value = rawWeights[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      sawInvalidValue = true;
      continue;
    }
    valuesByKey.set(key, value);
  }
  if (sawInvalidValue) reasons.push("distribution_weights_invalid");
  for (const key of requiredKeys) {
    if (!valuesByKey.has(key)) reasons.push(missingKeyReason);
  }
  if (reasons.length > 0) return { reasons, valuesByKey: null };
  return { reasons: [], valuesByKey };
}

/** Un peso POSITIVO que normaliza a 0 exacto (underflow IEEE-754) nunca se
    trata como un cero legítimo — se rechaza explícitamente. Ver el caso
    Number.MIN_VALUE junto a Number.MAX_VALUE verificado durante el diseño. */
function validateWeightsSafety(effectiveWeights: readonly number[]): WeeklyPlanStructuralInvalidReason[] {
  if (effectiveWeights.every((weight) => weight === 0)) {
    return ["distribution_weights_all_zero"];
  }
  const maxWeight = Math.max(...effectiveWeights);
  if (!Number.isFinite(maxWeight) || maxWeight <= 0) {
    return ["distribution_weights_numeric_range_unsafe"];
  }
  const normalized = effectiveWeights.map((weight) => weight / maxWeight);
  for (let i = 0; i < effectiveWeights.length; i++) {
    if (effectiveWeights[i] > 0 && normalized[i] === 0) {
      return ["distribution_weights_numeric_range_unsafe"];
    }
  }
  const normalizedSum = normalized.reduce((total, weight) => total + weight, 0);
  if (!Number.isFinite(normalizedSum) || normalizedSum <= 0) {
    return ["distribution_weights_numeric_range_unsafe"];
  }
  return [];
}

interface ExplicitTargetsValidation {
  reasons: WeeklyPlanStructuralInvalidReason[];
  targetsByDateKey: Map<string, number> | null;
}

function validateExplicitDailyTargets(
  rawTargets: unknown,
  dateKeys: readonly string[],
  roundedWeeklyKcalTarget: number,
): ExplicitTargetsValidation {
  if (!isPlainRecord(rawTargets)) {
    return { reasons: ["explicit_daily_targets_invalid"], targetsByDateKey: null };
  }
  const dateKeySet = new Set(dateKeys);
  const reasons: WeeklyPlanStructuralInvalidReason[] = [];
  const targetsByDateKey = new Map<string, number>();
  let sawInvalidValue = false;
  for (const key of Object.keys(rawTargets)) {
    if (!dateKeySet.has(key)) {
      reasons.push("explicit_daily_targets_extra_date");
      continue;
    }
    const value = rawTargets[key];
    if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value) || value < 0) {
      sawInvalidValue = true;
      continue;
    }
    targetsByDateKey.set(key, value);
  }
  if (sawInvalidValue) reasons.push("explicit_daily_targets_invalid");
  for (const dateKey of dateKeys) {
    if (!targetsByDateKey.has(dateKey)) reasons.push("explicit_daily_targets_missing_for_date");
  }
  if (reasons.length > 0) return { reasons, targetsByDateKey: null };
  let sum = 0;
  for (const dateKey of dateKeys) sum += targetsByDateKey.get(dateKey) as number;
  if (sum !== roundedWeeklyKcalTarget) {
    return { reasons: ["explicit_daily_targets_sum_mismatch"], targetsByDateKey: null };
  }
  return { reasons: [], targetsByDateKey };
}

// ─── Método del resto mayor (largest remainder) ───────────────────────

/** Reparte `roundedTarget` (entero) entre `weights.length` días proporcionalmente
    a `weights` (siempre relativos: normalizar por el máximo cancela
    algebraicamente en la proporción — ver el comentario de
    WeeklyDistributionPolicy). Garantiza por construcción que la suma del
    resultado sea exactamente `roundedTarget`. Desempate determinista por
    `dateKeys` ascendente cuando varios días comparten el mismo resto
    fraccionario (el caso típico de `uniform`, donde todos los pesos son
    iguales). Asume que `weights` ya pasó validateWeightsSafety.

    Devuelve `null` (nunca lanza) si `leftover` no cae en el rango
    matemáticamente esperado — ver la comprobación defensiva más abajo. */
function computeLargestRemainderShares(
  roundedTarget: number,
  weights: readonly number[],
  dateKeys: readonly string[],
): number[] | null {
  const maxWeight = Math.max(...weights);
  const normalized = weights.map((weight) => weight / maxWeight);
  const normalizedSum = normalized.reduce((total, weight) => total + weight, 0);
  const rawShares = normalized.map((weight) => (weight / normalizedSum) * roundedTarget);
  const floors = rawShares.map((share) => Math.floor(share));
  const flooredSum = floors.reduce((total, floor) => total + floor, 0);
  const leftover = roundedTarget - flooredSum;

  // Defensivo: algebraicamente, sum(rawShares) = roundedTarget exacto, así
  // que leftover SIEMPRE cae en [0, weights.length) — cada floor() se queda
  // como mucho 1 unidad por debajo de su valor real, y como mucho
  // weights.length-1 días pueden necesitar ese +1. En punto flotante, para
  // magnitudes extremas de roundedTarget (cerca de Number.MAX_SAFE_INTEGER)
  // el error de redondeo acumulado en rawShares podría en teoría desplazar
  // flooredSum fuera de ese rango — se comprueba explícitamente en vez de
  // confiar solo en la prueba algebraica, y se rechaza (null ->
  // distribution_result_unsafe en el llamador) antes de intentar repartir
  // un leftover que no tendría sentido, en vez de dejar que el bucle de
  // abajo distribuya de más/de menos en silencio.
  if (!Number.isSafeInteger(leftover) || leftover < 0 || leftover >= weights.length) {
    return null;
  }

  const remainders = rawShares.map((share, index) => ({
    index,
    remainder: share - floors[index],
    dateKey: dateKeys[index],
  }));
  remainders.sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0;
  });

  const shares = [...floors];
  let remaining = leftover;
  for (let i = 0; i < remainders.length && remaining > 0; i++, remaining--) {
    shares[remainders[i].index] += 1;
  }
  return shares;
}

// ─── Punto de entrada ───────────────────────────────────────────────

/** Punto de entrada del kernel de plan semanal. Ver
    nutrition-weekly-plan.ts para el contrato completo. Validación runtime
    COMPLETA sobre `request` tratado como `unknown`: TypeScript garantiza su
    forma en código bien tipado, pero un caller no-TS, JSON, o un simple
    `as` puede colar cualquier cosa — el kernel nunca confía ciegamente en
    el tipo declarado, igual que allocateDailyMacros. */
export function planWeek(request: WeeklyPlanRequest): WeeklyPlanResult {
  const rawRequest: unknown = request;
  if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
    return invalidRequest(["request_object_invalid"]);
  }
  const req = rawRequest as Record<string, unknown>;
  const structuralReasons: WeeklyPlanStructuralInvalidReason[] = [];

  // ─── Fase 1a: forma estructural de energyPolicy (+ validación completa
  // de todo lo declarado "resolved" salvo lo que requiere el conjunto de
  // días, que se completa en la fase 1c).
  type EnergyPolicyOutcome =
    | { kind: "invalid" }
    | { kind: "unresolved"; reasons: NonEmptyWeeklyPolicyRequirements }
    | {
        kind: "resolved_pending_distribution";
        rawWeeklyKcalTarget: number;
        roundedWeeklyKcalTarget: number;
        distributionKind: "uniform" | "weighted_by_label" | "weighted_by_date" | "explicit_daily_targets";
        rawWeights: unknown;
        rawExplicitTargets: unknown;
      };

  let energyPolicyOutcome: EnergyPolicyOutcome = { kind: "invalid" };
  const rawEnergyPolicy = req.energyPolicy;
  if (!isPlainRecord(rawEnergyPolicy)) {
    structuralReasons.push("energy_policy_status_invalid");
  } else {
    const status = rawEnergyPolicy.status;
    if (status !== "resolved" && status !== "unresolved") {
      structuralReasons.push("energy_policy_status_invalid");
    } else if (status === "unresolved") {
      const rawReasons: unknown = rawEnergyPolicy.reasons;
      if (
        !Array.isArray(rawReasons) ||
        rawReasons.length === 0 ||
        rawReasons.some((reason) => !KNOWN_WEEKLY_POLICY_REQUIREMENTS.has(reason as string))
      ) {
        structuralReasons.push("energy_policy_reasons_invalid");
      } else {
        energyPolicyOutcome = {
          kind: "unresolved",
          reasons: canonicalizeWeeklyPolicyReasons(rawReasons as WeeklyPolicyRequirement[]),
        };
      }
    } else {
      const rawWeeklyKcalTarget = rawEnergyPolicy.weeklyKcalTarget;
      let roundedWeeklyKcalTarget: number | null = null;
      if (typeof rawWeeklyKcalTarget !== "number" || !Number.isFinite(rawWeeklyKcalTarget) || rawWeeklyKcalTarget <= 0) {
        structuralReasons.push("weekly_kcal_target_invalid");
      } else {
        const rounded = Math.round(rawWeeklyKcalTarget);
        if (rounded <= 0) {
          structuralReasons.push("weekly_kcal_target_rounds_to_zero");
        } else if (!Number.isSafeInteger(rounded)) {
          structuralReasons.push("weekly_kcal_target_unsafe");
        } else {
          roundedWeeklyKcalTarget = rounded;
        }
      }

      const rawDistribution = rawEnergyPolicy.distribution;
      let distributionKind: "uniform" | "weighted_by_label" | "weighted_by_date" | "explicit_daily_targets" | null =
        null;
      let rawWeights: unknown;
      let rawExplicitTargets: unknown;
      if (!isPlainRecord(rawDistribution)) {
        structuralReasons.push("distribution_kind_invalid");
      } else {
        const kind = rawDistribution.kind;
        if (kind === "uniform") {
          distributionKind = "uniform";
        } else if (kind === "weighted_by_label") {
          distributionKind = "weighted_by_label";
          rawWeights = rawDistribution.weights;
        } else if (kind === "weighted_by_date") {
          distributionKind = "weighted_by_date";
          rawWeights = rawDistribution.weights;
        } else if (kind === "explicit_daily_targets") {
          distributionKind = "explicit_daily_targets";
          rawExplicitTargets = rawDistribution.dailyKcalTargets;
        } else {
          structuralReasons.push("distribution_kind_invalid");
        }
      }

      if (roundedWeeklyKcalTarget !== null && distributionKind !== null) {
        // `roundedWeeklyKcalTarget !== null` solo puede ser cierto por la
        // rama que ya validó `typeof rawWeeklyKcalTarget === "number"`
        // arriba — TypeScript no enlaza esa narrowing con esta variable
        // independiente, de ahí el cast explícito y justificado.
        energyPolicyOutcome = {
          kind: "resolved_pending_distribution",
          rawWeeklyKcalTarget: rawWeeklyKcalTarget as number,
          roundedWeeklyKcalTarget,
          distributionKind,
          rawWeights,
          rawExplicitTargets,
        };
      }
    }
  }

  // ─── Fase 1b: forma estructural de `days` (siempre presente y validado,
  // independientemente del estado de energyPolicy).
  const rawDays = req.days;
  let sortedDays: ParsedDay[] | null = null;
  if (!Array.isArray(rawDays)) {
    structuralReasons.push("days_not_array");
  } else if (rawDays.length !== 7) {
    structuralReasons.push("days_count_invalid");
  } else {
    const parsed = rawDays.map((rawDay) => parseDayStructure(rawDay, structuralReasons));
    if (parsed.every((day): day is ParsedDay => day !== null)) {
      const dateKeys = parsed.map((day) => day.dateKey);
      if (new Set(dateKeys).size !== dateKeys.length) {
        structuralReasons.push("duplicate_date_key");
      } else {
        const dayNumbers = parsed.map((day) => {
          const p = parseDateKeyFormat(day.dateKey) as ParsedDateKey;
          return daysFromCivil(p.year, p.month, p.day);
        });
        const sortedNumbers = [...dayNumbers].sort((a, b) => a - b);
        let consecutive = true;
        for (let i = 1; i < sortedNumbers.length; i++) {
          if (sortedNumbers[i] !== sortedNumbers[i - 1] + 1) {
            consecutive = false;
            break;
          }
        }
        if (!consecutive) {
          structuralReasons.push("date_keys_not_consecutive");
        } else {
          sortedDays = [...parsed].sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
        }
      }
    }
  }

  // ─── Fase 1c: validación cruzada de la política de reparto contra el
  // conjunto de 7 días — solo si TODO lo anterior sigue limpio, porque de
  // lo contrario el conjunto de días o la política no son de fiar.
  let resolvedDistributionPlan:
    | { kind: "uniform" }
    | { kind: "weighted_by_label"; weightsByLabel: Map<string, number> }
    | { kind: "weighted_by_date"; weightsByDateKey: Map<string, number> }
    | { kind: "explicit_daily_targets"; targetsByDateKey: Map<string, number> }
    | null = null;

  if (
    structuralReasons.length === 0 &&
    sortedDays !== null &&
    energyPolicyOutcome.kind === "resolved_pending_distribution"
  ) {
    const outcome = energyPolicyOutcome;
    const dateKeys = sortedDays.map((day) => day.dateKey);
    if (outcome.distributionKind === "uniform") {
      resolvedDistributionPlan = { kind: "uniform" };
    } else if (outcome.distributionKind === "weighted_by_label") {
      const usedLabels = new Set(sortedDays.map((day) => day.label).filter((label) => label !== "unclassified"));
      if (sortedDays.some((day) => day.label === "unclassified")) {
        structuralReasons.push("unclassified_incompatible_with_weighted_by_label");
      }
      const validation = validateNumericWeightsMap(
        outcome.rawWeights,
        [...usedLabels],
        (key) => WEIGHTABLE_DAY_LABELS.has(key),
        "weight_key_unknown_label",
        "weight_missing_for_label",
      );
      structuralReasons.push(...validation.reasons);
      if (validation.valuesByKey !== null) {
        // Excluye los días "unclassified": ya quedaron marcados como
        // incompatibles arriba y nunca tienen entrada en valuesByKey (no
        // pertenecen a usedLabels) — incluirlos aquí metería `undefined`
        // en el array y contaminaría la comprobación de seguridad con un
        // NaN espurio en vez de dejar que la única razón sea la
        // incompatibilidad ya reportada.
        const effectiveWeights = sortedDays
          .filter((day) => day.label !== "unclassified")
          .map((day) => validation.valuesByKey!.get(day.label) as number);
        // Si los 7 días son "unclassified", el array queda vacío — la
        // incompatibilidad ya fue reportada arriba; no tiene sentido
        // evaluar "todos a cero" sobre un conjunto vacío (sería
        // vacuously true y añadiría una razón engañosa).
        const safetyReasons = effectiveWeights.length > 0 ? validateWeightsSafety(effectiveWeights) : [];
        structuralReasons.push(...safetyReasons);
        if (safetyReasons.length === 0 && effectiveWeights.length > 0) {
          resolvedDistributionPlan = { kind: "weighted_by_label", weightsByLabel: validation.valuesByKey };
        }
      }
    } else if (outcome.distributionKind === "weighted_by_date") {
      const validation = validateNumericWeightsMap(
        outcome.rawWeights,
        dateKeys,
        (key) => dateKeys.includes(key),
        "weight_present_for_unknown_date",
        "weight_missing_for_date",
      );
      structuralReasons.push(...validation.reasons);
      if (validation.valuesByKey !== null) {
        const effectiveWeights = sortedDays.map((day) => validation.valuesByKey!.get(day.dateKey) as number);
        const safetyReasons = validateWeightsSafety(effectiveWeights);
        structuralReasons.push(...safetyReasons);
        if (safetyReasons.length === 0) {
          resolvedDistributionPlan = { kind: "weighted_by_date", weightsByDateKey: validation.valuesByKey };
        }
      }
    } else {
      const validation = validateExplicitDailyTargets(
        outcome.rawExplicitTargets,
        dateKeys,
        outcome.roundedWeeklyKcalTarget,
      );
      structuralReasons.push(...validation.reasons);
      if (validation.targetsByDateKey !== null) {
        resolvedDistributionPlan = { kind: "explicit_daily_targets", targetsByDateKey: validation.targetsByDateKey };
      }
    }
  }

  // ─── Fase 2: cualquier invalidez (estructural o de política resuelta) →
  // invalid_input/request. Nunca se llega aquí por culpa de un día con
  // macros pendientes: eso no es un WeeklyPlanStructuralInvalidReason.
  if (structuralReasons.length > 0) {
    return invalidRequest(structuralReasons);
  }

  // A partir de aquí, `sortedDays` está garantizado no-null (si fuera
  // null, algún structuralReason ya se habría añadido arriba).
  const days = sortedDays as ParsedDay[];

  // ─── Fase 3: unresolved_input — solo si no hubo ninguna invalidez.
  const unresolvedDayIssues: NonEmptyDayMacroIssues[number][] = [];
  for (const day of days) {
    if (day.macros.kind === "unresolved") {
      unresolvedDayIssues.push({ dateKey: day.dateKey, reasons: day.macros.reasons });
    }
  }

  if (energyPolicyOutcome.kind === "unresolved" && unresolvedDayIssues.length > 0) {
    const result: WeeklyPlanUnresolvedInput = {
      status: "unresolved_input",
      scope: "both",
      weeklyReasons: energyPolicyOutcome.reasons,
      unresolvedDays: unresolvedDayIssues as NonEmptyDayMacroIssues,
    };
    return result;
  }
  if (energyPolicyOutcome.kind === "unresolved") {
    const result: WeeklyPlanUnresolvedInput = {
      status: "unresolved_input",
      scope: "energy_policy",
      weeklyReasons: energyPolicyOutcome.reasons,
    };
    return result;
  }
  if (unresolvedDayIssues.length > 0) {
    const result: WeeklyPlanUnresolvedInput = {
      status: "unresolved_input",
      scope: "days",
      unresolvedDays: unresolvedDayIssues as NonEmptyDayMacroIssues,
    };
    return result;
  }

  // A partir de aquí: energyPolicy resuelta y completamente válida, los 7
  // días tienen macros resueltas — listos para repartir y ejecutar.
  if (energyPolicyOutcome.kind !== "resolved_pending_distribution" || resolvedDistributionPlan === null) {
    // Inalcanzable: si llegamos aquí sin invalidez ni pendientes, la única
    // posibilidad es que la política estuviera resuelta y su plan de
    // reparto se hubiera construido en la fase 1c.
    throw new Error("Nutrition Engine v4 — estado de reparto semanal inconsistente");
  }
  const { rawWeeklyKcalTarget, roundedWeeklyKcalTarget } = energyPolicyOutcome;
  const dateKeys = days.map((day) => day.dateKey);

  // ─── Fase 4: reparto.
  let distributedKcalTargets: number[] | null;
  if (resolvedDistributionPlan.kind === "explicit_daily_targets") {
    const targets = resolvedDistributionPlan.targetsByDateKey;
    distributedKcalTargets = dateKeys.map((dateKey) => targets.get(dateKey) as number);
  } else {
    let weights: number[];
    if (resolvedDistributionPlan.kind === "uniform") {
      weights = days.map(() => 1);
    } else if (resolvedDistributionPlan.kind === "weighted_by_label") {
      const weightsByLabel = resolvedDistributionPlan.weightsByLabel;
      weights = days.map((day) => weightsByLabel.get(day.label) as number);
    } else if (resolvedDistributionPlan.kind === "weighted_by_date") {
      const weightsByDateKey = resolvedDistributionPlan.weightsByDateKey;
      weights = days.map((day) => weightsByDateKey.get(day.dateKey) as number);
    } else {
      return assertNever(resolvedDistributionPlan);
    }
    distributedKcalTargets = computeLargestRemainderShares(roundedWeeklyKcalTarget, weights, dateKeys);
  }

  if (distributedKcalTargets === null) {
    return invalidRequest(["distribution_result_unsafe"]);
  }
  const distributedSum = distributedKcalTargets.reduce((total, share) => total + share, 0);
  if (distributedKcalTargets.some((share) => !Number.isSafeInteger(share)) || distributedSum !== roundedWeeklyKcalTarget) {
    return invalidRequest(["distribution_result_unsafe"]);
  }

  // ─── Fase 5: ejecución diaria vía allocateDailyMacros (PR2A) — su
  // aritmética y su validación numérica no se duplican aquí en ningún caso.
  // Se acumulan DOS arrays en paralelo: `okDayResults` (solo días "ok",
  // tipado MacroAllocationOk) y `executedDayResults` (días "ok" o
  // "infeasible", tipado MacroAllocationOk | MacroAllocationInfeasible) —
  // cada uno recibe su elemento ya con el tipo correcto directamente desde
  // la rama del switch que lo produjo, sin ningún cast posterior.
  const okDayResults: WeeklyPlanOkDayResult[] = [];
  const executedDayResults: WeeklyPlanInfeasibleDayResult[] = [];
  const diagnostics: WeeklyPlanPartialDayDiagnostic[] = [];

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const distributedKcalTarget = distributedKcalTargets[i];

    if (distributedKcalTarget <= 0) {
      const diagnosticKind: WeeklyPlanPartialDayDiagnosticKind = { kind: "non_positive_share", distributedKcalTarget };
      diagnostics.push({ dateKey: day.dateKey, diagnostic: diagnosticKind });
      continue;
    }

    // day.macros.kind === "resolved" está garantizado: cualquier día
    // "unresolved" ya habría producido unresolved_input en la Fase 3.
    const macros = day.macros as { kind: "resolved"; proteinTargetG: unknown; fatTargetG: unknown };
    const allocationRequest = {
      status: "resolved",
      kcalTarget: distributedKcalTarget,
      proteinTargetG: macros.proteinTargetG,
      fatTargetG: macros.fatTargetG,
    } as MacroAllocationRequest;
    const allocation = allocateDailyMacros(allocationRequest);

    switch (allocation.status) {
      case "ok": {
        // El switch real sobre allocation.status estrecha `allocation` a
        // MacroAllocationOk aquí mismo — ningún cast hace ese trabajo.
        const dayResult: WeeklyPlanOkDayResult = { dateKey: day.dateKey, label: day.label, distributedKcalTarget, allocation };
        okDayResults.push(dayResult);
        executedDayResults.push(dayResult);
        break;
      }
      case "infeasible": {
        executedDayResults.push({ dateKey: day.dateKey, label: day.label, distributedKcalTarget, allocation });
        diagnostics.push({ dateKey: day.dateKey, diagnostic: { kind: "infeasible", allocation } });
        break;
      }
      case "invalid_input": {
        diagnostics.push({ dateKey: day.dateKey, diagnostic: { kind: "rejected_by_pr2a", allocation } });
        break;
      }
      case "unresolved_input": {
        // Defensivo: PR2B siempre construye peticiones "resolved" para
        // PR2A, así que esta rama no debería alcanzarse nunca en la
        // práctica — pero se maneja igualmente, sin lanzar, por la misma
        // disciplina de "función total" del resto del motor.
        diagnostics.push({ dateKey: day.dateKey, diagnostic: { kind: "rejected_by_pr2a", allocation } });
        break;
      }
      default:
        assertNever(allocation);
    }
  }

  // ─── Fase 6: veredicto final. Un rechazo de PR2A siempre gana sobre una
  // inviabilidad nutricional o una cuota no positiva.
  if (diagnostics.length === 0) {
    // Ningún diagnóstico -> ningún día fue infeasible/rechazado/cuota-cero,
    // así que los 7 días ejecutados cayeron en el case "ok" de arriba. Se
    // comprueba explícitamente en runtime (no se asume solo por lógica) antes
    // de tratar `okDayResults` como la tupla de 7 que exige WeeklyPlanOk.
    if (okDayResults.length !== 7) {
      throw new Error("Nutrition Engine v4 — estado de reparto semanal inconsistente (esperados 7 días ok)");
    }
    const days7 = okDayResults as WeeklyPlanOkDays;
    const reconstructedWeeklyKcalTotal = days7.reduce((total, day) => total + day.allocation.kcal, 0);
    const energy: WeeklyEnergyAudit = {
      requestedWeeklyKcal: rawWeeklyKcalTarget,
      roundedWeeklyKcalTarget,
      distributedWeeklyKcalTotal: distributedSum,
      distributionRoundingDeltaKcal: distributedSum - roundedWeeklyKcalTarget,
      reconstructedWeeklyKcalTotal,
      macroReconstructionDeltaKcal: reconstructedWeeklyKcalTotal - roundedWeeklyKcalTarget,
      totalDeltaFromRequestedWeeklyKcal: reconstructedWeeklyKcalTotal - rawWeeklyKcalTarget,
    };
    const result: WeeklyPlanOk = { status: "ok", days: days7, energy };
    return result;
  }

  const rejectedByPr2a = diagnostics.filter((d) => d.diagnostic.kind === "rejected_by_pr2a");
  if (rejectedByPr2a.length > 0) {
    const reasons: WeeklyPlanDailyAllocationInvalidReason[] = [];
    for (const d of rejectedByPr2a) {
      // d.diagnostic.kind === "rejected_by_pr2a" ya está probado por el
      // filter de arriba — TypeScript no propaga ese narrowing a través de
      // .filter(), así que se repite aquí con el discriminante real en vez
      // de un cast a una forma inventada.
      if (d.diagnostic.kind !== "rejected_by_pr2a") continue;
      reasons.push(
        d.diagnostic.allocation.status === "unresolved_input"
          ? "daily_macro_allocation_unexpected_unresolved"
          : "daily_macro_allocation_invalid",
      );
    }
    const result: WeeklyPlanInvalidDailyAllocationError = {
      status: "invalid_input",
      scope: "daily_allocation",
      reasons: canonicalizeDailyAllocationReasons(reasons),
      partialDiagnostics: diagnostics as [WeeklyPlanPartialDayDiagnostic, ...WeeklyPlanPartialDayDiagnostic[]],
    };
    return result;
  }

  const infeasibleReasons: WeeklyPlanInfeasibleReason[] = [];
  if (diagnostics.some((d) => d.diagnostic.kind === "non_positive_share")) {
    infeasibleReasons.push("distributed_kcal_target_non_positive");
  }
  if (diagnostics.some((d) => d.diagnostic.kind === "infeasible")) {
    infeasibleReasons.push("macro_allocation_infeasible");
  }
  const result: WeeklyPlanInfeasible = {
    status: "infeasible",
    reasons: canonicalizeInfeasibleReasons(infeasibleReasons),
    requestedWeeklyKcal: rawWeeklyKcalTarget,
    roundedWeeklyKcalTarget,
    partialDiagnostics: diagnostics as [WeeklyPlanPartialDayDiagnostic, ...WeeklyPlanPartialDayDiagnostic[]],
    days: executedDayResults,
  };
  return result;
}

function invalidRequest(reasons: WeeklyPlanStructuralInvalidReason[]): WeeklyPlanInvalidRequestError {
  return { status: "invalid_input", scope: "request", reasons: canonicalizeStructuralReasons(reasons) };
}
