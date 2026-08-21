// Proxy server-side para Open Food Facts — resuelve CORS del browser.
// GET /api/food-search?q=nocilla
// Usa la nueva API de búsqueda de OFF (search.openfoodfacts.org) que tiene Elasticsearch
// y funciona mucho mejor que el CGI antiguo (/cgi/search.pl → devolvía 503).
//
// Caché de fetch() en Next 15 (migración de Next 14, revisión externa,
// 2026-08-22): en Next 14 el valor por defecto de fetch() era "force-cache"
// — Next podía servir la respuesta de OFF de una búsqueda desde su Data
// Cache en vez de pedirla de nuevo, así que dos usuarios (o el mismo, más
// tarde) buscando el mismo término podían recibir un resultado
// desactualizado sin que nadie lo pidiera. En Next 15 el valor por defecto
// pasa a ser "no-store", que es justo el comportamiento que esta ruta
// necesita: una búsqueda de alimentos debe reflejar el catálogo real de OFF
// en cada petición, nunca servir de caché. Se fija `cache: "no-store"`
// explícitamente para conservar ese comportamiento aunque el valor por
// defecto de Next vuelva a cambiar en el futuro — no depender de un
// default implícito que ya nos ha cambiado una vez por debajo. (El otro
// handler GET del proyecto, /api/recipe-fetch, no usa fetch() de Next en
// absoluto — usa conexión TCP de bajo nivel pinneada a una IP validada, ver
// lib/safe-fetch.ts — así que este cambio de Next no le afecta.)
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ products: [] });

  try {
    // Nueva API de búsqueda OFF (Elasticsearch) — reemplaza el CGI que devuelve 503
    const url =
      `https://search.openfoodfacts.org/search` +
      `?q=${encodeURIComponent(q)}` +
      `&page_size=20` +
      `&fields=product_name,product_name_es,product_name_es_ES,nutriments,quantity,brands,image_small_url,allergens_tags`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "FoodOS/1.0 (unai64535@gmail.com)",
        "Accept": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return NextResponse.json({ products: [] });

    const data = await res.json() as { hits?: unknown[] };

    // La nueva API devuelve "hits" en vez de "products" — normalizamos aquí
    const products = Array.isArray(data.hits) ? data.hits : [];
    return NextResponse.json({ products });
  } catch {
    return NextResponse.json({ products: [] });
  }
}
