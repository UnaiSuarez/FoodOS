"use client";

// Nutrition Engine v4 — panel de diagnóstico de SOLO LECTURA. Construye el
// input real con el adaptador (nutrition-v4-adapter.ts), lo evalúa con el
// ÚNICO gateway autorizado (nutrition-v4-coverage-gateway.ts) y muestra el
// resultado crudo. No escribe nada, no llama a Supabase, no genera ninguna
// propuesta, no cambia ningún objetivo, no activa nada — un informe, y
// solo eso. Los dos umbrales son parámetros EXPERIMENTALES de esta
// pantalla: viven en estado de componente (useState), nunca se guardan en
// `state.settings` ni se mutan en el diario.

import { useMemo, useState } from "react";
import type { DailyIntegrityWindowInput, NutrientKey } from "@foodos/types";
import { useFoodOS, getToday } from "@/lib/state";
import { addDaysToDateKey, isValidCalendarDateKey } from "@/lib/utils";
import { buildDiaryIntegrityInput } from "@/lib/nutrition-v4-adapter";
import { evaluateDiaryNutrientCoverageReadOnly } from "@/lib/nutrition-v4-coverage-gateway";

const WINDOW_DAYS = 28;

const NUTRIENT_LABELS: Record<NutrientKey, string> = {
  kcal: "Kcal", protein: "Proteína", carbs: "Hidratos", fat: "Grasas",
  fiber: "Fibra", sugars: "Azúcares", salt: "Sal",
};

/** `FoodLogEntry` no guarda fiber/sugars/salt hoy — su coverageFraction es
 *  siempre 0, no porque el consumo real sea cero, sino porque no hay NINGÚN
 *  dato que leer para esos tres nutrientes. Se marcan aparte para no
 *  insinuar "0 de fiable" en el mismo sentido que kcal/protein/carbs/fat. */
const NUTRIENTS_NOT_CAPTURED_IN_DIARY: readonly NutrientKey[] = ["fiber", "sugars", "salt"];

export function parseThresholdInput(raw: string): { value: number } | { error: string } {
  if (raw.trim() === "") return { error: "Obligatorio — introduce un valor entre 0 y 1." };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: "No es un número válido." };
  if (value < 0 || value > 1) return { error: "Debe estar entre 0 y 1." };
  return { value };
}

export function NutritionV4CoveragePanel() {
  const { state } = useFoodOS();
  const [open, setOpen] = useState(false);
  const [dailyReliabilityInput, setDailyReliabilityInput] = useState("0.8");
  const [provisionalInput, setProvisionalInput] = useState("0.25");

  const endDateKey = getToday(state);
  const startDateKey = addDaysToDateKey(endDateKey, -(WINDOW_DAYS - 1));

  const dailyReliability = parseThresholdInput(dailyReliabilityInput);
  const provisional = parseThresholdInput(provisionalInput);

  const result = useMemo(() => {
    if (!open) return null;
    if ("error" in dailyReliability || "error" in provisional) return null;
    if (!isValidCalendarDateKey(startDateKey) || !isValidCalendarDateKey(endDateKey)) return null;
    const input: DailyIntegrityWindowInput = buildDiaryIntegrityInput(
      state.foodLog,
      { startDateKey, endDateKey },
      { dailyReliabilityThreshold: dailyReliability.value, provisionalKcalFractionThreshold: provisional.value },
    );
    return evaluateDiaryNutrientCoverageReadOnly(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.foodLog, startDateKey, endDateKey, dailyReliabilityInput, provisionalInput]);

  return (
    <article className="panel settings-section settings-admin">
      <p className="eyebrow">Admin · Nutrition v4</p>
      <h2>Diagnóstico de integridad nutricional</h2>
      <p className="form-intro">
        Informe de SOLO LECTURA sobre los últimos {WINDOW_DAYS} días del diario. No activa nada, no
        genera propuestas, no cambia ningún objetivo ni guarda ningún dato — solo calcula y muestra.
      </p>
      <button className="secondary-button" onClick={() => setOpen((v) => !v)} type="button">
        {open ? "Ocultar diagnóstico" : "Calcular diagnóstico"}
      </button>

      {open && (
        <div className="mt-16">
          <p>
            Ventana: <strong>{startDateKey}</strong> → <strong>{endDateKey}</strong> ({WINDOW_DAYS} días)
          </p>

          <div className="settings-grid mt-16">
            <label className="settings-field">
              <span>Umbral diario de fiabilidad (experimental, sin calibrar)</span>
              <input
                type="number" min="0" max="1" step="0.01"
                value={dailyReliabilityInput}
                onChange={(e) => setDailyReliabilityInput(e.target.value)}
              />
              {"error" in dailyReliability && <small style={{ color: "var(--red, #c33)" }}>{dailyReliability.error}</small>}
            </label>
            <label className="settings-field">
              <span>Umbral de kcal provisional (experimental, sin calibrar)</span>
              <input
                type="number" min="0" max="1" step="0.01"
                value={provisionalInput}
                onChange={(e) => setProvisionalInput(e.target.value)}
              />
              {"error" in provisional && <small style={{ color: "var(--red, #c33)" }}>{provisional.error}</small>}
            </label>
          </div>
          <small style={{ color: "var(--amber, #c90)" }}>
            ⚠ Estos dos valores son parámetros de prueba de esta pantalla, no una calibración
            aprobada del producto. No se guardan en ningún sitio.
          </small>

          {result === null && ("error" in dailyReliability || "error" in provisional) && (
            <p className="form-intro mt-16">Corrige los umbrales para ver el resultado.</p>
          )}

          {result && result.status === "invalid_input" && (
            <p className="form-intro mt-16">Entrada inválida para el kernel: {result.reasons.join(", ")}.</p>
          )}

          {result && result.status === "evaluated" && (
            <div className="mt-16">
              <div className="settings-grid">
                <div className="settings-field"><span>Días de la ventana</span><strong>{result.windowDays}</strong></div>
                <div className="settings-field"><span>Sin registrar</span><strong>{result.unloggedDays}</strong></div>
                <div className="settings-field"><span>Legacy (sin etiquetar)</span><strong>{result.legacyUnlabeledDays}</strong></div>
                <div className="settings-field"><span>Provisionales</span><strong>{result.provisionalDays}</strong></div>
              </div>

              <table className="mt-16" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Nutriente</th>
                    <th style={{ textAlign: "right" }}>Días fiables</th>
                    <th style={{ textAlign: "right" }}>Cobertura</th>
                  </tr>
                </thead>
                <tbody>
                  {result.perNutrient.map((n) => {
                    const notCaptured = NUTRIENTS_NOT_CAPTURED_IN_DIARY.includes(n.nutrient);
                    return (
                      <tr key={n.nutrient}>
                        <td>{NUTRIENT_LABELS[n.nutrient]}</td>
                        <td style={{ textAlign: "right" }}>{notCaptured ? "—" : n.daysWithReliableData}</td>
                        <td style={{ textAlign: "right" }}>
                          {notCaptured ? "sin datos disponibles" : `${(n.coverageFraction * 100).toFixed(1)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <small style={{ color: "var(--text-soft, #888)" }}>
                Fibra, azúcares y sal no se guardan hoy en el diario de comidas — "sin datos
                disponibles" no significa que el consumo real fuera cero, significa que no hay
                ningún valor que evaluar para esos tres nutrientes.
              </small>

              <p className="form-intro mt-16">
                Un día puede contar a la vez como "provisional" y como fiable para un nutriente — son
                dos señales independientes del kernel, no una la contradice a la otra. Este informe no
                indica si Nutrition v4 debería activarse ni aprueba ni rechaza nada: solo muestra lo
                que el kernel calcula con los umbrales de arriba.
              </p>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
