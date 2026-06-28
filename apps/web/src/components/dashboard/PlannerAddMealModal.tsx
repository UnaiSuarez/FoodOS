"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import type { MacroTotals, MealPlanDay } from "@foodos/types";
import { useFoodOS } from "@/lib/state";
import { searchOFFSuggestions } from "@/lib/food-lookup";
import { uid } from "@/lib/utils";
import { Modal } from "./Modal";

type MealSlot = keyof MealPlanDay;

interface DishIngredient {
  id: string;
  name: string;
  qty: number;
  unit: string;
  kcalPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
  fromInventoryId?: string;
  pricePerUnit?: number;
}

interface Suggestion {
  key: string;
  type: "inventory" | "off";
  name: string;
  unit: string;
  kcalPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
  invId?: string;
  pricePerUnit?: number;
}

function toGrams(qty: number, unit: string): number {
  if (unit === "kg" || unit === "L") return qty * 1000;
  if (unit === "ud") return qty * 60;
  return qty;
}

function calcIngMacros(ing: DishIngredient): MacroTotals {
  const g = toGrams(ing.qty, ing.unit);
  return {
    kcal:    Math.round((ing.kcalPer100    * g) / 100),
    protein: Math.round((ing.proteinPer100 * g) / 100 * 10) / 10,
    carbs:   Math.round((ing.carbsPer100   * g) / 100 * 10) / 10,
    fat:     Math.round((ing.fatPer100     * g) / 100 * 10) / 10,
  };
}

function sumMacros(list: MacroTotals[]): MacroTotals {
  const r = list.reduce(
    (a, m) => ({ kcal: a.kcal + m.kcal, protein: a.protein + m.protein, carbs: a.carbs + m.carbs, fat: a.fat + m.fat }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
  return { kcal: Math.round(r.kcal), protein: Math.round(r.protein * 10) / 10, carbs: Math.round(r.carbs * 10) / 10, fat: Math.round(r.fat * 10) / 10 };
}

interface Props {
  dateKey: string;
  slot: MealSlot;
  onClose: () => void;
}

export function PlannerAddMealModal({ dateKey, slot, onClose }: Props) {
  const { state, mutate, showToast } = useFoodOS();

  const [dishName, setDishName] = useState("");
  const [ingredients, setIngredients] = useState<DishIngredient[]>([]);
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [deductInv, setDeductInv] = useState(true);
  const [saveAsRecipe, setSaveAsRecipe] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const macros = useMemo(() => sumMacros(ingredients.map(calcIngMacros)), [ingredients]);
  const cost = ingredients.reduce((s, ing) => {
    if (!ing.pricePerUnit) return s;
    const g = toGrams(ing.qty, ing.unit);
    return s + (ing.pricePerUnit * g) / 1000;
  }, 0);

  function handleSearch(q: string) {
    setSearch(q);
    clearTimeout(timerRef.current);
    if (q.trim().length < 2) { setSuggestions([]); setShowSuggestions(false); return; }

    const invHits: Suggestion[] = state.inventory
      .filter(i => i.name.toLowerCase().includes(q.toLowerCase()) && i.qty > 0)
      .slice(0, 5)
      .map(i => ({
        key: `inv-${i.id}`,
        type: "inventory" as const,
        name: i.name,
        unit: i.unit,
        kcalPer100: i.kcal,
        proteinPer100: i.protein,
        carbsPer100: i.carbs ?? 0,
        fatPer100: i.fat ?? 0,
        invId: i.id,
        pricePerUnit: i.price > 0 ? i.price : undefined,
      }));

    setSuggestions(invHits);
    setShowSuggestions(true);
    setLoading(true);

    timerRef.current = setTimeout(async () => {
      try {
        const off = await searchOFFSuggestions(q, 4);
        setSuggestions(prev => [
          ...prev.filter(s => s.type === "inventory"),
          ...off.map((s, i) => ({
            key: `off-${i}-${s.name}`,
            type: "off" as const,
            name: s.name,
            unit: "g",
            kcalPer100: s.kcal,
            proteinPer100: s.protein,
            carbsPer100: s.carbs,
            fatPer100: s.fat,
          })),
        ]);
      } catch {}
      setLoading(false);
    }, 600);
  }

  function addIngredient(s: Suggestion) {
    const defaultQty = s.unit === "ud" ? 1 : 100;
    setIngredients(prev => [...prev, {
      id: uid(),
      name: s.name,
      qty: defaultQty,
      unit: s.unit,
      kcalPer100: s.kcalPer100,
      proteinPer100: s.proteinPer100,
      carbsPer100: s.carbsPer100,
      fatPer100: s.fatPer100,
      fromInventoryId: s.invId,
      pricePerUnit: s.pricePerUnit,
    }]);
    setSearch("");
    setSuggestions([]);
    setShowSuggestions(false);
    inputRef.current?.focus();
  }

  function removeIngredient(id: string) {
    setIngredients(prev => prev.filter(i => i.id !== id));
  }

  function updateQty(id: string, qty: number) {
    setIngredients(prev => prev.map(i => i.id === id ? { ...i, qty } : i));
  }

  function confirm() {
    if (ingredients.length === 0 && !dishName.trim()) return;
    const name = dishName.trim() || "Plato personalizado";

    mutate(draft => {
      const qm = {
        id: uid(),
        name,
        kcal: macros.kcal,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        cost: Math.round(cost * 100) / 100,
      };
      draft.plannerQuickMeals ||= [];
      draft.plannerQuickMeals.push(qm);

      draft.mealPlan ||= {};
      draft.mealPlan[dateKey] ||= {};
      draft.mealPlan[dateKey][slot] = qm.id;

      if (deductInv) {
        for (const ing of ingredients) {
          if (!ing.fromInventoryId) continue;
          const item = draft.inventory.find(i => i.id === ing.fromInventoryId);
          if (!item) continue;
          item.qty = Math.max(0, Math.round((item.qty - ing.qty) * 100) / 100);
        }
        draft.inventory = draft.inventory.filter(i => i.qty > 0);
      }

      if (saveAsRecipe) {
        draft.customRecipes.push({
          id: uid(),
          title: name,
          ingredients: ingredients.map(ing => ({ name: ing.name, quantity: ing.qty, unit: ing.unit })),
          kcal: macros.kcal,
          protein: macros.protein,
          carbs: macros.carbs,
          fat: macros.fat,
          cost: Math.round(cost * 100) / 100,
          image: "",
          time: 20,
          servings: 1,
          difficulty: "Fácil",
          tags: ["elaborado"],
          steps: [],
          aiGenerated: false,
        });
      }
    });

    showToast(`"${name}" añadido al planificador${saveAsRecipe ? " y guardado como receta" : ""}`);
    onClose();
  }

  const canConfirm = ingredients.length > 0 || dishName.trim().length > 0;

  return (
    <Modal title="Añadir plato al planificador" onClose={onClose}>
      <div className="lm-body">
        {/* Nombre */}
        <input
          className="lm-search"
          placeholder="Nombre del plato (ej. Tortilla de atún)"
          value={dishName}
          onChange={e => setDishName(e.target.value)}
          style={{ marginBottom: 12 }}
        />

        {/* Buscador de ingredientes */}
        <div className="lm-dish-search-wrap">
          <input
            ref={inputRef}
            className="lm-search"
            placeholder="Añadir ingrediente (inventario o buscar)…"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            onFocus={() => search.length >= 2 && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul className="lm-dish-suggestions">
              {suggestions.map(s => (
                <li key={s.key} onMouseDown={() => addIngredient(s)} className={`lm-dish-sug-item ${s.type === "inventory" ? "inv" : "off"}`}>
                  <span className="lm-dish-sug-badge">{s.type === "inventory" ? "📦" : "🌍"}</span>
                  <span className="lm-dish-sug-name">{s.name}</span>
                  <small className="lm-dish-sug-macro">{s.kcalPer100} kcal · {s.proteinPer100}g P</small>
                </li>
              ))}
              {loading && <li className="lm-dish-sug-loading">Buscando más…</li>}
            </ul>
          )}
        </div>

        {/* Lista de ingredientes */}
        {ingredients.length === 0 ? (
          <p className="lm-empty">Añade ingredientes buscando arriba, o escribe solo el nombre del plato.</p>
        ) : (
          <ul className="lm-dish-ingredients">
            {ingredients.map(ing => {
              const m = calcIngMacros(ing);
              return (
                <li key={ing.id} className="lm-dish-ing-row">
                  <span className="lm-dish-ing-name">
                    {ing.fromInventoryId ? "📦 " : ""}{ing.name}
                  </span>
                  <div className="lm-dish-ing-qty">
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={ing.qty}
                      onChange={e => updateQty(ing.id, Number(e.target.value))}
                    />
                    <span>{ing.unit}</span>
                  </div>
                  <small className="lm-dish-ing-macro">{m.kcal} kcal · {m.protein}g P</small>
                  <button className="lm-inv-remove" onClick={() => removeIngredient(ing.id)}>×</button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Totales */}
        {ingredients.length > 0 && (
          <div className="lm-macros">
            <span><strong>{macros.kcal}</strong> kcal</span>
            <span><strong>{macros.protein}g</strong> prot</span>
            <span><strong>{macros.carbs}g</strong> carb</span>
            <span><strong>{macros.fat}g</strong> grasa</span>
            {cost > 0 && <span><strong>€{cost.toFixed(2)}</strong></span>}
          </div>
        )}

        {/* Opciones */}
        <div className="lm-dish-options">
          <label className="lm-checkbox">
            <input
              type="checkbox"
              checked={deductInv}
              onChange={e => setDeductInv(e.target.checked)}
            />
            Descontar del inventario
          </label>
          <label className="lm-checkbox">
            <input
              type="checkbox"
              checked={saveAsRecipe}
              onChange={e => setSaveAsRecipe(e.target.checked)}
            />
            Guardar como receta
          </label>
        </div>

        <div className="lm-actions" style={{ marginTop: 16 }}>
          <button className="secondary-button" onClick={onClose}>Cancelar</button>
          <button className="primary-button" disabled={!canConfirm} onClick={confirm}>
            Añadir al planificador
          </button>
        </div>
      </div>
    </Modal>
  );
}
