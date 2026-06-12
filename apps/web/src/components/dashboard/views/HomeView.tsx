"use client";

import {
  actions,
  bestRecipe,
  getBudgetLeft,
  getRecipeMatch,
  useFoodOS,
} from "@/lib/state";
import { GOAL_LABELS, isGymDay } from "@/lib/nutrition";
import { clampPct, daysUntil, eur } from "@/lib/utils";
import type { ViewId } from "../DashboardShell";

export function HomeView({
  goTo,
  openRecipe,
}: {
  goTo: (view: ViewId) => void;
  openRecipe: (id: string) => void;
}) {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();

  const expiring = state.inventory.filter((item) => daysUntil(item.expires) <= 3);
  const budgetLeft = getBudgetLeft(state);
  const proteinLeft = Math.max(0, state.nutrition.protein - state.consumed.protein);
  const pendingCart = state.cart.filter((item) => !item.checked);
  const recipe = bestRecipe(state);
  const match = getRecipeMatch(state, recipe);
  const kcalPct = clampPct(state.consumed.kcal, state.nutrition.kcal);

  const alerts = [
    ...expiring.map(
      (item) => `${item.name} caduca ${daysUntil(item.expires) < 0 ? "ya" : `en ${daysUntil(item.expires)} días`}.`
    ),
    ...(budgetLeft <= state.weeklyBudget * 0.2 ? ["Presupuesto de comida por debajo del 20%."] : []),
    ...(proteinLeft > 40 ? [`Te quedan ${Math.round(proteinLeft)} g de proteína para hoy.`] : []),
  ];

  return (
    <section className="view">
      {!state.profile ? (
        <button className="profile-banner" onClick={() => goTo("nutrition")}>
          <span>
            <strong>Configura tu perfil físico</strong> — FoodOS calculará tus calorías y macros
            diarios automáticamente (2 minutos).
          </span>
          <span className="banner-arrow">→</span>
        </button>
      ) : (
        <div className="meta-row" style={{ marginBottom: 12 }}>
          <span className={`badge ${isGymDay(state.profile) ? "green" : "blue"}`}>
            Hoy: {isGymDay(state.profile) ? "día de gym 💪" : "día de descanso"}
          </span>
          <span className="badge">{GOAL_LABELS[state.profile.goal]}</span>
          <span className="badge">{state.nutrition.kcal} kcal objetivo</span>
        </div>
      )}
      <div className="summary-grid">
        <article className="metric-card">
          <span>Caducan pronto</span>
          <strong>{expiring.length}</strong>
          <small>productos en 3 días</small>
        </article>
        <article className="metric-card">
          <span>Proteína pendiente</span>
          <strong>{Math.round(proteinLeft)}g</strong>
          <small>objetivo diario</small>
        </article>
        <article className="metric-card">
          <span>Presupuesto comida</span>
          <strong>{eur(budgetLeft)}</strong>
          <small>restante esta semana</small>
        </article>
        <article className="metric-card">
          <span>Carrito</span>
          <strong>{pendingCart.length}</strong>
          <small>items pendientes</small>
        </article>
      </div>

      <div className="dashboard-grid">
        <article className="panel hero-panel">
          <div>
            <p className="eyebrow">Recomendación FoodOS</p>
            {state.inventory.length === 0 ? (
              <>
                <h2>Añade alimentos para generar una sugerencia.</h2>
                <p>La app cruzará inventario, macros y presupuesto.</p>
              </>
            ) : (
              <>
                <h2>
                  <button className="link-title" onClick={() => openRecipe(recipe.id)}>
                    {recipe.title}
                  </button>
                </h2>
                <p>
                  {match.pct}% disponible · {recipe.protein} g proteína · coste estimado {eur(recipe.cost)} ·
                  presupuesto restante {eur(budgetLeft)}
                </p>
              </>
            )}
          </div>
          <button
            className="primary-button"
            onClick={() => {
              mutate((draft) => actions.cookRecipe(draft, recipe));
              setMascotMessage("Receta cocinada. Objetivos actualizados.");
              showToast("Receta registrada en nutrición");
            }}
          >
            Cocinar sugerencia
          </button>
        </article>

        <article className="panel macro-panel">
          <div
            className="macro-ring"
            style={{
              background: `radial-gradient(circle, #11170d 0 55%, transparent 56%), conic-gradient(var(--green) 0 ${kcalPct * 3.6}deg, rgba(240, 244, 238, 0.1) ${kcalPct * 3.6}deg)`,
            }}
          >
            <span>{kcalPct}%</span>
          </div>
          <div className="bars">
            <MacroBar label="Proteína" value={state.consumed.protein} max={state.nutrition.protein} />
            <MacroBar label="Carbos" value={state.consumed.carbs} max={state.nutrition.carbs} />
            <MacroBar label="Grasas" value={state.consumed.fat} max={state.nutrition.fat} />
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <h3>Alertas</h3>
            <button className="text-button" onClick={() => goTo("inventory")}>
              Ver inventario
            </button>
          </div>
          <div className="list">
            {alerts.length ? (
              alerts.map((alert) => (
                <div key={alert} className="card">
                  <div>
                    <h3>{alert}</h3>
                    <small>FoodOS monitor</small>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty">Sin alertas críticas ahora mismo.</div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}

function MacroBar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <label>
      {label} <b>{`${Math.round(value)}/${Math.round(max)}g`}</b>
      <i>
        <em style={{ width: `${clampPct(value, max)}%` }} />
      </i>
    </label>
  );
}
