"use client";

import { useEffect, useRef, type FormEvent } from "react";
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

export function FinanceView() {
  const { state, mutate, showToast } = useFoodOS();

  const expenseTotal = state.expenses
    .filter((entry) => entry.type === "expense")
    .reduce((sum, entry) => sum + Number(entry.amount), 0);

  // Gastos de los ultimos 30 dias: base del balance y la proyeccion.
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  const monthlyExpenses = state.expenses
    .filter((entry) => entry.type === "expense" && new Date(entry.date) >= monthAgo)
    .reduce((sum, entry) => sum + Number(entry.amount), 0);

  const monthlyIncome = state.incomeSources
    .filter((source) => source.active)
    .reduce((sum, source) => sum + monthlyAmountOf(source.frequency, source.amount), 0);

  const monthlySavings = Math.max(0, monthlyIncome - monthlyExpenses);
  const projection = projectSavings(monthlySavings, monthlyExpenses);

  const byCategory: Record<string, number> = {};
  state.expenses
    .filter((entry) => entry.type === "expense")
    .forEach((entry) => {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + Number(entry.amount || 0);
    });
  const categories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const maxCategory = Math.max(...categories.map(([, amount]) => amount), 1);

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

  return (
    <section className="view">
      <div className="work-grid">
        <div className="stack-panels">
          <form className="panel" onSubmit={addMovement}>
            <h2>Registrar gasto</h2>
            <div className="form-grid compact">
              <label>
                Importe € <input name="amount" type="number" min="0" step="0.01" defaultValue="12" required />
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
                </select>
              </label>
              <label>
                Descripción <input name="description" placeholder="Compra semanal" />
              </label>
            </div>
            <button className="primary-button" type="submit">
              Guardar gasto
            </button>
          </form>

          <form className="panel" onSubmit={addIncomeSource}>
            <h2>Fuentes de ingreso</h2>
            <div className="form-grid compact">
              <label>
                Nombre <input name="name" required placeholder="Nómina" />
              </label>
              <label>
                Importe € <input name="amount" type="number" min="0" step="0.01" required placeholder="1450" />
              </label>
              <label>
                Frecuencia
                <select name="frequency" defaultValue="monthly">
                  {(Object.keys(FREQUENCY_LABELS) as IncomeFrequency[]).map((frequency) => (
                    <option key={frequency} value={frequency}>
                      {FREQUENCY_LABELS[frequency]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Día de cobro <small>(opcional)</small>
                <input name="dayOfMonth" type="number" min="1" max="31" placeholder="28" />
              </label>
            </div>
            <button className="secondary-button" type="submit">
              Añadir fuente
            </button>

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
                            const target = draft.incomeSources.find((candidate) => candidate.id === source.id);
                            if (target) target.active = !target.active;
                          })
                        }
                      >
                        {source.active ? "Activa" : "Pausada"}
                      </button>
                      <button
                        className="small-action bad"
                        onClick={() =>
                          mutate((draft) => {
                            draft.incomeSources = draft.incomeSources.filter(
                              (candidate) => candidate.id !== source.id
                            );
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
        </div>

        <article className="panel">
          <div className="panel-head">
            <h2>Finanzas del mes</h2>
            <strong className={`money ${monthlyIncome - monthlyExpenses < 0 ? "negative" : ""}`}>
              {eur(monthlyIncome - monthlyExpenses)}
            </strong>
          </div>

          <div className="finance-stats">
            <div>
              <span>Ingresos/mes</span>
              <strong>{eur(monthlyIncome)}</strong>
            </div>
            <div>
              <span>Gastos (30 días)</span>
              <strong>{eur(monthlyExpenses)}</strong>
            </div>
            <div>
              <span>Comida (7 días)</span>
              <strong>{eur(getFoodSpend(state))}</strong>
            </div>
          </div>

          {/* Proyeccion de ahorro con interes compuesto (PDF §8.6) */}
          <div className="projection-card">
            <div className="panel-head">
              <h3>Si ahorras {eur(monthlySavings)}/mes…</h3>
            </div>
            {monthlySavings > 0 ? (
              <>
                <div className="projection-grid">
                  <div>
                    <span>En 6 meses</span>
                    <strong>{eur(projection.months6)}</strong>
                  </div>
                  <div>
                    <span>En 1 año</span>
                    <strong>{eur(projection.year1)}</strong>
                  </div>
                  <div>
                    <span>5 años (cuenta)</span>
                    <strong>{eur(projection.years5Bank)}</strong>
                  </div>
                  <div>
                    <span>5 años (fondo 7%)</span>
                    <strong className="highlight">{eur(projection.years5Fund)}</strong>
                  </div>
                  <div>
                    <span>10 años (fondo 7%)</span>
                    <strong className="highlight">{eur(projection.years10Fund)}</strong>
                  </div>
                  <div>
                    <span>Fondo de emergencia (3 meses)</span>
                    <strong>
                      {projection.emergencyFundMonths ? `en ${projection.emergencyFundMonths} meses` : "—"}
                    </strong>
                  </div>
                </div>
                <p className="projection-disclaimer">
                  El 7% es la rentabilidad histórica media de fondos indexados. Rentabilidades pasadas
                  no garantizan rentabilidades futuras.
                </p>
              </>
            ) : (
              <p className="projection-disclaimer">
                {monthlyIncome === 0
                  ? "Añade una fuente de ingreso para ver tu proyección de ahorro."
                  : "Este mes gastas más de lo que ingresas. Revisa el desglose por categoría y prueba el optimizador proteína/€ del asistente."}
              </p>
            )}
          </div>

          <div className="chart-card">
            <h3>Gasto últimas 4 semanas</h3>
            <FinanceChart />
          </div>

          <div className="category-breakdown">
            {categories.length ? (
              categories.map(([category, amount]) => (
                <div key={category} className="category-row">
                  <span>{category}</span>
                  <div className="category-track">
                    <i style={{ width: `${Math.round((amount / maxCategory) * 100)}%` }} />
                  </div>
                  <strong>{eur(amount)}</strong>
                </div>
              ))
            ) : (
              <div className="empty">Sin gastos categorizados todavía.</div>
            )}
          </div>

          <div className="budget-card">
            <span>Presupuesto semanal de comida</span>
            <input
              type="number"
              min="0"
              step="1"
              value={state.weeklyBudget}
              onChange={(event) => {
                const value = Number(event.target.value);
                mutate((draft) => void (draft.weeklyBudget = value));
              }}
            />
          </div>

          <div className="card-list">
            {state.expenses.length ? (
              [...state.expenses].reverse().map((entry) => (
                <article key={entry.id} className="card">
                  <div>
                    <h3>{entry.description || entry.category}</h3>
                    <small>
                      {entry.category} · {entry.date}
                    </small>
                  </div>
                  <div className="card-actions">
                    <span className="money">-{eur(entry.amount)}</span>
                    <button
                      className="small-action bad"
                      onClick={() =>
                        mutate((draft) => {
                          draft.expenses = draft.expenses.filter((candidate) => candidate.id !== entry.id);
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

    const weeks = [3, 2, 1, 0].map((weekOffset) => {
      const start = new Date();
      start.setDate(start.getDate() - (weekOffset + 1) * 7);
      const end = new Date();
      end.setDate(end.getDate() - weekOffset * 7);
      return state.expenses
        .filter((entry) => entry.type === "expense")
        .filter((entry) => {
          const date = new Date(entry.date);
          return date > start && date <= end;
        })
        .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    });

    const max = Math.max(...weeks, 10);
    const pad = 28;
    const gap = (width - pad * 2) / 4;
    const barWidth = Math.max(28, gap * 0.46);

    weeks.forEach((value, index) => {
      const barHeight = (value / max) * (height - 58);
      const x = pad + index * gap + (gap - barWidth) / 2;
      const y = height - 30 - barHeight;
      ctx.fillStyle = index === 3 ? "#4ade80" : "rgba(74,222,128,0.32)";
      ctx.fillRect(x, y, barWidth, barHeight);
      ctx.fillStyle = index === 3 ? "#4ade80" : "rgba(240,244,238,0.58)";
      ctx.font = "12px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${Math.round(value)} €`, x + barWidth / 2, Math.max(16, y - 8));
      ctx.fillStyle = "rgba(150,163,144,0.9)";
      ctx.fillText(["-4s", "-3s", "-2s", "Esta"][index], x + barWidth / 2, height - 8);
    });
  }, [state.expenses]);

  return <canvas ref={canvasRef} className="finance-chart" height={220} />;
}
