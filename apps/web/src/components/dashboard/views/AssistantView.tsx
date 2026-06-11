"use client";

import Image from "next/image";
import { useState } from "react";
import { MASCOTS } from "@/lib/mascots";
import { assistantMessage, getMascot, useFoodOS } from "@/lib/state";
import { todayPlus, uid } from "@/lib/utils";

type InsightKind = "ticket" | "bank" | "week" | "optimize";

export function AssistantView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [insight, setInsight] = useState("Pulsa una acción para generar un insight local.");
  const active = getMascot(state.mascotId);

  function runInsight(kind: InsightKind) {
    setInsight(assistantMessage(state, kind));
    if (kind === "ticket") {
      mutate((draft) => {
        draft.expenses.push({
          id: uid(), type: "expense", amount: 18.4, category: "Comida",
          description: "Ticket demo OCR", date: todayPlus(0),
        });
      });
    }
    if (kind === "bank") {
      mutate((draft) => {
        draft.bankSynced = true;
        draft.expenses.push({
          id: uid(), type: "expense", amount: 9.75, category: "Comida",
          description: "Banco demo: supermercado", date: todayPlus(0),
        });
      });
    }
    setMascotMessage("Insight generado.");
    showToast("Insight generado");
  }

  return (
    <section className="view">
      <div className="assistant-grid">
        <article className="panel assistant-card">
          <Image src={active.image} alt={`${active.name}, tu compañero`} width={400} height={440} />
          <div>
            <p className="eyebrow">Copiloto silencioso</p>
            <h2>{active.name} cruza tus datos.</h2>
            <p>
              Estas acciones simulan funciones que en producción usarán Gemini, Open Food Facts,
              Nordigen y Supabase.
            </p>
          </div>
        </article>

        <article className="panel">
          <h2>Acciones inteligentes</h2>
          <div className="action-grid">
            <button className="secondary-button" onClick={() => runInsight("ticket")}>
              Leer ticket demo
            </button>
            <button className="secondary-button" onClick={() => runInsight("bank")}>
              Sincronizar banco demo
            </button>
            <button className="secondary-button" onClick={() => runInsight("week")}>
              Crear plan semanal
            </button>
            <button className="secondary-button" onClick={() => runInsight("optimize")}>
              Optimizar proteína/€
            </button>
          </div>
          <div className="insight-box">{insight}</div>
        </article>

        <article className="panel mascot-settings">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Mascota personal</p>
              <h2>Elige tu compañero</h2>
            </div>
          </div>
          <div className="mascot-choice-grid">
            {MASCOTS.map((mascot) => (
              <button
                key={mascot.id}
                className={`mascot-choice ${mascot.id === state.mascotId ? "active" : ""}`}
                onClick={() => {
                  mutate((draft) => void (draft.mascotId = mascot.id));
                  setMascotMessage(`${mascot.name} seleccionado. ${mascot.tagline}.`);
                  showToast(`${mascot.name} es ahora tu compañero`);
                }}
              >
                <span className="mascot-token">
                  <Image src={mascot.image} alt={mascot.name} width={96} height={104} />
                </span>
                <strong>{mascot.name}</strong>
                <small>{mascot.tagline}</small>
              </button>
            ))}
          </div>
          <p className="mascot-selected">
            {active.name} — {active.tagline}
          </p>
        </article>
      </div>
    </section>
  );
}
