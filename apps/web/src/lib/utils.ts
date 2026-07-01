import type { MealType } from "@foodos/types";

/** Redimensiona una imagen subida (cámara/galería) a un data URL JPEG comprimido,
    para no disparar el tamaño de localStorage/la fila de Supabase. */
export function resizeImageFile(file: File, maxDim = 480, quality = 0.75): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el archivo"));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error("No se pudo procesar la imagen"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Canvas no soportado")); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/** Infiere el tipo de comida a partir de la hora HH:mm (PDF §9.5). */
export function mealTypeFromTime(time: string): MealType {
  const hour = parseInt(time.slice(0, 2), 10);
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 19 || hour < 5) return "dinner";
  return "snack"; // 16-19 = merienda/snack
}

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

/** Suma/resta días a una fecha base arbitraria (YYYY-MM-DD), a diferencia de
    todayPlus que siempre parte de la fecha real del sistema. Útil para que los
    cálculos de ventana respeten debugDate en vez de "hoy" real. */
export function dateOffset(base: string, days: number): string {
  const date = new Date(base + "T12:00:00");
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
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
