"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MacroTotals, MealType, Recipe } from "@foodos/types";
import { actions, allRecipes, macrosForQuantity, useFoodOS } from "@/lib/state";
import { loadAIConfig } from "@/lib/ai-config";
import { estimateMealMacros } from "@/lib/ai-inventory";
import { searchOFFSuggestions } from "@/lib/food-lookup";
import { mealTypeFromTime, todayPlus, uid } from "@/lib/utils";
import { Modal } from "./Modal";

type Tab = "inventory" | "recipe" | "dish" | "external";

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
}

interface DishSuggestion {
  key: string;
  type: "inventory" | "off";
  name: string;
  unit: string;
  kcalPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
  invId?: string;
}

function toGrams(qty: number, unit: string): number {
  if (unit === "kg" || unit === "L") return qty * 1000;
  if (unit === "ud") return qty * 60;
  return qty;
}

function calcIngMacros(ing: DishIngredient): MacroTotals {
  const g = toGrams(ing.qty, ing.unit);
  return {
    kcal: Math.round((ing.kcalPer100 * g) / 100),
    protein: Math.round((ing.proteinPer100 * g) / 100 * 10) / 10,
    carbs: Math.round((ing.carbsPer100 * g) / 100 * 10) / 10,
    fat: Math.round((ing.fatPer100 * g) / 100 * 10) / 10,
  };
}

function sumMacros(list: MacroTotals[]): MacroTotals {
  const raw = list.reduce(
    (acc, m) => ({
      kcal: acc.kcal + m.kcal,
      protein: acc.protein + m.protein,
      carbs: acc.carbs + m.carbs,
      fat: acc.fat + m.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
  return {
    kcal: Math.round(raw.kcal),
    protein: Math.round(raw.protein * 10) / 10,
    carbs: Math.round(raw.carbs * 10) / 10,
    fat: Math.round(raw.fat * 10) / 10,
  };
}

function MacroBar({ macros }: { macros: MacroTotals }) {
  return (
    <div className="lm-macros">
      <span><strong>{macros.kcal}</strong> kcal</span>
      <span><strong>{macros.protein}g</strong> prot</span>
      <span><strong>{macros.carbs}g</strong> carb</span>
      <span><strong>{macros.fat}g</strong> grasa</span>
    </div>
  );
}

const MEAL_OPTIONS: { id: MealType; label: string }[] = [
  { id: "breakfast", label: "🌅 Desayuno" },
  { id: "lunch",     label: "☀️ Comida" },
  { id: "snack",     label: "🌤 Snack" },
  { id: "dinner",    label: "🌙 Cena" },
];

const TABS: { id: Tab; label: string }[] = [
  { id: "inventory", label: "📦 Inventario" },
  { id: "recipe",    label: "🍽️ Receta" },
  { id: "dish",      label: "🥘 Plato" },
  { id: "external",  label: "🌍 Externa" },
];

export function LogMealModal({ onClose }: { onClose: () => void }) {
  const { state, mutate, showToast } = useFoodOS();
  const [tab, setTab] = useState<Tab>("inventory");
  const nowTime = () => new Date().toTimeString().slice(0, 5);
  const [mealType, setMealType] = useState<MealType>(() => mealTypeFromTime(new Date().toTimeString().slice(0, 5)));

  // ── Tab Inventario ─────────────────────────────────────────────────────────
  const [invFilter, setInvFilter] = useState("");
  const [selectedQtys, setSelectedQtys] = useState<Map<string, number>>(new Map());

  const filteredInventory = useMemo(() =>
    state.inventory.filter(i =>
      !invFilter || i.name.toLowerCase().includes(invFilter.toLowerCase())
    ), [state.inventory, invFilter]);

  function toggleItem(id: string, defaultQty: number) {
    setSelectedQtys(prev => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, defaultQty);
      return next;
    });
  }

  const invMacroTotal = useMemo(() => {
    const list: MacroTotals[] = [];
    for (const [id, qty] of selectedQtys) {
      const item = state.inventory.find(i => i.id === id);
      if (item) list.push(macrosForQuantity(item, qty));
    }
    return sumMacros(list);
  }, [selectedQtys, state.inventory]);

  function confirmInventory() {
    if (selectedQtys.size === 0) return;
    mutate(draft => {
      for (const [id, qty] of selectedQtys) {
        actions.consumeInventoryItem(draft, id, qty, mealType);
      }
    });
    const n = selectedQtys.size;
    showToast(`${n} alimento${n !== 1 ? "s" : ""} registrado${n !== 1 ? "s" : ""} en el diario`);
    onClose();
  }

  // ── Tab Receta ─────────────────────────────────────────────────────────────
  const recipes = useMemo(() => allRecipes(state), [state]);
  const [recipeFilter, setRecipeFilter] = useState("");
  const [selectedRecipeId, setSelectedRecipeId] = useState("");
  const [servings, setServings] = useState(1);

  const filteredRecipes = useMemo(() =>
    recipes.filter(r => !recipeFilter || r.title.toLowerCase().includes(recipeFilter.toLowerCase())),
    [recipes, recipeFilter]);

  const selectedRecipe: Recipe | null = useMemo(
    () => recipes.find(r => r.id === selectedRecipeId) ?? null,
    [recipes, selectedRecipeId]
  );

  const recipeRatio = selectedRecipe ? servings / Math.max(1, selectedRecipe.servings || 1) : 1;
  const recipeMacros: MacroTotals = selectedRecipe
    ? {
        kcal: Math.round(selectedRecipe.kcal * recipeRatio),
        protein: Math.round(selectedRecipe.protein * recipeRatio * 10) / 10,
        carbs: Math.round(selectedRecipe.carbs * recipeRatio * 10) / 10,
        fat: Math.round(selectedRecipe.fat * recipeRatio * 10) / 10,
      }
    : { kcal: 0, protein: 0, carbs: 0, fat: 0 };

  function confirmRecipe() {
    if (!selectedRecipe) return;
    mutate(draft => actions.cookRecipe(draft, selectedRecipe, recipeRatio, { deductIngredients: false, mealType }));
    showToast(`${selectedRecipe.title} registrado en el diario`);
    onClose();
  }

  // ── Tab Plato elaborado ────────────────────────────────────────────────────
  const [dishName, setDishName] = useState("");
  const [dishIngredients, setDishIngredients] = useState<DishIngredient[]>([]);
  const [dishSearch, setDishSearch] = useState("");
  const [dishSuggestions, setDishSuggestions] = useState<DishSuggestion[]>([]);
  const [dishLoading, setDishLoading] = useState(false);
  const [showDishSuggestions, setShowDishSuggestions] = useState(false);
  const [saveDishAsRecipe, setSaveDishAsRecipe] = useState(false);
  const [deductFromInv, setDeductFromInv] = useState(true);
  const dishTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(dishTimerRef.current), []);

  const dishMacroTotal = useMemo(
    () => sumMacros(dishIngredients.map(calcIngMacros)),
    [dishIngredients]
  );

  function handleDishSearch(q: string) {
    setDishSearch(q);
    clearTimeout(dishTimerRef.current);

    if (q.trim().length < 2) {
      setDishSuggestions([]);
      setShowDishSuggestions(false);
      return;
    }

    const invResults: DishSuggestion[] = state.inventory
      .filter(item => item.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 4)
      .map(item => ({
        key: `inv-${item.id}`,
        type: "inventory" as const,
        name: item.name,
        unit: item.unit,
        kcalPer100: item.kcal,
        proteinPer100: item.protein,
        carbsPer100: item.carbs ?? 0,
        fatPer100: item.fat ?? 0,
        invId: item.id,
      }));

    setDishSuggestions(invResults);
    setShowDishSuggestions(true);
    setDishLoading(true);

    dishTimerRef.current = setTimeout(async () => {
      try {
        const offResults = await searchOFFSuggestions(q, 4);
        setDishSuggestions(prev => [
          ...prev.filter(s => s.type === "inventory"),
          ...offResults.map((s, i) => ({
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
      setDishLoading(false);
    }, 600);
  }

  function addDishIngredient(s: DishSuggestion) {
    const defaultQty = s.unit === "ud" ? 1 : 100;
    setDishIngredients(prev => [
      ...prev,
      {
        id: uid(),
        name: s.name,
        qty: defaultQty,
        unit: s.unit,
        kcalPer100: s.kcalPer100,
        proteinPer100: s.proteinPer100,
        carbsPer100: s.carbsPer100,
        fatPer100: s.fatPer100,
        fromInventoryId: s.invId,
      },
    ]);
    setDishSearch("");
    setDishSuggestions([]);
    setShowDishSuggestions(false);
  }

  function removeDishIngredient(id: string) {
    setDishIngredients(prev => prev.filter(i => i.id !== id));
  }

  function updateDishQty(id: string, qty: number) {
    setDishIngredients(prev => prev.map(i => i.id === id ? { ...i, qty } : i));
  }

  function confirmDish() {
    if (dishIngredients.length === 0) return;
    const name = dishName.trim() || "Plato elaborado";
    const macros = dishMacroTotal;
    const t = nowTime();

    mutate(draft => {
      draft.foodLog.push({
        id: uid(),
        date: todayPlus(0),
        time: t,
        name,
        qty: null,
        unit: null,
        kcal: Math.round(macros.kcal),
        protein: Math.round(macros.protein * 10) / 10,
        carbs: Math.round(macros.carbs * 10) / 10,
        fat: Math.round(macros.fat * 10) / 10,
        source: "manual",
        mealType,
      });

      if (deductFromInv) {
        for (const ing of dishIngredients) {
          if (!ing.fromInventoryId) continue;
          const item = draft.inventory.find(i => i.id === ing.fromInventoryId);
          if (!item) continue;
          item.qty = Math.max(0, Math.round((item.qty - ing.qty) * 100) / 100);
        }
        draft.inventory = draft.inventory.filter(i => i.qty > 0);
      }

      if (saveDishAsRecipe) {
        draft.customRecipes.push({
          id: uid(),
          title: name,
          ingredients: dishIngredients.map(ing => ({
            name: ing.name,
            quantity: ing.qty,
            unit: ing.unit,
          })),
          kcal: Math.round(macros.kcal),
          protein: Math.round(macros.protein * 10) / 10,
          carbs: Math.round(macros.carbs * 10) / 10,
          fat: Math.round(macros.fat * 10) / 10,
          cost: 0,
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

    showToast(`${name} registrado${saveDishAsRecipe ? " y guardado como receta" : ""}`);
    onClose();
  }

  // ── Tab Externa ────────────────────────────────────────────────────────────
  const [extDesc, setExtDesc] = useState("");
  const [extMacros, setExtMacros] = useState<MacroTotals | null>(null);
  const [extEstimating, setExtEstimating] = useState(false);
  const [extPrice, setExtPrice] = useState(0);
  const aiConfig = useMemo(() => loadAIConfig(), []);

  async function estimateExternal() {
    if (!aiConfig || !extDesc.trim()) return;
    setExtEstimating(true);
    setExtMacros(null);
    try {
      const result = await estimateMealMacros(aiConfig, extDesc.trim());
      if (result) setExtMacros(result);
      else showToast("La IA no pudo estimar los macros, inténtalo de nuevo");
    } finally {
      setExtEstimating(false);
    }
  }

  function confirmExternal() {
    if (!extMacros || !extDesc.trim()) return;
    const t = nowTime();
    mutate(draft => {
      draft.foodLog.push({
        id: uid(),
        date: todayPlus(0),
        time: t,
        name: extDesc.trim(),
        qty: null,
        unit: null,
        kcal: extMacros.kcal,
        protein: extMacros.protein,
        carbs: extMacros.carbs,
        fat: extMacros.fat,
        source: "manual",
        mealType,
      });
      if (extPrice > 0) {
        draft.expenses.push({
          id: uid(),
          type: "expense",
          amount: extPrice,
          category: "Comida",
          description: extDesc.trim().slice(0, 60),
          date: todayPlus(0),
        });
      }
    });
    showToast("Comida registrada en el diario");
    onClose();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const canConfirm = {
    inventory: selectedQtys.size > 0,
    recipe: selectedRecipe !== null,
    dish: dishIngredients.length > 0,
    external: extMacros !== null && extDesc.trim().length > 0,
  };

  // Shared meal type + confirm row used by all tabs
  function BottomBar({ disabled, label, onConfirm }: { disabled: boolean; label: string; onConfirm: () => void }) {
    return (
      <div className="lm-bottom">
        <div className="lm-meal-picker">
          {MEAL_OPTIONS.map(o => (
            <button
              key={o.id}
              type="button"
              className={`lm-meal-chip ${mealType === o.id ? "active" : ""}`}
              onClick={() => setMealType(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="lm-actions">
          <button className="secondary-button" onClick={onClose}>Cancelar</button>
          <button className="primary-button" disabled={disabled} onClick={onConfirm}>{label}</button>
        </div>
      </div>
    );
  }

  return (
    <Modal title="¿Qué has comido?" onClose={onClose}>
      {/* Tab bar */}
      <div className="lm-tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`lm-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab: Inventario ── */}
      {tab === "inventory" && (
        <div className="lm-body">
          <input
            className="lm-search"
            placeholder="Filtrar alimentos…"
            value={invFilter}
            onChange={e => setInvFilter(e.target.value)}
          />

          {filteredInventory.length === 0 && (
            <p className="lm-empty">No hay alimentos en el inventario.</p>
          )}

          <ul className="lm-inv-list">
            {filteredInventory.map(item => {
              const checked = selectedQtys.has(item.id);
              const qty = selectedQtys.get(item.id) ?? item.qty;
              return (
                <li
                  key={item.id}
                  className={`lm-inv-row ${checked ? "selected" : ""}`}
                  onClick={() => toggleItem(item.id, item.qty)}
                >
                  <span className={`lm-inv-dot ${checked ? "on" : ""}`} />
                  <span className="lm-inv-name">{item.name}</span>
                  <small className="lm-inv-stock">
                    {item.kcal > 0 ? `${item.kcal} kcal` : "sin macros"}
                  </small>
                  {checked ? (
                    <div className="lm-inv-qty" onClick={e => e.stopPropagation()}>
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={qty}
                        onChange={e =>
                          setSelectedQtys(prev => {
                            const next = new Map(prev);
                            next.set(item.id, Number(e.target.value));
                            return next;
                          })
                        }
                      />
                      <span>{item.unit}</span>
                      <button
                        className="lm-inv-remove"
                        onClick={e => { e.stopPropagation(); toggleItem(item.id, item.qty); }}
                      >×</button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {selectedQtys.size > 0 && <MacroBar macros={invMacroTotal} />}

          <BottomBar
            disabled={!canConfirm.inventory}
            label={`Registrar${selectedQtys.size > 0 ? ` (${selectedQtys.size})` : ""}`}
            onConfirm={confirmInventory}
          />
        </div>
      )}

      {/* ── Tab: Receta ── */}
      {tab === "recipe" && (
        <div className="lm-body">
          <input
            className="lm-search"
            placeholder="Buscar receta…"
            value={recipeFilter}
            onChange={e => setRecipeFilter(e.target.value)}
          />

          <ul className="lm-recipe-list">
            {filteredRecipes.map(r => (
              <li
                key={r.id}
                className={`lm-recipe-row ${selectedRecipeId === r.id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedRecipeId(r.id);
                  setServings(r.servings || 1);
                }}
              >
                <span className="lm-recipe-name">{r.title}</span>
                <span className="lm-recipe-macros">
                  {r.kcal} kcal · {r.protein}g P
                </span>
              </li>
            ))}
          </ul>

          {selectedRecipe && (
            <>
              <div className="lm-servings-row">
                <span className="lm-servings-lbl">Raciones</span>
                <button className="serving-btn" onClick={() => setServings(s => Math.max(0.5, Math.round((s - 0.5) * 10) / 10))}>−</button>
                <strong className="servings-val">{servings}</strong>
                <button className="serving-btn" onClick={() => setServings(s => Math.min(12, Math.round((s + 0.5) * 10) / 10))}>+</button>
                <small className="lm-servings-hint">base: {selectedRecipe.servings || 1}</small>
              </div>
              <MacroBar macros={recipeMacros} />
            </>
          )}

          <BottomBar disabled={!canConfirm.recipe} label="Registrar" onConfirm={confirmRecipe} />
        </div>
      )}

      {/* ── Tab: Plato elaborado ── */}
      {tab === "dish" && (
        <div className="lm-body">
          <input
            className="lm-search"
            placeholder="Nombre del plato (opcional)…"
            value={dishName}
            onChange={e => setDishName(e.target.value)}
          />

          <div className="lm-dish-search-wrap">
            <input
              className="lm-search"
              placeholder="Añadir ingrediente (inventario o buscar)…"
              value={dishSearch}
              onChange={e => handleDishSearch(e.target.value)}
              onFocus={() => { if (dishSearch.trim().length >= 2) setShowDishSuggestions(true); }}
              onBlur={() => setTimeout(() => setShowDishSuggestions(false), 150)}
            />
            {showDishSuggestions && (
              <ul className="ac-dropdown">
                {dishSuggestions.filter(s => s.type === "inventory").map(s => (
                  <li key={s.key} onMouseDown={() => addDishIngredient(s)}>
                    <span>{s.name}</span>
                    <span className="ac-badge">📦 inv</span>
                    <span className="ac-muted">{s.kcalPer100} kcal/100{s.unit}</span>
                  </li>
                ))}
                {dishLoading && (
                  <li className="ac-loading">Buscando en Open Food Facts…</li>
                )}
                {dishSuggestions.filter(s => s.type === "off").map(s => (
                  <li key={s.key} onMouseDown={() => addDishIngredient(s)}>
                    <span>{s.name}</span>
                    <span className="ac-badge ac-badge-off">OFF</span>
                    <span className="ac-muted">{s.kcalPer100} kcal/100g</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {dishIngredients.length === 0 && (
            <p className="lm-empty">Añade ingredientes buscando arriba.</p>
          )}

          <ul className="lm-dish-list">
            {dishIngredients.map(ing => {
              const m = calcIngMacros(ing);
              return (
                <li key={ing.id} className="lm-dish-row">
                  <span className="lm-dish-name">{ing.name}</span>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={ing.qty}
                    onChange={e => updateDishQty(ing.id, Number(e.target.value))}
                    className="lm-dish-qty"
                  />
                  <span className="lm-dish-unit">{ing.unit}</span>
                  <span className="lm-dish-kcal">{m.kcal} kcal</span>
                  <button className="small-action bad" onClick={() => removeDishIngredient(ing.id)}>×</button>
                </li>
              );
            })}
          </ul>

          {dishIngredients.length > 0 && <MacroBar macros={dishMacroTotal} />}

          <div className="lm-toggles">
            <label>
              <input type="checkbox" checked={deductFromInv} onChange={e => setDeductFromInv(e.target.checked)} />
              Descontar del inventario
            </label>
            <label>
              <input type="checkbox" checked={saveDishAsRecipe} onChange={e => setSaveDishAsRecipe(e.target.checked)} />
              Guardar como receta
            </label>
          </div>

          <BottomBar disabled={!canConfirm.dish} label="Registrar plato" onConfirm={confirmDish} />
        </div>
      )}

      {/* ── Tab: Comida externa ── */}
      {tab === "external" && (
        <div className="lm-body">
          <textarea
            className="lm-ext-textarea"
            placeholder="Describe qué has comido, ej: menú del día con lentejas, filete y postre, o 2 trozos de pizza margarita…"
            value={extDesc}
            onChange={e => setExtDesc(e.target.value)}
            rows={3}
          />

          {!aiConfig && (
            <p className="lm-no-ai">
              Configura tu IA en Ajustes para estimar macros automáticamente.
            </p>
          )}

          <button
            className="secondary-button lm-estimate-btn"
            disabled={!aiConfig || extEstimating || extDesc.trim().length < 5}
            onClick={estimateExternal}
          >
            {extEstimating ? "Estimando…" : "✨ Estimar con IA"}
          </button>

          {extMacros && (
            <>
              <p className="lm-ext-hint">Macros estimados (puedes ajustarlos):</p>
              <div className="lm-ext-macros">
                {(["kcal", "protein", "carbs", "fat"] as const).map(k => (
                  <label key={k} className="lm-ext-field">
                    <small>{k === "kcal" ? "kcal" : k === "protein" ? "Proteína g" : k === "carbs" ? "Carbs g" : "Grasa g"}</small>
                    <input
                      type="number" min="0"
                      step={k === "kcal" ? "1" : "0.1"}
                      value={extMacros[k]}
                      onChange={e => setExtMacros(prev => prev ? { ...prev, [k]: Number(e.target.value) } : null)}
                    />
                  </label>
                ))}
              </div>
            </>
          )}

          <label className="lm-ext-price-row">
            <small>Coste (€, opcional)</small>
            <input
              type="number" min="0" step="0.5"
              value={extPrice || ""}
              placeholder="0.00"
              onChange={e => setExtPrice(Number(e.target.value))}
              className="lm-ext-price-input"
            />
          </label>

          <BottomBar disabled={!canConfirm.external} label="Registrar" onConfirm={confirmExternal} />
        </div>
      )}
    </Modal>
  );
}
