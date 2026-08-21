// Tests puros (sin red real) de la mitad de safe-fetch.ts que no depende de
// http.request/https.request: resolución+validación de la IP a fijar, y el
// límite de bytes durante el streaming, incluida su cancelación por deadline
// total. La parte que sí habla con http.request (safeFetch) se cubre en
// route.test.ts, mockeando ahí node:http/node:https junto con el resto del
// Route Handler — así el escenario de "pinning frente a rebinding" se prueba
// en el punto donde realmente importa: la ruta completa.
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

import { resolvePinnedAddress, readNodeStreamLimited } from "./safe-fetch";

function noAbort(): AbortSignal {
  return new AbortController().signal;
}

afterEach(() => {
  lookupMock.mockReset();
});

describe("resolvePinnedAddress", () => {
  it("devuelve la IP cuando el hostname resuelve a una única dirección pública", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(resolvePinnedAddress("ejemplo.com", noAbort())).resolves.toBe("93.184.216.34");
  });

  it("rechaza si CUALQUIERA de las direcciones resueltas es privada (rebinding con varios A records)", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(resolvePinnedAddress("ejemplo.com", noAbort())).rejects.toThrow("PRIVATE_TARGET");
  });

  it("rechaza si la única dirección resuelta es privada", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(resolvePinnedAddress("metadata.interno", noAbort())).rejects.toThrow("PRIVATE_TARGET");
  });

  it("rechaza si el hostname no resuelve", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(resolvePinnedAddress("no-existe.invalido", noAbort())).rejects.toThrow("PRIVATE_TARGET");
  });

  it("rechaza si dns.lookup devuelve una lista vacía", async () => {
    lookupMock.mockResolvedValue([]);
    await expect(resolvePinnedAddress("vacio.com", noAbort())).rejects.toThrow("PRIVATE_TARGET");
  });

  it("un literal IP pública se acepta sin llamar a dns.lookup", async () => {
    await expect(resolvePinnedAddress("93.184.216.34", noAbort())).resolves.toBe("93.184.216.34");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("un literal IP privada se rechaza sin llamar a dns.lookup", async () => {
    await expect(resolvePinnedAddress("127.0.0.1", noAbort())).rejects.toThrow("PRIVATE_TARGET");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("solo llama a dns.lookup UNA vez — la resolución no se repite (el punto entero de fijar la conexión)", async () => {
    lookupMock.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    await resolvePinnedAddress("ejemplo.com", noAbort());
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it("un literal IPv6 con corchetes (tal cual lo da URL.hostname) se reconoce como IP sin llamar a dns.lookup", async () => {
    await expect(resolvePinnedAddress("[2606:4700:4700::1111]", noAbort())).resolves.toBe("2606:4700:4700::1111");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("un literal IPv6 privado con corchetes se rechaza sin llamar a dns.lookup", async () => {
    await expect(resolvePinnedAddress("[::1]", noAbort())).rejects.toThrow("PRIVATE_TARGET");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("se cancela con TIMEOUT si el signal ya está abortado antes de resolver", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolvePinnedAddress("ejemplo.com", controller.signal)).rejects.toThrow("TIMEOUT");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("se cancela con TIMEOUT si el signal se aborta mientras dns.lookup sigue pendiente", async () => {
    const controller = new AbortController();
    lookupMock.mockImplementation(() => new Promise(() => {})); // nunca se resuelve por sí sola
    const pending = resolvePinnedAddress("lento.example.com", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("TIMEOUT");
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

  // Deadline total frente a timeout de inactividad (revisión externa,
  // 2026-08-21): un servidor "slow-drip" que manda un byte cada pocos
  // milisegundos para siempre nunca dispararía un timeout basado en
  // inactividad de socket — SIEMPRE hay actividad. Este test simula
  // exactamente eso: chunks periódicos indefinidos, y comprueba que el
  // deadline total (el AbortSignal) corta la descarga de todos modos,
  // aunque el stream nunca deje de recibir datos por sí mismo.
  it("se corta por el deadline total aunque el stream siga recibiendo datos periódicamente (slow-drip)", async () => {
    const stream = new Readable({ read() {} });
    const interval = setInterval(() => stream.push(Buffer.from("x")), 5);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const start = Date.now();
    await expect(readNodeStreamLimited(stream, 1_000_000, controller.signal)).rejects.toThrow("TIMEOUT");
    const elapsed = Date.now() - start;

    clearInterval(interval);
    stream.destroy();
    // Debe cortar cerca del deadline (30ms), no seguir indefinidamente
    // goteando datos — margen generoso para no ser un test frágil por timing.
    expect(elapsed).toBeLessThan(500);
  });

  it("un signal ya abortado antes de empezar corta inmediatamente sin leer nada", async () => {
    const stream = streamOf(["esto no debería leerse"]);
    const controller = new AbortController();
    controller.abort();
    await expect(readNodeStreamLimited(stream, 1000, controller.signal)).rejects.toThrow("TIMEOUT");
  });
});
