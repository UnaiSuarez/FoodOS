"use client";

import { useEffect, useRef, type FormEvent } from "react";
import { getFoodSpend, useFoodOS } from "@/lib/state";
import { eur, todayPlus, uid } from "@/lib/utils";

export function FinanceView() {
  const { state, mutate, showToast } = useFoodOS();

  const income = state.expenses.filter((entry) => entry.type === "income").reduce((sum, entry) => sum + Number(entry.amount), 0);
  const expense = state.expenses.filter((entry) => entry.type === "expense").reduce((sum, entry) => sum + Number(entry.amount), 0);

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
        type: data.get("type") === "income" ? "income" : "expense",
        amount: Number(data.get("amount")),
        category: String(data.get("category")),
        description: String(data.get("description")).trim(),
        date: todayPlus(0),
      });
    });
    showToast("Movimiento guardado");
    form.reset();
  }

  return (
    <section className="view">
      <div className="work-grid">
        <form className="panel form-panel" onSubmit={addMovement}>
          <h2>Registrar movimiento</h2>
          <div className="form-grid compact">
            <label>
              Tipo
              <select name="type" defaultValue="expense">
                <option value="expense">Gasto</option>
                <option value="income">Ingreso</option>
              </select>
            </label>
            <label>
              Importe € <input name="amount" type="number" min="0" step="0.01" defaultValue="12" required />
            </label>
            <label>
              Categoría
              <select name="category" defaultValue="Comida">
                <option>Comida</option>
                <option>Vivienda</option>
                <option>Transporte</option>
                <option>Ocio</option>
                <option>Salud</option>
                <option>Ahorro</option>
              </select>
            </label>
            <label>
              Descripción <input name="description" placeholder="Compra semanal" />
            </label>
          </div>
          <button className="primary-button" type="submit">
            Guardar movimiento
          </button>
        </form>

        <article className="panel">
          <div className="panel-head">
            <h2>Finanzas</h2>
            <strong className="money">{eur(income - expense)}</strong>
          </div>

          <div className="finance-stats">
            <div>
              <span>Ingresos</span>
              <strong>{eur(income)}</strong>
            </div>
            <div>
              <span>Gastos</span>
              <strong>{eur(expense)}</strong>
            </div>
            <div>
              <span>Comida (7 días)</span>
              <strong>{eur(getFoodSpend(state))}</strong>
            </div>
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
                      {entry.category} · {entry.type === "income" ? "Ingreso" : "Gasto"} · {entry.date}
                    </small>
                  </div>
                  <div className="card-actions">
                    <span className="money">
                      {entry.type === "income" ? "+" : "-"}
                      {eur(entry.amount)}
                    </span>
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
