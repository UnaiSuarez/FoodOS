// Proxy server-side para Open Food Facts — resuelve CORS del browser.
// GET /api/food-search?q=nocilla
// Usa la nueva API de búsqueda de OFF (search.openfoodfacts.org) que tiene Elasticsearch
// y funciona mucho mejor que el CGI antiguo (/cgi/search.pl → devolvía 503).
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
