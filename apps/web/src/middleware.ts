import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * E15-03 / E20-03: Content-Security-Policy — FoodOS no tenía ninguna hasta
 * ahora. Sigue el patrón oficial de Next.js (nonce por petición + 'strict-
 * dynamic' en script-src) en vez de una lista de dominios para scripts, que
 * es mucho más frágil.
 *
 * connect-src/img-src se construyen a partir de los dominios externos
 * reales que usa la app hoy (grep de `fetch(` en apps/web/src): Supabase
 * (API + Realtime), los tres proveedores de IA en la nube, Open Food Facts
 * (escaneo de código de barras) y USDA (fallback nutricional). El proxy de
 * búsqueda de OFF (/api/food-search) y el resto de rutas /api/* ya son
 * same-origin, no necesitan entrada aparte.
 *
 * OJO — Ollama (IA local/autoalojada) usa una URL que el propio usuario
 * configura libremente (localhost, red local, un túnel...); no se puede
 * fijar de antemano en connect-src. Quien use Ollama con esta CSP en modo
 * enforcing puede necesitar añadir su URL a mano, o desactivar la CSP.
 *
 * DESPLIEGUE EN DOS FASES, A PROPÓSITO: se envía primero como
 * Content-Security-Policy-Report-Only (no bloquea nada, solo lo reporta en
 * la consola del navegador) porque los flujos que más pueden romperse
 * (login con Google, sincronización Realtime, llamadas reales a la IA) no
 * se pueden probar de extremo a extremo sin la sesión real del usuario.
 * Tras confirmar un uso normal sin violaciones en la consola, cambiar el
 * nombre de la cabecera a "Content-Security-Policy" para aplicarla de verdad.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV !== "production";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseWs = supabaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");

  const connectSrc = [
    "'self'",
    supabaseUrl,
    supabaseWs,
    "https://generativelanguage.googleapis.com",
    "https://api.openai.com",
    "https://api.anthropic.com",
    "https://world.openfoodfacts.org",
    "https://api.nal.usda.gov",
    isDev ? "ws://localhost:*" : "", // HMR de Next.js en desarrollo
  ].filter(Boolean).join(" ");

  const cspDirectives = [
    `default-src 'self'`,
    // 'strict-dynamic' permite que los scripts con nonce carguen a su vez
    // otros scripts (los chunks de Next.js) sin tener que listarlos todos.
    // 'unsafe-eval' solo en dev: Next.js lo necesita para el HMR/Fast Refresh.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Sin nonces para estilos: la app usa muchos `style={{...}}` inline en
    // React (atributos style, no <style> nonced) — bloquearlos habría roto
    // gran parte de la interfaz para un beneficio de seguridad menor que
    // bloquear scripts, que es lo que de verdad importa en una CSP.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc}`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    !isDev ? `upgrade-insecure-requests` : "",
  ].filter(Boolean).join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-csp", cspDirectives);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Fase 1 del rollout: Report-Only. Ver nota arriba antes de pasar a
  // "Content-Security-Policy" (quitar "-Report-Only").
  response.headers.set("Content-Security-Policy-Report-Only", cspDirectives);
  return response;
}

export const config = {
  matcher: [
    // Todas las rutas salvo assets estáticos y la API de imágenes de Next.
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.json).*)",
  ],
};
