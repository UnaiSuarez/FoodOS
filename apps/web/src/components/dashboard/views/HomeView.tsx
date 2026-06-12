"use client";

import Image from "next/image";
import { useState } from "react";
import type { InventoryItem } from "@foodos/types";
import {
  actions,
  allRecipes,
  getBudgetLeft,
  getConsumedToday,
  getFoodSpend,
  getMascot,
  getPendingMacros,
  getRecipeMatch,
  useFoodOS,
} from "@/lib/state";
import { GOAL_LABELS, isGymDay } from "@/lib/nutrition";
import { clampPct, daysUntil, eur } from "@/lib/utils";
import { ConsumeModal } from "../ConsumeModal";
import type { ViewId } from "../DashboardShell";

export function HomeView({
  goTo,
  openRecipe,
}: {
  goTo: (view: ViewId) => void;
  openRecipe: (id: string) => void;
}) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [consumeItem, setConsumeItem] = useState<InventoryItem | null>(null);

  const consumed = getConsumedToday(state);
  const pending = getPendingMacros(state);
  const budgetLeft = getBudgetLeft(state);
  const foodSpend = getFoodSpend(state);
  const budgetPct = clampPct(foodSpend, state.weeklyBudget);
  const kcalPct = clampPct(consumed.kcal, state.nutrition.kcal);
  const pendingCart = state.cart.filter((item) => !item.checked);
  const mascot = getMascot(state.mascotId);

  const expiring = state.inventory
    .filter((item) => daysUntil(item.expires) <= 3)
    .sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires))
    .slice(0, 4);

  // Sugerencia SOLO con motivo real: algo caduca + faltan macros + entra en presupuesto.
  const suggestion = (() => {
    if (!expiring.length || pending.protein < 15) return null;
    const expiringNames = expiring.map((item) => item.name.toLowerCase());
    const candidate = allRecipes(state)
      .filter((recipe) => recipe.cost <= Math.max(budgetLeft, 1.5))
      .map((recipe) => ({
        recipe,
        usedItem: expiring.find((item) =>
          recipe.ingredients.some(
            (ing) =>
              item.name.toLowerCase().includes(ing.name.split(" ")[0]) ||
              ing.name.includes(item.name.toLowerCase().split(" ")[0])
          )
        ),
        match: getRecipeMatch(state, recipe).pct,
      }))
      .filter((entry) => entry.usedItem)
      .sort((a, b) => b.match - a.match || b.recipe.protein - a.recipe.protein)[0];
    return candidate ?? null;
  })();

  // Mensaje contextual de la mascota segun el estado real.
  const mascotInsight = (() => {
    const urgent = expiring.find((item) => daysUntil(item.expires) <= 1);
    if (urgent) return `${urgent.name} caduca ${daysUntil(urgent.expires) < 0 ? "ya" : "mañana"}. ¿Lo usamos hoy?`;
    if (pending.protein > 40) return `Te faltan ${Math.round(pending.protein)} g de proteína para cerrar el día.`;
    if (budgetLeft <= state.weeklyBudget * 0.2 && state.weeklyBudget > 0)
      return `Queda poco presupuesto de comida: ${eur(budgetLeft)}. Mira las recetas económicas.`;
    if (kcalPct >= 95) return "Día completado. Macros cerrados, ¡bien hecho!";
    return "Todo en orden. Sigue así.";
  })();

  return (
    <section className="view">
      {!state.profile && (
        <button className="profile-banner" onClick={() => goTo("nutrition")}>
          <span>
            <strong>Configura tu perfil físico</strong> — FoodOS calculará tus calorías y macros
            diarios automáticamente (2 minutos).
          </span>
          <span className="banner-arrow">→</span>
        </button>
      )}

      <div className={`bento-grid ${suggestion ? "" : "no-suggest"}`}>
        {/* Macros del dia — la tarjeta principal */}
        <article className="panel bento-macros">
          <div className="bento-macros-head">
            <div>
              <p className="eyebrow">Hoy</p>
              <h2>
                {Math.round(consumed.kcal)} <small>/ {state.nutrition.kcal} kcal</small>
              </h2>
            </div>
            {state.profile && (
              <div className="bento-day-badges">
                <span className={`badge ${isGymDay(state.profile) ? "green" : "blue"}`}>
                  {isGymDay(state.profile) ? "💪 Día de gym" : "Día de descanso"}
                </span>
                <span className="badge">{GOAL_LABELS[state.profile.goal]}</span>
              </div>
            )}
          </div>
          <div className="bento-macros-body">
            <div
              className="macro-ring"
              role="img"
              aria-label={`${kcalPct}% de las calorías del día`}
              style={{
                background: `radial-gradient(circle, #11170d 0 55%, transparent 56%), conic-gradient(var(--green) 0 ${kcalPct * 3.6}deg, rgba(240, 244, 238, 0.1) ${kcalPct * 3.6}deg)`,
              }}
            >
              <span>{kcalPct}%</span>
            </div>
            <div className="bars">
              <MacroBar label="Proteína" value={consumed.protein} max={state.nutrition.protein} accent />
              <MacroBar label="Carbos" value={consumed.carbs} max={state.nutrition.carbs} />
              <MacroBar label="Grasas" value={consumed.fat} max={state.nutrition.fat} />
              {pending.protein > 0 ? (
                <p className="bars-note">
                  Te quedan <strong>{Math.round(pending.protein)} g de proteína</strong> y{" "}
                  {Math.round(pending.kcal)} kcal.
                </p>
              ) : (
                <p className="bars-note">Proteína del día cubierta ✓</p>
              )}
            </div>
          </div>
        </article>

        {/* Caducidades */}
        <article className="panel bento-expiry">
          <div className="panel-head">
            <h3>🥕 Caduca pronto</h3>
            <button className="text-button" onClick={() => goTo("inventory")}>
              Inventario
            </button>
          </div>
          {expiring.length ? (
            <ul className="expiry-list">
              {expiring.map((item) => {
                const days = daysUntil(item.expires);
                return (
                  <li key={item.id}>
                    <span className={`expiry-dot ${days <= 1 ? "red" : "amber"}`} />
                    <div>
                      <strong>{item.name}</strong>
                      <small>{days < 0 ? "caducado" : days === 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} días`}</small>
                    </div>
                    <button className="small-action good" onClick={() => setConsumeItem(item)}>
                      Usar
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="bento-empty">Nada en riesgo. Tu nevera está bajo control ✓</p>
          )}
        </article>

        {/* Presupuesto semanal */}
        <article className="panel bento-budget">
          <div className="panel-head">
            <h3>€ Presupuesto semanal</h3>
            <button className="text-button" onClick={() => goTo("finance")}>
              Finanzas
            </button>
          </div>
          <strong className="budget-big">{eur(budgetLeft)}</strong>
          <small className="budget-sub">
            disponibles de {eur(state.weeklyBudget)} · gastados {eur(foodSpend)}
          </small>
          <div className={`budget-track ${budgetPct >= 80 ? "warn" : ""}`}>
            <i style={{ width: `${budgetPct}%` }} />
          </div>
        </article>

        {/* Accesos rapidos */}
        <article className="panel bento-actions">
          <button className="quick-action" onClick={() => goTo("inventory")}>
            <span>＋</span> Añadir alimento
          </button>
          <button className="quick-action" onClick={() => goTo("nutrition")}>
            <span>🍽</span> Registrar comida
          </button>
          <button className="quick-action" onClick={() => goTo("cart")}>
            <span>🛒</span> Carrito
            {pendingCart.length > 0 && <b className="quick-badge">{pendingCart.length}</b>}
          </button>
          <button className="quick-action" onClick={() => goTo("recipes")}>
            <span>✦</span> Buscar receta
          </button>
        </article>

        {/* Mascota con insight contextual */}
        <article className="panel bento-mascot">
          <div className="bento-mascot-avatar">
            <Image src={mascot.image} alt={mascot.name} width={120} height={134} />
          </div>
          <div>
            <strong>{mascot.name}</strong>
            <p>{mascotInsight}</p>
          </div>
        </article>

        {/* Sugerencia inteligente — solo con motivo real */}
        {suggestion && (
          <article className="panel bento-suggest">
            <p className="eyebrow">Sugerencia con motivo</p>
            <h3>{suggestion.recipe.title}</h3>
            <p className="suggest-why">
              Usa <strong>{suggestion.usedItem!.name.toLowerCase()}</strong> que caduca{" "}
              {daysUntil(suggestion.usedItem!.expires) <= 0
                ? "hoy"
                : daysUntil(suggestion.usedItem!.expires) === 1
                  ? "mañana"
                  : `en ${daysUntil(suggestion.usedItem!.expires)} días`}
              , aporta <strong>{suggestion.recipe.protein} g de proteína</strong> y cuesta{" "}
              {eur(suggestion.recipe.cost)} — dentro de tu presupuesto.
            </p>
            <div className="card-actions">
              <button className="small-action" onClick={() => openRecipe(suggestion.recipe.id)}>
                Ver receta
              </button>
              <button
                className="small-action good"
                onClick={() => {
                  mutate((draft) => actions.cookRecipe(draft, suggestion.recipe));
                  setMascotMessage("Receta cocinada. Objetivos actualizados.");
                  showToast("Receta registrada en nutrición");
                }}
              >
                Cocinar
              </button>
            </div>
          </article>
        )}
      </div>

      {consumeItem && <ConsumeModal item={consumeItem} onClose={() => setConsumeItem(null)} />}
    </section>
  );
}

function MacroBar({
  label,
  value,
  max,
  accent = false,
}: {
  label: string;
  value: number;
  max: number;
  accent?: boolean;
}) {
  return (
    <label className={accent ? "accent" : ""}>
      {label} <b>{`${Math.round(value)}/${Math.round(max)}g`}</b>
      <i>
        <em style={{ width: `${clampPct(value, max)}%` }} />
      </i>
    </label>
  );
}
