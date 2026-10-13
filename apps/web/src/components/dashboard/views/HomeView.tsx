"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { InventoryItem, MealPlanDay } from "@foodos/types";
import {
  actions,
  allRecipes,
  findPlanEntry,
  getBudgetLeft,
  getConsumedToday,
  getDinnerSuggestion,
  getFoodSpend,
  getLowStockSuggestions,
  getMascot,
  getPendingMacros,
  getRecipeMatch,
  getStepsToday,
  getTodayLog,
  getToday,
  getWaterToday,
  useFoodOS,
} from "@/lib/state";
import { GOAL_LABELS, isGymDay } from "@/lib/nutrition";
import { buildPlanLogEntry } from "@/lib/food-log-entries";
import { adherenceFreshnessNote, describeEvaluableFraction, useAdherenceWindow } from "@/lib/nutrition-history";
import { clampPct, dateFromKey, daysUntil, eur, namesMatch } from "@/lib/utils";
import { ConsumeModal } from "../ConsumeModal";
import { CookModal } from "../CookModal";
import type { ViewId } from "../DashboardShell";

const ADHERENCE_WINDOW_DAYS = 60; // cubre la racha — ver diseño §6

export function HomeView({
  goTo,
  openRecipe,
}: {
  goTo: (view: ViewId) => void;
  openRecipe: (id: string) => void;
}) {
  const { state, authUser, mutate, addWater, showToast, setMascotMessage, triggerMascot } = useFoodOS();
  const [consumeItem, setConsumeItem] = useState<InventoryItem | null>(null);
  const [cookingRecipe, setCookingRecipe] = useState<import("@foodos/types").Recipe | null>(null);
  const [whatToEatOpen, setWhatToEatOpen] = useState(false);
  const [stepsInput, setStepsInput] = useState("");

  const consumed = getConsumedToday(state);
  const pending = getPendingMacros(state);
  const budgetLeft = getBudgetLeft(state);
  const foodSpend = getFoodSpend(state);
  const budgetPct = clampPct(foodSpend, state.weeklyBudget);
  const kcalPct = clampPct(consumed.kcal, state.nutrition.kcal);
  const pendingCart = state.cart.filter((item) => !item.checked);
  const mascot = getMascot(state.mascotId);

  /* Agua */
  const waterMl = getWaterToday(state);
  const waterGoalMl = state.settings?.waterGoalMl ?? 2500;
  const waterPct = Math.min(100, Math.round((waterMl / waterGoalMl) * 100));

  /* Pasos (registro manual) */
  const stepsToday = getStepsToday(state);
  const stepsGoal = state.settings?.stepsGoal ?? 8000;
  const stepsPct = Math.min(100, Math.round((stepsToday / stepsGoal) * 100));

  /* Racha de adherencia — PR A: objetivo histórico real de cada fecha, no
     el de hoy aplicado retroactivamente (ver diseño). */
  const adherence = useAdherenceWindow(state, getToday(state), ADHERENCE_WINDOW_DAYS, authUser?.id ?? "local");
  const streak = adherence.streak;
  const adherenceLast7 = adherence.history.slice(-7);
  // PR A (revisión — P3): el denominador es el número REAL de días
  // evaluables (excluye unknown_target/unlogged) — nunca "/7" a ciegas.
  const adherenceLast7Evaluable = adherenceLast7.filter((d) => d.status !== "unknown_target" && d.status !== "unlogged");
  const hitThisWeek = adherenceLast7.filter((d) => d.status === "hit").length;
  const adherenceFreshness = adherenceFreshnessNote(adherence.remoteStatus);

  /* Stock bajo */
  const lowStock = getLowStockSuggestions(state).slice(0, 3);

  /* Celebrate cuando macros están cumplidos (≥80% kcal y proteína) */
  const macroCelebrated = useRef(false);
  useEffect(() => {
    const kcalOk = state.nutrition.kcal > 0 && consumed.kcal >= state.nutrition.kcal * 0.8 && consumed.kcal <= state.nutrition.kcal * 1.15;
    const protOk = state.nutrition.protein > 0 && consumed.protein >= state.nutrition.protein * 0.8;
    if (kcalOk && protOk && !macroCelebrated.current) {
      macroCelebrated.current = true;
      triggerMascot("celebrate", "¡Macros del día cumplidos! Gran trabajo.");
    } else if (!kcalOk || !protOk) {
      macroCelebrated.current = false;
    }
  }, [consumed.kcal, consumed.protein, state.nutrition.kcal, state.nutrition.protein, triggerMascot]);

  /* Plan de hoy */
  const todayKey = getToday(state);
  const todayDate = dateFromKey(todayKey);
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
      // PR3: ni la receta ni el plato rapido conservan de donde salen sus totales
      // -> legacy_unlabeled (food-log-entries.ts).
      draft.foodLog.push(buildPlanLogEntry({
        id: crypto.randomUUID(),
        date: todayKey,
        time: new Date().toTimeString().slice(0, 5),
        title: entry.title,
        macros: { kcal: entry.kcal, protein: entry.protein, carbs: entry.carbs, fat: entry.fat },
        mealType,
      }));
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
          recipe.ingredients.some((ing) => namesMatch(item.name, ing.name))
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

  /* ── Panel diario v2: lo REGISTRADO y lo PLANIFICADO siempre por separado ──
     El diario no guarda a qué entrada del plan corresponde cada registro
     (buildPlanLogEntry solo conserva el título), así que no se puede demostrar
     qué comida planificada ya está registrada. Por eso la barra de energía
     representa SOLO lo registrado y el plan se muestra aparte, sin sumarlo. */
  const todayLog = getTodayLog(state);
  const goalKcal = state.nutrition.kcal;
  const consumedKcal = Math.round(consumed.kcal);
  const overKcal = goalKcal > 0 ? Math.max(0, consumedKcal - goalKcal) : 0;
  // La escala crece con el exceso: la barra nunca oculta que se superó el objetivo.
  const barScale = Math.max(goalKcal, consumedKcal, 1);
  const barRegPct = Math.min(100, (consumedKcal / barScale) * 100);
  const goalTickPct = overKcal > 0 ? (goalKcal / barScale) * 100 : null;

  const plannedSlots = TODAY_SLOTS.flatMap((slot) => {
    const entryId = todayPlan[slot.key];
    const entry = entryId ? findPlanEntry(state, entryId) : null;
    return entry && entryId ? [{ ...slot, entryId, entry }] : [];
  });
  const plannedKcal = plannedSlots.reduce((sum, slot) => sum + slot.entry.kcal, 0);
  const loggedNames = new Set(todayLog.map((entry) => entry.name.trim().toLowerCase()));
  const MAX_LOGGED_SHOWN = 6;
  const shownLog = todayLog.length > MAX_LOGGED_SHOWN ? todayLog.slice(-MAX_LOGGED_SHOWN) : todayLog;
  const hiddenLogCount = todayLog.length - shownLog.length;
  const MEAL_ICON: Record<string, string> = { breakfast: "☀", lunch: "◉", dinner: "◑", snack: "◔" };

  const statusLine =
    todayLog.length === 0
      ? "Sin comidas registradas hoy. El total empieza en cuanto registres una."
      : `${todayLog.length} ${todayLog.length === 1 ? "comida registrada" : "comidas registradas"} hoy. El total solo incluye lo que has registrado.`;

  return (
    <section className="view home-v2">
      {!state.profile && (
        <button className="profile-banner" onClick={() => goTo("nutrition")}>
          <span>
            <strong>Configura tu perfil físico</strong> — FoodOS calculará tus calorías y macros
            diarios automáticamente (2 minutos).
          </span>
          <span className="banner-arrow">→</span>
        </button>
      )}

      {/* 1 · Banda del día: energía registrada, macros, hábitos y acciones */}
      <article className="hv-band" data-tour="panel-macros" aria-labelledby="hv-band-title">
        <div className="hv-band-top">
          <div>
            <p className="hv-eyebrow" id="hv-band-title">
              Hoy · {todayDate.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })}
            </p>
            <p className="hv-hero">
              <span className="hv-hero-num">{consumedKcal}</span>
              <span className="hv-hero-unit">
                kcal registradas{goalKcal > 0 ? ` de ${goalKcal}` : ""}
              </span>
            </p>
            <p className="hv-status">{statusLine}</p>
          </div>
          <div className="hv-chips">
            {state.profile && (
              <>
                <span className="hv-chip">{isGymDay(state.profile, todayDate) ? "💪 Gym" : "Descanso"}</span>
                <span className="hv-chip">{GOAL_LABELS[state.profile.goal]}</span>
              </>
            )}
            {streak >= 2 && (
              <span
                className="hv-chip"
                title={`${streak} días consecutivos cumpliendo objetivos${!adherence.historyComplete ? " (provisional, histórico incompleto)" : ""}`}
              >
                🔥 {streak}d{!adherence.historyComplete ? "…" : ""}
              </span>
            )}
          </div>
        </div>

        <div className="hv-meter">
          <div
            className="hv-meter-bar"
            role="img"
            aria-label={
              goalKcal > 0
                ? `${consumedKcal} kcal registradas de un objetivo de ${goalKcal}${overKcal > 0 ? `; ${overKcal} kcal por encima` : ""}`
                : `${consumedKcal} kcal registradas`
            }
          >
            <div className={`hv-meter-fill ${overKcal > 0 ? "over" : ""}`} style={{ width: `${barRegPct}%` }} />
            {goalTickPct !== null && <i className="hv-meter-goal" style={{ left: `${goalTickPct}%` }} aria-hidden="true" />}
          </div>
          <div className="hv-meter-legend">
            <span><i className="hv-key" /> Registrado <b>{consumedKcal} kcal</b></span>
            {goalKcal > 0 && <span>Objetivo <b>{goalKcal} kcal</b></span>}
            {overKcal > 0 ? (
              <span className="hv-over" role="status">+{overKcal} kcal sobre el objetivo</span>
            ) : (
              goalKcal > 0 && <span>Hasta el objetivo <b>{Math.round(pending.kcal)} kcal</b></span>
            )}
          </div>
          {plannedSlots.length > 0 && (
            <p className="hv-plan-note">
              En tu plan de hoy:{" "}
              <b>
                {plannedSlots.length} {plannedSlots.length === 1 ? "comida" : "comidas"} · {Math.round(plannedKcal)} kcal
              </b>
              . Va aparte: no cuenta como consumido hasta que la registras.
            </p>
          )}
        </div>

        <div className="hv-macros">
          <MacroTile label="Proteína" value={consumed.protein} max={state.nutrition.protein} />
          <MacroTile label="Carbohidratos" value={consumed.carbs} max={state.nutrition.carbs} />
          <MacroTile label="Grasas" value={consumed.fat} max={state.nutrition.fat} />
        </div>

        {/* Hábitos: agua y pasos, visibles al entrar y con su control a mano */}
        <div className="hv-habits">
          <section className="hv-hab" aria-labelledby="hv-water-title">
            <div className="hv-hab-top">
              <span id="hv-water-title">💧 Agua</span>
              <span className="hv-hab-val">
                {waterMl >= 1000 ? `${(waterMl / 1000).toFixed(1).replace(".", ",")} L` : `${waterMl} ml`}
                <small> / {waterGoalMl >= 1000 ? `${waterGoalMl / 1000} L` : `${waterGoalMl} ml`}</small>
              </span>
            </div>
            <div
              className="hv-hab-bar"
              role="progressbar"
              aria-label="Agua de hoy"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={waterPct}
            >
              <i className="water" style={{ width: `${waterPct}%` }} />
            </div>
            <div className="hv-hab-ctl">
              {[250, 500, 750].map((ml) => (
                <button key={ml} className="hv-hchip" onClick={() => addWater(ml)} aria-label={`Añadir ${ml} ml de agua`}>
                  +{ml}<span className="hv-hunit"> ml</span>
                </button>
              ))}
              {waterMl > 0 && (
                <button className="hv-hchip dim" onClick={() => addWater(-250)} aria-label="Quitar 250 ml de agua">
                  −250<span className="hv-hunit"> ml</span>
                </button>
              )}
            </div>
          </section>

          <section className="hv-hab" aria-labelledby="hv-steps-title">
            <div className="hv-hab-top">
              <span id="hv-steps-title">👟 Pasos</span>
              <span className="hv-hab-val">
                {stepsToday.toLocaleString("es-ES")}
                <small> / {stepsGoal.toLocaleString("es-ES")}</small>
              </span>
            </div>
            <div
              className="hv-hab-bar"
              role="progressbar"
              aria-label="Pasos de hoy"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={stepsPct}
            >
              <i style={{ width: `${stepsPct}%` }} />
            </div>
            <div className="hv-hab-ctl">
              <input
                type="number"
                min="0"
                className="hv-steps-input"
                placeholder="Pasos de hoy"
                aria-label="Pasos de hoy"
                value={stepsInput}
                onChange={(e) => setStepsInput(e.target.value)}
              />
              <button
                className="hv-hchip strong"
                onClick={() => {
                  const steps = parseInt(stepsInput, 10);
                  if (!Number.isFinite(steps) || steps < 0) return;
                  mutate((draft) => actions.logSteps(draft, steps));
                  setStepsInput("");
                }}
              >
                Guardar
              </button>
            </div>
          </section>
        </div>

        {/* Acciones frecuentes */}
        <div className="hv-actions" aria-label="Acciones frecuentes">
          <button className="hv-act primary" onClick={() => goTo("diary")}>
            <span aria-hidden="true">🍽</span> Registrar comida
          </button>
          <button className="hv-act" onClick={() => goTo("inventory")}>
            <span aria-hidden="true">＋</span> Añadir alimento
          </button>
          <button className="hv-act" onClick={() => goTo("cart")}>
            <span aria-hidden="true">🛒</span> Carrito
            {pendingCart.length > 0 && <b className="hv-act-n">{pendingCart.length}</b>}
          </button>
          <button className="hv-act" onClick={() => goTo("recipes")}>
            <span aria-hidden="true">✦</span> Recetas
          </button>
          <button
            className="hv-act"
            onClick={() => setWhatToEatOpen((v) => !v)}
            aria-expanded={whatToEatOpen}
          >
            <span aria-hidden="true">🤔</span> ¿Qué como ahora?
          </button>
        </div>
      </article>

      {/* Panel "¿Qué como ahora?" (sin cambios de contenido) */}
      {whatToEatOpen && (
        <article className="panel bento-what-to-eat hv-block">
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

      {/* Sugerencia inteligente — cena para cerrar macros o receta con caducidad */}
      {activeSuggestion && (
        <article className={`panel bento-suggest hv-block ${activeSuggestion.kind === "dinner" ? "dinner" : ""}`}>
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

      {/* 2 · Plan del día en línea temporal + Inventario */}
      <div className="hv-cols">
        <article className="hv-card today-plan-panel">
          <div className="hv-card-head">
            <div>
              <p className="hv-eyebrow">
                {todayDate.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })}
              </p>
              <h3>Tu plan de hoy</h3>
            </div>
            <div className="hv-head-right">
              {state.profile && (() => {
                // PR A (revisión — P3): denominador = días realmente
                // evaluables esa semana (excluye unknown_target/unlogged) —
                // con cero evaluables no hay fracción que mostrar en absoluto,
                // nunca un "0/7" que se leería como fracaso.
                const weekFraction = describeEvaluableFraction(hitThisWeek, adherenceLast7Evaluable.length);
                return (
                  <span
                    className="hv-chip soft"
                    title={`Días esta semana con objetivos de macros cumplidos${adherenceFreshness ? ` — ${adherenceFreshness}` : ""}`}
                  >
                    {weekFraction.hasEvaluableDays ? `${weekFraction.label} días ✓` : "Sin días evaluables"}
                    {!adherence.historyComplete ? "…" : ""}
                  </span>
                );
              })()}
              <button className="hv-link" onClick={() => goTo("planner")}>
                {plannedCount === 0 ? "Planificar →" : "Editar →"}
              </button>
            </div>
          </div>

          {/* PR A (revisión — P2): antes solo iba en el `title` del badge —
              invisible en móvil, donde no hay hover. Nota visible, distinta
              para loading/error (`adherenceFreshnessNote`, compartida con
              NutritionView/StatsView) — "ready" no renderiza nada. */}
          {adherenceFreshness && (
            <p
              className="chart-legend"
              role={adherence.remoteStatus === "error" ? "alert" : "status"}
            >
              {adherenceFreshness}
            </p>
          )}

          {todayLog.length === 0 && plannedSlots.length === 0 ? (
            <p className="today-plan-empty">
              {plannedCount === 0
                ? <>Todavía no hay nada registrado ni planificado para hoy.{" "}
                    <button className="link-button" onClick={() => goTo("planner")}>Ir al planificador</button></>
                : <>Tienes comidas en el plan de hoy que ya no existen. <button className="link-button" onClick={() => goTo("planner")}>Revisar el plan</button></>}
            </p>
          ) : (
            <ol className="hv-line">
              {hiddenLogCount > 0 && (
                <li className="hv-step more">
                  <span className="hv-node" aria-hidden="true">…</span>
                  <div>
                    <button className="hv-link" onClick={() => goTo("diary")}>
                      {hiddenLogCount} {hiddenLogCount === 1 ? "registro anterior" : "registros anteriores"} en el registro →
                    </button>
                  </div>
                </li>
              )}
              {shownLog.map((entry) => (
                <li key={entry.id} className="hv-step reg">
                  <span className="hv-node" aria-hidden="true">✓</span>
                  <div>
                    <div className="hv-step-time">{entry.time}</div>
                    <div className="hv-step-name">{entry.name}</div>
                    <div className="hv-step-meta">
                      <span className="hv-tag reg">Registrado</span>
                      {Math.round(entry.kcal)} kcal · {Math.round(entry.protein)} g P
                    </div>
                  </div>
                </li>
              ))}
              {plannedSlots.map(({ key, label, icon, mealType, entryId, entry }) => {
                const maybeLogged = loggedNames.has(entry.title.trim().toLowerCase());
                return (
                  <li key={key} className="hv-step plan">
                    <span className="hv-node" aria-hidden="true">{icon}</span>
                    <div>
                      <div className="hv-step-time">{label}</div>
                      <div className="hv-step-name">{entry.title}</div>
                      <div className="hv-step-meta">
                        <span className="hv-tag plan">Planificado</span>
                        {entry.kcal} kcal · {Math.round(entry.protein)} g P
                      </div>
                      {maybeLogged && (
                        <div className="hv-step-warn" role="note">
                          Ya hay un registro con este nombre hoy: comprueba antes de registrarlo otra vez.
                        </div>
                      )}
                    </div>
                    <button
                      className="hv-btn"
                      onClick={() => logPlanEntry(entryId, mealType)}
                      title="Registrar en el diario"
                    >
                      {maybeLogged ? "Registrar otra vez" : "✓ Registrar"}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {plannedSlots.length > 0 && (
            <p className="hv-foot">Lo planificado no cuenta como consumido hasta que lo registras.</p>
          )}
        </article>

        {/* Inventario: caducidades y stock bajo */}
        <article className="hv-card hv-watch">
          <div className="hv-card-head">
            <div>
              <p className="hv-eyebrow">Inventario</p>
              <h3>🥕 Para vigilar</h3>
            </div>
            <button className="hv-link" onClick={() => goTo("inventory")}>
              Inventario →
            </button>
          </div>
          {expiring.length ? (
            <div className="hv-group">
              <p className="hv-group-title">Caduca pronto</p>
              <ul className="hv-att">
                {expiring.map((item) => {
                  const days = daysUntil(item.expires);
                  return (
                    <li key={item.id}>
                      <span className={`hv-bar ${days <= 1 ? "bad" : ""}`} aria-hidden="true" />
                      <span className="hv-att-main">
                        <strong>{item.name}</strong>
                        <small>{days < 0 ? "caducado" : days === 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} días`}</small>
                      </span>
                      <button className="hv-btn ghost" onClick={() => setConsumeItem(item)}>
                        Usar
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : state.inventory.length === 0 ? (
            // E05-09: "Nada en riesgo" sugería que ya estaba todo revisado y en
            // orden — con el inventario vacío, lo real es que todavía no hay
            // nada que vigilar, no que esté "todo bien".
            <p className="hv-empty">
              Tu inventario está vacío.{" "}
              <button className="link-button" onClick={() => goTo("inventory")}>
                Añade tus primeros alimentos
              </button>
              {" "}para que FoodOS vigile caducidades.
            </p>
          ) : (
            <p className="hv-empty">Nada en riesgo ✓</p>
          )}

          {lowStock.length > 0 && (
            <div className="hv-group">
              <p className="hv-group-title">Stock bajo</p>
              <ul className="hv-att">
                {lowStock.map((item) => (
                  <li key={item.id}>
                    <span className="hv-bar info" aria-hidden="true" />
                    <span className="hv-att-main">
                      <strong>{item.name}</strong>
                      <small>quedan pocas unidades</small>
                    </span>
                    <button
                      className="hv-btn ghost"
                      onClick={() => {
                        mutate(draft => { draft.cart.push({ ...item, id: crypto.randomUUID() }); });
                        showToast(`${item.name} añadido al carrito`);
                      }}
                    >
                      + Carrito
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      </div>

      {/* 3 · Presupuesto semanal en franja inferior */}
      <article className="hv-card hv-budget">
        <div>
          <p className="hv-eyebrow">Presupuesto semanal</p>
          <p className="hv-budget-fig">
            <strong>{eur(budgetLeft)}</strong>
            <span>disponibles de {eur(state.weeklyBudget)}</span>
          </p>
        </div>
        <div className="hv-budget-mid">
          <div
            className={`hv-budget-bar ${budgetPct >= budgetWarnPct ? "warn" : ""}`}
            role="img"
            aria-label={`${budgetPct} % del presupuesto semanal gastado`}
          >
            <i style={{ width: `${budgetPct}%` }} />
          </div>
          <small>Gastados {eur(foodSpend)} de {eur(state.weeklyBudget)} esta semana</small>
        </div>
        <button className="hv-link" onClick={() => goTo("finance")}>
          Finanzas →
        </button>
        {state.weeklyBudget > 0 && budgetPct >= budgetWarnPct && (
          <p className={`budget-alert hv-budget-alert ${budgetPct < 100 ? "warn" : ""}`} role="status">
            {budgetPct >= 100
              ? <>⚠ Presupuesto semanal agotado ({eur(foodSpend)} de {eur(state.weeklyBudget)}).</>
              : <>⚠ Llevas {eur(foodSpend)} de {eur(state.weeklyBudget)} ({budgetPct}%) y aún es {dateFromKey(getToday(state)).toLocaleDateString("es-ES", { weekday: "long" })}.</>}
            {" "}
            <button className="text-button" onClick={() => goTo("recipes")}>
              Ver recetas económicas
            </button>
          </p>
        )}
      </article>

      {/* 4 · Zana acompaña con el mensaje contextual real */}
      <div className="hv-pet">
        <Image className="hv-pet-img" src={mascot.image} alt={mascot.name} width={120} height={134} />
        <p className="hv-bubble">
          <strong>{mascot.name}</strong> {mascotInsight}
        </p>
      </div>

      {consumeItem && <ConsumeModal item={consumeItem} onClose={() => setConsumeItem(null)} />}
      {cookingRecipe && <CookModal recipe={cookingRecipe} onClose={() => setCookingRecipe(null)} />}
    </section>
  );
}

function MacroTile({ label, value, max }: { label: string; value: number; max: number }) {
  const over = max > 0 ? Math.round(value) - Math.round(max) : 0;
  return (
    <div className="hv-mac">
      <span>{label}</span>
      <b>
        {Math.round(value)}
        <small> / {Math.round(max)} g</small>
      </b>
      <i aria-hidden="true">
        <em style={{ width: `${clampPct(value, max)}%` }} />
      </i>
      {over > 0 && <span className="hv-mac-over">+{over} g sobre el objetivo</span>}
    </div>
  );
}
