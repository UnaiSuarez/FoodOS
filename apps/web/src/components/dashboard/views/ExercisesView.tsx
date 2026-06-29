"use client";

import { useState, useEffect, useRef } from "react";
import { useFoodOS } from "@/lib/state";
import { uid } from "@/lib/utils";
import { loadAIConfig } from "@/lib/ai-config";
import { generateAIRoutine } from "@/lib/ai-provider";
import type { Routine, RoutineExercise, WorkoutSession, CompletedExercise, GoalMode } from "@foodos/types";
import { estimateWorkoutKcal } from "@/lib/nutrition";

// ─── wger API types ─────────────────────────────────────────────────────────
interface WgerTranslation {
  language: { id: number; short_name: string } | null;
  name: string;
}
interface WgerExerciseInfo {
  id: number;
  equipment: Array<{ id: number; name: string }> | null;
  muscles: Array<{ id: number; name_en: string }> | null;
  translations: WgerTranslation[] | null;
}
interface WgerResponse {
  count: number;
  results: WgerExerciseInfo[];
}

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

  async function handleGenerateAI() {
    if (!aiConfig) { showToast("Configura la IA primero en Ajustes"); return; }
    if (!profile)  { showToast("Completa el perfil físico en Nutrición"); return; }
    setAiLoading(true);
    try {
      const routine = await generateAIRoutine(
        aiConfig,
        profile.goal,
        profile.weightKg,
        (profile.gymDays ?? []).length,
      );
      setAiPreview(routine);
      setShowAI(false);
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
            La IA generará una rutina basada en tu objetivo
            {profile
              ? ` (${GOAL_LABELS[profile.goal]}, ${(profile.gymDays ?? []).length} días/semana)`
              : ""}.
          </p>
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
  const label = GOAL_LABELS[routine.goal as GoalMode] ?? routine.goal;
  const exercises = routine.exercises ?? [];

  return (
    <div className="routine-card">
      <div className="routine-card-header" onClick={() => setExpanded((e) => !e)}>
        <div className="routine-card-meta">
          <span className="routine-card-name">{routine.name}</span>
          <span className="routine-card-badges">
            <span className="routine-badge">{label}</span>
            <span className="routine-badge">{routine.estimatedMinutes} min</span>
            {routine.aiGenerated && <span className="routine-badge ai">IA</span>}
          </span>
        </div>
        <span className="routine-card-chevron">{expanded ? "▴" : "▾"}</span>
      </div>

      {expanded && (
        <div className="routine-card-body">
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
function RoutinePreviewCard({
  routine,
  onSave,
  onDiscard,
}: {
  routine: Routine;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const exercises = routine.exercises ?? [];
  return (
    <div className="routine-preview-card">
      <p className="eyebrow">Vista previa de rutina IA</p>
      <h3 className="routine-preview-name">{routine.name}</h3>
      <p className="routine-preview-meta">
        {GOAL_LABELS[routine.goal as GoalMode] ?? routine.goal} · {routine.estimatedMinutes} min estimados
      </p>
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
  const [exercises, setExercises] = useState<RoutineExercise[]>([]);
  const [exName, setExName]       = useState("");
  const [sets, setSets]           = useState(3);
  const [reps, setReps]           = useState(10);
  const [rest, setRest]           = useState(60);

  function addExercise() {
    if (!exName.trim()) return;
    const ex: RoutineExercise = {
      exerciseId: `custom-${uid()}`,
      name: exName.trim(),
      sets: Array.from({ length: sets }, () => ({ reps, weight: null, rest })),
    };
    setExercises((prev) => [...prev, ex]);
    setExName("");
  }

  function removeExercise(i: number) {
    setExercises((prev) => prev.filter((_, idx) => idx !== i));
  }

  function handleSave() {
    if (!name.trim()) return;
    onSave({
      id: uid(),
      name: name.trim(),
      goal,
      estimatedMinutes: mins,
      exercises,
      createdAt: new Date().toISOString(),
    });
  }

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

      <div className="create-exercise-row">
        <input
          className="form-input"
          value={exName}
          onChange={(e) => setExName(e.target.value)}
          placeholder="Nombre del ejercicio"
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

      {exercises.length > 0 && (
        <ul className="create-exercises-preview">
          {exercises.map((ex, i) => (
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
function LogSessionModal({
  routine,
  onClose,
  onSave,
}: {
  routine: Routine;
  onClose: () => void;
  onSave: (s: WorkoutSession) => void;
}) {
  const { state } = useFoodOS();
  const today = new Date().toISOString().slice(0, 10);
  const defaultDur = routine.estimatedMinutes ?? 45;

  // Auto-estimate kcal using MET 5.0 (fuerza moderada) + peso del perfil
  const weightKg = state.profile?.weightKg ?? 75;
  const defaultKcal = estimateWorkoutKcal(weightKg, defaultDur);

  const [date, setDate]       = useState(today);
  const [duration, setDur]    = useState(defaultDur);
  const [kcal, setKcal]       = useState<number | "">(defaultKcal);
  const [kcalEdited, setKcalEdited] = useState(false);
  const [notes, setNotes]     = useState("");

  // Exercise completion: starts all sets as "todo completado"
  const exercises = routine.exercises ?? [];
  const [completed, setCompleted] = useState<CompletedExercise[]>(() =>
    exercises.map((ex) => ({
      exerciseId: ex.exerciseId,
      name: ex.name,
      setsCompleted: (ex.sets ?? []).length,
      totalSets: (ex.sets ?? []).length,
    })),
  );

  // Re-estimate kcal when duration changes (unless user overrode it manually)
  function handleDurChange(val: number) {
    setDur(val);
    if (!kcalEdited) {
      setKcal(estimateWorkoutKcal(weightKg, val));
    }
  }

  function setSetsCompleted(idx: number, val: number) {
    setCompleted((prev) =>
      prev.map((ex, i) =>
        i === idx ? { ...ex, setsCompleted: Math.max(0, Math.min(val, ex.totalSets)) } : ex,
      ),
    );
  }

  function handleSave() {
    onSave({
      id: uid(),
      routineId: routine.id,
      routineName: routine.name,
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

        {/* Exercise completion checklist */}
        {completed.length > 0 && (
          <div className="log-exercises-section">
            <p className="log-exercises-title">Ejercicios realizados</p>
            <ul className="log-exercises-list">
              {completed.map((ex, i) => (
                <li key={i} className="log-exercise-row">
                  <span className="log-exercise-name">{ex.name}</span>
                  <div className="log-sets-control">
                    <button
                      type="button"
                      className="log-sets-btn"
                      onClick={() => setSetsCompleted(i, ex.setsCompleted - 1)}
                      disabled={ex.setsCompleted === 0}
                    >
                      −
                    </button>
                    <span className={`log-sets-count ${ex.setsCompleted === ex.totalSets ? "done" : ex.setsCompleted === 0 ? "zero" : "partial"}`}>
                      {ex.setsCompleted}/{ex.totalSets}
                    </span>
                    <button
                      type="button"
                      className="log-sets-btn"
                      onClick={() => setSetsCompleted(i, ex.setsCompleted + 1)}
                      disabled={ex.setsCompleted >= ex.totalSets}
                    >
                      +
                    </button>
                    <span className="log-sets-label">series</span>
                  </div>
                </li>
              ))}
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
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    setError(null);
    setExercises([]);

    fetch(
      `https://wger.de/api/v2/exerciseinfo/?format=json&language=2&category=${categoryId}&limit=20`,
      { signal: abortRef.current.signal },
    )
      .then((r) => r.json() as Promise<WgerResponse>)
      .then((data) => {
        setExercises(data.results ?? []);
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
      trans.find((t) => t.language?.short_name === "en")?.name ??
      trans[0]?.name ??
      `Ejercicio ${ex.id}`
    );
  }

  function addToRoutine(ex: WgerExerciseInfo, routineId: string) {
    const name = getExName(ex);
    const newEx: RoutineExercise = {
      exerciseId: String(ex.id),
      name,
      sets: [
        { reps: 10, weight: null, rest: 60 },
        { reps: 10, weight: null, rest: 60 },
        { reps: 10, weight: null, rest: 60 },
      ],
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
          const name      = getExName(ex);
          const muscles   = (ex.muscles   ?? []).map((m) => m.name_en).join(", ");
          const equipment = (ex.equipment ?? []).map((e) => e.name).join(", ");
          const isAdding  = addTarget === ex.id;

          return (
            <div key={ex.id} className="exercise-card">
              <div className="exercise-card-header">
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
                {muscles   && <span>Músculo: {muscles}</span>}
                {equipment && <span>Equipo: {equipment}</span>}
              </div>
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

  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const thisWeek = sessions.filter((s) => s.date >= weekStartStr);
  const weekKcal = thisWeek.reduce((sum, s) => sum + (s.kcalBurned ?? 0), 0);
  const weekMins = thisWeek.reduce((sum, s) => sum + s.durationMin, 0);

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
          {sessions.map((s) => (
            <div key={s.id} className="session-item">
              <div className="session-item-main">
                <span className="session-item-name">{s.routineName}</span>
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
          ))}
        </div>
      )}
    </div>
  );
}
