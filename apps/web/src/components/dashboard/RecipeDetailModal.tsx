"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import {
  actions,
  findRecipe,
  getIngredientStatus,
  getPendingMacros,
  getRecipeMatch,
  useFoodOS,
} from "@/lib/state";
import { scaleByCalories, scaleByRatio } from "@/lib/nutrition";
import { eur } from "@/lib/utils";
import { Modal } from "./Modal";

export function RecipeDetailModal({ recipeId, onClose }: { recipeId: string; onClose: () => void }) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [ratio, setRatio] = useState(1);
  const [kcalInput, setKcalInput] = useState("");

  const recipe = findRecipe(state, recipeId);
  const pending = getPendingMacros(state);

  // Las kcal pendientes se reparten entre las comidas que quedan hoy:
  // por la mañana ~3 comidas, por la tarde ~2, por la noche 1 (cena que cierra macros).
  const hour = new Date().getHours();
  const remainingMeals = hour < 12 ? 3 : hour < 18 ? 2 : 1;
  const suggestedKcal = Math.round(pending.kcal / remainingMeals);

  const scaled = useMemo(() => (recipe ? scaleByRatio(recipe, ratio) : null), [recipe, ratio]);

  if (!recipe || !scaled) return null;

  const match = getRecipeMatch(state, recipe);
  const ingredients = getIngredientStatus(state, recipe);

  function applyKcalTarget(target: number) {
    if (!recipe || target <= 0) return;
    const result = scaleByCalories(recipe, target);
    setRatio(result.ratio);
    setKcalInput(String(target));
  }

  return (
    <Modal title={recipe.title} onClose={onClose}>
      <div className="recipe-detail-hero">
        <Image src={recipe.image} alt={recipe.title} width={420} height={420} />
        <div className="recipe-detail-copy">
          <div className="recipe-detail-meta">
            <span className="badge blue">{recipe.time} min</span>
            <span className="badge">{recipe.difficulty}</span>
            <span className={`badge ${match.pct >= 60 ? "green" : "amber"}`}>{match.pct}% ingredientes</span>
            {recipe.aiGenerated && <span className="badge purple">IA</span>}
          </div>
          <h3>{recipe.title}</h3>
          <p>
            Ración base: {recipe.kcal} kcal · {recipe.protein} g proteína · {eur(recipe.cost)}.
          </p>
          <div className="recipe-detail-tags">
            {recipe.tags.map((tag) => (
              <span key={tag} className="badge">
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Escalado por raciones o por kcal objetivo (PDF §5.3 y §9.7) */}
      <div className="scale-card">
        <div className="scale-controls">
          <label>
            Raciones
            <input
              type="number"
              min="0.25"
              max="6"
              step="0.25"
              value={scaled.servings}
              onChange={(event) => setRatio(Number(event.target.value) || 1)}
            />
          </label>
          <label>
            kcal objetivo
            <input
              type="number"
              min="100"
              step="10"
              placeholder={String(recipe.kcal)}
              value={kcalInput}
              onChange={(event) => {
                setKcalInput(event.target.value);
                const value = Number(event.target.value);
                if (value >= 100) applyKcalTarget(value);
              }}
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={pending.kcal <= 0}
            onClick={() => applyKcalTarget(suggestedKcal)}
            title={
              pending.kcal > 0
                ? `${suggestedKcal} kcal para esta comida (${Math.round(pending.kcal)} pendientes entre ${remainingMeals} comida${remainingMeals > 1 ? "s" : ""})`
                : "Ya has cubierto tus kcal de hoy"
            }
          >
            Ajustar a mis macros pendientes
          </button>
          {ratio !== 1 && (
            <button type="button" className="text-button" onClick={() => { setRatio(1); setKcalInput(""); }}>
              Restablecer
            </button>
          )}
        </div>
        {pending.kcal > 0 && (
          <p className="scale-note">
            Hoy te quedan <strong>{Math.round(pending.kcal)} kcal</strong> y{" "}
            <strong>{Math.round(pending.protein)} g de proteína</strong>
            {remainingMeals > 1 ? ` (~${suggestedKcal} kcal para esta comida)` : " — esta comida puede cerrar el día"}
            . Esta porción cubre el{" "}
            {Math.min(999, Math.round((scaled.macros.protein / Math.max(1, pending.protein)) * 100))}% de tu
            proteína pendiente.
          </p>
        )}
      </div>

      <div className="recipe-macros-row">
        <div className="macro-item">
          <span className="macro-val">{scaled.macros.kcal}</span>
          <span className="macro-lbl">kcal</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{scaled.macros.protein}g</span>
          <span className="macro-lbl">proteína</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{scaled.macros.carbs}g</span>
          <span className="macro-lbl">carbos</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{scaled.macros.fat}g</span>
          <span className="macro-lbl">grasas</span>
        </div>
      </div>

      <div className="recipe-detail-grid">
        <section className="recipe-section">
          <h3>Ingredientes {ratio !== 1 ? `(×${scaled.servings})` : ""}</h3>
          <ul className="recipe-ingredients-list">
            {scaled.ingredients.map((ingredient, index) => (
              <li key={ingredient.name}>
                <span className={`ing-dot ${ingredients[index]?.has ? "" : "missing"}`} />
                <span>
                  <strong className="ing-qty">
                    {ingredient.quantity} {ingredient.unit}
                  </strong>{" "}
                  {ingredient.name}
                  {ingredients[index]?.has ? "" : " (te falta)"}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="recipe-section">
          <h3>Preparación</h3>
          <ol className="recipe-steps-list">
            {recipe.steps.map((step, index) => (
              <li key={step}>
                <span className="step-num">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="recipe-detail-actions">
        <span className="badge blue">Coste de esta porción: {eur(scaled.cost)}</span>
        <button
          className="secondary-button"
          onClick={() => {
            mutate((draft) => actions.addRecipeToCart(draft, recipe));
            setMascotMessage("Ingredientes fusionados en el carrito.");
            showToast("Ingredientes añadidos al carrito");
          }}
        >
          Ingredientes al carrito
        </button>
        <button
          className="primary-button"
          onClick={() => {
            mutate((draft) => actions.cookRecipe(draft, recipe, ratio));
            setMascotMessage("Receta cocinada. Objetivos actualizados.");
            showToast(`Registrados ${scaled.macros.kcal} kcal en nutrición`);
            onClose();
          }}
        >
          Cocinar esta porción
        </button>
      </div>
    </Modal>
  );
}
