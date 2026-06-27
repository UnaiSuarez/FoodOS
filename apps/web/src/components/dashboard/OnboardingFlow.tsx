"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";
import type { GoalMode, PhysicalProfile, Sex } from "@foodos/types";
import { useFoodOS } from "@/lib/state";
import { MASCOTS } from "@/lib/mascots";
import { GOAL_DESCRIPTIONS, GOAL_LABELS } from "@/lib/nutrition";

interface Props {
  onDone: () => void;
}

const GOAL_ORDER: GoalMode[] = ["fat_loss", "muscle_gain", "recomp", "maintain"];

export function OnboardingFlow({ onDone }: Props) {
  const { mutate } = useFoodOS();
  const [step, setStep] = useState(0);
  const [mascotId, setMascotId] = useState("zana");
  const [goal, setGoal] = useState<GoalMode>("fat_loss");

  const selectedMascot = MASCOTS.find((m) => m.id === mascotId) ?? MASCOTS[0];

  function chooseMascot(id: string) {
    setMascotId(id);
    mutate((draft) => { draft.mascotId = id; });
  }

  function saveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const profile: PhysicalProfile = {
      age:           Number(d.get("age")),
      sex:           String(d.get("sex")) as Sex,
      heightCm:      Number(d.get("height")),
      weightKg:      Number(d.get("weight")),
      bodyFatPct:    null,
      activityLevel: "moderate",
      goal,
      gymDays:       [1, 3, 5],
      allergies:     [],
      excludedFoods: [],
    };
    mutate((draft) => { draft.profile = profile; });
    onDone();
  }

  const STEP_LABELS = ["Bienvenida", "Tu compañero", "Tu objetivo"];

  return (
    <div className="ob-overlay" role="dialog" aria-modal="true" aria-label="Configuración inicial de FoodOS">
      <div className="ob-card">

        {/* Indicador de pasos */}
        <div className="ob-progress" aria-label={`Paso ${step + 1} de ${STEP_LABELS.length}`}>
          {STEP_LABELS.map((label, i) => (
            <div
              key={label}
              className={`ob-dot ${i === step ? "active" : i < step ? "done" : ""}`}
              title={label}
              aria-hidden="true"
            />
          ))}
        </div>

        {/* ── Paso 0: Bienvenida ── */}
        {step === 0 && (
          <div className="ob-step ob-welcome">
            <p className="ob-brand"><span>Food</span>OS</p>
            <h1 className="ob-headline">Tu cocina, inteligente.</h1>
            <p className="ob-sub">
              Gestiona tu despensa, sigue tus macros y controla el gasto —
              todo en un lugar. La IA decide qué cocinar hoy.
            </p>
            <ul className="ob-features">
              <li>📦 Inventario con alertas de caducidad</li>
              <li>🍳 Recetas que usan lo que tienes en casa</li>
              <li>📊 Macros y seguimiento de peso</li>
              <li>💶 Presupuesto alimentario automático</li>
              <li>✦ Asistente IA contextual</li>
            </ul>
            <div className="ob-actions">
              <button className="ob-cta" onClick={() => setStep(1)}>
                Empezar →
              </button>
              <button className="ob-skip" onClick={onDone}>
                Ya sé lo que hago, entrar directamente
              </button>
            </div>
          </div>
        )}

        {/* ── Paso 1: Elige mascota ── */}
        {step === 1 && (
          <div className="ob-step ob-mascot-step">
            <p className="eyebrow">Paso 1 de 2</p>
            <h2 className="ob-headline">Elige tu compañero</h2>
            <p className="ob-sub">
              Te acompañará, te recordará lo que caduca y celebrará tus logros.
              Puedes cambiarlo en Ajustes en cualquier momento.
            </p>

            <div className="ob-mascot-grid">
              {MASCOTS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`ob-mascot ${m.id === mascotId ? "active" : ""}`}
                  onClick={() => chooseMascot(m.id)}
                  aria-pressed={m.id === mascotId}
                >
                  <Image src={m.image} alt={m.name} width={80} height={90} />
                  <span>{m.name}</span>
                </button>
              ))}
            </div>

            <p className="ob-mascot-tagline" aria-live="polite">
              <strong>{selectedMascot.name}</strong> — {selectedMascot.tagline}
            </p>

            <div className="ob-nav">
              <button type="button" className="ob-back" onClick={() => setStep(0)}>
                ← Atrás
              </button>
              <button type="button" className="ob-cta" onClick={() => setStep(2)}>
                Continuar →
              </button>
            </div>
          </div>
        )}

        {/* ── Paso 2: Perfil físico ── */}
        {step === 2 && (
          <div className="ob-step ob-profile-step">
            <p className="eyebrow">Paso 2 de 2</p>
            <h2 className="ob-headline">Tu objetivo</h2>
            <p className="ob-sub">
              FoodOS calculará tus calorías y macros diarios (fórmula Mifflin-St Jeor).
              Puedes editar estos datos en la sección Nutrición.
            </p>

            <form onSubmit={saveProfile} className="ob-form">
              <div className="ob-form-grid">
                <label>
                  Edad
                  <input name="age" type="number" min="14" max="100" required defaultValue={25} />
                </label>
                <label>
                  Sexo biológico
                  <select name="sex" defaultValue="male">
                    <option value="male">Hombre</option>
                    <option value="female">Mujer</option>
                  </select>
                </label>
                <label>
                  Altura (cm)
                  <input name="height" type="number" min="120" max="230" required defaultValue={175} />
                </label>
                <label>
                  Peso actual (kg)
                  <input name="weight" type="number" min="35" max="250" step="0.1" required defaultValue={75} />
                </label>
              </div>

              <fieldset className="ob-goals">
                <legend>¿Cuál es tu objetivo?</legend>
                <div className="ob-goal-grid">
                  {GOAL_ORDER.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={`ob-goal ${goal === g ? "active" : ""}`}
                      onClick={() => setGoal(g)}
                      aria-pressed={goal === g}
                    >
                      <strong>{GOAL_LABELS[g]}</strong>
                      <small>{GOAL_DESCRIPTIONS[g]}</small>
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="ob-nav">
                <button type="button" className="ob-back" onClick={() => setStep(1)}>
                  ← Atrás
                </button>
                <button type="submit" className="ob-cta">
                  Calcular mis objetivos →
                </button>
              </div>
            </form>
          </div>
        )}

      </div>
    </div>
  );
}
