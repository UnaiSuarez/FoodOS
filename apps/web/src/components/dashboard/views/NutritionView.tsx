"use client";

import { useState, type FormEvent } from "react";
import type { ActivityLevel, GoalMode, PhysicalProfile, Sex } from "@foodos/types";
import { actions, bestRecipe, useFoodOS } from "@/lib/state";
import {
  ACTIVITY_LABELS,
  GOAL_DESCRIPTIONS,
  GOAL_LABELS,
  calcDailyTargets,
  calcSummary,
  isGymDay,
  weeklyCycle,
} from "@/lib/nutrition";

const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "L" },
  { value: 2, label: "M" },
  { value: 3, label: "X" },
  { value: 4, label: "J" },
  { value: 5, label: "V" },
  { value: 6, label: "S" },
  { value: 0, label: "D" },
];

export function NutritionView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [editing, setEditing] = useState(false);

  const showForm = !state.profile || editing;

  return (
    <section className="view">
      <div className="work-grid">
        {showForm ? (
          <ProfileForm
            onSaved={() => {
              setEditing(false);
              setMascotMessage("Perfil guardado. Tus objetivos diarios ya se calculan solos.");
              showToast("Perfil actualizado: objetivos recalculados");
            }}
          />
        ) : (
          <ProfileSummary onEdit={() => setEditing(true)} />
        )}

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

// ---------- Onboarding / edicion de perfil fisico (PDF §9.1) ----------

function ProfileForm({ onSaved }: { onSaved: () => void }) {
  const { state, mutate } = useFoodOS();
  const profile = state.profile;
  const [goal, setGoal] = useState<GoalMode>(profile?.goal ?? "recomp");
  const [gymDays, setGymDays] = useState<number[]>(profile?.gymDays ?? [1, 3, 5]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parseList = (value: string) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    const bodyFatRaw = String(data.get("bodyFat")).trim();
    const next: PhysicalProfile = {
      age: Number(data.get("age")),
      sex: String(data.get("sex")) as Sex,
      heightCm: Number(data.get("height")),
      weightKg: Number(data.get("weight")),
      bodyFatPct: bodyFatRaw ? Number(bodyFatRaw) : null,
      activityLevel: String(data.get("activity")) as ActivityLevel,
      goal,
      gymDays,
      allergies: parseList(String(data.get("allergies"))),
      excludedFoods: parseList(String(data.get("excluded"))),
    };
    mutate((draft) => {
      draft.profile = next;
    });
    onSaved();
  }

  return (
    <form className="panel form-panel" onSubmit={save}>
      <p className="eyebrow">{profile ? "Editar perfil" : "Configura tu perfil"}</p>
      <h2>{profile ? "Tu perfil físico" : "Cuéntanos tu objetivo"}</h2>
      <p className="form-intro">
        Con estos datos FoodOS calcula tus calorías y macros diarios (fórmula Mifflin-St Jeor) y los
        ajusta cada día según si entrenas o descansas.
      </p>

      <div className="form-grid">
        <label>
          Edad <input name="age" type="number" min="14" max="100" required defaultValue={profile?.age ?? 25} />
        </label>
        <label>
          Sexo biológico
          <select name="sex" defaultValue={profile?.sex ?? "male"}>
            <option value="male">Hombre</option>
            <option value="female">Mujer</option>
          </select>
        </label>
        <label>
          Altura (cm)
          <input name="height" type="number" min="120" max="230" required defaultValue={profile?.heightCm ?? 175} />
        </label>
        <label>
          Peso (kg)
          <input name="weight" type="number" min="35" max="250" step="0.1" required defaultValue={profile?.weightKg ?? 75} />
        </label>
        <label>
          % graso <small>(opcional)</small>
          <input name="bodyFat" type="number" min="3" max="60" step="0.1" defaultValue={profile?.bodyFatPct ?? ""} placeholder="—" />
        </label>
        <label>
          Nivel de actividad
          <select name="activity" defaultValue={profile?.activityLevel ?? "moderate"}>
            {(Object.keys(ACTIVITY_LABELS) as ActivityLevel[]).map((level) => (
              <option key={level} value={level}>
                {ACTIVITY_LABELS[level]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="goal-options">
        <legend>Objetivo corporal</legend>
        {(Object.keys(GOAL_LABELS) as GoalMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`goal-option ${goal === mode ? "active" : ""}`}
            onClick={() => setGoal(mode)}
          >
            <strong>{GOAL_LABELS[mode]}</strong>
            <small>{GOAL_DESCRIPTIONS[mode]}</small>
          </button>
        ))}
      </fieldset>

      <fieldset className="gym-days">
        <legend>Días de entrenamiento</legend>
        <div className="day-toggles">
          {WEEKDAYS.map((day) => (
            <button
              key={day.value}
              type="button"
              className={`day-toggle ${gymDays.includes(day.value) ? "active" : ""}`}
              aria-pressed={gymDays.includes(day.value)}
              onClick={() =>
                setGymDays((current) =>
                  current.includes(day.value)
                    ? current.filter((value) => value !== day.value)
                    : [...current, day.value]
                )
              }
            >
              {day.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="form-grid compact">
        <label>
          Alergias <small>(separadas por comas)</small>
          <input name="allergies" placeholder="lactosa, frutos secos" defaultValue={profile?.allergies.join(", ") ?? ""} />
        </label>
        <label>
          Alimentos que no quieres <small>(separados por comas)</small>
          <input name="excluded" placeholder="cilantro, hígado" defaultValue={profile?.excludedFoods.join(", ") ?? ""} />
        </label>
      </div>

      <button className="primary-button" type="submit">
        {profile ? "Guardar cambios" : "Calcular mis objetivos"}
      </button>
    </form>
  );
}

// ---------- Resumen del perfil y ciclo semanal ----------

function ProfileSummary({ onEdit }: { onEdit: () => void }) {
  const { state } = useFoodOS();
  const profile = state.profile!;
  const { tmb, tdee } = calcSummary(profile);
  const gymToday = isGymDay(profile);
  const today = calcDailyTargets(profile, gymToday);
  const cycle = weeklyCycle(profile);

  return (
    <article className="panel form-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Objetivo: {GOAL_LABELS[profile.goal]}</p>
          <h2>Tu plan diario</h2>
        </div>
        <button className="secondary-button" onClick={onEdit}>
          Editar perfil
        </button>
      </div>

      <div className="meta-row" style={{ marginBottom: 14 }}>
        <span className={`badge ${gymToday ? "green" : "blue"}`}>
          Hoy: {gymToday ? "día de gym 💪" : "día de descanso"}
        </span>
        <span className="badge">
          {profile.weightKg} kg · {profile.heightCm} cm · {profile.age} años
        </span>
      </div>

      <div className="nutrition-totals">
        <div>
          <span>TMB</span>
          <strong>{tmb}</strong>
          <small>kcal en reposo</small>
        </div>
        <div>
          <span>TDEE</span>
          <strong>{tdee}</strong>
          <small>kcal de mantenimiento</small>
        </div>
        <div>
          <span>Objetivo hoy</span>
          <strong>{today.kcal}</strong>
          <small>kcal ({today.kcal - tdee >= 0 ? "+" : ""}{today.kcal - tdee} vs TDEE)</small>
        </div>
        <div>
          <span>Proteína</span>
          <strong>{today.protein}g</strong>
          <small>
            {profile.bodyFatPct != null ? "afinada con masa magra" : `${(today.protein / profile.weightKg).toFixed(1)} g/kg`}
          </small>
        </div>
      </div>

      <div className="cycle-card">
        <h3>Tu semana ({profile.gymDays.length} días de gym)</h3>
        <div className="cycle-grid">
          {cycle.map(({ day, targets }) => (
            <div key={day} className={`cycle-day ${targets.dayType === "gym" ? "gym" : ""}`}>
              <span>{day}</span>
              <strong>{targets.kcal}</strong>
              <small>{targets.dayType === "gym" ? "gym" : "descanso"}</small>
            </div>
          ))}
        </div>
        {profile.goal === "recomp" && (
          <p className="cycle-note">
            Recomposición: ligero superávit los días de gym para construir músculo y ligero déficit
            en descanso para oxidar grasa. La media semanal queda casi neutra.
          </p>
        )}
      </div>

      {(profile.allergies.length > 0 || profile.excludedFoods.length > 0) && (
        <div className="meta-row">
          {profile.allergies.map((item) => (
            <span key={item} className="badge red">
              ⚠ {item}
            </span>
          ))}
          {profile.excludedFoods.map((item) => (
            <span key={item} className="badge">
              sin {item}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
