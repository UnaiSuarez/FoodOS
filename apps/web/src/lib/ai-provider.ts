import type {
  EquipmentAccess,
  ExperienceLevel,
  FoodOSState,
  GoalMode,
  Recipe,
  Routine,
  RoutineDay,
  RoutineExercise,
  SplitTemplate,
} from "@foodos/types";
import type { AIConfig } from "./ai-config";
import { getMascot } from "./mascots";
import { getBudgetLeft } from "./state";
import { daysUntil, todayPlus, uid } from "./utils";
import { canMakeRequest, recordRequest, getWaitMs } from "./ai-rate-limiter";

function checkRateLimit() {
  if (!canMakeRequest()) {
    const wait = Math.ceil(getWaitMs() / 1000);
    throw new Error(`Límite de solicitudes alcanzado (15/min). Espera ${wait}s antes de intentarlo de nuevo.`);
  }
  recordRequest();
}

function buildPrompt(state: FoodOSState): string {
  const todayDate = state.debugDate ?? todayPlus(0);
  const todayLog = state.foodLog.filter((e) => e.date === todayDate);
  const consumed = todayLog.reduce(
    (acc, e) => ({
      kcal: acc.kcal + e.kcal,
      protein: acc.protein + e.protein,
      carbs: acc.carbs + e.carbs,
      fat: acc.fat + e.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
  const pending = {
    kcal: Math.round(Math.max(0, state.nutrition.kcal - consumed.kcal)),
    protein: Math.round(Math.max(0, state.nutrition.protein - consumed.protein)),
    carbs: Math.round(Math.max(0, state.nutrition.carbs - consumed.carbs)),
    fat: Math.round(Math.max(0, state.nutrition.fat - consumed.fat)),
  };

  // FoodLogEntry no tiene campo "cost" — el gasto real vive en state.expenses
  // (categoría "Comida"), igual que en buildAssistantSystemPrompt.
  const budgetLeft = getBudgetLeft(state);

  const excluded = [
    ...(state.profile?.allergies ?? []),
    ...(state.profile?.excludedFoods ?? []),
  ].filter(Boolean);

  const inventoryLines = state.inventory
    .filter((item) => item.qty > 0)
    .filter((item) => !excluded.some((bad) => item.name.toLowerCase().includes(bad.toLowerCase())))
    .sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires))
    .slice(0, 12)
    .map((item) => {
      const expiresIn = daysUntil(item.expires);
      const expiryLabel = expiresIn <= 0 ? "HOY" : `en ${expiresIn}d`;
      return `  - ${item.name}: ${item.qty}${item.unit}, ${item.protein}g prot/100g, ${item.kcal}kcal/100g, caduca ${expiryLabel}`;
    })
    .join("\n");

  return `Eres chef y nutricionista. Genera UNA receta personalizada. Responde ÚNICAMENTE con JSON válido, sin texto extra ni markdown.

CONTEXTO:
- Macros pendientes hoy: ${pending.kcal} kcal, ${pending.protein}g proteína, ${pending.carbs}g carbos, ${pending.fat}g grasas
- Presupuesto disponible: €${budgetLeft.toFixed(2)}
- Alergias/exclusiones: ${excluded.join(", ") || "ninguna"}
- Inventario disponible (prioriza los que caducan antes):
${inventoryLines || "  Sin inventario registrado, usa ingredientes comunes"}

REGLAS:
- Usa preferentemente ingredientes del inventario
- Respeta estrictamente las alergias/exclusiones
- Ajusta porciones para cubrir aproximadamente los macros pendientes (sin pasarlos)
- Coste ≤ €${budgetLeft > 0 ? budgetLeft.toFixed(2) : "5.00"}
- La receta debe ser realista y sabrosa

JSON requerido (exactamente estos campos, sin más texto):
{"title":"...","ingredients":[{"name":"...","quantity":150,"unit":"g","kcalPer100":165,"proteinPer100":31,"carbsPer100":0,"fatPer100":3.6}],"steps":["Paso 1.","Paso 2."],"kcal":450,"protein":35,"carbs":40,"fat":12,"cost":2.50,"time":20,"servings":1,"difficulty":"fácil","tags":["proteico"]}

IMPORTANTE: Cada ingrediente debe incluir kcalPer100/proteinPer100/carbsPer100/fatPer100 (valores por 100g). Estos son los macros del ingrediente crudo, no de la receta completa.`;
}

function extractJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

function parseRecipe(raw: string): Recipe {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = JSON.parse(extractJSON(raw)) as Record<string, any>;
  return {
    id: uid(),
    title: String(json.title ?? "Receta IA"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ingredients: Array.isArray(json.ingredients) ? json.ingredients.map((ing: any) => ({
      name: String(ing.name ?? ""),
      quantity: Number(ing.quantity ?? 0),
      unit: String(ing.unit ?? "g"),
      ...(ing.kcalPer100    ? { kcalPer100:    Number(ing.kcalPer100)    } : {}),
      ...(ing.proteinPer100 ? { proteinPer100: Number(ing.proteinPer100) } : {}),
      ...(ing.carbsPer100 != null ? { carbsPer100: Number(ing.carbsPer100) } : {}),
      ...(ing.fatPer100   != null ? { fatPer100:   Number(ing.fatPer100)   } : {}),
    })) : [],
    steps: Array.isArray(json.steps) ? json.steps.map(String) : [],
    kcal: Math.round(Number(json.kcal) || 0),
    protein: Math.round(Number(json.protein) || 0),
    carbs: Math.round(Number(json.carbs) || 0),
    fat: Math.round(Number(json.fat) || 0),
    cost: Math.round((Number(json.cost) || 0) * 100) / 100,
    image: "",
    time: Number(json.time) || 20,
    servings: Number(json.servings) || 1,
    difficulty: String(json.difficulty ?? "media"),
    tags: Array.isArray(json.tags) ? json.tags.map(String) : [],
    aiGenerated: true,
  };
}

async function callGemini(config: AIConfig, prompt: string): Promise<string> {
  checkRateLimit();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1536 },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Gemini error ${res.status}`);
  }
  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  return data.candidates[0].content.parts[0].text;
}

async function callOpenAI(config: AIConfig, prompt: string): Promise<string> {
  checkRateLimit();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 1536,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `OpenAI error ${res.status}`);
  }
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content;
}

async function callAnthropic(config: AIConfig, prompt: string): Promise<string> {
  checkRateLimit();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-allow-browser": "true",
    } as Record<string, string>,
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1536,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? `Anthropic error ${res.status}`);
  }
  const data = await res.json() as { content: Array<{ text: string }> };
  return data.content[0].text;
}

async function callOllama(config: AIConfig, prompt: string): Promise<string> {
  const baseUrl = (config.ollamaBaseUrl ?? "http://localhost:11434").replace(/\/$/, "");
  const modelName = config.model === "custom" ? "llama3.2" : config.model;
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature: 0.7 },
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama: error ${res.status}. ¿Está corriendo en ${baseUrl}?`);
  }
  const data = await res.json() as { message: { content: string } };
  return data.message.content;
}

export async function generateAIRecipe(config: AIConfig, state: FoodOSState): Promise<Recipe> {
  const prompt = buildPrompt(state);
  let text: string;
  switch (config.provider) {
    case "gemini":   text = await callGemini(config, prompt);    break;
    case "openai":   text = await callOpenAI(config, prompt);    break;
    case "anthropic": text = await callAnthropic(config, prompt); break;
    case "ollama":   text = await callOllama(config, prompt);    break;
  }
  return parseRecipe(text);
}

export type ChatTurn = { role: "user" | "assistant"; content: string };

function buildAssistantSystemPrompt(state: FoodOSState): string {
  const todayDate = state.debugDate ?? todayPlus(0);
  const todayLog = state.foodLog.filter((e) => e.date === todayDate);
  const consumed = todayLog.reduce(
    (acc, e) => ({ kcal: acc.kcal + e.kcal, protein: acc.protein + e.protein }),
    { kcal: 0, protein: 0 }
  );
  const pending = {
    kcal: Math.round(Math.max(0, state.nutrition.kcal - consumed.kcal)),
    protein: Math.round(Math.max(0, state.nutrition.protein - consumed.protein)),
  };
  const budgetLeft = getBudgetLeft(state);
  const expiringSoon = state.inventory
    .filter((item) => daysUntil(item.expires) <= 3 && item.qty > 0)
    .map((item) => item.name)
    .slice(0, 5)
    .join(", ");
  const inventoryTop = state.inventory
    .filter((item) => item.qty > 0)
    .slice(0, 10)
    .map((i) => `${i.name} (${i.qty}${i.unit})`)
    .join(", ");
  const goal = state.profile?.goal ?? "no configurado";

  const mascot = getMascot(state.mascotId ?? "zana");
  const personalityLine = mascot.personality
    ? `\nPERSONALIDAD: Eres ${mascot.name}. ${mascot.personality} Mantén este tono en todas tus respuestas.\n`
    : "";

  return `Eres el asistente nutricional y financiero de FoodOS. Respondes en español, de forma concisa y útil.
${personalityLine}
DATOS DEL USUARIO (tiempo real):
- Macros pendientes hoy: ${pending.kcal} kcal, ${pending.protein}g proteína
- Presupuesto semanal disponible: €${budgetLeft.toFixed(2)}
- Objetivo: ${goal}
- Inventario: ${inventoryTop || "vacío"}
- Caducan pronto (≤3 días): ${expiringSoon || "ninguno"}
- Alergias/exclusiones: ${state.profile?.allergies?.join(", ") || "ninguna"}

══════════════════════════════════════════════
REGLAS DE ACCIÓN OBLIGATORIAS (tu personalidad NO puede ignorarlas):
══════════════════════════════════════════════
▸ RECETA solicitada (crear, proponer, dame, hazme, necesito, qué como, cena, come) →
  Escribe primero tu respuesta de texto Y DESPUÉS incluye OBLIGATORIAMENTE el tag [RECIPE] con el JSON.
  NUNCA respondas solo con texto cuando pidan una receta.

▸ ALIMENTO para añadir/guardar/registrar →
  Escribe tu respuesta Y DESPUÉS incluye [INV] con el JSON.

▸ Ninguna de las anteriores → responde sin tags.

▸ NUNCA uses [INV] y [RECIPE] a la vez.

FORMATO DE TAGS (JSON en una sola línea, sin saltos dentro del JSON):

[INV]{"name":"Pechuga de pollo","qty":500,"unit":"g","storage":"Nevera","expires_days":5,"price":4.50,"kcal":165,"protein":31}[/INV]
→ unit: g | ml | kg | L | ud   storage: Nevera | Congelador | Despensa

[RECIPE]{"title":"Nombre","ingredients":[{"name":"X","quantity":150,"unit":"g","kcalPer100":165,"proteinPer100":31,"carbsPer100":0,"fatPer100":3.6}],"kcal":450,"protein":35,"carbs":40,"fat":12,"cost":2.50,"time":20,"servings":1,"difficulty":"fácil","tags":["proteico"],"steps":["Paso 1.","Paso 2."]}[/RECIPE]
→ Cada ingrediente DEBE incluir kcalPer100/proteinPer100/carbsPer100/fatPer100 (macros por 100g del ingrediente crudo)
══════════════════════════════════════════════`;
}

export async function callAIChat(
  config: AIConfig,
  state: FoodOSState,
  userMessage: string,
  history: ChatTurn[] = []
): Promise<string> {
  const system = buildAssistantSystemPrompt(state);
  // Keep last 10 turns to avoid token bloat
  const recent = history.slice(-10);

  checkRateLimit();

  switch (config.provider) {
    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
      // Gemini needs alternating user/model turns; embed system in first user message
      type GeminiPart = { text: string };
      type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
      const contents: GeminiContent[] = [];

      if (recent.length === 0) {
        contents.push({ role: "user", parts: [{ text: `${system}\n\n${userMessage}` }] });
      } else {
        recent.forEach((m, i) => {
          const geminiRole = m.role === "assistant" ? "model" : "user";
          const text = i === 0 ? `${system}\n\n${m.content}` : m.content;
          contents.push({ role: geminiRole, parts: [{ text }] });
        });
        contents.push({ role: "user", parts: [{ text: userMessage }] });
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents, generationConfig: { temperature: 0.7, maxOutputTokens: 1536 } }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `Gemini error ${res.status}`);
      }
      const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      return data.candidates[0].content.parts[0].text;
    }

    case "openai": {
      const messages = [
        { role: "system", content: system },
        ...recent.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userMessage },
      ];
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, max_tokens: 1536, temperature: 0.7 }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `OpenAI error ${res.status}`);
      }
      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return data.choices[0].message.content;
    }

    case "anthropic": {
      const messages = [
        ...recent.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user" as const, content: userMessage },
      ];
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-allow-browser": "true",
        } as Record<string, string>,
        body: JSON.stringify({ model: config.model, max_tokens: 1536, system, messages }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `Anthropic error ${res.status}`);
      }
      const data = (await res.json()) as { content: Array<{ text: string }> };
      return data.content[0].text;
    }

    case "ollama": {
      const baseUrl = (config.ollamaBaseUrl ?? "http://localhost:11434").replace(/\/$/, "");
      const modelName = config.model === "custom" ? "llama3.2" : config.model;
      const messages = [
        { role: "system", content: system },
        ...recent.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userMessage },
      ];
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelName, messages, stream: false, options: { temperature: 0.7 } }),
      });
      if (!res.ok) throw new Error(`Ollama: error ${res.status}. ¿Está corriendo en ${baseUrl}?`);
      const data = await res.json() as { message: { content: string } };
      return data.message.content;
    }
  }
}

export type MealSlot = "breakfast" | "almuerzo" | "lunch" | "merienda" | "dinner";
export type WeekPlanResult = Record<string, Partial<Record<MealSlot, string | null>>>;

function buildWeeklyPlanPrompt(state: FoodOSState, recipes: Recipe[], dateKeys: string[]): string {
  const targets = state.nutrition;
  const profile = state.profile;
  const excluded = [...(profile?.allergies ?? []), ...(profile?.excludedFoods ?? [])].filter(Boolean);
  const goalLine = profile ? `Objetivo: ${profile.goal}. Días de gym: ${profile.gymDays.join(",")} (1=lun..7=dom).` : "";

  const recipeLines = recipes
    .slice(0, 40)
    .map((r) => `  {"id":"${r.id}","title":"${r.title}","kcal":${r.kcal},"protein":${r.protein},"carbs":${r.carbs},"fat":${r.fat}}`)
    .join(",\n");

  return `Eres nutricionista. Genera un plan de comidas para ${dateKeys.length} días. Responde SOLO con JSON válido, sin texto extra.

OBJETIVOS DIARIOS: ${targets.kcal} kcal · ${targets.protein}g proteína · ${targets.carbs}g carbos · ${targets.fat}g grasas.
${goalLine}
Alergias/exclusiones: ${excluded.join(", ") || "ninguna"}.

RECETAS DISPONIBLES:
[
${recipeLines}
]

REGLAS:
- Usa solo IDs de las recetas listadas arriba.
- Distribuye entre los 5 slots: breakfast, almuerzo, lunch, merienda, dinner.
- La suma de los slots del día debe aproximarse a los objetivos diarios.
- No repitas la misma receta más de 2 veces en la semana.
- Si no hay suficientes recetas para un slot, usa null.
- Varía los platos para aportar nutrientes diferentes cada día.

DÍAS A PLANIFICAR: ${dateKeys.join(", ")}

JSON requerido (exactamente este formato):
{"${dateKeys[0]}":{"breakfast":"id_o_null","almuerzo":"id_o_null","lunch":"id_o_null","merienda":"id_o_null","dinner":"id_o_null"}${dateKeys.length > 1 ? `,"${dateKeys[1]}":{"breakfast":"id_o_null","almuerzo":"id_o_null","lunch":"id_o_null","merienda":"id_o_null","dinner":"id_o_null"}` : ""}}`;
}

function parseWeekPlan(raw: string, validIds: Set<string>): WeekPlanResult {
  const json = JSON.parse(extractJSON(raw)) as Record<string, Record<string, string | null>>;
  const result: WeekPlanResult = {};
  for (const [date, slots] of Object.entries(json)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const day: Partial<Record<MealSlot, string | null>> = {};
    for (const slot of ["breakfast", "almuerzo", "lunch", "merienda", "dinner"] as MealSlot[]) {
      const val = slots[slot];
      day[slot] = val && validIds.has(val) ? val : null;
    }
    result[date] = day;
  }
  return result;
}

export async function generateAIWeeklyPlan(
  config: AIConfig,
  state: FoodOSState,
  recipes: Recipe[],
  dateKeys: string[]
): Promise<WeekPlanResult> {
  const prompt = buildWeeklyPlanPrompt(state, recipes, dateKeys);
  const validIds = new Set(recipes.map((r) => r.id));
  let text: string;
  switch (config.provider) {
    case "gemini":    text = await callGemini(config, prompt);    break;
    case "openai":    text = await callOpenAI(config, prompt);    break;
    case "anthropic": text = await callAnthropic(config, prompt); break;
    case "ollama":    text = await callOllama(config, prompt);    break;
  }
  return parseWeekPlan(text, validIds);
}

const RECIPE_IMPORT_PROMPT = `Analiza el siguiente texto/imagen y extrae la receta que contiene.
Responde ÚNICAMENTE con JSON válido, sin texto extra ni markdown.
Si no hay receta reconocible, devuelve {"error":"no_recipe"}.

JSON requerido (exactamente estos campos):
{"title":"...","ingredients":[{"name":"...","quantity":150,"unit":"g","kcalPer100":165,"proteinPer100":31,"carbsPer100":0,"fatPer100":3.6}],"steps":["Paso 1.","Paso 2."],"kcal":450,"protein":35,"carbs":40,"fat":12,"cost":2.50,"time":20,"servings":1,"difficulty":"fácil","tags":["proteico"]}

REGLAS:
- Estima los macros nutricionales de los ingredientes aunque no estén en el texto (usa valores típicos).
- Si no hay pasos, genera 2-3 pasos básicos derivados de los ingredientes.
- Adapta las unidades a: g, ml, kg, L, ud.
- Traduce al español si el texto está en otro idioma.`;

export async function importRecipeFromText(config: AIConfig, text: string): Promise<Recipe> {
  const prompt = `${RECIPE_IMPORT_PROMPT}\n\nTEXTO DE LA RECETA:\n${text}`;
  let raw: string;
  switch (config.provider) {
    case "gemini":    raw = await callGemini(config, prompt);    break;
    case "openai":    raw = await callOpenAI(config, prompt);    break;
    case "anthropic": raw = await callAnthropic(config, prompt); break;
    case "ollama":    raw = await callOllama(config, prompt);    break;
  }
  const json = JSON.parse(extractJSON(raw)) as Record<string, unknown>;
  if (json.error) throw new Error("No se detectó ninguna receta en el texto.");
  return parseRecipe(raw);
}

export async function importRecipeFromImage(config: AIConfig, base64: string, mimeType: string): Promise<Recipe> {
  checkRateLimit();
  let raw: string;

  if (config.provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: RECIPE_IMPORT_PROMPT },
            { inlineData: { mimeType, data: base64 } },
          ],
        }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 2048 },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(err.error?.message ?? `Gemini error ${res.status}`);
    }
    const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    raw = data.candidates[0].content.parts[0].text;

  } else if (config.provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model.includes("vision") || config.model.includes("gpt-4o") ? config.model : "gpt-4o",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: RECIPE_IMPORT_PROMPT },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        }],
        max_tokens: 2048,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(err.error?.message ?? `OpenAI error ${res.status}`);
    }
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    raw = data.choices[0].message.content;

  } else if (config.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-allow-browser": "true",
      } as Record<string, string>,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2048,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
            { type: "text", text: RECIPE_IMPORT_PROMPT },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(err.error?.message ?? `Anthropic error ${res.status}`);
    }
    const data = await res.json() as { content: Array<{ text: string }> };
    raw = data.content[0].text;

  } else {
    throw new Error("Tu proveedor de IA no soporta análisis de imágenes. Usa Gemini, OpenAI o Anthropic.");
  }

  const json = JSON.parse(extractJSON(raw)) as Record<string, unknown>;
  if (json.error) throw new Error("No se detectó ninguna receta en la imagen.");
  return parseRecipe(raw);
}

const GOAL_LABELS: Record<GoalMode, string> = {
  fat_loss: "Pérdida de grasa",
  muscle_gain: "Ganancia muscular",
  recomp: "Recomposición corporal",
  maintain: "Mantenimiento",
};

const SPLIT_TEMPLATE_LABELS: Record<SplitTemplate, string> = {
  push_pull_legs: "Push/Pull/Legs (empuje, tirón, pierna)",
  upper_lower: "Torso/Pierna (upper/lower alternado)",
  full_body: "Full body (cuerpo completo cada sesión)",
  bro_split: "Split por grupo muscular (un grupo protagonista por día)",
  ai_decide: "El propio entrenador decide el mejor split para estos días",
};

const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = {
  beginner: "Principiante (poca o ninguna experiencia entrenando con pesas)",
  intermediate: "Intermedio (entrena de forma regular desde hace tiempo)",
  advanced: "Avanzado (mucha experiencia, técnica sólida, alto volumen tolerado)",
};

const EQUIPMENT_LABELS: Record<EquipmentAccess, string> = {
  full_gym: "Gimnasio completo (máquinas, barras, poleas, mancuernas)",
  home_dumbbells: "Casa con mancuernas/bandas, sin máquinas",
  bodyweight: "Sin material, solo peso corporal",
};

export interface RoutineGenerationParams {
  goal: GoalMode;
  weightKg: number;
  /** Días de la semana en que se entrena (recuento, no importa cuáles). */
  gymDaysCount: number;
  splitTemplate: SplitTemplate;
  experienceLevel?: ExperienceLevel;
  equipmentAccess?: EquipmentAccess;
  /** Minutos disponibles por sesión. */
  sessionMinutes: number;
}

export async function generateAIRoutine(config: AIConfig, params: RoutineGenerationParams): Promise<Routine> {
  checkRateLimit();
  const { goal, weightKg, gymDaysCount, splitTemplate, experienceLevel, equipmentAccess, sessionMinutes } = params;
  const goalLabel = GOAL_LABELS[goal] ?? goal;
  const days = Math.max(1, gymDaysCount || 3);

  const prompt = `Eres entrenador personal experto. Diseña un programa de entrenamiento de ${days} día(s) por semana, cada día con su propio foco muscular. Responde SOLO con JSON válido, sin texto extra ni markdown.

Objetivo: ${goalLabel}
Peso corporal: ${weightKg} kg
Días de entrenamiento por semana: ${days}
Split solicitado: ${SPLIT_TEMPLATE_LABELS[splitTemplate]}
Nivel de experiencia: ${experienceLevel ? EXPERIENCE_LABELS[experienceLevel] : "No especificado, asume intermedio"}
Material disponible: ${equipmentAccess ? EQUIPMENT_LABELS[equipmentAccess] : "No especificado, asume gimnasio completo"}
Duración objetivo por sesión: ${sessionMinutes} minutos

JSON requerido (exactamente este formato, un objeto por cada día de entrenamiento):
{"name":"nombre descriptivo del programa","estimatedMinutes":${sessionMinutes},"days":[{"label":"Día 1 · Pecho y tríceps","muscleGroups":["pecho","tríceps"],"exercises":[{"name":"nombre en español","exerciseId":"ai-1-1","notes":"consejo breve","sets":[{"reps":10,"weight":null,"rest":60}]}]}]}

Reglas:
- Genera exactamente ${days} día(s) dentro de "days", cada uno con una etiqueta clara del tipo "Día N · Grupos musculares".
- Cada día debe tener 4-7 ejercicios, coherentes con el material disponible indicado.
- Ajusta el volumen (series/repeticiones) al nivel de experiencia: principiante = menos series y técnica simple, avanzado = más volumen e intensidad.
- Pérdida de grasa: prioriza compuestos con repetición alta (12-15) y densidad. Ganancia muscular: compuestos pesados (5-8) + aislamiento (8-12). Recomposición: mix equilibrado (8-12).
- Peso null para ejercicios de peso corporal, número (kg) para cargas con material.
- exerciseId único por ejercicio, formato "ai-{numDia}-{numEjercicio}".`;

  let text: string;
  switch (config.provider) {
    case "gemini":    text = await callGemini(config, prompt);    break;
    case "openai":    text = await callOpenAI(config, prompt);    break;
    case "anthropic": text = await callAnthropic(config, prompt); break;
    case "ollama":    text = await callOllama(config, prompt);    break;
  }

  type RawExercise = {
    name: string;
    exerciseId?: string;
    notes?: string;
    sets: Array<{ reps: number; weight?: number | null; rest?: number }>;
  };
  const json = JSON.parse(extractJSON(text!)) as {
    name: string;
    estimatedMinutes: number;
    days?: Array<{ label: string; muscleGroups?: string[]; exercises: RawExercise[] }>;
    exercises?: RawExercise[];
  };

  const toRoutineExercise = (ex: RawExercise, fallbackId: string): RoutineExercise => ({
    exerciseId: ex.exerciseId ?? fallbackId,
    name: String(ex.name ?? ""),
    notes: ex.notes,
    sets: (ex.sets ?? []).map((s) => ({
      reps: Number(s.reps) || 10,
      weight: s.weight ?? null,
      rest: Number(s.rest) || 60,
    })),
  });

  const routineDays: RoutineDay[] = (json.days ?? []).map((day, dayIdx) => ({
    label: String(day.label ?? `Día ${dayIdx + 1}`),
    muscleGroups: (day.muscleGroups ?? []).map(String),
    exercises: (day.exercises ?? []).map((ex, i) => toRoutineExercise(ex, `ai-${dayIdx + 1}-${i + 1}`)),
  }));

  return {
    id: uid(),
    name: String(json.name ?? "Rutina IA"),
    goal,
    estimatedMinutes: Number(json.estimatedMinutes) || sessionMinutes || 45,
    // Fallback plano: si la IA no devolvió days (o el proveedor no siguió el formato),
    // usa exercises directo; si hay days, exercises queda como unión para compat legacy.
    exercises: routineDays.length > 0
      ? routineDays.flatMap((d) => d.exercises)
      : (json.exercises ?? []).map((ex, i) => toRoutineExercise(ex, `ai-${i + 1}`)),
    ...(routineDays.length > 0 && { days: routineDays }),
    splitTemplate,
    aiGenerated: true,
    createdAt: new Date().toISOString(),
  };
}

export async function testAIConnection(config: AIConfig): Promise<void> {
  const ping = 'Responde SOLO con este JSON: {"ok":true}';
  switch (config.provider) {
    case "gemini":   await callGemini(config, ping);    break;
    case "openai":   await callOpenAI(config, ping);    break;
    case "anthropic": await callAnthropic(config, ping); break;
    case "ollama":   await callOllama(config, ping);    break;
  }
}
