// Búsqueda externa de macronutrientes: Open Food Facts (español) → USDA FoodData Central (inglés)
// Resultados cacheados en localStorage para no repetir llamadas.
//
// Flujo que ya existe antes de llegar aquí:
//   1. food-db.ts (local, ~120 alimentos españoles) ← se comprueba primero
//   2. ← ESTA capa (OFF + USDA + caché)
//   3. IA (último recurso, consume cuota)

const CACHE_KEY = "foodos-food-lookup-cache";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

export interface FoodLookupResult {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  source: "off-search" | "usda";
  cachedAt: number;
}

// ─── Caché localStorage ───────────────────────────────────────────────────────

function loadCache(): Record<string, FoodLookupResult> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, FoodLookupResult>) : {};
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, FoodLookupResult>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

function normalizeKey(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

// ─── Helpers internos: búsqueda vía proxy server-side ───────────────────────
// El endpoint CGI de OFF no permite CORS desde el browser.
// Usamos /api/food-search (Next.js route handler) que llama a OFF en el servidor.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchOFFProxy(query: string): Promise<any[]> {
  try {
    const res = await fetch(
      `/api/food-search?q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(9_000) }
    );
    if (!res.ok) return [];
    const data = await res.json() as { products?: unknown[] };
    return Array.isArray(data.products) ? data.products : [];
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOFFProduct(p: any): { kcal: number; protein: number; carbs: number; fat: number; salt?: number; fiber?: number; sugars?: number } {
  const n = p.nutriments ?? {};
  return {
    kcal: Math.round((n["energy-kcal_100g"] ?? n["energy-kcal"] ?? (n.energy_100g != null ? n.energy_100g / 4.184 : 0)) || 0),
    protein: Math.round((n.proteins_100g ?? n.proteins ?? 0) * 10) / 10,
    carbs:   Math.round((n.carbohydrates_100g ?? n.carbohydrates ?? 0) * 10) / 10,
    fat:     Math.round((n.fat_100g ?? n.fat ?? 0) * 10) / 10,
    ...(n.salt_100g    != null && { salt:   Math.round(n.salt_100g   * 100) / 100 }),
    ...(n.fiber_100g   != null && { fiber:  Math.round(n.fiber_100g  * 10)  / 10  }),
    ...(n.sugars_100g  != null && { sugars: Math.round(n.sugars_100g * 10)  / 10  }),
  };
}

// ─── Open Food Facts text search (para lookupFoodExternal) ───────────────────

async function searchOFF(query: string): Promise<FoodLookupResult | null> {
  const products = await fetchOFFProxy(query);
  for (const p of products) {
    const macros = parseOFFProduct(p);
    if (macros.kcal <= 0) continue;
    return { ...macros, source: "off-search", cachedAt: Date.now() };
  }
  return null;
}

// ─── USDA FoodData Central ────────────────────────────────────────────────────
// Requiere nombre en inglés. Usamos DEMO_KEY (límite: ~1000 req/hora por IP,
// solo para alimentos no cubiertos por OFF ni la BD local).

// Traducción ES → EN para los alimentos genéricos más comunes no incluidos en food-db.ts
const ES_TO_EN: Record<string, string> = {
  // Carnes menos comunes
  "conejo": "rabbit meat raw",
  "cordero": "lamb leg raw",
  "chuletillas de cordero": "lamb chops raw",
  "pato": "duck meat raw",
  "ternera asada": "beef roasted",
  "buey": "beef sirloin raw",
  "jabalí": "wild boar raw",
  // Pescados / mariscos menos comunes
  "pulpo": "octopus cooked",
  "calamar": "squid raw",
  "sepia": "cuttlefish raw",
  "salmón ahumado": "salmon smoked",
  "trucha": "trout raw",
  "boquerones": "anchovies raw",
  "rape": "monkfish raw",
  "langostinos": "shrimp raw",
  "almejas": "clams raw",
  "berberechos": "cockles",
  "navajas": "razor clams",
  // Frutas tropicales / exóticas
  "piña": "pineapple raw",
  "mango": "mango raw",
  "papaya": "papaya raw",
  "coco": "coconut raw",
  "maracuyá": "passion fruit raw",
  "guayaba": "guava raw",
  "lichi": "litchi raw",
  "pomelo": "grapefruit raw",
  "arándanos": "blueberries raw",
  "frambuesas": "raspberries raw",
  "moras": "blackberries raw",
  "cerezas": "cherries raw",
  "ciruelas": "plums raw",
  "higos": "figs raw",
  "dátiles": "dates raw",
  "pasas": "raisins",
  // Pan / repostería
  "croissant": "croissant",
  "magdalenas": "muffins corn commercial",
  "bizcocho": "sponge cake",
  "pan de pita": "pita bread",
  "pan baguette": "bread french baguette",
  "galletas maría": "butter cookies",
  "galletas digestive": "digestive biscuits",
  "galletas de avena": "oatmeal cookies",
  "crepes": "crepes",
  "tortitas": "pancakes plain",
  // Snacks / otros
  "patatas fritas (bolsa)": "potato chips salted",
  "palomitas": "popcorn air-popped",
  "cacahuetes tostados": "peanuts dry-roasted",
  "pistachos": "pistachios raw",
  "pipas de calabaza": "pumpkin seeds raw",
  // Lácteos adicionales
  "leche condensada": "milk condensed sweetened",
  "queso brie": "brie cheese",
  "queso gouda": "gouda cheese",
  "queso cheddar": "cheddar cheese",
  "queso ricotta": "ricotta cheese",
  "queso feta": "feta cheese",
  "queso cottage": "cottage cheese",
  "crema agria": "sour cream",
  "kéfir": "kefir",
  // Aceites / grasas adicionales
  "aceite de coco": "coconut oil",
  "ghee": "butter clarified ghee",
  "aceite de aguacate": "oil avocado",
  // Suplementos / proteínas
  "proteína de guisante": "pea protein powder",
  "leche de coco": "coconut milk canned",
  "leche de arroz": "rice milk",
  // Varios
  "flan": "custard dessert",
  "natillas": "pudding vanilla",
  "arroz con leche": "rice pudding",
  "helado de vainilla": "ice cream vanilla",
  "helado de chocolate": "ice cream chocolate",
};

async function searchUSDA(name: string): Promise<FoodLookupResult | null> {
  const englishQuery = ES_TO_EN[normalizeKey(name)];
  if (!englishQuery) return null;

  try {
    const url =
      `https://api.nal.usda.gov/fdc/v1/foods/search` +
      `?query=${encodeURIComponent(englishQuery)}` +
      `&api_key=DEMO_KEY&dataType=Foundation,SR%20Legacy&pageSize=3`;

    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      foods?: Array<{
        foodNutrients?: Array<{ nutrientId?: number; value?: number }>;
      }>;
    };

    const foods = data.foods ?? [];
    if (!foods.length) return null;

    const nutrients = foods[0].foodNutrients ?? [];
    const get = (id: number) => nutrients.find((n) => n.nutrientId === id)?.value ?? 0;

    const kcal = Math.round(get(1008)); // Energy kcal
    if (kcal <= 0) return null;

    return {
      kcal,
      protein: Math.round(get(1003) * 10) / 10, // Protein
      carbs: Math.round(get(1005) * 10) / 10,   // Carbs
      fat: Math.round(get(1004) * 10) / 10,     // Total lipid
      source: "usda",
      cachedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Busca macros de un alimento en fuentes externas (OFF → USDA) con caché local.
 * Llámalo después de comprobar food-db.ts y antes de usar la IA.
 */
export async function lookupFoodExternal(name: string): Promise<FoodLookupResult | null> {
  if (typeof window === "undefined") return null;

  const key = normalizeKey(name);
  const cache = loadCache();

  // 1. Caché local (30 días)
  const cached = cache[key];
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;

  // 2. Open Food Facts (español, sin clave)
  const off = await searchOFF(name);
  if (off) {
    cache[key] = off;
    saveCache(cache);
    return off;
  }

  // 3. USDA FoodData Central (inglés, DEMO_KEY)
  const usda = await searchUSDA(name);
  if (usda) {
    cache[key] = usda;
    saveCache(cache);
    return usda;
  }

  return null;
}

/** Elimina toda la caché de búsquedas externas (útil para depuración). */
export function clearFoodLookupCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}

// ─── Autocompletado en tiempo real con OFF ────────────────────────────────────

export interface ExternalFoodSuggestion {
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  salt?: number;
  fiber?: number;
  sugars?: number;
}

/**
 * Busca productos en Open Food Facts por nombre (texto libre, español).
 * Pensado para autocompletado debounced — responde en ~1-3 s.
 * No guarda en caché (los resultados varían; la caché es para lookupFoodExternal).
 */
export async function searchOFFSuggestions(
  query: string,
  limit = 5
): Promise<ExternalFoodSuggestion[]> {
  if (query.trim().length < 2) return [];

  const products = await fetchOFFProxy(query.trim());
  const seen = new Set<string>();
  const results: ExternalFoodSuggestion[] = [];

  for (const p of products) {
    const rawName = (
      p.product_name_es ?? p.product_name_es_ES ?? p.product_name ?? ""
    ).split("\n")[0].trim();
    if (!rawName || seen.has(rawName.toLowerCase())) continue;
    seen.add(rawName.toLowerCase());

    const macros = parseOFFProduct(p);
    results.push({ name: rawName.slice(0, 70), ...macros });

    if (results.length >= limit) break;
  }
  return results;
}
