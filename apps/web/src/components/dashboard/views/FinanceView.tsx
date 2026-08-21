"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { IncomeFrequency } from "@foodos/types";
import { getFoodSpend, getSavingsStreak, getToday, useFoodOS } from "@/lib/state";
import { monthlyAmountOf, projectSavings } from "@/lib/nutrition";
import { dateFromKey, eur, uid } from "@/lib/utils";
import { consumeQuickAddSignal } from "@/lib/quick-add-signal";

const FREQUENCY_LABELS: Record<IncomeFrequency, string> = {
  weekly: "Semanal",
  biweekly: "Quincenal",
  monthly: "Mensual",
  yearly: "Anual",
};

const NEEDS_CATS = new Set(["Comida", "Vivienda", "Suministros", "Transporte", "Salud"]);
const WANTS_CATS = new Set(["Ocio", "Suscripciones", "Ropa", "Formación", "Otros"]);

const EXPENSE_CATS = ["Comida", "Vivienda", "Suministros", "Transporte", "Suscripciones", "Ocio", "Salud", "Ropa", "Formación", "Otros"];
const INCOME_CATS  = ["Trabajo", "Venta", "Bizum", "Freelance", "Regalo", "Otros"];

// Porcentaje sugerido de cada categoría DENTRO de su cubeta (sum = 1.0)
const DEFAULT_BUCKET_PCTS: Record<string, number> = {
  "Vivienda":     0.52,
  "Comida":       0.27,
  "Transporte":   0.12,
  "Salud":        0.05,
  "Suministros":  0.04,
  "Ocio":         0.35,
  "Ropa":         0.25,
  "Suscripciones":0.20,
  "Formación":    0.12,
  "Otros":        0.08,
};

function catBucket(cat: string): { label: string; color: string } {
  if (NEEDS_CATS.has(cat)) return { label: "Necesidades", color: "needs" };
  if (WANTS_CATS.has(cat)) return { label: "Deseos", color: "wants" };
  return { label: "Variable", color: "wants" };
}

function buildTip(params: {
  savingsRate: number;
  savingsGoalPct: number;
  totalIncome: number;
  monthlyFixed: number;
  monthlyExpenses: number;
  monthlySavings: number;
  foodPct: number;
  foodSpend: number;
  monthlyVariable: number;
  topVariableCat: string;
  topVariableCatAmount: number;
}): { icon: string; text: string; type: "good" | "warn" | "alert" | "info" } {
  const {
    savingsRate, savingsGoalPct, totalIncome, monthlyFixed, monthlyExpenses, monthlySavings,
    foodPct, foodSpend, monthlyVariable, topVariableCat, topVariableCatAmount,
  } = params;
  if (totalIncome === 0)
    return { icon: "→", text: "Añade tus fuentes de ingreso para calcular tu tasa de ahorro real.", type: "info" };
  if (savingsRate >= savingsGoalPct)
    // E13-01: sin recomendar un producto financiero concreto — FoodOS no es
    // un asesor de inversión (ver E23-02).
    return { icon: "✓", text: `¡Meta de ahorro alcanzada! Llevas el ${Math.round(savingsRate)}% de ahorro. Es un buen momento para decidir qué hacer con el excedente: seguir ahorrando, invertir o adelantar tu próximo objetivo.`, type: "good" };
  if (monthlyFixed > totalIncome * 0.6) {
    const over = Math.round(monthlyFixed - totalIncome * 0.6);
    return { icon: "⚠", text: `Tus gastos fijos son el ${Math.round((monthlyFixed / totalIncome) * 100)}% de tus ingresos (${eur(monthlyFixed)}/mes). Recorta unos ${eur(over)}/mes en suscripciones o servicios para bajar del 60%.`, type: "alert" };
  }
  if (foodPct > 40) {
    const over = Math.round(foodSpend - monthlyVariable * 0.4);
    return { icon: "◌", text: `La comida representa el ${Math.round(foodPct)}% de tus gastos variables (${eur(foodSpend)}). Activa el modo ahorro en Recetas: bajar ${eur(over)} te dejaría en el 40%.`, type: "warn" };
  }
  if (savingsRate < 10 && savingsRate > 0) {
    const needed = Math.max(0, (savingsGoalPct / 100) * totalIncome - monthlySavings);
    const cut = Math.min(needed, topVariableCatAmount || needed);
    return { icon: "⚠", text: `Tu tasa de ahorro es del ${Math.round(savingsRate)}%. Recorta ${eur(cut)} en ${topVariableCat || "ocio"} este mes para llegar al ${savingsGoalPct}%.`, type: "warn" };
  }
  if (savingsRate <= 0) {
    const deficit = Math.round(monthlyExpenses - totalIncome);
    return { icon: "!", text: `Este mes gastas ${eur(deficit)} más de lo que ingresas. Revisa el desglose por categoría y activa el modo ahorro en Recetas.`, type: "alert" };
  }
  const needed = Math.max(0, (savingsGoalPct / 100) * totalIncome - monthlySavings);
  return { icon: "✦", text: `Vas bien. Tu tasa de ahorro es del ${Math.round(savingsRate)}%. Te faltan ${eur(needed)}/mes para llegar al ${savingsGoalPct}%.`, type: "info" };
}

export function FinanceView() {
  const { state, mutate, showToast } = useFoodOS();

  // ── UI state ─────────────────────────────────────────────────
  const [formType, setFormType]       = useState<"expense" | "income">("expense");
  const [formCategory, setFormCategory] = useState("Comida");
  const [incomeOpen, setIncomeOpen]   = useState(false);
  const [showAllMovements, setShowAllMovements] = useState(false);
  const amountInputRef = useRef<HTMLInputElement>(null);

  // E04-04: acción universal "Añadir" → "Añadir gasto" navega aquí y deja
  // esta señal — el formulario ya está siempre visible, solo falta llevar
  // el foco al importe en vez de dejar al usuario buscándolo.
  useEffect(() => {
    if (consumeQuickAddSignal("expense")) amountInputRef.current?.focus();
  }, []);

  // ── Cálculos base ────────────────────────────────────────────
  const activeToday = getToday(state);
  const now = dateFromKey(activeToday);
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(now.getDate() - 30);
  const sixtyDaysAgo  = new Date(now); sixtyDaysAgo.setDate(now.getDate() - 60);

  // Ingresos
  const recurringIncome = state.incomeSources
    .filter((s) => s.active)
    .reduce((sum, s) => sum + monthlyAmountOf(s.frequency, s.amount), 0);

  const oneTimeIncome = state.expenses
    .filter((e) => e.type === "income" && dateFromKey(e.date) >= thirtyDaysAgo)
    .reduce((sum, e) => sum + Number(e.amount), 0);

  const totalMonthlyIncome = recurringIncome + oneTimeIncome;

  // Gastos
  const monthlyFixed = (state.recurringExpenses ?? [])
    .filter((r) => r.active)
    .reduce((sum, r) => sum + monthlyAmountOf(r.frequency, r.amount), 0);

  // Auditoría de suscripciones: 8€/mes no impresiona, 96€/año sí — reencuadrar
  // el coste como anual empuja a decidir si de verdad merece la pena.
  const activeSubscriptions = (state.recurringExpenses ?? []).filter(
    (r) => r.active && r.category === "Suscripciones"
  );
  const subscriptionsMonthly = activeSubscriptions.reduce((sum, r) => sum + monthlyAmountOf(r.frequency, r.amount), 0);
  const subscriptionsYearly  = subscriptionsMonthly * 12;

  const variableExpenses = state.expenses.filter(
    (e) => e.type === "expense" && dateFromKey(e.date) >= thirtyDaysAgo
  );
  const monthlyVariable = variableExpenses.reduce((sum, e) => sum + Number(e.amount), 0);

  const prevMonthVariable = state.expenses
    .filter((e) => e.type === "expense" && dateFromKey(e.date) >= sixtyDaysAgo && dateFromKey(e.date) < thirtyDaysAgo)
    .reduce((sum, e) => sum + Number(e.amount), 0);

  const totalMonthlyExpenses = monthlyFixed + monthlyVariable;
  const monthlySavings = totalMonthlyIncome - totalMonthlyExpenses;
  const savingsRate    = totalMonthlyIncome > 0 ? (monthlySavings / totalMonthlyIncome) * 100 : 0;
  const savingsGoalPct = state.savingsGoalPct ?? 20;
  const projection     = projectSavings(Math.max(0, monthlySavings), totalMonthlyExpenses);
  const savingsStreak  = getSavingsStreak(state);

  // ── Meta de ahorro con nombre ───────────────────────────────────
  // No hay banco real conectado (bankSynced es demo), así que el progreso es
  // una estimación honesta: ritmo de ahorro actual × meses desde que se creó
  // la meta, igual que la proyección de abajo ya asume un ritmo constante.
  const savingsGoal = state.savingsGoal;
  const monthsSinceGoal = savingsGoal
    ? Math.max(0, (now.getTime() - dateFromKey(savingsGoal.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30.44))
    : 0;
  const goalEstimatedSaved = savingsGoal
    ? Math.max(0, Math.min(savingsGoal.targetAmount, Math.max(0, monthlySavings) * monthsSinceGoal))
    : 0;
  const goalProgressPct = savingsGoal && savingsGoal.targetAmount > 0
    ? Math.min(100, (goalEstimatedSaved / savingsGoal.targetAmount) * 100)
    : 0;
  const monthsToGoalDate = savingsGoal?.targetDate
    ? Math.max(0, (dateFromKey(savingsGoal.targetDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 30.44))
    : null;
  const neededMonthlyPace = savingsGoal && monthsToGoalDate != null && monthsToGoalDate > 0.1
    ? Math.max(0, savingsGoal.targetAmount - goalEstimatedSaved) / monthsToGoalDate
    : null;
  const goalBehindPace = neededMonthlyPace != null && monthlySavings < neededMonthlyPace;
  const goalReached = savingsGoal ? goalEstimatedSaved >= savingsGoal.targetAmount : false;

  // ── Breakdown categorías ──────────────────────────────────────
  const byCategory: Record<string, number> = {};
  variableExpenses.forEach((e) => {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + Number(e.amount || 0);
  });
  (state.recurringExpenses ?? []).filter((r) => r.active).forEach((r) => {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + monthlyAmountOf(r.frequency, r.amount);
  });
  const categories   = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const maxCategory  = Math.max(...categories.map(([, v]) => v), 1);
  const topVariableCatEntry = Object.entries(
    variableExpenses.reduce<Record<string, number>>((acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + Number(e.amount);
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1])[0];
  const topVariableCat = topVariableCatEntry?.[0] ?? "";
  const topVariableCatAmount = topVariableCatEntry?.[1] ?? 0;

  // ── Regla 50/30/20 ───────────────────────────────────────────
  let needs = 0, wants = 0;
  categories.forEach(([cat, amt]) => {
    if (NEEDS_CATS.has(cat)) needs += amt;
    else if (WANTS_CATS.has(cat)) wants += amt;
  });
  const savingsAmt   = Math.max(0, monthlySavings);
  const needsTarget  = totalMonthlyIncome * 0.5;
  const wantsTarget  = totalMonthlyIncome * 0.3;
  const savingsTarget = totalMonthlyIncome * 0.2;

  // ── Consejo ───────────────────────────────────────────────────
  const foodSpend = variableExpenses.filter((e) => e.category === "Comida").reduce((s, e) => s + Number(e.amount), 0);
  const foodPct   = monthlyVariable > 0 ? (foodSpend / monthlyVariable) * 100 : 0;
  const tip       = buildTip({
    savingsRate, savingsGoalPct, totalIncome: totalMonthlyIncome, monthlyFixed,
    monthlyExpenses: totalMonthlyExpenses, monthlySavings, foodPct, foodSpend,
    monthlyVariable, topVariableCat, topVariableCatAmount,
  });

  // ── Comparativa mes anterior ──────────────────────────────────
  const vsLastMonth = monthlyVariable - prevMonthVariable;
  const hasPrevData = prevMonthVariable > 0;

  // ── Presupuesto semanal ───────────────────────────────────────
  const foodSpendWeek = getFoodSpend(state);
  // Si hay presupuesto de categoría "Comida" guardado, derivamos el semanal; si no, usamos el manual
  const foodMonthlyBudget = (state.categoryBudgets ?? {})["Comida"];
  const weeklyBudget  = foodMonthlyBudget != null
    ? foodMonthlyBudget / 4.33
    : (state.weeklyBudget || 0);
  const budgetPct     = weeklyBudget > 0 ? Math.min(100, (foodSpendWeek / weeklyBudget) * 100) : 0;
  const budgetOverrun = foodSpendWeek > weeklyBudget && weeklyBudget > 0;
  const budgetWarn    = budgetPct >= (state.settings?.budgetWarnPct ?? 80) && !budgetOverrun;

  // ── Lista movimientos ─────────────────────────────────────────
  const allMovements = [...state.expenses].reverse();
  const visibleMovements = showAllMovements ? allMovements : allMovements.slice(0, 8);

  // ── Handlers ─────────────────────────────────────────────────
  function addMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    mutate((draft) => {
      draft.expenses.push({
        id: uid(),
        type: formType,
        amount: Number(data.get("amount")),
        category: String(data.get("category")),
        description: String(data.get("description")).trim(),
        date: getToday(draft),
      });
    });
    showToast(formType === "income" ? "Ingreso registrado" : "Gasto guardado");
    form.reset();
    setFormCategory(formType === "income" ? "Trabajo" : "Comida");
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

  function saveSavingsGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const dateRaw = String(data.get("targetDate") ?? "").trim();
    mutate((draft) => {
      draft.savingsGoal = {
        name: String(data.get("name")).trim(),
        targetAmount: Number(data.get("targetAmount")),
        targetDate: dateRaw || null,
        createdAt: getToday(draft),
      };
    });
    showToast("Meta de ahorro creada");
  }

  function deleteSavingsGoal() {
    mutate((draft) => { draft.savingsGoal = null; });
    showToast("Meta de ahorro borrada");
  }

  const balanceSign = monthlySavings >= 0 ? "positive" : "negative";
  const bucket = catBucket(formCategory);

  // ── Helper: presupuesto de una categoría (guardado o sugerido) ──
  const catBudget = (cat: string, bucketTarget: number): number =>
    (state.categoryBudgets ?? {})[cat] ?? bucketTarget * (DEFAULT_BUCKET_PCTS[cat] ?? 0);

  // ── Datos cubetas 50/30/20 ────────────────────────────────────
  const buckets = [
    {
      key: "needs",
      label: "Necesidades",
      goal: 50,
      target: needsTarget,
      actual: needs,
      higherIsBetter: false,
      catList: ["Vivienda", "Comida", "Transporte", "Salud", "Suministros"],
    },
    {
      key: "wants",
      label: "Deseos",
      goal: 30,
      target: wantsTarget,
      actual: wants,
      higherIsBetter: false,
      catList: ["Ocio", "Ropa", "Suscripciones", "Formación", "Otros"],
    },
    {
      key: "savings",
      label: "Ahorro",
      goal: 20,
      target: savingsTarget,
      actual: savingsAmt,
      higherIsBetter: true,
      catList: [] as string[],
    },
  ];

  return (
    <section className="view">
      <div className="work-grid">

        {/* ── Columna izquierda ── */}
        <div className="stack-panels">

          {/* Formulario unificado Gasto / Ingreso */}
          <form className="panel" onSubmit={addMovement}>
            <div className="form-type-tabs">
              <button
                type="button"
                className={`form-type-tab ${formType === "expense" ? "active" : ""}`}
                onClick={() => { setFormType("expense"); setFormCategory("Comida"); }}
              >
                − Gasto
              </button>
              <button
                type="button"
                className={`form-type-tab income ${formType === "income" ? "active" : ""}`}
                onClick={() => { setFormType("income"); setFormCategory("Trabajo"); }}
              >
                + Ingreso
              </button>
            </div>

            <div className="form-grid compact" style={{ marginTop: 14 }}>
              <label>
                Importe €
                {/* E13-03: sin importe por defecto — un 12€ inventado podía
                    guardarse sin que el usuario lo notara. */}
                <input ref={amountInputRef} name="amount" type="number" min="0" step="0.01" placeholder="ej. 12,50" required />
              </label>
              <label>
                Categoría
                <select
                  name="category"
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                >
                  {(formType === "expense" ? EXPENSE_CATS : INCOME_CATS).map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                  {formType === "expense" && state.settings.extraExpenseCategories?.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                {formType === "expense" && (
                  <span className={`bucket-hint bucket-hint-${bucket.color}`}>
                    → {bucket.label}
                  </span>
                )}
              </label>
              <label>
                Descripción
                <input
                  name="description"
                  placeholder={formType === "income" ? "Bizum de Pedro, paga extra…" : "Compra semanal…"}
                />
              </label>
            </div>

            <button className={`primary-button ${formType === "income" ? "income-btn" : ""}`} type="submit">
              {formType === "income" ? "+ Guardar ingreso" : "Guardar gasto"}
            </button>
          </form>

          {/* Gastos fijos */}
          <form className="panel" onSubmit={addRecurring}>
            <h2>Gastos fijos</h2>
            <p className="panel-hint">Alquiler, suministros, suscripciones… se descuentan del balance automáticamente cada mes.</p>
            <div className="form-grid compact">
              <label>Nombre<input name="name" required placeholder="Alquiler" /></label>
              <label>Importe €<input name="amount" type="number" min="0" step="0.01" required placeholder="650" /></label>
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
                  <option>Vivienda</option><option>Suministros</option><option>Transporte</option>
                  <option>Suscripciones</option><option>Salud</option><option>Comida</option><option>Otros</option>
                </select>
              </label>
            </div>
            <button className="secondary-button" type="submit">Añadir gasto fijo</button>

            {activeSubscriptions.length > 0 && (
              <div className="finance-tip tip-warn subscriptions-audit">
                <span className="tip-icon">📱</span>
                <p>
                  {activeSubscriptions.length} suscripción{activeSubscriptions.length > 1 ? "es" : ""} activa{activeSubscriptions.length > 1 ? "s" : ""}:{" "}
                  {eur(subscriptionsMonthly)}/mes = <strong>{eur(subscriptionsYearly)}/año</strong>. Si hay alguna que no usas, cancelarla es ahorro inmediato.
                </p>
              </div>
            )}

            <div className="card-list income-list">
              {(state.recurringExpenses ?? []).length ? (
                (state.recurringExpenses ?? []).map((r) => (
                  <article key={r.id} className={`card ${r.active ? "" : "inactive"}`}>
                    <div>
                      <h3>{r.name}</h3>
                      <small>{eur(r.amount)} · {FREQUENCY_LABELS[r.frequency]} · {r.category} · {eur(monthlyAmountOf(r.frequency, r.amount))}/mes</small>
                    </div>
                    <div className="card-actions">
                      <button
                        className={`small-action ${r.active ? "good" : ""}`}
                        onClick={() => mutate((d) => { const t = d.recurringExpenses.find((x) => x.id === r.id); if (t) t.active = !t.active; })}
                      >
                        {r.active ? "Activo" : "Pausado"}
                      </button>
                      <button className="small-action bad" onClick={() => mutate((d) => { d.recurringExpenses = d.recurringExpenses.filter((x) => x.id !== r.id); })}>
                        Borrar
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty">Sin gastos fijos. Añade el alquiler, la luz, Spotify…</div>
              )}
            </div>
          </form>

          {/* Fuentes de ingreso — colapsable */}
          <div className="panel">
            <button className="smart-suggest-toggle" onClick={() => setIncomeOpen((v) => !v)}>
              <span>Fuentes de ingreso</span>
              <span className="suggest-counts"><span className="badge green">{eur(recurringIncome)}/mes</span></span>
              <span className="suggest-chevron">{incomeOpen ? "▲" : "▼"}</span>
            </button>
            {incomeOpen && (
              <form onSubmit={addIncomeSource} style={{ marginTop: 12 }}>
                <div className="form-grid compact">
                  <label>Nombre<input name="name" required placeholder="Nómina" /></label>
                  <label>Importe €<input name="amount" type="number" min="0" step="0.01" required placeholder="1450" /></label>
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
                    state.incomeSources.map((s) => (
                      <article key={s.id} className={`card ${s.active ? "" : "inactive"}`}>
                        <div>
                          <h3>{s.name}</h3>
                          <small>{eur(s.amount)} · {FREQUENCY_LABELS[s.frequency]}{s.dayOfMonth ? ` · día ${s.dayOfMonth}` : ""} · {eur(monthlyAmountOf(s.frequency, s.amount))}/mes</small>
                        </div>
                        <div className="card-actions">
                          <button
                            className={`small-action ${s.active ? "good" : ""}`}
                            onClick={() => mutate((d) => { const t = d.incomeSources.find((x) => x.id === s.id); if (t) t.active = !t.active; })}
                          >
                            {s.active ? "Activa" : "Pausada"}
                          </button>
                          <button className="small-action bad" onClick={() => mutate((d) => { d.incomeSources = d.incomeSources.filter((x) => x.id !== s.id); })}>
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

          {/* Balance */}
          <div className="finance-balance">
            <div className="finance-balance-head">
              <h2>Balance mensual</h2>
              <strong className={`finance-balance-num ${balanceSign}`}>
                {monthlySavings >= 0 ? "+" : ""}{eur(monthlySavings)}
              </strong>
            </div>
            <div className="finance-stats">
              <div>
                <span>Ingresos fijos/mes</span>
                <strong className="positive">{eur(recurringIncome)}</strong>
              </div>
              {oneTimeIncome > 0 && (
                <div>
                  <span>Ingresos extra (30 días)</span>
                  <strong className="positive">+{eur(oneTimeIncome)}</strong>
                </div>
              )}
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
                <strong>{eur(foodSpendWeek)}</strong>
              </div>
            </div>

            {/* Tasa de ahorro */}
            <div className="savings-rate-card">
              <div className="savings-rate-head">
                <span>Tasa de ahorro</span>
                <div className="savings-rate-goal">
                  <span>Meta:</span>
                  <input
                    type="number" min="1" max="80"
                    value={savingsGoalPct}
                    onChange={(e) => mutate((d) => { d.savingsGoalPct = Number(e.target.value); })}
                    className="savings-goal-input"
                    aria-label="Meta de ahorro (%)"
                  />
                  <span>%</span>
                </div>
              </div>
              {savingsStreak > 0 && (
                <div className="meta-row" style={{ marginTop: 4, marginBottom: 8 }}>
                  <span className="badge green" title="Semanas seguidas con el gasto variable dentro de lo que permite tu meta de ahorro">
                    🔥 {savingsStreak} semana{savingsStreak > 1 ? "s" : ""} seguida{savingsStreak > 1 ? "s" : ""} en objetivo
                  </span>
                </div>
              )}
              <div className="savings-rate-bar-wrap">
                <div className="savings-rate-bar">
                  <div
                    className={`savings-rate-fill ${savingsRate >= savingsGoalPct ? "goal-reached" : ""}`}
                    style={{ width: `${Math.min(100, Math.max(0, savingsRate))}%` }}
                  />
                  <div className="savings-goal-marker" style={{ left: `${Math.min(100, savingsGoalPct)}%` }} />
                </div>
                <span className={`savings-rate-pct ${savingsRate >= savingsGoalPct ? "goal-reached" : savingsRate < 0 ? "neg" : ""}`}>
                  {savingsRate > 0 ? Math.round(savingsRate) : 0}%
                </span>
              </div>
            </div>
          </div>

          {/* Consejo */}
          <div className={`finance-tip tip-${tip.type}`}>
            <span className="tip-icon">{tip.icon}</span>
            <p>{tip.text}</p>
          </div>

          {/* Meta de ahorro con nombre — más motivador que un % abstracto */}
          <div className="projection-card">
            <div className="panel-head">
              <h3>🎯 Meta de ahorro</h3>
            </div>
            {savingsGoal ? (
              <>
                <div className="budget-card-head">
                  <span>{savingsGoal.name}</span>
                  <button className="small-action bad" onClick={deleteSavingsGoal}>Borrar meta</button>
                </div>
                <div className="budget-bar-wrap">
                  <div className="budget-bar">
                    <div
                      className={`budget-bar-fill ${goalReached ? "" : goalBehindPace ? "warn" : ""}`}
                      style={{ width: `${goalProgressPct}%` }}
                    />
                  </div>
                  <span className={`budget-bar-label ${goalBehindPace && !goalReached ? "warn" : ""}`}>
                    {eur(goalEstimatedSaved)} / {eur(savingsGoal.targetAmount)}
                  </span>
                </div>
                {goalReached ? (
                  <p className="projection-disclaimer">✓ Meta alcanzada (estimado). ¡Enhorabuena!</p>
                ) : savingsGoal.targetDate ? (
                  <p className="projection-disclaimer">
                    {goalBehindPace
                      ? `Vas por detrás: necesitas ~${eur(neededMonthlyPace ?? 0)}/mes hasta ${savingsGoal.targetDate} (ahora ahorras ${eur(Math.max(0, monthlySavings))}/mes).`
                      : `Al ritmo actual llegas antes de ${savingsGoal.targetDate}.`}
                  </p>
                ) : (
                  <p className="projection-disclaimer">Sin fecha objetivo — progreso estimado por tu ritmo de ahorro actual.</p>
                )}
                <p className="projection-disclaimer">Estimado a partir de tu ahorro mensual actual — no hay banco real conectado.</p>
              </>
            ) : (
              <form onSubmit={saveSavingsGoal} className="form-grid compact">
                <label>Objetivo<input name="name" required placeholder="Viaje en agosto" /></label>
                <label>Importe €<input name="targetAmount" type="number" min="1" step="1" required placeholder="600" /></label>
                <label>Fecha objetivo <small>(opcional)</small><input name="targetDate" type="date" /></label>
                <button className="secondary-button" type="submit" style={{ alignSelf: "end" }}>Crear meta</button>
              </form>
            )}
          </div>

          {/* 50/30/20 cubetas detalladas */}
          <div className="rule-buckets-section">
            <div className="rule-buckets-head">
              <h3>Distribución 50/30/20</h3>
              {totalMonthlyIncome === 0 && <span className="rule-hint">Añade ingresos para ver las metas</span>}
            </div>
            <div className="rule-bucket-cards">
              {buckets.map((b) => {
                const usedPct = b.target > 0 ? Math.min(120, (b.actual / b.target) * 100) : 0;
                const bad = b.higherIsBetter
                  ? b.actual < b.target && b.target > 0
                  : b.actual > b.target && b.target > 0;
                const diff = b.higherIsBetter
                  ? b.actual - b.target
                  : b.target - b.actual;
                return (
                  <div key={b.key} className={`rule-bucket-card ${bad ? "over" : "ok"}`}>
                    <div className="rule-bucket-head">
                      <i className={`rule-dot ${b.key}`} />
                      <strong>{b.label}</strong>
                      <span className="rule-bucket-goal-pct">{b.goal}%</span>
                    </div>
                    <div className="rule-bucket-bar">
                      <div className={`rule-bucket-fill ${b.key}${bad ? " over" : ""}`} style={{ width: `${usedPct}%` }} />
                    </div>
                    <div className="rule-bucket-summary">
                      <div className="rule-bucket-nums">
                        <span>{eur(b.actual)}</span>
                        <span className="rule-bucket-target">/ {eur(b.target)}</span>
                      </div>
                      <div className={`rule-bucket-diff ${bad ? "neg" : "pos"}`}>
                        {b.target === 0
                          ? "—"
                          : diff >= 0
                            ? b.higherIsBetter
                              ? `+${eur(diff)} extra`
                              : `+${eur(diff)} libre`
                            : `−${eur(Math.abs(diff))} ${b.higherIsBetter ? "faltan" : "pasado"}`}
                      </div>
                    </div>

                    {/* Desglose editable por categoría (solo needs y wants) */}
                    {b.catList.length > 0 && (
                      <div className="cat-budget-list">
                        {b.catList.map((cat) => {
                          const budget = catBudget(cat, b.target);
                          const spent  = byCategory[cat] ?? 0;
                          const rem    = budget - spent;
                          const barPct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
                          return (
                            <div key={cat} className="cat-budget-row">
                              <div className="cat-budget-top">
                                <span className="cat-budget-name">{cat}</span>
                                <div className="cat-budget-right">
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={budget.toFixed(2)}
                                    onChange={(e) =>
                                      mutate((d) => { d.categoryBudgets[cat] = Number(e.target.value); })
                                    }
                                    className="cat-budget-input"
                                    title={`Presupuesto mensual ${cat} (€)`}
                                    aria-label={`Presupuesto mensual ${cat} (€)`}
                                  />
                                </div>
                              </div>
                              <div className="cat-budget-bottom">
                                <div className="cat-budget-bar-wrap">
                                  <div
                                    className={`cat-budget-bar ${b.key}${spent > budget && budget > 0 ? " over" : ""}`}
                                    style={{ width: `${barPct}%` }}
                                  />
                                </div>
                                <span className={`cat-budget-rem ${rem < 0 ? "neg" : ""}`}>
                                  {rem >= 0 ? `+${eur(rem)}` : `−${eur(Math.abs(rem))}`}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {b.key === "savings" && (
                      <div className="cat-budget-list">
                        <div className="cat-budget-row savings-row">
                          <span className="cat-budget-name">Meta mensual</span>
                          <span className={`cat-budget-rem ${b.actual >= b.target ? "" : "neg"}`}>
                            {eur(b.actual)} / {eur(b.target)}
                          </span>
                        </div>
                        {totalMonthlyIncome > 0 && (
                          <div className="cat-budget-row savings-row">
                            <span className="cat-budget-name">Comida semanal derivada</span>
                            <span className="cat-budget-rem">{eur(catBudget("Comida", needsTarget) / 4.33)}/sem</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Gráfico 4 semanas */}
          <div className="chart-card">
            <h3>Gastos variables — últimas 4 semanas</h3>
            <FinanceChart />
          </div>

          {/* Proyección */}
          <div className="projection-card">
            <div className="panel-head">
              <h3>Si ahorras ~{eur(Math.max(0, monthlySavings))}/mes…</h3>
            </div>
            {monthlySavings > 0 ? (
              <>
                <div className="projection-grid">
                  <div><span>En 6 meses</span><strong>{eur(projection.months6)}</strong></div>
                  <div><span>En 1 año</span><strong>{eur(projection.year1)}</strong></div>
                  <div><span>5 años (cuenta)</span><strong>{eur(projection.years5Bank)}</strong></div>
                  <div><span>5 años (con crecimiento ~7%)</span><strong className="highlight">{eur(projection.years5Fund)}</strong></div>
                  <div><span>10 años (con crecimiento ~7%)</span><strong className="highlight">{eur(projection.years10Fund)}</strong></div>
                  <div><span>Colchón de emergencia (3 meses)</span><strong>{projection.emergencyFundMonths ? `en ${projection.emergencyFundMonths} meses` : "—"}</strong></div>
                </div>
                {/* E13-01/E23-02: ilustra el interés compuesto con una
                    rentabilidad media de mercado, sin nombrar ni recomendar
                    ningún producto de inversión concreto. */}
                <p className="projection-disclaimer">
                  El 7% es una rentabilidad media histórica de mercado, usada solo como referencia para
                  ilustrar el interés compuesto — no es un consejo de inversión ni garantiza resultados futuros.
                </p>
              </>
            ) : (
              <p className="projection-disclaimer">
                {totalMonthlyIncome === 0 ? "Añade una fuente de ingreso para ver tu proyección." : "Este mes el balance es negativo. Reduce gastos para liberar margen de ahorro."}
              </p>
            )}
          </div>

          {/* Breakdown categorías */}
          <div className="category-breakdown">
            <h3>Gasto por categoría <small>(fijos + variables)</small></h3>
            {categories.length ? (
              categories.map(([cat, amt]) => (
                <div key={cat} className="category-row">
                  <span className={`cat-label ${NEEDS_CATS.has(cat) ? "needs" : WANTS_CATS.has(cat) ? "wants" : ""}`}>{cat}</span>
                  <div className="category-track"><i style={{ width: `${Math.round((amt / maxCategory) * 100)}%` }} /></div>
                  <strong>{eur(amt)}</strong>
                </div>
              ))
            ) : (
              <div className="empty">Sin gastos categorizados todavía.</div>
            )}
          </div>

          {/* Presupuesto semanal comida */}
          <div className="budget-card-v2">
            <div className="budget-card-head">
              <span>Presupuesto semanal de comida</span>
              <div className="budget-edit">
                <input
                  type="number" min="0" step="1" value={state.weeklyBudget}
                  onChange={(e) => mutate((d) => void (d.weeklyBudget = Number(e.target.value)))}
                  className="budget-input"
                  aria-label="Presupuesto semanal de comida (€)"
                />
                <span>€</span>
              </div>
            </div>
            <div className="budget-bar-wrap">
              <div className="budget-bar">
                <div className={`budget-bar-fill ${budgetOverrun ? "overrun" : budgetWarn ? "warn" : ""}`} style={{ width: `${budgetPct}%` }} />
              </div>
              <span className={`budget-bar-label ${budgetOverrun ? "overrun" : budgetWarn ? "warn" : ""}`}>
                {eur(foodSpendWeek)} / {eur(weeklyBudget)}
              </span>
            </div>
            {budgetOverrun && <p className="budget-alert">⚠ Superado en {eur(foodSpendWeek - weeklyBudget)}</p>}
            {budgetWarn && (
              <p className="budget-alert warn">
                ⚠ Llevas {eur(foodSpendWeek)} de {eur(weeklyBudget)} ({Math.round(budgetPct)}%) y aún es{" "}
                {now.toLocaleDateString("es-ES", { weekday: "long" })}.
              </p>
            )}
          </div>

          {/* Últimos movimientos */}
          <div className="expenses-list-section">
            <div className="panel-head">
              <h3>Movimientos</h3>
              {allMovements.length > 8 && (
                <button className="secondary-button small" onClick={() => setShowAllMovements((v) => !v)}>
                  {showAllMovements ? "Ver menos" : `Ver todos (${allMovements.length})`}
                </button>
              )}
            </div>
            <div className="card-list">
              {visibleMovements.length ? (
                visibleMovements.map((entry) => {
                  const isIncome = entry.type === "income";
                  return (
                    <article key={entry.id} className={`card ${isIncome ? "income-entry" : ""}`}>
                      <div>
                        <h3>{entry.description || entry.category}</h3>
                        <small>{entry.category} · {entry.date}</small>
                      </div>
                      <div className="card-actions">
                        <span className={`money ${isIncome ? "positive" : ""}`}>
                          {isIncome ? "+" : "−"}{eur(entry.amount)}
                        </span>
                        <button
                          className="small-action bad"
                          onClick={() => {
                            const deleted = entry;
                            // La lista se muestra en orden de inserción (invertido), así
                            // que al deshacer se restaura en su posición original.
                            const index = state.expenses.findIndex((c) => c.id === entry.id);
                            mutate((d) => { d.expenses = d.expenses.filter((c) => c.id !== entry.id); });
                            showToast(`Movimiento de ${eur(entry.amount)} borrado`, {
                              label: "Deshacer",
                              onAction: () => mutate((d) => {
                                d.expenses.splice(Math.min(index, d.expenses.length), 0, deleted);
                              }),
                            });
                          }}
                        >
                          Borrar
                        </button>
                      </div>
                    </article>
                  );
                })
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

  // E18-12: <canvas> no tiene ningún contenido accesible por su cuenta (a
  // diferencia de <svg>, no hay nada que un lector de pantalla pueda leer
  // salvo lo que se le dé explícitamente vía aria-label/contenido) — antes
  // este gráfico era completamente invisible para quien no lo ve. Se saca
  // el cálculo de las 4 semanas fuera del efecto de dibujo para poder
  // reutilizarlo también en el aria-label y en la tabla de abajo.
  const activeToday = dateFromKey(getToday(state));
  const weekLabels = ["Hace 4 semanas", "Hace 3 semanas", "Hace 2 semanas", "Esta semana"];
  const weeks = [3, 2, 1, 0].map((offset) => {
    const start = new Date(activeToday); start.setDate(activeToday.getDate() - (offset + 1) * 7);
    const end   = new Date(activeToday); end.setDate(activeToday.getDate() - offset * 7);
    return state.expenses
      .filter((e) => e.type === "expense")
      .filter((e) => { const d = dateFromKey(e.date); return d > start && d <= end; })
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
  });
  const chartSummary = `Gasto variable por semana: ${weekLabels
    .map((label, i) => `${label}, ${eur(weeks[i])}`)
    .join("; ")}.`;

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
  }, [state.expenses, state.debugDate]);

  return (
    <>
      <canvas ref={canvasRef} className="finance-chart" height={220} role="img" aria-label={chartSummary} />
      <table className="sr-only">
        <caption>Gasto variable por semana, últimas 4 semanas</caption>
        <thead>
          <tr>
            <th scope="col">Semana</th>
            <th scope="col">Gasto</th>
          </tr>
        </thead>
        <tbody>
          {weekLabels.map((label, i) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{eur(weeks[i])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
