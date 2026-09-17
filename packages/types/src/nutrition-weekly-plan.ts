/**
 * Plan semanal — Nutrition Engine v4, PR2B. Reparte un total energético
 * semanal YA DECIDIDO entre 7 días, según una política de reparto
 * EXPLÍCITA, y llama una vez por día a `allocateDailyMacros` (PR2A) — sin
 * reimplementar ni un ápice de su aritmética. Sigue INERTE: no se conecta
 * a apps/web, no persiste nada, no toca Supabase.
 *
 * A diferencia de nutrition-evidence.ts y nutrition-macro-allocation.ts,
 * este archivo SÍ importa de un hermano dentro del mismo paquete
 * (nutrition-macro-allocation.ts) — deliberado: PR2B está genuinamente
 * construido sobre el contrato de PR2A (reutiliza sus tipos de resultado
 * diario tal cual, nunca los duplica), y ambos siguen viviendo en
 * @foodos/types sin crear ningún ciclo entre paquetes.
 *
 * Responsabilidad exacta y fronteras — ver el diseño discutido:
 * - NO decide el total energético semanal ni su tamaño (déficit/superávit).
 * - NO decide proteína/grasa por día — las recibe ya resueltas.
 * - NO reimplementa el redondeo de macros ni la factibilidad diaria — eso
 *   es responsabilidad exclusiva de allocateDailyMacros.
 * - NO estima gasto de entrenamiento ni hace eat-back — una etiqueta de día
 *   ("strength", etc.) es una declaración del caller, nunca un cálculo.
 * - NO tiene memoria entre semanas — es una función pura de una sola
 *   invocación; el Adaptive Coordinator (futuro) decide re-planificar
 *   llamando de nuevo, no editando un estado que PR2B recuerde.
 */

import type {
  MacroAllocationInfeasible,
  MacroAllocationInvalidInput,
  MacroAllocationOk,
  MacroAllocationUnresolvedInput,
  MacroPolicyRequirement,
} from "./nutrition-macro-allocation";

// ─── Días ──────────────────────────────────────────────────────────────

export type DayLabel = "strength" | "rest" | "cardio" | "mixed" | "unclassified";

/** Igual que MacroPolicyRequirement de PR2A menos "kcal_target_not_resolved"
    — a este nivel el kcal del día lo calcula PR2B a partir del reparto
    semanal; el día nunca lo declara por sí mismo. */
export type DayMacroPolicyRequirement = Exclude<MacroPolicyRequirement, "kcal_target_not_resolved">;
export type NonEmptyDayMacroPolicyRequirements = [DayMacroPolicyRequirement, ...DayMacroPolicyRequirement[]];

export type DayMacroInput =
  | { status: "resolved"; proteinTargetG: number; fatTargetG: number }
  | { status: "unresolved"; reasons: NonEmptyDayMacroPolicyRequirements };

export interface WeeklyPlanDayInput {
  /** "YYYY-MM-DD" — fecha de calendario pura, nunca un Date. Ver la
      validación completa (año admitido, mes/día reales, bisiestos) en el
      kernel. */
  dateKey: string;
  label: DayLabel;
  macros: DayMacroInput;
}

// ─── Política energética semanal ──────────────────────────────────────

export type WeeklyPolicyRequirement = "weekly_kcal_target_not_resolved" | "distribution_policy_not_resolved";
export type NonEmptyWeeklyPolicyRequirements = [WeeklyPolicyRequirement, ...WeeklyPolicyRequirement[]];

/**
 * Los pesos son SIEMPRE relativos (una proporción frente a la suma de los
 * pesos efectivos de los 7 días), nunca kcal absolutas — multiplicar todos
 * los pesos por una constante no cambia el reparto (ver la normalización
 * por el máximo en el kernel, y su matiz sobre IEEE-754 en los comentarios
 * de validación más abajo).
 */
export type WeeklyDistributionPolicy =
  | { kind: "uniform" }
  /** Un peso por label EFECTIVAMENTE USADA entre los 7 días — una label
      declarada pero no usada esa semana no es error (el mapa puede
      reutilizarse entre semanas con distinta composición de días).
      "unclassified" nunca puede tener peso propio: es incompatible con
      esta política si algún día lo usa. */
  | { kind: "weighted_by_label"; weights: Readonly<Partial<Record<Exclude<DayLabel, "unclassified">, number>>> }
  /** Un peso por dateKey — exactamente las 7 fechas del plan, ni más ni
      menos. Elegido en vez de pesos posicionales porque un array de 7
      posiciones sería ambiguo frente al reordenamiento de `days` (la salida
      siempre se ordena por fecha, independientemente del orden de
      entrada) — una clave por fecha elimina esa ambigüedad por
      construcción. */
  | { kind: "weighted_by_date"; weights: Readonly<Record<string, number>> }
  /** Los 7 objetivos ya decididos día a día. `weeklyKcalTarget` sigue
      siendo la única autoridad: estos 7 valores, ya redondeados, deben
      sumar EXACTAMENTE roundedWeeklyKcalTarget o la petición es inválida
      — nunca una segunda fuente de verdad silenciosamente distinta. */
  | { kind: "explicit_daily_targets"; dailyKcalTargets: Readonly<Record<string, number>> };

export type WeeklyEnergyPolicy =
  | { status: "resolved"; weeklyKcalTarget: number; distribution: WeeklyDistributionPolicy }
  | { status: "unresolved"; reasons: NonEmptyWeeklyPolicyRequirements };

export interface WeeklyPlanRequest {
  energyPolicy: WeeklyEnergyPolicy;
  /** SIEMPRE presente y validado estructuralmente, incluso si energyPolicy
      todavía no está resuelta — ver la precedencia de validación en el
      kernel: primero se agota TODA la validación de lo ya declarado como
      resuelto (incluida la política energética completa), y solo entonces
      se decide si lo pendiente es "unresolved". */
  days: readonly WeeklyPlanDayInput[]; // exactamente 7, validado en runtime
}

// ─── invalid_input — dos variantes, diagnóstico obligatorio por tipo ──

/** Errores detectados ANTES de intentar repartir energía o llamar a PR2A —
    nunca incluyen diagnóstico por día porque no llegó a haber ninguno. */
export type WeeklyPlanStructuralInvalidReason =
  | "request_object_invalid"
  | "energy_policy_status_invalid"
  | "energy_policy_reasons_invalid"
  | "days_not_array"
  | "days_count_invalid"
  | "day_object_invalid"
  | "date_key_format_invalid"
  | "date_key_out_of_range"
  | "duplicate_date_key"
  | "date_keys_not_consecutive"
  | "day_label_invalid"
  | "day_macro_status_invalid"
  | "day_macro_reasons_invalid"
  | "weekly_kcal_target_invalid"
  | "weekly_kcal_target_rounds_to_zero"
  | "weekly_kcal_target_unsafe"
  | "distribution_kind_invalid"
  | "distribution_weights_invalid"
  | "distribution_weights_all_zero"
  /** Un peso POSITIVO que, tras normalizar dividiendo por el mayor peso
      efectivo, resulta en 0 exacto (underflow de IEEE-754) — nunca se
      convierte en silencio un peso positivo en peso cero. También cubre
      que normalizedSum no sea finita y positiva. */
  | "distribution_weights_numeric_range_unsafe"
  | "weight_key_unknown_label"
  | "weight_missing_for_label"
  | "weight_missing_for_date"
  | "weight_present_for_unknown_date"
  | "unclassified_incompatible_with_weighted_by_label"
  | "explicit_daily_targets_invalid"
  | "explicit_daily_targets_missing_for_date"
  | "explicit_daily_targets_extra_date"
  | "explicit_daily_targets_sum_mismatch"
  /** Defensivo, en dos capas: (1) el propio `leftover` del método del resto
      mayor fuera de [0, 7) o no seguro, comprobado ANTES de repartirlo; (2)
      alguna cuota final fuera de Number.isSafeInteger, o la suma repartida
      sin coincidir exactamente con el objetivo semanal ya redondeado —
      comprobado después. Verificado que ni siquiera weeklyKcalTarget =
      Number.MAX_SAFE_INTEGER lo dispara (ver el test de magnitud extrema),
      pero se comprueba igualmente por la misma disciplina de "función
      total" del resto del motor, en vez de confiar solo en la prueba
      algebraica de que el resto mayor siempre reparte exacto. */
  | "distribution_result_unsafe";

export type NonEmptyStructuralInvalidReasons = [WeeklyPlanStructuralInvalidReason, ...WeeklyPlanStructuralInvalidReason[]];

export interface WeeklyPlanInvalidRequestError {
  status: "invalid_input";
  scope: "request";
  reasons: NonEmptyStructuralInvalidReasons;
}

/** Un día rechazó la asignación — PR2A dijo que la entrada (ya construida
    por PR2B) no era válida, o (defensivo, no debería ocurrir nunca dado
    que PR2B siempre construye peticiones "resolved") dijo "unresolved". Es
    un rechazo de ENTRADA, nunca una imposibilidad nutricional — ver
    WeeklyPlanInfeasibleReason, familia completamente separada. */
export type WeeklyPlanDailyAllocationInvalidReason =
  | "daily_macro_allocation_invalid"
  | "daily_macro_allocation_unexpected_unresolved";

export type NonEmptyDailyAllocationInvalidReasons = [
  WeeklyPlanDailyAllocationInvalidReason,
  ...WeeklyPlanDailyAllocationInvalidReason[],
];

/** Diagnóstico de un día que NO llegó a "ok" durante el reparto/ejecución
    — nunca comparte forma con WeeklyPlanOkDayResult ni con
    WeeklyPlanInfeasibleDayResult, para que no se pueda confundir con un
    resultado completo. */
export type WeeklyPlanPartialDayDiagnosticKind =
  | { kind: "rejected_by_pr2a"; allocation: MacroAllocationInvalidInput | MacroAllocationUnresolvedInput }
  | { kind: "infeasible"; allocation: MacroAllocationInfeasible }
  | { kind: "non_positive_share"; distributedKcalTarget: number };

export interface WeeklyPlanPartialDayDiagnostic {
  dateKey: string;
  diagnostic: WeeklyPlanPartialDayDiagnosticKind;
}

/**
 * `partialDiagnostics` es OBLIGATORIA y no vacía a nivel de TIPO — no se
 * puede construir un rechazo de asignación diaria sin al menos un
 * diagnóstico, precisamente el problema que tenía la v2 con un campo
 * opcional. Conserva TODOS los diagnósticos no-ok encontrados en ese
 * intento (rechazos de PR2A, inviabilidades y cuotas no positivas que
 * coexistieran) — la invalidez decide el `status` exterior, pero ningún
 * diagnóstico se pierde.
 */
export interface WeeklyPlanInvalidDailyAllocationError {
  status: "invalid_input";
  scope: "daily_allocation";
  reasons: NonEmptyDailyAllocationInvalidReasons;
  partialDiagnostics: [WeeklyPlanPartialDayDiagnostic, ...WeeklyPlanPartialDayDiagnostic[]];
}

export type WeeklyPlanInvalidInput = WeeklyPlanInvalidRequestError | WeeklyPlanInvalidDailyAllocationError;

// ─── unresolved_input — unión discriminada por alcance ────────────────

export interface DayMacroIssue {
  dateKey: string;
  reasons: NonEmptyDayMacroPolicyRequirements;
}
export type NonEmptyDayMacroIssues = [DayMacroIssue, ...DayMacroIssue[]];

/**
 * Solo alcanzable cuando energyPolicy.status === "unresolved" desde el
 * principio: si energyPolicy es "resolved", TODA su validación (kcal,
 * política, mapas, cobertura, suma, seguridad numérica previa al reparto)
 * se agota primero — un día pendiente nunca oculta una política resuelta
 * pero malformada, que sería invalid_input/request en su lugar. Por eso
 * "energy_policy"/"both" solo surgen de la rama "unresolved" de
 * energyPolicy; "days" surge únicamente cuando esa política YA pasó toda
 * su validación.
 */
export type WeeklyPlanUnresolvedInput =
  | { status: "unresolved_input"; scope: "energy_policy"; weeklyReasons: NonEmptyWeeklyPolicyRequirements }
  | { status: "unresolved_input"; scope: "days"; unresolvedDays: NonEmptyDayMacroIssues }
  | {
      status: "unresolved_input";
      scope: "both";
      weeklyReasons: NonEmptyWeeklyPolicyRequirements;
      unresolvedDays: NonEmptyDayMacroIssues;
    };

// ─── infeasible ────────────────────────────────────────────────────────

/** Exclusivamente inviabilidades matemáticas reales — nunca un rechazo de
    entrada (ver WeeklyPlanDailyAllocationInvalidReason, familia separada). */
export type WeeklyPlanInfeasibleReason = "distributed_kcal_target_non_positive" | "macro_allocation_infeasible";
export type NonEmptyWeeklyPlanInfeasibleReasons = [WeeklyPlanInfeasibleReason, ...WeeklyPlanInfeasibleReason[]];

/**
 * Día de un resultado "ok" — `allocation` es SIEMPRE MacroAllocationOk, no
 * la unión completa de PR2A. Esto es a nivel de TIPO, no solo de
 * documentación: un `WeeklyPlanOk` no puede construirse (ni por el kernel
 * ni por ningún consumidor) con un día infeasible, rechazado o sin
 * resolver — sería un error de compilación, no solo una violación de un
 * comentario. Ver WeeklyPlanInfeasibleDayResult para el día de un
 * resultado "infeasible", que sí admite MacroAllocationInfeasible además
 * de MacroAllocationOk, pero NUNCA un rechazo de PR2A (ver
 * WeeklyPlanPartialDayDiagnosticKind — un rechazo de PR2A solo puede
 * aparecer dentro de partialDiagnostics con scope:"daily_allocation").
 */
export interface WeeklyPlanOkDayResult {
  dateKey: string;
  label: DayLabel;
  /** La cuota entera que el reparto semanal asignó a este día — el
      kcalTarget real pasado a allocateDailyMacros. */
  distributedKcalTarget: number;
  allocation: MacroAllocationOk;
}

/**
 * Día de un resultado "infeasible" — `allocation` es MacroAllocationOk (el
 * día individual salió bien aunque OTRO día del plan fue inviable) o
 * MacroAllocationInfeasible. NUNCA MacroAllocationInvalidInput ni
 * MacroAllocationUnresolvedInput: un rechazo de PR2A siempre gana por
 * precedencia y produce invalid_input/daily_allocation en su lugar, nunca
 * coexiste con un veredicto "infeasible" (ver el comentario de
 * WeeklyPlanInfeasible.partialDiagnostics).
 */
export interface WeeklyPlanInfeasibleDayResult {
  dateKey: string;
  label: DayLabel;
  distributedKcalTarget: number;
  allocation: MacroAllocationOk | MacroAllocationInfeasible;
}

export interface WeeklyPlanInfeasible {
  status: "infeasible";
  reasons: NonEmptyWeeklyPlanInfeasibleReasons;
  requestedWeeklyKcal: number;
  roundedWeeklyKcalTarget: number;
  /** Nunca contiene kind:"rejected_by_pr2a" — si lo hubiera, el resultado
      completo sería invalid_input/daily_allocation en su lugar (la
      invalidez tiene prioridad sobre la inviabilidad). */
  partialDiagnostics: [WeeklyPlanPartialDayDiagnostic, ...WeeklyPlanPartialDayDiagnostic[]];
  /** Todo día que SÍ recibió una llamada real a allocateDailyMacros (ok o
      infeasible) — excluye los de cuota no positiva, que nunca llegan a
      PR2A. */
  days: WeeklyPlanInfeasibleDayResult[];
}

// ─── ok ────────────────────────────────────────────────────────────────

export interface WeeklyEnergyAudit {
  requestedWeeklyKcal: number;
  roundedWeeklyKcalTarget: number;
  /** Suma de distributedKcalTarget de los 7 días — SIEMPRE igual a
      roundedWeeklyKcalTarget en un "ok" (invariante garantizado por
      construcción para las 4 políticas, incluida explicit_daily_targets
      tras la corrección de suma exacta). */
  distributedWeeklyKcalTotal: number;
  /** distributedWeeklyKcalTotal - roundedWeeklyKcalTarget. SIEMPRE 0 en
      un "ok". */
  distributionRoundingDeltaKcal: number;
  /** Suma de reconstructedKcal de los 7 días. */
  reconstructedWeeklyKcalTotal: number;
  /** reconstructedWeeklyKcalTotal - roundedWeeklyKcalTarget. Límite
      |·| ≤ 14 kcal (7 días × ≤2 kcal de PR2A, desigualdad triangular). */
  macroReconstructionDeltaKcal: number;
  /** reconstructedWeeklyKcalTotal - requestedWeeklyKcal, por resta
      DIRECTA (nunca suma de deltas parciales — mismo principio que PR2A).
      Límite |·| ≤ 14.5 kcal (0.5 + 0 + 14). */
  totalDeltaFromRequestedWeeklyKcal: number;
}

/** Tupla exacta de 7 — no un array — para que "un `WeeklyPlanOk` tiene
    exactamente 7 días, todos ok" sea una garantía del compilador y no solo
    una convención documentada. Orden por dateKey ascendente — SIEMPRE,
    independiente del orden de `days` en la entrada. */
export type WeeklyPlanOkDays = [
  WeeklyPlanOkDayResult,
  WeeklyPlanOkDayResult,
  WeeklyPlanOkDayResult,
  WeeklyPlanOkDayResult,
  WeeklyPlanOkDayResult,
  WeeklyPlanOkDayResult,
  WeeklyPlanOkDayResult,
];

export interface WeeklyPlanOk {
  status: "ok";
  days: WeeklyPlanOkDays;
  energy: WeeklyEnergyAudit;
}

export type WeeklyPlanResult = WeeklyPlanOk | WeeklyPlanInfeasible | WeeklyPlanInvalidInput | WeeklyPlanUnresolvedInput;
