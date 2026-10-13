"use client";

import { useEffect, useState } from "react";
import type { Recipe } from "@foodos/types";
import { actions, getToday, useFoodOS } from "@/lib/state";
import { eur } from "@/lib/utils";
import { loadAIConfig } from "@/lib/ai-config";
import { generateAIRecipe } from "@/lib/ai-provider";
import { describeLogTarget } from "./cook-log-copy";
import { Modal } from "./Modal";

export function AiRecipeModal({ draft, onClose }: { draft: Recipe; onClose: () => void }) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [title, setTitle] = useState(draft.title);
  const [ingredients, setIngredients] = useState(draft.ingredients);
  const [steps, setSteps] = useState(draft.steps.join("\n"));
  const [macros, setMacros] = useState({
    kcal: draft.kcal,
    protein: draft.protein,
    carbs: draft.carbs,
    fat: draft.fat,
    cost: draft.cost,
  });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiUsed, setAiUsed] = useState(false);
  const [whyThisRecipe, setWhyThisRecipe] = useState(draft.whyThisRecipe ?? "");

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void tryGenerateAI(); }, []);

  async function tryGenerateAI() {
    const config = loadAIConfig();
    if (!config) return;
    setAiLoading(true);
    setAiError("");
    try {
      const recipe = await generateAIRecipe(config, state);
      setTitle(recipe.title);
      setIngredients(recipe.ingredients);
      setSteps(recipe.steps.join("\n"));
      setMacros({
        kcal: recipe.kcal,
        protein: recipe.protein,
        carbs: recipe.carbs,
        fat: recipe.fat,
        cost: recipe.cost,
      });
      setWhyThisRecipe(recipe.whyThisRecipe ?? "");
      setAiUsed(true);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Error generando receta con IA");
    } finally {
      setAiLoading(false);
    }
  }

  function buildRecipe(): Recipe {
    return {
      ...draft,
      ...macros,
      title: title.trim() || draft.title,
      ingredients: ingredients.filter((ing) => ing.name.trim() && ing.quantity > 0),
      steps: steps
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      aiGenerated: aiUsed,
      ...(whyThisRecipe ? { whyThisRecipe } : {}),
    };
  }

  function save(cook: boolean) {
    const recipe = buildRecipe();
    // Solo se avisa y se cierra si la mutación se aplicó (gate de hidratación).
    const applied = mutate((draftState) => {
      draftState.customRecipes.unshift(recipe);
      // Sin `deductIngredients`: registra la ración en el diario sin tocar el inventario.
      if (cook) actions.cookRecipe(draftState, recipe);
    });
    if (!applied) return;
    setMascotMessage(
      cook
        ? `Receta guardada y 1 ración registrada en tu diario (${macros.kcal} kcal), sin descontar inventario.`
        : "Receta guardada en tu colección."
    );
    showToast(
      cook
        ? "Receta guardada y 1 ración registrada en tu diario · inventario sin cambios"
        : "Receta IA guardada"
    );
    onClose();
  }

  const hasConfig = !!loadAIConfig();
  // cookRecipe sin opciones: hoy y tipo de comida según la hora.
  const logTarget = describeLogTarget({ today: getToday(state) });

  return (
    <Modal title="Receta generada para ti" onClose={onClose}>
      <div className="ai-recipe-head">
        <span className="badge purple">{aiUsed ? "IA real" : "IA local"}</span>
        <span className="badge green">{macros.protein} g proteína</span>
        <span className="badge">{macros.kcal} kcal</span>
        <span className="badge blue">{eur(macros.cost)}</span>
      </div>

      {aiUsed && (
        <p className="ai-estimate-warning" role="alert">
          ⚠ Macros estimados por la IA, no de una base de datos verificada — revísalos antes de guardar.
        </p>
      )}

      {aiLoading && (
        <div className="ai-loading-overlay">
          <div className="ai-loading-spinner" aria-hidden="true" />
          <p>Generando receta con IA…</p>
        </div>
      )}

      {aiError && <p className="form-error">{aiError}</p>}

      {!aiLoading && (
        <>
          <p className="ai-recipe-why">
            {aiUsed && whyThisRecipe
              ? <>💡 {whyThisRecipe}</>
              : aiUsed
                ? "Generada con tu IA personal según tu inventario, macros pendientes y presupuesto."
                : hasConfig
                  ? "La IA encontró un error — edita esta receta local o regenera."
                  : "Receta local con tu inventario (priorizando caducidades), macros y presupuesto. Configura tu IA personal para resultados más precisos."}
            {" "}<strong>Edítala a tu gusto antes de guardarla</strong> — solo se guarda si tú quieres.
          </p>

          <label className="ai-field">
            Nombre
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>

          <section className="recipe-section ai-ingredients">
            <h3>Ingredientes</h3>
            {ingredients.map((ingredient, index) => (
              <div key={index} className="ai-ingredient-row">
                <input
                  className="ai-ing-name"
                  value={ingredient.name}
                  onChange={(event) =>
                    setIngredients((current) =>
                      current.map((ing, i) => (i === index ? { ...ing, name: event.target.value } : ing))
                    )
                  }
                />
                <input
                  className="ai-ing-qty"
                  type="number"
                  min="0"
                  step="5"
                  value={ingredient.quantity}
                  onChange={(event) =>
                    setIngredients((current) =>
                      current.map((ing, i) =>
                        i === index ? { ...ing, quantity: Number(event.target.value) } : ing
                      )
                    )
                  }
                />
                <span className="ai-ing-unit">{ingredient.unit}</span>
                <button
                  type="button"
                  className="small-action bad"
                  aria-label={`Quitar ${ingredient.name}`}
                  onClick={() => setIngredients((current) => current.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setIngredients((current) => [...current, { name: "", quantity: 50, unit: "g" }])
              }
            >
              + Añadir ingrediente
            </button>
          </section>

          <label className="ai-field">
            Pasos (uno por línea)
            <textarea rows={4} value={steps} onChange={(event) => setSteps(event.target.value)} />
          </label>

          <div className="cook-log-summary" role="note">
            <p>
              <strong>«Guardar y registrar en el diario»</strong> guarda la receta y anota{" "}
              <strong>1 ración ({macros.kcal} kcal · {macros.protein} g de proteína)</strong> en tu diario
              personal — {logTarget.dateLabel} · {logTarget.mealLabel}
              {logTarget.mealFromClock ? " (según la hora actual)" : ""}. No descuenta ingredientes del
              inventario. «Guardar receta» solo la guarda en tu colección.
            </p>
          </div>

          <div className="recipe-detail-actions">
            {hasConfig && (
              <button
                className="secondary-button"
                onClick={() => void tryGenerateAI()}
                disabled={aiLoading}
              >
                ↺ Regenerar
              </button>
            )}
            <button className="secondary-button" onClick={onClose}>
              Descartar
            </button>
            <button className="secondary-button" onClick={() => save(false)}>
              Guardar receta
            </button>
            <button className="primary-button" onClick={() => save(true)}>
              Guardar y registrar en el diario
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
