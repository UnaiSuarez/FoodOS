import type { MealType } from "@foodos/types";

const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB

/** Redimensiona una imagen subida (cámara/galería) a un data URL JPEG comprimido,
    para no disparar el tamaño de localStorage/la fila de Supabase. Rechaza antes
    de leer el archivo si es enorme (ej. RAW, TIFF, foto de decenas de MB): sin
    este límite, un input type="file" acepta cualquier tamaño y FileReader lo
    cargaría entero en memoria antes de comprimirlo. */
export function resizeImageFile(file: File, maxDim = 480, quality = 0.75): Promise<string> {
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    return Promise.reject(new Error(`La imagen pesa demasiado (máx. ${MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024}MB)`));
  }
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

/** Convierte un File a base64 crudo (para las llamadas de visión de IA:
    escaneo de ticket, identificación de alimento por foto). Antes esta
    conversión estaba duplicada en dos sitios de InventoryView, ninguno con
    límite de tamaño — igual que resizeImageFile, un archivo enorme se
    cargaría entero en memoria antes de fallar en la propia llamada a la IA. */
export async function fileToBase64(file: File, maxBytes = MAX_IMAGE_UPLOAD_BYTES): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(`El archivo pesa demasiado (máx. ${maxBytes / 1024 / 1024}MB)`);
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
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

/** PRNG determinista (mulberry32) para datos de ejemplo que necesitan verse
 * "naturales" (algo de ruido) pero no pueden depender de Math.random() —
 * ver el comentario en seedDemo (E21-20): los tests e2e cargan datos demo y
 * comprueban valores concretos, y un peso demo distinto en cada carga (antes,
 * el ruido del historial de peso usaba Math.random()) los haría inestables
 * sin previo aviso. La misma seed produce siempre la misma secuencia. */
export function seededJitter(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

// E08-01: antes `${n.toFixed(2)} €` — con miles usaba punto y coma como en
// inglés ("1234.50 €") en vez de la convención española ("1.234,50 €").
// Intl.NumberFormat lo resuelve de forma correcta y consistente en toda la
// app (Finanzas, Inventario, Recetas, Carrito...), ya que eur() es el único
// punto de formateo de dinero.
const EUR_FORMAT = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });

export function eur(value: number | undefined | null): string {
  return EUR_FORMAT.format(Number(value ?? 0));
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

/** FNV-1a de 32 bits — hash rápido y determinista, no criptográfico (no hace
    falta: solo migra ids legacy de forma estable, no protege nada sensible
    a colisiones maliciosas). `seed` distinto en cada llamada de
    deterministicUuidFrom() para cubrir los 128 bits de una UUID a partir de
    un único hash de 32 bits. */
function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deriva una UUID v5-like DETERMINISTA a partir de un string arbitrario: el
    mismo `value` de entrada produce SIEMPRE la misma UUID de salida, sin
    importar cuándo ni en qué sesión se calcule.
    Por qué hace falta (B2, revisión externa, 2026-08-22): antes,
    ensureUuid() llamaba a crypto.randomUUID() para cualquier id legacy no-
    UUID — una función distinta cada vez. syncTable() mutaba item.id en el
    propio estado para que un REINTENTO EN LA MISMA SESIÓN (mismo objeto JS)
    reutilizara la id ya generada, pero esa mutación se pierde en cualquier
    punto donde el estado se reconstruya desde cero con la id legacy
    original — recargar la página entre el guardado local (que ocurre ANTES
    del push debounced) y que el push llegue a completarse, o simplemente
    abrir la app en otro dispositivo antes de que ese primer push tenga
    éxito. Cada vez que eso pasa, el mismo item legacy genera una fila
    NUEVA en vez de actualizar la que ya existía — duplicados que además
    pueden no limpiarse solos si el borrado de la fila huérfana también
    falla. Una derivación determinista por el VALOR del id legacy (no por
    sesión) hace que esto sea imposible estructuralmente: no depende de que
    ninguna mutación sobreviva a nada. */
function deterministicUuidFrom(value: string): string {
  const words = [0, 1, 2, 3].map((i) => fnv1a(`${i}:${value}`, 0x811c9dc5));
  const bytes = new Uint8Array(16);
  words.forEach((w, i) => {
    bytes[i * 4] = (w >>> 24) & 0xff;
    bytes[i * 4 + 1] = (w >>> 16) & 0xff;
    bytes[i * 4 + 2] = (w >>> 8) & 0xff;
    bytes[i * 4 + 3] = w & 0xff;
  });
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // versión 5 (derivada por nombre, no aleatoria)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function ensureUuid(value: string): string {
  return isUuid(value) ? value : deterministicUuidFrom(value);
}

const NAME_MATCH_STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "con", "sin", "y", "al"]);

/** Palabras con peso de un nombre de producto: en minúsculas, sin las
    partículas que no aportan (de/del/la...), que si no contarían como
    "coincidencia" entre dos productos que solo comparten un "de". */
function significantWords(name: string): string[] {
  return name.split(/\s+/).filter((w) => w.length > 0 && !NAME_MATCH_STOPWORDS.has(w));
}

/** ¿Tienen w1 y w2 relación suficiente como para considerarse la misma
    palabra? Iguales, o una contiene a la otra (para tolerar plural/género:
    "tomates" ↔ "tomate") — solo si ambas tienen 4+ letras, para no dejar
    que palabras cortas den falsos positivos por casualidad. */
function wordsCloseEnough(w1: string, w2: string): boolean {
  if (w1 === w2) return true;
  return w1.length >= 4 && w2.length >= 4 && (w1.includes(w2) || w2.includes(w1));
}

/** Compara un nombre de producto/ingrediente con un nombre de item de
    inventario de forma tolerante: coinciden si son iguales, o si TODAS las
    palabras con peso del nombre más corto tienen correspondencia en el más
    largo (ej. "pollo" ↔ "pechuga de pollo", "tomate" ↔ "tomate cherry").
    No distingue mayúsculas/minúsculas. Usado para casar ingredientes de
    receta con lotes de inventario cuando no hay un ID exacto que los
    relacione — ver nota en RoutineExercise/InventoryItem sobre por qué este
    matching es intencionalmente laxo (nombres libres, sin catálogo cerrado
    de productos).
    E08-07: antes solo comparaba la PRIMERA palabra de uno contra el otro
    completo — "leche entera" incluye "leche" (primera palabra de "leche de
    coco"), así que casaban aunque sean productos distintos. Ahora hace
    falta que TODAS las palabras con peso del lado corto encajen, no solo
    la primera: "leche entera" vs "leche de coco" comparten "leche" pero no
    "entera"/"coco", así que ya no coinciden. */
export function namesMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = significantWords(na);
  const wb = significantWords(nb);
  if (wa.length === 0 || wb.length === 0) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.some((lw) => wordsCloseEnough(w, lw)));
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
