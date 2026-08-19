import type { Recipe, RecipeIngredient, StorageName } from "@foodos/types";
import { uid } from "./utils";

/**
 * E15-04: acciones de la IA sobre inventario y recetas — antes se aplicaban
 * al estado con solo un `Number(x ?? 0)`/`String(x ?? "")` suelto, sin
 * validar rangos ni rechazar nada (ver AssistantView.tsx antes de este
 * cambio). Un JSON mal formado, un campo alucinado (`qty: -50000`,
 * `storage: "Frigorífico"`, `kcal: 9999999`) se guardaba en el estado del
 * usuario tal cual. Este módulo centraliza la validación con límites
 * explícitos y devuelve un resultado tipado en vez de asumir que todo es
 * correcto — igual criterio que evaluateNutritionSafety() en nutrition.ts:
 * nunca confiar en un dato que viene de fuera (IA, red) sin comprobarlo.
 */

export type ActionValidation<T> = { ok: true; value: T } | { ok: false; reason: string };

const VALID_STORAGE: StorageName[] = ["Nevera", "Congelador", "Despensa"];

const MAX_NAME_LEN = 80;
const MAX_QTY = 100_000;
const MAX_UNIT_LEN = 10;
const MAX_EXPIRES_DAYS = 3650; // 10 años — evita "caduca en 500000 días"
const MIN_EXPIRES_DAYS = -1; // permite "ya caducado" pero no fechas absurdamente pasadas
const MAX_PRICE = 10_000;
const MAX_KCAL_ITEM = 10_000;
const MAX_PROTEIN_ITEM = 1_000;

/** Number(x) puede devolver NaN o Infinity sin lanzar — hay que comprobarlo
    explícitamente, `Number("hola")` es NaN pero no un error de JS. */
function finiteNumberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export interface ValidatedInventoryAction {
  name: string;
  qty: number;
  unit: string;
  storage: StorageName;
  expiresDays: number;
  price: number;
  kcal: number;
  protein: number;
}

/** Valida el bloque [INV]{...}[/INV] que puede devolver la IA antes de
    convertirlo en un item de inventario real. Rechaza (ok:false) en vez de
    inventar un valor cuando el dato es claramente inválido — cantidad,
    nombre — pero recorta (clamp) en vez de rechazar los campos donde un
    valor "raro pero acotado" es más útil que perder toda la acción. */
export function validateInventoryAction(raw: Record<string, unknown>): ActionValidation<ValidatedInventoryAction> {
  const name = String(raw.name ?? "").trim().slice(0, MAX_NAME_LEN);
  if (!name) return { ok: false, reason: "La IA no indicó un nombre de alimento." };

  const qty = finiteNumberOr(raw.qty, NaN);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: `Cantidad inválida: ${JSON.stringify(raw.qty)}.` };
  }

  const unit = String(raw.unit ?? "g").trim().slice(0, MAX_UNIT_LEN) || "g";

  const storageRaw = String(raw.storage ?? "Despensa");
  const storage = (VALID_STORAGE as string[]).includes(storageRaw) ? (storageRaw as StorageName) : "Despensa";

  return {
    ok: true,
    value: {
      name,
      qty: clamp(qty, 0.01, MAX_QTY),
      unit,
      storage,
      expiresDays: clamp(finiteNumberOr(raw.expires_days, 7), MIN_EXPIRES_DAYS, MAX_EXPIRES_DAYS),
      price: clamp(finiteNumberOr(raw.price, 0), 0, MAX_PRICE),
      kcal: clamp(finiteNumberOr(raw.kcal, 0), 0, MAX_KCAL_ITEM),
      protein: clamp(finiteNumberOr(raw.protein, 0), 0, MAX_PROTEIN_ITEM),
    },
  };
}

const MAX_TITLE_LEN = 120;
const MAX_INGREDIENTS = 40;
const MAX_STEPS = 30;
const MAX_KCAL_SERVING = 5_000;
const MAX_MACRO_SERVING = 500; // g de proteína/carbos/grasa por ración
const MAX_COST_SERVING = 200;
const MAX_TIME_MIN = 600;
const MAX_SERVINGS = 50;

function validateIngredient(raw: unknown): RecipeIngredient | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = String(r.name ?? "").trim().slice(0, MAX_NAME_LEN);
  if (!name) return null;
  const quantity = clamp(finiteNumberOr(r.quantity, 0), 0, MAX_QTY);
  const unit = String(r.unit ?? "g").trim().slice(0, MAX_UNIT_LEN) || "g";
  return {
    name,
    quantity,
    unit,
    ...(r.kcalPer100 != null ? { kcalPer100: clamp(finiteNumberOr(r.kcalPer100, 0), 0, MAX_KCAL_ITEM) } : {}),
    ...(r.proteinPer100 != null ? { proteinPer100: clamp(finiteNumberOr(r.proteinPer100, 0), 0, MAX_PROTEIN_ITEM) } : {}),
    ...(r.carbsPer100 != null ? { carbsPer100: clamp(finiteNumberOr(r.carbsPer100, 0), 0, MAX_PROTEIN_ITEM) } : {}),
    ...(r.fatPer100 != null ? { fatPer100: clamp(finiteNumberOr(r.fatPer100, 0), 0, MAX_PROTEIN_ITEM) } : {}),
  };
}

/** Valida el bloque [RECIPE]{...}[/RECIPE]. Rechaza si no hay título ni
    ingredientes reconocibles — una "receta" sin ninguno de los dos no es
    una acción válida, es ruido. El resto de campos numéricos se recortan a
    rangos plausibles en vez de rechazar la receta entera por un solo campo
    fuera de rango. */
export function validateRecipeAction(raw: Record<string, unknown>): ActionValidation<Recipe> {
  const title = String(raw.title ?? "").trim().slice(0, MAX_TITLE_LEN);
  if (!title) return { ok: false, reason: "La IA no indicó un título de receta." };

  const rawIngredients = Array.isArray(raw.ingredients) ? raw.ingredients.slice(0, MAX_INGREDIENTS) : [];
  const ingredients = rawIngredients
    .map(validateIngredient)
    .filter((i): i is RecipeIngredient => i !== null);
  if (ingredients.length === 0) {
    return { ok: false, reason: "La IA no indicó ningún ingrediente reconocible." };
  }

  const steps = Array.isArray(raw.steps)
    ? raw.steps.slice(0, MAX_STEPS).map((s) => String(s).trim().slice(0, 500)).filter(Boolean)
    : [];
  const tags = Array.isArray(raw.tags)
    ? raw.tags.slice(0, 15).map((t) => String(t).trim().slice(0, 30)).filter(Boolean)
    : [];

  return {
    ok: true,
    value: {
      id: uid(),
      title,
      ingredients,
      kcal: clamp(finiteNumberOr(raw.kcal, 0), 0, MAX_KCAL_SERVING),
      protein: clamp(finiteNumberOr(raw.protein, 0), 0, MAX_MACRO_SERVING),
      carbs: clamp(finiteNumberOr(raw.carbs, 0), 0, MAX_MACRO_SERVING),
      fat: clamp(finiteNumberOr(raw.fat, 0), 0, MAX_MACRO_SERVING),
      cost: clamp(finiteNumberOr(raw.cost, 0), 0, MAX_COST_SERVING),
      time: clamp(finiteNumberOr(raw.time, 20), 1, MAX_TIME_MIN),
      servings: clamp(finiteNumberOr(raw.servings, 1), 1, MAX_SERVINGS),
      difficulty: String(raw.difficulty ?? "media").trim().slice(0, 20) || "media",
      tags,
      steps,
      image: "",
      aiGenerated: true,
    },
  };
}
