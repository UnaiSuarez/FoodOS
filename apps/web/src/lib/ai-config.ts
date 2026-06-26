// Configuración de IA personal del usuario.
// La clave API se guarda SOLO en localStorage de este dispositivo.
// Nunca entra en FoodOSState, nunca se exporta, nunca llega a ningún servidor.

export type AIProvider = "gemini" | "openai" | "anthropic" | "ollama";

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
  ollamaBaseUrl?: string;
}

const STORAGE_KEY = "foodos-ai-config";

const GEMINI_MIGRATIONS: Record<string, string> = {
  "gemini-1.5-flash": "gemini-2.5-flash",
  "gemini-1.5-pro":   "gemini-2.5-flash",
  "gemini-2.0-flash": "gemini-2.5-flash",
  "gemini-2.5-pro":   "gemini-2.5-flash",
};

export function loadAIConfig(): AIConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const config = JSON.parse(raw) as AIConfig;
    if (config.provider === "gemini" && GEMINI_MIGRATIONS[config.model]) {
      config.model = GEMINI_MIGRATIONS[config.model];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    }
    return config;
  } catch {
    return null;
  }
}

export function saveAIConfig(config: AIConfig | null): void {
  if (config === null) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }
}

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  gemini: "Google Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama (local)",
};

export const PROVIDER_KEY_LABEL: Record<AIProvider, string> = {
  gemini: "API Key — Google AI Studio",
  openai: "API Key — OpenAI Platform",
  anthropic: "API Key — Anthropic Console",
  ollama: "Sin clave (modelo local)",
};

export const PROVIDER_KEY_LINK: Record<AIProvider, string> = {
  gemini: "https://aistudio.google.com/app/apikey",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  ollama: "https://ollama.com",
};

export const PROVIDER_KEY_LINK_LABEL: Record<AIProvider, string> = {
  gemini: "Obtener clave en Google AI Studio →",
  openai: "Obtener clave en OpenAI →",
  anthropic: "Obtener clave en Anthropic Console →",
  ollama: "Instalar Ollama localmente →",
};

export const PROVIDER_MODELS: Record<AIProvider, { id: string; label: string }[]> = {
  gemini: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (gratis, recomendado)" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (requiere billing)" },
    { id: "gemini-2.5-pro",   label: "Gemini 2.5 Pro (requiere billing)" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o Mini (económico)" },
    { id: "gpt-4o", label: "GPT-4o" },
  ],
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (rápido)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  ],
  ollama: [
    { id: "llama3.2", label: "llama3.2" },
    { id: "llama3.1", label: "llama3.1" },
    { id: "mistral", label: "mistral" },
    { id: "custom", label: "Personalizado…" },
  ],
};
