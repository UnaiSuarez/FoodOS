"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MealPlanDay, MealType, QuickMeal, Recipe } from "@foodos/types";
import { allRecipes, getMealPlanShoppingList, getToday, pruneOrphanedQuickMeals, useFoodOS } from "@/lib/state";
import { CookModal } from "../CookModal";
import { PlannerAddMealModal } from "../PlannerAddMealModal";
import { PlannerPickMealModal } from "../PlannerPickMealModal";
import { PlannerPlaceModal } from "../PlannerPlaceModal";
import { loadAIConfig } from "@/lib/ai-config";
import { generateAIWeeklyPlan } from "@/lib/ai-provider";
import { buildPlanLogEntry } from "@/lib/food-log-entries";
import { dateFromKey, dateKeyFromDate, eur } from "@/lib/utils";

type MealSlot = keyof MealPlanDay;

const MEAL_SLOTS: { key: MealSlot; label: string; icon: string; mealType: MealType }[] = [
  { key: "breakfast", label: "Desayuno", icon: "☀", mealType: "breakfast" },
  { key: "almuerzo",  label: "Almuerzo", icon: "◔", mealType: "snack"     },
  { key: "lunch",     label: "Comida",   icon: "◉", mealType: "lunch"     },
  { key: "merienda",  label: "Merienda", icon: "◕", mealType: "snack"     },
  { key: "dinner",    label: "Cena",     icon: "◑", mealType: "dinner"    },
];

const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

/** Ancho útil mínimo (px) DEL PROPIO PLANIFICADOR para mostrar la semana: etiqueta de franja +
    siete columnas de ≥132 px con nombres legibles y botones de 44 px. Por debajo, vista por día.
    Se mide el contenedor, no el viewport: con la barra lateral abierta caben menos columnas. */
export const WEEK_MIN_WIDTH = 1040;

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

type Dialog =
  | { kind: "pick"; dateKey: string; slot: MealSlot }
  | { kind: "quick"; dateKey: string; slot: MealSlot }
  | { kind: "place"; recipeId: string }
  | { kind: "cook"; recipe: Recipe; dateKey: string; slot: MealSlot; mealType: MealType };

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

const toKey = (d: Date): string => dateKeyFromDate(d);
const fmtDay = (d: Date) => d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
const fmtLong = (d: Date) => d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
const fmtWeekday = (d: Date) => d.toLocaleDateString("es-ES", { weekday: "long" });

/** «semana» si el contenedor mide ≥ WEEK_MIN_WIDTH; «día» si no (también sin medida). */
function useLayoutMode(ref: React.RefObject<HTMLElement | null>): "week" | "day" {
  const [mode, setMode] = useState<"week" | "day">("day");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setMode(el.clientWidth >= WEEK_MIN_WIDTH ? "week" : "day");
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return mode;
}

export function PlannerView() {
  const { state, mutate, showToast } = useFoodOS();
  const recipes = allRecipes(state);
  const quickMeals: QuickMeal[] = state.plannerQuickMeals ?? [];
  const plan = state.mealPlan ?? {};
  const today = getToday(state);
  const todayDate = () => new Date(`${today}T12:00:00`);

  const rootRef = useRef<HTMLDivElement>(null);
  const layout = useLayoutMode(rootRef);

  const [weekStart, setWeekStart] = useState(() => getMondayOfWeek(todayDate()));
  // Posición (0 = lunes) del día mostrado en la vista por día. Efímera: no se guarda en datos del usuario.
  const [dayIdx, setDayIdx] = useState(() => (todayDate().getDay() + 6) % 7);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Destino lógico del foco tras cerrar un diálogo o tras quitar: sobrevive a un cambio de distribución.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [search, setSearch] = useState("");
  const draggingId = useRef<string | null>(null);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Devuelve el foco a un control visible del hueco correcto (o a la cabecera si ya no existe).
  useEffect(() => {
    if (!focusKey || dialog) return;
    const root = rootRef.current;
    const target = root?.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`) ?? root?.querySelector<HTMLElement>("[data-focus-fallback]");
    target?.focus();
    setFocusKey(null);
  }, [focusKey, dialog, layout, weekStart, dayIdx]);

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
      pruneOrphanedQuickMeals(draft);
    });
  }

  const slotLabel = (slot: MealSlot) => MEAL_SLOTS.find((s) => s.key === slot)!.label;
  const dateOf = (dateKey: string) => dateFromKey(dateKey);
  const holeName = (dateKey: string, slot: MealSlot) => `${slotLabel(slot)} del ${fmtWeekday(dateOf(dateKey))} ${dateOf(dateKey).getDate()}`;
  const editKey = (dateKey: string, slot: MealSlot) => `${dateKey}:${slot}:edit`;

  function closeDialog(returnKey: string | null) {
    setDialog(null);
    setFocusKey(returnKey);
  }

  /** «Cocinar y registrar»: receta → CookModal (descuento opcional). Plato rápido → registro directo. */
  function logEntry(dateKey: string, slot: MealSlot, mealType: MealType, entry: PlanEntry) {
    if (!entry.isQuick) {
      const recipe = recipes.find((r) => r.id === entry.id);
      if (recipe) { setDialog({ kind: "cook", recipe, dateKey, slot, mealType }); return; }
    }
    mutate((draft) => {
      // PR3: un plato rapido no conserva de donde salen sus totales -> legacy_unlabeled.
      draft.foodLog.push(buildPlanLogEntry({
        id: crypto.randomUUID(),
        date: dateKey,
        time: new Date().toTimeString().slice(0, 5),
        title: entry.title,
        macros: { kcal: entry.kcal, protein: entry.protein, carbs: entry.carbs, fat: entry.fat },
        mealType,
      }));
    });
    showToast(`"${entry.title}" registrado`);
  }

  function removeEntry(dateKey: string, slot: MealSlot, entry: PlanEntry) {
    setMeal(dateKey, slot, null);
    showToast(`${entry.title} quitado del plan (${holeName(dateKey, slot)})`);
    setFocusKey(editKey(dateKey, slot)); // el «Añadir» del mismo hueco
  }

  async function handleAIPlan() {
    const config = loadAIConfig();
    if (!config) {
      showToast("Configura tu IA primero (botón IA en la barra superior)");
      return;
    }
    if (recipes.length === 0) {
      showToast("Añade recetas antes de generar un plan");
      return;
    }
    setAiLoading(true);
    try {
      const dateKeys = days.map(toKey);
      const weekPlan = await generateAIWeeklyPlan(config, state, recipes, dateKeys);
      mutate((draft) => {
        draft.mealPlan ||= {};
        for (const [dateKey, slots] of Object.entries(weekPlan)) {
          draft.mealPlan[dateKey] ||= {};
          for (const [slot, id] of Object.entries(slots)) {
            if (id) (draft.mealPlan[dateKey] as Record<string, string>)[slot] = id;
          }
        }
        pruneOrphanedQuickMeals(draft);
      });
      const filled = Object.values(weekPlan).reduce(
        (n, day) => n + Object.values(day).filter(Boolean).length, 0
      );
      showToast(`Plan IA generado: ${filled} comidas planificadas`);
    } catch (err) {
      showToast(`Error al generar plan: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAiLoading(false);
    }
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

  /* Arrastre: atajo opcional con ratón en la vista semanal; ninguna tarea depende de él. */
  function handleDrop(e: React.DragEvent, dateKey: string, slot: MealSlot) {
    e.currentTarget.classList.remove("drag-over");
    const id = e.dataTransfer.getData("recipeId") || draggingId.current;
    if (id) { setMeal(dateKey, slot, id); setFocusKey(editKey(dateKey, slot)); }
  }

  /* Totales PLANIFICADOS (no ingesta registrada). El objetivo solo se muestra si existe el
     registrado para ESA fecha en nutritionGoalsHistory; nunca se copia el de hoy a otros días. */
  type DayTotal = { kcal: number; prot: number; carbs: number; fat: number; cost: number; count: number; goalKcal?: number; goalProt?: number };
  const dayTotals: DayTotal[] = days.map((d) => {
    const key = toKey(d);
    const day = plan[key];
    let kcal = 0, prot = 0, carbs = 0, fat = 0, cost = 0, count = 0;
    if (day) {
      MEAL_SLOTS.forEach(({ key: sk }) => {
        const e = day[sk] ? findEntry(day[sk]!) : null;
        if (e) { kcal += e.kcal; prot += e.protein; carbs += e.carbs; fat += e.fat; cost += e.cost; count++; }
      });
    }
    const goal = state.nutritionGoalsHistory?.[key];
    return { kcal, prot, carbs, fat, cost, count, goalKcal: goal?.kcal, goalProt: goal?.protein };
  });

  const weekKcal = dayTotals.reduce((s, d) => s + d.kcal, 0);
  const weekProt = dayTotals.reduce((s, d) => s + d.prot, 0);
  const weekCost = dayTotals.reduce((s, d) => s + d.cost, 0);
  const weekCount = dayTotals.reduce((s, d) => s + d.count, 0);

  const filteredRecipes = search.trim()
    ? recipes.filter((r) => r.title.toLowerCase().includes(search.trim().toLowerCase()))
    : recipes;

  const todayKey = today;

  /** Una franja de un día: tarjeta con nombre completo y tres acciones hermanas (o «Añadir»). */
  function renderSlot(d: Date, slotDef: (typeof MEAL_SLOTS)[number], variant: "cell" | "card") {
    const dateKey = toKey(d);
    const rid = plan[dateKey]?.[slotDef.key];
    const entry = rid ? findEntry(rid) : null;
    const hole = holeName(dateKey, slotDef.key);
    const isRecipe = !!entry && !entry.isQuick && recipes.some((r) => r.id === entry.id);

    if (!entry) {
      return (
        <div className={`pl-slot pl-slot-empty pl-${variant}`}>
          {variant === "card" && <p className="pl-empty-hint">Sin planificar. Puedes dejarlo vacío.</p>}
          <button
            type="button"
            className="pl-btn pl-add"
            data-focus-key={editKey(dateKey, slotDef.key)}
            aria-label={`Añadir comida: ${hole}`}
            onClick={() => setDialog({ kind: "pick", dateKey, slot: slotDef.key })}
          >
            ＋ Añadir
          </button>
        </div>
      );
    }

    return (
      <div className={`pl-slot pl-slot-full pl-${variant}`}>
        <span className={`pl-tag ${isRecipe ? "recipe" : "quick"}`}>{isRecipe ? "Receta" : "Plato rápido"}</span>
        <div className="pl-entry">
          {entry.image && variant === "card" && (
            <Image src={entry.image} alt="" width={44} height={34} className="pl-thumb" />
          )}
          <div>
            <p className="pl-name">{entry.title}</p>
            <p className="pl-meta">{entry.kcal} kcal · {Math.round(entry.protein)} g P</p>
          </div>
        </div>
        <div className="pl-actions">
          <button
            type="button"
            className="pl-btn pl-btn-primary pl-log"
            data-focus-key={`${dateKey}:${slotDef.key}:main`}
            aria-label={isRecipe
              ? `Cocinar y registrar ${entry.title}, ${hole}: abre el diálogo de cocinar y registrar; allí eliges si se descuentan ingredientes del inventario`
              : `Registrar ${entry.title} en el diario, ${hole}`}
            onClick={() => logEntry(dateKey, slotDef.key, slotDef.mealType, entry)}
          >
            {isRecipe ? "Cocinar y registrar" : "Registrar"}
          </button>
          <button
            type="button"
            className="pl-btn pl-change"
            data-focus-key={editKey(dateKey, slotDef.key)}
            aria-label={`Cambiar ${entry.title} en ${hole}`}
            onClick={() => setDialog({ kind: "pick", dateKey, slot: slotDef.key })}
          >
            Cambiar
          </button>
          <button
            type="button"
            className="pl-btn pl-btn-quiet pl-remove"
            aria-label={`Quitar ${entry.title} del plan, ${hole}`}
            onClick={() => removeEntry(dateKey, slotDef.key, entry)}
          >
            Quitar
          </button>
        </div>
      </div>
    );
  }

  function renderTotal(i: number, withLabel: boolean) {
    const t = dayTotals[i];
    if (t.count === 0) return <span className="pl-total-none">{withLabel ? "Total planificado: sin comidas planificadas" : "—"}</span>;
    return (
      <>
        {withLabel && <strong className="pl-total-title">Total planificado: </strong>}
        <span className="pl-total-kcal"><b>{Math.round(t.kcal)}</b>{t.goalKcal ? ` de ${t.goalKcal}` : ""} kcal</span>
        <span className="pl-total-prot"><b>{Math.round(t.prot)}</b>{t.goalProt ? ` de ${t.goalProt}` : ""} g de proteína</span>
        <span className="pl-total-macros">G {Math.round(t.fat)} g · HC {Math.round(t.carbs)} g</span>
      </>
    );
  }

  const sel = days[dayIdx];
  const selCount = dayTotals[dayIdx].count;

  return (
    <section className="view">
      <div className="pl-root" ref={rootRef} data-layout={layout} data-tour="planner-grid">
        <div className="panel pl-panel">
          <p className="eyebrow">Planificador semanal</p>
          <h2 tabIndex={-1} data-focus-fallback>¿Qué vas a comer esta semana?</h2>

          {/* Semana ≠ día ≠ acciones */}
          <div className="pl-bar">
            <div className="pl-week-nav" role="group" aria-label="Cambiar de semana">
              <span className="pl-week-range" aria-live="polite">{fmtDay(days[0])} – {fmtDay(days[6])}</span>
              <button type="button" className="pl-btn" aria-label="Semana anterior" onClick={() => setWeekStart(addDays(weekStart, -7))}>← Anterior</button>
              <button type="button" className="pl-btn" aria-label="Semana siguiente" onClick={() => setWeekStart(addDays(weekStart, 7))}>Siguiente →</button>
              <button
                type="button"
                className="pl-btn"
                onClick={() => { setWeekStart(getMondayOfWeek(todayDate())); setDayIdx((todayDate().getDay() + 6) % 7); }}
              >
                Hoy
              </button>
            </div>
            <div className="pl-bar-actions" role="group" aria-label="Acciones de la semana">
              <button
                type="button"
                className="pl-btn planner-ai-btn"
                onClick={handleAIPlan}
                disabled={aiLoading}
                title="La IA genera un plan semanal equilibrado usando tus recetas y macros objetivo"
              >
                {aiLoading ? "Generando…" : "✨ Plan IA"}
              </button>
              <button type="button" className="pl-btn" onClick={handleBuyWeek} title="Generar lista de la compra desde las recetas de esta semana">
                🛒 Comprar semana
              </button>
            </div>
          </div>

          <div className="pl-chips">
            <span className="pl-chip"><b>{Math.round(weekKcal)}</b> kcal planificadas</span>
            <span className="pl-chip"><b>{Math.round(weekProt)} g</b> de proteína planificada</span>
            <span className="pl-chip"><b>{eur(weekCost)}</b> de coste planificado</span>
            <span className="pl-chip">{weekCount} comidas planificadas</span>
          </div>
          <p className="pl-legend">
            <strong>Cocinar y registrar</strong> (recetas) abre el diálogo donde eliges si se descuentan ingredientes del
            inventario. <strong>Registrar</strong> (platos rápidos) lo anota directamente en el diario. Planificar no
            registra nada por sí solo.
          </p>
          {weekCount === 0 && (
            <p className="pl-empty-note">
              <strong>Esta semana no tiene comidas planificadas.</strong> Pulsa «Añadir» en cualquier hueco o usa «Plan IA».
              Un hueco vacío no es una comida obligatoria.
            </p>
          )}

          {layout === "week" ? (
            /* Vista semanal: solo existe en el DOM cuando el ancho útil basta */
            <div className="pl-week" role="group" aria-label="Semana completa">
              <div className="pl-corner" />
              {days.map((d, i) => (
                <div
                  key={`h${i}`}
                  className={`pl-head ${toKey(d) === todayKey ? "today" : ""}`}
                  aria-current={toKey(d) === todayKey ? "date" : undefined}
                >
                  <span className="pl-head-name">{DAY_NAMES[i]}</span>
                  <span className="pl-head-date">{fmtDay(d)}</span>
                  {toKey(d) === todayKey && <span className="pl-head-today">Hoy</span>}
                </div>
              ))}
              {MEAL_SLOTS.map((slotDef) => (
                <WeekRow key={slotDef.key} label={slotDef.label} snack={slotDef.mealType === "snack"}>
                  {days.map((d) => (
                    <div
                      key={toKey(d)}
                      className={`pl-cellwrap ${toKey(d) === todayKey ? "today" : ""}`}
                      role="group"
                      aria-label={holeName(toKey(d), slotDef.key)}
                      onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("drag-over"); }}
                      onDragLeave={(e) => e.currentTarget.classList.remove("drag-over")}
                      onDrop={(e) => handleDrop(e, toKey(d), slotDef.key)}
                    >
                      {renderSlot(d, slotDef, "cell")}
                    </div>
                  ))}
                </WeekRow>
              ))}
              <div className="pl-rowlabel">Total planificado</div>
              {days.map((d, i) => <div key={`t${i}`} className="pl-total">{renderTotal(i, false)}</div>)}
            </div>
          ) : (
            /* Vista por día: selector + las cinco franjas */
            <div className="pl-dayview">
              <div className="pl-day-strip" role="group" aria-label="Elegir día de la semana">
                {days.map((d, i) => (
                  <button
                    key={toKey(d)}
                    type="button"
                    className={`pl-day-btn ${toKey(d) === todayKey ? "today" : ""}`}
                    aria-pressed={i === dayIdx}
                    aria-current={toKey(d) === todayKey ? "date" : undefined}
                    aria-label={`${fmtLong(d)}${toKey(d) === todayKey ? ", hoy" : ""}`}
                    onClick={() => setDayIdx(i)}
                  >
                    <span className="pl-day-btn-name">{DAY_NAMES[i]}</span>
                    <span className="pl-day-btn-num">{d.getDate()}</span>
                    <span className="pl-day-btn-today">{toKey(d) === todayKey ? "HOY" : ""}</span>
                  </button>
                ))}
              </div>
              <h3 className="pl-day-heading">
                {fmtLong(sel)}
                {toKey(sel) === todayKey && <span className="pl-today-pill">Hoy</span>}
              </h3>
              <p className="sr-only" role="status">{`${fmtLong(sel)}: ${selCount} de 5 franjas con comida planificada`}</p>
              <ul className="pl-slot-list">
                {MEAL_SLOTS.map((slotDef) => (
                  <li key={slotDef.key} className="pl-slot-item">
                    <h4>{slotDef.label}{slotDef.mealType === "snack" ? " · se registra como Snack" : ""}</h4>
                    {renderSlot(sel, slotDef, "card")}
                  </li>
                ))}
              </ul>
              <p className="pl-day-total">{renderTotal(dayIdx, true)}</p>
            </div>
          )}

          {/* Biblioteca de recetas: buscar y colocar sin arrastrar */}
          <section className="pl-library" aria-labelledby="pl-lib-title">
            <div className="pl-library-head">
              <h3 id="pl-lib-title">Recetas</h3>
              <input
                className="pl-search"
                type="search"
                placeholder="Buscar…"
                aria-label="Buscar recetas"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <ul className="pl-rec-list">
              {filteredRecipes.map((recipe) => (
                <li
                  key={recipe.id}
                  className="pl-rec"
                  draggable={layout === "week"}
                  onDragStart={(e) => { e.dataTransfer.setData("recipeId", recipe.id); draggingId.current = recipe.id; }}
                  onDragEnd={() => { draggingId.current = null; }}
                >
                  <Image src={recipe.image} alt="" width={44} height={34} className="pl-thumb" />
                  <div className="pl-rec-info">
                    <p className="pl-name">{recipe.title}</p>
                    <p className="pl-meta">{recipe.kcal} kcal · {eur(recipe.cost)} · {recipe.time} min</p>
                  </div>
                  <button
                    type="button"
                    className="pl-btn"
                    data-focus-key={`lib:${recipe.id}`}
                    aria-label={`Colocar ${recipe.title} en el plan: eliges día y franja`}
                    onClick={() => setDialog({ kind: "place", recipeId: recipe.id })}
                  >
                    Colocar…
                  </button>
                </li>
              ))}
            </ul>
            {filteredRecipes.length === 0 && <p className="pl-empty">Sin resultados.</p>}
          </section>
        </div>
      </div>

      {dialog?.kind === "cook" && (
        <CookModal
          recipe={dialog.recipe}
          logDate={dialog.dateKey}
          mealType={dialog.mealType}
          onClose={() => closeDialog(`${dialog.dateKey}:${dialog.slot}:main`)}
        />
      )}

      {dialog?.kind === "pick" && (() => {
        const { dateKey, slot } = dialog;
        const cur = plan[dateKey]?.[slot] ? findEntry(plan[dateKey]![slot]!) : null;
        return (
          <PlannerPickMealModal
            title={`${cur ? "Cambiar" : "Añadir"}: ${slotLabel(slot)} · ${fmtLong(dateOf(dateKey))}`}
            recipes={recipes}
            replacingName={cur?.title}
            onPick={(id) => {
              setMeal(dateKey, slot, id);
              const r = recipes.find((x) => x.id === id);
              showToast(`${r?.title ?? "Receta"} ${cur ? "sustituye a " + cur.title : "añadida"} en ${holeName(dateKey, slot)}`);
              closeDialog(editKey(dateKey, slot));
            }}
            onNewQuick={() => setDialog({ kind: "quick", dateKey, slot })}
            onClose={() => closeDialog(editKey(dateKey, slot))}
          />
        );
      })()}

      {dialog?.kind === "quick" && (
        <PlannerAddMealModal
          dateKey={dialog.dateKey}
          slot={dialog.slot}
          onClose={() => closeDialog(editKey(dialog.dateKey, dialog.slot))}
        />
      )}

      {dialog?.kind === "place" && (() => {
        const recipe = recipes.find((r) => r.id === dialog.recipeId);
        if (!recipe) return null;
        return (
          <PlannerPlaceModal
            recipeTitle={recipe.title}
            days={days.map((d) => ({ dateKey: toKey(d), label: `${fmtLong(d)}${toKey(d) === todayKey ? " (hoy)" : ""}` }))}
            slots={MEAL_SLOTS.map((s) => ({ key: s.key, label: s.label }))}
            initialDateKey={toKey(sel)}
            occupant={(dk, sl) => {
              const id = plan[dk]?.[sl as MealSlot];
              return id ? findEntry(id)?.title ?? null : null;
            }}
            onConfirm={(dk, sl) => {
              setMeal(dk, sl as MealSlot, recipe.id);
              const idx = days.findIndex((d) => toKey(d) === dk);
              if (idx >= 0) setDayIdx(idx);
              showToast(`${recipe.title} colocada en ${holeName(dk, sl as MealSlot)}`);
              closeDialog(editKey(dk, sl as MealSlot));
            }}
            onClose={() => closeDialog(`lib:${recipe.id}`)}
          />
        );
      })()}
    </section>
  );
}

function WeekRow({ label, snack, children }: { label: string; snack: boolean; children: React.ReactNode }) {
  return (
    <>
      <div className="pl-rowlabel">
        {label}
        {snack && <small>se registra como Snack</small>}
      </div>
      {children}
    </>
  );
}
