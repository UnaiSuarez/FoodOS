"use client";

import { useState, type FormEvent } from "react";
import type { ActivityLevel, GoalMode, PhysicalProfile, Sex, WeightEntry } from "@foodos/types";
import {
  actions,
  bestRecipe,
  countLowProteinDays,
  findRecipe,
  getAdherenceStreak,
  getConsumedToday,
  getLatestWeight,
  getMacroAdherenceHistory,
  getProteinRanking,
  getTodayLog,
  getWeeklyMacroHistory,
  useFoodOS,
} from "@/lib/state";
import {
  ACTIVITY_LABELS,
  GOAL_DESCRIPTIONS,
  GOAL_LABELS,
  calcDailyTargets,
  calcProteinRange,
  calcSummary,
  isGymDay,
  shouldWarnMuscleGain,
  weeklyCycle,
} from "@/lib/nutrition";
import { todayMinus, todayPlus } from "@/lib/utils";

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

        <TodayRingPanel />
      </div>

      {state.profile && <MacroWeekChart />}

      {state.profile && <MacroAdherencePanel />}

      {state.profile && <ProteinOptimizerPanel />}

      {state.profile && <WeightPanel />}

      {state.profile && <WeightProjectionPanel />}
    </section>
  );
}

// ---------- Consumido hoy (deriva del diario, vista Registro) ----------

function NutritionToday() {
  const { state, mutate, showToast } = useFoodOS();
  const consumed = getConsumedToday(state);
  const todayLog = getTodayLog(state);

  return (
    <>
      <div className="nutrition-totals">
        <div>
          <span>kcal</span>
          <strong>{Math.round(consumed.kcal)}</strong>
          <small>de {state.nutrition.kcal}</small>
        </div>
        <div>
          <span>Proteína</span>
          <strong>{Math.round(consumed.protein)}g</strong>
          <small>de {state.nutrition.protein}g</small>
        </div>
        <div>
          <span>Carbos</span>
          <strong>{Math.round(consumed.carbs)}g</strong>
          <small>de {state.nutrition.carbs}g</small>
        </div>
        <div>
          <span>Grasas</span>
          <strong>{Math.round(consumed.fat)}g</strong>
          <small>de {state.nutrition.fat}g</small>
        </div>
      </div>

      <div className="meal-list">
        {todayLog.length ? (
          todayLog.map((entry) => (
            <article key={entry.id} className="meal-item">
              <span className="meal-icon">{entry.source === "inventory" ? "🥕" : "🍽"}</span>
              <div>
                <h3>{entry.name}</h3>
                <p>
                  {entry.time} · {entry.qty != null ? `${entry.qty} ${entry.unit} · ` : ""}
                  {Math.round(entry.kcal)} kcal · {entry.protein}g prot · {entry.carbs}g carb · {entry.fat}g grasa
                </p>
              </div>
              <button
                className="small-action bad"
                onClick={() =>
                  mutate((draft) => {
                    draft.foodLog = draft.foodLog.filter((candidate) => candidate.id !== entry.id);
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
            const today = new Date().toISOString().slice(0, 10);
            draft.foodLog = draft.foodLog.filter((entry) => entry.date !== today);
          });
          showToast("Día nutricional reiniciado");
        }}
      >
        Reiniciar día
      </button>
    </>
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
    const targetWeightRaw = String(data.get("targetWeight")).trim();
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
      targetWeightKg: targetWeightRaw ? Number(targetWeightRaw) : undefined,
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
          Peso objetivo kg <small>(opcional)</small>
          <input name="targetWeight" type="number" min="30" max="250" step="0.1" defaultValue={profile?.targetWeightKg ?? ""} placeholder="—" />
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

// ---------- Historial de peso (Feature 1) ----------

function WeightPanel() {
  const { state, mutate, showToast } = useFoodOS();
  const latest = getLatestWeight(state);
  const target = state.profile?.targetWeightKg;
  const [inputKg, setInputKg] = useState(String(latest?.kg ?? state.profile?.weightKg ?? ""));

  const sorted = [...state.weightLog].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);

  return (
    <article className="panel weight-panel-section">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Evolución</p>
          <h2>Peso corporal</h2>
        </div>
        <div className="weight-log-form">
          <input
            type="number"
            min="30"
            max="250"
            step="0.1"
            value={inputKg}
            onChange={(e) => setInputKg(e.target.value)}
            placeholder="kg de hoy"
            className="weight-input"
          />
          <button
            className="secondary-button"
            onClick={() => {
              const kg = parseFloat(inputKg);
              if (!kg || kg < 30 || kg > 300) return;
              mutate((draft) => actions.logWeight(draft, kg));
              showToast(`Peso registrado: ${kg} kg`);
            }}
          >
            Guardar hoy
          </button>
        </div>
      </div>

      {sorted.length >= 2 ? (
        <WeightChart entries={sorted} target={target} />
      ) : (
        <p className="empty">Registra tu peso al menos 2 días para ver la gráfica.</p>
      )}

      {latest && (
        <div className="meta-row" style={{ marginTop: 10 }}>
          <span className="badge green">
            Último: {latest.kg} kg ({latest.date === todayPlus(0) ? "hoy" : latest.date})
          </span>
          {target && (
            <span className="badge amber">
              Objetivo: {target} kg (
              {latest.kg > target
                ? `faltan ${Math.round((latest.kg - target) * 10) / 10} kg`
                : latest.kg < target
                  ? `+${Math.round((target - latest.kg) * 10) / 10} kg por ganar`
                  : "¡objetivo alcanzado! ✓"}
              )
            </span>
          )}
        </div>
      )}
    </article>
  );
}

function WeightChart({ entries, target }: { entries: WeightEntry[]; target?: number }) {
  const weights = entries.map((e) => e.kg);
  const all = target ? [...weights, target] : weights;
  const minKg = Math.min(...all) - 0.8;
  const maxKg = Math.max(...all) + 0.8;
  const range = maxKg - minKg || 1;
  const W = 500, H = 90;

  const xOf = (i: number) => (i / Math.max(entries.length - 1, 1)) * W;
  const yOf = (kg: number) => H - ((kg - minKg) / range) * H;

  const linePath = entries
    .map((e, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(e.kg).toFixed(1)}`)
    .join(" ");

  const last = entries[entries.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="weight-chart" role="img" aria-label="Evolución del peso">
      {/* Área bajo la línea */}
      <path
        d={`${linePath} L${xOf(entries.length - 1).toFixed(1)},${H} L0,${H} Z`}
        fill="rgba(74,222,128,0.07)"
      />
      {/* Línea de objetivo */}
      {target && (
        <line
          x1="0" y1={yOf(target)} x2={W} y2={yOf(target)}
          stroke="var(--amber)" strokeWidth="1.2" strokeDasharray="5 3"
        />
      )}
      {/* Línea de peso */}
      <path d={linePath} fill="none" stroke="var(--green)" strokeWidth="2" strokeLinejoin="round" />
      {/* Punto final */}
      <circle cx={xOf(entries.length - 1)} cy={yOf(last.kg)} r="4" fill="var(--green)" />
      <text
        x={Math.min(xOf(entries.length - 1), W - 30)}
        y={yOf(last.kg) - 7}
        textAnchor="middle"
        fill="var(--green)"
        fontSize="11"
        fontWeight="600"
      >
        {last.kg} kg
      </text>
      {/* Etiqueta objetivo */}
      {target && (
        <text x={W - 2} y={yOf(target) - 4} textAnchor="end" fill="var(--amber)" fontSize="9">
          objetivo {target} kg
        </text>
      )}
    </svg>
  );
}

// ---------- Gráfica semanal de macros (analytics) ----------

function MacroWeekChart() {
  const { state } = useFoodOS();
  const history = getWeeklyMacroHistory(state, 7);
  const targetKcal = state.nutrition.kcal || 2000;
  const targetProtein = state.nutrition.protein || 150;

  const W = 560, H = 100, PAD = 20;
  const gap = (W - PAD * 2) / 7;
  const BAR_W = Math.max(20, gap * 0.55);
  const DAY_LABELS = ["L", "M", "X", "J", "V", "S", "D"];

  return (
    <article className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Últimos 7 días</p>
          <h2>Evolución de macros</h2>
        </div>
        <div className="meta-row">
          <span className="badge green" style={{ fontSize: 11 }}>■ Proteína</span>
          <span className="badge blue" style={{ fontSize: 11 }}>■ Kcal</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H + 28}`}
        className="macro-week-chart"
        role="img"
        aria-label="Evolución semanal de macros"
      >
        {/* Línea objetivo 100% */}
        <line x1={PAD} y1={1} x2={W - PAD} y2={1} stroke="rgba(74,222,128,0.25)" strokeWidth="1" strokeDasharray="4 3" />
        {history.map((day, i) => {
          const kcalPct = Math.min(1, day.kcal / targetKcal);
          const protPct = Math.min(1, day.protein / targetProtein);
          const x = PAD + i * gap + (gap - BAR_W) / 2;
          const barKcalH = kcalPct * H;
          const barProtH = protPct * H;
          const dateObj = new Date(`${day.date}T12:00:00`);
          const dow = dateObj.getDay();
          const label = DAY_LABELS[dow === 0 ? 6 : dow - 1];
          return (
            <g key={day.date}>
              <rect x={x} y={H - barKcalH} width={BAR_W} height={barKcalH} fill="rgba(59,130,246,0.28)" rx="3" />
              <rect x={x + BAR_W * 0.2} y={H - barProtH} width={BAR_W * 0.6} height={barProtH} fill="var(--green)" rx="2" />
              <text x={x + BAR_W / 2} y={H + 18} textAnchor="middle" fill="rgba(150,163,144,0.85)" fontSize="11">{label}</text>
              {day.protein > 0 && (
                <text
                  x={x + BAR_W / 2}
                  y={Math.max(11, H - barProtH - 4)}
                  textAnchor="middle"
                  fill="var(--green)"
                  fontSize="9"
                  fontWeight="600"
                >
                  {Math.round(protPct * 100)}%
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="chart-legend">
        Las barras verdes muestran % de proteína alcanzado. Las azules, % de calorías.
      </p>
    </article>
  );
}

// ---------- Panel de adherencia: racha + heatmap 28 días ----------

function MacroAdherencePanel() {
  const { state } = useFoodOS();
  const history = getMacroAdherenceHistory(state, 28);
  const streak  = getAdherenceStreak(state);

  const last7   = history.slice(-7);
  const hitDays = last7.filter((d) => d.status === "hit").length;
  const avgKcal = Math.round(
    last7.reduce((s, d) => {
      const entries = state.foodLog.filter((e) => e.date === d.date);
      return s + entries.reduce((ss, e) => ss + e.kcal, 0);
    }, 0) / Math.max(1, last7.filter((d) => d.status !== "empty").length)
  );
  const avgProt = Math.round(
    last7.reduce((s, d) => {
      const entries = state.foodLog.filter((e) => e.date === d.date);
      return s + entries.reduce((ss, e) => ss + e.protein, 0);
    }, 0) / Math.max(1, last7.filter((d) => d.status !== "empty").length)
  );

  const statusColor: Record<string, string> = {
    hit:     "var(--green)",
    partial: "var(--amber)",
    miss:    "rgba(239,68,68,0.55)",
    empty:   "rgba(150,163,144,0.15)",
  };

  return (
    <article className="panel adherence-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Constancia</p>
          <h2>Adherencia a macros</h2>
        </div>
        {streak >= 3 && (
          <span className="badge green">🔥 Racha {streak} días</span>
        )}
      </div>

      <div className="adherence-body">
        {/* Racha + stats */}
        <div className="adherence-stats">
          <div className="adherence-streak-block">
            <span className="adherence-streak-num">{streak}</span>
            <span className="adherence-streak-label">días de racha</span>
          </div>
          <div className="adherence-week-stats">
            <div className="adherence-stat">
              <span>{hitDays}/7</span>
              <small>días objetivo esta semana</small>
            </div>
            <div className="adherence-stat">
              <span>{avgKcal} kcal</span>
              <small>promedio vs {state.nutrition.kcal} objetivo</small>
            </div>
            <div className="adherence-stat">
              <span>{avgProt}g</span>
              <small>proteína promedio vs {state.nutrition.protein}g</small>
            </div>
          </div>
        </div>

        {/* Heatmap 28 días: 4 filas × 7 cols */}
        <div className="adherence-heatmap">
          {["L", "M", "X", "J", "V", "S", "D"].map((d) => (
            <span key={d} className="adherence-heatmap-header">{d}</span>
          ))}
          {history.map((day) => (
            <div
              key={day.date}
              className="adherence-cell"
              title={`${day.date}: ${day.status === "hit" ? "objetivo cumplido" : day.status === "partial" ? "parcial" : day.status === "miss" ? "no cumplido" : "sin datos"}`}
              style={{ background: statusColor[day.status] }}
            />
          ))}
        </div>

        <div className="adherence-legend">
          <span style={{ color: "var(--green)" }}>■ Cumplido</span>
          <span style={{ color: "var(--amber)" }}>■ Parcial (proteína O kcal)</span>
          <span style={{ color: "rgba(239,68,68,0.75)" }}>■ No cumplido</span>
          <span style={{ color: "rgba(150,163,144,0.5)" }}>■ Sin datos</span>
        </div>
      </div>
    </article>
  );
}

// ---------- Optimizador proteína/€ (§9.8) ----------

function ProteinOptimizerPanel() {
  const { state } = useFoodOS();
  const ranking = getProteinRanking(state);
  const lowDays = countLowProteinDays(state);

  return (
    <article className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Eficiencia</p>
          <h2>Optimizador proteína/€</h2>
        </div>
        {lowDays >= 2 && (
          <span className="badge red">⚠ Baja proteína {lowDays}/3 días</span>
        )}
      </div>

      {lowDays >= 2 && (
        <p className="optimizer-alert">
          Has estado por debajo del 80% de tu objetivo de proteína {lowDays} de los últimos 3
          días. Estas recetas son las más eficientes:
        </p>
      )}

      {ranking.length === 0 ? (
        <p className="empty">
          Añade recetas con coste y macros para ver el ranking de eficiencia proteica.
        </p>
      ) : (
        <div className="optimizer-list">
          {ranking.map((item, i) => (
            <div key={item.id} className="optimizer-row">
              <span className="optimizer-rank">{i + 1}</span>
              <span className="optimizer-name">{item.title}</span>
              <span className="optimizer-macro">{item.protein}g prot</span>
              <span className="optimizer-cost">€{item.cost.toFixed(2)}/ración</span>
              <span className={`badge ${i === 0 ? "green" : i <= 2 ? "amber" : ""}`}>
                {item.proteinPerEuro}g/€
              </span>
            </div>
          ))}
        </div>
      )}
    </article>
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
  const protRange = calcProteinRange(profile);
  const warnMuscle = shouldWarnMuscleGain(profile);

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
            {profile.bodyFatPct != null
              ? "afinada con masa magra"
              : `rango ${protRange.recommendedMin}–${protRange.recommendedMax} g`}
          </small>
        </div>
      </div>

      {warnMuscle && (
        <div className="nutrition-warn-banner">
          Tu IMC actual es superior a 27. En este punto, el superávit calórico favorece la
          acumulación de grasa más que el músculo. Te recomendamos{" "}
          <strong>Recomposición</strong> o <strong>Pérdida de grasa</strong> primero.
        </div>
      )}

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

// ---------- Anillo de kcal + barras de macros (Resumen de hoy) ----------

function TodayRingPanel() {
  const { state } = useFoodOS();
  const consumed = getConsumedToday(state);
  const targets  = state.nutrition;
  const profile  = state.profile;
  const gymToday = profile ? isGymDay(profile) : false;

  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const kcalPct = targets.kcal   > 0 ? clamp(Math.round((consumed.kcal    / targets.kcal)    * 100)) : 0;
  const protPct = targets.protein > 0 ? clamp(Math.round((consumed.protein / targets.protein) * 100)) : 0;
  const carbPct = targets.carbs   > 0 ? clamp(Math.round((consumed.carbs   / targets.carbs)   * 100)) : 0;
  const fatPct  = targets.fat     > 0 ? clamp(Math.round((consumed.fat     / targets.fat)     * 100)) : 0;

  const ringColor = kcalPct >= 90 ? "var(--amber)" : "var(--green)";
  const ringBg    = `conic-gradient(${ringColor} 0deg ${kcalPct * 3.6}deg, rgba(240,244,238,0.1) ${kcalPct * 3.6}deg 360deg)`;

  const MACROS = [
    { key: "prot",    label: "Proteína", consumed: consumed.protein, target: targets.protein, unit: "g", pct: protPct },
    { key: "carbs",   label: "Carbos",   consumed: consumed.carbs,   target: targets.carbs,   unit: "g", pct: carbPct },
    { key: "fat",     label: "Grasas",   consumed: consumed.fat,     target: targets.fat,     unit: "g", pct: fatPct  },
  ];

  return (
    <article className="panel">
      <div className="panel-head">
        <h2>Resumen de hoy</h2>
        {profile && (
          <span className={`badge ${gymToday ? "green" : "blue"}`}>
            {gymToday ? "Gym 💪" : "Descanso 😴"}
          </span>
        )}
      </div>
      <div className="today-ring-layout">
        <div
          className="kcal-ring-wrap"
          style={{ background: ringBg }}
          role="img"
          aria-label={`${kcalPct}% de las calorías del día consumidas`}
        >
          <div className="kcal-ring-center">
            <strong>{kcalPct}%</strong>
            <span>{Math.round(consumed.kcal)}</span>
            <small>/ {targets.kcal} kcal</small>
          </div>
        </div>
        <div className="macro-bars">
          {MACROS.map(({ key, label, consumed: c, target: t, unit, pct }) => (
            <div key={key} className="macro-bar-row">
              <div className="macro-bar-label">
                <span>{label}</span>
                <span>
                  {Math.round(c)}{unit} <em>/ {t}{unit}</em> · <b>{pct}%</b>
                </span>
              </div>
              <div className="macro-bar-track">
                <div className={`macro-bar-fill macro-bar-${key}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          ))}
          <p className="today-ring-hint">
            Detalle de comidas en <strong>Registro</strong>
          </p>
        </div>
      </div>
    </article>
  );
}

// ---------- Proyección de peso a futuro ----------

function WeightProjectionPanel() {
  const { state } = useFoodOS();
  const profile = state.profile!;
  const { tdee } = calcSummary(profile);
  const protRange = calcProteinRange(profile);
  const latest = getLatestWeight(state);
  const currentKg = latest?.kg ?? profile.weightKg;
  const targetKg = profile.targetWeightKg;

  // Promedio de kcal ingeridas en los últimos 14 días (solo días con ≥500 kcal registradas)
  const daysWithData = Array.from({ length: 14 }, (_, i) => todayMinus(i))
    .map((date) => ({
      date,
      kcal: state.foodLog.filter((e) => e.date === date).reduce((s, e) => s + e.kcal, 0),
    }))
    .filter((d) => d.kcal >= 500);

  const minDays = 3;
  if (daysWithData.length < minDays) {
    return (
      <article className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Proyección</p>
            <h2>Peso a futuro</h2>
          </div>
        </div>
        <p className="empty">
          Registra al menos {minDays} días de comidas en <strong>Registro</strong> para ver tu
          proyección de peso ({daysWithData.length}/{minDays} días disponibles).
        </p>
      </article>
    );
  }

  const avgKcal = Math.round(daysWithData.reduce((s, d) => s + d.kcal, 0) / daysWithData.length);
  const dailyDelta = tdee - avgKcal; // positivo = déficit, negativo = superávit
  const weeklyKg = (dailyDelta * 7) / 7700;

  const projectKg = (days: number) =>
    Math.round((currentKg - (dailyDelta * days) / 7700) * 10) / 10;

  const kg30  = projectKg(30);
  const kg90  = projectKg(90);
  const kg180 = projectKg(180);

  const daysToTarget =
    targetKg && dailyDelta > 0 && currentKg > targetKg
      ? Math.ceil(((currentKg - targetKg) * 7700) / dailyDelta)
      : null;

  // Estado del ritmo
  const absWeekly = Math.abs(weeklyKg);
  const isSurplus  = dailyDelta < 0;
  const isAggressive = absWeekly > 0.75;
  const isSlow       = absWeekly < 0.2 && profile.goal !== "maintain" && profile.goal !== "recomp";
  const isHealthy    = !isAggressive && !isSlow;

  const rateColor = isAggressive ? "red" : isSlow ? "amber" : isSurplus ? "blue" : "green";
  const rateLabel = isSurplus
    ? `+${Math.abs(weeklyKg).toFixed(2)} kg/semana`
    : `−${Math.abs(weeklyKg).toFixed(2)} kg/semana`;

  // SVG proyección (0 → 180 días)
  const W = 520, H = 80;
  const minW = Math.min(currentKg, kg180, targetKg ?? Infinity) - 1.5;
  const maxW = Math.max(currentKg, kg180, targetKg ?? -Infinity) + 1.5;
  const rangeW = maxW - minW || 2;
  const xOf = (day: number) => (day / 180) * W;
  const yOf = (kg: number)  => H - ((kg - minW) / rangeW) * H;

  const projLine = `M${xOf(0).toFixed(1)},${yOf(currentKg).toFixed(1)} L${xOf(180).toFixed(1)},${yOf(kg180).toFixed(1)}`;
  const markers  = [30, 90, 180];

  return (
    <article className="panel weight-projection-panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Proyección</p>
          <h2>Peso a futuro</h2>
        </div>
        <span className={`badge ${rateColor}`}>{rateLabel}</span>
      </div>

      <p className="projection-intro">
        Basado en tu ingesta media de los últimos{" "}
        <strong>{daysWithData.length} días</strong> ({avgKcal} kcal/día vs {tdee} kcal TDEE).
        Déficit diario: <strong>{dailyDelta > 0 ? `−${dailyDelta}` : `+${Math.abs(dailyDelta)}`} kcal</strong>.
      </p>

      {/* Tarjetas de proyección */}
      <div className="projection-cards">
        {[
          { label: "En 30 días", kg: kg30, days: 30 },
          { label: "En 90 días", kg: kg90, days: 90 },
          { label: "En 180 días", kg: kg180, days: 180 },
        ].map(({ label, kg, days }) => {
          const diff = Math.round((currentKg - kg) * 10) / 10;
          const isLoss = diff > 0;
          return (
            <div key={days} className="projection-card">
              <span className="projection-card-label">{label}</span>
              <span className="projection-card-kg">{kg} kg</span>
              <span className={`projection-card-diff ${isLoss ? "loss" : "gain"}`}>
                {isLoss ? `−${diff}` : `+${Math.abs(diff)}`} kg
              </span>
            </div>
          );
        })}
      </div>

      {/* SVG línea de proyección */}
      <svg viewBox={`0 0 ${W} ${H + 24}`} className="projection-chart" aria-hidden="true">
        {/* Línea objetivo */}
        {targetKg && targetKg >= minW && targetKg <= maxW && (
          <line
            x1={0} y1={yOf(targetKg)} x2={W} y2={yOf(targetKg)}
            stroke="var(--amber)" strokeWidth="1" strokeDasharray="5 3"
          />
        )}
        {/* Área bajo la proyección */}
        <path
          d={`${projLine} L${xOf(180)},${H} L${xOf(0)},${H} Z`}
          fill={dailyDelta > 0 ? "rgba(74,222,128,0.07)" : "rgba(59,130,246,0.07)"}
        />
        {/* Línea de proyección */}
        <path d={projLine} fill="none" stroke={dailyDelta > 0 ? "var(--green)" : "var(--blue, #3b82f6)"} strokeWidth="2" strokeDasharray="8 4" />
        {/* Punto actual */}
        <circle cx={xOf(0)} cy={yOf(currentKg)} r="4" fill="var(--green)" />
        <text x={xOf(0) + 6} y={yOf(currentKg) - 6} fill="var(--green)" fontSize="10" fontWeight="600">
          {currentKg} kg
        </text>
        {/* Marcadores en 30/90/180 días */}
        {markers.map((d) => (
          <g key={d}>
            <line x1={xOf(d)} y1={0} x2={xOf(d)} y2={H} stroke="rgba(150,163,144,0.2)" strokeWidth="1" strokeDasharray="3 3" />
            <text x={xOf(d)} y={H + 17} textAnchor="middle" fill="rgba(150,163,144,0.7)" fontSize="10">
              {d}d
            </text>
          </g>
        ))}
        {/* Etiqueta objetivo */}
        {targetKg && targetKg >= minW && targetKg <= maxW && (
          <text x={W - 2} y={yOf(targetKg) - 4} textAnchor="end" fill="var(--amber)" fontSize="9">
            objetivo {targetKg} kg
          </text>
        )}
      </svg>

      {/* Progreso hacia objetivo */}
      {targetKg && currentKg > targetKg && (
        <div className="projection-target">
          <div className="projection-target-row">
            <span>Objetivo: <strong>{targetKg} kg</strong></span>
            <span>Faltan <strong>{Math.round((currentKg - targetKg) * 10) / 10} kg</strong></span>
            {daysToTarget && (
              <span className="badge amber">
                ~{daysToTarget < 365
                  ? `${Math.round(daysToTarget / 7)} semanas`
                  : `${(daysToTarget / 365).toFixed(1)} años`}
              </span>
            )}
          </div>
          <div className="projection-progress-bar">
            <div
              className="projection-progress-fill"
              style={{
                width: `${Math.min(100, Math.max(0, ((profile.weightKg - currentKg) / (profile.weightKg - targetKg)) * 100))}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Alertas */}
      {isAggressive && (
        <div className="projection-alert projection-alert--danger">
          ⚠ Ritmo agresivo ({Math.abs(weeklyKg).toFixed(2)} kg/semana). Riesgo de pérdida muscular. Lo
          recomendado es ≤ 0,5 kg/semana.
        </div>
      )}
      {isSurplus && profile.goal === "fat_loss" && (
        <div className="projection-alert projection-alert--warning">
          Estás en superávit calórico pero tu objetivo es pérdida de grasa. Ajusta la ingesta.
        </div>
      )}

      {/* Recomendaciones */}
      <div className="projection-recommendations">
        <p className="projection-rec-title">Recomendaciones</p>
        <ul>
          {isSlow && profile.goal === "fat_loss" && (
            <li>Tu déficit es pequeño. Prueba reducir 150–200 kcal más al día o añadir 20 min de cardio.</li>
          )}
          {isAggressive && (
            <li>Aumenta 200–300 kcal/día para proteger el músculo. La pérdida de grasa seguirá siendo efectiva.</li>
          )}
          {isHealthy && dailyDelta > 0 && (
            <li>Ritmo saludable. Mantén la constancia y los resultados llegarán.</li>
          )}
          <li>
            Proteína recomendada:{" "}
            <strong>{protRange.recommendedMin}–{protRange.target} g/día</strong> para preservar masa muscular
            {profile.weightKg > 25 * Math.pow(profile.heightCm / 100, 2) * 1.25
              ? " (peso ajustado ESPEN)"
              : ` (${(protRange.target / currentKg).toFixed(1)} g/kg)`}
            .
          </li>
          <li>
            Agua recomendada: <strong>{Math.round(currentKg * 35)} ml/día</strong> ({(currentKg * 35 / 1000).toFixed(1)} L).
          </li>
          {profile.gymDays.length < 3 && profile.goal !== "maintain" && (
            <li>Añadir 1–2 días de entrenamiento de fuerza aceleraría la recomposición.</li>
          )}
        </ul>
      </div>
    </article>
  );
}
