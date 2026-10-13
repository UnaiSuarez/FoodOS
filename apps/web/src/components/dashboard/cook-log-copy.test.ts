import { describe, expect, it } from "vitest";
import { describeLogTarget, inventoryOutcome, registeredWord, servingsLabel } from "./cook-log-copy";

describe("describeLogTarget — dónde se registrará, sin asumir «hoy, Comida»", () => {
  it("sin fecha ni tipo: hoy, y el tipo sale de la hora", () => {
    const at = (time: string) => describeLogTarget({ today: "2026-10-14", time });
    expect(at("07:30")).toMatchObject({ isToday: true, dateLabel: "hoy", mealType: "breakfast", mealLabel: "Desayuno", mealFromClock: true });
    expect(at("13:00")).toMatchObject({ mealType: "lunch", mealLabel: "Comida" });
    expect(at("17:30")).toMatchObject({ mealType: "snack", mealLabel: "Snack" });
    expect(at("21:15")).toMatchObject({ mealType: "dinner", mealLabel: "Cena" });
    expect(at("02:00")).toMatchObject({ mealType: "dinner" });
  });

  it("con fecha y tipo recibidos (Planificador) usa esos, no el reloj ni hoy", () => {
    const target = describeLogTarget({ today: "2026-10-14", date: "2026-10-16", mealType: "dinner", time: "08:00" });
    expect(target.isToday).toBe(false);
    expect(target.date).toBe("2026-10-16");
    expect(target.dateLabel).toMatch(/viernes.*16.*octubre/i);
    expect(target.mealType).toBe("dinner");
    expect(target.mealLabel).toBe("Cena");
    expect(target.mealFromClock).toBe(false);
  });

  it("una fecha igual a hoy se sigue llamando «hoy»", () => {
    expect(describeLogTarget({ today: "2026-10-14", date: "2026-10-14", mealType: "lunch" }).dateLabel).toBe("hoy");
  });
});

describe("servingsLabel / registeredWord", () => {
  it("singular y plural, con decimales en coma", () => {
    expect(servingsLabel(1)).toBe("1 ración");
    expect(servingsLabel(2)).toBe("2 raciones");
    expect(servingsLabel(1.5)).toBe("1,5 raciones");
    expect(servingsLabel(0.5)).toBe("0,5 raciones");
    expect(registeredWord(1)).toBe("registrada");
    expect(registeredWord(3)).toBe("registradas");
  });
});

describe("inventoryOutcome — nunca afirma que se descontó todo si faltaba stock", () => {
  it("sin descuento: inventario sin cambios, aunque faltara stock", () => {
    expect(inventoryOutcome({ deduct: false, shortCount: 2, lotsTouched: 0 })).toBe("inventario sin cambios");
  });
  it("con descuento y stock suficiente", () => {
    expect(inventoryOutcome({ deduct: true, shortCount: 0, lotsTouched: 3 })).toBe("ingredientes descontados");
  });
  it("con descuento y faltantes: solo lo disponible, con el número", () => {
    expect(inventoryOutcome({ deduct: true, shortCount: 1, lotsTouched: 1 })).toBe(
      "descontado solo lo disponible (1 ingrediente sin stock suficiente)",
    );
    expect(inventoryOutcome({ deduct: true, shortCount: 2, lotsTouched: 0 })).toContain("2 ingredientes sin stock suficiente");
    expect(inventoryOutcome({ deduct: true, shortCount: 1, lotsTouched: 1 })).not.toContain("ingredientes descontados");
  });
  it("con descuento pero sin nada que tocar", () => {
    expect(inventoryOutcome({ deduct: true, shortCount: 0, lotsTouched: 0 })).toBe("no había ingredientes que descontar");
  });
});
