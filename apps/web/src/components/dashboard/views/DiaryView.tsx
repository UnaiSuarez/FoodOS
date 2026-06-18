"use client";

import { useState } from "react";
import type { MealType } from "@foodos/types";
import { actions, getLogByDay, getWaterToday, useFoodOS } from "@/lib/state";
import { todayPlus } from "@/lib/utils";

const WATER_GOAL_ML = 2500;
const SOURCE_ICONS: Record<string, string> = { recipe: "🍽", inventory: "🥕", manual: "✎" };

const MEAL_CHIPS: Record<MealType, { label: string; cls: string }> = {
  breakfast: { label: "🌅 Desayuno", cls: "breakfast" },
  lunch:     { label: "☀️ Comida",   cls: "lunch" },
  snack:     { label: "🌤 Snack",    cls: "snack" },
  dinner:    { label: "🌙 Cena",     cls: "dinner" },
};

function formatDay(date: string): string {
  if (date === todayPlus(0)) return "Hoy";
  if (date === todayPlus(-1)) return "Ayer";
  return new Date(`${date}T12:00:00`).toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function DiaryView() {
  const { state, mutate, showToast } = useFoodOS();
  const waterToday = getWaterToday(state);
  const waterPct = Math.min(100, Math.round((waterToday / WATER_GOAL_ML) * 100));
  const days = getLogByDay(state);
  const today = todayPlus(0);
  const hasToday = days.some((day) => day.date === today);
  const [editingMealTypeId, setEditingMealTypeId] = useState<string | null>(null);

  return (
    <section className="view">
      {/* Agua de hoy */}
      <article className="panel water-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Hidratación</p>
            <h2>
              💧 {(waterToday / 1000).toFixed(2).replace(".", ",")} L{" "}
              <small>de {(WATER_GOAL_ML / 1000).toFixed(1).replace(".", ",")} L</small>
            </h2>
          </div>
          <div className="water-actions">
            <button className="secondary-button" onClick={() => { mutate((draft) => actions.addWater(draft, 250)); showToast("+250 ml de agua"); }}>
              + Vaso (250 ml)
            </button>
            <button className="secondary-button" onClick={() => { mutate((draft) => actions.addWater(draft, 500)); showToast("+500 ml de agua"); }}>
              + Botella (500 ml)
            </button>
            <button
              className="text-button"
              disabled={waterToday <= 0}
              onClick={() => { mutate((draft) => actions.addWater(draft, -250)); showToast("-250 ml"); }}
            >
              Deshacer
            </button>
          </div>
        </div>
        <div className="water-track">
          <i style={{ width: `${waterPct}%` }} />
        </div>
        <div className="water-glasses" aria-hidden="true">
          {Array.from({ length: 10 }).map((_, index) => (
            <span key={index} className={waterToday >= (index + 1) * 250 ? "full" : ""}>
              💧
            </span>
          ))}
        </div>
      </article>

      {/* Diario por dias */}
      {days.length === 0 && (
        <article className="panel">
          <div className="empty">
            Tu diario está vacío. Cocina una receta, usa un alimento del inventario o carga los
            datos demo (botón ↻ arriba).
          </div>
        </article>
      )}

      {!hasToday && days.length > 0 && (
        <article className="panel diary-day">
          <div className="panel-head">
            <h3>Hoy</h3>
            <span className="badge">sin comidas todavía</span>
          </div>
          <div className="empty">Registra tu primera comida del día desde Recetas o Inventario.</div>
        </article>
      )}

      {days.map((day) => (
        <article key={day.date} className="panel diary-day">
          <div className="panel-head">
            <h3 className="diary-date">{formatDay(day.date)}</h3>
            <div className="diary-totals">
              <span className="badge green">{Math.round(day.totals.kcal)} kcal</span>
              <span className="badge">{Math.round(day.totals.protein)}g prot</span>
              <span className="badge">{Math.round(day.totals.carbs)}g carb</span>
              <span className="badge">{Math.round(day.totals.fat)}g grasa</span>
              <span className="badge blue">💧 {(day.water / 1000).toFixed(2).replace(".", ",")} L</span>
            </div>
          </div>

          {day.entries.length ? (
            <ul className="diary-list">
              {day.entries.map((entry) => (
                <li key={entry.id}>
                  <span className="diary-time">{entry.time}</span>
                  <span className="diary-icon">{SOURCE_ICONS[entry.source] ?? "🍽"}</span>
                  <div className="diary-meal">
                    <div className="diary-meal-head">
                      <strong>{entry.name}</strong>
                      {editingMealTypeId === entry.id ? (
                        <span className="meal-type-picker">
                          {(Object.keys(MEAL_CHIPS) as MealType[]).map((type) => (
                            <button
                              key={type}
                              className={`meal-chip ${MEAL_CHIPS[type].cls} ${entry.mealType === type ? "active" : ""}`}
                              onClick={() => {
                                mutate((draft) => {
                                  const e = draft.foodLog.find((x) => x.id === entry.id);
                                  if (e) e.mealType = type;
                                });
                                setEditingMealTypeId(null);
                              }}
                            >
                              {MEAL_CHIPS[type].label}
                            </button>
                          ))}
                        </span>
                      ) : (
                        entry.mealType && (
                          <button
                            className={`meal-chip ${MEAL_CHIPS[entry.mealType]?.cls ?? ""}`}
                            title="Cambiar tipo de comida"
                            onClick={() => setEditingMealTypeId(entry.id)}
                          >
                            {MEAL_CHIPS[entry.mealType]?.label ?? entry.mealType}
                          </button>
                        )
                      )}
                    </div>
                    <small>
                      {entry.qty != null ? `${entry.qty} ${entry.unit} · ` : ""}
                      {Math.round(entry.kcal)} kcal · {entry.protein}g P · {entry.carbs}g C · {entry.fat}g G
                    </small>
                  </div>
                  <button
                    className="small-action bad"
                    aria-label={`Borrar ${entry.name}`}
                    onClick={() => {
                      mutate((draft) => {
                        draft.foodLog = draft.foodLog.filter((candidate) => candidate.id !== entry.id);
                      });
                      showToast("Comida eliminada del diario");
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">Solo agua registrada este día.</div>
          )}
        </article>
      ))}
    </section>
  );
}
