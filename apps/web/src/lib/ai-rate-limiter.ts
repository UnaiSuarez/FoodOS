// Ventana deslizante: máximo 15 llamadas por minuto (free tier Gemini = 20/min)
const MAX_REQUESTS = 15;
const WINDOW_MS = 60_000;
const timestamps: number[] = [];

function pruneOld() {
  const cutoff = Date.now() - WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
}

export function canMakeRequest(): boolean {
  pruneOld();
  return timestamps.length < MAX_REQUESTS;
}

export function recordRequest() {
  timestamps.push(Date.now());
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
