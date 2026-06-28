"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { IncomeFrequency } from "@foodos/types";
import { getFoodSpend, useFoodOS } from "@/lib/state";
import { monthlyAmountOf, projectSavings } from "@/lib/nutrition";
import { eur, todayPlus, uid } from "@/lib/utils";

const FREQUENCY_LABELS: Record<IncomeFrequency, string> = {
  weekly: "Semanal",
  biweekly: "Quincenal",
  monthly: "Mensual",
  yearly: "Anual",
};

const NEEDS_CATS = new Set(["Comida", "Vivienda", "Suministros", "Transporte", "Salud"]);
const WANTS_CATS = new Set(["Ocio", "Suscripciones", "Ropa", "Formación", "Otros"]);

function buildTip(params: {
  savingsRate: number;
  savingsGoalPct: number;
  monthlyIncome: number;
  monthlyFixed: number;
  foodPct: number;
  topVariableCat: string;
}): { icon: string; text: string; type: "good" | "warn" | "alert" | "info" } {
  const { savingsRate, savingsGoalPct, monthlyIncome, monthlyFixed, foodPct, topVariableCat } = params;

  if (monthlyIncome === 0) {
    return { icon: "→", text: "Añade tus fuentes de ingreso para calcular tu tasa de ahorro real.", type: "info" };
  }
  if (savingsRate >= savingsGoalPct) {
    return { icon: "✓", text: `¡Meta de ahorro alcanzada! Llevas el ${Math.round(savingsRate)}% de ahorro. Considera invertir el excedente en un fondo indexado.`, type: "good" };
  }
  if (monthlyFixed > monthlyIncome * 0.6) {
    return { icon: "⚠", text: `Tus gastos fijos son el ${Math.round((monthlyFixed / monthlyIncome) * 100)}% de tus ingresos. Revisa suscripciones o servicios que puedas reducir.`, type: "alert" };
  }
  if (foodPct > 40) {
    return { icon: "◌", text: `La comida representa el ${Math.round(foodPct)}% de tus gastos variables. Activa el modo ahorro en Recetas para reducir el coste por ración.`, type: "warn" };
  }
  if (savingsRate < 10 && savingsRate > 0) {
    return { icon: "⚠", text: `Tu tasa de ahorro es del ${Math.round(savingsRate)}%. Intenta reducir los gastos en ${topVariableCat || "ocio"} para subir al ${savingsGoalPct}%.`, type: "warn" };
  }
  if (savingsRate <= 0) {
    return { icon: "!", text: `Este mes gastas más de lo que ingresas. Revisa el desglose por categoría y activa el modo ahorro en Recetas.`, type: "alert" };
  }
  return { icon: "✦", text: `Vas bien. Tu tasa de ahorro es del ${Math.round(savingsRate)}%. Sube la meta al ${savingsGoalPct}% para acelerar tu fondo de emergencia.`, type: "info" };
}

export function FinanceView() {
  const { state, mutate, showToast } = useFoodOS();

  // ── Cálculos base ────────────────────────────────────────────
  const now = new Date();
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(now.getDate() - 30);
  const sixtyDaysAgo  = new Date(now); sixtyDaysAgo.setDate(now.getDate() - 60);

  const monthlyIncome = state.incomeSources
    .filter((s) => s.active)
    .reduce((sum, s) => sum + monthlyAmountOf(s.frequency, s.amount), 0);

  const monthlyFixed = (state.recurringExpenses ?? [])
    .filter((r) => r.active)
    .reduce((sum, r) => sum + monthlyAmountOf(r.frequency, r.amount), 0);

  const variableExpenses = state.expenses.filter(
    (e) => e.type === "expense" && new Date(e.date) >= thirtyDaysAgo
  );
  const monthlyVariable = variableExpenses.reduce((sum, e) => sum + Number(e.amount), 0);

  const prevMonthExpenses = state.expenses
    .filter((e) => e.type === "expense" && new Date(e.date) >= sixtyDaysAgo && new Date(e.date) < thirtyDaysAgo)
    .reduce((sum, e) => sum + Number(e.amount), 0);

  const totalMonthlyExpenses = monthlyFixed + monthlyVariable;
  const monthlySavings = monthlyIncome - totalMonthlyExpenses;
  const savingsRate = monthlyIncome > 0 ? (monthlySavings / monthlyIncome) * 100 : 0;
  const savingsGoalPct = state.savingsGoalPct ?? 20;

  const projection = projectSavings(Math.max(0, monthlySavings), totalMonthlyExpenses);

  // ── Breakdown por categoría (variable) ───────────────────────
  const byCategory: Record<string, number> = {};
  variableExpenses.forEach((e) => {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + Number(e.amount || 0);
  });
  // Sumar gastos fijos al breakdown
  (state.recurringExpenses ?? []).filter((r) => r.active).forEach((r) => {
    const monthly = monthlyAmountOf(r.frequency, r.amount);
    byCategory[r.category] = (byCategory[r.category] ?? 0) + monthly;
  });
  const categories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const maxCategory = Math.max(...categories.map(([, v]) => v), 1);
  const topVariableCat = Object.entries(
    variableExpenses.reduce<Record<string, number>>((acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + Number(e.amount);
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  // ── Regla 50/30/20 ───────────────────────────────────────────
  let needs = 0, wants = 0;
  categories.forEach(([cat, amt]) => {
    if (NEEDS_CATS.has(cat)) needs += amt;
    else if (WANTS_CATS.has(cat)) wants += amt;
  });
  const savingsAmt = Math.max(0, monthlySavings);
  const rule_total = needs + wants + savingsAmt || 1;
  const needsPct  = Math.round((needs / rule_total) * 100);
  const wantsPct  = Math.round((wants / rule_total) * 100);
  const savingsPct = Math.round((savingsAmt / rule_total) * 100);

  // ── Consejo automático ────────────────────────────────────────
  const foodSpend = variableExpenses
    .filter((e) => e.category === "Comida")
    .reduce((s, e) => s + Number(e.amount), 0);
  const foodPct = monthlyVariable > 0 ? (foodSpend / monthlyVariable) * 100 : 0;
  const tip = buildTip({ savingsRate, savingsGoalPct, monthlyIncome, monthlyFixed, foodPct, topVariableCat });

  // ── Comparativa mes anterior ──────────────────────────────────
  const vsLastMonth = monthlyVariable - prevMonthExpenses;
  const hasPrevData = prevMonthExpenses > 0;

  function addMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    mutate((draft) => {
      draft.expenses.push({
        id: uid(),
        type: "expense",
        amount: Number(data.get("amount")),
        category: String(data.get("category")),
        description: String(data.get("description")).trim(),
        date: todayPlus(0),
      });
    });
    showToast("Gasto guardado");
    form.reset();
  }

  function addRecurring(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    mutate((draft) => {
      draft.recurringExpenses.push({
        id: uid(),
        name: String(data.get("name")).trim(),
        amount: Number(data.get("amount")),
        frequency: String(data.get("frequency")) as IncomeFrequency,
        category: String(data.get("category")),
        active: true,
      });
    });
    showToast("Gasto fijo añadido");
    form.reset();
  }

  function addIncomeSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const dayRaw = String(data.get("dayOfMonth")).trim();
    mutate((draft) => {
      draft.incomeSources.push({
        id: uid(),
        name: String(data.get("name")).trim(),
        amount: Number(data.get("amount")),
        frequency: String(data.get("frequency")) as IncomeFrequency,
        dayOfMonth: dayRaw ? Number(dayRaw) : null,
        active: true,
      });
    });
    showToast("Fuente de ingreso añadida");
    form.reset();
  }

  const balanceSign = monthlySavings >= 0 ? "positive" : "negative";

  // Estado UI local
  const [incomeOpen, setIncomeOpen] = useState(false);
  const [showAllExpenses, setShowAllExpenses] = useState(false);

  // Presupuesto semanal
  const foodSpendWeek = getFoodSpend(state);
  const weeklyBudget = state.weeklyBudget || 0;
  const budgetPct = weeklyBudget > 0 ? Math.min(100, (foodSpendWeek / weeklyBudget) * 100) : 0;
  const budgetOverrun = foodSpendWeek > weeklyBudget && weeklyBudget > 0;
  const budgetWarn = budgetPct >= (state.settings?.budgetWarnPct ?? 80) && !budgetOverrun;

  // Lista gastos
  const allExpenses = [...state.expenses].reverse();
  const visibleExpenses = showAllExpenses ? allExpenses : allExpenses.slice(0, 8);

  return (
    <section className="view">
      <div className="work-grid">

        {/* ── Columna izquierda: formularios ── */}
        <div className="stack-panels">

          {/* Registrar gasto puntual */}
          <form className="panel" onSubmit={addMovement}>
            <h2>Registrar gasto</h2>
            <div className="form-grid compact">
              <label>
                Importe €<input name="amount" type="number" min="0" step="0.01" defaultValue="12" required />
              </label>
              <label>
                Categoría
                <select name="category" defaultValue="Comida">
                  <option>Comida</option>
                  <option>Vivienda</option>
                  <option>Suministros</option>
                  <option>Transporte</option>
                  <option>Suscripciones</option>
                  <option>Ocio</option>
                  <option>Salud</option>
                  <option>Ropa</option>
                  <option>Formación</option>
                  <option>Otros</option>
                  {state.settings.extraExpenseCategories?.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Descripción<input name="description" placeholder="Compra semanal" />
              </label>
            </div>
            <button className="primary-button" type="submit">Guardar gasto</button>
          </form>

          {/* Gastos fijos mensuales (E) */}
          <form className="panel" onSubmit={addRecurring}>
            <h2>Gastos fijos</h2>
            <p className="panel-hint">Alquiler, suministros, suscripciones… se descuentan del balance automáticamente cada mes.</p>
            <div className="form-grid compact">
              <label>
                Nombre<input name="name" required placeholder="Alquiler" />
              </label>
              <label>
                Importe €<input name="amount" type="number" min="0" step="0.01" required placeholder="650" />
              </label>
              <label>
                Frecuencia
                <select name="frequency" defaultValue="monthly">
                  {(Object.keys(FREQUENCY_LABELS) as IncomeFrequency[]).map((f) => (
                    <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
                  ))}
                </select>
              </label>
              <label>
                Categoría
                <select name="category" defaultValue="Vivienda">
                  <option>Vivienda</option>
                  <option>Suministros</option>
                  <option>Transporte</option>
                  <option>Suscripciones</option>
                  <option>Salud</option>
                  <option>Comida</option>
                  <option>Otros</option>
                </select>
              </label>
            </div>
            <button className="secondary-button" type="submit">Añadir gasto fijo</button>

            <div className="card-list income-list">
              {(state.recurringExpenses ?? []).length ? (
                (state.recurringExpenses ?? []).map((r) => (
                  <article key={r.id} className={`card ${r.active ? "" : "inactive"}`}>
                    <div>
                      <h3>{r.name}</h3>
                      <small>
                        {eur(r.amount)} · {FREQUENCY_LABELS[r.frequency]} · {r.category} ·{" "}
                        {eur(monthlyAmountOf(r.frequency, r.amount))}/mes
                      </small>
                    </div>
                    <div className="card-actions">
                      <button
                        className={`small-action ${r.active ? "good" : ""}`}
                        onClick={() =>
                          mutate((draft) => {
                            const t = draft.recurringExpenses.find((x) => x.id === r.id);
                            if (t) t.active = !t.active;
                          })
                        }
                      >
                        {r.active ? "Activo" : "Pausado"}
                      </button>
                      <button
                        className="small-action bad"
                        onClick={() =>
                          mutate((draft) => {
                            draft.recurringExpenses = draft.recurringExpenses.filter((x) => x.id !== r.id);
                          })
                        }
                      >
                        Borrar
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty">Sin gastos fijos todavía. Añade el alquiler, la luz, Spotify…</div>
              )}
            </div>
          </form>

          {/* Fuentes de ingreso — colapsable */}
          <div className="panel">
            <button className="smart-suggest-toggle" onClick={() => setIncomeOpen((v) => !v)}>
              <span>Fuentes de ingreso</span>
              <span className="suggest-counts">
                <span className="badge green">{eur(monthlyIncome)}/mes</span>
              </span>
              <span className="suggest-chevron">{incomeOpen ? "▲" : "▼"}</span>
            </button>

            {incomeOpen && (
              <form onSubmit={addIncomeSource} style={{ marginTop: 12 }}>
                <div className="form-grid compact">
                  <label>
                    Nombre<input name="name" required placeholder="Nómina" />
                  </label>
                  <label>
                    Importe €<input name="amount" type="number" min="0" step="0.01" required placeholder="1450" />
                  </label>
                  <label>
                    Frecuencia
                    <select name="frequency" defaultValue="monthly">
                      {(Object.keys(FREQUENCY_LABELS) as IncomeFrequency[]).map((f) => (
                        <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Día de cobro <small>(opcional)</small>
                    <input name="dayOfMonth" type="number" min="1" max="31" placeholder="28" />
                  </label>
                </div>
                <button className="secondary-button" type="submit">Añadir fuente</button>

                <div className="card-list income-list">
                  {state.incomeSources.length ? (
                    state.incomeSources.map((source) => (
                      <article key={source.id} className={`card ${source.active ? "" : "inactive"}`}>
                        <div>
                          <h3>{source.name}</h3>
                          <small>
                            {eur(source.amount)} · {FREQUENCY_LABELS[source.frequency]}
                            {source.dayOfMonth ? ` · día ${source.dayOfMonth}` : ""} ·{" "}
                            {eur(monthlyAmountOf(source.frequency, source.amount))}/mes
                          </small>
                        </div>
                        <div className="card-actions">
                          <button
                            className={`small-action ${source.active ? "good" : ""}`}
                            onClick={() =>
                              mutate((draft) => {
                                const t = draft.incomeSources.find((x) => x.id === source.id);
                                if (t) t.active = !t.active;
                              })
                            }
                          >
                            {source.active ? "Activa" : "Pausada"}
                          </button>
                          <button
                            className="small-action bad"
                            onClick={() =>
                              mutate((draft) => {
                                draft.incomeSources = draft.incomeSources.filter((x) => x.id !== source.id);
                              })
                            }
                          >
                            Borrar
                          </button>
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="empty">Añade tu nómina u otras fuentes para calcular tu ahorro.</div>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>

        {/* ── Columna derecha: dashboard ── */}
        <article className="panel finance-dashboard" data-tour="finance-summary">

          {/* Balance principal */}
          <div className="finance-balance">
            <div className="finance-balance-head">
              <h2>Balance mensual</h2>
              <strong className={`finance-balance-num ${balanceSign}`}>
                {monthlySavings >= 0 ? "+" : ""}{eur(monthlySavings)}
              </strong>
            </div>

            <div className="finance-stats">
              <div>
                <span>Ingresos/mes</span>
                <strong className="positive">{eur(monthlyIncome)}</strong>
              </div>
              <div>
                <span>Gastos fijos/mes</span>
                <strong>{eur(monthlyFixed)}</strong>
              </div>
              <div>
                <span>Variables (30 días)</span>
                <strong>{eur(monthlyVariable)}</strong>
                {hasPrevData && (
                  <span className={`finance-vs ${vsLastMonth > 0 ? "neg" : "pos"}`}>
                    {vsLastMonth > 0 ? "+" : ""}{eur(vsLastMonth)} vs mes ant.
                  </span>
                )}
              </div>
              <div>
                <span>Comida (7 días)</span>
                <strong>{eur(getFoodSpend(state))}</strong>
              </div>
            </div>

            {/* A: Tasa de ahorro + meta */}
            <div className="savings-rate-card">
              <div className="savings-rate-head">
                <span>Tasa de ahorro</span>
                <div className="savings-rate-goal">
                  <span>Meta:</span>
                  <input
                    type="number"
                    min="1"
                    max="80"
                    value={savingsGoalPct}
                    onChange={(e) => mutate((d) => { d.savingsGoalPct = Number(e.target.value); })}
                    className="savings-goal-input"
                  />
                  <span>%</span>
                </div>
              </div>
              <div className="savings-rate-bar-wrap">
                <div className="savings-rate-bar">
                  <div
                    className={`savings-rate-fill ${savingsRate >= savingsGoalPct ? "goal-reached" : ""}`}
                    style={{ width: `${Math.min(100, Math.max(0, savingsRate))}%` }}
                  />
                  <div
                    className="savings-goal-marker"
                    style={{ left: `${Math.min(100, savingsGoalPct)}%` }}
                    title={`Meta: ${savingsGoalPct}%`}
                  />
                </div>
                <span className={`savings-rate-pct ${savingsRate >= savingsGoalPct ? "goal-reached" : savingsRate < 0 ? "neg" : ""}`}>
                  {savingsRate > 0 ? Math.round(savingsRate) : 0}%
                </span>
              </div>
            </div>
          </div>

          {/* D: Consejo automático */}
          <div className={`finance-tip tip-${tip.type}`}>
            <span className="tip-icon">{tip.icon}</span>
            <p>{tip.text}</p>
          </div>

          {/* C: Regla 50/30/20 */}
          <div className="rule-5030-card">
            <div className="rule-head">
              <h3>Distribución 50/30/20</h3>
              <span className="rule-hint">Necesidades · Deseos · Ahorro</span>
            </div>
            <div className="rule-bar">
              <div className="rule-needs"  style={{ width: needsPct > 0 ? `max(4%, ${needsPct}%)` : "0" }}  title={`Necesidades ${needsPct}%`} />
              <div className="rule-wants"  style={{ width: wantsPct > 0 ? `max(4%, ${wantsPct}%)` : "0" }}  title={`Deseos ${wantsPct}%`} />
              <div className="rule-savings" style={{ width: savingsPct > 0 ? `max(4%, ${savingsPct}%)` : "0" }} title={`Ahorro ${savingsPct}%`} />
            </div>
            <div className="rule-legend">
              <span><i className="rule-dot needs" />{needsPct}% Necesidades <small>(meta 50%)</small></span>
              <span><i className="rule-dot wants" />{wantsPct}% Deseos <small>(meta 30%)</small></span>
              <span><i className="rule-dot savings" />{savingsPct}% Ahorro <small>(meta 20%)</small></span>
            </div>
          </div>

          {/* Gráfico 4 semanas */}
          <div className="chart-card">
            <h3>Gasto variables — últimas 4 semanas</h3>
            <FinanceChart />
          </div>

          {/* Proyección ahorro */}
          <div className="projection-card">
            <div className="panel-head">
              <h3>Si ahorras ~{eur(Math.max(0, Math.round(monthlySavings)))}/mes…</h3>
            </div>
            {monthlySavings > 0 ? (
              <>
                <div className="projection-grid">
                  <div><span>En 6 meses</span><strong>{eur(projection.months6)}</strong></div>
                  <div><span>En 1 año</span><strong>{eur(projection.year1)}</strong></div>
                  <div><span>5 años (cuenta)</span><strong>{eur(projection.years5Bank)}</strong></div>
                  <div><span>5 años (fondo 7%)</span><strong className="highlight">{eur(projection.years5Fund)}</strong></div>
                  <div><span>10 años (fondo 7%)</span><strong className="highlight">{eur(projection.years10Fund)}</strong></div>
                  <div>
                    <span>Fondo emergencia (3 meses)</span>
                    <strong>{projection.emergencyFundMonths ? `en ${projection.emergencyFundMonths} meses` : "—"}</strong>
                  </div>
                </div>
                <p className="projection-disclaimer">
                  El 7% es la rentabilidad histórica media de fondos indexados. Rentabilidades pasadas no garantizan rentabilidades futuras.
                </p>
              </>
            ) : (
              <p className="projection-disclaimer">
                {monthlyIncome === 0
                  ? "Añade una fuente de ingreso para ver tu proyección."
                  : "Este mes el balance es negativo. Reduce gastos para liberar margen de ahorro."}
              </p>
            )}
          </div>

          {/* Breakdown por categoría */}
          <div className="category-breakdown">
            <h3>Gasto por categoría <small>(fijos + variables)</small></h3>
            {categories.length ? (
              categories.map(([cat, amt]) => (
                <div key={cat} className="category-row">
                  <span className={`cat-label ${NEEDS_CATS.has(cat) ? "needs" : WANTS_CATS.has(cat) ? "wants" : ""}`}>
                    {cat}
                  </span>
                  <div className="category-track">
                    <i style={{ width: `${Math.round((amt / maxCategory) * 100)}%` }} />
                  </div>
                  <strong>{eur(amt)}</strong>
                </div>
              ))
            ) : (
              <div className="empty">Sin gastos categorizados todavía.</div>
            )}
          </div>

          {/* Presupuesto semanal comida con barra */}
          <div className="budget-card-v2">
            <div className="budget-card-head">
              <span>Presupuesto semanal de comida</span>
              <div className="budget-edit">
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={state.weeklyBudget}
                  onChange={(e) => mutate((d) => void (d.weeklyBudget = Number(e.target.value)))}
                  className="budget-input"
                />
                <span>€</span>
              </div>
            </div>
            <div className="budget-bar-wrap">
              <div className="budget-bar">
                <div
                  className={`budget-bar-fill ${budgetOverrun ? "overrun" : budgetWarn ? "warn" : ""}`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
              <span className={`budget-bar-label ${budgetOverrun ? "overrun" : budgetWarn ? "warn" : ""}`}>
                {eur(foodSpendWeek)} / {eur(weeklyBudget)}
              </span>
            </div>
            {budgetOverrun && (
              <p className="budget-alert">⚠ Has superado el presupuesto semanal en {eur(foodSpendWeek - weeklyBudget)}</p>
            )}
          </div>

          {/* Lista últimos movimientos */}
          <div className="expenses-list-section">
            <div className="panel-head">
              <h3>Últimos gastos</h3>
              {allExpenses.length > 8 && (
                <button className="secondary-button small" onClick={() => setShowAllExpenses((v) => !v)}>
                  {showAllExpenses ? "Ver menos" : `Ver todos (${allExpenses.length})`}
                </button>
              )}
            </div>
            <div className="card-list">
              {visibleExpenses.length ? (
                visibleExpenses.map((entry) => (
                  <article key={entry.id} className="card">
                    <div>
                      <h3>{entry.description || entry.category}</h3>
                      <small>{entry.category} · {entry.date}</small>
                    </div>
                    <div className="card-actions">
                      <span className="money">-{eur(entry.amount)}</span>
                      <button
                        className="small-action bad"
                        onClick={() =>
                          mutate((draft) => {
                            draft.expenses = draft.expenses.filter((c) => c.id !== entry.id);
                          })
                        }
                      >
                        Borrar
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty">No hay movimientos todavía.</div>
              )}
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

function FinanceChart() {
  const { state } = useFoodOS();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.clientWidth;
    const height = 220;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const weeks = [3, 2, 1, 0].map((offset) => {
      const start = new Date(); start.setDate(start.getDate() - (offset + 1) * 7);
      const end   = new Date(); end.setDate(end.getDate() - offset * 7);
      return state.expenses
        .filter((e) => e.type === "expense")
        .filter((e) => { const d = new Date(e.date); return d > start && d <= end; })
        .reduce((sum, e) => sum + Number(e.amount || 0), 0);
    });

    const max = Math.max(...weeks, 10);
    const pad = 28;
    const gap = (width - pad * 2) / 4;
    const barWidth = Math.max(28, gap * 0.46);

    weeks.forEach((value, i) => {
      const barHeight = (value / max) * (height - 58);
      const x = pad + i * gap + (gap - barWidth) / 2;
      const y = height - 30 - barHeight;
      ctx.fillStyle = i === 3 ? "#4ade80" : "rgba(74,222,128,0.32)";
      ctx.fillRect(x, y, barWidth, barHeight);
      ctx.fillStyle = i === 3 ? "#4ade80" : "rgba(240,244,238,0.58)";
      ctx.font = "12px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${Math.round(value)} €`, x + barWidth / 2, Math.max(16, y - 8));
      ctx.fillStyle = "rgba(150,163,144,0.9)";
      ctx.fillText(["-4s", "-3s", "-2s", "Esta"][i], x + barWidth / 2, height - 8);
    });
  }, [state.expenses]);

  return <canvas ref={canvasRef} className="finance-chart" height={220} />;
}
