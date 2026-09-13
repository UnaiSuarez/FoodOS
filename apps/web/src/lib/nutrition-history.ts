"use client";

// PR A — coherencia histórica nutricional: hook compartido que combina el
// rango remoto de nutrition_goals con el ledger local y el resolver puro
// (nutrition.ts) en un único resultado listo para pintar. Las 4 vistas que
// comparaban días pasados contra el objetivo de HOY (state.nutrition) deben
// consumir esto en vez de reimplementar la resolución cada una por su
// cuenta — ver el diseño aprobado para el detalle de cada regla.

import { useEffect, useState } from "react";
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

/**
 * PR A (diseño §5): resultado EXPLÍCITO de cargar nutrition_goals por
 * rango — loading/error nunca se traducen en 60 días "unknown_target"
 * silenciosos. En "error" conserva el último resultado bueno conocido (o
 * un Map vacío si nunca hubo uno), para que la UI pueda seguir mostrando lo
 * que ya tenía mientras avisa del fallo. Usa getNutritionGoalsRangeWithStatus
 * (data-layer.ts) — un método NUEVO; no toca getNutritionGoalsRange ni sus
 * 3 llamadas existentes de la pestaña "Adaptativo".
 */
export function useNutritionGoalsRangeState(referenceDate: string, windowDays: number): NutritionGoalsRangeState {
  const [rangeState, setRangeState] = useState<NutritionGoalsRangeState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setRangeState((prev) => (prev.status === "loading" ? prev : { status: "loading" }));
    const fromDateKey = dateOffset(referenceDate, -(windowDays - 1));
    void remote.getNutritionGoalsRangeWithStatus(fromDateKey, referenceDate).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setRangeState({ status: "ready", goalsByDate: new Map(result.rows.map((r) => [r.goalDate, r])) });
      } else {
        setRangeState((prev) => ({
          status: "error",
          error: result.error,
          goalsByDate: prev.status === "ready" ? prev.goalsByDate : new Map(),
        }));
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceDate, windowDays]);

  return rangeState;
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
 */
export function useAdherenceWindow(state: FoodOSState, todayKey: string, windowDays: number): AdherenceWindow {
  const remoteRange = useNutritionGoalsRangeState(todayKey, windowDays);
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
