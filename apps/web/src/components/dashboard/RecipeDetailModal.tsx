"use client";

import Image from "next/image";
import { actions, findRecipe, getIngredientStatus, getRecipeMatch, useFoodOS } from "@/lib/state";
import { eur } from "@/lib/utils";
import { Modal } from "./Modal";

export function RecipeDetailModal({ recipeId, onClose }: { recipeId: string; onClose: () => void }) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const recipe = findRecipe(state, recipeId);
  if (!recipe) return null;

  const match = getRecipeMatch(state, recipe);
  const ingredients = getIngredientStatus(state, recipe);

  return (
    <Modal title={recipe.title} onClose={onClose}>
      <div className="recipe-detail-hero">
        <Image src={recipe.image} alt={recipe.title} width={420} height={420} />
        <div className="recipe-detail-copy">
          <div className="recipe-detail-meta">
            <span className="badge blue">{recipe.time} min</span>
            <span className="badge">{recipe.servings} raciones</span>
            <span className="badge">{recipe.difficulty}</span>
            <span className={`badge ${match.pct >= 60 ? "green" : "amber"}`}>{match.pct}% ingredientes</span>
          </div>
          <h3>{recipe.title}</h3>
          <p>
            {recipe.kcal} kcal · {recipe.protein} g proteína · coste estimado {eur(recipe.cost)}.
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

      <div className="recipe-macros-row">
        <div className="macro-item">
          <span className="macro-val">{recipe.kcal}</span>
          <span className="macro-lbl">kcal</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{recipe.protein}g</span>
          <span className="macro-lbl">proteína</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{recipe.carbs}g</span>
          <span className="macro-lbl">carbos</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{recipe.fat}g</span>
          <span className="macro-lbl">grasas</span>
        </div>
      </div>

      <div className="recipe-detail-grid">
        <section className="recipe-section">
          <h3>Ingredientes</h3>
          <ul className="recipe-ingredients-list">
            {ingredients.map((ingredient) => (
              <li key={ingredient.name}>
                <span className={`ing-dot ${ingredient.has ? "" : "missing"}`} />
                <span>
                  {ingredient.name}
                  {ingredient.has ? "" : " (te falta)"}
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
            mutate((draft) => actions.cookRecipe(draft, recipe));
            setMascotMessage("Receta cocinada. Objetivos actualizados.");
            showToast("Receta registrada en nutrición");
            onClose();
          }}
        >
          Marcar como cocinada
        </button>
      </div>
    </Modal>
  );
}
