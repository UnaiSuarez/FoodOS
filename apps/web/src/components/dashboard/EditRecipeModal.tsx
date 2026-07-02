"use client";

import { useMemo, useState } from "react";
import type { Recipe, RecipeIngredient } from "@foodos/types";
import { useFoodOS } from "@/lib/state";
import { findExactFood } from "@/lib/food-db";
import { namesMatch, toGrams } from "@/lib/utils";
import { Modal } from "./Modal";

type IngStatus = "idle" | "loading" | "found" | "manual";

type IngDraft = {
  name: string;
  quantity: number;
  unit: string;
  kcalPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
  status: IngStatus;
  /** Gramos/ml por unidad cuando unit==="ud" (ej. 1 huevo = 60g). */
  unitSize: number;
};

function recipeIngToIng(ri: RecipeIngredient): IngDraft {
  const hasMacros = (ri.kcalPer100 ?? 0) > 0 || (ri.proteinPer100 ?? 0) > 0;
  return {
    name: ri.name,
    quantity: ri.quantity,
    unit: ri.unit,
    kcalPer100:    ri.kcalPer100    ?? 0,
    proteinPer100: ri.proteinPer100 ?? 0,
    carbsPer100:   ri.carbsPer100   ?? 0,
    fatPer100:     ri.fatPer100     ?? 0,
    status: hasMacros ? "found" : "idle",
    unitSize: ri.unitSize ?? 60,
  };
}

function ingToRecord(ing: IngDraft): RecipeIngredient {
  const { name, quantity, unit, kcalPer100, proteinPer100, carbsPer100, fatPer100, status, unitSize } = ing;
  return {
    name, quantity, unit,
    ...(unit === "ud" ? { unitSize } : {}),
    ...(status === "found" || status === "manual"
      ? { kcalPer100, proteinPer100, carbsPer100, fatPer100 }
      : {}),
  };
}


export function EditRecipeModal({ recipe, onClose }: { recipe: Recipe; onClose: () => void }) {
  const { state, mutate, showToast } = useFoodOS();
  const [title, setTitle]           = useState(recipe.title);
  const [time, setTime]             = useState(recipe.time);
  const [servings, setServings]     = useState(recipe.servings || 1);
  const [difficulty, setDifficulty] = useState(recipe.difficulty);
  const [tags, setTags] = useState(recipe.tags.join(", "));
  const [cost, setCost] = useState(recipe.cost);
  const [ingredients, setIngredients] = useState<IngDraft[]>(
    recipe.ingredients.length
      ? recipe.ingredients.map(recipeIngToIng)
      : [{ name: "", quantity: 100, unit: "g", kcalPer100: 0, proteinPer100: 0, carbsPer100: 0, fatPer100: 0, status: "idle", unitSize: 60 }]
  );
  const [steps, setSteps] = useState(recipe.steps.length ? [...recipe.steps] : [""]);
  // Start with the stored recipe macros as override so editing doesn't lose them
  const [macroOverride, setMacroOverride] = useState<{ kcal: number; protein: number; carbs: number; fat: number } | null>(
    { kcal: recipe.kcal, protein: recipe.protein, carbs: recipe.carbs, fat: recipe.fat }
  );

  const derivedMacros = useMemo(() => {
    if (servings < 1) return { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    let k = 0, p = 0, c = 0, f = 0;
    for (const ing of ingredients) {
      if (!ing.name.trim() || (ing.status !== "found" && ing.status !== "manual")) continue;
      const g = toGrams(ing.quantity, ing.unit, ing.unitSize);
      k += (ing.kcalPer100 * g) / 100;
      p += (ing.proteinPer100 * g) / 100;
      c += (ing.carbsPer100 * g) / 100;
      f += (ing.fatPer100 * g) / 100;
    }
    return {
      kcal:    Math.round(k / servings),
      protein: Math.round((p / servings) * 10) / 10,
      carbs:   Math.round((c / servings) * 10) / 10,
      fat:     Math.round((f / servings) * 10) / 10,
    };
  }, [ingredients, servings]);

  const displayMacros = macroOverride ?? derivedMacros;
  const hasLookedUp   = ingredients.some((i) => i.status === "found" || i.status === "manual");

  function setIng(i: number, patch: Partial<IngDraft>) {
    setIngredients((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  async function lookupIngredient(i: number, name: string) {
    if (!name.trim()) return;
    setIng(i, { status: "loading" });

    const local = findExactFood(name);
    if (local) {
      setIng(i, { kcalPer100: local.kcal, proteinPer100: local.protein, carbsPer100: local.carbs ?? 0, fatPer100: local.fat ?? 0, status: "found" });
      return;
    }

    const invMatch = state.inventory.find((item) => namesMatch(item.name, name));
    if (invMatch) {
      setIng(i, {
        kcalPer100: invMatch.kcal, proteinPer100: invMatch.protein,
        carbsPer100: invMatch.carbs ?? 0, fatPer100: invMatch.fat ?? 0,
        ...(invMatch.unit === "ud" ? { unit: "ud", unitSize: invMatch.unitSize ?? 60 } : {}),
        status: "found",
      });
      return;
    }

    try {
      const res  = await fetch(`/api/food-search?q=${encodeURIComponent(name)}`);
      const data = await res.json() as { products?: Array<{ nutriments?: Record<string, number> }> };
      const hit  = data.products?.[0];
      if (hit?.nutriments) {
        const n = hit.nutriments;
        setIng(i, {
          kcalPer100:    Math.round(n["energy-kcal_100g"] ?? n["energy-kcal"] ?? 0),
          proteinPer100: Math.round((n["proteins_100g"] ?? 0) * 10) / 10,
          carbsPer100:   Math.round((n["carbohydrates_100g"] ?? 0) * 10) / 10,
          fatPer100:     Math.round((n["fat_100g"] ?? 0) * 10) / 10,
          status: "found",
        });
        return;
      }
    } catch { /* ignore */ }

    setIng(i, { status: "manual" });
  }

  async function lookupAll() {
    for (let i = 0; i < ingredients.length; i++) {
      const ing = ingredients[i];
      if (ing.name.trim() && ing.status === "idle") {
        await lookupIngredient(i, ing.name);
      }
    }
  }

  function save() {
    if (!title.trim()) { showToast("Escribe un nombre para la receta"); return; }
    const finalMacros = macroOverride ?? derivedMacros;
    mutate((draft) => {
      const r = draft.customRecipes.find((x) => x.id === recipe.id);
      if (!r) return;
      r.title      = title.trim();
      r.time       = time;
      r.servings   = servings;
      r.difficulty = difficulty;
      r.tags       = tags.split(",").map((t) => t.trim()).filter(Boolean);
      r.kcal       = finalMacros.kcal;
      r.protein    = finalMacros.protein;
      r.carbs      = finalMacros.carbs;
      r.fat        = finalMacros.fat;
      r.cost       = cost;
      r.ingredients = ingredients.filter((i) => i.name.trim()).map(ingToRecord);
      r.steps      = steps.filter((s) => s.trim());
    });
    showToast("Receta actualizada");
    onClose();
  }

  const ING_MACRO_FIELDS = [
    { key: "kcalPer100"    as const, label: "kcal"   },
    { key: "proteinPer100" as const, label: "prot g"  },
    { key: "carbsPer100"   as const, label: "carb g"  },
    { key: "fatPer100"     as const, label: "gras g"  },
  ];

  return (
    <Modal title="Editar receta" onClose={onClose}>
      <div className="create-recipe-form">
        <div className="form-grid compact">
          <label className="name-label">
            Nombre
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
          </label>
          <label>
            Tiempo (min)
            <input type="number" min="1" max="360" value={time} onChange={(e) => setTime(Number(e.target.value))} />
          </label>
          <label>
            Raciones
            <input type="number" min="1" max="20" value={servings} onChange={(e) => setServings(Number(e.target.value))} />
          </label>
          <label>
            Dificultad
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              <option value="fácil">Fácil</option>
              <option value="media">Media</option>
              <option value="difícil">Difícil</option>
            </select>
          </label>
          <label>
            Etiquetas (comas)
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="proteico, vegano, rápido" />
          </label>
          <label>
            Coste total €
            <input type="number" min="0" step="0.1" value={cost} onChange={(e) => setCost(Number(e.target.value))} />
          </label>
        </div>

        {/* Ingredients */}
        <div className="create-section">
          <div className="create-section-head">
            <h4 className="create-section-title">Ingredientes</h4>
            {ingredients.some((i) => i.name.trim() && i.status === "idle") && (
              <button type="button" className="text-button" onClick={lookupAll}>
                🔍 Buscar macros
              </button>
            )}
          </div>

          {ingredients.map((ing, i) => (
            <div key={i} className="create-ing-wrap">
              <div className="create-ing-row">
                <input
                  className="create-ing-name"
                  placeholder="Ingrediente"
                  value={ing.name}
                  onChange={(e) => setIng(i, { name: e.target.value, status: "idle", kcalPer100: 0, proteinPer100: 0, carbsPer100: 0, fatPer100: 0 })}
                  onBlur={(e) => { if (ing.status === "idle" && e.target.value.trim()) lookupIngredient(i, e.target.value); }}
                />
                <input
                  type="number" min="0" step="0.1"
                  className="create-ing-qty"
                  value={ing.quantity}
                  onChange={(e) => setIng(i, { quantity: Number(e.target.value) })}
                />
                <select
                  className="create-ing-unit"
                  value={ing.unit}
                  onChange={(e) => setIng(i, { unit: e.target.value })}
                >
                  <option>g</option><option>ml</option><option>ud</option>
                  <option>kg</option><option>L</option><option>cucharada</option><option>pizca</option>
                </select>
                {ing.unit === "ud" && (
                  <input
                    type="number" min="1" step="1"
                    className="create-ing-qty"
                    title="Gramos/ml por unidad"
                    value={ing.unitSize}
                    onChange={(e) => setIng(i, { unitSize: Number(e.target.value) })}
                  />
                )}
                <span className={`ing-status ing-status--${ing.status}`}>
                  {ing.status === "loading" ? "…" : ing.status === "found" ? "✓" : ing.status === "manual" ? "?" : ""}
                </span>
                {ingredients.length > 1 && (
                  <button type="button" className="remove-btn" onClick={() => setIngredients((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
                )}
              </div>

              {(ing.status === "found" || ing.status === "manual") && (
                <div className="ing-macro-row">
                  <span className="ing-macro-label">por 100g</span>
                  {ING_MACRO_FIELDS.map(({ key, label }) => (
                    <label key={key} className="ing-macro-cell">
                      <span>{label}</span>
                      <input
                        className="ing-macro-input"
                        type="number" min="0" step="0.1"
                        value={ing[key]}
                        onChange={(e) => setIng(i, { [key]: Number(e.target.value) })}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}

          <button type="button" className="secondary-button" onClick={() => setIngredients((prev) => [...prev, { name: "", quantity: 100, unit: "g", kcalPer100: 0, proteinPer100: 0, carbsPer100: 0, fatPer100: 0, status: "idle", unitSize: 60 }])}>
            + Añadir ingrediente
          </button>
        </div>

        {/* Macros por ración */}
        <div className="create-macros-section">
          <div className="create-section-head">
            <h4 className="create-section-title">Macros por ración</h4>
            {hasLookedUp && (
              <button type="button" className="text-button" onClick={() => setMacroOverride(null)}
                title="Recalcular desde los ingredientes">
                {macroOverride === null ? "✓ Auto" : "↺ Recalcular desde ingredientes"}
              </button>
            )}
          </div>
          {hasLookedUp && macroOverride === null && (
            <p className="create-section-hint macro-auto-hint">Calculadas desde ingredientes — edítalas para fijar tus propios valores.</p>
          )}
          <div className="form-grid compact">
            <label>
              kcal
              <input type="number" min="0" value={displayMacros.kcal}
                onChange={(e) => setMacroOverride({ ...(macroOverride ?? derivedMacros), kcal: Number(e.target.value) })} />
            </label>
            <label>
              Proteína g
              <input type="number" min="0" step="0.1" value={displayMacros.protein}
                onChange={(e) => setMacroOverride({ ...(macroOverride ?? derivedMacros), protein: Number(e.target.value) })} />
            </label>
            <label>
              Carbos g
              <input type="number" min="0" step="0.1" value={displayMacros.carbs}
                onChange={(e) => setMacroOverride({ ...(macroOverride ?? derivedMacros), carbs: Number(e.target.value) })} />
            </label>
            <label>
              Grasas g
              <input type="number" min="0" step="0.1" value={displayMacros.fat}
                onChange={(e) => setMacroOverride({ ...(macroOverride ?? derivedMacros), fat: Number(e.target.value) })} />
            </label>
          </div>
        </div>

        {/* Steps */}
        <div className="create-section">
          <h4 className="create-section-title">Pasos de elaboración</h4>
          {steps.map((step, i) => (
            <div key={i} className="create-step-row">
              <span className="step-num">{i + 1}.</span>
              <textarea
                className="create-step-text" rows={2} value={step}
                onChange={(e) => { const v = e.target.value; setSteps((prev) => { const n = [...prev]; n[i] = v; return n; }); }}
              />
              {steps.length > 1 && (
                <button type="button" className="remove-btn" onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
              )}
            </div>
          ))}
          <button type="button" className="secondary-button" onClick={() => setSteps((prev) => [...prev, ""])}>
            + Añadir paso
          </button>
        </div>

        <div className="recipe-detail-actions">
          <button className="secondary-button" onClick={onClose}>Cancelar</button>
          <button className="primary-button" onClick={save}>Guardar receta</button>
        </div>
      </div>
    </Modal>
  );
}
