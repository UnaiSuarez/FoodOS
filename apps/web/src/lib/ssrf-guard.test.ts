// Cobertura del bloqueo de SSRF de /api/recipe-fetch (auditoría externa,
// 2026-08-21). Casos elegidos para cubrir exactamente lo que un atacante
// usaría: loopback, RFC1918, link-local (metadata cloud), CGNAT, rangos de
// documentación, multicast/reservado, e IPv6 equivalentes + mapeo IPv4.
import { describe, expect, it } from "vitest";
import { isPrivateOrReservedIp, stripIPv6Brackets } from "./ssrf-guard";

describe("isPrivateOrReservedIp — IPv4", () => {
  it.each([
    ["127.0.0.1", true, "loopback"],
    ["127.255.255.255", true, "loopback (extremo del rango)"],
    ["0.0.0.0", true, "0.0.0.0/8"],
    ["10.0.0.1", true, "10.0.0.0/8"],
    ["10.255.255.255", true, "10.0.0.0/8 (extremo)"],
    ["172.16.0.1", true, "172.16.0.0/12 (inicio)"],
    ["172.31.255.255", true, "172.16.0.0/12 (fin)"],
    ["172.32.0.1", false, "justo fuera de 172.16.0.0/12"],
    ["172.15.255.255", false, "justo antes de 172.16.0.0/12"],
    ["192.168.0.1", true, "192.168.0.0/16"],
    ["169.254.169.254", true, "metadata de nube (AWS/GCP/Azure)"],
    ["169.254.0.1", true, "169.254.0.0/16 link-local"],
    ["100.64.0.1", true, "100.64.0.0/10 CGNAT"],
    ["100.127.255.255", true, "100.64.0.0/10 CGNAT (extremo)"],
    ["192.0.2.1", true, "192.0.2.0/24 TEST-NET-1"],
    ["198.51.100.1", true, "198.51.100.0/24 TEST-NET-2"],
    ["203.0.113.1", true, "203.0.113.0/24 TEST-NET-3"],
    ["224.0.0.1", true, "multicast"],
    ["240.0.0.1", true, "reservado"],
    ["255.255.255.255", true, "broadcast"],
    ["8.8.8.8", false, "Google DNS pública"],
    ["1.1.1.1", false, "Cloudflare DNS pública"],
    ["93.184.216.34", false, "IP pública genérica"],
  ] as const)("%s → %s (%s)", (ip, expected, _label) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected);
  });
});

describe("isPrivateOrReservedIp — IPv6", () => {
  it.each([
    ["::1", true, "loopback"],
    ["::", true, "unspecified"],
    ["fe80::1", true, "link-local fe80::/10"],
    ["febf::1", true, "link-local fe80::/10 (extremo alto)"],
    ["fc00::1", true, "unique local fc00::/7"],
    ["fd12:3456::1", true, "unique local fd00::/8"],
    ["ff02::1", true, "multicast"],
    ["::ffff:127.0.0.1", true, "IPv4-mapped, loopback embebido, forma decimal"],
    ["::ffff:10.0.0.1", true, "IPv4-mapped, privada embebida, forma decimal"],
    ["::ffff:8.8.8.8", false, "IPv4-mapped, pública embebida, forma decimal"],
    ["2606:4700:4700::1111", false, "Cloudflare DNS pública IPv6"],
    ["2001:4860:4860::8888", false, "Google DNS pública IPv6"],
    // Mismas direcciones IPv4-mapped que arriba, pero escritas en otras
    // formas textuales válidas — todas tienen que dar el mismo resultado
    // que su equivalente decimal (revisión externa, 2026-08-21: la regex
    // original solo reconocía "::ffff:a.b.c.d" y dejaba pasar el resto).
    ["::ffff:7f00:1", true, "IPv4-mapped loopback, grupos en hex en vez de decimal"],
    ["0:0:0:0:0:ffff:7f00:1", true, "IPv4-mapped loopback, sin comprimir con ::"],
    ["::FFFF:7F00:1", true, "IPv4-mapped loopback, hex en mayúsculas"],
    ["::ffff:a00:1", true, "IPv4-mapped 10.0.0.1, hex en vez de decimal"],
    ["::ffff:a9fe:a9fe", true, "IPv4-mapped metadata de nube (169.254.169.254), hex"],
    ["::ffff:558:808", false, "IPv4-mapped 5.88.8.8 pública, hex (no confundir con 8.8.8.8)"],
  ] as const)("%s → %s (%s)", (ip, expected, _label) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected);
  });
});

describe("isPrivateOrReservedIp — entradas no-IP", () => {
  it("una cadena que no es una IP válida se rechaza por seguridad (true)", () => {
    expect(isPrivateOrReservedIp("no-es-una-ip")).toBe(true);
    expect(isPrivateOrReservedIp("")).toBe(true);
  });
});

describe("stripIPv6Brackets", () => {
  it("quita los corchetes de un literal IPv6", () => {
    expect(stripIPv6Brackets("[::1]")).toBe("::1");
    expect(stripIPv6Brackets("[2606:4700:4700::1111]")).toBe("2606:4700:4700::1111");
  });

  it("deja intacto un hostname que no lleva corchetes", () => {
    expect(stripIPv6Brackets("ejemplo.com")).toBe("ejemplo.com");
    expect(stripIPv6Brackets("93.184.216.34")).toBe("93.184.216.34");
  });
});
