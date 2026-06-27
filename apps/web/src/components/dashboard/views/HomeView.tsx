"use client";

import Image from "next/image";
import { useState } from "react";
import type { InventoryItem, MealPlanDay } from "@foodos/types";
import {
  actions,
  allRecipes,
  findPlanEntry,
  getBudgetLeft,
  getConsumedToday,
  getDinnerSuggestion,
  getFoodSpend,
  getMascot,
  getPendingMacros,
  getRecipeMatch,
  useFoodOS,
} from "@/lib/state";
import { GOAL_LABELS, isGymDay } from "@/lib/nutrition";
import { clampPct, daysUntil, eur } from "@/lib/utils";
import { ConsumeModal } from "../ConsumeModal";
import { CookModal } from "../CookModal";
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
  const [cookingRecipe, setCookingRecipe] = useState<import("@foodos/types").Recipe | null>(null);
  const [whatToEatOpen, setWhatToEatOpen] = useState(false);

  const consumed = getConsumedToday(state);
  const pending = getPendingMacros(state);
  const budgetLeft = getBudgetLeft(state);
  const foodSpend = getFoodSpend(state);
  const budgetPct = clampPct(foodSpend, state.weeklyBudget);
  const kcalPct = clampPct(consumed.kcal, state.nutrition.kcal);
  const pendingCart = state.cart.filter((item) => !item.checked);
  const mascot = getMascot(state.mascotId);

  /* Plan de hoy */
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayPlan: MealPlanDay = state.mealPlan?.[todayKey] ?? {};
  const TODAY_SLOTS = [
    { key: "breakfast" as keyof MealPlanDay, label: "Desayuno",  icon: "☀", mealType: "breakfast" as const },
    { key: "almuerzo"  as keyof MealPlanDay, label: "Almuerzo",  icon: "◔", mealType: "snack"     as const },
    { key: "lunch"     as keyof MealPlanDay, label: "Comida",    icon: "◉", mealType: "lunch"     as const },
    { key: "merienda"  as keyof MealPlanDay, label: "Merienda",  icon: "◕", mealType: "snack"     as const },
    { key: "dinner"    as keyof MealPlanDay, label: "Cena",      icon: "◑", mealType: "dinner"    as const },
  ];
  const plannedCount = TODAY_SLOTS.filter(s => todayPlan[s.key]).length;

  function logPlanEntry(entryId: string, mealType: "breakfast" | "lunch" | "dinner" | "snack") {
    const entry = findPlanEntry(state, entryId);
    if (!entry) return;
    mutate((draft) => {
      draft.foodLog.push({
        id: crypto.randomUUID(),
        date: todayKey,
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

  const expiryWarnDays = state.settings?.expiryWarnDays ?? 3;
  const budgetWarnPct  = state.settings?.budgetWarnPct ?? 80;

  const expiring = state.inventory
    .filter((item) => daysUntil(item.expires) <= expiryWarnDays)
    .sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires))
    .slice(0, 4);

  // Sugerencia de cena para cerrar macros (activa 18:30-23:00 si quedan macros).
  const dinnerSug = getDinnerSuggestion(state);

  // Sugerencia por caducidad (motivo: algo caduca + faltan macros + entra en presupuesto).
  const expirySug = (() => {
    if (!expiring.length || pending.protein < 15) return null;
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

  // La sugerencia activa: cena tiene prioridad a su hora; si no, caducidad.
  const activeSuggestion = dinnerSug
    ? { kind: "dinner" as const, ...dinnerSug }
    : expirySug
      ? { kind: "expiry" as const, recipe: expirySug.recipe, usedItem: expirySug.usedItem! }
      : null;

  // Mensaje contextual de la mascota — incluye notificación de cierre de día (Feature 5).
  const mascotInsight = (() => {
    const hour = new Date().getHours();
    const urgent = expiring.find((item) => daysUntil(item.expires) <= 1);
    if (urgent) return `${urgent.name} caduca ${daysUntil(urgent.expires) < 0 ? "ya" : "mañana"}. ¿Lo usamos hoy?`;
    if (hour >= 20 && pending.kcal > 300) {
      const closer = allRecipes(state)
        .filter((r) => r.cost <= Math.max(budgetLeft, 1))
        .sort((a, b) => Math.abs(a.kcal - pending.kcal) - Math.abs(b.kcal - pending.kcal))[0];
      return closer
        ? `Son las ${hour}h y faltan ${Math.round(pending.kcal)} kcal. ${closer.title} encaja bien para cerrar el día.`
        : `Son las ${hour}h y todavía faltan ${Math.round(pending.kcal)} kcal. ¡Cierra el día!`;
    }
    if (pending.protein > 40) return `Te faltan ${Math.round(pending.protein)} g de proteína para cerrar el día.`;
    if (budgetLeft <= state.weeklyBudget * (1 - budgetWarnPct / 100) && state.weeklyBudget > 0)
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

      <div className={`bento-grid ${activeSuggestion ? "" : "no-suggest"}`}>
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
          <div className={`budget-track ${budgetPct >= budgetWarnPct ? "warn" : ""}`}>
            <i style={{ width: `${budgetPct}%` }} />
          </div>
        </article>

        {/* Accesos rapidos */}
        <article className="panel bento-actions">
          <button className="quick-action" onClick={() => goTo("inventory")}>
            <span>＋</span> Añadir alimento
          </button>
          <button className="quick-action" onClick={() => goTo("diary")}>
            <span>🍽</span> Registro
          </button>
          <button className="quick-action" onClick={() => goTo("cart")}>
            <span>🛒</span> Carrito
            {pendingCart.length > 0 && <b className="quick-badge">{pendingCart.length}</b>}
          </button>
          <button className="quick-action" onClick={() => goTo("recipes")}>
            <span>✦</span> Recetas
          </button>
          <button
            className="quick-action what-to-eat"
            onClick={() => setWhatToEatOpen((v) => !v)}
          >
            <span>🤔</span> ¿Qué como ahora?
          </button>
        </article>

        {/* Panel "¿Qué como ahora?" */}
        {whatToEatOpen && (
          <article className="panel bento-what-to-eat">
            <div className="panel-head">
              <h3>🤔 Mejor opción ahora mismo</h3>
              <button className="text-button" onClick={() => setWhatToEatOpen(false)}>Cerrar</button>
            </div>
            <p className="what-to-eat-context">
              Te quedan <strong>{Math.round(pending.kcal)} kcal</strong> y{" "}
              <strong>{Math.round(pending.protein)}g de proteína</strong>.{" "}
              Presupuesto: <strong>{eur(budgetLeft)}</strong>.
            </p>
            <div className="what-to-eat-list">
              {allRecipes(state)
                .map((r) => {
                  const match = getRecipeMatch(state, r);
                  const kcalFit = pending.kcal > 0 ? 1 - Math.abs(r.kcal - pending.kcal) / Math.max(pending.kcal, 1) : 0.5;
                  const score = match.pct * 0.5 + Math.max(0, kcalFit) * 30 + (r.cost <= budgetLeft ? 20 : 0);
                  return { r, match, score };
                })
                .filter((e) => e.r.cost <= Math.max(budgetLeft + 1, 2))
                .sort((a, b) => b.score - a.score)
                .slice(0, 4)
                .map(({ r, match }) => (
                  <div key={r.id} className="what-to-eat-card">
                    <div className="what-to-eat-info">
                      <strong>{r.title}</strong>
                      <small>{r.kcal} kcal · {r.protein}g prot · {eur(r.cost)} · {match.pct}% disponible</small>
                    </div>
                    <div className="what-to-eat-actions">
                      <button className="small-action" onClick={() => { openRecipe(r.id); setWhatToEatOpen(false); }}>
                        Ver
                      </button>
                      <button className="small-action good" onClick={() => { setCookingRecipe(r); setWhatToEatOpen(false); }}>
                        Cocinar
                      </button>
                    </div>
                  </div>
                ))}
              {allRecipes(state).length === 0 && (
                <p className="empty">Añade recetas para ver sugerencias.</p>
              )}
            </div>
          </article>
        )}

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

        {/* Sugerencia inteligente — cena para cerrar macros o receta con caducidad */}
        {activeSuggestion && (
          <article className={`panel bento-suggest ${activeSuggestion.kind === "dinner" ? "dinner" : ""}`}>
            {activeSuggestion.kind === "dinner" ? (
              <>
                <p className="eyebrow">🌙 Cena para cerrar macros</p>
                <h3>{activeSuggestion.recipe.title}</h3>
                <p className="suggest-why">
                  Te quedan <strong>{activeSuggestion.pendingKcal} kcal</strong> y{" "}
                  <strong>{activeSuggestion.pendingProtein} g de proteína</strong> — esta receta encaja bien para cenar.
                  {activeSuggestion.usedExpiringItem && (
                    <> Además usa <strong>{activeSuggestion.usedExpiringItem.name.toLowerCase()}</strong>, que caduca{" "}
                    {daysUntil(activeSuggestion.usedExpiringItem.expires) <= 0
                      ? "hoy"
                      : daysUntil(activeSuggestion.usedExpiringItem.expires) === 1
                        ? "mañana"
                        : `en ${daysUntil(activeSuggestion.usedExpiringItem.expires)} días`}.</>
                  )}
                </p>
              </>
            ) : (
              <>
                <p className="eyebrow">Sugerencia con motivo</p>
                <h3>{activeSuggestion.recipe.title}</h3>
                <p className="suggest-why">
                  Usa <strong>{activeSuggestion.usedItem.name.toLowerCase()}</strong> que caduca{" "}
                  {daysUntil(activeSuggestion.usedItem.expires) <= 0
                    ? "hoy"
                    : daysUntil(activeSuggestion.usedItem.expires) === 1
                      ? "mañana"
                      : `en ${daysUntil(activeSuggestion.usedItem.expires)} días`}
                  , aporta <strong>{activeSuggestion.recipe.protein} g de proteína</strong> y cuesta{" "}
                  {eur(activeSuggestion.recipe.cost)} — dentro de tu presupuesto.
                </p>
              </>
            )}
            <div className="card-actions">
              <button className="small-action" onClick={() => openRecipe(activeSuggestion.recipe.id)}>
                Ver receta
              </button>
              <button
                className="small-action good"
                onClick={() => setCookingRecipe(activeSuggestion.recipe)}
              >
                Cocinar
              </button>
            </div>
          </article>
        )}
      </div>

      {/* Plan de hoy */}
      <article className="panel today-plan-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">
              {new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })}
            </p>
            <h3>Tu plan de hoy</h3>
          </div>
          <button className="text-button" onClick={() => goTo("planner")}>
            {plannedCount === 0 ? "Planificar →" : "Editar →"}
          </button>
        </div>

        {plannedCount === 0 ? (
          <p className="today-plan-empty">
            No tienes nada planificado para hoy.{" "}
            <button className="link-button" onClick={() => goTo("planner")}>Ir al planificador</button>
          </p>
        ) : (
          <div className="today-plan-slots">
            {TODAY_SLOTS.map(({ key, label, icon, mealType }) => {
              const entryId = todayPlan[key];
              const entry = entryId ? findPlanEntry(state, entryId) : null;
              return (
                <div key={key} className={`today-plan-slot ${entry ? "filled" : "empty"}`}>
                  <div className="today-plan-slot-head">
                    <span className="today-plan-slot-icon">{icon}</span>
                    <span className="today-plan-slot-label">{label}</span>
                  </div>
                  {entry ? (
                    <>
                      <p className="today-plan-slot-name">{entry.title}</p>
                      <p className="today-plan-slot-meta">{entry.kcal} kcal · {Math.round(entry.protein)}g P</p>
                      <button
                        className="today-plan-slot-log"
                        onClick={() => logPlanEntry(entryId!, mealType)}
                        title="Registrar en el diario"
                      >
                        ✓ Registrar
                      </button>
                    </>
                  ) : (
                    <p className="today-plan-slot-empty">—</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </article>

      {consumeItem && <ConsumeModal item={consumeItem} onClose={() => setConsumeItem(null)} />}
      {cookingRecipe && <CookModal recipe={cookingRecipe} onClose={() => setCookingRecipe(null)} />}
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
