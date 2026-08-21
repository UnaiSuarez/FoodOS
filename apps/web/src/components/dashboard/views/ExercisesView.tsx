"use client";

import { useState, useEffect, useRef } from "react";
import { getToday, useFoodOS } from "@/lib/state";
import { dateFromKey, dateKeyFromDate, uid } from "@/lib/utils";
import { loadAIConfig } from "@/lib/ai-config";
import { generateAIRoutine } from "@/lib/ai-provider";
import { useEscapeToClose } from "@/lib/use-escape-key";
import type {
  CompletedExercise,
  CompletedSet,
  EquipmentAccess,
  ExperienceLevel,
  GoalMode,
  Routine,
  RoutineDay,
  RoutineExercise,
  SetType,
  SplitTemplate,
  WorkoutSession,
} from "@foodos/types";
import { estimateWorkoutKcal, metForMuscleGroups, EQUIPMENT_LABELS, EXPERIENCE_LABELS } from "@/lib/nutrition";
import { bestE1RM, weeklySetsByMuscle } from "@/lib/strength";

// Traducción de los name_en de wger que más aparecen — el resto se muestra
// tal cual (mejor un nombre en inglés que nada) en vez de mantener una tabla
// exhaustiva de las ~40 entradas del catálogo de músculos de wger.
const MUSCLE_LABELS_ES: Record<string, string> = {
  Chest: "Pecho", Back: "Espalda", Lats: "Dorsal", Shoulders: "Hombros",
  Biceps: "Bíceps", Triceps: "Tríceps", Abs: "Abdomen", Quads: "Cuádriceps",
  Hamstrings: "Isquiotibiales", Glutes: "Glúteos", Calves: "Gemelos",
  Traps: "Trapecio", Forearms: "Antebrazos",
};
function muscleLabel(name: string): string {
  return MUSCLE_LABELS_ES[name] ?? name;
}

// Silueta base sobre la que se superponen los resaltados de músculo (ver
// comentario en WgerMuscle). Confirmado que existen y sirven un SVG de
// ~400KB (mucho más detalle que el resaltado de 1-2 paths) con el mismo
// lienzo 200×369.03, así que ambas capas encajan en las mismas coordenadas.
const WGER_BODY_BASE_FRONT = "https://wger.de/static/images/muscles/muscular_system_front.svg";
const WGER_BODY_BASE_BACK  = "https://wger.de/static/images/muscles/muscular_system_back.svg";

// ─── wger API types ─────────────────────────────────────────────────────────
// wger identifica el idioma de cada traducción con un entero plano (no un
// objeto {id, short_name} como parecía sugerir la forma anterior de este
// tipo) — comprobado contra la API real: 1=de, 2=en, 4=es, 12=fr, etc.
// Bug preexistente: el filtro por "en" nunca coincidía contra este campo
// (comparaba un string con un número), así que siempre caía en trans[0].
const WGER_LANG_ES = 4;
const WGER_LANG_EN = 2;

interface WgerTranslation {
  language: number | null;
  name: string;
  description: string | null;
}
interface WgerMuscle {
  id: number;
  name_en: string;
  is_front: boolean;
  // image_url_main/secondary NO son siluetas de cuerpo completo — son solo
  // la mancha resaltada (roja=principal, naranja=asistente) sobre un lienzo
  // de 200×369.03, pensada para superponerse sobre WGER_BODY_BASE_SVG (esa
  // sí es la silueta completa). Usarlas solas, sin la base debajo, muestra
  // una mancha semitransparente flotando en un lienzo vacío — comprobado
  // descargando el SVG real: solo tiene 1-2 <path> sin ningún contorno.
  image_url_main: string | null;
  image_url_secondary: string | null;
}
interface WgerExerciseInfo {
  id: number;
  equipment: Array<{ id: number; name: string }> | null;
  muscles: WgerMuscle[] | null;
  // Músculos que asisten al movimiento sin ser el objetivo principal — sin
  // esto, un ejercicio como el press de banca solo contaría para "pecho" y
  // nunca para tríceps/hombro en un futuro cálculo de volumen semanal.
  muscles_secondary: WgerMuscle[] | null;
  translations: WgerTranslation[] | null;
}
interface WgerResponse {
  count: number;
  results: WgerExerciseInfo[];
}

const SET_TYPE_LABELS: Record<SetType, string> = {
  normal:   "Normal",
  warmup:   "Calent.",
  dropset:  "Dropset",
  failure:  "Fallo",
};
const SET_TYPES: SetType[] = ["normal", "warmup", "dropset", "failure"];

const WGER_CATEGORIES = [
  { id: 10, label: "Abdomen" },
  { id: 8,  label: "Brazos" },
  { id: 12, label: "Espalda" },
  { id: 11, label: "Pecho" },
  { id: 9,  label: "Piernas" },
  { id: 13, label: "Hombros" },
] as const;

const GOAL_LABELS: Record<GoalMode, string> = {
  fat_loss:    "Pérdida de grasa",
  muscle_gain: "Ganancia muscular",
  recomp:      "Recomposición",
  maintain:    "Mantenimiento",
};

const SPLIT_OPTIONS: Array<{ value: SplitTemplate; label: string; hint: string }> = [
  { value: "ai_decide",      label: "Que decida la IA",   hint: "El entrenador elige el mejor split para tus días" },
  { value: "push_pull_legs", label: "Push/Pull/Legs",     hint: "Empuje, tirón y pierna" },
  { value: "upper_lower",    label: "Torso/Pierna",       hint: "Alterna tren superior e inferior" },
  { value: "full_body",      label: "Full body",          hint: "Cuerpo completo cada sesión" },
  { value: "bro_split",      label: "Por grupo muscular",  hint: "Un grupo protagonista por día" },
];

const EXPERIENCE_OPTIONS = (Object.entries(EXPERIENCE_LABELS) as [ExperienceLevel, string][])
  .map(([value, label]) => ({ value, label }));

const EQUIPMENT_OPTIONS = (Object.entries(EQUIPMENT_LABELS) as [EquipmentAccess, string][])
  .map(([value, label]) => ({ value, label }));

// ─── Main view ───────────────────────────────────────────────────────────────
type Tab = "routines" | "explore" | "history";

export function ExercisesView() {
  const [tab, setTab] = useState<Tab>("routines");
  return (
    <section className="view exercises-view">
      <div className="exercises-tabs">
        <button
          className={`exercises-tab ${tab === "routines" ? "active" : ""}`}
          onClick={() => setTab("routines")}
        >
          Mis rutinas
        </button>
        <button
          className={`exercises-tab ${tab === "explore" ? "active" : ""}`}
          onClick={() => setTab("explore")}
        >
          Explorar
        </button>
        <button
          className={`exercises-tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          Historial
        </button>
      </div>

      {tab === "routines" && <RoutinesTab />}
      {tab === "explore" && <ExploreTab />}
      {tab === "history" && <HistoryTab />}
    </section>
  );
}

// ─── Routines tab ────────────────────────────────────────────────────────────
function RoutinesTab() {
  const { state, mutate, showToast } = useFoodOS();
  const [showCreate, setShowCreate] = useState(false);
  const [showAI, setShowAI]         = useState(false);
  const [aiLoading, setAiLoading]   = useState(false);
  const [aiPreview, setAiPreview]   = useState<Routine | null>(null);
  const [logRoutine, setLogRoutine] = useState<Routine | null>(null);

  const aiConfig = loadAIConfig();
  const profile  = state.profile;
  // Defensive: routines may be undefined if stored state predates this field
  const routines = state.routines ?? [];

  // ── Wizard de generación con IA ──
  const [splitTemplate, setSplitTemplate] = useState<SplitTemplate>("ai_decide");
  const [wizardDays, setWizardDays] = useState(Math.max(1, profile?.gymDays?.length || 3));
  const [experienceLevel, setExperienceLevel] = useState<ExperienceLevel>(profile?.experienceLevel ?? "intermediate");
  const [equipmentAccess, setEquipmentAccess] = useState<EquipmentAccess>(profile?.equipmentAccess ?? "full_gym");
  const [sessionMinutes, setSessionMinutes] = useState(45);

  async function handleGenerateAI() {
    if (!aiConfig) { showToast("Configura la IA primero en Ajustes"); return; }
    if (!profile)  { showToast("Completa el perfil físico en Nutrición"); return; }
    setAiLoading(true);
    try {
      const routine = await generateAIRoutine(aiConfig, {
        goal: profile.goal,
        weightKg: profile.weightKg,
        gymDaysCount: wizardDays,
        splitTemplate,
        experienceLevel,
        equipmentAccess,
        sessionMinutes,
      });
      setAiPreview(routine);
      setShowAI(false);
      // Guarda nivel/material en el perfil para no volver a preguntarlo la próxima vez.
      mutate((d) => {
        if (d.profile) {
          d.profile.experienceLevel = experienceLevel;
          d.profile.equipmentAccess = equipmentAccess;
        }
      });
    } catch (err) {
      showToast((err as Error).message ?? "Error generando rutina");
    } finally {
      setAiLoading(false);
    }
  }

  function savePreview() {
    if (!aiPreview) return;
    mutate((d) => { (d.routines ??= []).push(aiPreview); });
    setAiPreview(null);
    showToast("Rutina guardada");
  }

  function deleteRoutine(id: string) {
    if (!confirm("¿Eliminar esta rutina?")) return;
    mutate((d) => { d.routines = (d.routines ?? []).filter((r) => r.id !== id); });
    showToast("Rutina eliminada");
  }

  return (
    <div className="exercises-body">
      {aiPreview && (
        <RoutinePreviewCard
          routine={aiPreview}
          onSave={savePreview}
          onDiscard={() => setAiPreview(null)}
        />
      )}

      <div className="exercises-actions">
        <button
          className="primary-button"
          onClick={() => { setShowAI(true); setShowCreate(false); }}
          disabled={aiLoading}
        >
          {aiLoading ? "Generando…" : "Generar con IA"}
        </button>
        <button
          className="secondary-button"
          onClick={() => { setShowCreate(true); setShowAI(false); }}
        >
          Crear manualmente
        </button>
      </div>

      {showAI && !aiLoading && (
        <div className="routine-ai-card">
          <p className="routine-ai-desc">
            La IA generará un programa de entrenamiento por días basado en tu objetivo
            {profile ? ` (${GOAL_LABELS[profile.goal]})` : ""}. Configúralo abajo:
          </p>

          <fieldset className="routine-wizard-section">
            <legend>Tipo de split</legend>
            <div className="routine-split-options">
              {SPLIT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`routine-split-option ${splitTemplate === opt.value ? "active" : ""}`}
                  onClick={() => setSplitTemplate(opt.value)}
                >
                  <strong>{opt.label}</strong>
                  <small>{opt.hint}</small>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="form-row">
            <label className="form-label">
              Días de entrenamiento/semana
              <input
                type="number"
                className="form-input"
                value={wizardDays}
                min={1}
                max={7}
                onChange={(e) => setWizardDays(Math.max(1, Math.min(7, Number(e.target.value))))}
              />
            </label>
            <label className="form-label">
              Duración por sesión (min)
              <input
                type="number"
                className="form-input"
                value={sessionMinutes}
                min={15}
                max={180}
                onChange={(e) => setSessionMinutes(Number(e.target.value))}
              />
            </label>
          </div>

          <div className="form-row">
            <label className="form-label">
              Nivel de experiencia
              <select
                className="form-input"
                value={experienceLevel}
                onChange={(e) => setExperienceLevel(e.target.value as ExperienceLevel)}
              >
                {EXPERIENCE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
            <label className="form-label">
              Material disponible
              <select
                className="form-input"
                value={equipmentAccess}
                onChange={(e) => setEquipmentAccess(e.target.value as EquipmentAccess)}
              >
                {EQUIPMENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="routine-ai-actions">
            <button className="primary-button" onClick={handleGenerateAI}>
              Generar ahora
            </button>
            <button className="secondary-button" onClick={() => setShowAI(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateRoutineForm
          onSave={(r) => {
            mutate((d) => { (d.routines ??= []).push(r); });
            setShowCreate(false);
            showToast("Rutina creada");
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {routines.length === 0 && !showCreate && !showAI && !aiPreview && (
        <div className="exercises-empty">
          <p className="exercises-empty-icon">⊙</p>
          <p className="exercises-empty-title">Sin rutinas todavía</p>
          <p className="exercises-empty-hint">
            Genera una con IA o crea la tuya manualmente.
          </p>
        </div>
      )}

      <div className="routines-list">
        {routines.map((r) => (
          <RoutineCard
            key={r.id}
            routine={r}
            onDelete={() => deleteRoutine(r.id)}
            onLog={() => setLogRoutine(r)}
          />
        ))}
      </div>

      {logRoutine && (
        <LogSessionModal
          routine={logRoutine}
          onClose={() => setLogRoutine(null)}
          onSave={(session) => {
            mutate((d) => { (d.workoutLog ??= []).push(session); });
            setLogRoutine(null);
            showToast("Sesión registrada");
          }}
        />
      )}
    </div>
  );
}

// ─── Lista de ejercicios (compartida entre vista plana y por día) ───────────
function ExerciseListView({ exercises }: { exercises: RoutineExercise[] }) {
  return (
    <ul className="routine-exercises-list">
      {exercises.map((ex, i) => (
        <li key={i} className="routine-exercise-item">
          <span className="routine-exercise-name">{ex.name}</span>
          <div className="routine-exercise-sets">
            {(ex.sets ?? []).map((s, j) => (
              <span key={j} className="set-badge">
                {s.reps} rep{s.reps !== 1 ? "s" : ""}
                {s.weight != null ? ` · ${s.weight} kg` : ""}
                {s.rest ? ` · ${s.rest}s` : ""}
              </span>
            ))}
          </div>
          {ex.notes && <p className="routine-exercise-notes">{ex.notes}</p>}
        </li>
      ))}
    </ul>
  );
}

// ─── Routine card ────────────────────────────────────────────────────────────
function RoutineCard({
  routine,
  onDelete,
  onLog,
}: {
  routine: Routine;
  onDelete: () => void;
  onLog: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [activeDay, setActiveDay] = useState(0);
  const label = GOAL_LABELS[routine.goal as GoalMode] ?? routine.goal;
  const days = routine.days ?? [];
  const hasDays = days.length > 0;
  const exercises = hasDays ? (days[activeDay]?.exercises ?? []) : (routine.exercises ?? []);

  return (
    <div className="routine-card">
      {/* E18-03: era un <div onClick> — un toggle de expandir/colapsar solo
          alcanzable con ratón/touch, invisible para teclado y lectores de
          pantalla. */}
      <button
        type="button"
        className="routine-card-header"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <div className="routine-card-meta">
          <span className="routine-card-name">{routine.name}</span>
          <span className="routine-card-badges">
            <span className="routine-badge">{label}</span>
            <span className="routine-badge">{routine.estimatedMinutes} min</span>
            {hasDays && <span className="routine-badge">{days.length} día{days.length !== 1 ? "s" : ""}</span>}
            {routine.aiGenerated && <span className="routine-badge ai">IA</span>}
          </span>
        </div>
        <span className="routine-card-chevron" aria-hidden="true">{expanded ? "▴" : "▾"}</span>
      </button>

      {expanded && (
        <div className="routine-card-body">
          {hasDays && (
            <div className="routine-day-tabs">
              {days.map((day, i) => (
                <button
                  key={i}
                  type="button"
                  className={`routine-day-tab ${activeDay === i ? "active" : ""}`}
                  onClick={() => setActiveDay(i)}
                >
                  {day.label}
                </button>
              ))}
            </div>
          )}

          <ExerciseListView exercises={exercises} />

          <div className="routine-card-actions">
            <button className="primary-button" onClick={onLog}>
              Registrar sesión
            </button>
            <button className="danger-button--small" onClick={onDelete}>
              Eliminar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AI routine preview ──────────────────────────────────────────────────────
function RoutinePreviewExerciseList({ exercises }: { exercises: RoutineExercise[] }) {
  return (
    <ul className="routine-preview-list">
      {exercises.map((ex, i) => {
        const sets = ex.sets ?? [];
        return (
          <li key={i} className="routine-preview-item">
            <strong>{ex.name}</strong>
            {" — "}
            {sets.length} series × {sets[0]?.reps ?? "?"} reps
            {sets[0]?.weight != null ? ` · ${sets[0].weight} kg` : ""}
            {ex.notes ? <em> ({ex.notes})</em> : null}
          </li>
        );
      })}
    </ul>
  );
}

function RoutinePreviewCard({
  routine,
  onSave,
  onDiscard,
}: {
  routine: Routine;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const days = routine.days ?? [];
  return (
    <div className="routine-preview-card">
      <p className="eyebrow">Vista previa de rutina IA</p>
      <h3 className="routine-preview-name">{routine.name}</h3>
      <p className="routine-preview-meta">
        {GOAL_LABELS[routine.goal as GoalMode] ?? routine.goal} · {routine.estimatedMinutes} min estimados
        {days.length > 0 && ` · ${days.length} día${days.length !== 1 ? "s" : ""}`}
      </p>
      {days.length > 0 ? (
        days.map((day, i) => (
          <div key={i} className="routine-preview-day">
            <p className="routine-preview-day-label">{day.label}</p>
            <RoutinePreviewExerciseList exercises={day.exercises} />
          </div>
        ))
      ) : (
        <RoutinePreviewExerciseList exercises={routine.exercises ?? []} />
      )}
      <div className="routine-preview-actions">
        <button className="primary-button" onClick={onSave}>
          Guardar rutina
        </button>
        <button className="secondary-button" onClick={onDiscard}>
          Descartar
        </button>
      </div>
    </div>
  );
}

// ─── Manual creation form ────────────────────────────────────────────────────
function CreateRoutineForm({
  onSave,
  onCancel,
}: {
  onSave: (r: Routine) => void;
  onCancel: () => void;
}) {
  const [name, setName]           = useState("");
  const [goal, setGoal]           = useState<GoalMode>("fat_loss");
  const [mins, setMins]           = useState(45);
  // Rutina de un solo día (sin split): ejercicios sueltos, comportamiento legacy.
  const [exercises, setExercises] = useState<RoutineExercise[]>([]);
  // Rutina con split: uno o más días, cada uno con su propia lista de ejercicios.
  const [days, setDays]           = useState<RoutineDay[]>([]);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [dayLabel, setDayLabel]   = useState("");
  const [exName, setExName]       = useState("");
  const [sets, setSets]           = useState(3);
  const [reps, setReps]           = useState(10);
  const [rest, setRest]           = useState(60);

  const hasDays = days.length > 0;

  function addDay() {
    if (!dayLabel.trim()) return;
    setDays((prev) => [...prev, { label: dayLabel.trim(), muscleGroups: [], exercises: [] }]);
    setActiveDay(days.length); // el que se acaba de añadir
    setDayLabel("");
  }

  function removeDay(i: number) {
    setDays((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      setActiveDay((current) => {
        if (next.length === 0) return null;
        if (current === i) return 0;
        if (current !== null && current > i) return current - 1;
        return current;
      });
      return next;
    });
  }

  function addExercise() {
    if (!exName.trim()) return;
    const ex: RoutineExercise = {
      exerciseId: `custom-${uid()}`,
      name: exName.trim(),
      sets: Array.from({ length: sets }, () => ({ reps, weight: null, rest })),
    };
    if (activeDay !== null) {
      setDays((prev) => prev.map((d, i) => (i === activeDay ? { ...d, exercises: [...d.exercises, ex] } : d)));
    } else {
      setExercises((prev) => [...prev, ex]);
    }
    setExName("");
  }

  function removeExercise(i: number) {
    if (activeDay !== null) {
      setDays((prev) => prev.map((d, idx) => (idx === activeDay ? { ...d, exercises: d.exercises.filter((_, j) => j !== i) } : d)));
    } else {
      setExercises((prev) => prev.filter((_, idx) => idx !== i));
    }
  }

  function handleSave() {
    if (!name.trim()) return;
    onSave({
      id: uid(),
      name: name.trim(),
      goal,
      estimatedMinutes: mins,
      exercises: hasDays ? days.flatMap((d) => d.exercises) : exercises,
      ...(hasDays && { days }),
      createdAt: new Date().toISOString(),
    });
  }

  const activeExercises = activeDay !== null ? (days[activeDay]?.exercises ?? []) : exercises;

  return (
    <div className="create-routine-form">
      <h3>Nueva rutina</h3>

      <label className="form-label">
        Nombre
        <input
          className="form-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ej. Full Body A"
        />
      </label>

      <div className="form-row">
        <label className="form-label">
          Objetivo
          <select className="form-input" value={goal} onChange={(e) => setGoal(e.target.value as GoalMode)}>
            {(Object.entries(GOAL_LABELS) as [GoalMode, string][]).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label className="form-label">
          Duración (min)
          <input
            type="number"
            className="form-input"
            value={mins}
            min={10}
            max={180}
            onChange={(e) => setMins(Number(e.target.value))}
          />
        </label>
      </div>

      <fieldset className="routine-wizard-section">
        <legend>Días (opcional — deja vacío para una rutina de un solo día)</legend>
        {days.length > 0 && (
          <div className="routine-day-tabs">
            {days.map((day, i) => (
              <span key={i} className="routine-day-tab-wrap">
                <button
                  type="button"
                  className={`routine-day-tab ${activeDay === i ? "active" : ""}`}
                  onClick={() => setActiveDay(i)}
                >
                  {day.label}
                </button>
                <button
                  type="button"
                  className="create-exercise-remove"
                  onClick={() => removeDay(i)}
                  title="Eliminar día"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="create-exercise-row">
          <input
            className="form-input"
            value={dayLabel}
            onChange={(e) => setDayLabel(e.target.value)}
            placeholder="Ej. Día 1 · Pecho y tríceps"
            aria-label="Nombre del día"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDay(); } }}
          />
          <button type="button" className="secondary-button" onClick={addDay}>
            + Añadir día
          </button>
        </div>
      </fieldset>

      <div className="create-exercise-row">
        <input
          className="form-input"
          value={exName}
          onChange={(e) => setExName(e.target.value)}
          placeholder={activeDay !== null ? `Ejercicio para "${days[activeDay]?.label}"` : "Nombre del ejercicio"}
          aria-label="Nombre del ejercicio"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExercise(); } }}
        />
        <input
          type="number"
          className="form-input form-input--small"
          value={sets}
          min={1}
          max={10}
          title="Series"
          onChange={(e) => setSets(Number(e.target.value))}
        />
        <span className="create-exercise-sep">×</span>
        <input
          type="number"
          className="form-input form-input--small"
          value={reps}
          min={1}
          max={100}
          title="Repeticiones"
          onChange={(e) => setReps(Number(e.target.value))}
        />
        <span className="create-exercise-sep">· {rest}s</span>
        <button type="button" className="secondary-button" onClick={addExercise}>
          +
        </button>
      </div>

      {activeExercises.length > 0 && (
        <ul className="create-exercises-preview">
          {activeExercises.map((ex, i) => (
            <li key={i} className="create-exercise-item">
              <span>
                {ex.name} — {(ex.sets ?? []).length}×{ex.sets?.[0]?.reps}
              </span>
              <button
                type="button"
                className="create-exercise-remove"
                onClick={() => removeExercise(i)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="create-routine-actions">
        <button
          className="primary-button"
          onClick={handleSave}
          disabled={!name.trim()}
        >
          Guardar rutina
        </button>
        <button className="secondary-button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

// ─── Log session modal ───────────────────────────────────────────────────────

/**
 * Construye el registro de series reales a partir del plan de la rutina:
 * cada serie planeada (peso × reps) se pre-rellena como punto de partida y
 * arranca marcada como hecha — igual de rápido que antes para quien solo
 * quiere confirmar que siguió el plan, pero editable serie a serie para
 * quien levantó distinto peso o hizo más/menos repeticiones. Antes esto solo
 * guardaba un conteo agregado (setsCompleted/totalSets) sin peso ni reps
 * reales, así que no había datos con los que calcular e1RM, PRs ni volumen.
 */
function buildCompletedFromExercises(exercises: RoutineExercise[]): CompletedExercise[] {
  return exercises.map((ex) => {
    const sets: CompletedSet[] = (ex.sets ?? []).map((s) => ({
      reps: s.reps,
      weight: s.weight ?? null,
      done: true,
      type: "normal",
      rir: null,
    }));
    return {
      exerciseId: ex.exerciseId,
      name: ex.name,
      setsCompleted: sets.length,
      totalSets: sets.length,
      sets,
      ...(ex.muscles && ex.muscles.length > 0 && { muscles: ex.muscles }),
    };
  });
}

function LogSessionModal({
  routine,
  onClose,
  onSave,
}: {
  routine: Routine;
  onClose: () => void;
  onSave: (s: WorkoutSession) => void;
}) {
  useEscapeToClose(onClose); // E18-03: ver comentario en BarcodeScannerModal.tsx
  const { state } = useFoodOS();
  const today = getToday(state);
  const defaultDur = routine.estimatedMinutes ?? 45;

  const days = routine.days ?? [];
  const hasDays = days.length > 0;
  const [selectedDay, setSelectedDay] = useState(0);

  // Auto-estimate kcal usando el MET del grupo muscular del día seleccionado
  // (ej. pierna/espalda pesan más que brazo/abdomen a la misma duración) +
  // peso del perfil. Sin días con split, cae al MET moderado de siempre.
  const weightKg = state.profile?.weightKg ?? 75;
  const sessionMet = metForMuscleGroups(hasDays ? days[selectedDay]?.muscleGroups : undefined);
  const defaultKcal = estimateWorkoutKcal(weightKg, defaultDur, sessionMet);

  const [date, setDate]       = useState(today);
  const [duration, setDur]    = useState(defaultDur);
  const [kcal, setKcal]       = useState<number | "">(defaultKcal);
  const [kcalEdited, setKcalEdited] = useState(false);
  const [notes, setNotes]     = useState("");

  // Exercicios del día seleccionado (o de la rutina completa si no tiene split).
  const exercises = hasDays ? (days[selectedDay]?.exercises ?? []) : (routine.exercises ?? []);
  const [completed, setCompleted] = useState<CompletedExercise[]>(() =>
    buildCompletedFromExercises(exercises),
  );

  // Temporizador de descanso: arranca solo al marcar una serie como hecha,
  // con la duración planeada de ESA serie (ExerciseSet.rest, 60s si no se
  // definió) — el mismo patrón que Hevy/Strong, para no tener que mirar el
  // reloj entre series. `restTotal` se usa para la barra de progreso.
  const [restSeconds, setRestSeconds] = useState<number | null>(null);
  const [restTotal, setRestTotal]     = useState(60);

  useEffect(() => {
    if (restSeconds == null || restSeconds <= 0) return;
    const id = setTimeout(() => setRestSeconds((s) => (s == null ? null : s - 1)), 1000);
    return () => clearTimeout(id);
  }, [restSeconds]);

  // Vibración corta al llegar a 0 (si el dispositivo lo soporta) — feedback
  // sin tener que mirar la pantalla, igual que el resto de apps de logging.
  useEffect(() => {
    if (restSeconds !== 0) return;
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(200);
    }
  }, [restSeconds]);

  // Al cambiar de día, el registro de series se reinicia al nuevo día — y la
  // estimación de kcal se recalcula con el MET de ESE día (ej. pasar de
  // "Pecho" a "Piernas" sube el gasto estimado), salvo que el usuario ya la
  // haya corregido a mano.
  function handleSelectDay(idx: number) {
    setSelectedDay(idx);
    setCompleted(buildCompletedFromExercises(days[idx]?.exercises ?? []));
    if (!kcalEdited) {
      const met = metForMuscleGroups(days[idx]?.muscleGroups);
      setKcal(estimateWorkoutKcal(weightKg, duration, met));
    }
  }

  // Re-estimate kcal when duration changes (unless user overrode it manually)
  function handleDurChange(val: number) {
    setDur(val);
    if (!kcalEdited) {
      setKcal(estimateWorkoutKcal(weightKg, val, sessionMet));
    }
  }

  /** Edita una serie concreta (peso, reps o si se hizo) y recalcula el
      conteo agregado setsCompleted/totalSets a partir de las series reales,
      para que siga siendo consistente con lo que ya lee el resto de la app.
      Marcar una serie como hecha (false → true) arranca el temporizador de
      descanso con la duración planeada de esa serie. */
  function updateSet(exIdx: number, setIdx: number, patch: Partial<CompletedSet>) {
    const wasDone = completed[exIdx]?.sets?.[setIdx]?.done ?? false;
    setCompleted((prev) =>
      prev.map((ex, i) => {
        if (i !== exIdx) return ex;
        const sets = (ex.sets ?? []).map((s, j) => (j === setIdx ? { ...s, ...patch } : s));
        return { ...ex, sets, setsCompleted: sets.filter((s) => s.done).length, totalSets: sets.length };
      }),
    );
    if (patch.done === true && !wasDone) {
      const plannedRest = exercises[exIdx]?.sets?.[setIdx]?.rest ?? 60;
      setRestTotal(plannedRest);
      setRestSeconds(plannedRest);
    }
  }

  function adjustRest(deltaSeconds: number) {
    setRestSeconds((s) => (s == null ? null : Math.max(0, s + deltaSeconds)));
  }

  function handleSave() {
    onSave({
      id: uid(),
      routineId: routine.id,
      routineName: routine.name,
      dayLabel: hasDays ? days[selectedDay]?.label : undefined,
      date,
      durationMin: duration,
      kcalBurned: kcal === "" ? undefined : Number(kcal),
      notes: notes.trim() || undefined,
      completedExercises: completed.length > 0 ? completed : undefined,
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel log-session-panel" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">Registrar sesión</p>
        <h3>{routine.name}</h3>

        {hasDays && (
          <div className="routine-day-tabs">
            {days.map((day, i) => (
              <button
                key={i}
                type="button"
                className={`routine-day-tab ${selectedDay === i ? "active" : ""}`}
                onClick={() => handleSelectDay(i)}
              >
                {day.label}
              </button>
            ))}
          </div>
        )}

        <label className="form-label">
          Fecha
          <input
            type="date"
            className="form-input"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>

        <div className="form-row">
          <label className="form-label">
            Duración (min)
            <input
              type="number"
              className="form-input"
              value={duration}
              min={1}
              onChange={(e) => handleDurChange(Number(e.target.value))}
            />
          </label>
          <label className="form-label">
            <span>
              Kcal quemadas
              {!kcalEdited && (
                <span className="log-kcal-hint"> (estimado)</span>
              )}
            </span>
            <input
              type="number"
              className="form-input"
              value={kcal}
              min={0}
              onChange={(e) => {
                setKcalEdited(true);
                setKcal(e.target.value === "" ? "" : Number(e.target.value));
              }}
            />
          </label>
        </div>

        {/* Registro de series reales: peso × reps por serie, no solo un conteo */}
        {completed.length > 0 && (
          <div className="log-exercises-section">
            <p className="log-exercises-title">Series realizadas</p>
            <ul className="log-exercises-list">
              {completed.map((ex, exIdx) => {
                const e1rm = bestE1RM(ex.sets);
                return (
                  <li key={exIdx} className="log-exercise-card">
                    <div className="log-exercise-header">
                      <span className="log-exercise-name">{ex.name}</span>
                      {e1rm != null && (
                        <span className="log-exercise-e1rm" title="1RM estimado (Epley) de la mejor serie">
                          e1RM ~{e1rm} kg
                        </span>
                      )}
                    </div>
                    <div className="log-sets-rows">
                      {(ex.sets ?? []).map((s, setIdx) => (
                        <div key={setIdx} className={`log-set-row ${s.done ? "done" : ""}`}>
                          <span className="log-set-index">{setIdx + 1}</span>
                          <input
                            type="number"
                            className="form-input form-input--small log-set-weight"
                            value={s.weight ?? ""}
                            min={0}
                            step="0.5"
                            placeholder="corporal"
                            aria-label={`Peso serie ${setIdx + 1} de ${ex.name} (kg)`}
                            onChange={(e) =>
                              updateSet(exIdx, setIdx, {
                                weight: e.target.value === "" ? null : Number(e.target.value),
                              })
                            }
                          />
                          <span className="log-set-x">kg ×</span>
                          <input
                            type="number"
                            className="form-input form-input--small log-set-reps"
                            value={s.reps}
                            min={0}
                            aria-label={`Repeticiones serie ${setIdx + 1} de ${ex.name}`}
                            onChange={(e) => updateSet(exIdx, setIdx, { reps: Number(e.target.value) })}
                          />
                          <span className="log-set-x">reps</span>
                          <select
                            className="form-input form-input--small log-set-type"
                            value={s.type ?? "normal"}
                            aria-label={`Tipo de serie ${setIdx + 1} de ${ex.name}`}
                            onChange={(e) => updateSet(exIdx, setIdx, { type: e.target.value as SetType })}
                          >
                            {SET_TYPES.map((t) => (
                              <option key={t} value={t}>{SET_TYPE_LABELS[t]}</option>
                            ))}
                          </select>
                          <input
                            type="number"
                            className="form-input form-input--small log-set-rir"
                            value={s.rir ?? ""}
                            min={0}
                            max={10}
                            placeholder="RIR"
                            title="Repeticiones en reserva (0 = al fallo) — opcional"
                            aria-label={`RIR serie ${setIdx + 1} de ${ex.name} (opcional)`}
                            onChange={(e) =>
                              updateSet(exIdx, setIdx, {
                                rir: e.target.value === "" ? null : Number(e.target.value),
                              })
                            }
                          />
                          <label className="log-set-done">
                            <input
                              type="checkbox"
                              checked={s.done}
                              onChange={(e) => updateSet(exIdx, setIdx, { done: e.target.checked })}
                            />
                            hecha
                          </label>
                        </div>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <label className="form-label">
          Notas
          <input
            className="form-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Opcional"
          />
        </label>

        {restSeconds != null && (
          <div className="rest-timer" role="status" aria-live="polite">
            <div className="rest-timer-bar">
              <div
                className="rest-timer-fill"
                style={{ width: `${restTotal > 0 ? Math.max(0, (restSeconds / restTotal) * 100) : 0}%` }}
              />
            </div>
            <div className="rest-timer-row">
              <span className="rest-timer-label">
                {restSeconds > 0 ? "Descanso" : "¡Listo!"}
              </span>
              <span className="rest-timer-clock">
                {Math.floor(restSeconds / 60)}:{String(restSeconds % 60).padStart(2, "0")}
              </span>
              <div className="rest-timer-controls">
                <button type="button" className="rest-timer-btn" onClick={() => adjustRest(-15)}>−15s</button>
                <button type="button" className="rest-timer-btn" onClick={() => adjustRest(15)}>+15s</button>
                <button type="button" className="rest-timer-btn rest-timer-skip" onClick={() => setRestSeconds(null)}>
                  Saltar
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="primary-button" onClick={handleSave}>
            Guardar sesión
          </button>
          <button className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Explore tab ─────────────────────────────────────────────────────────────
// El catálogo de wger es estático: cachear por categoría evita re-descargar
// la misma lista en cada montaje de la pestaña o cambio de categoría ida-vuelta.
const wgerCache = new Map<number, WgerExerciseInfo[]>();

function ExploreTab() {
  const { state, mutate, showToast } = useFoodOS();
  const [categoryId, setCategoryId] = useState<number>(12);
  const [exercises, setExercises]   = useState<WgerExerciseInfo[]>([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [addTarget, setAddTarget]   = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Defensive read — same as RoutinesTab
  const routines = state.routines ?? [];

  useEffect(() => {
    const cached = wgerCache.get(categoryId);
    if (cached) {
      setExercises(cached);
      setLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    setError(null);
    setExercises([]);

    fetch(
      // language=2 (inglés) da la cobertura de catálogo más amplia — casi todo
      // ejercicio de wger tiene traducción en inglés, no todos en español.
      // getExName() ya prioriza la traducción en español cuando existe.
      // limit=250: la categoría más grande (Piernas) tiene 206 ejercicios;
      // wger pagina a 20 por defecto si no se pide explícitamente más.
      `https://wger.de/api/v2/exerciseinfo/?format=json&language=2&category=${categoryId}&limit=250`,
      { signal: abortRef.current.signal },
    )
      .then((r) => r.json() as Promise<WgerResponse>)
      .then((data) => {
        const results = data.results ?? [];
        wgerCache.set(categoryId, results);
        setExercises(results);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setError("No se pudo conectar con la API de ejercicios.");
        setLoading(false);
      });

    return () => abortRef.current?.abort();
  }, [categoryId]);

  function getExName(ex: WgerExerciseInfo): string {
    const trans = ex.translations ?? [];
    return (
      trans.find((t) => t.language === WGER_LANG_ES)?.name ??
      trans.find((t) => t.language === WGER_LANG_EN)?.name ??
      trans[0]?.name ??
      `Ejercicio ${ex.id}`
    );
  }

  // Las descripciones de wger vienen como HTML simple (<p>, <ul><li>) y a
  // veces con mojibake (UTF-8 mal reinterpretado) en traducciones no
  // inglesas — problema de origen en los datos de wger, no de este parseo.
  // Aquí solo se limpian las etiquetas para poder mostrarlo como texto plano.
  function stripHtml(html: string): string {
    return html
      .replace(/<\/(p|li|div)>/gi, "\n")
      .replace(/<li>/gi, "• ")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getExDescription(ex: WgerExerciseInfo): string | null {
    const trans = ex.translations ?? [];
    const raw =
      trans.find((t) => t.language === WGER_LANG_ES)?.description ??
      trans.find((t) => t.language === WGER_LANG_EN)?.description ??
      trans[0]?.description ??
      null;
    if (!raw) return null;
    const text = stripHtml(raw);
    return text || null;
  }

  function addToRoutine(ex: WgerExerciseInfo, routineId: string) {
    const name = getExName(ex);
    // name_en viene vacío en algunas entradas de wger (dato incompleto en su
    // propia base) — se descartan esas para no guardar cadenas vacías.
    const muscles          = (ex.muscles ?? []).map((m) => m.name_en).filter(Boolean);
    const musclesSecondary = (ex.muscles_secondary ?? []).map((m) => m.name_en).filter(Boolean);
    const newEx: RoutineExercise = {
      exerciseId: String(ex.id),
      name,
      sets: [
        { reps: 10, weight: null, rest: 60 },
        { reps: 10, weight: null, rest: 60 },
        { reps: 10, weight: null, rest: 60 },
      ],
      ...(muscles.length > 0 && { muscles }),
      ...(musclesSecondary.length > 0 && { musclesSecondary }),
    };
    mutate((d) => {
      const r = (d.routines ?? []).find((r) => r.id === routineId);
      if (r) (r.exercises ??= []).push(newEx);
    });
    setAddTarget(null);
    showToast(`"${name}" añadido a la rutina`);
  }

  return (
    <div className="exercises-body">
      <div className="explore-categories">
        {WGER_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            className={`explore-category-btn ${categoryId === cat.id ? "active" : ""}`}
            onClick={() => setCategoryId(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {loading && <p className="exercises-loading">Cargando ejercicios…</p>}
      {error   && <p className="exercises-error">{error}</p>}

      {!loading && !error && exercises.length === 0 && (
        <p className="exercises-empty-hint">No hay ejercicios en esta categoría.</p>
      )}

      <div className="explore-list">
        {exercises.map((ex) => {
          const name              = getExName(ex);
          const muscleList        = ex.muscles ?? [];
          const secondaryList     = ex.muscles_secondary ?? [];
          const muscles           = muscleList.map((m) => m.name_en).join(", ");
          const secondaryMuscles  = secondaryList.map((m) => m.name_en).join(", ");
          const equipment         = (ex.equipment ?? []).map((e) => e.name).join(", ");
          const description       = getExDescription(ex);
          const isAdding          = addTarget === ex.id;

          // Silueta de cuerpo con el/los músculo(s) resaltado(s): base
          // (frontal o dorsal, según el primer músculo con dato) + una capa
          // roja por músculo principal + una naranja por asistente — solo
          // las que coincidan con esa misma vista, ver comentario en
          // WgerMuscle. Sin eso, la mancha resaltada sola no se entiende.
          const diagramIsFront = muscleList[0]?.is_front ?? secondaryList[0]?.is_front ?? null;
          const diagramOverlays = diagramIsFront == null ? [] : [
            ...muscleList
              .filter((m) => m.is_front === diagramIsFront && m.image_url_main)
              .map((m) => m.image_url_main as string),
            ...secondaryList
              .filter((m) => m.is_front === diagramIsFront && m.image_url_secondary)
              .map((m) => m.image_url_secondary as string),
          ];

          return (
            <div key={ex.id} className="exercise-card">
              <div className="exercise-card-header">
                {diagramIsFront != null && (
                  <div className="exercise-card-muscle-diagram" aria-hidden="true">
                    <img src={diagramIsFront ? WGER_BODY_BASE_FRONT : WGER_BODY_BASE_BACK} alt="" loading="lazy" />
                    {diagramOverlays.map((url, i) => (
                      <img key={i} src={url} alt="" loading="lazy" />
                    ))}
                  </div>
                )}
                <span className="exercise-card-name">{name}</span>
                {!isAdding ? (
                  <button
                    className="secondary-button exercise-card-add"
                    onClick={() => {
                      if (routines.length === 0) {
                        showToast("Crea una rutina primero en 'Mis rutinas'");
                      } else if (routines.length === 1) {
                        addToRoutine(ex, routines[0].id);
                      } else {
                        setAddTarget(ex.id);
                      }
                    }}
                  >
                    + Añadir
                  </button>
                ) : (
                  <div className="exercise-routine-select">
                    <select
                      className="form-input form-input--small"
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) addToRoutine(ex, e.target.value);
                      }}
                    >
                      <option value="" disabled>Elige rutina…</option>
                      {routines.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                    <button
                      className="create-exercise-remove"
                      onClick={() => setAddTarget(null)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
              <div className="exercise-card-meta">
                {muscles          && <span>Músculo: {muscles}</span>}
                {secondaryMuscles && <span>Asisten: {secondaryMuscles}</span>}
                {equipment        && <span>Equipo: {equipment}</span>}
              </div>
              {description && (
                <details className="exercise-card-instructions">
                  <summary>Cómo hacerlo</summary>
                  <p>{description}</p>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── History tab ─────────────────────────────────────────────────────────────
function HistoryTab() {
  const { state, mutate, showToast } = useFoodOS();

  const sessions = [...(state.workoutLog ?? [])].sort((a, b) =>
    b.date.localeCompare(a.date),
  );

  const today = dateFromKey(getToday(state));
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  const weekStartStr = dateKeyFromDate(weekStart);
  const thisWeek = sessions.filter((s) => s.date >= weekStartStr);
  const weekKcal = thisWeek.reduce((sum, s) => sum + (s.kcalBurned ?? 0), 0);
  const weekMins = thisWeek.reduce((sum, s) => sum + s.durationMin, 0);
  // Series de trabajo por músculo esta semana — solo cuenta ejercicios
  // añadidos desde el explorador de wger (los únicos con músculo capturado,
  // ver addToRoutine). El consenso de la investigación para hipertrofia es
  // 10-20 series/músculo/semana — se usa como referencia visual del gráfico.
  const weekSetsByMuscle = Object.entries(weeklySetsByMuscle(thisWeek))
    .sort((a, b) => b[1] - a[1]);
  const maxMuscleSets = weekSetsByMuscle.length > 0 ? Math.max(...weekSetsByMuscle.map(([, n]) => n), 20) : 20;

  function deleteSession(id: string) {
    mutate((d) => {
      d.workoutLog = (d.workoutLog ?? []).filter((s) => s.id !== id);
    });
    showToast("Sesión eliminada");
  }

  return (
    <div className="exercises-body">
      {sessions.length > 0 && (
        <div className="history-summary">
          <div className="history-summary-card">
            <span className="history-summary-value">{thisWeek.length}</span>
            <span className="history-summary-label">sesiones esta semana</span>
          </div>
          <div className="history-summary-card">
            <span className="history-summary-value">{weekMins}</span>
            <span className="history-summary-label">minutos</span>
          </div>
          {weekKcal > 0 && (
            <div className="history-summary-card">
              <span className="history-summary-value">{weekKcal}</span>
              <span className="history-summary-label">kcal quemadas</span>
            </div>
          )}
        </div>
      )}

      {weekSetsByMuscle.length > 0 && (
        <div className="muscle-volume-section">
          <p className="log-exercises-title">Series por músculo esta semana</p>
          <div className="muscle-volume-list">
            {weekSetsByMuscle.map(([muscle, count]) => (
              <div key={muscle} className="muscle-volume-row">
                <span className="muscle-volume-name">{muscleLabel(muscle)}</span>
                <div className="muscle-volume-bar-track">
                  <div
                    className={`muscle-volume-bar-fill ${count >= 10 && count <= 20 ? "in-range" : ""}`}
                    style={{ width: `${Math.min(100, (count / maxMuscleSets) * 100)}%` }}
                  />
                </div>
                <span className="muscle-volume-count">{count}</span>
              </div>
            ))}
          </div>
          <p className="muscle-volume-hint">Referencia habitual para hipertrofia: 10-20 series/músculo/semana.</p>
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="exercises-empty">
          <p className="exercises-empty-icon">⊙</p>
          <p className="exercises-empty-title">Sin sesiones registradas</p>
          <p className="exercises-empty-hint">
            Ve a Mis rutinas y pulsa "Registrar sesión" tras completar un entrenamiento.
          </p>
        </div>
      ) : (
        <div className="sessions-list">
          {sessions.map((s) => {
            // Mejor 1RM estimado entre todos los ejercicios de la sesión —
            // solo existe para sesiones registradas con el nuevo formato de
            // series (peso × reps); sesiones antiguas (solo conteo agregado)
            // devuelven null y simplemente no muestran esta pastilla.
            const sessionE1RM = (s.completedExercises ?? []).reduce<number | null>((best, ex) => {
              const e1rm = bestE1RM(ex.sets);
              return e1rm != null && (best == null || e1rm > best) ? e1rm : best;
            }, null);
            return (
            <div key={s.id} className="session-item">
              <div className="session-item-main">
                <span className="session-item-name">
                  {s.routineName}
                  {s.dayLabel && <span className="session-item-day"> · {s.dayLabel}</span>}
                </span>
                <span className="session-item-date">
                  {new Date(s.date + "T12:00:00").toLocaleDateString("es-ES", {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                  })}
                </span>
              </div>
              <div className="session-item-meta">
                <span>{s.durationMin} min</span>
                {s.kcalBurned ? <span>{s.kcalBurned} kcal</span> : null}
                {sessionE1RM != null && (
                  <span title="1RM estimado (Epley) más alto de la sesión, entre todas las series registradas">
                    🏋 e1RM {sessionE1RM} kg
                  </span>
                )}
                {s.notes ? <span className="session-item-notes">{s.notes}</span> : null}
              </div>
              <button
                className="create-exercise-remove session-delete"
                onClick={() => deleteSession(s.id)}
                title="Eliminar sesión"
              >
                ×
              </button>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
