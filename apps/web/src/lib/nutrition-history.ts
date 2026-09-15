"use client";

// PR A — coherencia histórica nutricional: hook compartido que combina el
// rango remoto de nutrition_goals con el ledger local y el resolver puro
// (nutrition.ts) en un único resultado listo para pintar. Las 4 vistas que
// comparaban días pasados contra el objetivo de HOY (state.nutrition) deben
// consumir esto en vez de reimplementar la resolución cada una por su
// cuenta — ver el diseño aprobado para el detalle de cada regla.

import { useEffect, useRef, useState } from "react";
import type { DayAdherenceStatus, FoodOSState, MacroTotals, SanitizedRemoteGoalRow } from "@foodos/types";
import { remote } from "./data-layer";
import {
  classifyDayAdherence,
  getAdherenceStats,
  getAdherenceStreakFromStatuses,
  resolveHistoricalGoal,
  type AdherenceStats,
} from "./nutrition";
import { dateOffset } from "./utils";

export type NutritionGoalsRangeState =
  | { status: "loading" }
  | { status: "ready"; goalsByDate: Map<string, SanitizedRemoteGoalRow> }
  | { status: "error"; error: string; goalsByDate: Map<string, SanitizedRemoteGoalRow> };

type NutritionGoalsRangeAction =
  | { type: "fetch-start" }
  | { type: "fetch-success"; goalsByDate: Map<string, SanitizedRemoteGoalRow> }
  | { type: "fetch-error"; error: string };

/**
 * PR A (revisión — P1): transición de estado PURA, separada del efecto de
 * React que la dispara. `lastGood` viaja FUERA del `NutritionGoalsRangeState`
 * devuelto (que sí pasa por "loading" sin datos) precisamente para que un
 * fallo posterior a una recarga pueda recuperarlo — el bug corregido era
 * que el hook inspeccionaba el `prev` de React (ya en "loading", sin
 * `goalsByDate`) en vez de un valor que sobreviviera esa transición.
 */
export function reduceNutritionGoalsRangeState(
  lastGood: Map<string, SanitizedRemoteGoalRow>,
  action: NutritionGoalsRangeAction,
): { next: NutritionGoalsRangeState; lastGood: Map<string, SanitizedRemoteGoalRow> } {
  switch (action.type) {
    case "fetch-start":
      return { next: { status: "loading" }, lastGood };
    case "fetch-success":
      return { next: { status: "ready", goalsByDate: action.goalsByDate }, lastGood: action.goalsByDate };
    case "fetch-error":
      return { next: { status: "error", error: action.error, goalsByDate: lastGood }, lastGood };
  }
}

/**
 * PR A (diseño §5): resultado EXPLÍCITO de cargar nutrition_goals por
 * rango — loading/error nunca se traducen en 60 días "unknown_target"
 * silenciosos. En "error" conserva el último resultado bueno conocido (o
 * un Map vacío si nunca hubo uno), para que la UI pueda seguir mostrando lo
 * que ya tenía mientras avisa del fallo. Usa getNutritionGoalsRangeWithStatus
 * (data-layer.ts) — un método NUEVO; no toca getNutritionGoalsRange ni sus
 * 3 llamadas existentes de la pestaña "Adaptativo".
 */
interface ScopedGoalsMap {
  scopeKey: string;
  goalsByDate: Map<string, SanitizedRemoteGoalRow>;
}

/**
 * PR A (revisión — P1): decide si el último resultado bueno debe
 * descartarse por pertenecer a otro ámbito (cuenta/sesión). Extraída como
 * función pura — separada del useEffect que la dispara — para poder probar
 * el aislamiento por cuenta sin renderizar el hook. Mismo `scopeKey`:
 * devuelve la MISMA referencia (sin reset). `scopeKey` distinto: descarta
 * el mapa anterior por completo, nunca lo mezcla ni lo conserva parcialmente.
 */
export function resetLastGoodForScope(current: ScopedGoalsMap, scopeKey: string): ScopedGoalsMap {
  return current.scopeKey === scopeKey ? current : { scopeKey, goalsByDate: new Map() };
}

export interface ScopedRangeState {
  scopeKey: string;
  value: NutritionGoalsRangeState;
}

/**
 * PR A (revisión 3 — P1): el enmascarado en sí, extraído como función pura
 * para poder probar el render transitorio SIN renderizar React. Si el
 * `scopeKey` guardado no coincide con el que se pide, se devuelve
 * `{status:"loading"}` incondicionalmente — nunca el `value` guardado,
 * sea cual sea su estado (`ready`, `error` o `loading` de otra cuenta).
 */
export function maskRangeStateForScope(scopedRangeState: ScopedRangeState, scopeKey: string): NutritionGoalsRangeState {
  return scopedRangeState.scopeKey === scopeKey ? scopedRangeState.value : { status: "loading" };
}

/**
 * PR A (revisión 3 — P1, fallo de timing): `useEffect` corre DESPUÉS del
 * render. Si el estado interno se guardara sin su propio `scopeKey` (como
 * antes), el PRIMER render tras un cambio de cuenta A→B devolvería
 * TODAVÍA el `rangeState` de A (React pinta con lo que ya había en
 * `useState` antes de que el efecto llegue a ejecutarse) — modificar
 * `lastGoodRef` dentro del efecto no protege ese render, porque el valor
 * devuelto sale de `rangeState`, no del ref.
 *
 * La corrección: el propio `NutritionGoalsRangeState` guardado en
 * `useState` viaja etiquetado con el `scopeKey` de la consulta que lo
 * produjo (`ScopedRangeState`), y el enmascarado ocurre en el CUERPO de la
 * función, en cada render, comparando ese `scopeKey` guardado contra el
 * `scopeKey` que se está pidiendo AHORA MISMO — nunca dentro de un efecto.
 * Si no coinciden, se devuelve `{status:"loading"}` sin más, sea cual sea
 * el estado interno. Esto aísla por construcción incluso el primer render,
 * sin depender de que ningún efecto (ni siquiera `useLayoutEffect`) llegue
 * a correr antes de pintar.
 */
export function useNutritionGoalsRangeState(
  scopeKey: string,
  referenceDate: string,
  windowDays: number,
): NutritionGoalsRangeState {
  const [scopedRangeState, setScopedRangeState] = useState<ScopedRangeState>({
    scopeKey,
    value: { status: "loading" },
  });
  // Vive fuera de React state a propósito (ver reduceNutritionGoalsRangeState):
  // debe sobrevivir intacto a la transición por "loading" de cada recarga,
  // pero SOLO dentro del mismo scopeKey — ver resetLastGoodForScope. Esto
  // es bookkeeping INTERNO del efecto (qué mapa usar como fallback de error
  // en la PRÓXIMA respuesta) — no sustituye el enmascarado del valor
  // devuelto, que ocurre más abajo sobre `scopedRangeState`.
  const lastGoodRef = useRef<ScopedGoalsMap>({ scopeKey, goalsByDate: new Map() });

  useEffect(() => {
    let cancelled = false;

    // Descarta el resultado bueno de la sesión anterior antes de que la
    // nueva consulta empiece — protege el FALLBACK de error de la consulta
    // que este efecto está a punto de lanzar, no el render (eso ya lo
    // garantiza el enmascarado de más abajo, que actúa antes que esto).
    lastGoodRef.current = resetLastGoodForScope(lastGoodRef.current, scopeKey);

    const started = reduceNutritionGoalsRangeState(lastGoodRef.current.goalsByDate, { type: "fetch-start" });
    setScopedRangeState({ scopeKey, value: started.next });
    const fromDateKey = dateOffset(referenceDate, -(windowDays - 1));
    void remote.getNutritionGoalsRangeWithStatus(fromDateKey, referenceDate).then((result) => {
      if (cancelled) return;
      const action: NutritionGoalsRangeAction = result.ok
        ? { type: "fetch-success", goalsByDate: new Map(result.rows.map((r) => [r.goalDate, r])) }
        : { type: "fetch-error", error: result.error };
      const outcome = reduceNutritionGoalsRangeState(lastGoodRef.current.goalsByDate, action);
      lastGoodRef.current = { scopeKey, goalsByDate: outcome.lastGood };
      setScopedRangeState({ scopeKey, value: outcome.next });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, referenceDate, windowDays]);

  // Enmascarado EN EL RENDER, nunca en un efecto: por construcción, no
  // puede filtrarse el resultado de A al renderizar B, ni siquiera en el
  // primer render tras el cambio, antes de que useEffect llegue a ejecutarse.
  return maskRangeStateForScope(scopedRangeState, scopeKey);
}

/**
 * PR A (revisión — P1): texto explícito según el estado del fetch remoto —
 * "loading" y "error" nunca comparten el mismo mensaje (antes ambos
 * mostraban "Cargando histórico completo…", indistinguibles para quien lee).
 * "ready" no tiene nota (null): las cifras ya son completas.
 */
export function adherenceFreshnessNote(remoteStatus: NutritionGoalsRangeState["status"]): string | null {
  if (remoteStatus === "loading") return "Cargando histórico completo…";
  if (remoteStatus === "error") return "No se pudo actualizar el histórico completo — mostrando datos locales/provisionales.";
  return null;
}

export interface AdherenceWindow {
  /** `targets` es el objetivo resuelto para esa fecha (null si
   *  unknown_target); `consumed` son los totales reales de foodLog ese día
   *  (null si no hay registros) — expuestos juntos para que los
   *  consumidores que dibujan barras de % (MacroWeekChart, StatsMacroChart)
   *  no tengan que volver a resolver ni sumar el diario por su cuenta. */
  history: Array<{ date: string; status: DayAdherenceStatus; targets: MacroTotals | null; consumed: MacroTotals | null }>;
  stats: AdherenceStats;
  streak: number;
  /** false mientras el rango remoto no esté "ready" (loading o error) —
   *  ver diseño §6: nunca presentar un % global como definitivo sobre un
   *  subconjunto local incompleto. */
  historyComplete: boolean;
  remoteStatus: NutritionGoalsRangeState["status"];
}

function sumDay(state: FoodOSState, date: string): MacroTotals | null {
  const entries = state.foodLog.filter((e) => e.date === date);
  if (!entries.length) return null;
  return {
    kcal: entries.reduce((s, e) => s + e.kcal, 0),
    protein: entries.reduce((s, e) => s + e.protein, 0),
    carbs: entries.reduce((s, e) => s + e.carbs, 0),
    fat: entries.reduce((s, e) => s + e.fat, 0),
  };
}

/**
 * Combina fetch remoto + ledger local + resolver + clasificación en un
 * solo hook. `windowDays` debe ser el mayor de los consumidores de la
 * vista (60, para incluir la racha — ver diseño §6); recortar a una
 * ventana menor para mostrar es responsabilidad de quien llama
 * (`history.slice(-N)`), nunca un fetch nuevo.
 *
 * Mientras `remoteStatus !== "ready"`, `history` sigue resolviendo cada
 * fecha con lo que YA hay disponible (ledger local, si existe para esa
 * fecha) — nunca se bloquea en blanco — pero `historyComplete` queda en
 * `false` para que la UI no presente el % como definitivo (diseño §6).
 *
 * `scopeKey` (revisión — P1): identidad explícita de a quién pertenece esta
 * ventana — pásale `authUser?.id ?? "local"` desde el llamador. Ver
 * useNutritionGoalsRangeState para el porqué (aislamiento de cuenta).
 */
export function useAdherenceWindow(state: FoodOSState, todayKey: string, windowDays: number, scopeKey: string): AdherenceWindow {
  const remoteRange = useNutritionGoalsRangeState(scopeKey, todayKey, windowDays);
  const goalsByDate = remoteRange.status === "loading" ? new Map<string, SanitizedRemoteGoalRow>() : remoteRange.goalsByDate;

  const history: AdherenceWindow["history"] = [];
  for (let i = 0; i < windowDays; i++) {
    const date = dateOffset(todayKey, -(windowDays - 1 - i));
    const resolved = resolveHistoricalGoal(date, todayKey, goalsByDate, state.nutritionGoalsHistory);
    const consumed = sumDay(state, date);
    history.push({ date, status: classifyDayAdherence(resolved, consumed), targets: resolved.targets, consumed });
  }

  const statuses = history.map((h) => h.status);
  return {
    history,
    stats: getAdherenceStats(statuses),
    streak: getAdherenceStreakFromStatuses(statuses),
    historyComplete: remoteRange.status === "ready",
    remoteStatus: remoteRange.status,
  };
}

/**
 * PR A (revisión — P5): unknown_target (sin objetivo) y unlogged (objetivo
 * conocido, sin consumo) comparten el tratamiento NEUTRO en las gráficas de
 * barras (MacroWeekChart, StatsMacroChart) — ninguno de los dos es "0%
 * cumplido"; ambos son "no evaluable" (ver diseño §7). Extraída como
 * función pura para que ambos componentes usen exactamente el mismo
 * criterio y para poder probarlo sin renderizar React.
 */
export function isNeutralAdherenceStatus(status: DayAdherenceStatus): boolean {
  return status === "unknown_target" || status === "unlogged";
}

export interface EvaluableFraction {
  /** "3/5", o "—" cuando no hay ningún día evaluable. */
  label: string;
  hasEvaluableDays: boolean;
}

/**
 * PR A (revisión — P3): denominador REAL de días evaluables (excluye
 * unknown_target/unlogged), nunca un "/7" fijo — "0 || 7" convertía
 * silenciosamente cero días evaluables en un falso "0/7". Con
 * evaluableCount === 0 no hay fracción que mostrar en absoluto.
 * Compartida por HomeView y MacroAdherencePanel para no duplicar el
 * criterio (y poder probarlo una sola vez).
 */
export function describeEvaluableFraction(hitCount: number, evaluableCount: number): EvaluableFraction {
  return evaluableCount > 0
    ? { label: `${hitCount}/${evaluableCount}`, hasEvaluableDays: true }
    : { label: "—", hasEvaluableDays: false };
}
