"use client";

import Image from "next/image";
import { useState } from "react";
import type { Recipe } from "@foodos/types";
import { actions, allRecipes, buildAiRecipeDraft, getRecipeMatch, useFoodOS } from "@/lib/state";
import { eur } from "@/lib/utils";
import { AiRecipeModal } from "../AiRecipeModal";

type Mode = "exact" | "partial" | "budget" | "ai";

export function RecipesView({ openRecipe }: { openRecipe: (id: string) => void }) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [mode, setMode] = useState<Mode>("exact");
  const [aiDraft, setAiDraft] = useState<Recipe | null>(null);

  const recipes = allRecipes(state);
  const allTags = ["todos", ...new Set(recipes.flatMap((recipe) => recipe.tags))];

  let filtered = state.recipeTag === "todos" ? [...recipes] : recipes.filter((recipe) => recipe.tags.includes(state.recipeTag));
  filtered.sort((a, b) => {
    if (mode === "budget") return a.cost - b.cost;
    if (mode === "ai") return b.protein - a.protein;
    return getRecipeMatch(state, b).pct - getRecipeMatch(state, a).pct;
  });

  const withIngredients = filtered.filter((recipe) => getRecipeMatch(state, recipe).pct >= 60).length;

  return (
    <section className="view">
      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Búsqueda por ingredientes</p>
            <h2>Recetas que encajan con tu inventario</h2>
          </div>
          <div className="panel-actions">
            <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
              <option value="exact">Modo exacto</option>
              <option value="partial">Modo parcial</option>
              <option value="budget">Modo ahorro</option>
              <option value="ai">Modo IA</option>
            </select>
            <button
              className="primary-button"
              onClick={() => {
                const draft = buildAiRecipeDraft(state);
                if (!draft) {
                  showToast("Añade alimentos al inventario para generar una receta");
                  return;
                }
                setAiDraft(draft);
                setMascotMessage("Receta generada con tu inventario y tus macros de hoy.");
              }}
            >
              Generar receta IA
            </button>
          </div>
        </div>

        <div className="recipe-filter-bar">
          <span className="badge">Filtrar</span>
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`filter ${tag === state.recipeTag ? "active" : ""}`}
              onClick={() => mutate((draft) => void (draft.recipeTag = tag))}
            >
              {tag}
            </button>
          ))}
          <span className="badge blue">{withIngredients} con ingredientes</span>
        </div>

        <div className="recipe-grid">
          {filtered.map((recipe) => {
            const match = getRecipeMatch(state, recipe);
            const cls = match.pct >= 80 ? "green" : match.pct >= 35 ? "amber" : "red";
            return (
              <article key={recipe.id} className="recipe-card">
                <button className="recipe-open" onClick={() => openRecipe(recipe.id)} aria-label={`Abrir ${recipe.title}`}>
                  <span className="recipe-image">
                    <Image src={recipe.image} alt="" width={420} height={280} />
                  </span>
                  <span className={`badge ${cls}`}>{match.pct}% disponible</span>
                  <h3>{recipe.title}</h3>
                  <p>
                    {recipe.kcal} kcal · {recipe.protein} g proteína · {recipe.time} min · {eur(recipe.cost)}
                  </p>
                  <span className="meta-row">
                    {recipe.tags.map((tag) => (
                      <span key={tag} className="badge">
                        {tag}
                      </span>
                    ))}
                  </span>
                </button>
                <div className="card-actions">
                  <button className="small-action" onClick={() => openRecipe(recipe.id)}>
                    Ver detalle
                  </button>
                  <button
                    className="small-action"
                    onClick={() => {
                      mutate((draft) => actions.addRecipeToCart(draft, recipe));
                      setMascotMessage("Ingredientes fusionados en el carrito.");
                      showToast("Ingredientes añadidos al carrito");
                    }}
                  >
                    Ingredientes al carrito
                  </button>
                  <button
                    className="small-action good"
                    onClick={() => {
                      mutate((draft) => actions.cookRecipe(draft, recipe));
                      setMascotMessage("Receta cocinada. Objetivos actualizados.");
                      showToast("Receta registrada en nutrición");
                    }}
                  >
                    Cocinar
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {aiDraft && <AiRecipeModal draft={aiDraft} onClose={() => setAiDraft(null)} />}
    </section>
  );
}
