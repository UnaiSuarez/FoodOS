"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMascot, useFoodOS } from "@/lib/state";
import type { ViewId } from "./DashboardShell";

interface TourStep {
  view?: ViewId;
  selector?: string;
  title: string;
  description: string;
}

const STEPS: TourStep[] = [
  {
    title: "¡Bienvenido a FoodOS!",
    description:
      "Vamos a darte un rápido vistazo por las secciones principales. Puedes saltar el tour en cualquier momento.",
  },
  {
    view: "dashboard",
    selector: "panel-macros",
    title: "Panel diario",
    description:
      "Tu centro de control. De un vistazo ves los macros del día, el agua que llevas, alertas de caducidad y el plan de comidas de hoy.",
  },
  {
    view: "inventory",
    selector: "inventory-add",
    title: "Inventario inteligente",
    description:
      "Registra lo que tienes en casa. Escanea el código de barras, sube una foto del ticket o escribe el nombre — FoodOS rellena los datos nutricionales solo.",
  },
  {
    view: "recipes",
    selector: "recipes-panel",
    title: "Recetas a tu medida",
    description:
      "Recetas ordenadas por lo que ya tienes disponible. Pulsa 'Generar receta IA' para crear una nueva adaptada a tus macros pendientes y presupuesto.",
  },
  {
    view: "diary",
    selector: "diary-log",
    title: "Registro de comidas",
    description:
      "Anota lo que comes cada día. Los macros del Panel se actualizan en tiempo real. También aquí encuentras el historial por fechas y el seguimiento de agua.",
  },
  {
    view: "planner",
    selector: "planner-grid",
    title: "Planificador semanal",
    description:
      "Organiza la semana de comidas. Arrastra recetas a cada franja horaria o deja que la IA genere un plan completo adaptado a tus objetivos y días de gym.",
  },
  {
    view: "finance",
    selector: "finance-summary",
    title: "Finanzas alimentarias",
    description:
      "Controla cuánto gastas en comida. Fija un presupuesto semanal y FoodOS te avisa cuando te acercas al límite. También proyecta tu ahorro a largo plazo.",
  },
  {
    view: "assistant",
    selector: "assistant-chat",
    title: "Asistente IA",
    description:
      "Pregúntale qué cocinar con lo que caduca, cómo cerrar los macros del día o pídele que genere una receta. Conecta tu propia IA con el botón ✦ IA para mejores respuestas.",
  },
  {
    view: "dashboard",
    title: "¡Todo listo!",
    description:
      "Ya conoces FoodOS. El mejor punto de partida es añadir alimentos al inventario — el resto fluirá solo. Puedes repetir este tour desde Ajustes cuando quieras.",
  },
];

interface Props {
  setView: (view: ViewId) => void;
  onDone: () => void;
}

export function AppTour({ setView, onDone }: Props) {
  const { state } = useFoodOS();
  const mascot = getMascot(state.mascotId);
  const [step, setStep] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const current = STEPS[step];
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;

  const applyHighlight = useCallback(
    (selector: string | undefined) => {
      document.querySelectorAll("[data-tour]").forEach((el) => el.classList.remove("tour-highlight"));
      if (!selector) return;

      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const el = document.querySelector(`[data-tour="${selector}"]`);
        if (!el) return;
        el.classList.add("tour-highlight");
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 300);
    },
    [],
  );

  useEffect(() => {
    if (current.view) setView(current.view);
    applyHighlight(current.selector);

    return () => {
      clearTimeout(timerRef.current);
      document.querySelectorAll("[data-tour]").forEach((el) => el.classList.remove("tour-highlight"));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function next() {
    if (isLast) { done(); return; }
    setStep((s) => s + 1);
  }

  function back() {
    if (!isFirst) setStep((s) => s - 1);
  }

  function done() {
    document.querySelectorAll("[data-tour]").forEach((el) => el.classList.remove("tour-highlight"));
    localStorage.setItem("foodos-tour-done", "1");
    onDone();
  }

  return (
    <div className="app-tour">
      <div className="tour-card">
        <div className="tour-mascot">
          <Image src={mascot.image} alt={mascot.name} width={52} height={58} />
        </div>

        <div className="tour-content">
          <div className="tour-progress">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`tour-dot${i === step ? " active" : i < step ? " done" : ""}`}
              />
            ))}
          </div>
          <h3 className="tour-title">{current.title}</h3>
          <p className="tour-desc">{current.description}</p>
        </div>

        <div className="tour-actions">
          <button className="tour-skip" onClick={done}>
            Saltar
          </button>
          <div className="tour-btns">
            {!isFirst && (
              <button className="secondary-button" onClick={back}>
                ← Atrás
              </button>
            )}
            <button className="primary-button" onClick={next}>
              {isLast ? "¡Empezar!" : "Siguiente →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
