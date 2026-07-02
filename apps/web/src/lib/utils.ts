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

export function dateKeyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromKey(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00`);
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const date = dateFromKey(dateKey);
  date.setDate(date.getDate() + days);
  return dateKeyFromDate(date);
}

export function todayPlus(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateKeyFromDate(date);
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
  const end = dateFromKey(dateString);
  end.setHours(0, 0, 0, 0);
  return Math.ceil((end.getTime() - start.getTime()) / 86400000);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function ensureUuid(value: string): string {
  return isUuid(value) ? value : crypto.randomUUID();
}

/** Compara un nombre de producto/ingrediente con un nombre de item de inventario
    de forma tolerante: coinciden si son iguales, o si la primera palabra de uno
    aparece contenida en el otro (ej. "pollo" ↔ "pechuga de pollo"). No distingue
    mayúsculas/minúsculas. Usado para casar ingredientes de receta con lotes de
    inventario cuando no hay un ID exacto que los relacione — ver nota en
    RoutineExercise/InventoryItem sobre por qué este matching es intencionalmente
    laxo (nombres libres, sin catálogo cerrado de productos). */
export function namesMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb.split(" ")[0]) || nb.includes(na.split(" ")[0]);
}

/** Convierte una cantidad a gramos/ml según la unidad, usando unitSize (o 60
    por defecto) para unidades sueltas ("ud"). Única fuente de verdad para esta
    conversión — antes había 5+ copias ligeramente distintas entre sí (algunas
    sin soporte para oz/lb/cucharada/pizca, causando cálculos silenciosamente
    incorrectos para esas unidades). */
export function toGrams(qty: number, unit: string, unitSize = 60): number {
  switch (unit) {
    case "kg": return qty * 1000;
    case "L":  return qty * 1000;
    case "oz": return qty * 28.35;
    case "lb": return qty * 453.6;
    case "cucharada": return qty * 15;
    case "pizca":     return qty * 0.5;
    case "ud": return qty * unitSize;
    default:   return qty; // g, ml
  }
}
