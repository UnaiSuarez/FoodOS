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
    return isPrivateOrReservedIpv6(ip);
  }
  return true; // no se pudo interpretar como IP — rechazar por seguridad
}

/** Descompone una IPv6 válida en sus 8 grupos de 16 bits, expandiendo "::" y
    la notación IPv4 final (p.ej. "::ffff:127.0.0.1"). Se hace ESTRUCTURALMENTE
    (aritmética sobre los grupos), no con una regex sobre el texto — una regex
    solo reconoce la forma decimal con "::" al principio, y deja pasar como
    "pública" cualquier otra representación textual válida de la misma
    dirección: "::ffff:7f00:1" (hex en vez de decimal), "0:0:0:0:0:ffff:7f00:1"
    (sin comprimir), "::ffff:a9fe:a9fe" (link-local de nube en hex)... IPv6
    tiene muchas formas de escribir el mismo valor y todas tienen que acabar
    en el mismo resultado. */
function ipv6ToGroups(ip: string): number[] | null {
  const withoutZone = ip.split("%")[0].toLowerCase();
  const halves = withoutZone.split("::");
  if (halves.length > 2) return null; // "::" no puede aparecer más de una vez

  function parseSide(side: string): string[] | null {
    if (side === "") return [];
    const groups = side.split(":");
    const last = groups[groups.length - 1];
    if (last.includes(".")) {
      const octets = last.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
      const hi = ((octets[0] << 8) | octets[1]).toString(16);
      const lo = ((octets[2] << 8) | octets[3]).toString(16);
      groups.splice(groups.length - 1, 1, hi, lo);
    }
    if (groups.some((g) => g.length === 0 || g.length > 4 || !/^[0-9a-f]+$/.test(g))) return null;
    return groups;
  }

  const head = parseSide(halves[0]);
  if (head === null) return null;
  let full: string[];
  if (halves.length === 2) {
    const tail = parseSide(halves[1]);
    if (tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    full = [...head, ...new Array(missing).fill("0"), ...tail];
  } else {
    if (head.length !== 8) return null;
    full = head;
  }
  if (full.length !== 8) return null;
  return full.map((g) => parseInt(g, 16));
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const groups = ipv6ToGroups(ip);
  if (!groups) return true; // no se pudo interpretar -> rechazar por seguridad
  if (groups.every((g) => g === 0)) return true;                              // "::" unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // "::1" loopback
  if ((groups[0] & 0xffc0) === 0xfe80) return true;                           // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true;                           // fc00::/7 unique local
  if ((groups[0] & 0xff00) === 0xff00) return true;                           // ff00::/8 multicast
  // IPv4-mapped ::ffff:0:0/96 — los primeros 5 grupos a 0, el 6º = ffff,
  // los 2 últimos son la IPv4 embebida. Se valida esa IPv4 recursivamente,
  // sin importar en qué forma textual venía escrita la IPv6 de entrada.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isPrivateOrReservedIp(`${a}.${b}.${c}.${d}`);
  }
  return false;
}

/** Quita los corchetes de un hostname IPv6 literal tomado de URL.hostname
    ("[::1]" -> "::1") — net.isIP/isPrivateOrReservedIp no reconocen la forma
    con corchetes, y hace falta la forma "pelada" también para decidir si se
    manda SNI (ver safe-fetch.ts: nunca se manda SNI cuando el destino es un
    literal IP, sea IPv4 o IPv6). */
export function stripIPv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
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
