"use client";

import { useState } from "react";
import type { Recipe } from "@foodos/types";
import { actions, useFoodOS } from "@/lib/state";
import { eur } from "@/lib/utils";
import { Modal } from "./Modal";

// Receta generada por IA: es TEMPORAL hasta que el usuario la guarda,
// y puede editarla por completo antes (PDF §15.7).
export function AiRecipeModal({ draft, onClose }: { draft: Recipe; onClose: () => void }) {
  const { mutate, showToast, setMascotMessage } = useFoodOS();
  const [title, setTitle] = useState(draft.title);
  const [ingredients, setIngredients] = useState(draft.ingredients);
  const [steps, setSteps] = useState(draft.steps.join("\n"));

  function buildRecipe(): Recipe {
    return {
      ...draft,
      title: title.trim() || draft.title,
      ingredients: ingredients.filter((ing) => ing.name.trim() && ing.quantity > 0),
      steps: steps
        .split("\n")
        .map((step) => step.trim())
        .filter(Boolean),
    };
  }

  function save(cook: boolean) {
    const recipe = buildRecipe();
    mutate((draftState) => {
      draftState.customRecipes.unshift(recipe);
      if (cook) actions.cookRecipe(draftState, recipe);
    });
    setMascotMessage(cook ? "Receta guardada y registrada en tu día." : "Receta guardada en tu colección.");
    showToast(cook ? "Guardada y cocinada" : "Receta IA guardada");
    onClose();
  }

  return (
    <Modal title="Receta generada para ti" onClose={onClose}>
      <div className="ai-recipe-head">
        <span className="badge purple">IA</span>
        <span className="badge green">{draft.protein} g proteína</span>
        <span className="badge">{draft.kcal} kcal</span>
        <span className="badge blue">{eur(draft.cost)}</span>
      </div>
      <p className="ai-recipe-why">
        Generada con tu inventario (priorizando lo que caduca), tus macros pendientes de hoy y tu
        presupuesto. <strong>Edítala a tu gusto antes de guardarla</strong> — solo se guarda si tú quieres.
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
                  current.map((ing, i) => (i === index ? { ...ing, quantity: Number(event.target.value) } : ing))
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
          onClick={() => setIngredients((current) => [...current, { name: "", quantity: 50, unit: "g" }])}
        >
          + Añadir ingrediente
        </button>
      </section>

      <label className="ai-field">
        Pasos (uno por línea)
        <textarea rows={4} value={steps} onChange={(event) => setSteps(event.target.value)} />
      </label>

      <div className="recipe-detail-actions">
        <button className="secondary-button" onClick={onClose}>
          Descartar
        </button>
        <button className="secondary-button" onClick={() => save(false)}>
          Guardar receta
        </button>
        <button className="primary-button" onClick={() => save(true)}>
          Guardar y cocinar
        </button>
      </div>
    </Modal>
  );
}
