import { describe, expect, it } from "vitest";
import { namesMatch, toGrams } from "./utils";

describe("toGrams", () => {
  it("kg y L multiplican por 1000", () => {
    expect(toGrams(2, "kg")).toBe(2000);
    expect(toGrams(1.5, "L")).toBe(1500);
  });

  it("g y ml pasan igual (caso por defecto)", () => {
    expect(toGrams(250, "g")).toBe(250);
    expect(toGrams(330, "ml")).toBe(330);
  });

  it("oz y lb usan el factor de conversión correcto", () => {
    expect(toGrams(1, "oz")).toBeCloseTo(28.35, 5);
    expect(toGrams(1, "lb")).toBeCloseTo(453.6, 5);
  });

  it("cucharada y pizca", () => {
    expect(toGrams(1, "cucharada")).toBe(15);
    expect(toGrams(1, "pizca")).toBe(0.5);
  });

  it("ud usa unitSize (o 60 por defecto)", () => {
    expect(toGrams(3, "ud")).toBe(180); // 3 * 60 por defecto
    expect(toGrams(2, "ud", 125)).toBe(250); // ej. yogures de 125g
  });
});

describe("namesMatch", () => {
  it("coincide con nombres idénticos (case-insensitive, con espacios)", () => {
    expect(namesMatch("Pechuga de pollo", "pechuga de pollo")).toBe(true);
    expect(namesMatch("  Leche  ", "leche")).toBe(true);
  });

  it("coincide si la primera palabra de uno está contenida en el otro", () => {
    expect(namesMatch("Pollo", "Pollo entero")).toBe(true);
    expect(namesMatch("Yogur griego", "Yogur")).toBe(true);
  });

  it("no coincide con nombres sin relación", () => {
    expect(namesMatch("Pollo", "Arroz")).toBe(false);
  });

  it("cadenas vacías nunca coinciden", () => {
    expect(namesMatch("", "algo")).toBe(false);
    expect(namesMatch("algo", "")).toBe(false);
  });
});
