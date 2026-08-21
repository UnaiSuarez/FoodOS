import type { StorageName } from "@foodos/types";
import type { AIConfig } from "./ai-config";
import { findExactFood } from "./food-db";
import { lookupFoodExternal } from "./food-lookup";
import { checkRateLimit } from "./ai-rate-limiter";

/** Origen de un dato nutricional: "ai" = estimado por el modelo, no verificado en una BD real. */
export type NutriDataSource = "local" | "off" | "usda" | "ai";

export type FoodNutriData = {
  kcal: number;
  protein: number;
  unit: "g" | "ml" | "ud" | "kg" | "L";
  defaultQty: number;
  storage: StorageName;
  expiryDays: number;
  source: NutriDataSource;
};

/** Resultado de identificar un alimento desde foto: igual que FoodNutriData pero con nombre. */
export type IdentifiedFood = FoodNutriData & { name: string };

export type ScannedItem = {
  name: string;
  qty: number;
  unit: string;
  kcal: number;
  protein: number;
  storage: StorageName;
  expiryDays: number;
  price: number;
  /** El escaneo de tickets/fotos siempre pasa por la IA — no hay BD verificada de por medio. */
  source: "ai";
};

function extractJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

function extractJSONArray(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start !== -1 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

async function callAIText(config: AIConfig, prompt: string, maxTokens = 512): Promise<string> {
  switch (config.provider) {
    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `Gemini error ${res.status}`);
      }
      const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      return data.candidates[0].content.parts[0].text;
    }
    case "openai": {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          max_tokens: maxTokens,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `OpenAI error ${res.status}`);
      }
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0].message.content;
    }
    case "anthropic": {
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
          max_tokens: maxTokens,
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
    case "ollama": {
      const baseUrl = (config.ollamaBaseUrl ?? "http://localhost:11434").replace(/\/$/, "");
      const modelName = config.model === "custom" ? "llama3.2" : config.model;
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          options: { temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama: error ${res.status}`);
      const data = await res.json() as { message: { content: string } };
      return data.message.content;
    }
  }
}

/**
 * Rellena datos nutricionales de un alimento usando el siguiente orden de prioridad:
 *   1. BD local (food-db.ts) — instantáneo, sin red
 *   2. Open Food Facts texto search → USDA FoodData Central (con caché 30 días)
 *   3. IA configurada por el usuario — último recurso, consume cuota
 */
export async function fillFoodData(
  config: AIConfig | null,
  name: string
): Promise<FoodNutriData | null> {
  // 1. BD local
  const local = findExactFood(name);
  if (local) {
    return {
      kcal: local.kcal,
      protein: local.protein,
      unit: local.unit,
      defaultQty: local.defaultQty,
      storage: local.storage,
      expiryDays: local.expiryDays,
      source: "local",
    };
  }

  // 2. Open Food Facts + USDA (con caché local)
  const external = await lookupFoodExternal(name);
  if (external) {
    return {
      kcal: external.kcal,
      protein: external.protein,
      unit: "g",
      defaultQty: 100,
      storage: "Nevera",
      expiryDays: 7,
      source: external.source === "usda" ? "usda" : "off",
    };
  }

  if (!config) return null;
  checkRateLimit();

  const prompt = `Dame los datos nutricionales de "${name}" por 100g (o 100ml si es líquido). Solo JSON, sin texto extra.
Formato exacto:
{"kcal":120,"protein":22,"unit":"g","defaultQty":300,"storage":"Nevera","expiryDays":4}
Valores válidos → unit: g | ml | ud | kg | L   storage: Nevera | Congelador | Despensa`;

  try {
    const text = await callAIText(config, prompt, 256);
    const parsed = JSON.parse(extractJSON(text)) as Partial<FoodNutriData>;
    return {
      kcal: Number(parsed.kcal ?? 0),
      protein: Number(parsed.protein ?? 0),
      unit: (["g", "ml", "ud", "kg", "L"].includes(String(parsed.unit)) ? parsed.unit : "g") as FoodNutriData["unit"],
      defaultQty: Number(parsed.defaultQty ?? 100),
      storage: (["Nevera", "Congelador", "Despensa"].includes(String(parsed.storage)) ? parsed.storage : "Nevera") as StorageName,
      expiryDays: Number(parsed.expiryDays ?? 7),
      source: "ai",
    };
  } catch {
    return null;
  }
}

/** Analiza una imagen (ticket de compra, etiqueta, foto de comida) y extrae todos los alimentos detectados. */
export async function scanTicketImage(
  config: AIConfig,
  imageBase64: string,
  mimeType: string
): Promise<ScannedItem[]> {
  checkRateLimit();
  const prompt = `Analiza esta imagen (ticket de compra, etiqueta de producto o foto de alimentos) y extrae TODOS los alimentos o productos alimentarios que encuentres.
Responde ÚNICAMENTE con un array JSON. Sin texto extra. Sin markdown.
Formato:
[{"name":"Pechuga de pollo","qty":500,"unit":"g","kcal":165,"protein":31,"storage":"Nevera","expiryDays":4,"price":3.50}]
Valores válidos → unit: g | ml | ud | kg | L   storage: Nevera | Congelador | Despensa
Si no hay alimentos visibles devuelve [].`;

  let text = "";

  switch (config.provider) {
    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType, data: imageBase64 } },
              { text: prompt },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048 },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `Gemini error ${res.status}`);
      }
      const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      text = data.candidates[0].content.parts[0].text;
      break;
    }
    case "openai": {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
              { type: "text", text: prompt },
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
      text = data.choices[0].message.content;
      break;
    }
    case "anthropic": {
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
              { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
              { type: "text", text: prompt },
            ],
          }],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `Anthropic error ${res.status}`);
      }
      const data = await res.json() as { content: Array<{ text: string }> };
      text = data.content[0].text;
      break;
    }
    case "ollama": {
      const baseUrl = (config.ollamaBaseUrl ?? "http://localhost:11434").replace(/\/$/, "");
      const modelName = config.model === "custom" ? "llama3.2" : config.model;
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: prompt, images: [imageBase64] }],
          stream: false,
          options: { temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama: error ${res.status}`);
      const data = await res.json() as { message: { content: string } };
      text = data.message.content;
      break;
    }
  }

  try {
    const raw = JSON.parse(extractJSONArray(text));
    if (!Array.isArray(raw)) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return raw.map((item: any) => ({
      name: String(item.name ?? "Producto"),
      qty: Number(item.qty ?? 100),
      unit: String(item.unit ?? "g"),
      kcal: Number(item.kcal ?? 0),
      protein: Number(item.protein ?? 0),
      storage: (["Nevera", "Congelador", "Despensa"].includes(String(item.storage)) ? item.storage : "Nevera") as StorageName,
      expiryDays: Number(item.expiryDays ?? 7),
      price: Number(item.price ?? 0),
      source: "ai" as const,
    }));
  } catch {
    return [];
  }
}

/**
 * Analiza una foto de un alimento (o su etiqueta nutricional) con visión IA.
 * Devuelve hasta 3 candidatos (el más probable primero) para que el usuario
 * elija antes de rellenar el formulario, en vez de aceptar ciegamente el
 * primer resultado.
 *
 * Por qué: un estudio comparativo de 7 plataformas de reconocimiento de
 * alimentos (JMIR, https://pmc.ncbi.nlm.nih.gov/articles/PMC7752530/) mide
 * top-1 vs top-5 y encuentra una diferencia de ~25 puntos porcentuales de
 * precisión (ej. Foodvisor: 46,2% top-1 → 71,5% top-5) — el propio salto de
 * calidad viene casi gratis con solo mostrar varios candidatos en vez de
 * uno. Ver docs/INVESTIGACION_VISION_Y_ENTRENAMIENTO.md §1.2.
 * Cuando el modelo solo devuelve un candidato (caso claro, ej. una manzana
 * sola en la foto) el llamador puede seguir rellenando sin fricción extra.
 */
export async function identifyFoodFromPhoto(
  config: AIConfig,
  imageBase64: string,
  mimeType: string
): Promise<IdentifiedFood[]> {
  checkRateLimit();
  const prompt =
    `Identifica el alimento o producto de la imagen y proporciona sus datos nutricionales por 100g (o 100ml si es líquido).
Si hay ambigüedad razonable sobre qué alimento es (ej. podría ser dos variedades distintas, o el envase no deja verlo con certeza), devuelve HASTA 3 candidatos posibles, el más probable primero. Si está claro, devuelve solo 1.
Responde ÚNICAMENTE con un array JSON, sin texto extra, sin markdown. Formato exacto:
[{"name":"Manzana","kcal":52,"protein":0.3,"unit":"g","defaultQty":200,"storage":"Nevera","expiryDays":14}]
Valores válidos → unit: g | ml | ud | kg | L   storage: Nevera | Congelador | Despensa
Si no se identifica nada devuelve [].`;

  let text = "";

  switch (config.provider) {
    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 600 },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `Gemini error ${res.status}`);
      }
      const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      text = data.candidates[0].content.parts[0].text;
      break;
    }
    case "openai": {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: "text", text: prompt },
          ]}],
          max_tokens: 600,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `OpenAI error ${res.status}`);
      }
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      text = data.choices[0].message.content;
      break;
    }
    case "anthropic": {
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
          max_tokens: 600,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `Anthropic error ${res.status}`);
      }
      const data = await res.json() as { content: Array<{ text: string }> };
      text = data.content[0].text;
      break;
    }
    case "ollama": {
      const baseUrl = (config.ollamaBaseUrl ?? "http://localhost:11434").replace(/\/$/, "");
      const modelName = config.model === "custom" ? "llama3.2" : config.model;
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: prompt, images: [imageBase64] }],
          stream: false,
          options: { temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama: error ${res.status}`);
      const data = await res.json() as { message: { content: string } };
      text = data.message.content;
      break;
    }
  }

  try {
    const raw = JSON.parse(extractJSONArray(text));
    if (!Array.isArray(raw)) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return raw.slice(0, 3).map((parsed: any) => ({
      name: String(parsed.name ?? "Alimento"),
      kcal: Number(parsed.kcal ?? 0),
      protein: Number(parsed.protein ?? 0),
      unit: (["g", "ml", "ud", "kg", "L"].includes(String(parsed.unit)) ? parsed.unit : "g") as FoodNutriData["unit"],
      defaultQty: Number(parsed.defaultQty ?? 100),
      storage: (["Nevera", "Congelador", "Despensa"].includes(String(parsed.storage)) ? parsed.storage : "Nevera") as StorageName,
      expiryDays: Number(parsed.expiryDays ?? 7),
      source: "ai" as const,
    }));
  } catch {
    return [];
  }
}

/**
 * Estima los macros TOTALES de una comida descrita en texto libre.
 * Devuelve los macros para la comida completa (no por 100g).
 */
export async function estimateMealMacros(
  config: AIConfig,
  description: string
): Promise<{ kcal: number; protein: number; carbs: number; fat: number } | null> {
  const prompt = `Eres nutricionista. Estima los macronutrientes TOTALES para esta comida:
"${description}"
Responde SOLO con JSON: {"kcal":number,"protein":number,"carbs":number,"fat":number}
Valores totales de la comida descrita, no por 100g. Sin explicaciones.`;
  checkRateLimit();
  try {
    const raw = await callAIText(config, prompt, 128);
    const parsed = JSON.parse(extractJSON(raw)) as { kcal?: number; protein?: number; carbs?: number; fat?: number };
    if (typeof parsed.kcal !== "number") return null;
    return {
      kcal: Math.round(parsed.kcal),
      protein: Math.round((parsed.protein ?? 0) * 10) / 10,
      carbs: Math.round((parsed.carbs ?? 0) * 10) / 10,
      fat: Math.round((parsed.fat ?? 0) * 10) / 10,
    };
  } catch {
    return null;
  }
}

/**
 * Identifica una comida completa (puede tener varios alimentos en el plato) a
 * partir de una foto y estima sus macronutrientes TOTALES — el equivalente en
 * foto de estimateMealMacros(). A diferencia de identifyFoodFromPhoto (pensada
 * para UN producto/ingrediente, macros por 100g, flujo de inventario), esto
 * devuelve el total de todo lo visible en el plato, pensado para registrar
 * directamente en el diario. `extraNote` es la descripción opcional que el
 * usuario añade junto a la foto (ej. "con una cucharada extra de aceite") —
 * el mismo patrón que usa MacroFactor para afinar la estimación visual.
 */
export async function estimateMealFromPhoto(
  config: AIConfig,
  imageBase64: string,
  mimeType: string,
  extraNote?: string
): Promise<{ name: string; kcal: number; protein: number; carbs: number; fat: number } | null> {
  checkRateLimit();
  const prompt =
    `Eres nutricionista. Identifica la comida de esta foto — puede tener varios alimentos en el mismo plato — y estima sus macronutrientes TOTALES (de todo lo visible, no por 100g).` +
    (extraNote?.trim() ? `\nNota del usuario: "${extraNote.trim()}"` : "") +
    `\nResponde SOLO con JSON, sin texto extra: {"name":"Nombre breve del plato","kcal":number,"protein":number,"carbs":number,"fat":number}`;

  let text = "";

  switch (config.provider) {
    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 256 },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `Gemini error ${res.status}`);
      }
      const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      text = data.candidates[0].content.parts[0].text;
      break;
    }
    case "openai": {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: "text", text: prompt },
          ]}],
          max_tokens: 256,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `OpenAI error ${res.status}`);
      }
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      text = data.choices[0].message.content;
      break;
    }
    case "anthropic": {
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
          max_tokens: 256,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(err.error?.message ?? `Anthropic error ${res.status}`);
      }
      const data = await res.json() as { content: Array<{ text: string }> };
      text = data.content[0].text;
      break;
    }
    case "ollama": {
      const baseUrl = (config.ollamaBaseUrl ?? "http://localhost:11434").replace(/\/$/, "");
      const modelName = config.model === "custom" ? "llama3.2" : config.model;
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: prompt, images: [imageBase64] }],
          stream: false,
          options: { temperature: 0.3 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama: error ${res.status}`);
      const data = await res.json() as { message: { content: string } };
      text = data.message.content;
      break;
    }
  }

  try {
    const parsed = JSON.parse(extractJSON(text)) as { name?: string; kcal?: number; protein?: number; carbs?: number; fat?: number };
    if (typeof parsed.kcal !== "number") return null;
    return {
      name: String(parsed.name ?? "Comida (foto)"),
      kcal: Math.round(parsed.kcal),
      protein: Math.round((parsed.protein ?? 0) * 10) / 10,
      carbs: Math.round((parsed.carbs ?? 0) * 10) / 10,
      fat: Math.round((parsed.fat ?? 0) * 10) / 10,
    };
  } catch {
    return null;
  }
}
