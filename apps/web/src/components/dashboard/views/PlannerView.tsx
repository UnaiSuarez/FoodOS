"use client";

import Image from "next/image";
import { Fragment, useRef, useState } from "react";
import type { MealPlanDay } from "@foodos/types";
import { allRecipes, useFoodOS } from "@/lib/state";
import { eur } from "@/lib/utils";

type MealSlot = keyof MealPlanDay;

const MEAL_SLOTS: { key: MealSlot; label: string; icon: string }[] = [
  { key: "breakfast", label: "Desayuno",  icon: "☀" },
  { key: "almuerzo",  label: "Almuerzo",  icon: "◔" },
  { key: "lunch",     label: "Comida",    icon: "◉" },
  { key: "merienda",  label: "Merienda",  icon: "◕" },
  { key: "dinner",    label: "Cena",      icon: "◑" },
];

const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

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
  const { state, mutate } = useFoodOS();
  const recipes = allRecipes(state);
  const plan = state.mealPlan ?? {};

  const [weekStart, setWeekStart] = useState(() => getMondayOfWeek(new Date()));
  const draggingId = useRef<string | null>(null);
  const [, forceRender] = useState(0);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = toKey(new Date());

  function setMeal(dateKey: string, slot: MealSlot, recipeId: string | null) {
    mutate((draft) => {
      draft.mealPlan ||= {};
      draft.mealPlan[dateKey] ||= {};
      if (recipeId === null) {
        delete draft.mealPlan[dateKey][slot];
      } else {
        draft.mealPlan[dateKey][slot] = recipeId;
      }
    });
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

  /* Per-day and weekly totals */
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
        const r = day[key] ? recipes.find((x) => x.id === day[key]) : null;
        if (r) { kcal += r.kcal; prot += r.protein; carbs += r.carbs; fat += r.fat; cost += r.cost; }
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
              <button
                className="secondary-button"
                onClick={() => setWeekStart(getMondayOfWeek(new Date()))}
              >
                Hoy
              </button>
            </div>
          </div>

          {/* Resumen semanal */}
          <div className="planner-summary">
            <span className="planner-summary-chip">
              <b>{Math.round(weekKcal)}</b> kcal
            </span>
            <span className="planner-summary-chip">
              <b>{Math.round(weekProt)}g</b> proteína
            </span>
            <span className="planner-summary-chip cost">
              <b>{eur(weekCost)}</b> coste
            </span>
            <span className="planner-drag-hint">
              Arrastra recetas desde el panel lateral
            </span>
          </div>

          {/* Grid de días × comidas */}
          <div className="planner-scroll">
            <div className="planner-grid">
              {/* Fila de cabecera: esquina vacía + 7 días */}
              <div className="planner-header-row">
                <div className="planner-corner" />
                {days.map((d, i) => (
                  <div
                    key={i}
                    className={`planner-day-head ${toKey(d) === today ? "today" : ""}`}
                  >
                    <span className="planner-day-name">{DAY_NAMES[i]}</span>
                    <span className="planner-day-num">{d.getDate()}</span>
                    {toKey(d) === today && <span className="planner-today-dot" />}
                  </div>
                ))}
              </div>

              {/* Filas de comidas */}
              {MEAL_SLOTS.map(({ key, label, icon }) => (
                <div key={key} className="planner-meal-row">
                  <div className="planner-meal-label">
                    <span className="planner-meal-icon">{icon}</span>
                    <span>{label}</span>
                  </div>

                  {days.map((d, di) => {
                    const dateKey = toKey(d);
                    const rid = plan[dateKey]?.[key];
                    const recipe = rid ? recipes.find((r) => r.id === rid) : null;
                    return (
                      <div
                        key={di}
                        className={`planner-cell ${recipe ? "has-recipe" : "empty"}`}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={(e) => handleDrop(e, dateKey, key)}
                      >
                        {recipe ? (
                          <div className="planner-cell-content">
                            <Image
                              src={recipe.image}
                              alt=""
                              width={40}
                              height={30}
                              className="planner-cell-img"
                            />
                            <div className="planner-cell-info">
                              <span className="planner-cell-name">{recipe.title}</span>
                              <span className="planner-cell-meta">
                                {recipe.kcal} kcal · {eur(recipe.cost)}
                              </span>
                            </div>
                            <button
                              className="planner-cell-remove"
                              onClick={() => setMeal(dateKey, key, null)}
                              aria-label="Quitar receta"
                            >
                              ×
                            </button>
                          </div>
                        ) : (
                          <span className="planner-cell-plus">+</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}

              {/* Fila de totales diarios */}
              <div className="planner-totals-row">
                <div className="planner-totals-label">Totales</div>
                {dayTotals.map((dt, i) => {
                  const kcalPct = targetKcal > 0 ? dt.kcal / targetKcal : 0;
                  const protPct = targetProt > 0 ? dt.prot / targetProt : 0;
                  const status =
                    dt.kcal === 0 ? "empty"
                    : kcalPct >= 0.85 && protPct >= 0.85 ? "good"
                    : kcalPct >= 0.5 || protPct >= 0.5 ? "partial"
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
                  forceRender((n) => n + 1);
                }}
                onDragEnd={() => {
                  draggingId.current = null;
                  forceRender((n) => n + 1);
                }}
              >
                <Image
                  src={recipe.image}
                  alt=""
                  width={44}
                  height={34}
                  className="planner-recipe-img"
                />
                <div className="planner-recipe-info">
                  <span className="planner-recipe-name">{recipe.title}</span>
                  <span className="planner-recipe-meta">
                    {recipe.kcal} kcal · {eur(recipe.cost)} · {recipe.time} min
                  </span>
                </div>
              </div>
            ))}
            {filteredRecipes.length === 0 && (
              <p className="planner-empty">Sin resultados.</p>
            )}
          </div>
        </div>

      </div>
    </section>
  );
}
