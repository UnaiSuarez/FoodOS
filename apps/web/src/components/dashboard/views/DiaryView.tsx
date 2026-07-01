"use client";

import { useState } from "react";
import type { FoodLogEntry, MealType } from "@foodos/types";
import { actions, getLogByDay, getToday, getWaterToday, useFoodOS } from "@/lib/state";
import { dateOffset } from "@/lib/utils";
import { DiaryEntryDetailModal } from "../DiaryEntryDetailModal";
import { EditLogModal } from "../EditLogModal";
import { LogMealModal } from "../LogMealModal";

// Valor por defecto; se reemplaza con state.settings.waterGoalMl en el componente.
const WATER_GOAL_DEFAULT = 2500;
const SOURCE_ICONS: Record<string, string> = { recipe: "🍽", inventory: "🥕", manual: "🥘" };

const MEAL_CHIPS: Record<MealType, { label: string; cls: string }> = {
  breakfast: { label: "🌅 Desayuno", cls: "breakfast" },
  lunch:     { label: "☀️ Comida",   cls: "lunch" },
  snack:     { label: "🌤 Snack",    cls: "snack" },
  dinner:    { label: "🌙 Cena",     cls: "dinner" },
};

function formatDay(date: string, today: string): string {
  if (date === today) return "Hoy";
  if (date === dateOffset(today, -1)) return "Ayer";
  return new Date(`${date}T12:00:00`).toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function DiaryView() {
  const { state, mutate, addWater, showToast } = useFoodOS();
  const WATER_GOAL_ML = state.settings?.waterGoalMl ?? WATER_GOAL_DEFAULT;
  const waterToday = getWaterToday(state);
  const waterPct = Math.min(100, Math.round((waterToday / WATER_GOAL_ML) * 100));
  const days = getLogByDay(state);
  const today = getToday(state);
  const hasToday = days.some((day) => day.date === today);
  const [editingMealTypeId, setEditingMealTypeId] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<FoodLogEntry | null>(null);
  const [detailEntry, setDetailEntry] = useState<FoodLogEntry | null>(null);
  const [showLogMeal, setShowLogMeal] = useState(false);

  return (
    <section className="view">
      {/* Registro de comida */}
      <div className="diary-log-btn-wrap">
        <button className="primary-button diary-log-btn" onClick={() => setShowLogMeal(true)}>
          + ¿Qué has comido?
        </button>
      </div>

      {/* Agua de hoy */}
      <article className="panel water-panel" data-tour="diary-log">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Hidratación</p>
            <h2>
              💧 {(waterToday / 1000).toFixed(2).replace(".", ",")} L{" "}
              <small>de {(WATER_GOAL_ML / 1000).toFixed(1).replace(".", ",")} L</small>
            </h2>
          </div>
          <div className="water-actions">
            <button className="secondary-button" onClick={() => { addWater(250); showToast("+250 ml de agua"); }}>
              + Vaso (250 ml)
            </button>
            <button className="secondary-button" onClick={() => { addWater(500); showToast("+500 ml de agua"); }}>
              + Botella (500 ml)
            </button>
            <button
              className="text-button"
              disabled={waterToday <= 0}
              onClick={() => { addWater(-250); showToast("-250 ml"); }}
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
            <h3 className="diary-date">{formatDay(day.date, today)}</h3>
            <div className="diary-totals">
              <span className="badge green">{Math.round(day.totals.kcal)} kcal</span>
              <span className="badge">{Math.round(day.totals.protein)}g prot</span>
              <span className="badge">{Math.round(day.totals.carbs)}g carb</span>
              <span className="badge">{Math.round(day.totals.fat)}g grasa</span>
              <span className="badge blue">💧 {(day.water / 1000).toFixed(2).replace(".", ",")} L</span>
            </div>
          </div>

          {day.entries.length ? (
            <>
              {(Object.keys(MEAL_CHIPS) as MealType[])
                .map((mealType) => {
                  const group = day.entries.filter((e) => e.mealType === mealType);
                  if (group.length === 0) return null;
                  const groupKcal = Math.round(group.reduce((s, e) => s + e.kcal, 0));
                  const groupProtein = Math.round(group.reduce((s, e) => s + e.protein, 0));
                  return (
                    <div key={mealType} className="diary-meal-group">
                      <div className="diary-meal-group-head">
                        <span className={`meal-chip ${MEAL_CHIPS[mealType].cls} active`}>
                          {MEAL_CHIPS[mealType].label}
                        </span>
                        <span className="diary-group-totals">
                          {groupKcal} kcal · {groupProtein}g prot
                        </span>
                      </div>
                      <ul className="diary-list">
                        {group.map((entry) => (
                          <li key={entry.id}>
                            <span className="diary-time">{entry.time}</span>
                            <span className="diary-icon">{SOURCE_ICONS[entry.source] ?? "🍽"}</span>
                            <div className="diary-meal">
                              <div className="diary-meal-head">
                                <strong
                                  className="diary-entry-name-link"
                                  onClick={() => setDetailEntry(entry)}
                                  title="Ver detalle"
                                >
                                  {entry.name}
                                </strong>
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
                                  <button
                                    className={`meal-chip ${MEAL_CHIPS[mealType]?.cls ?? ""}`}
                                    title="Cambiar tipo de comida"
                                    onClick={() => setEditingMealTypeId(entry.id)}
                                  >
                                    {MEAL_CHIPS[mealType]?.label ?? mealType}
                                  </button>
                                )}
                              </div>
                              <small>
                                {entry.qty != null ? `${entry.qty} ${entry.unit} · ` : ""}
                                {Math.round(entry.kcal)} kcal · {entry.protein}g P · {entry.carbs}g C · {entry.fat}g G
                              </small>
                            </div>
                            <button
                              className="small-action"
                              aria-label={`Editar ${entry.name}`}
                              title="Editar cantidad"
                              onClick={() => setEditingEntry(entry)}
                            >
                              ✎
                            </button>
                            <button
                              className="small-action bad"
                              aria-label={`Borrar ${entry.name}`}
                              onClick={() => {
                                let restored = false;
                                mutate((draft) => {
                                  restored = actions.returnEntryToInventory(draft, entry);
                                  draft.foodLog = draft.foodLog.filter((c) => c.id !== entry.id);
                                });
                                showToast(restored ? "Comida eliminada · cantidad devuelta al inventario" : "Comida eliminada");
                              }}
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
            </>
          ) : (
            <div className="empty">Solo agua registrada este día.</div>
          )}
        </article>
      ))}
      {detailEntry && (
        <DiaryEntryDetailModal
          entry={detailEntry}
          onClose={() => setDetailEntry(null)}
          onEdit={() => { setEditingEntry(detailEntry); setDetailEntry(null); }}
        />
      )}
      {editingEntry && <EditLogModal entry={editingEntry} onClose={() => setEditingEntry(null)} />}
      {showLogMeal && <LogMealModal onClose={() => setShowLogMeal(false)} />}
    </section>
  );
}
