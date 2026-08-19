// Proxy server-side para descargar una página de receta — resuelve CORS del
// browser y evita exponer la clave de IA a la página de destino. Devuelve
// texto plano (sin etiquetas) y, si existe, el bloque JSON-LD de schema.org
// Recipe — la señal más limpia posible, porque casi todo blog de recetas lo
// incluye para las rich snippets de Google.
// GET /api/recipe-fetch?url=https://ejemplo.com/receta
import { NextRequest, NextResponse } from "next/server";

const MAX_HTML_BYTES = 1_500_000; // defensivo: páginas enormes no aportan más señal
const MAX_TEXT_CHARS = 8_000;
const MAX_JSONLD_CHARS = 6_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRecipeJsonLd(html: string): string {
  const blocks = [
    ...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ]
    .map((m) => m[1].trim())
    .filter((block) => /"@type"\s*:\s*"Recipe"/i.test(block) || /"@type"\s*:\s*\[[^\]]*"Recipe"/i.test(block));
  return blocks.join("\n").slice(0, MAX_JSONLD_CHARS);
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : undefined;
}

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get("url")?.trim() ?? "";
  if (!rawUrl) return NextResponse.json({ error: "Falta el parámetro url" }, { status: 400 });

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "URL no válida" }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "Solo se admiten URLs http/https" }, { status: 400 });
  }

  try {
    const res = await fetch(target.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FoodOS/1.0; +https://github.com/UnaiSuarez/FoodOS)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: `La página respondió con un error (${res.status})` }, { status: 502 });
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("xml")) {
      return NextResponse.json({ error: "Esa URL no apunta a una página web (¿es un PDF o una imagen?)" }, { status: 415 });
    }

    const fullHtml = await res.text();
    const html = fullHtml.length > MAX_HTML_BYTES ? fullHtml.slice(0, MAX_HTML_BYTES) : fullHtml;

    const jsonLd = extractRecipeJsonLd(html);
    const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
    const title = extractTitle(html);

    if (!text && !jsonLd) {
      return NextResponse.json({ error: "No se pudo extraer texto de esa página" }, { status: 422 });
    }

    return NextResponse.json({ text, jsonLd: jsonLd || null, title: title ?? null });
  } catch {
    return NextResponse.json(
      { error: "No se pudo descargar la página (tardó demasiado o bloqueó la petición)" },
      { status: 502 }
    );
  }
}
