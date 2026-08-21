// Tests de integración de GET /api/recipe-fetch (revisión externa,
// 2026-08-21) — cubren la ruta completa, no solo isPrivateOrReservedIp
// (eso ya está en lib/ssrf-guard.test.ts). node:dns/promises y
// node:http/node:https se mockean para no depender de red real; el resto
// (auth, rate limit, seguimiento de redirecciones, límite de bytes) corre
// con el código real de la ruta.
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks de red ──────────────────────────────────────────────────────────
// lookupTable: hostname -> lista de IPs que "resuelve" ese hostname en cada
// test. responseTable: hostname -> función que fabrica la respuesta HTTP que
// devolvería ESE hostname (statusCode/headers/body) — el mock de
// http.request/https.request la busca por options.headers.Host, que es
// justo el hostname original (nunca la IP pinneada, ver safe-fetch.ts).
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}
let responseTable: Map<string, FakeResponse>;
const requestMock = vi.fn((options: { headers: Record<string, string>; host: string; servername?: string }, callback: (res: unknown) => void) => {
  const hostHeader = options.headers.Host;
  const fake = responseTable.get(hostHeader);
  const stream = new Readable({ read() {} }) as Readable & { statusCode: number; headers: Record<string, string> };
  stream.statusCode = fake?.statusCode ?? 502;
  stream.headers = fake?.headers ?? {};
  queueMicrotask(() => {
    stream.push(Buffer.from(fake?.body ?? ""));
    stream.push(null);
    callback(stream);
  });
  return { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
});
vi.mock("node:http", () => ({ default: { request: (...args: unknown[]) => (requestMock as (...a: unknown[]) => unknown)(...args) } }));
vi.mock("node:https", () => ({ default: { request: (...args: unknown[]) => (requestMock as (...a: unknown[]) => unknown)(...args) } }));

const getUserMock = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: getUserMock } }),
}));

const { GET } = await import("./route");
const { NextRequest } = await import("next/server");

function makeRequest(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(new Request(`http://localhost${url}`, { headers }));
}

beforeEach(() => {
  responseTable = new Map();
  lookupMock.mockReset();
  requestMock.mockClear();
  getUserMock.mockReset();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proyecto-test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-test");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FOODOS_ALLOW_LOCAL_ONLY_API", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/recipe-fetch — autenticación", () => {
  it("401 sin token cuando Supabase está configurado", async () => {
    const res = await GET(makeRequest("/api/recipe-fetch?url=https://publica.example.com/receta"));
    expect(res.status).toBe(401);
  });

  it("401 con token inválido", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error("invalid") });
    const res = await GET(
      makeRequest("/api/recipe-fetch?url=https://publica.example.com/receta", { authorization: "Bearer malo" })
    );
    expect(res.status).toBe(401);
  });

  it("fail-closed: sin config de Supabase Y sin señal explícita de dev, deniega (no se abre sola)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const res = await GET(makeRequest("/api/recipe-fetch?url=https://publica.example.com/receta"));
    expect(res.status).toBe(401);
  });

  it("fail-closed: la señal explícita NO basta en producción", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FOODOS_ALLOW_LOCAL_ONLY_API", "true");
    const res = await GET(makeRequest("/api/recipe-fetch?url=https://publica.example.com/receta"));
    expect(res.status).toBe(401);
  });

  it("con la señal explícita fuera de producción, pasa la autenticación (llega a intentar la descarga)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("FOODOS_ALLOW_LOCAL_ONLY_API", "true");
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    responseTable.set("publica.example.com", {
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: "<html><title>ok</title><body>receta</body></html>",
    });
    const res = await GET(makeRequest("/api/recipe-fetch?url=https://publica.example.com/receta"));
    expect(res.status).not.toBe(401);
  });
});

describe("GET /api/recipe-fetch — SSRF vía redirección y rebinding", () => {
  it("bloquea una redirección pública→privada (con sesión válida)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === "publica.example.com") return [{ address: "93.184.216.34", family: 4 }];
      if (hostname === "interno.local") return [{ address: "10.0.0.5", family: 4 }];
      throw new Error("ENOTFOUND");
    });
    responseTable.set("publica.example.com", {
      statusCode: 302,
      headers: { location: "http://interno.local/secreto" },
      body: "",
    });
    const res = await GET(
      makeRequest("/api/recipe-fetch?url=https://publica.example.com/receta", { authorization: "Bearer x" })
    );
    const json = (await res.json()) as { error?: string };
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/no es accesible/i);
  });

  it("bloquea directamente un objetivo cuyo hostname resuelve a IP privada (rebinding con varios A records)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }, // basta con que UNA sea privada
    ]);
    const res = await GET(
      makeRequest("/api/recipe-fetch?url=https://rebinding.example.com/receta", { authorization: "Bearer x" })
    );
    expect(res.status).toBe(400);
  });

  it("la conexión real usa la IP fijada por la única resolución, no el hostname — pinning frente a rebinding", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    responseTable.set("publica.example.com", {
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: "<html><title>ok</title><body>receta con contenido suficiente</body></html>",
    });
    await GET(makeRequest("/api/recipe-fetch?url=https://publica.example.com/receta", { authorization: "Bearer x" }));
    expect(lookupMock).toHaveBeenCalledTimes(1); // una sola resolución para toda la petición
    expect(requestMock).toHaveBeenCalledTimes(1);
    const optionsUsed = requestMock.mock.calls[0][0] as { host: string; headers: Record<string, string> };
    expect(optionsUsed.host).toBe("93.184.216.34"); // conecta a la IP resuelta, no a "publica.example.com"
    expect(optionsUsed.headers.Host).toBe("publica.example.com"); // pero el vhost/SNI siguen siendo el hostname real
  });

  it("demasiadas redirecciones se rechazan en vez de seguir indefinidamente", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    lookupMock.mockImplementation(async (hostname: string) => {
      const n = Number(hostname.split(".")[0].replace("hop", ""));
      return [{ address: `93.184.216.${n}`, family: 4 }];
    });
    for (let i = 0; i <= 6; i++) {
      responseTable.set(`hop${i}.example.com`, {
        statusCode: 302,
        headers: { location: `http://hop${i + 1}.example.com/` },
        body: "",
      });
    }
    const res = await GET(
      makeRequest("/api/recipe-fetch?url=https://hop0.example.com/", { authorization: "Bearer x" })
    );
    const json = (await res.json()) as { error?: string };
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/redirecciones/i);
  });
});

describe("GET /api/recipe-fetch — IPv6 y puertos no estándar", () => {
  it("un objetivo IPv6 literal público se pinnea directamente, sin dns.lookup y sin SNI", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    responseTable.set("[2606:4700:4700::1111]", {
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: "<html><title>ok</title><body>receta con contenido suficiente</body></html>",
    });
    const res = await GET(
      makeRequest("/api/recipe-fetch?url=https://[2606:4700:4700::1111]/receta", { authorization: "Bearer x" })
    );
    expect(res.status).toBe(200);
    expect(lookupMock).not.toHaveBeenCalled(); // literal IP: no hace falta resolver
    const optionsUsed = requestMock.mock.calls[0][0] as { host: string; headers: Record<string, string>; servername?: string };
    expect(optionsUsed.host).toBe("2606:4700:4700::1111"); // sin corchetes al conectar (net.connect espera la IP pelada)
    expect(optionsUsed.headers.Host).toBe("[2606:4700:4700::1111]"); // con corchetes en el header Host, como exige HTTP
    expect(optionsUsed.servername).toBeUndefined(); // RFC 6066: SNI no se manda para un literal IP
  });

  it("un objetivo IPv6 literal privado (::1) se bloquea sin dns.lookup", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const res = await GET(
      makeRequest("/api/recipe-fetch?url=https://[::1]/receta", { authorization: "Bearer x" })
    );
    expect(res.status).toBe(400);
    expect(lookupMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("el header Host incluye el puerto cuando no es el estándar", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    responseTable.set("publica.example.com:8443", {
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: "<html><title>ok</title><body>receta con contenido suficiente</body></html>",
    });
    const res = await GET(
      makeRequest("/api/recipe-fetch?url=https://publica.example.com:8443/receta", { authorization: "Bearer x" })
    );
    expect(res.status).toBe(200);
    const optionsUsed = requestMock.mock.calls[0][0] as { host: string; port: number; headers: Record<string, string> };
    expect(optionsUsed.headers.Host).toBe("publica.example.com:8443");
    expect(optionsUsed.port).toBe(8443);
    expect(optionsUsed.host).toBe("93.184.216.34"); // conecta a la IP fijada, el puerto va aparte
  });

  it("un objetivo con hostname normal SÍ manda SNI (servername) con el hostname real", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    responseTable.set("publica.example.com", {
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: "<html><title>ok</title><body>receta con contenido suficiente</body></html>",
    });
    await GET(makeRequest("/api/recipe-fetch?url=https://publica.example.com/receta", { authorization: "Bearer x" }));
    const optionsUsed = requestMock.mock.calls[0][0] as { servername?: string };
    expect(optionsUsed.servername).toBe("publica.example.com");
  });
});

describe("GET /api/recipe-fetch — límite de bytes", () => {
  it("trunca cuerpos enormes en vez de cargarlos enteros o fallar", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const hugeBody = `<html><title>t</title><body>${"x".repeat(2_000_000)}</body></html>`;
    responseTable.set("publica.example.com", {
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: hugeBody,
    });
    const res = await GET(
      makeRequest("/api/recipe-fetch?url=https://publica.example.com/receta", { authorization: "Bearer x" })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { text?: string };
    expect(json.text?.length).toBeLessThanOrEqual(8_000); // MAX_TEXT_CHARS de la ruta
  });
});
