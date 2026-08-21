// Bloqueo de SSRF para rutas server-side que descargan URLs proporcionadas
// por el usuario (hoy: /api/recipe-fetch). Extraído a módulo aparte para
// poder testear la lógica de rangos de IP sin levantar un Route Handler —
// ver docs de la propia ruta para el contexto completo de la vulnerabilidad
// (auditoría externa, 2026-08-21).
//
// La resolución DNS + validación + conexión real vive en lib/safe-fetch.ts,
// no aquí — deliberadamente: hacerlo con fetch()/dns.lookup() por separado
// (como se hacía antes con resolvesToPublicAddress/assertPublicUrl, ya
// retirados de este archivo) deja una ventana de DNS rebinding entre
// "resolver para validar" y "resolver para conectar". safe-fetch.ts resuelve
// una sola vez y fija la conexión a esa IP — ver el comentario al principio
// de ese archivo.
import net from "node:net";

/** ¿Es esta IP privada, loopback, link-local (incluye el endpoint de
    metadata de nube 169.254.169.254), multicast o reservada? No es un
    listado exhaustivo de cada RFC, pero cubre todo lo que un atacante
    usaría realmente para SSRF contra infraestructura interna. */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b, c] = parts;
    if (a === 0) return true;                                    // 0.0.0.0/8
    if (a === 10) return true;                                    // 10.0.0.0/8
    if (a === 127) return true;                                   // 127.0.0.0/8 loopback
    if (a === 100 && b >= 64 && b <= 127) return true;            // 100.64.0.0/10 CGNAT
    if (a === 169 && b === 254) return true;                      // 169.254.0.0/16 link-local (incl. metadata cloud)
    if (a === 172 && b >= 16 && b <= 31) return true;              // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                      // 192.168.0.0/16
    if (a === 192 && b === 0 && c === 0) return true;              // 192.0.0.0/24
    if (a === 192 && b === 0 && c === 2) return true;              // 192.0.2.0/24 (TEST-NET-1)
    if (a === 198 && b === 51 && c === 100) return true;           // 198.51.100.0/24 (TEST-NET-2)
    if (a === 203 && b === 0 && c === 113) return true;            // 203.0.113.0/24 (TEST-NET-3)
    if (a >= 224) return true;                                     // 224.0.0.0/4 multicast + 240.0.0.0/4 reservado + broadcast
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;            // loopback / unspecified
    if (/^fe[89ab]/.test(lower)) return true;                      // fe80::/10 link-local
    if (/^f[cd]/.test(lower)) return true;                         // fc00::/7 unique local
    if (lower.startsWith("ff")) return true;                       // ff00::/8 multicast
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }
  return true; // no se pudo interpretar como IP — rechazar por seguridad
}

// ─── Rate limiting ────────────────────────────────────────────────────────
// Mitigación básica en memoria, por clave (IP) — NO sobrevive a un reinicio
// ni es compartida entre instancias si el despliegue escala horizontalmente
// (cada instancia serverless tendría su propio contador). Es mejor que nada
// y cierra el caso de abuso de una sola instancia/IP; si esto pasa a
// necesitar protección robusta multi-instancia, mover a un store
// compartido (Upstash/Redis) — documentado como límite conocido, no oculto.
export function createRateLimiter(windowMs: number, maxRequests: number) {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  return function isRateLimited(key: string, now: number = Date.now()): boolean {
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      buckets.set(key, { count: 1, windowStart: now });
      return false;
    }
    bucket.count += 1;
    return bucket.count > maxRequests;
  };
}
