"use client";

import { useMemo, useState } from "react";
import type { MealType, Recipe } from "@foodos/types";
import { actions, getPendingMacros, useFoodOS } from "@/lib/state";
import { eur, uid } from "@/lib/utils";
import { Modal } from "./Modal";

interface Props {
  recipe: Recipe;
  onClose: () => void;
  logDate?: string;
  mealType?: MealType;
}

function toGrams(qty: number, unit: string, unitSize = 60): number {
  switch (unit) {
    case "kg": return qty * 1000;
    case "L":  return qty * 1000;
    case "oz": return qty * 28.35;
    case "lb": return qty * 453.6;
    case "cucharada": return qty * 15;
    case "pizca":     return qty * 0.5;
    case "ud": return qty * unitSize;
    default:   return qty;
  }
}

export function CookModal({ recipe, onClose, logDate, mealType }: Props) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [servings, setServings] = useState(recipe.servings || 1);
  const [deduct, setDeduct] = useState(true);
  // Per-ingredient qty overrides (null = use scaled default)
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, number>>({});

  const ratio = servings / Math.max(1, recipe.servings || 1);
  const scaledCost = Math.round(recipe.cost * ratio * 100) / 100;

  // If all ingredients have per-100g macros, derive live from them (respects qtyOverrides)
  const derivedMacros = useMemo(() => {
    const ings = recipe.ingredients;
    if (!ings.length || !ings.every((i) => (i.kcalPer100 ?? 0) > 0)) return null;
    let k = 0, p = 0, c = 0, f = 0;
    for (const ing of ings) {
      const scaledQty = ing.quantity * ratio;
      const actual = qtyOverrides[ing.name] ?? scaledQty;
      const g = toGrams(actual, ing.unit, ing.unitSize);
      k += ((ing.kcalPer100 ?? 0) * g) / 100;
      p += ((ing.proteinPer100 ?? 0) * g) / 100;
      c += ((ing.carbsPer100 ?? 0) * g) / 100;
      f += ((ing.fatPer100 ?? 0) * g) / 100;
    }
    return {
      kcal:    Math.round(k),
      protein: Math.round(p * 10) / 10,
      carbs:   Math.round(c * 10) / 10,
      fat:     Math.round(f * 10) / 10,
    };
  }, [recipe.ingredients, ratio, qtyOverrides]);

  const scaled = {
    kcal:    derivedMacros?.kcal    ?? Math.round(recipe.kcal * ratio),
    protein: derivedMacros?.protein ?? Math.round(recipe.protein * ratio * 10) / 10,
    carbs:   derivedMacros?.carbs   ?? Math.round(recipe.carbs * ratio * 10) / 10,
    fat:     derivedMacros?.fat     ?? Math.round(recipe.fat * ratio * 10) / 10,
    cost: scaledCost,
  };

  // Ingredient status with aggregated qty from all matching inventory lots
  const ingStatus = useMemo(() => {
    return recipe.ingredients.map((ing) => {
      const scaledQty = Math.round(ing.quantity * ratio * 10) / 10;
      const needed = qtyOverrides[ing.name] ?? scaledQty;
      const available = state.inventory
        .filter((item) => {
          const n = item.name.toLowerCase();
          const i = ing.name.toLowerCase();
          return n.includes(i.split(" ")[0]) || i.includes(n.split(" ")[0]);
        })
        .reduce((sum, item) => sum + item.qty, 0);
      const status = available >= needed ? "ok" : available > 0 ? "partial" : "missing";
      return { name: ing.name, unit: ing.unit, needed, scaledQty, available: Math.round(available * 10) / 10, status };
    });
  }, [recipe, ratio, state.inventory, qtyOverrides]);

  const missingCount = ingStatus.filter((i) => i.status !== "ok").length;
  const pending = getPendingMacros(state);
  const exceedKcal = pending.kcal > 0 && scaled.kcal > pending.kcal + 100;
  const coversProtein = scaled.protein >= pending.protein * 0.7;

  function updateIngQty(name: string, val: number) {
    setQtyOverrides((prev) => ({ ...prev, [name]: Math.max(0, val) }));
  }

  function resetIngQty(name: string) {
    setQtyOverrides((prev) => { const next = { ...prev }; delete next[name]; return next; });
  }

  function addMissingToCart() {
    const toAdd = ingStatus.filter((i) => i.status !== "ok");
    mutate((draft) => {
      for (const ing of toAdd) {
        const qty = Math.ceil(ing.needed - ing.available);
        const existing = draft.cart.find(
          (c) => c.name.toLowerCase() === ing.name.toLowerCase() && !c.checked
        );
        if (existing) {
          existing.qty += qty;
        } else {
          draft.cart.push({
            id: uid(),
            name: ing.name,
            qty,
            unit: ing.unit,
            price: Math.max(0.5, recipe.cost / recipe.ingredients.length),
            store: state.settings?.defaultStore ?? "Mercadona",
            checked: false,
            source: "plan" as const,
          });
        }
      }
    });
    showToast(`${toAdd.length} ingrediente${toAdd.length !== 1 ? "s" : ""} añadido${toAdd.length !== 1 ? "s" : ""} al carrito`);
  }

  function cook() {
    const overrides = Object.keys(qtyOverrides).length > 0 ? qtyOverrides : undefined;
    mutate((draft) => actions.cookRecipe(draft, recipe, ratio, { deductIngredients: deduct, qtyOverrides: overrides, date: logDate, mealType }));
    const lines: string[] = [];
    if (exceedKcal) lines.push("Atención: superas el objetivo de calorías de hoy.");
    if (coversProtein) lines.push("Proteína del día cubierta ✓");
    setMascotMessage(
      `${recipe.title} cocinado. ${scaled.kcal} kcal y ${scaled.protein}g de proteína registrados. ${lines.join(" ")}`
    );
    showToast(`${recipe.title} cocinado (${servings} ración${servings !== 1 ? "es" : ""})`);
    onClose();
  }

  return (
    <Modal title={`Cocinar: ${recipe.title}`} onClose={onClose}>
      {/* Servings */}
      <div className="cook-servings">
        <span className="cook-label">Raciones</span>
        <div className="servings-row">
          <button type="button" className="serving-btn" onClick={() => setServings((s) => Math.max(0.5, Math.round((s - 0.5) * 10) / 10))}>−</button>
          <strong className="servings-val">{servings}</strong>
          <button type="button" className="serving-btn" onClick={() => setServings((s) => Math.min(12, Math.round((s + 0.5) * 10) / 10))}>+</button>
        </div>
        <span className="cook-hint">Base: {recipe.servings || 1} ración{(recipe.servings || 1) !== 1 ? "es" : ""}</span>
      </div>

      {/* Macro impact */}
      <div className="cook-macros">
        <div className={`cook-macro-item ${exceedKcal ? "warn" : ""}`}>
          <span>{scaled.kcal}</span>
          <small>kcal{exceedKcal ? " ⚠" : ""}</small>
        </div>
        <div className={`cook-macro-item ${coversProtein ? "good" : ""}`}>
          <span>{scaled.protein}g</span>
          <small>prot{coversProtein ? " ✓" : ""}</small>
        </div>
        <div className="cook-macro-item">
          <span>{scaled.carbs}g</span>
          <small>carb</small>
        </div>
        <div className="cook-macro-item">
          <span>{scaled.fat}g</span>
          <small>grasa</small>
        </div>
        <div className="cook-macro-item">
          <span>{eur(scaled.cost)}</span>
          <small>coste</small>
        </div>
      </div>

      {/* Macro warnings */}
      {(exceedKcal || coversProtein) && (
        <div className={`cook-alert ${exceedKcal && !coversProtein ? "warn" : "good"}`}>
          {exceedKcal && (
            <p>⚠ Superas el objetivo de calorías en {Math.round(scaled.kcal - pending.kcal)} kcal.</p>
          )}
          {coversProtein && pending.protein > 0 && (
            <p>✓ Cubre {Math.round((scaled.protein / pending.protein) * 100)}% de la proteína que te falta.</p>
          )}
        </div>
      )}

      {/* Ingredient status — with editable quantities */}
      <div className="cook-ingredients">
        <h4>Ingredientes</h4>
        <ul className="cook-ing-list">
          {ingStatus.map((ing) => {
            const isOverridden = ing.name in qtyOverrides;
            return (
              <li key={ing.name} className={`cook-ing-item ${ing.status}`}>
                <span className="cook-ing-dot" />
                <span className="cook-ing-name">{ing.name}</span>
                <span className="cook-ing-qty-wrap">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={ing.needed}
                    className={`cook-ing-qty-input ${isOverridden ? "overridden" : ""}`}
                    onChange={(e) => updateIngQty(ing.name, Number(e.target.value))}
                  />
                  <span className="cook-ing-unit">{ing.unit}</span>
                  {isOverridden && (
                    <button
                      type="button"
                      className="cook-ing-reset"
                      title={`Restaurar a ${ing.scaledQty} ${ing.unit}`}
                      onClick={() => resetIngQty(ing.name)}
                    >↺</button>
                  )}
                  {ing.status !== "ok" && (
                    <small className="cook-ing-avail">(tienes {ing.available})</small>
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        {missingCount > 0 && (
          <button type="button" className="secondary-button cook-cart-btn" onClick={addMissingToCart}>
            + Añadir {missingCount} ingrediente{missingCount !== 1 ? "s" : ""} faltante{missingCount !== 1 ? "s" : ""} al carrito
          </button>
        )}
      </div>

      {/* Deduct toggle */}
      <label className="cook-deduct-toggle">
        <input type="checkbox" checked={deduct} onChange={(e) => setDeduct(e.target.checked)} />
        Descontar ingredientes del inventario al cocinar
      </label>

      <div className="recipe-detail-actions">
        <button className="secondary-button" onClick={onClose}>Cancelar</button>
        <button className="primary-button" onClick={cook}>
          Cocinar {servings} ración{servings !== 1 ? "es" : ""}
        </button>
      </div>
    </Modal>
  );
}
