/**
 * Núcleo matemático puro de asignación diaria de macros — Nutrition Engine
 * v4, PR2A. Recibe kcal/proteína/grasa objetivo YA DECIDIDOS por una capa
 * superior (política de proteína, política de grasa, TDEE×factor) y solo
 * ejecuta la aritmética: redondear una vez cada macro, comprobar
 * factibilidad, derivar carbohidratos del residuo, reconstruir kcal.
 *
 * CERO imports de otros tipos de este paquete a propósito: la entrada son
 * solo números y estados de política, nunca Sex/GoalMode/MacroTotals — esos
 * pertenecen a decisiones que este kernel no conoce ni necesita importar
 * por anticipación.
 *
 * Corrige el defecto real de v3.1 (ver apps/web/src/lib/nutrition.ts,
 * calcDailyTargets): ahí la grasa se redondea DOS veces (una a kcal, otra
 * a gramos desde ese kcal ya redondeado) y una infactibilidad se oculta
 * con `Math.max(0, carbs)`. Este kernel redondea cada macro una única vez
 * y expone la infactibilidad como un estado propio, nunca como un 0
 * silencioso. PR2A permanece INERTE: v3.1 sigue funcionando exactamente
 * igual que hoy, con el mismo doble redondeo, hasta que una futura PR de
 * integración, explícita y separada, conecte este kernel a apps/web.
 */

/** Qué política/dato concreto sigue sin resolver — cerrado, nunca string[]. */
export type MacroPolicyRequirement =
  | "kcal_target_not_resolved"
  | "protein_target_not_resolved"
  | "fat_target_not_resolved";

/** Tupla no vacía a nivel de TIPO — impide construir un request "unresolved"
    sin al menos un motivo declarado, en código TypeScript normal. No es una
    garantía en runtime: un caller no-TS, JSON, o un cast puede colar un
    array vacío pese al tipo — ver "unresolved_reasons_missing" más abajo
    para ese caso. */
export type NonEmptyMacroPolicyRequirements = [MacroPolicyRequirement, ...MacroPolicyRequirement[]];

/**
 * Entrada discriminada del kernel. "resolved" es la ÚNICA forma de aportar
 * los tres números; "unresolved" es la ÚNICA forma de decir "todavía no sé
 * cuál es la política" — sin simular esa ausencia con 0, NaN, o cualquier
 * otro valor centinela. El kernel nunca infiere cuál de los dos casos
 * aplica a partir de los números: el caller lo declara explícitamente.
 */
export type MacroAllocationRequest =
  | { status: "resolved"; kcalTarget: number; proteinTargetG: number; fatTargetG: number }
  | { status: "unresolved"; reasons: NonEmptyMacroPolicyRequirements };

/** Entrada numéricamente ilegítima — nunca incluye nada relacionado con
    factibilidad (ver MacroAllocationInfeasibleReason, familia separada). */
export type MacroAllocationInvalidReason =
  /** `request` en sí no es un objeto con status "resolved" ni "unresolved"
      — cubre null, undefined, strings/números/booleanos, arrays (que no
      tienen status propio), y objetos sin la clave `status` o con un valor
      desconocido en ella. Colado en runtime pese al tipo (caller no-TS,
      JSON, cast). Se comprueba ANTES que cualquier otra cosa, sin leer
      ningún otro campo primero: sin esto, un status desconocido caería por
      defecto en la rama "resolved" e informaría el motivo equivocado
      (p. ej. "kcal_target_invalid" cuando el problema real es el status). */
  | "request_status_invalid"
  | "kcal_target_invalid"
  /** kcalTarget > 0 pero Math.round(kcalTarget) === 0 — ocurre exactamente
      cuando 0 < kcalTarget < 0.5 (verificado: Number.MIN_VALUE, 0.1 y 0.49
      redondean a 0; 0.5 y 0.51 redondean a 1, porque Math.round redondea
      los empates hacia +Infinity). Impide que el OBJETIVO mismo colapse a
      cero antes de repartir nada — NO garantiza que el resultado final
      (reconstructedKcal) sea positivo: con un objetivo mínimo como
      kcalTarget=0.5 (roundedTargetKcal=1) y proteína/grasa en 0, el
      redondeo de carbohidratos a gramos enteros puede legítimamente
      producir reconstructedKcal=0 — ver el comentario de MacroAllocationOk
      sobre qué garantiza "ok" y qué no. Distinto de "kcal_target_invalid"
      (que juzga el valor CRUDO): este se detecta DESPUÉS de redondear. */
  | "kcal_target_rounds_to_zero"
  | "protein_target_invalid"
  | "fat_target_invalid"
  /** Algún entero redondeado o alguna suma/producto intermedio — incluidos
      los de la fase de carbohidratos (remainingKcal, carbsG, carbsG*4,
      reconstructedKcal) — queda fuera de Number.isSafeInteger. La prueba
      algebraica de ±2/±2.5 kcal solo es válida si JavaScript representa
      esos enteros con exactitud; sin esta comprobación, un caso cercano a
      Number.MAX_SAFE_INTEGER puede pasar el primer barrido (los valores de
      partida son seguros) y romperse igualmente al redondear carbohidratos
      y multiplicar por 4 (posible desbordar el límite seguro por muy poco).
      Nunca un límite clínico inventado: puramente una consecuencia de
      IEEE-754. */
  | "numeric_range_unsafe"
  /** request.status === "unresolved" y reasons es un array VACÍO — llegó
      así en runtime pese al tipo NonEmptyMacroPolicyRequirements. Una
      declaración de "no resuelto" sin ningún motivo es en sí misma una
      entrada inválida, nunca un unresolved_input mudo que el caller no
      pueda explicar. Estrictamente para el array vacío — si reasons ni
      siquiera es un array, o contiene algo que no es un
      MacroPolicyRequirement, ver "unresolved_reason_invalid". */
  | "unresolved_reasons_missing"
  /** request.status === "unresolved" y reasons es ilegítimo de cualquier
      otra forma: no es un array en absoluto (string, número, objeto...), o
      es un array con al menos un elemento que NO pertenece a
      MacroPolicyRequirement (caller no-TS, JSON, cast). El kernel nunca
      descarta en silencio el motivo desconocido para quedarse con los
      válidos — un solo elemento ilegítimo invalida toda la petición, para
      no devolver un unresolved_input que parezca completo sin serlo. */
  | "unresolved_reason_invalid";

/** Asignación matemáticamente inviable con datos VÁLIDOS — nunca aparece
    junto a un motivo de invalidez ni de política sin resolver. */
export type MacroAllocationInfeasibleReason = "protein_and_fat_exceed_rounded_kcal_target";

/** Auditoría de un macro cuyo valor se pide explícitamente (proteína,
    grasa) — permite explicar por qué, p. ej., 66.4 g se convirtió en 66 g. */
export interface MacroGramsAudit {
  requestedG: number;
  /** round(requestedG) — el único redondeo que sufre este macro. */
  assignedG: number;
  /** assignedG - requestedG. Límite |·| ≤ 0.5 (semántica de Math.round). */
  deltaG: number;
}

/** Reconstrucción energética con los dos niveles de delta SIEMPRE
    separados — nunca se llama "targetKcal" a un valor distinto del
    solicitado sin conservar también el original. */
export interface EnergyReconstruction {
  /** El valor decimal exacto de la petición — nunca se pierde ni se redondea aquí. */
  requestedKcal: number;
  /** round(requestedKcal) — el ancla ENTERA contra la que se mide la asignación de macros. */
  roundedTargetKcal: number;
  /** roundedTargetKcal - requestedKcal. Límite |·| ≤ 0.5, con igualdad solo
      en el caso límite de una mitad exacta. Math.round redondea esos
      empates SIEMPRE hacia +Infinity — no es redondeo bancario (round-half-
      to-even) ni simétrico respecto a cero; como aquí todo valor validado
      es ≥0, un empate exacto siempre sube. */
  inputRoundingDeltaKcal: number;
  /** 4·protein + 9·fat + 4·carbs, con los tres gramos ya redondeados. */
  reconstructedKcal: number;
  /** reconstructedKcal - roundedTargetKcal. Límite |·| ≤ 2 kcal — el óptimo
      posible con carbohidratos en gramos enteros (medio gramo × 4 kcal/g).
      Ambos operandos son enteros exactos: comparar en tests con igualdad
      estricta, nunca con tolerancia. */
  macroRoundingDeltaKcal: number;
  /**
   * Identidad ALGEBRAICA exacta en aritmética real:
   *   totalDeltaFromRequestedKcal = inputRoundingDeltaKcal + macroRoundingDeltaKcal
   * El kernel NO usa esa fórmula para calcularlo — lo obtiene por resta
   * DIRECTA (reconstructedKcal - requestedKcal), para no sumar dos errores
   * de representación en coma flotante en vez de uno. Con decimales
   * binarios (p. ej. 1779.2, no representable exactamente) las dos vías
   * pueden diferir en un épsilon de coma flotante — los tests deben
   * comparar con tolerancia explícita (`toBeCloseTo`), nunca con igualdad
   * estricta. Límite teórico |·| ≤ 2.5 kcal, por desigualdad triangular
   * sobre los dos límites anteriores.
   */
  totalDeltaFromRequestedKcal: number;
}

/**
 * "ok" significa "asignación representable dentro del error de redondeo
 * permitido" (|macroRoundingDeltaKcal| ≤ 2, ver EnergyReconstruction) —
 * NUNCA "kcal reconstruidas positivas". Para un objetivo mínimo
 * representable (kcalTarget=0.5, roundedTargetKcal=1, proteína=grasa=0),
 * redondear el residuo de carbohidratos a gramos enteros produce
 * legítimamente carbs.assignedG=0 y por tanto kcal=0 — sigue siendo "ok"
 * porque cumple la cota matemática exactamente igual que cualquier otro
 * caso. El kernel no impone ningún mínimo nutricional (p. ej. "nunca menos
 * de 800 kcal") — eso pertenece a la política superior que decide qué
 * kcalTarget resolver antes de llamar a este kernel.
 */
export interface MacroAllocationOk {
  status: "ok";
  protein: MacroGramsAudit;
  fat: MacroGramsAudit;
  /** Los carbohidratos nunca tienen un "requested" propio — siempre se
      derivan del residuo, nunca se piden como número aparte. */
  carbs: { assignedG: number };
  /** = energy.reconstructedKcal — conveniencia para no obligar a leer el objeto anidado. */
  kcal: number;
  energy: EnergyReconstruction;
}

/** Inviable DESPUÉS de redondear proteína, grasa y kcal — los mismos
    enteros que de verdad se devolverían. La factibilidad se decide sobre
    ellos, nunca sobre los decimales de entrada, precisamente porque el
    redondeo puede cambiar cuál lado de la desigualdad gana (ver los casos
    de "sorpresa de redondeo" en los tests: valores decimalmente factibles
    que dejan de serlo al redondear, y viceversa). */
export interface MacroAllocationInfeasible {
  status: "infeasible";
  reasons: [MacroAllocationInfeasibleReason];
  /** Los tres valores decimales de la petición, conservados para que el
      caller pueda mostrar "por decimales parecía viable" si aplica. */
  requestedKcal: number;
  requestedProteinG: number;
  requestedFatG: number;
  /** Los mismos tres valores YA redondeados que se usaron para decidir. */
  roundedTargetKcal: number;
  proteinG: number;
  fatG: number;
  /** Siempre positivo: por cuántas kcal excede proteína+grasa (ya
      redondeadas) al objetivo (ya redondeado). */
  exceedsRoundedTargetByKcal: number;
}

export interface MacroAllocationInvalidInput {
  status: "invalid_input";
  /** Sin duplicados, en orden canónico fijo — nunca depende del orden en
      que el kernel evaluó sus comprobaciones internas. */
  reasons: MacroAllocationInvalidReason[];
}

/** Espeja request.status="unresolved" — el kernel no decide nada, solo lo
    hace explícito en la salida con la misma forma cerrada de motivos,
    canonicalizada (sin duplicados, orden fijo, nunca el array original del
    caller ni mutado). */
export interface MacroAllocationUnresolvedInput {
  status: "unresolved_input";
  reasons: NonEmptyMacroPolicyRequirements;
}

export type MacroAllocationResult =
  | MacroAllocationOk
  | MacroAllocationInfeasible
  | MacroAllocationInvalidInput
  | MacroAllocationUnresolvedInput;
