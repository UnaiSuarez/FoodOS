"use client";

import Image from "next/image";
import { useState } from "react";
import type { Recipe } from "@foodos/types";
import { actions, allRecipes, buildAiRecipeDraft, getBudgetLeft, getRecipeMatch, useFoodOS } from "@/lib/state";
import { eur, uid } from "@/lib/utils";
import { AiRecipeModal } from "../AiRecipeModal";

type Mode = "exact" | "partial" | "budget" | "ai";

export function RecipesView({ openRecipe }: { openRecipe: (id: string) => void }) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [mode, setMode] = useState<Mode>("exact");
  const [aiDraft, setAiDraft] = useState<Recipe | null>(null);

  // Filtros avanzados (estado local, no persisten)
  const [search, setSearch]           = useState("");
  const [maxCost, setMaxCost]         = useState(0);
  const [minProtein, setMinProtein]   = useState(0);
  const [maxTime, setMaxTime]         = useState(0);
  const [onlyAvail, setOnlyAvail]     = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const budgetLeft = getBudgetLeft(state);
  const budgetTight = budgetLeft < 5 && state.weeklyBudget > 0;
  const [savingsMode, setSavingsMode] = useState(false);
  const effectiveSavings = budgetTight || savingsMode;

  const recipes = allRecipes(state);
  const allTags = ["todos", ...new Set(recipes.flatMap((r) => r.tags))];

  let filtered = state.recipeTag === "todos" ? [...recipes] : recipes.filter((r) => r.tags.includes(state.recipeTag));

  // Búsqueda por nombre o ingrediente
  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.ingredients.some((ing) => ing.name.toLowerCase().includes(q))
    );
  }

  // Filtros numéricos
  if (effectiveSavings) filtered = filtered.filter((r) => r.cost <= 1.5);
  if (maxCost > 0)     filtered = filtered.filter((r) => r.cost <= maxCost);
  if (minProtein > 0)  filtered = filtered.filter((r) => r.protein >= minProtein);
  if (maxTime > 0)     filtered = filtered.filter((r) => r.time <= maxTime);
  if (onlyAvail)       filtered = filtered.filter((r) => getRecipeMatch(state, r).pct >= 60);

  // Orden
  filtered.sort((a, b) => {
    if (mode === "budget") return a.cost - b.cost;
    if (mode === "ai")     return b.protein - a.protein;
    return getRecipeMatch(state, b).pct - getRecipeMatch(state, a).pct;
  });

  const withIngredients = filtered.filter((r) => getRecipeMatch(state, r).pct >= 60).length;
  const activeFilters = [maxCost > 0, minProtein > 0, maxTime > 0, onlyAvail, search.trim() !== ""].filter(Boolean).length;

  function clearFilters() {
    setSearch("");
    setMaxCost(0);
    setMinProtein(0);
    setMaxTime(0);
    setOnlyAvail(false);
  }

  return (
    <section className="view">
      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Búsqueda por ingredientes</p>
            <h2>Recetas que encajan con tu inventario</h2>
          </div>
          <div className="panel-actions">
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="exact">Modo exacto</option>
              <option value="partial">Modo parcial</option>
              <option value="budget">Modo ahorro</option>
              <option value="ai">Modo IA</option>
            </select>
            <button
              className="primary-button"
              onClick={() => {
                const draft = buildAiRecipeDraft(state);
                if (!draft) { showToast("Añade alimentos al inventario para generar una receta"); return; }
                setAiDraft(draft);
                setMascotMessage("Receta generada con tu inventario y tus macros de hoy.");
              }}
            >
              Generar receta IA
            </button>
          </div>
        </div>

        {/* Banner modo ahorro máximo */}
        {(budgetTight || savingsMode) && (
          <div className={`savings-banner ${budgetTight ? "auto" : ""}`}>
            <span>
              {budgetTight
                ? `⚠ Presupuesto casi agotado (${eur(budgetLeft)} disponibles). Modo ahorro máximo activo — solo recetas ≤ €1,50/ración.`
                : "💚 Modo ahorro máximo activo — solo recetas ≤ €1,50/ración."}
            </span>
            <button className="text-button" onClick={() => setSavingsMode(false)}>
              Desactivar
            </button>
          </div>
        )}
        {!budgetTight && !savingsMode && (
          <button className="savings-toggle" onClick={() => setSavingsMode(true)}>
            💚 Activar modo ahorro máximo (≤ €1,50/ración)
          </button>
        )}

        {/* Barra de búsqueda + filtros */}
        <div className="recipe-search-bar">
          <input
            className="recipe-search-input"
            type="search"
            placeholder="Buscar por nombre o ingrediente…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className={`secondary-button ${filtersOpen ? "active-filter" : ""}`}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            Filtros {activeFilters > 0 && <b className="filter-count">{activeFilters}</b>}
          </button>
          {activeFilters > 0 && (
            <button className="text-button" onClick={clearFilters}>
              Limpiar
            </button>
          )}
        </div>

        {filtersOpen && (
          <div className="recipe-filter-panel">
            <label className="filter-field">
              Coste máximo (€)
              <div className="filter-range-row">
                <input
                  type="range"
                  min={0} max={15} step={0.5}
                  value={maxCost}
                  onChange={(e) => setMaxCost(Number(e.target.value))}
                />
                <span>{maxCost > 0 ? `≤ ${eur(maxCost)}` : "Sin límite"}</span>
              </div>
            </label>
            <label className="filter-field">
              Proteína mínima (g)
              <div className="filter-range-row">
                <input
                  type="range"
                  min={0} max={80} step={5}
                  value={minProtein}
                  onChange={(e) => setMinProtein(Number(e.target.value))}
                />
                <span>{minProtein > 0 ? `≥ ${minProtein} g` : "Sin límite"}</span>
              </div>
            </label>
            <label className="filter-field">
              Tiempo máximo (min)
              <div className="filter-range-row">
                <input
                  type="range"
                  min={0} max={120} step={5}
                  value={maxTime}
                  onChange={(e) => setMaxTime(Number(e.target.value))}
                />
                <span>{maxTime > 0 ? `≤ ${maxTime} min` : "Sin límite"}</span>
              </div>
            </label>
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={onlyAvail}
                onChange={(e) => setOnlyAvail(e.target.checked)}
              />
              Solo recetas con ≥ 60% de ingredientes en despensa
            </label>
          </div>
        )}

        {/* Tags */}
        <div className="recipe-filter-bar">
          <span className="badge">Etiqueta</span>
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
          <span className="badge">{filtered.length} resultados</span>
        </div>

        {filtered.length === 0 ? (
          <div className="empty">
            Ninguna receta coincide con los filtros actuales.{" "}
            <button className="text-button" onClick={clearFilters}>Limpiar filtros</button>
          </div>
        ) : (
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
                        <span key={tag} className="badge">{tag}</span>
                      ))}
                    </span>
                  </button>
                  <div className="card-actions">
                    <button className="small-action" onClick={() => openRecipe(recipe.id)}>Ver detalle</button>
                    <button
                      className="small-action"
                      onClick={() => {
                        mutate((draft) => actions.addRecipeToCart(draft, recipe));
                        setMascotMessage("Ingredientes fusionados en el carrito.");
                        showToast("Ingredientes añadidos al carrito");
                      }}
                    >
                      Al carrito
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
                    <button
                      className="small-action"
                      title="Compartir en feed"
                      onClick={() => {
                        mutate((draft) => {
                          draft.feedPosts.push({
                            id: uid(),
                            recipeId: recipe.id,
                            author: "tu",
                            title: recipe.title,
                            caption: `${recipe.protein}g de proteína · ${recipe.time} min · ¡la he cocinado!`,
                            likes: 0,
                            comments: [],
                          });
                        });
                        showToast("Compartida en el feed");
                      }}
                    >
                      Compartir
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {aiDraft && <AiRecipeModal draft={aiDraft} onClose={() => setAiDraft(null)} />}
    </section>
  );
}
