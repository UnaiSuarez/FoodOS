// Proxy server-side para descargar una página de receta — resuelve CORS del
// browser y evita exponer la clave de IA a la página de destino. Devuelve
// texto plano (sin etiquetas) y, si existe, el bloque JSON-LD de schema.org
// Recipe — la señal más limpia posible, porque casi todo blog de recetas lo
// incluye para las rich snippets de Google.
// GET /api/recipe-fetch?url=https://ejemplo.com/receta
//
// SSRF (auditoría externa, 2026-08-21): esta ruta descarga desde el SERVIDOR
// cualquier URL http/https que le pidan — sin las comprobaciones de abajo,
// es un proxy hacia loopback/redes privadas/link-local (incluido el
// endpoint de metadata de nube, 169.254.169.254) y hacia lo mismo tras una
// redirección. Se resuelve DNS y se valida la IP resultante ANTES de cada
// conexión, incluidas las redirecciones (que se siguen a mano, nunca con
// redirect:"follow", precisamente para poder revalidar cada salto).
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { assertPublicUrl, createRateLimiter } from "@/lib/ssrf-guard";

const MAX_HTML_BYTES = 1_500_000; // defensivo: páginas enormes no aportan más señal
const MAX_TEXT_CHARS = 8_000;
const MAX_JSONLD_CHARS = 6_000;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const isRateLimited = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS);

// ─── Autenticación ──────────────────────────────────────────────────────
// Si Supabase está configurado, exige una sesión válida (Authorization:
// Bearer <access_token>). Si NO está configurado, la app entera funciona en
// modo local-only sin autenticación (ver hasSupabaseConfig() en
// lib/supabase.ts) — mismo modelo de seguridad para esta ruta en ese modo,
// pensado para uso personal/privado, no un debilitamiento nuevo.
async function isAuthorized(request: NextRequest): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || url.includes("TU-PROYECTO")) return true;

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;

  try {
    const client = createClient(url, anonKey);
    const { data, error } = await client.auth.getUser(token);
    return !error && !!data.user;
  } catch {
    return false;
  }
}

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

/** Descarga con límite de bytes real durante el streaming — antes se hacía
    res.text() (cuerpo COMPLETO en memoria) y se truncaba después, así que
    MAX_HTML_BYTES no protegía nada frente a una respuesta enorme. */
async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      out += decoder.decode(value.subarray(0, Math.max(0, maxBytes - (received - value.byteLength))));
      await reader.cancel().catch(() => {});
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** Sigue redirecciones A MANO (nunca redirect:"follow") para poder validar
    que cada salto sigue apuntando a una IP pública — una URL pública puede
    redirigir a localhost/metadata igual de bien que apuntar ahí directamente. */
async function fetchPublicUrl(startUrl: URL): Promise<Response> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FoodOS/1.0; +https://github.com/UnaiSuarez/FoodOS)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current);
      continue;
    }
    return res;
  }
  throw new Error("TOO_MANY_REDIRECTS");
}

export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const rateLimitKey =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (isRateLimited(rateLimitKey)) {
    return NextResponse.json({ error: "Demasiadas peticiones — espera un momento" }, { status: 429 });
  }

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
    const res = await fetchPublicUrl(target);

    if (!res.ok) {
      return NextResponse.json({ error: `La página respondió con un error (${res.status})` }, { status: 502 });
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("xml")) {
      return NextResponse.json({ error: "Esa URL no apunta a una página web (¿es un PDF o una imagen?)" }, { status: 415 });
    }

    const html = await readBodyLimited(res, MAX_HTML_BYTES);

    const jsonLd = extractRecipeJsonLd(html);
    const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
    const title = extractTitle(html);

    if (!text && !jsonLd) {
      return NextResponse.json({ error: "No se pudo extraer texto de esa página" }, { status: 422 });
    }

    return NextResponse.json({ text, jsonLd: jsonLd || null, title: title ?? null });
  } catch (err) {
    if (err instanceof Error && err.message === "PRIVATE_TARGET") {
      return NextResponse.json({ error: "Esa URL no es accesible (apunta a una red no permitida)" }, { status: 400 });
    }
    if (err instanceof Error && err.message === "TOO_MANY_REDIRECTS") {
      return NextResponse.json({ error: "Demasiadas redirecciones" }, { status: 400 });
    }
    return NextResponse.json(
      { error: "No se pudo descargar la página (tardó demasiado o bloqueó la petición)" },
      { status: 502 }
    );
  }
}
