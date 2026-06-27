"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import type { MealPlanDay, MealType, QuickMeal, Recipe } from "@foodos/types";
import { allRecipes, getMealPlanShoppingList, useFoodOS } from "@/lib/state";
import { CookModal } from "../CookModal";
import { eur } from "@/lib/utils";

type MealSlot = keyof MealPlanDay;

const MEAL_SLOTS: { key: MealSlot; label: string; icon: string; mealType: MealType }[] = [
  { key: "breakfast", label: "Desayuno", icon: "☀", mealType: "breakfast" },
  { key: "almuerzo",  label: "Almuerzo", icon: "◔", mealType: "snack"     },
  { key: "lunch",     label: "Comida",   icon: "◉", mealType: "lunch"     },
  { key: "merienda",  label: "Merienda", icon: "◕", mealType: "snack"     },
  { key: "dinner",    label: "Cena",     icon: "◑", mealType: "dinner"    },
];

const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

type PlanEntry = {
  id: string;
  title: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  cost: number;
  image?: string;
  isQuick: boolean;
};

const EMPTY_FORM = { name: "", kcal: "", protein: "", carbs: "", fat: "", cost: "" };

function getMondayOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function toKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

export function PlannerView() {
  const { state, mutate, showToast } = useFoodOS();
  const recipes = allRecipes(state);
  const quickMeals: QuickMeal[] = state.plannerQuickMeals ?? [];
  const plan = state.mealPlan ?? {};

  const [weekStart, setWeekStart] = useState(() => getMondayOfWeek(new Date()));
  const draggingId = useRef<string | null>(null);
  const [, forceRender] = useState(0);

  /* Quick-add modal */
  const [quickAdd, setQuickAdd] = useState<{ dateKey: string; slot: MealSlot } | null>(null);
  const [quickForm, setQuickForm] = useState(EMPTY_FORM);

  /* CookModal para recetas del planificador */
  const [cookingRecipe, setCookingRecipe] = useState<Recipe | null>(null);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = state.debugDate ?? toKey(new Date());

  function findEntry(id: string): PlanEntry | null {
    const r = recipes.find((x) => x.id === id);
    if (r) return { id: r.id, title: r.title, kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, cost: r.cost, image: r.image, isQuick: false };
    const q = quickMeals.find((x) => x.id === id);
    if (q) return { id: q.id, title: q.name, kcal: q.kcal, protein: q.protein, carbs: q.carbs, fat: q.fat, cost: q.cost, isQuick: true };
    return null;
  }

  function setMeal(dateKey: string, slot: MealSlot, id: string | null) {
    mutate((draft) => {
      draft.mealPlan ||= {};
      draft.mealPlan[dateKey] ||= {};
      if (id === null) {
        delete draft.mealPlan[dateKey][slot];
      } else {
        draft.mealPlan[dateKey][slot] = id;
      }
    });
  }

  function saveQuickMeal() {
    if (!quickAdd || !quickForm.name.trim()) return;
    const meal: QuickMeal = {
      id: crypto.randomUUID(),
      name: quickForm.name.trim(),
      kcal: Number(quickForm.kcal) || 0,
      protein: Number(quickForm.protein) || 0,
      carbs: Number(quickForm.carbs) || 0,
      fat: Number(quickForm.fat) || 0,
      cost: Number(quickForm.cost) || 0,
    };
    mutate((draft) => {
      draft.plannerQuickMeals ||= [];
      draft.plannerQuickMeals.push(meal);
      draft.mealPlan ||= {};
      draft.mealPlan[quickAdd.dateKey] ||= {};
      draft.mealPlan[quickAdd.dateKey][quickAdd.slot] = meal.id;
    });
    setQuickAdd(null);
    setQuickForm(EMPTY_FORM);
    showToast(`"${meal.name}" añadido`);
  }

  function logEntry(dateKey: string, mealType: MealType, entry: PlanEntry) {
    if (!entry.isQuick) {
      // Receta real → abre CookModal para descuento de inventario
      const recipe = recipes.find((r) => r.id === entry.id);
      if (recipe) { setCookingRecipe(recipe); return; }
    }
    // Plato rápido → registro directo (sin ingredientes que descontar)
    mutate((draft) => {
      draft.foodLog.push({
        id: crypto.randomUUID(),
        date: dateKey,
        time: new Date().toTimeString().slice(0, 5),
        name: entry.title,
        qty: null,
        unit: null,
        kcal: entry.kcal,
        protein: entry.protein,
        carbs: entry.carbs,
        fat: entry.fat,
        source: "recipe",
        mealType,
      });
    });
    showToast(`"${entry.title}" registrado`);
  }

  function handleBuyWeek() {
    const items = getMealPlanShoppingList(state, days.map(toKey));
    if (items.length === 0) {
      showToast("Todo lo necesario ya está en el inventario o el carrito");
      return;
    }
    mutate((draft) => {
      const existing = new Set(draft.cart.filter((i) => !i.checked).map((i) => i.name.toLowerCase()));
      draft.cart.push(...items.filter((item) => !existing.has(item.name.toLowerCase())));
    });
    showToast(`${items.length} ingredientes añadidos al carrito`);
  }

  function handleDrop(e: React.DragEvent, dateKey: string, slot: MealSlot) {
    e.currentTarget.classList.remove("drag-over");
    const id = e.dataTransfer.getData("recipeId") || draggingId.current;
    if (id) setMeal(dateKey, slot, id);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.currentTarget.classList.add("drag-over");
  }

  function handleDragLeave(e: React.DragEvent) {
    e.currentTarget.classList.remove("drag-over");
  }

  /* Targets */
  const targetKcal  = state.nutrition?.kcal    ?? 0;
  const targetProt  = state.nutrition?.protein  ?? 0;
  const targetCarbs = state.nutrition?.carbs    ?? 0;
  const targetFat   = state.nutrition?.fat      ?? 0;

  type DayTotal = { kcal: number; prot: number; carbs: number; fat: number; cost: number };
  const dayTotals: DayTotal[] = days.map((d) => {
    const day = plan[toKey(d)];
    let kcal = 0, prot = 0, carbs = 0, fat = 0, cost = 0;
    if (day) {
      MEAL_SLOTS.forEach(({ key }) => {
        const e = day[key] ? findEntry(day[key]!) : null;
        if (e) { kcal += e.kcal; prot += e.protein; carbs += e.carbs; fat += e.fat; cost += e.cost; }
      });
    }
    return { kcal, prot, carbs, fat, cost };
  });

  const weekKcal = dayTotals.reduce((s, d) => s + d.kcal, 0);
  const weekProt = dayTotals.reduce((s, d) => s + d.prot, 0);
  const weekCost = dayTotals.reduce((s, d) => s + d.cost, 0);

  const [search, setSearch] = useState("");
  const filteredRecipes = search.trim()
    ? recipes.filter((r) => r.title.toLowerCase().includes(search.toLowerCase()))
    : recipes;

  return (
    <section className="view">
      <div className="planner-layout">

        {/* ── Panel principal ── */}
        <div className="panel planner-main-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Planificador semanal</p>
              <h2>¿Qué vas a comer esta semana?</h2>
            </div>
            <div className="panel-actions">
              <button className="secondary-button" onClick={() => setWeekStart(addDays(weekStart, -7))}>
                ← Anterior
              </button>
              <span className="planner-week-range">
                {fmtDay(days[0])} – {fmtDay(days[6])}
              </span>
              <button className="secondary-button" onClick={() => setWeekStart(addDays(weekStart, 7))}>
                Siguiente →
              </button>
              <button className="secondary-button" onClick={() => setWeekStart(getMondayOfWeek(new Date()))}>
                Hoy
              </button>
              <button className="secondary-button planner-buy-btn" onClick={handleBuyWeek} title="Generar lista de la compra desde las recetas de esta semana">
                🛒 Comprar semana
              </button>
            </div>
          </div>

          {/* Resumen semanal */}
          <div className="planner-summary">
            <span className="planner-summary-chip"><b>{Math.round(weekKcal)}</b> kcal</span>
            <span className="planner-summary-chip"><b>{Math.round(weekProt)}g</b> proteína</span>
            <span className="planner-summary-chip cost"><b>{eur(weekCost)}</b> coste</span>
            <span className="planner-drag-hint">Arrastra recetas o pulsa + para añadir un plato rápido</span>
          </div>

          {/* Grid */}
          <div className="planner-scroll">
            <div className="planner-grid">
              {/* Cabecera */}
              <div className="planner-header-row">
                <div className="planner-corner" />
                {days.map((d, i) => (
                  <div key={i} className={`planner-day-head ${toKey(d) === today ? "today" : ""}`}>
                    <span className="planner-day-name">{DAY_NAMES[i]}</span>
                    <span className="planner-day-num">{d.getDate()}</span>
                    {toKey(d) === today && <span className="planner-today-dot" />}
                  </div>
                ))}
              </div>

              {/* Filas de comidas */}
              {MEAL_SLOTS.map(({ key, label, icon, mealType }) => (
                <div key={key} className="planner-meal-row">
                  <div className="planner-meal-label">
                    <span className="planner-meal-icon">{icon}</span>
                    <span>{label}</span>
                  </div>

                  {days.map((d, di) => {
                    const dateKey = toKey(d);
                    const rid = plan[dateKey]?.[key];
                    const entry = rid ? findEntry(rid) : null;
                    return (
                      <div
                        key={di}
                        className={`planner-cell ${entry ? "has-recipe" : "empty"}`}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={(e) => handleDrop(e, dateKey, key)}
                      >
                        {entry ? (
                          <div className="planner-cell-content">
                            {entry.image ? (
                              <Image
                                src={entry.image}
                                alt=""
                                width={36}
                                height={28}
                                className="planner-cell-img"
                              />
                            ) : (
                              <div className="planner-cell-quick-icon">◌</div>
                            )}
                            <div className="planner-cell-info">
                              <span className="planner-cell-name">{entry.title}</span>
                              <span className="planner-cell-meta">{entry.kcal} kcal</span>
                            </div>
                            <div className="planner-cell-actions">
                              <button
                                className="planner-cell-log"
                                title="Registrar en el diario"
                                onClick={() => logEntry(dateKey, mealType, entry)}
                              >
                                ✓
                              </button>
                              <button
                                className="planner-cell-remove"
                                title="Quitar"
                                onClick={() => setMeal(dateKey, key, null)}
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            className="planner-cell-plus"
                            onClick={() => { setQuickAdd({ dateKey, slot: key }); setQuickForm(EMPTY_FORM); }}
                            title="Añadir plato"
                          >
                            +
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}

              {/* Totales diarios */}
              <div className="planner-totals-row">
                <div className="planner-totals-label">Totales</div>
                {dayTotals.map((dt, i) => {
                  const kcalPct = targetKcal > 0 ? dt.kcal / targetKcal : 0;
                  const protPct = targetProt  > 0 ? dt.prot / targetProt  : 0;
                  const status =
                    dt.kcal === 0 ? "empty"
                    : kcalPct >= 0.85 && protPct >= 0.85 ? "good"
                    : kcalPct >= 0.5  || protPct >= 0.5  ? "partial"
                    : "low";
                  return (
                    <div key={i} className={`planner-total-cell ${status}`}>
                      {dt.kcal === 0 ? (
                        <span className="planner-total-empty">—</span>
                      ) : (
                        <>
                          <span className="planner-total-kcal">
                            {Math.round(dt.kcal)}
                            {targetKcal > 0 && <span className="planner-total-target">/{targetKcal}</span>}
                            <span className="planner-total-unit"> kcal</span>
                          </span>
                          <div className="planner-total-bar">
                            <div
                              className="planner-total-bar-fill"
                              style={{ width: `${Math.min(kcalPct * 100, 100)}%` }}
                            />
                          </div>
                          <div className="planner-total-macros">
                            <span>
                              <b>{Math.round(dt.prot)}</b>
                              {targetProt > 0 && <span className="planner-total-target">/{targetProt}</span>}g P
                            </span>
                            <span>
                              <b>{Math.round(dt.fat)}</b>
                              {targetFat > 0 && <span className="planner-total-target">/{targetFat}</span>}g G
                            </span>
                            <span>
                              <b>{Math.round(dt.carbs)}</b>
                              {targetCarbs > 0 && <span className="planner-total-target">/{targetCarbs}</span>}g HC
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* ── Panel lateral: recetas ── */}
        <div className="panel planner-sidebar">
          <h3>Recetas</h3>
          <input
            className="planner-search"
            type="search"
            placeholder="Buscar…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="planner-recipe-list">
            {filteredRecipes.map((recipe) => (
              <div
                key={recipe.id}
                className="planner-recipe-card"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("recipeId", recipe.id);
                  draggingId.current = recipe.id;
                  // Ghost personalizado para evitar el rectángulo blanco del navegador
                  const ghost = document.createElement("div");
                  ghost.className = "planner-drag-ghost";
                  ghost.textContent = recipe.title;
                  document.body.appendChild(ghost);
                  e.dataTransfer.setDragImage(ghost, 12, 12);
                  requestAnimationFrame(() => document.body.removeChild(ghost));
                  forceRender((n) => n + 1);
                }}
                onDragEnd={() => {
                  draggingId.current = null;
                  forceRender((n) => n + 1);
                }}
              >
                <Image src={recipe.image} alt="" width={44} height={34} className="planner-recipe-img" />
                <div className="planner-recipe-info">
                  <span className="planner-recipe-name">{recipe.title}</span>
                  <span className="planner-recipe-meta">
                    {recipe.kcal} kcal · {eur(recipe.cost)} · {recipe.time} min
                  </span>
                </div>
              </div>
            ))}
            {filteredRecipes.length === 0 && <p className="planner-empty">Sin resultados.</p>}
          </div>
        </div>

      </div>

      {cookingRecipe && (
        <CookModal recipe={cookingRecipe} onClose={() => setCookingRecipe(null)} />
      )}

      {/* ── Modal de plato rápido ── */}
      {quickAdd && (
        <div className="planner-quickadd-overlay" onClick={() => setQuickAdd(null)}>
          <div className="planner-quickadd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="planner-quickadd-head">
              <h3>Añadir plato</h3>
              <button className="planner-quickadd-close" onClick={() => setQuickAdd(null)}>×</button>
            </div>

            <div className="planner-quickadd-body">
              <input
                className="planner-quickadd-name"
                placeholder="Nombre del plato (ej. Tortilla de atún)"
                value={quickForm.name}
                onChange={(e) => setQuickForm((f) => ({ ...f, name: e.target.value }))}
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && saveQuickMeal()}
              />

              <div className="planner-quickadd-macros">
                {([
                  { field: "kcal",    label: "kcal"     },
                  { field: "protein", label: "Proteína (g)" },
                  { field: "carbs",   label: "HC (g)"   },
                  { field: "fat",     label: "Grasas (g)" },
                  { field: "cost",    label: "Coste (€)", step: "0.10" },
                ] as { field: keyof typeof quickForm; label: string; step?: string }[]).map(({ field, label, step }) => (
                  <label key={field} className="planner-quickadd-field">
                    <span>{label}</span>
                    <input
                      type="number"
                      min={0}
                      step={step ?? "1"}
                      placeholder="0"
                      value={quickForm[field]}
                      onChange={(e) => setQuickForm((f) => ({ ...f, [field]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="planner-quickadd-foot">
              <button className="secondary-button" onClick={() => setQuickAdd(null)}>Cancelar</button>
              <button
                className="primary-button"
                onClick={saveQuickMeal}
                disabled={!quickForm.name.trim()}
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
