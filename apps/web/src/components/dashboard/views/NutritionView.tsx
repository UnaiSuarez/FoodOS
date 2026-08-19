"use client";

import { useState, type FormEvent } from "react";
import type { ActivityLevel, ActivityModelVersion, ConfidenceLevel, DailyTargets, EquipmentAccess, ExperienceLevel, GoalMode, MacroPreference, NutritionCalculationSnapshot, NutritionSafetyResult, PhysicalProfile, Sex, TrainingActivityProfile, WeightEntry } from "@foodos/types";
import { Modal } from "@/components/dashboard/Modal";
import {
  actions,
  bestRecipe,
  countLowProteinDays,
  findRecipe,
  getAdherenceStreak,
  getConsumedToday,
  getKcalBurnedToday,
  getLatestWeight,
  getMacroAdherenceHistory,
  getProteinRanking,
  getToday,
  getTodayLog,
  getWeeklyMacroHistory,
  useFoodOS,
} from "@/lib/state";
import {
  ACTIVITY_LABELS,
  adjustmentCooldownDaysLeft,
  buildAdjustmentEvidence,
  calcAdaptiveTdee,
  calcHabitualTrainingAllowanceKcal,
  calcIntakeCoverage,
  EQUIPMENT_LABELS,
  EXPERIENCE_LABELS,
  GOAL_DESCRIPTIONS,
  GOAL_LABELS,
  calcDailyTargets,
  calcProteinRange,
  calcSummary,
  calculateFiberTarget,
  calcWeightTrend,
  evaluateAdjustmentProposal,
  evaluateNutritionSafety,
  filterEntriesFromCalibrationStart,
  getAdaptiveDiagnostics,
  isAdjustmentCooldownActive,
  isGymDay,
  isProposalStale,
  isRelevantCalibrationChange,
  LIFESTYLE_ONLY_FACTORS,
  MACRO_PREFERENCE_LABELS,
  NUTRITION_ENGINE_VERSION,
  buildAdjustmentProfileFingerprint,
  shouldWarnMuscleGain,
  usesEspenAdjustedWeight,
  weeklyCycle,
} from "@/lib/nutrition";
import { remote } from "@/lib/data-layer";
import { dateFromKey, dateOffset } from "@/lib/utils";

const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "L" },
  { value: 2, label: "M" },
  { value: 3, label: "X" },
  { value: 4, label: "J" },
  { value: 5, label: "V" },
  { value: 6, label: "S" },
  { value: 0, label: "D" },
];

/**
 * N16: la sección Nutrición había crecido a 8 paneles apilados verticalmente
 * (ver docs/REVISION_NUTRICION_PR48-52.md) — aquí se organiza el contenido
 * secundario en pestañas. El plan diario (perfil + resumen de hoy) se queda
 * FUERA de las pestañas, a propósito: es lo único que casi todo el mundo
 * quiere ver sin un clic extra, y moverlo a una pestaña "Objetivos" solo
 * habría duplicado ProfileSummary (ya es exactamente ese contenido) sin
 * ganar nada. Por eso hay 3 pestañas, no 4 — "Objetivos" ya está pinned.
 */
type NutritionTab = "hoy" | "peso" | "adaptativo";

export function NutritionView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<NutritionTab>("hoy");

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

      {state.profile && (
        <>
          <div className="nutrition-tabs">
            <button
              className={`nutrition-tab ${tab === "hoy" ? "active" : ""}`}
              onClick={() => setTab("hoy")}
            >
              Hoy
            </button>
            <button
              className={`nutrition-tab ${tab === "peso" ? "active" : ""}`}
              onClick={() => setTab("peso")}
            >
              Peso
            </button>
            <button
              className={`nutrition-tab ${tab === "adaptativo" ? "active" : ""}`}
              onClick={() => setTab("adaptativo")}
            >
              Adaptativo
            </button>
          </div>

          {tab === "hoy" && (
            <>
              <MacroWeekChart />
              <MacroAdherencePanel />
              <ProteinOptimizerPanel />
            </>
          )}

          {tab === "peso" && (
            <>
              <WeightPanel />
              <WeightTrendPanel />
              <WeightProjectionPanel />
            </>
          )}

          {tab === "adaptativo" && (
            <>
              <AdaptiveTdeePanel />
              <AdjustmentProposalPanel />
            </>
          )}
        </>
      )}
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
                onClick={() => {
                  let restored = false;
                  mutate((draft) => {
                    restored = actions.returnEntryToInventory(draft, entry);
                    draft.foodLog = draft.foodLog.filter((candidate) => candidate.id !== entry.id);
                  });
                  showToast(restored ? "Comida eliminada · cantidad devuelta al inventario" : "Comida eliminada");
                }}
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
            const today = getToday(draft);
            for (const entry of draft.foodLog) {
              if (entry.date === today) actions.returnEntryToInventory(draft, entry);
            }
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
  const { state, mutate, showToast } = useFoodOS();
  const profile = state.profile;
  const [goal, setGoal] = useState<GoalMode>(profile?.goal ?? "recomp");
  const [gymDays, setGymDays] = useState<number[]>(profile?.gymDays ?? [1, 3, 5]);
  const [macroPreference, setMacroPreference] = useState<MacroPreference>(state.macroPreference ?? "balanced");
  const [activityModelVersion, setActivityModelVersion] = useState<ActivityModelVersion>(
    profile?.activityModelVersion ?? "legacy_total_pal"
  );
  const isNewActivityModel = activityModelVersion === "lifestyle_plus_training";
  const defaultTraining = profile?.trainingActivity;

  // N10: un déficit agresivo (>30% del TDEE) ya no se guarda con solo un
  // toast informativo — se detiene el guardado y se pide una confirmación
  // real, persistente, con el dato concreto delante. pendingConfirm != null
  // mientras esa decisión está pendiente.
  const [pendingConfirm, setPendingConfirm] = useState<{
    next: PhysicalProfile;
    tmb: number;
    tdee: number;
    targets: DailyTargets;
    safety: NutritionSafetyResult;
    trainingActivity?: TrainingActivityProfile;
  } | null>(null);

  /** Escribe el perfil de verdad — solo se llama cuando no hace falta
      confirmación, o después de que el usuario la haya dado explícitamente. */
  function commitSave(
    next: PhysicalProfile,
    tmb: number,
    tdee: number,
    targets: DailyTargets,
    safety: NutritionSafetyResult,
    trainingActivity: TrainingActivityProfile | undefined,
  ) {
    mutate((draft) => {
      draft.profile = next;
      draft.macroPreference = macroPreference;
    });

    // Desglose adaptativo (PR5), solo si ya hay tendencia de peso e ingesta
    // registradas — se guarda como contexto adicional del snapshot, nunca
    // dispara un snapshot por sí solo. Se filtra por la calibración vigente
    // TRAS este guardado (next.adaptiveCalibrationStartedAt): si este mismo
    // guardado acaba de reiniciarla, el desglose ya refleja que apenas hay
    // histórico bajo el nuevo régimen, en vez de mezclar datos de antes.
    const weightLogAtSave = filterEntriesFromCalibrationStart(state.weightLog, next.adaptiveCalibrationStartedAt);
    const weightTrendAtSave = calcWeightTrend(weightLogAtSave, getToday(state));
    const dailyKcalAtSaveMap = new Map<string, number>();
    for (const entry of state.foodLog) {
      dailyKcalAtSaveMap.set(entry.date, (dailyKcalAtSaveMap.get(entry.date) ?? 0) + entry.kcal);
    }
    const dailyKcalAtSave = filterEntriesFromCalibrationStart(
      Array.from(dailyKcalAtSaveMap, ([date, kcal]) => ({ date, kcal })),
      next.adaptiveCalibrationStartedAt
    );
    const coverageAtSave = calcIntakeCoverage(dailyKcalAtSave, getToday(state), 28, targets.kcal);
    const adaptiveAtSave = calcAdaptiveTdee({
      initialTdeeKcal: tdee,
      avgIntakeKcal: coverageAtSave?.avgKcal ?? null,
      weightTrend: weightTrendAtSave,
    });

    // Snapshot inmutable de cómo se calculó — solo en este evento explícito
    // (guardar perfil), nunca desde un render. No bloquea el guardado si falla.
    // safety puede llevar confirmedDespiteWarning:true (N10) — queda en el
    // snapshot como constancia de que el aviso no se ignoró en silencio.
    void remote.saveNutritionSnapshot({
      calculationVersion: NUTRITION_ENGINE_VERSION,
      triggerReason: profile ? "profile_changed" : "initial_calculation",
      inputSnapshot: {
        age: next.age, sex: next.sex, heightCm: next.heightCm, weightKg: next.weightKg,
        goal: next.goal, activityLevel: next.activityLevel, macroPreference,
        activityModelVersion, trainingActivity,
      },
      restingEnergy: { valueKcal: tmb, method: "mifflin_st_jeor" },
      tdee: {
        valueKcal: tdee,
        ...(adaptiveAtSave.confidence !== "insufficient_data" && { adaptive: adaptiveAtSave }),
      },
      calorieTarget: { kcal: targets.kcal, dayType: targets.dayType },
      macros: {
        kcal: targets.kcal, protein: targets.protein, carbs: targets.carbs, fat: targets.fat,
        fiber: calculateFiberTarget(targets.kcal),
      },
      safety,
    });

    onSaved();
  }

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

    const trainingActivity: TrainingActivityProfile | undefined = isNewActivityModel
      ? {
          lifestyleActivity: String(data.get("lifestyleActivity")) as ActivityLevel,
          strengthDaysPerWeek: Number(data.get("strengthDays")),
          cardioDaysPerWeek: Number(data.get("cardioDays")),
          avgSessionDurationMin: Number(data.get("avgSessionDuration")),
          habitualSteps: String(data.get("habitualSteps") ?? "").trim()
            ? Number(data.get("habitualSteps"))
            : null,
        }
      : undefined;

    const next: PhysicalProfile = {
      age: Number(data.get("age")),
      sex: String(data.get("sex")) as Sex,
      heightCm: Number(data.get("height")),
      weightKg: Number(data.get("weight")),
      bodyFatPct: bodyFatRaw ? Number(bodyFatRaw) : null,
      // En el modelo nuevo, activityLevel deja de usarse para calcular el TDEE
      // (ver calcTDEE) — se rellena con la actividad cotidiana declarada solo
      // para que el campo no quede vacío en el resto de la app.
      activityLevel: isNewActivityModel
        ? (trainingActivity!.lifestyleActivity)
        : (String(data.get("activity")) as ActivityLevel),
      goal,
      gymDays,
      allergies: parseList(String(data.get("allergies"))),
      excludedFoods: parseList(String(data.get("excluded"))),
      targetWeightKg: targetWeightRaw ? Number(targetWeightRaw) : undefined,
      experienceLevel: (data.get("experienceLevel") as ExperienceLevel) || undefined,
      equipmentAccess: (data.get("equipmentAccess") as EquipmentAccess) || undefined,
      activityModelVersion,
      trainingActivity,
      // Se conservan salvo que este guardado dispare un reinicio de
      // calibración más abajo — antes de PR9 este objeto ni siquiera
      // incluía adaptiveKcalOffsetKcal, así que guardar el perfil borraba
      // en silencio cualquier ajuste adaptativo ya aceptado.
      adaptiveKcalOffsetKcal: profile?.adaptiveKcalOffsetKcal ?? 0,
      adaptiveCalibrationStartedAt: profile?.adaptiveCalibrationStartedAt ?? null,
      lastTargetChangedAt: profile?.lastTargetChangedAt ?? null,
    };

    // Reinicia la calibración adaptativa si este guardado cambia objetivo,
    // actividad o modelo de actividad: el histórico de peso/ingesta previo ya
    // no representa el nuevo régimen (ver N5). No se toca por cambios de
    // peso o preferencia de macros — esos no invalidan la ventana adaptativa.
    if (isRelevantCalibrationChange(profile ?? null, next)) {
      const changeDate = getToday(state);
      next.adaptiveCalibrationStartedAt = changeDate;
      next.lastTargetChangedAt = changeDate;
    }

    // ── Guardarraíles de seguridad ──────────────────────────────────────────
    const { tmb, tdee } = calcSummary(next);
    const gymTodayForNext = isGymDay(next, dateFromKey(getToday(state)));
    const targets = calcDailyTargets(next, gymTodayForNext, macroPreference);
    const safety = evaluateNutritionSafety({
      targetKcal: targets.kcal,
      estimatedTdeeKcal: tdee,
      restingEnergyKcal: tmb,
    });
    if (!safety.automaticPlanAllowed) {
      showToast("Ese objetivo queda por debajo de 800 kcal — revisa peso/altura/edad o consulta a un profesional.");
      return;
    }
    if (safety.warnings.includes("below_resting_energy")) {
      showToast("El objetivo queda por debajo de tu TMB estimada — no es peligroso por sí solo, pero merece revisión.");
    }

    // N10: un déficit agresivo detiene el guardado y pide confirmación real
    // (diálogo persistente, no un toast) — antes se avisaba y se guardaba
    // igual, así que "requiresConfirmation" nunca llegaba a exigir nada.
    if (safety.requiresConfirmation) {
      setPendingConfirm({ next, tmb, tdee, targets, safety, trainingActivity });
      return;
    }

    commitSave(next, tmb, tdee, targets, safety, trainingActivity);
  }

  return (
    <>
    <form className="panel form-panel" onSubmit={save}>
      <p className="eyebrow">{profile ? "Editar perfil" : "Configura tu perfil"}</p>
      <h2>{profile ? "Tu perfil físico" : "Cuéntanos tu objetivo"}</h2>
      <p className="form-intro">
        Con estos datos FoodOS calcula tus calorías y macros diarios (fórmula Mifflin-St Jeor) y los
        ajusta cada día según si entrenas o descansas.
      </p>

      <div className="form-grid">
        <label>
          Edad
          {/* Sin valor por defecto (N9): un dato inventado (25 años) podía
              guardarse sin que el usuario lo notara. Al editar sí se muestra
              el valor ya guardado — eso no es un dato inventado. */}
          <input name="age" type="number" min="14" max="100" required defaultValue={profile?.age} placeholder="ej. 28" />
        </label>
        <label>
          Sexo biológico
          <select name="sex" defaultValue={profile?.sex ?? ""} required>
            {!profile && <option value="" disabled>Elige una opción</option>}
            <option value="male">Hombre</option>
            <option value="female">Mujer</option>
          </select>
        </label>
        <label>
          Altura (cm)
          <input name="height" type="number" min="120" max="230" required defaultValue={profile?.heightCm} placeholder="ej. 175" />
        </label>
        <label>
          Peso (kg)
          <input name="weight" type="number" min="35" max="250" step="0.1" required defaultValue={profile?.weightKg} placeholder="ej. 75" />
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
          Preferencia de grasa/carbos
          <select
            name="macroPreference"
            value={macroPreference}
            onChange={(e) => setMacroPreference(e.target.value as MacroPreference)}
          >
            {(Object.keys(MACRO_PREFERENCE_LABELS) as MacroPreference[]).map((pref) => (
              <option key={pref} value={pref}>
                {MACRO_PREFERENCE_LABELS[pref]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Experiencia entrenando <small>(para el asistente de rutinas IA)</small>
          <select name="experienceLevel" defaultValue={profile?.experienceLevel ?? "intermediate"}>
            {(Object.keys(EXPERIENCE_LABELS) as ExperienceLevel[]).map((level) => (
              <option key={level} value={level}>
                {EXPERIENCE_LABELS[level]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Material disponible <small>(para el asistente de rutinas IA)</small>
          <select name="equipmentAccess" defaultValue={profile?.equipmentAccess ?? "full_gym"}>
            {(Object.keys(EQUIPMENT_LABELS) as EquipmentAccess[]).map((level) => (
              <option key={level} value={level}>
                {EQUIPMENT_LABELS[level]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="activity-model-section">
        <legend>Actividad y entrenamiento</legend>
        <div className="activity-model-toggle">
          <button
            type="button"
            className={`activity-model-option ${!isNewActivityModel ? "active" : ""}`}
            onClick={() => setActivityModelVersion("legacy_total_pal")}
          >
            <strong>Clásico</strong>
            <small>Un solo nivel combina tu día a día y el entreno.</small>
          </button>
          <button
            type="button"
            className={`activity-model-option ${isNewActivityModel ? "active" : ""}`}
            onClick={() => setActivityModelVersion("lifestyle_plus_training")}
          >
            <strong>Nuevo (beta)</strong>
            <small>Declara tu día a día y tu entreno por separado — más preciso.</small>
          </button>
        </div>

        {!isNewActivityModel ? (
          <label className="activity-legacy-field">
            Nivel de actividad
            <select name="activity" defaultValue={profile?.activityLevel ?? ""} required>
              {!profile && <option value="" disabled>Elige una opción</option>}
              {(Object.keys(ACTIVITY_LABELS) as ActivityLevel[]).map((level) => (
                <option key={level} value={level}>
                  {ACTIVITY_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="activity-new-model">
            <p className="activity-model-note">
              Así separamos cuánto te mueves fuera del gimnasio de cuánto entrenas — útil si tienes
              un trabajo sedentario pero entrenas duro, o al revés.
            </p>
            <div className="form-grid compact">
              <label>
                Actividad cotidiana <small>(sin contar el entreno)</small>
                <select name="lifestyleActivity" defaultValue={defaultTraining?.lifestyleActivity ?? ""} required>
                  {!defaultTraining && <option value="" disabled>Elige una opción</option>}
                  {(Object.keys(ACTIVITY_LABELS) as ActivityLevel[]).map((level) => (
                    <option key={level} value={level}>
                      {ACTIVITY_LABELS[level]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Días de fuerza/semana
                {/* Sin valor por defecto (N9): "3 días" sin que el usuario lo
                    tocara podía sumar gasto de entreno inventado al TDEE. */}
                <input
                  name="strengthDays"
                  type="number"
                  min="0"
                  max="7"
                  required
                  defaultValue={defaultTraining?.strengthDaysPerWeek}
                  placeholder="ej. 3"
                />
              </label>
              <label>
                Días de cardio/semana
                <input
                  name="cardioDays"
                  type="number"
                  min="0"
                  max="7"
                  required
                  defaultValue={defaultTraining?.cardioDaysPerWeek}
                  placeholder="ej. 0"
                />
              </label>
              <label>
                Duración media por sesión (min)
                <input
                  name="avgSessionDuration"
                  type="number"
                  min="10"
                  max="240"
                  required
                  defaultValue={defaultTraining?.avgSessionDurationMin}
                  placeholder="ej. 60"
                />
              </label>
              <label>
                Pasos diarios habituales <small>(opcional — todavía no afecta al cálculo, ver abajo)</small>
                <input
                  name="habitualSteps"
                  type="number"
                  min="0"
                  max="40000"
                  placeholder="—"
                  defaultValue={defaultTraining?.habitualSteps ?? ""}
                />
              </label>
            </div>
            {/* N8: se captura para un futuro modelo que evite doble conteo
                con la actividad cotidiana, pero hoy no entra en ningún
                cálculo — sin esto, el usuario podía asumir que rellenarlo
                cambiaba su TDEE. */}
            <p className="activity-model-note">
              📌 Los pasos diarios se guardan como referencia — <strong>todavía no afectan</strong> a tu
              cálculo de calorías. Los tendremos en cuenta más adelante, evitando contar dos veces el
              mismo movimiento si ya está incluido en tu actividad cotidiana.
            </p>
          </div>
        )}
      </fieldset>

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

    {pendingConfirm && (
      <Modal title="Revisa tu déficit antes de continuar" onClose={() => setPendingConfirm(null)}>
        <p className="cycle-note">
          Este objetivo ({pendingConfirm.targets.kcal} kcal/día) equivale aproximadamente al{" "}
          <strong>{Math.round((pendingConfirm.targets.kcal / pendingConfirm.tdee) * 100)}%</strong> de tu
          mantenimiento estimado ({pendingConfirm.tdee} kcal/día) — un déficit superior al 30% se considera
          agresivo. No es peligroso por sí solo, pero conviene revisarlo antes de seguir: comprueba que edad,
          peso, altura y actividad son correctos, o consulta con un profesional si mantienes este ritmo mucho
          tiempo.
        </p>
        <div className="meta-row" style={{ marginTop: 12 }}>
          <button className="secondary-button" onClick={() => setPendingConfirm(null)}>
            ← Revisar los datos
          </button>
          <button
            className="primary-button"
            onClick={() => {
              const { next, tmb, tdee, targets, safety, trainingActivity } = pendingConfirm;
              commitSave(next, tmb, tdee, targets, { ...safety, confirmedDespiteWarning: true }, trainingActivity);
              setPendingConfirm(null);
            }}
          >
            Guardar de todos modos
          </button>
        </div>
      </Modal>
    )}
    </>
  );
}

// ---------- Historial de peso (Feature 1) ----------

function WeightPanel() {
  const { state, mutate, showToast } = useFoodOS();
  const latest = getLatestWeight(state);
  const today = getToday(state);
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
            Último: {latest.kg} kg ({latest.date === today ? "hoy" : latest.date})
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

// ---------- Tendencia de peso suavizada (solo informativa, PR4) ----------

const TREND_CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  low: "Baja",
  moderate: "Moderada",
  high: "Alta",
};

function WeightTrendPanel() {
  const { state } = useFoodOS();
  const trend = calcWeightTrend(state.weightLog, getToday(state));

  if (!trend) {
    return (
      <article className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Tendencia</p>
            <h2>Peso suavizado</h2>
          </div>
        </div>
        <p className="empty">
          Registra tu peso al menos 3 días (dentro de las últimas 4 semanas) para ver tu tendencia suavizada.
        </p>
      </article>
    );
  }

  const isLoss = trend.weeklyChangeKg < 0;
  const isFlat = Math.abs(trend.weeklyChangeKg) < 0.05;
  const confidenceBadge = trend.confidence === "high" ? "green" : trend.confidence === "moderate" ? "amber" : "";

  return (
    <article className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Tendencia · {trend.validMeasurements} mediciones (últimas 4 semanas)</p>
          <h2>Peso suavizado</h2>
        </div>
        <span className={`badge ${confidenceBadge}`}>Confianza: {TREND_CONFIDENCE_LABELS[trend.confidence]}</span>
      </div>
      <div className="nutrition-totals">
        <div>
          <span>Registrado</span>
          <strong>{trend.latestWeightKg} kg</strong>
          <small>último dato tal cual</small>
        </div>
        <div>
          <span>Tendencia</span>
          <strong>{trend.trendWeightKg} kg</strong>
          <small>suavizado (mediana + EWMA)</small>
        </div>
        <div>
          <span>Cambio estimado</span>
          <strong>
            {isFlat ? "≈0" : `${isLoss ? "−" : "+"}${Math.abs(trend.weeklyChangeKg).toFixed(2)}`} kg
          </strong>
          <small>
            por semana ({trend.weeklyChangePercent >= 0 ? "+" : ""}
            {trend.weeklyChangePercent}%)
          </small>
        </div>
      </div>
      <p className="cycle-note">
        Este dato es solo informativo — todavía no ajusta tu objetivo de calorías.
      </p>
    </article>
  );
}

// ---------- TDEE adaptativo pasivo (solo informativo, PR5) ----------

const ADAPTIVE_TDEE_WINDOW_DAYS = 28;

function AdaptiveTdeePanel() {
  const { state } = useFoodOS();
  const profile = state.profile!;
  const today = getToday(state);
  const { tdee: initialTdeeKcal } = calcSummary(profile);
  // Referencia para el suelo relativo de cobertura (PR10/N6) — el objetivo
  // de HOY, ya que cambia entre día de gym y de descanso.
  const targetKcalToday = calcDailyTargets(profile, isGymDay(profile, dateFromKey(today)), state.macroPreference).kcal;
  // Filtrado por calibración (PR9): tras cambiar objetivo/actividad, el
  // histórico previo ya no representa el régimen actual — ver N5.
  const calibrationFloor = profile.adaptiveCalibrationStartedAt ?? null;
  const weightLogForAdaptive = filterEntriesFromCalibrationStart(state.weightLog, calibrationFloor);
  const weightTrend = calcWeightTrend(weightLogForAdaptive, today);

  const dailyKcalByDate = new Map<string, number>();
  for (const entry of state.foodLog) {
    dailyKcalByDate.set(entry.date, (dailyKcalByDate.get(entry.date) ?? 0) + entry.kcal);
  }
  const dailyKcal = filterEntriesFromCalibrationStart(
    Array.from(dailyKcalByDate, ([date, kcal]) => ({ date, kcal })),
    calibrationFloor
  );
  const coverage = calcIntakeCoverage(dailyKcal, today, ADAPTIVE_TDEE_WINDOW_DAYS, targetKcalToday);

  const adaptive = calcAdaptiveTdee({
    initialTdeeKcal,
    avgIntakeKcal: coverage?.avgKcal ?? null,
    weightTrend,
  });

  if (adaptive.confidence === "insufficient_data") {
    return (
      <article className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">TDEE adaptativo (beta)</p>
            <h2>Mantenimiento real estimado</h2>
          </div>
        </div>
        <p className="empty">
          Registra tu peso y tus comidas durante unas semanas para ver una estimación de tu
          mantenimiento real basada en datos, no solo en la fórmula.
        </p>
      </article>
    );
  }

  const confidenceBadge = adaptive.confidence === "high" ? "green" : adaptive.confidence === "moderate" ? "amber" : "";

  return (
    <article className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">
            TDEE adaptativo (beta) · cobertura {coverage ? Math.round(coverage.coverageFraction * 100) : 0}%
          </p>
          <h2>Mantenimiento real estimado</h2>
        </div>
        <span className={`badge ${confidenceBadge}`}>Confianza: {TREND_CONFIDENCE_LABELS[adaptive.confidence]}</span>
      </div>
      <div className="nutrition-totals">
        <div>
          <span>Fórmula</span>
          <strong>{adaptive.initialKcal}</strong>
          {/* N15: Mifflin-St Jeor solo calcula la TMB (reposo) — este número
              ya incluye el factor de actividad, así que atribuirlo solo a
              la fórmula del metabolismo basal inducía a error. */}
          <small title="TMB (Mifflin-St Jeor) × tu factor de actividad declarado — no es solo la fórmula del metabolismo basal.">
            kcal (TMB + actividad)
          </small>
        </div>
        <div>
          <span>Observado</span>
          <strong>{adaptive.observedKcal}</strong>
          <small>ingesta real vs. peso real</small>
        </div>
        <div>
          <span>Combinado</span>
          <strong>{adaptive.combinedKcal}</strong>
          <small>mantenimiento adaptativo</small>
        </div>
      </div>
      <p className="cycle-note">
        Tu mantenimiento adaptativo estimado es de {adaptive.combinedKcal} kcal. Todavía no ha
        modificado tu objetivo diario.
      </p>
      {adaptive.warnings.includes("tdee_estimates_strongly_disagree") && (
        <div className="nutrition-warn-banner">
          ⚠ Tu ingesta real y tu tendencia de peso implican un mantenimiento muy distinto al de la
          fórmula (más de un 30% de diferencia). Puede deberse a registros incompletos, retención
          de agua, creatina u otro factor puntual — de momento no se generan propuestas de ajuste
          hasta que los datos se estabilicen.
        </div>
      )}
    </article>
  );
}

// ---------- Propuestas de ajuste adaptativo (PR6) ----------

function AdjustmentProposalPanel() {
  const { state, mutate, showToast } = useFoodOS();
  const profile = state.profile!;
  const today = getToday(state);
  const gymToday = isGymDay(profile, dateFromKey(today));
  const pending = state.pendingAdjustmentProposal ?? null;

  const { tmb, tdee: initialTdeeKcal } = calcSummary(profile);
  // Filtrado por calibración (PR9) — mismo criterio que AdaptiveTdeePanel.
  const calibrationFloor = profile.adaptiveCalibrationStartedAt ?? null;
  const weightLogForAdaptive = filterEntriesFromCalibrationStart(state.weightLog, calibrationFloor);
  const weightTrend = calcWeightTrend(weightLogForAdaptive, today);
  const dailyKcalByDate = new Map<string, number>();
  for (const entry of state.foodLog) {
    dailyKcalByDate.set(entry.date, (dailyKcalByDate.get(entry.date) ?? 0) + entry.kcal);
  }
  const dailyKcalForAdaptive = filterEntriesFromCalibrationStart(
    Array.from(dailyKcalByDate, ([date, kcal]) => ({ date, kcal })),
    calibrationFloor
  );
  const currentTargets = calcDailyTargets(profile, gymToday, state.macroPreference);
  const coverage = calcIntakeCoverage(dailyKcalForAdaptive, today, 28, currentTargets.kcal);
  const adaptive = calcAdaptiveTdee({ initialTdeeKcal, avgIntakeKcal: coverage?.avgKcal ?? null, weightTrend });
  const decision = evaluateAdjustmentProposal({
    currentTargetKcal: currentTargets.kcal,
    adaptive,
    weightTrend,
    intakeCoverage: coverage,
  });

  const cooldownDaysLeft = pending ? 0 : adjustmentCooldownDaysLeft(state.lastAdjustmentDecisionAt ?? null, today);
  const inCooldown = !pending && isAdjustmentCooldownActive(state.lastAdjustmentDecisionAt ?? null, today);

  const diagnostics = getAdaptiveDiagnostics({
    weightLog: weightLogForAdaptive,
    dailyKcal: dailyKcalForAdaptive,
    referenceDate: today,
    initialTdeeKcal,
    currentTargetKcal: currentTargets.kcal,
    calibrationStartedAt: calibrationFloor,
  });

  // ¿Sigue siendo válida la propuesta pendiente con el perfil actual? Un
  // cambio de objetivo/peso/actividad/macros/offset desde que se generó la
  // invalida — aceptarla aplicaría un ajuste calculado para otro contexto
  // (ver N4). Rechazar siempre es seguro, solo se bloquea aceptar.
  const currentFingerprint = buildAdjustmentProfileFingerprint(profile, state.macroPreference ?? "balanced");
  const proposalStale = pending ? isProposalStale(pending.evidence?.profileFingerprint, currentFingerprint) : false;

  // N11: si aceptar el ajuste cruza un umbral de advertencia (déficit
  // agresivo o por debajo de la TMB) — sin llegar al bloqueo duro de <800
  // kcal, que ya se rechaza solo — antes se aplicaba igual y el aviso solo
  // aparecía después en un toast. Ahora se detiene y se pide confirmación
  // explícita, igual criterio que el guardado de perfil (N10).
  const [pendingWarningConfirm, setPendingWarningConfirm] = useState<{
    nextOffset: number;
    nextProfile: PhysicalProfile;
    nextTargets: DailyTargets;
    nextTmb: number;
    nextTdee: number;
    safety: NutritionSafetyResult;
  } | null>(null);

  async function commitAccept(
    nextOffset: number,
    nextProfile: PhysicalProfile,
    nextTargets: DailyTargets,
    nextTmb: number,
    nextTdee: number,
    safety: NutritionSafetyResult,
  ) {
    if (!pending) return;
    const finalSnapshot: NutritionCalculationSnapshot = {
      calculationVersion: NUTRITION_ENGINE_VERSION,
      triggerReason: "adaptive_adjustment_accepted",
      inputSnapshot: {
        age: nextProfile.age, sex: nextProfile.sex, heightCm: nextProfile.heightCm, weightKg: nextProfile.weightKg,
        goal: nextProfile.goal, activityLevel: nextProfile.activityLevel,
        macroPreference: state.macroPreference ?? "balanced",
        activityModelVersion: nextProfile.activityModelVersion ?? "legacy_total_pal",
        trainingActivity: nextProfile.trainingActivity,
      },
      restingEnergy: { valueKcal: nextTmb, method: "mifflin_st_jeor" },
      tdee: { valueKcal: nextTdee },
      calorieTarget: { kcal: nextTargets.kcal, dayType: nextTargets.dayType },
      macros: {
        kcal: nextTargets.kcal, protein: nextTargets.protein, carbs: nextTargets.carbs, fat: nextTargets.fat,
        fiber: calculateFiberTarget(nextTargets.kcal),
      },
      safety,
    };

    // La UI NO toca perfil/propuesta local hasta que el RPC confirme ok:true
    // — si falla (red, RLS, propuesta ya resuelta en otro dispositivo...) el
    // estado local se queda exactamente como estaba, sin un "aplicado" falso.
    const result = await remote.acceptAdjustmentProposal({
      proposalId: pending.id,
      accepted: true,
      goalDate: today,
      newOffsetKcal: nextOffset,
      kcalTarget: nextTargets.kcal,
      proteinG: nextTargets.protein,
      carbsG: nextTargets.carbs,
      fatG: nextTargets.fat,
      mode: nextProfile.goal,
      finalSnapshot,
    });
    if (!result.ok) {
      showToast(`No se pudo aplicar el ajuste: ${result.error}`);
      return;
    }

    mutate((draft) => {
      if (draft.profile) draft.profile.adaptiveKcalOffsetKcal = nextOffset;
      draft.pendingAdjustmentProposal = null;
      draft.lastAdjustmentDecisionAt = today;
    });
    showToast(
      safety.warnings.length
        ? `Ajuste aplicado (${pending.deltaKcal > 0 ? "+" : ""}${pending.deltaKcal} kcal/día) — revisa el aviso de seguridad en tu resumen.`
        : `Ajuste aplicado: ${pending.deltaKcal > 0 ? "+" : ""}${pending.deltaKcal} kcal/día`
    );
  }

  async function generateProposal() {
    const snapshot: NutritionCalculationSnapshot = {
      calculationVersion: NUTRITION_ENGINE_VERSION,
      triggerReason: "adaptive_review",
      inputSnapshot: {
        age: profile.age, sex: profile.sex, heightCm: profile.heightCm, weightKg: profile.weightKg,
        goal: profile.goal, activityLevel: profile.activityLevel,
        macroPreference: state.macroPreference ?? "balanced",
        activityModelVersion: profile.activityModelVersion ?? "legacy_total_pal",
        trainingActivity: profile.trainingActivity,
      },
      restingEnergy: { valueKcal: tmb, method: "mifflin_st_jeor" },
      tdee: { valueKcal: initialTdeeKcal, adaptive },
      calorieTarget: { kcal: currentTargets.kcal, dayType: currentTargets.dayType },
      macros: {
        kcal: currentTargets.kcal, protein: currentTargets.protein, carbs: currentTargets.carbs, fat: currentTargets.fat,
        fiber: calculateFiberTarget(currentTargets.kcal),
      },
      safety: evaluateNutritionSafety({ targetKcal: currentTargets.kcal, estimatedTdeeKcal: initialTdeeKcal, restingEnergyKcal: tmb }),
    };
    const evidence = {
      ...buildAdjustmentEvidence(diagnostics, adaptive.warnings, NUTRITION_ENGINE_VERSION),
      profileFingerprint: currentFingerprint,
    };
    const created = await remote.createAdjustmentReview({ snapshot, decision, evidence });
    if (created) {
      mutate((draft) => { draft.pendingAdjustmentProposal = created; });
      showToast("Propuesta de ajuste generada — revísala abajo.");
    } else {
      showToast("No se pudo generar la propuesta (revisa tu conexión).");
    }
  }

  async function respond(accepted: boolean) {
    if (!pending) return;

    if (accepted) {
      // Bloqueo de propuesta obsoleta (N4): si el perfil cambió desde que se
      // generó, el delta ya no corresponde al contexto actual — nunca se
      // aplica silenciosamente sobre un régimen distinto. Rechazar sigue
      // permitido siempre (no aplica nada, es seguro por definición).
      if (proposalStale) {
        showToast("Tu perfil cambió desde que se generó esta propuesta — descártala y genera una nueva para que refleje tu situación actual.");
        return;
      }

      const nextOffset = (profile.adaptiveKcalOffsetKcal ?? 0) + pending.deltaKcal;
      const nextProfile: PhysicalProfile = { ...profile, adaptiveKcalOffsetKcal: nextOffset };
      const nextTargets = calcDailyTargets(nextProfile, gymToday, state.macroPreference);
      const { tmb: nextTmb, tdee: nextTdee } = calcSummary(nextProfile);
      const safety = evaluateNutritionSafety({
        targetKcal: nextTargets.kcal,
        estimatedTdeeKcal: nextTdee,
        restingEnergyKcal: nextTmb,
      });

      if (!safety.automaticPlanAllowed) {
        const result = await remote.acceptAdjustmentProposal({ proposalId: pending.id, accepted: false, goalDate: today });
        if (!result.ok) {
          showToast(`No se pudo rechazar la propuesta: ${result.error}`);
          return;
        }
        mutate((draft) => { draft.pendingAdjustmentProposal = null; draft.lastAdjustmentDecisionAt = today; });
        showToast("Ese ajuste dejaría tu objetivo por debajo de 800 kcal — rechazado automáticamente por seguridad.");
        return;
      }

      // N11: cualquier warning nuevo (déficit agresivo o por debajo de la
      // TMB) detiene la aplicación y pide confirmación explícita — antes se
      // aplicaba directamente y el aviso solo se veía después, en un toast.
      if (safety.warnings.length > 0) {
        setPendingWarningConfirm({ nextOffset, nextProfile, nextTargets, nextTmb, nextTdee, safety });
        return;
      }

      await commitAccept(nextOffset, nextProfile, nextTargets, nextTmb, nextTdee, safety);
    } else {
      const result = await remote.acceptAdjustmentProposal({ proposalId: pending.id, accepted: false, goalDate: today });
      if (!result.ok) {
        showToast(`No se pudo rechazar la propuesta: ${result.error}`);
        return;
      }
      mutate((draft) => { draft.pendingAdjustmentProposal = null; draft.lastAdjustmentDecisionAt = today; });
      showToast("Propuesta rechazada");
    }
  }

  return (
    <>
    <article className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Revisión adaptativa (beta)</p>
          <h2>Propuesta de ajuste</h2>
        </div>
      </div>

      {pending ? (
        <>
          <p className="cycle-note">{pending.reason}</p>
          <div className="nutrition-totals">
            <div>
              <span>Actual</span>
              <strong>{pending.currentTargetKcal}</strong>
              <small>kcal/día</small>
            </div>
            <div>
              <span>Propuesto</span>
              <strong>{pending.proposedTargetKcal}</strong>
              <small>
                ({pending.deltaKcal > 0 ? "+" : ""}
                {pending.deltaKcal} kcal/día)
              </small>
            </div>
          </div>
          {proposalStale && (
            <div className="nutrition-warn-banner">
              ⚠ Tu perfil cambió desde que se generó esta propuesta (objetivo, peso, actividad, macros u offset) —
              ya no aplica a tu situación actual. Descártala y genera una nueva.
            </div>
          )}
          <div className="meta-row" style={{ marginTop: 12 }}>
            <button className="primary-button" onClick={() => void respond(true)} disabled={proposalStale}>
              Aceptar ajuste
            </button>
            <button className="secondary-button" onClick={() => void respond(false)}>
              {proposalStale ? "Descartar propuesta obsoleta" : "Rechazar"}
            </button>
          </div>
        </>
      ) : decision.shouldPropose && !inCooldown ? (
        <>
          <p className="cycle-note">{decision.reason}</p>
          <button className="primary-button" onClick={() => void generateProposal()}>
            Generar propuesta de ajuste
          </button>
        </>
      ) : inCooldown ? (
        <p className="empty">
          Ya revisamos tu objetivo hace poco. Próxima revisión disponible en {cooldownDaysLeft} día
          {cooldownDaysLeft === 1 ? "" : "s"}.
        </p>
      ) : (
        <p className="empty">{decision.reason}</p>
      )}

      <details className="adaptive-diagnostics">
        <summary>Diagnóstico</summary>
        <div className="adaptive-diagnostics-grid">
          <div>
            <span>Ventana evaluada</span>
            <strong>
              {diagnostics.evaluationStart} → {diagnostics.evaluationEnd}
            </strong>
            {calibrationFloor && (
              <small>Recortada: cambiaste objetivo/actividad el {calibrationFloor} — solo cuentan datos desde entonces.</small>
            )}
          </div>
          <div>
            <span>Ingesta media registrada</span>
            <strong>{diagnostics.averageLoggedCalories != null ? `${diagnostics.averageLoggedCalories} kcal` : "—"}</strong>
          </div>
          <div>
            <span>Cobertura de ingesta</span>
            <strong>
              {diagnostics.calorieCoverage != null ? `${Math.round(diagnostics.calorieCoverage * 100)}%` : "—"}
            </strong>
          </div>
          <div>
            <span>Mediciones de peso</span>
            <strong>{diagnostics.weightMeasurements}</strong>
          </div>
          <div>
            <span>Cambio de peso (crudo / suavizado)</span>
            <strong>
              {diagnostics.rawWeightChangeKg != null ? `${diagnostics.rawWeightChangeKg} kg` : "—"}
              {" / "}
              {diagnostics.smoothedWeightChangeKg != null ? `${diagnostics.smoothedWeightChangeKg} kg` : "—"}
            </strong>
          </div>
          <div>
            <span>Pendiente de regresión</span>
            <strong>
              {diagnostics.regressionSlopeKgPerDay != null ? `${diagnostics.regressionSlopeKgPerDay} kg/día` : "—"}
            </strong>
          </div>
          <div>
            <span>TDEE inicial / observado / combinado</span>
            <strong>
              {diagnostics.initialTdeeKcal} / {diagnostics.observedTdeeKcal ?? "—"} / {diagnostics.blendedTdeeKcal}
            </strong>
          </div>
          <div>
            <span>Confianza</span>
            <strong>
              {diagnostics.confidenceLevel} ({Math.round(diagnostics.confidenceScore * 100)}%)
            </strong>
          </div>
          <div>
            <span>Calidad de la tendencia</span>
            <strong>
              {diagnostics.weightTrendQualityScore != null ? `${Math.round(diagnostics.weightTrendQualityScore * 100)}%` : "—"}
            </strong>
            <small>Cantidad + cobertura temporal + regularidad + ajuste — no solo nº de mediciones.</small>
          </div>
          <div>
            <span>Elegible para propuesta</span>
            <strong>{diagnostics.proposalEligible ? "Sí" : "No"}</strong>
          </div>
        </div>
        {diagnostics.ineligibilityReasons.length > 0 && (
          <ul className="adaptive-diagnostics-reasons">
            {diagnostics.ineligibilityReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </details>
    </article>

    {pendingWarningConfirm && (
      <Modal title="Revisa el aviso antes de aplicar" onClose={() => setPendingWarningConfirm(null)}>
        {pendingWarningConfirm.safety.warnings.includes("aggressive_energy_deficit") && (
          <p className="cycle-note">
            ⚠ Con este ajuste tu objetivo pasaría a {pendingWarningConfirm.nextTargets.kcal} kcal/día — un
            déficit agresivo, por debajo del 70% de tu TDEE estimado ({pendingWarningConfirm.nextTdee} kcal).
            No es peligroso por sí solo, pero conviene revisarlo antes de aplicarlo.
          </p>
        )}
        {!pendingWarningConfirm.safety.warnings.includes("aggressive_energy_deficit") &&
          pendingWarningConfirm.safety.warnings.includes("below_resting_energy") && (
          <p className="cycle-note">
            Con este ajuste tu objetivo pasaría a {pendingWarningConfirm.nextTargets.kcal} kcal/día — por
            debajo de tu TMB estimada ({pendingWarningConfirm.nextTmb} kcal). No es un mínimo obligatorio,
            pero merece revisión.
          </p>
        )}
        <div className="meta-row" style={{ marginTop: 12 }}>
          <button className="secondary-button" onClick={() => setPendingWarningConfirm(null)}>
            ← No aplicar todavía
          </button>
          <button
            className="primary-button"
            onClick={() => {
              const { nextOffset, nextProfile, nextTargets, nextTmb, nextTdee, safety } = pendingWarningConfirm;
              setPendingWarningConfirm(null);
              void commitAccept(nextOffset, nextProfile, nextTargets, nextTmb, nextTdee, {
                ...safety,
                confirmedDespiteWarning: true,
              });
            }}
          >
            Aplicar de todos modos
          </button>
        </div>
      </Modal>
    )}
    </>
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
  const activeDate = dateFromKey(getToday(state));
  const gymToday = isGymDay(profile, activeDate);
  const today = calcDailyTargets(profile, gymToday, state.macroPreference);
  const cycle = weeklyCycle(profile, state.macroPreference);
  const protRange = calcProteinRange(profile);
  const warnMuscle = shouldWarnMuscleGain(profile);
  const safety = evaluateNutritionSafety({ targetKcal: today.kcal, estimatedTdeeKcal: tdee, restingEnergyKcal: tmb });

  const usesNewActivityModel = profile.activityModelVersion === "lifestyle_plus_training" && !!profile.trainingActivity;
  const lifestyleTdee = usesNewActivityModel
    ? Math.round(tmb * LIFESTYLE_ONLY_FACTORS[profile.trainingActivity!.lifestyleActivity])
    : null;
  const trainingAllowance = usesNewActivityModel
    ? calcHabitualTrainingAllowanceKcal(profile.weightKg, profile.trainingActivity!)
    : null;

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
        {usesNewActivityModel && (
          <span className="badge blue">Actividad: vida diaria + entreno (beta)</span>
        )}
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
          <small>
            {usesNewActivityModel
              ? `${lifestyleTdee} vida diaria + ${trainingAllowance} entreno`
              : "kcal de mantenimiento"}
          </small>
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

      {safety.warnings.includes("aggressive_energy_deficit") && (
        <div className="nutrition-warn-banner" role="alert">
          ⚠ Tu objetivo de hoy ({today.kcal} kcal) es un déficit agresivo — menos del 70% de tu
          TDEE estimado ({tdee} kcal). Revisa si es el ritmo que buscas.
        </div>
      )}
      {!safety.warnings.includes("aggressive_energy_deficit") && safety.warnings.includes("below_resting_energy") && (
        <div className="nutrition-warn-banner">
          Tu objetivo de hoy ({today.kcal} kcal) queda por debajo de tu TMB estimada ({tmb} kcal).
          No es peligroso por sí solo — la TMB no es un mínimo obligatorio — pero merece revisión.
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
  const consumed    = getConsumedToday(state);
  const burnedToday = getKcalBurnedToday(state);
  const targets     = state.nutrition;
  const profile     = state.profile;
  const gymToday    = profile ? isGymDay(profile, dateFromKey(getToday(state))) : false;
  const fiberTarget = calculateFiberTarget(targets.kcal);

  // El objetivo diario no cambia con el entrenamiento de hoy: el PAL/perfil ya
  // asume la actividad habitual, y sumar además cada sesión concreta duplicaría
  // ese mismo entrenamiento en el balance energético. burnedToday se muestra
  // aparte como dato informativo (ver badge más abajo), nunca como presupuesto extra.
  const dailyKcalTarget = targets.kcal;

  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const kcalPct = dailyKcalTarget > 0 ? clamp(Math.round((consumed.kcal    / dailyKcalTarget) * 100)) : 0;
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
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {profile && (
            <span className={`badge ${gymToday ? "green" : "blue"}`}>
              {gymToday ? "Gym 💪" : "Descanso 😴"}
            </span>
          )}
        </div>
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
            <small>/ {dailyKcalTarget} kcal</small>
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
            Fibra recomendada: ~{fiberTarget}g · Detalle de comidas en <strong>Registro</strong>
          </p>
          {burnedToday > 0 && (
            <p className="today-ring-hint workout-informational">
              🔥 Gasto orientativo del entrenamiento de hoy: ~{burnedToday} kcal — no modifica tu objetivo diario.
            </p>
          )}
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
  const today = getToday(state);
  const daysWithData = Array.from({ length: 14 }, (_, i) => dateOffset(today, -i))
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
            {usesEspenAdjustedWeight(profile)
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
