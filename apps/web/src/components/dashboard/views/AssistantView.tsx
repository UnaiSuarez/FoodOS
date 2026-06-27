"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { Recipe } from "@foodos/types";
import { MASCOTS } from "@/lib/mascots";
import { actions, getMascot, getBudgetLeft, getPendingMacros, buildAiRecipeDraft, useFoodOS } from "@/lib/state";
import { loadAIConfig } from "@/lib/ai-config";
import { callAIChat, type ChatTurn } from "@/lib/ai-provider";
import { eur, todayPlus, uid } from "@/lib/utils";

// ── Tipos ─────────────────────────────────────────────────────────

type InvAdded = { name: string; qty: number; unit: string };

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  invAdded?: InvAdded;
  recipe?: Recipe;
};

// ── Persistencia ──────────────────────────────────────────────────

const CHAT_KEY = "foodos-chat-history";

function stripLegacyTags(text: string): string {
  // Remove complete tags first, then incomplete ones (tag appears but no closing found)
  return text
    .replace(/\[INV\][\s\S]*?\[\/INV\]/g, "")
    .replace(/\[RECIPE\][\s\S]*?\[\/RECIPE\]/g, "")
    .replace(/\[INV\][\s\S]*/g, "")
    .replace(/\[RECIPE\][\s\S]*/g, "")
    .trim();
}

function loadHistory(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    if (!raw) return [];
    const msgs = JSON.parse(raw) as ChatMessage[];
    // Strip any raw action tags left in older messages
    return msgs.map((m) => ({ ...m, text: stripLegacyTags(m.text) }));
  } catch {
    return [];
  }
}

function saveHistory(msgs: ChatMessage[]) {
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-50)));
  } catch {}
}

// ── Parser de acciones ────────────────────────────────────────────

type Parsed = {
  text: string;
  invRaw?: Record<string, unknown>;
  recipeRaw?: Record<string, unknown>;
};

function parseActions(raw: string): Parsed {
  let text = raw;
  let invRaw: Record<string, unknown> | undefined;
  let recipeRaw: Record<string, unknown> | undefined;

  const invMatch = text.match(/\[INV\]([\s\S]*?)\[\/INV\]/);
  if (invMatch) {
    try { invRaw = JSON.parse(invMatch[1].trim()) as Record<string, unknown>; } catch {}
    text = text.replace(invMatch[0], "").trim();
  }

  const recipeMatch = text.match(/\[RECIPE\]([\s\S]*?)\[\/RECIPE\]/);
  if (recipeMatch) {
    try { recipeRaw = JSON.parse(recipeMatch[1].trim()) as Record<string, unknown>; } catch {}
    text = text.replace(recipeMatch[0], "").trim();
  }

  return { text, invRaw, recipeRaw };
}

function buildRecipeFromRaw(raw: Record<string, unknown>): Recipe {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ings = Array.isArray(raw.ingredients) ? (raw.ingredients as any[]).map((i) => ({
    name: String(i.name ?? ""),
    quantity: Number(i.quantity ?? 0),
    unit: String(i.unit ?? "g"),
    ...(i.kcalPer100    ? { kcalPer100:    Number(i.kcalPer100)    } : {}),
    ...(i.proteinPer100 ? { proteinPer100: Number(i.proteinPer100) } : {}),
    ...(i.carbsPer100 != null ? { carbsPer100: Number(i.carbsPer100) } : {}),
    ...(i.fatPer100   != null ? { fatPer100:   Number(i.fatPer100)   } : {}),
  })) : [];
  return {
    id: uid(),
    title: String(raw.title ?? "Receta"),
    ingredients: ings,
    kcal: Number(raw.kcal) || 0,
    protein: Number(raw.protein) || 0,
    carbs: Number(raw.carbs) || 0,
    fat: Number(raw.fat) || 0,
    cost: Number(raw.cost) || 0,
    time: Number(raw.time) || 20,
    servings: Number(raw.servings) || 1,
    difficulty: String(raw.difficulty ?? "media"),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    steps: Array.isArray(raw.steps) ? raw.steps.map(String) : [],
    image: "",
    aiGenerated: true,
  };
}

// ── Frases motivacionales contextuales (sin IA) ──────────────────

function buildContextualTips(
  mascotId: string,
  pending: { kcal: number; protein: number },
  budgetLeft: number,
  state: import("@foodos/types").FoodOSState
): string[] {
  const tips: string[] = [];
  const inv = state.inventory.filter((i) => i.qty > 0);
  const expiringSoon = inv.filter((i) => {
    const d = Math.ceil((new Date(i.expires).getTime() - Date.now()) / 86400000);
    return d >= 0 && d <= 3;
  });

  const totalKcal = state.nutrition.kcal;
  const pctKcal = totalKcal > 0 ? Math.round(((totalKcal - pending.kcal) / totalKcal) * 100) : 0;
  const goal = state.profile?.goal ?? "";

  const dataFacts: string[] = [];
  if (pending.kcal > 0) dataFacts.push(`te quedan ${Math.round(pending.kcal)} kcal y ${Math.round(pending.protein)}g de proteína para hoy`);
  if (pctKcal > 0)      dataFacts.push(`llevas el ${pctKcal}% de tu objetivo calórico hoy`);
  if (budgetLeft > 0)   dataFacts.push(`tu presupuesto disponible es €${budgetLeft.toFixed(2)}`);
  if (expiringSoon.length > 0) dataFacts.push(`${expiringSoon[0].name} caduca en ${Math.max(0, Math.ceil((new Date(expiringSoon[0].expires).getTime() - Date.now()) / 86400000))} días — úsalo pronto`);
  if (inv.length > 0)   dataFacts.push(`tienes ${inv.length} alimentos en el inventario`);
  if (goal === "muscle_gain") dataFacts.push("estás en modo volumen — prioriza proteína en cada comida");
  if (goal === "fat_loss")    dataFacts.push("estás en déficit calórico — las verduras de bajo IG son tus aliadas");
  if (goal === "maintain")    dataFacts.push("en mantenimiento la consistencia es más importante que la perfección");

  // Mapeo de personalidad por mascota
  const wrappers: Record<string, (fact: string) => string> = {
    zana:  (f) => `¡Recuerda, cariño! ${f.charAt(0).toUpperCase() + f.slice(1)}. ¡Tú puedes! 💪`,
    basil: (f) => `Dato registrado: ${f.charAt(0).toUpperCase() + f.slice(1)}. Actúa en consecuencia.`,
    froggy:(f) => `¡Croac! Oye, ${f}. ¡Como diría la rana: más vale saltar que esperar! 🐸`,
    sage:  (f) => `Reflexiona… ${f.charAt(0).toUpperCase() + f.slice(1)}. Cada decisión forma el todo.`,
    chip:  (f) => `[INFO] ${f.charAt(0).toUpperCase() + f.slice(1)}. Optimiza tu siguiente acción.`,
    mushi: (f) => `🍄 ¡Mira! ${f.charAt(0).toUpperCase() + f.slice(1)}. ¡Que florezca tu día!`,
    bruno: (f) => `Oye, ${f}. ¡Cuídate mucho, que Bruno está pendiente de ti! 🐻`,
    pica:  (f) => `¡Sin excusas! ${f.charAt(0).toUpperCase() + f.slice(1)}. ¡Dale fuerte! 🌶️`,
    okto:  (f) => `Procesando… ${f.charAt(0).toUpperCase() + f.slice(1)}. Siguiente paso: optimizar.`,
    kiri:  (f) => `Cuenta tu historia: ${f.charAt(0).toUpperCase() + f.slice(1)}. ¿Cuál es tu próximo capítulo?`,
    vera:  (f) => `Respira. ${f.charAt(0).toUpperCase() + f.slice(1)}. Escucha lo que tu cuerpo necesita.`,
    pingo: (f) => `Registro: ${f.charAt(0).toUpperCase() + f.slice(1)}. Procesando siguiente objetivo.`,
    volt:  (f) => `¡${f.toUpperCase()}! ¡VAMOS A POR ELLO AHORA MISMO! ⚡`,
    leo:   (f) => `Escúchame: ${f.charAt(0).toUpperCase() + f.slice(1)}. Los campeones no descansan.`,
    luna:  (f) => `Bajo la luz de los datos… ${f.charAt(0).toUpperCase() + f.slice(1)}. Sigue tu camino. 🌙`,
  };

  const wrap = wrappers[mascotId] ?? ((f: string) => `${f.charAt(0).toUpperCase() + f.slice(1)}.`);
  for (const fact of dataFacts) tips.push(wrap(fact));
  return tips.length > 0 ? tips : ["¡Registra alimentos para recibir consejos personalizados!"];
}

// ── Respuestas locales ────────────────────────────────────────────

const QUICK_QUESTIONS = [
  "¿Qué puedo cenar con lo que tengo?",
  "¿Cuánta proteína me falta hoy?",
  "Dame una receta rápida y barata",
  "¿Cómo voy de presupuesto esta semana?",
];

function localReply(
  pending: { kcal: number; protein: number },
  budgetLeft: number,
  msg: string
): string {
  const lower = msg.toLowerCase();
  if (lower.includes("proteína") || lower.includes("protein"))
    return `Te quedan ${Math.round(pending.protein)}g de proteína y ${Math.round(pending.kcal)} kcal para hoy. Mira el optimizador proteína/€ en Nutrición para las fuentes más baratas.`;
  if (lower.includes("presupuesto") || lower.includes("dinero") || lower.includes("gastar"))
    return `Te quedan ${eur(budgetLeft)} de presupuesto semanal. En Finanzas puedes ver el desglose por categoría.`;
  if (lower.includes("cenar") || lower.includes("comer") || lower.includes("receta"))
    return `Con ${Math.round(pending.kcal)} kcal y ${Math.round(pending.protein)}g de proteína pendientes, filtra por "disponibles" en Recetas para ver qué puedes hacer con tu despensa.`;
  if (lower.includes("caduc") || lower.includes("inventario"))
    return "En el Panel aparecen los alimentos que caducan pronto con sugerencias de recetas para usarlos.";
  return "Conecta tu IA personal (botón ✦ IA) para respuestas inteligentes sobre tu inventario, macros y presupuesto.";
}

// ── Componente principal ──────────────────────────────────────────

export function AssistantView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  // Inicializar vacío para evitar hidratación SSR; cargar de localStorage en useEffect
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [tipIdx, setTipIdx] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const active = getMascot(state.mascotId);
  const aiConfig = loadAIConfig();
  const pending = getPendingMacros(state);
  const budgetLeft = getBudgetLeft(state);

  // Frases motivacionales contextuales, rotan cada 12 s
  const contextualTips = buildContextualTips(state.mascotId ?? "zana", pending, budgetLeft, state);
  const currentTip = contextualTips[tipIdx % contextualTips.length];

  useEffect(() => {
    if (contextualTips.length <= 1) return;
    const id = setInterval(() => setTipIdx((i) => i + 1), 12000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mascotId, contextualTips.length]);

  // Cargar historial solo en el cliente, tras el montaje
  useEffect(() => {
    const saved = loadHistory();
    if (saved.length > 0) setMessages(saved);
  }, []);

  useEffect(() => {
    saveHistory(messages);
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function addMsg(msg: ChatMessage) {
    setMessages((prev) => [...prev, msg]);
  }

  async function send(text: string) {
    if (!text.trim() || loading) return;
    // Capturar historial ANTES de añadir el nuevo mensaje del usuario
    const historySnapshot: ChatTurn[] = messages.map((m) => ({
      role: m.role,
      content: m.text,
    }));
    addMsg({ role: "user", text: text.trim() });
    setInput("");
    setLoading(true);

    try {
      let rawReply: string;
      if (aiConfig) {
        try {
          rawReply = await callAIChat(aiConfig, state, text.trim(), historySnapshot);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "";
          const isRateOrQuota =
            errMsg.includes("high demand") ||
            errMsg.includes("temporarily") ||
            errMsg.includes("overloaded") ||
            errMsg.includes("503") ||
            errMsg.includes("429") ||
            errMsg.toLowerCase().includes("quota") ||
            errMsg.toLowerCase().includes("exceeded") ||
            errMsg.toLowerCase().includes("rate") ||
            errMsg.toLowerCase().includes("límite");
          rawReply = isRateOrQuota
            ? localReply(pending, budgetLeft, text.trim()) +
              "\n\n*(Cuota de IA agotada — respuesta local. Espera un minuto antes de reintentar.)*"
            : `⚠ ${errMsg}`;
        }
      } else {
        rawReply = localReply(pending, budgetLeft, text.trim());
      }

      const { text: cleanText, invRaw, recipeRaw } = parseActions(rawReply);
      const msg: ChatMessage = { role: "assistant", text: cleanText };

      if (invRaw) {
        const name = String(invRaw.name ?? "Alimento");
        const qty = Number(invRaw.qty ?? 100);
        const unit = String(invRaw.unit ?? "g");
        const expiresDays = Number(invRaw.expires_days ?? 7);
        mutate((draft) => {
          draft.inventory.push({
            id: uid(),
            name,
            qty,
            unit,
            storage: (String(invRaw.storage ?? "Despensa")) as import("@foodos/types").StorageName,
            expires: todayPlus(expiresDays),
            price: Number(invRaw.price ?? 0),
            kcal: Number(invRaw.kcal ?? 0),
            protein: Number(invRaw.protein ?? 0),
          });
        });
        msg.invAdded = { name, qty, unit };
        showToast(`${name} añadido al inventario`);
      }

      if (recipeRaw) {
        msg.recipe = buildRecipeFromRaw(recipeRaw);
      } else {
        // Fallback: si pidieron receta pero la IA no incluyó [RECIPE], generamos una local
        const recipeKeywords = ["receta", "cocinar", "preparar", "cena", "come", "comer", "plato", "hazme", "dame", "propón"];
        const askedForRecipe = recipeKeywords.some((kw) => text.trim().toLowerCase().includes(kw));
        if (askedForRecipe && !invRaw) {
          const draft = buildAiRecipeDraft(state);
          if (draft) msg.recipe = draft;
        }
      }

      addMsg(msg);
    } finally {
      setLoading(false);
    }
  }

  function clearChat() {
    setMessages([]);
    localStorage.removeItem(CHAT_KEY);
    showToast("Conversación borrada");
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
            {messages.length > 0 && (
              <button className="text-button chat-clear" onClick={clearChat} title="Borrar conversación">
                Limpiar
              </button>
            )}
          </div>

          <div className="chat-messages">
            {messages.length === 0 && (
              <div className="chat-empty">
                <p>
                  Hola, soy {active.name}. Cruzo tus datos en tiempo real — inventario, macros y
                  presupuesto. Puedo añadir cosas al inventario o crear recetas directamente desde
                  aquí. ¿En qué te ayudo?
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
                <div className="bubble-content">
                  <p>{msg.text}</p>

                  {/* Chip de inventario añadido */}
                  {msg.invAdded && (
                    <div className="chat-action-chip green">
                      ✓ {msg.invAdded.name} ({msg.invAdded.qty} {msg.invAdded.unit}) añadido al inventario
                    </div>
                  )}

                  {/* Tarjeta de receta inline */}
                  {msg.recipe && (
                    <ChatRecipeCard
                      recipe={msg.recipe}
                      onSave={() => {
                        mutate((draft) => { draft.customRecipes.push(msg.recipe!); });
                        showToast("Receta guardada");
                        setMascotMessage("Receta de la IA guardada en tu colección.");
                      }}
                      onCart={() => {
                        mutate((draft) => actions.addRecipeToCart(draft, msg.recipe!));
                        showToast("Ingredientes añadidos al carrito");
                      }}
                      onCook={() => {
                        mutate((draft) => actions.cookRecipe(draft, msg.recipe!));
                        showToast("Receta registrada en nutrición");
                        setMascotMessage("¡Receta cocinada! Macros actualizados.");
                      }}
                    />
                  )}
                </div>
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
                <div className="bubble-content">
                  <p className="chat-thinking">
                    <span /><span /><span />
                  </p>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Tip motivacional — siempre visible, rota cada 12 s */}
          <div className="chat-mascot-tip" key={tipIdx}>
            <span className="tip-dot" />
            {currentTip}
          </div>

          {!aiConfig && (
            <p className="chat-no-ai">
              Respuestas locales. Conecta tu IA con el botón <strong>✦ IA</strong> para añadir al
              inventario, crear recetas y más.
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
              placeholder="Escríbeme algo… ej: añade 500g de pollo a la nevera"
              disabled={loading}
              autoComplete="off"
            />
            <button className="primary-button" type="submit" disabled={loading || !input.trim()}>
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
                  // Saludo en el estilo de la personalidad del compañero
                  const greetings: Record<string, string> = {
                    zana:  "¡Hola cariño! Soy Zana, y estoy aquí para motivarte en cada paso. ¡Vamos a por ello juntos!",
                    basil: "Selección realizada. Soy Basil. Procederé a analizar tus datos con precisión académica.",
                    froggy:"¡Croac! ¿Sabes qué le dijo la rana a la ensalada? ¡Nada, porque se la comió! Soy Froggy, ¡vamos a divertirnos comiendo sano!",
                    sage:  "Desde otro ángulo... considera que cada elección alimentaria refleja tus valores. Soy Sage. Reflexionemos juntos.",
                    chip:  "Chip activo. Datos cargados. Listo para optimizar tu nutrición.",
                    mushi: "Como una flor que se abre al sol, aquí estoy yo, Mushi, lista para pintar tu día de colores y sabores.",
                    bruno: "¡Aquí Bruno! Cuidar de ti es mi misión. Juntos vamos a construir hábitos que te hagan sentir genial.",
                    pica:  "¡Sin excusas! Soy Pica. ¿Estás listo para dar el 100%? Porque yo ya estoy a tope.",
                    okto:  "Sistema iniciado. 1. Mascota seleccionada: Okto. 2. Objetivo: optimizar tu alimentación. 3. Comenzamos.",
                    kiri:  "Cada alimento tiene una historia que contar, y yo, Kiri, seré tu narrador en este viaje gastronómico.",
                    vera:  "Respira. Con calma y sin prisa. Soy Vera, y te acompañaré a escuchar lo que tu cuerpo necesita de verdad.",
                    pingo: "Registro iniciado. Soy Pingo. Procesaré tus datos con exactitud. Paso 1: bienvenido al sistema.",
                    volt:  "¡VOLT CONECTADO! ¡VAMOS! ¡SIN PARAR! ¡TODO ES POSIBLE! ¡AHORA!",
                    leo:   "Bienvenido. Soy Leo. La disciplina construye campeones. Hoy es un buen día para ser mejor.",
                    luna:  "Como la luna que guía en la oscuridad... aquí estoy, Luna, para acompañarte en silencio hacia tu mejor versión.",
                  };
                  setMascotMessage(greetings[mascot.id] ?? `${mascot.name} seleccionado. ${mascot.tagline}.`);
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

// ── Tarjeta de receta inline ──────────────────────────────────────

function ChatRecipeCard({
  recipe,
  onSave,
  onCart,
  onCook,
}: {
  recipe: Recipe;
  onSave: () => void;
  onCart: () => void;
  onCook: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [cooked, setCooked] = useState(false);

  return (
    <div className="chat-recipe-card">
      <h4>{recipe.title}</h4>
      <div className="meta-row">
        <span className="badge green">{recipe.protein}g prot</span>
        <span className="badge">{recipe.kcal} kcal</span>
        <span className="badge blue">{eur(recipe.cost)}/ración</span>
        <span className="badge">{recipe.time} min</span>
      </div>

      <ul className="chat-ingredients">
        {recipe.ingredients.map((ing) => (
          <li key={ing.name}>
            {ing.name} — {ing.quantity} {ing.unit}
          </li>
        ))}
      </ul>

      {recipe.steps.length > 0 && (
        <ol className="chat-steps">
          {recipe.steps.slice(0, 3).map((step, i) => (
            <li key={i}>{step}</li>
          ))}
          {recipe.steps.length > 3 && (
            <li className="steps-more">… {recipe.steps.length - 3} pasos más</li>
          )}
        </ol>
      )}

      <div className="card-actions">
        <button
          className={`small-action ${saved ? "good" : ""}`}
          onClick={() => { onSave(); setSaved(true); }}
          disabled={saved}
        >
          {saved ? "Guardada ✓" : "Guardar receta"}
        </button>
        <button className="small-action" onClick={onCart}>
          Añadir al carrito
        </button>
        <button
          className={`small-action ${cooked ? "good" : "good"}`}
          onClick={() => { onCook(); setCooked(true); }}
          disabled={cooked}
        >
          {cooked ? "Cocinada ✓" : "Cocinar ahora"}
        </button>
      </div>
    </div>
  );
}
