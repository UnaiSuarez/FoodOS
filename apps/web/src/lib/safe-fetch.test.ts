// Tests puros (sin red real) de la mitad de safe-fetch.ts que no depende de
// http.request/https.request: resolución+validación de la IP a fijar, y el
// límite de bytes durante el streaming. La parte que sí habla con
// http.request (safeFetch) se cubre en route.test.ts, mockeando ahí
// node:http/node:https junto con el resto del Route Handler — así el
// escenario de "pinning frente a rebinding" se prueba en el punto donde
// realmente importa: la ruta completa.
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

import { resolvePinnedAddress, readNodeStreamLimited } from "./safe-fetch";

afterEach(() => {
  lookupMock.mockReset();
});

describe("resolvePinnedAddress", () => {
  it("devuelve la IP cuando el hostname resuelve a una única dirección pública", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(resolvePinnedAddress("ejemplo.com")).resolves.toBe("93.184.216.34");
  });

  it("rechaza si CUALQUIERA de las direcciones resueltas es privada (rebinding con varios A records)", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(resolvePinnedAddress("ejemplo.com")).rejects.toThrow("PRIVATE_TARGET");
  });

  it("rechaza si la única dirección resuelta es privada", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(resolvePinnedAddress("metadata.interno")).rejects.toThrow("PRIVATE_TARGET");
  });

  it("rechaza si el hostname no resuelve", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(resolvePinnedAddress("no-existe.invalido")).rejects.toThrow("PRIVATE_TARGET");
  });

  it("rechaza si dns.lookup devuelve una lista vacía", async () => {
    lookupMock.mockResolvedValue([]);
    await expect(resolvePinnedAddress("vacio.com")).rejects.toThrow("PRIVATE_TARGET");
  });

  it("un literal IP pública se acepta sin llamar a dns.lookup", async () => {
    await expect(resolvePinnedAddress("93.184.216.34")).resolves.toBe("93.184.216.34");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("un literal IP privada se rechaza sin llamar a dns.lookup", async () => {
    await expect(resolvePinnedAddress("127.0.0.1")).rejects.toThrow("PRIVATE_TARGET");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("solo llama a dns.lookup UNA vez — la resolución no se repite (el punto entero de fijar la conexión)", async () => {
    lookupMock.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    await resolvePinnedAddress("ejemplo.com");
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });
});

describe("readNodeStreamLimited", () => {
  function streamOf(chunks: string[]): Readable {
    const r = new Readable({ read() {} });
    queueMicrotask(() => {
      for (const c of chunks) r.push(Buffer.from(c));
      r.push(null);
    });
    return r;
  }

  it("devuelve el cuerpo completo si no supera el límite", async () => {
    const body = await readNodeStreamLimited(streamOf(["hola ", "mundo"]), 1000);
    expect(body).toBe("hola mundo");
  });

  it("corta EXACTAMENTE en maxBytes cuando el cuerpo lo supera", async () => {
    const body = await readNodeStreamLimited(streamOf(["a".repeat(10)]), 4);
    expect(body).toBe("aaaa");
    expect(body.length).toBe(4);
  });

  it("corta correctamente cuando el límite cae en mitad de un chunk", async () => {
    const body = await readNodeStreamLimited(streamOf(["abc", "defghi"]), 5);
    expect(body).toBe("abcde");
  });
});
