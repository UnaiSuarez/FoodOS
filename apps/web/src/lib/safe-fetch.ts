// Descarga HTTP/S "pinneada" a una IP ya validada — la mitad de red del
// bloqueo de SSRF de /api/recipe-fetch (la otra mitad, isPrivateOrReservedIp,
// vive en ssrf-guard.ts).
//
// Por qué existe este módulo por separado, en vez de usar fetch() con
// assertPublicUrl() antes: fetch() resuelve DNS por su cuenta al conectar.
// Si assertPublicUrl() resuelve y valida, y LUEGO fetch() resuelve otra vez
// para conectar, hay una ventana entre las dos resoluciones — un atacante
// que controla el DNS del dominio objetivo (dominio propio, TTL bajísimo)
// puede responder una IP pública a la primera consulta (la que se valida) y
// una IP privada a la segunda (la que fetch() usa de verdad para conectar).
// Esto es DNS rebinding y hace inútil cualquier validación que no fije la
// conexión a la IP concreta que se validó.
//
// La solución: resolver UNA sola vez, validar esa única resolución, y
// conectar el socket TCP/TLS directamente a esa IP — sin dejar que
// http.request/https.request repitan la resolución. El header Host y el
// SNI de TLS se fijan al hostname original para que el vhost y el
// certificado del servidor de destino sigan siendo correctos; solo la
// conexión de bajo nivel usa la IP fija.
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { isPrivateOrReservedIp } from "./ssrf-guard";

export interface SafeFetchResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  bodyStream: NodeJS.ReadableStream;
}

/** Resuelve DNS del host UNA sola vez, exige que TODAS las direcciones
    resultantes sean públicas y devuelve la que se usará para conectar. No
    hay una segunda resolución en ningún punto posterior del flujo — por
    diseño, para cerrar la ventana de DNS rebinding descrita arriba. */
export async function resolvePinnedAddress(hostname: string): Promise<string> {
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new Error("PRIVATE_TARGET");
    return hostname;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("PRIVATE_TARGET"); // no resuelve -> no se puede validar con seguridad
  }
  if (addresses.length === 0) throw new Error("PRIVATE_TARGET");
  if (addresses.some((a) => isPrivateOrReservedIp(a.address))) throw new Error("PRIVATE_TARGET");
  return addresses[0].address;
}

/** Conecta directamente a `pinnedAddress` (nunca al hostname) usando
    http.request/https.request de bajo nivel, para que Node no repita la
    resolución DNS por su cuenta. */
function requestPinned(params: { url: URL; pinnedAddress: string; timeoutMs: number }): Promise<SafeFetchResult> {
  const { url, pinnedAddress, timeoutMs } = params;
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        host: pinnedAddress, // conexión TCP: siempre la IP ya validada, nunca el hostname
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Host: url.hostname, // vhost correcto en el servidor de destino
          "User-Agent": "Mozilla/5.0 (compatible; FoodOS/1.0; +https://github.com/UnaiSuarez/FoodOS)",
          Accept: "text/html,application/xhtml+xml",
        },
        ...(isHttps ? { servername: url.hostname } : {}), // SNI + verificación de certificado contra el hostname real, no la IP
        timeout: Math.max(1, timeoutMs),
      },
      (res) => {
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, bodyStream: res });
      }
    );
    req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
    req.on("error", (err) => reject(err instanceof Error && err.message ? err : new Error("FETCH_FAILED")));
    req.end();
  });
}

/** Resuelve + valida + conecta a una URL concreta, sin seguir redirecciones
    (eso lo gestiona fetchPublicUrlPinned salto a salto, revalidando cada
    vez — ver route.ts). */
export async function safeFetch(url: URL, timeoutMs: number): Promise<SafeFetchResult> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PROTOCOL_NOT_ALLOWED");
  }
  const pinnedAddress = await resolvePinnedAddress(url.hostname);
  return requestPinned({ url, pinnedAddress, timeoutMs });
}

/** Lee un stream de Node con límite real de bytes durante la descarga (no
    tras cargarlo entero en memoria) — corta la conexión en cuanto se supera
    el límite, en vez de seguir descargando y truncar después. */
export function readNodeStreamLimited(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        const allowed = maxBytes - (received - chunk.length);
        if (allowed > 0) chunks.push(chunk.subarray(0, allowed));
        (stream as unknown as { destroy: () => void }).destroy();
        resolve(Buffer.concat(chunks).toString("utf-8"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", (err) => reject(err));
  });
}
