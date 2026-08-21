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
//
// Deadline total (revisión externa, 2026-08-21): el timeout de socket que se
// pasaba antes (http.request({ timeout })) mide INACTIVIDAD, no tiempo
// total — un servidor que manda un byte cada pocos segundos indefinidamente
// (slow-drip) resetea ese contador para siempre y nunca corta. Además no
// cubría la resolución DNS, que puede colgarse sin límite propio. Por eso
// todo el flujo (DNS + conexión + cada redirección + lectura del cuerpo)
// comparte un único AbortSignal con un deadline absoluto fijado UNA vez al
// principio de la petición completa (ver fetchPublicUrl en route.ts) — se
// aborta a esa hora exacta pase lo que pase, haya o no actividad.
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { isPrivateOrReservedIp, stripIPv6Brackets } from "./ssrf-guard";

export interface SafeFetchResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  bodyStream: NodeJS.ReadableStream;
}

/** Corre una promesa que no soporta cancelación nativa (dns.lookup no acepta
    AbortSignal) contra un signal ya existente — si el signal se aborta
    primero, esta función deja de esperar (la operación original puede
    seguir en segundo plano en el thread pool de libuv, pero la petición ya
    no depende de su resultado). */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("TIMEOUT"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("TIMEOUT"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

/** Resuelve DNS del host UNA sola vez, exige que TODAS las direcciones
    resultantes sean públicas y devuelve la que se usará para conectar. No
    hay una segunda resolución en ningún punto posterior del flujo — por
    diseño, para cerrar la ventana de DNS rebinding descrita arriba. */
export async function resolvePinnedAddress(hostname: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error("TIMEOUT"); // comprobar ANTES de llamar a dns.lookup — sus argumentos se evalúan igual aunque luego se descarte la promesa
  const bare = stripIPv6Brackets(hostname); // URL.hostname conserva los corchetes en IPv6 ("[::1]"); net.isIP no los reconoce
  if (net.isIP(bare)) {
    if (isPrivateOrReservedIp(bare)) throw new Error("PRIVATE_TARGET");
    return bare;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await raceWithAbort(dns.lookup(bare, { all: true, verbatim: true }), signal);
  } catch (err) {
    if (err instanceof Error && err.message === "TIMEOUT") throw err;
    throw new Error("PRIVATE_TARGET"); // no resuelve -> no se puede validar con seguridad
  }
  if (addresses.length === 0) throw new Error("PRIVATE_TARGET");
  if (addresses.some((a) => isPrivateOrReservedIp(a.address))) throw new Error("PRIVATE_TARGET");
  return addresses[0].address;
}

/** Conecta directamente a `pinnedAddress` (nunca al hostname) usando
    http.request/https.request de bajo nivel, para que Node no repita la
    resolución DNS por su cuenta. */
function requestPinned(params: { url: URL; pinnedAddress: string; signal: AbortSignal }): Promise<SafeFetchResult> {
  const { url, pinnedAddress, signal } = params;
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const bareHostname = stripIPv6Brackets(url.hostname);
    const isIpLiteralTarget = net.isIP(bareHostname) !== 0;
    const req = transport.request(
      {
        host: pinnedAddress, // conexión TCP: siempre la IP ya validada, nunca el hostname
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Host: url.host, // vhost correcto en el destino, incluido el puerto si no es el estándar (url.host, no url.hostname)
          "User-Agent": "Mozilla/5.0 (compatible; FoodOS/1.0; +https://github.com/UnaiSuarez/FoodOS)",
          Accept: "text/html,application/xhtml+xml",
        },
        // SNI: solo tiene sentido para un nombre de dominio — RFC 6066 excluye
        // explícitamente las IPs literales del campo server_name. Mandar un
        // literal IP (o su forma con corchetes) como SNI es inválido y algunos
        // servidores TLS lo rechazan.
        ...(isHttps && !isIpLiteralTarget ? { servername: bareHostname } : {}),
        signal, // aborta esta conexión/petición en el mismo instante que el deadline total del request.ts
      },
      (res) => {
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, bodyStream: res });
      }
    );
    req.on("error", (err) => reject(err instanceof Error && err.message ? err : new Error("FETCH_FAILED")));
    req.end();
  });
}

/** Resuelve + valida + conecta a una URL concreta, sin seguir redirecciones
    (eso lo gestiona fetchPublicUrl salto a salto, revalidando cada vez — ver
    route.ts). Todo el trabajo (DNS incluida) corre bajo el mismo signal. */
export async function safeFetch(url: URL, signal: AbortSignal): Promise<SafeFetchResult> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PROTOCOL_NOT_ALLOWED");
  }
  if (signal.aborted) throw new Error("TIMEOUT");
  const pinnedAddress = await resolvePinnedAddress(url.hostname, signal);
  return requestPinned({ url, pinnedAddress, signal });
}

/** Lee un stream de Node con límite real de bytes durante la descarga (no
    tras cargarlo entero en memoria) — corta la conexión en cuanto se supera
    el límite, en vez de seguir descargando y truncar después. También
    respeta `signal`: si el deadline total expira a mitad de la descarga
    (p.ej. un servidor que manda datos goteando indefinidamente para eludir
    un timeout de inactividad), se corta ahí igualmente aunque siga habiendo
    actividad en el stream. */
export function readNodeStreamLimited(stream: NodeJS.ReadableStream, maxBytes: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const destroyable = stream as unknown as { destroy: () => void };
    if (signal?.aborted) {
      destroyable.destroy();
      reject(new Error("TIMEOUT"));
      return;
    }
    let received = 0;
    const chunks: Buffer[] = [];
    const onAbort = () => {
      destroyable.destroy();
      reject(new Error("TIMEOUT"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    stream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        const allowed = maxBytes - (received - chunk.length);
        if (allowed > 0) chunks.push(chunk.subarray(0, allowed));
        destroyable.destroy();
        cleanup();
        resolve(Buffer.concat(chunks).toString("utf-8"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    stream.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}
