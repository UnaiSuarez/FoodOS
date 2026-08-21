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
//
// DNS rebinding (revisión externa, 2026-08-21): validar con dns.lookup() y
// luego llamar a fetch(url) NO es suficiente — fetch() vuelve a resolver el
// hostname por su cuenta al conectar, y esa segunda resolución puede
// devolver una IP distinta (TTL bajo, DNS del atacante). La conexión real
// tiene que fijarse a la IP que se validó, no repetir la resolución — ver
// lib/safe-fetch.ts.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createRateLimiter } from "@/lib/ssrf-guard";
import { safeFetch, readNodeStreamLimited, type SafeFetchResult } from "@/lib/safe-fetch";

const MAX_HTML_BYTES = 1_500_000; // defensivo: páginas enormes no aportan más señal
const MAX_TEXT_CHARS = 8_000;
const MAX_JSONLD_CHARS = 6_000;
const MAX_REDIRECTS = 5;
// Presupuesto TOTAL para toda la petición — DNS + conexión + cada
// redirección + lectura del cuerpo, no un timeout por salto ni de inactividad
// de socket (ver el comentario grande sobre deadline en lib/safe-fetch.ts:
// un timeout de inactividad nunca corta un servidor que gotea datos sin
// parar). Un único AbortController con este deadline se crea en GET() y se
// pasa a todo el flujo.
const TOTAL_FETCH_TIMEOUT_MS = 10_000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const isRateLimited = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS);

// ─── Autenticación ──────────────────────────────────────────────────────
// Si Supabase está configurado, exige una sesión válida (Authorization:
// Bearer <access_token>). Si NO está configurado, la app entera funciona en
// modo local-only sin autenticación (ver hasSupabaseConfig() en
// lib/supabase.ts).
//
// Fail-closed (revisión externa, 2026-08-21): el modo local-only anónimo NO
// se infiere solo de que falten NEXT_PUBLIC_SUPABASE_URL/ANON_KEY. Antes sí
// se hacía así, lo que significa que un despliegue a producción con esas
// variables olvidadas (typo, paso de CI saltado, etc.) dejaba esta ruta
// abierta a cualquiera sin que nadie lo decidiera a propósito — justo lo
// contrario de fail-closed. Ahora hace falta una señal EXPLÍCITA
// (FOODOS_ALLOW_LOCAL_ONLY_API=true) y además NODE_ENV distinto de
// "production"; sin las dos, la ausencia de configuración de Supabase
// deniega la petición en vez de abrirla.
function isExplicitLocalOnlyMode(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.FOODOS_ALLOW_LOCAL_ONLY_API === "true";
}

async function isAuthorized(request: NextRequest): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseConfigured = !!url && !!anonKey && !url.includes("TU-PROYECTO");
  if (!supabaseConfigured) return isExplicitLocalOnlyMode();

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

/** Sigue redirecciones A MANO (nunca redirect:"follow") para poder validar
    que cada salto sigue apuntando a una IP pública — una URL pública puede
    redirigir a localhost/metadata igual de bien que apuntar ahí directamente.
    Cada salto usa safeFetch(), que resuelve y fija la conexión a esa única
    IP validada (ver lib/safe-fetch.ts). `signal` es EL MISMO para toda la
    cadena (lo crea GET() una sola vez, con un único deadline absoluto) — así
    el presupuesto de tiempo es total para toda la petición, no por salto. */
async function fetchPublicUrl(startUrl: URL, signal: AbortSignal): Promise<SafeFetchResult> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await safeFetch(current, signal);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.bodyStream.resume?.(); // descarta el cuerpo de la redirección, no lo necesitamos
      current = new URL(String(res.headers.location), current);
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new Error("PROTOCOL_NOT_ALLOWED");
      }
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

  // Un único deadline absoluto para TODA la petición — DNS, conexión, cada
  // redirección y la lectura del cuerpo comparten este mismo signal (ver
  // safe-fetch.ts). El timer se limpia en el finally de más abajo, DESPUÉS
  // de leer el cuerpo, no nada más terminar fetchPublicUrl — si se limpiara
  // antes, el deadline dejaría de proteger la fase de lectura del cuerpo,
  // que es justo donde un servidor "slow-drip" intentaría explotar un
  // timeout basado en inactividad.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchPublicUrl(target, controller.signal);

    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.bodyStream.resume?.();
      return NextResponse.json({ error: `La página respondió con un error (${res.statusCode})` }, { status: 502 });
    }

    const contentType = String(res.headers["content-type"] ?? "");
    if (!contentType.includes("text/html") && !contentType.includes("xml")) {
      res.bodyStream.resume?.();
      return NextResponse.json({ error: "Esa URL no apunta a una página web (¿es un PDF o una imagen?)" }, { status: 415 });
    }

    const html = await readNodeStreamLimited(res.bodyStream, MAX_HTML_BYTES, controller.signal);

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
  } finally {
    clearTimeout(timer);
  }
}
