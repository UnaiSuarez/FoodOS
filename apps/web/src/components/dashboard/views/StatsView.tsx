"use client";

import type { WeightEntry } from "@foodos/types";
import {
  getAdherenceStreak,
  getLatestWeight,
  getMonthlyFinanceHistory,
  getWeeklyMacroHistory,
  useFoodOS,
} from "@/lib/state";
import { eur } from "@/lib/utils";

export function StatsView() {
  const { state } = useFoodOS();

  const monthly = getMonthlyFinanceHistory(state, 6);
  const macroHistory = getWeeklyMacroHistory(state, 28);
  const streak = getAdherenceStreak(state);
  const latestWeight = getLatestWeight(state);

  const sorted = [...state.weightLog].sort((a, b) => a.date.localeCompare(b.date));
  const last7 = sorted.slice(-7);
  const prev7 = sorted.slice(-14, -7);
  const avgLast = last7.length ? last7.reduce((s, e) => s + e.kg, 0) / last7.length : null;
  const avgPrev = prev7.length ? prev7.reduce((s, e) => s + e.kg, 0) / prev7.length : null;
  const weightTrend =
    avgLast != null && avgPrev != null ? Math.round((avgLast - avgPrev) * 10) / 10 : null;

  const monthsWithIncome = monthly.filter((m) => m.income > 0);
  const avgSavingsRate = monthsWithIncome.length
    ? monthsWithIncome.reduce((s, m) => s + (m.savings / m.income) * 100, 0) /
      monthsWithIncome.length
    : null;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const byCat: Record<string, number> = {};
  state.expenses
    .filter((e) => e.type === "expense" && new Date(e.date) >= thirtyDaysAgo)
    .forEach((e) => {
      byCat[e.category] = (byCat[e.category] ?? 0) + Number(e.amount);
    });
  const catEntries = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maxCat = Math.max(...catEntries.map(([, v]) => v), 1);
  const totalSpend30 = catEntries.reduce((s, [, v]) => s + v, 0);

  return (
    <section className="view">
      {/* KPI row */}
      <div className="summary-grid" style={{ marginBottom: 14 }}>
        <article className="metric-card">
          <span>Racha de macros</span>
          <strong>{streak}</strong>
          <small>días objetivo consecutivos</small>
        </article>
        <article className="metric-card">
          <span>Peso actual</span>
          <strong>{latestWeight ? `${latestWeight.kg} kg` : "—"}</strong>
          <small>
            {weightTrend != null
              ? `${weightTrend >= 0 ? "+" : ""}${weightTrend} kg vs sem. anterior`
              : "Registra tu peso en Nutrición"}
          </small>
        </article>
        <article className="metric-card">
          <span>Tasa de ahorro</span>
          <strong>{avgSavingsRate != null ? `${Math.round(avgSavingsRate)}%` : "—"}</strong>
          <small>promedio meses con ingresos registrados</small>
        </article>
        <article className="metric-card">
          <span>Gastos 30 días</span>
          <strong>{eur(totalSpend30)}</strong>
          <small>{catEntries.length} categorías activas</small>
        </article>
      </div>

      {/* Monthly finance chart */}
      <article className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-head">
          <div>
            <p className="eyebrow">Historial financiero</p>
            <h2>Ingresos vs gastos</h2>
          </div>
          <div className="meta-row">
            <span className="badge blue" style={{ fontSize: 11 }}>■ Ingresos</span>
            <span className="badge red" style={{ fontSize: 11 }}>■ Gastos</span>
            <span className="badge green" style={{ fontSize: 11 }}>■ Ahorro neto</span>
          </div>
        </div>
        <MonthlyFinanceChart data={monthly} />
        <p className="chart-legend">
          Solo ingresos/gastos variables registrados manualmente. Gastos fijos recurrentes no incluidos por mes.
        </p>
      </article>

      {/* Weight + category split */}
      <div className="stats-two-col">
        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Evolución</p>
              <h2>Peso corporal</h2>
            </div>
            {latestWeight && (
              <span className="badge green">{latestWeight.kg} kg</span>
            )}
          </div>
          {sorted.length >= 2 ? (
            <StatsWeightChart entries={sorted.slice(-30)} />
          ) : (
            <p className="empty">
              Registra tu peso al menos 2 días en Nutrición para ver la evolución.
            </p>
          )}
          {weightTrend != null && (
            <div className="meta-row" style={{ marginTop: 8 }}>
              <span className={`badge ${weightTrend < 0 ? "green" : weightTrend > 0 ? "amber" : ""}`}>
                {weightTrend >= 0 ? "+" : ""}{weightTrend} kg esta semana
              </span>
            </div>
          )}
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Últimos 30 días</p>
              <h2>Gasto por categoría</h2>
            </div>
          </div>
          {catEntries.length ? (
            <div className="stats-cat-list">
              {catEntries.map(([cat, amt]) => (
                <div key={cat} className="stats-cat-row">
                  <span className="stats-cat-name">{cat}</span>
                  <div className="stats-cat-bar-wrap">
                    <div
                      className="stats-cat-bar"
                      style={{ width: `${(amt / maxCat) * 100}%` }}
                    />
                  </div>
                  <span className="stats-cat-amt">{eur(amt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">Sin gastos registrados los últimos 30 días.</p>
          )}
        </article>
      </div>

      {/* 28-day macro chart */}
      <article className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head">
          <div>
            <p className="eyebrow">Últimas 4 semanas</p>
            <h2>Evolución de macros</h2>
          </div>
          <div className="meta-row">
            <span className="badge green" style={{ fontSize: 11 }}>■ Proteína</span>
            <span className="badge blue" style={{ fontSize: 11 }}>■ Kcal</span>
          </div>
        </div>
        <StatsMacroChart
          data={macroHistory}
          targetKcal={state.nutrition.kcal}
          targetProtein={state.nutrition.protein}
        />
        <p className="chart-legend">
          Verde = % proteína · Azul = % calorías · Objetivos: {state.nutrition.kcal} kcal /{" "}
          {state.nutrition.protein}g prot
        </p>
      </article>
    </section>
  );
}

// ── Chart components ──────────────────────────────────────────────

function MonthlyFinanceChart({
  data,
}: {
  data: Array<{ label: string; income: number; expenses: number; savings: number; month: string }>;
}) {
  const maxVal = Math.max(...data.map((m) => Math.max(m.income, m.expenses)), 1);
  const W = 560, H = 110, PAD = 16;
  const gap = (W - PAD * 2) / data.length;
  const BAR_W = Math.max(12, gap * 0.3);

  return (
    <svg
      viewBox={`0 0 ${W} ${H + 38}`}
      className="macro-week-chart"
      role="img"
      aria-label="Historial financiero mensual"
    >
      <line
        x1={PAD}
        y1={H}
        x2={W - PAD}
        y2={H}
        stroke="var(--border)"
        strokeWidth="1"
      />
      {data.map((m, i) => {
        const cx = PAD + i * gap + gap / 2;
        const incomeH = m.income > 0 ? (m.income / maxVal) * H : 0;
        const expH = m.expenses > 0 ? (m.expenses / maxVal) * H : 0;
        const hasSavings = m.income > 0 || m.expenses > 0;
        const savColor = m.savings >= 0 ? "var(--green)" : "var(--red)";

        return (
          <g key={m.month}>
            {/* Income bar */}
            {incomeH > 0 && (
              <rect
                x={cx - BAR_W - 1}
                y={H - incomeH}
                width={BAR_W}
                height={incomeH}
                fill="rgba(96,165,250,0.5)"
                rx="3"
              />
            )}
            {/* Expense bar */}
            {expH > 0 && (
              <rect
                x={cx + 1}
                y={H - expH}
                width={BAR_W}
                height={expH}
                fill="rgba(248,113,113,0.5)"
                rx="3"
              />
            )}
            {/* Month label */}
            <text
              x={cx}
              y={H + 16}
              textAnchor="middle"
              fill="rgba(150,163,144,0.85)"
              fontSize="11"
            >
              {m.label}
            </text>
            {/* Savings */}
            {hasSavings && (
              <text
                x={cx}
                y={H + 30}
                textAnchor="middle"
                fill={savColor}
                fontSize="9"
                fontWeight="600"
              >
                {m.savings >= 0 ? "+" : ""}
                {m.savings}€
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function StatsWeightChart({ entries }: { entries: WeightEntry[] }) {
  const weights = entries.map((e) => e.kg);
  const minKg = Math.min(...weights) - 0.8;
  const maxKg = Math.max(...weights) + 0.8;
  const range = maxKg - minKg || 1;
  const W = 500, H = 80;
  const xOf = (i: number) => (i / Math.max(entries.length - 1, 1)) * W;
  const yOf = (kg: number) => H - ((kg - minKg) / range) * H;

  const linePath = entries
    .map((e, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(e.kg).toFixed(1)}`)
    .join(" ");
  const last = entries[entries.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="weight-chart"
      role="img"
      aria-label="Evolución del peso"
    >
      <path
        d={`${linePath} L${xOf(entries.length - 1).toFixed(1)},${H} L0,${H} Z`}
        fill="rgba(74,222,128,0.07)"
      />
      <path d={linePath} fill="none" stroke="var(--green)" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={xOf(entries.length - 1)} cy={yOf(last.kg)} r="4" fill="var(--green)" />
      <text
        x={Math.min(xOf(entries.length - 1), W - 32)}
        y={Math.max(yOf(last.kg) - 7, 12)}
        textAnchor="middle"
        fill="var(--green)"
        fontSize="11"
        fontWeight="600"
      >
        {last.kg} kg
      </text>
    </svg>
  );
}

function StatsMacroChart({
  data,
  targetKcal,
  targetProtein,
}: {
  data: Array<{ date: string; kcal: number; protein: number }>;
  targetKcal: number;
  targetProtein: number;
}) {
  const W = 700, H = 90, PAD = 10;
  const days = data.length;
  const gap = (W - PAD * 2) / days;
  const barW = Math.max(8, gap * 0.52);
  const DAY_LABELS = ["D", "L", "M", "X", "J", "V", "S"];

  return (
    <svg
      viewBox={`0 0 ${W} ${H + 22}`}
      className="macro-week-chart"
      role="img"
      aria-label="28 días de evolución de macros"
    >
      <line
        x1={PAD}
        y1={1}
        x2={W - PAD}
        y2={1}
        stroke="rgba(74,222,128,0.25)"
        strokeWidth="1"
        strokeDasharray="4 3"
      />
      {data.map((day, i) => {
        const kcalPct = targetKcal > 0 ? Math.min(1, day.kcal / targetKcal) : 0;
        const protPct = targetProtein > 0 ? Math.min(1, day.protein / targetProtein) : 0;
        const x = PAD + i * gap + (gap - barW) / 2;
        const dateObj = new Date(`${day.date}T12:00:00`);
        const dow = dateObj.getDay();
        const showLabel = i === 0 || dow === 1;

        return (
          <g key={day.date}>
            <rect
              x={x}
              y={H - kcalPct * H}
              width={barW}
              height={kcalPct * H}
              fill="rgba(59,130,246,0.28)"
              rx="2"
            />
            <rect
              x={x + barW * 0.18}
              y={H - protPct * H}
              width={barW * 0.64}
              height={protPct * H}
              fill="var(--green)"
              rx="1"
            />
            {showLabel && (
              <text
                x={x + barW / 2}
                y={H + 16}
                textAnchor="middle"
                fill="rgba(150,163,144,0.75)"
                fontSize="9"
              >
                {DAY_LABELS[dow]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
