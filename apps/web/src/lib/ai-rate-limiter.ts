// Ventana deslizante: máximo 15 llamadas por minuto (free tier Gemini = 20/min).
// Persistida en localStorage: cada usuario aporta su propia clave de IA (no hay
// clave compartida entre usuarios — ver ai-config.ts), así que este límite solo
// protege al propio usuario de un 429 de su proveedor, no un cupo de negocio
// compartido. Sin persistencia, recargar la pestaña a mitad de una ráfaga
// resetea el contador y deja pasar de golpe otras 15 peticiones.
const MAX_REQUESTS = 15;
const WINDOW_MS = 60_000;
const STORAGE_KEY = "foodos-ai-rate-limiter";

function loadTimestamps(): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "number") : [];
  } catch {
    return [];
  }
}

function saveTimestamps(timestamps: number[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(timestamps));
  } catch {
    // localStorage lleno o no disponible: el límite sigue funcionando en memoria para esta sesión.
  }
}

let timestamps: number[] = loadTimestamps();

function pruneOld() {
  const cutoff = Date.now() - WINDOW_MS;
  const before = timestamps.length;
  timestamps = timestamps.filter((t) => t >= cutoff);
  if (timestamps.length !== before) saveTimestamps(timestamps);
}

export function canMakeRequest(): boolean {
  pruneOld();
  return timestamps.length < MAX_REQUESTS;
}

export function recordRequest() {
  timestamps.push(Date.now());
  saveTimestamps(timestamps);
}

/** Milisegundos hasta que haya cupo de nuevo (0 si hay cupo ahora) */
export function getWaitMs(): number {
  pruneOld();
  if (timestamps.length < MAX_REQUESTS) return 0;
  return Math.max(0, timestamps[0] + WINDOW_MS - Date.now());
}

export function getRemainingRequests(): number {
  pruneOld();
  return Math.max(0, MAX_REQUESTS - timestamps.length);
}

/** Llamar al principio de toda función que dispare una petición a un proveedor
    de IA (Gemini/OpenAI/Anthropic/Ollama) — única fuente de verdad, para que
    ningún call site nuevo se quede fuera del límite sin darse cuenta. */
export function checkRateLimit(): void {
  if (!canMakeRequest()) {
    const wait = Math.ceil(getWaitMs() / 1000);
    throw new Error(`Límite de solicitudes alcanzado (${MAX_REQUESTS}/min). Espera ${wait}s antes de intentarlo de nuevo.`);
  }
  recordRequest();
}
