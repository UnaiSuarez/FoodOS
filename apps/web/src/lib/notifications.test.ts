import { describe, expect, it } from "vitest";
import type { InventoryItem } from "@foodos/types";
import { buildExpiryNotification, getExpiringForNotification } from "./notifications";
import { todayPlus } from "./utils";

function item(name: string, expiresInDays: number, qty = 100): InventoryItem {
  return {
    id: name,
    name,
    qty,
    unit: "g",
    storage: "Nevera",
    expires: todayPlus(expiresInDays),
    price: 1,
    kcal: 100,
    protein: 10,
  };
}

describe("getExpiringForNotification", () => {
  it("incluye lo que caduca hoy, mañana o ya caducó; excluye lo lejano", () => {
    const result = getExpiringForNotification([
      item("Caducado", -2),
      item("Caduca hoy", 0),
      item("Caduca mañana", 1),
      item("Caduca en 3 días", 3),
      item("Caduca en una semana", 7),
    ]);
    expect(result.map((i) => i.name)).toEqual(["Caducado", "Caduca hoy", "Caduca mañana"]);
  });

  it("ignora items sin stock", () => {
    const result = getExpiringForNotification([item("Vacío", 0, 0)]);
    expect(result).toEqual([]);
  });

  it("ordena por urgencia (lo más caducado primero)", () => {
    const result = getExpiringForNotification([item("Mañana", 1), item("Hoy", 0)]);
    expect(result[0].name).toBe("Hoy");
  });
});

describe("buildExpiryNotification", () => {
  it("singular con un item", () => {
    const { title, body } = buildExpiryNotification([item("Pollo", 0)]);
    expect(title).toBe("1 alimento caduca ya");
    expect(body).toContain("Pollo");
  });

  it("lista hasta 3 nombres y resume el resto", () => {
    const items = [item("A", 0), item("B", 0), item("C", 0), item("D", 0), item("E", 0)];
    const { title, body } = buildExpiryNotification(items);
    expect(title).toBe("5 alimentos caducan ya");
    expect(body).toContain("A, B, C y 2 más");
  });
});
