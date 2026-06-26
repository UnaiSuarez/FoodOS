"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { MASCOTS } from "@/lib/mascots";
import { getMascot, getPendingMacros, getBudgetLeft, useFoodOS } from "@/lib/state";
import { loadAIConfig } from "@/lib/ai-config";
import { callAIChat } from "@/lib/ai-provider";
import { eur } from "@/lib/utils";

type ChatMessage = { role: "user" | "assistant"; text: string };

const QUICK_QUESTIONS = [
  "¿Qué puedo cenar con lo que tengo?",
  "¿Cuánta proteína me falta hoy?",
  "¿Cuál es la receta más barata con proteína?",
  "¿Cómo voy de presupuesto esta semana?",
];

function localReply(
  pending: { kcal: number; protein: number },
  budgetLeft: number,
  msg: string
): string {
  const lower = msg.toLowerCase();
  if (lower.includes("proteína") || lower.includes("protein"))
    return `Te quedan ${Math.round(pending.protein)}g de proteína y ${Math.round(pending.kcal)} kcal para hoy. Mira el optimizador proteína/€ en la vista de Nutrición para las fuentes más baratas.`;
  if (lower.includes("presupuesto") || lower.includes("dinero") || lower.includes("gastar"))
    return `Te quedan ${eur(budgetLeft)} de presupuesto semanal de comida. En Finanzas puedes ver el desglose por semana.`;
  if (lower.includes("cenar") || lower.includes("comer") || lower.includes("receta"))
    return `Con ${Math.round(pending.kcal)} kcal y ${Math.round(pending.protein)}g de proteína pendientes, busca en Recetas filtrando por "disponibles" — ahí verás qué puedes hacer con tu despensa actual.`;
  if (lower.includes("caduc") || lower.includes("inventario"))
    return "Revisa la vista Panel — ahí aparecen los alimentos que caducan pronto y sugerencias de recetas para usarlos.";
  return `Hola! Tengo acceso a tus datos de inventario, nutrición y presupuesto. Para respuestas más precisas conecta tu IA personal (botón ✦ IA en el menú superior). ¿En qué te ayudo?`;
}

export function AssistantView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const active = getMascot(state.mascotId);
  const aiConfig = loadAIConfig();
  const pending = getPendingMacros(state);
  const budgetLeft = getBudgetLeft(state);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setMessages((prev) => [...prev, { role: "user", text: text.trim() }]);
    setInput("");
    setLoading(true);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 40);

    try {
      let reply: string;
      if (aiConfig) {
        try {
          reply = await callAIChat(aiConfig, state, text.trim());
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          const isOverload = msg.includes("high demand") || msg.includes("temporarily") || msg.includes("overloaded") || msg.includes("503") || msg.includes("429");
          if (isOverload) {
            reply = localReply(pending, budgetLeft, text.trim()) +
              "\n\n*(La IA está saturada ahora mismo — respuesta local. Inténtalo de nuevo en unos segundos.)*";
          } else {
            reply = `⚠ ${msg}`;
          }
        }
      } else {
        reply = localReply(pending, budgetLeft, text.trim());
      }
      setMessages((prev) => [...prev, { role: "assistant", text: reply }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      setMessages((prev) => [...prev, { role: "assistant", text: `⚠ ${msg}` }]);
    } finally {
      setLoading(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 40);
    }
  }

  return (
    <section className="view">
      <div className="assistant-grid">
        {/* Panel de chat */}
        <article className="panel chat-panel">
          <div className="chat-header">
            <Image src={active.image} alt={active.name} width={48} height={53} />
            <div>
              <strong>{active.name}</strong>
              <span className={`badge ${aiConfig ? "green" : ""}`}>
                {aiConfig ? "IA conectada" : "Modo local"}
              </span>
            </div>
          </div>

          <div className="chat-messages">
            {messages.length === 0 && (
              <div className="chat-empty">
                <p>
                  Hola, soy {active.name}. Cruzo tus datos de inventario, nutrición y
                  presupuesto en tiempo real. ¿En qué te ayudo?
                </p>
                <div className="quick-chips">
                  {QUICK_QUESTIONS.map((q) => (
                    <button key={q} className="quick-chip" onClick={() => void send(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`chat-bubble ${msg.role}`}>
                {msg.role === "assistant" && (
                  <Image
                    src={active.image}
                    alt={active.name}
                    width={28}
                    height={31}
                    className="bubble-avatar"
                  />
                )}
                <p>{msg.text}</p>
              </div>
            ))}

            {loading && (
              <div className="chat-bubble assistant">
                <Image
                  src={active.image}
                  alt={active.name}
                  width={28}
                  height={31}
                  className="bubble-avatar"
                />
                <p className="chat-thinking">
                  <span /><span /><span />
                </p>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {!aiConfig && (
            <p className="chat-no-ai">
              Respuestas locales activas. Conecta tu IA personal con el botón{" "}
              <strong>✦ IA</strong> arriba para respuestas inteligentes.
            </p>
          )}

          <form
            className="chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Escríbeme algo…"
              disabled={loading}
              autoComplete="off"
            />
            <button
              className="primary-button"
              type="submit"
              disabled={loading || !input.trim()}
            >
              →
            </button>
          </form>
        </article>

        {/* Selector de mascota */}
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
