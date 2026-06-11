"use client";

import { type FormEvent } from "react";
import type { NutritionMode } from "@foodos/types";
import { actions, bestRecipe, useFoodOS } from "@/lib/state";

const MODES: NutritionMode[] = ["Recomposicion", "Perdida de grasa", "Ganancia muscular", "Mantenimiento"];

export function NutritionView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();

  function updateGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutate((draft) => {
      draft.nutrition = {
        kcal: Number(data.get("kcal")),
        protein: Number(data.get("protein")),
        carbs: Number(data.get("carbs")),
        fat: Number(data.get("fat")),
        mode: String(data.get("mode")) as NutritionMode,
      };
    });
    setMascotMessage(`Objetivo actualizado: ${String(data.get("mode"))}.`);
    showToast("Objetivo nutricional actualizado");
  }

  return (
    <section className="view">
      <div className="work-grid">
        <form className="panel form-panel" onSubmit={updateGoal} key={JSON.stringify(state.nutrition)}>
          <h2>Objetivo nutricional</h2>
          <div className="form-grid">
            <label>
              kcal objetivo <input name="kcal" type="number" min="1000" defaultValue={state.nutrition.kcal} />
            </label>
            <label>
              Proteína g <input name="protein" type="number" min="20" defaultValue={state.nutrition.protein} />
            </label>
            <label>
              Carbos g <input name="carbs" type="number" min="20" defaultValue={state.nutrition.carbs} />
            </label>
            <label>
              Grasas g <input name="fat" type="number" min="10" defaultValue={state.nutrition.fat} />
            </label>
            <label>
              Objetivo
              <select name="mode" defaultValue={state.nutrition.mode}>
                {MODES.map((mode) => (
                  <option key={mode}>{mode}</option>
                ))}
              </select>
            </label>
          </div>
          <button className="primary-button" type="submit">
            Actualizar objetivo
          </button>
        </form>

        <article className="panel">
          <div className="panel-head">
            <h2>Consumido hoy</h2>
            <button
              className="secondary-button"
              onClick={() => {
                const recipe = bestRecipe(state);
                mutate((draft) => actions.cookRecipe(draft, recipe));
                showToast("Receta registrada en nutrición");
              }}
            >
              Registrar receta
            </button>
          </div>

          <div className="nutrition-totals">
            <div>
              <span>kcal</span>
              <strong>{Math.round(state.consumed.kcal)}</strong>
              <small>de {state.nutrition.kcal}</small>
            </div>
            <div>
              <span>Proteína</span>
              <strong>{Math.round(state.consumed.protein)}g</strong>
              <small>de {state.nutrition.protein}g</small>
            </div>
            <div>
              <span>Carbos</span>
              <strong>{Math.round(state.consumed.carbs)}g</strong>
              <small>de {state.nutrition.carbs}g</small>
            </div>
            <div>
              <span>Grasas</span>
              <strong>{Math.round(state.consumed.fat)}g</strong>
              <small>de {state.nutrition.fat}g</small>
            </div>
          </div>

          <div className="meal-list">
            {state.consumedMeals.length ? (
              state.consumedMeals.map((meal) => (
                <article key={meal.id} className="meal-item">
                  <span className="meal-icon">{meal.icon || "🍽"}</span>
                  <div>
                    <h3>{meal.name}</h3>
                    <p>
                      {meal.kcal} kcal · {meal.protein}g prot · {meal.carbs}g carb · {meal.fat}g grasa
                    </p>
                  </div>
                  <button
                    className="small-action bad"
                    onClick={() =>
                      mutate((draft) => {
                        const target = draft.consumedMeals.find((candidate) => candidate.id === meal.id);
                        if (target) {
                          draft.consumed.kcal = Math.max(0, draft.consumed.kcal - target.kcal);
                          draft.consumed.protein = Math.max(0, draft.consumed.protein - target.protein);
                          draft.consumed.carbs = Math.max(0, draft.consumed.carbs - target.carbs);
                          draft.consumed.fat = Math.max(0, draft.consumed.fat - target.fat);
                        }
                        draft.consumedMeals = draft.consumedMeals.filter((candidate) => candidate.id !== meal.id);
                      })
                    }
                  >
                    Borrar
                  </button>
                </article>
              ))
            ) : (
              <div className="empty">Todavía no has registrado comidas hoy.</div>
            )}
          </div>

          <button
            className="secondary-button"
            onClick={() => {
              mutate((draft) => {
                draft.consumed = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
                draft.consumedMeals = [];
              });
              showToast("Día nutricional reiniciado");
            }}
          >
            Reiniciar día
          </button>
        </article>
      </div>
    </section>
  );
}
