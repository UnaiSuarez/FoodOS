export function uid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

export function todayPlus(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export function todayMinus(days: number): string {
  return todayPlus(-days);
}

export function eur(value: number | undefined | null): string {
  return `${Number(value ?? 0).toFixed(2)} €`;
}

export function clampPct(value: number, max: number): number {
  if (!max) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

export function daysUntil(dateString: string): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(dateString);
  end.setHours(0, 0, 0, 0);
  return Math.ceil((end.getTime() - start.getTime()) / 86400000);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function ensureUuid(value: string): string {
  return isUuid(value) ? value : crypto.randomUUID();
}
