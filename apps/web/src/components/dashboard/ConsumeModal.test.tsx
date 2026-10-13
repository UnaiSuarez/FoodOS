// @vitest-environment jsdom
//
// §20 — ConsumeModal montado sobre el FoodOSProvider REAL (mismo patrón que
// food-log-writers.integration.test.tsx): se interactúa con los controles
// que la persona usaría de verdad y se inspecciona el estado resultante.
// Cubre el modo «He pesado» (declaración explícita de peso, g/kg) por
// separado del recorrido estimado de siempre, validación en el propio
// modal, bloqueo por cambio de unidad con reintento, y protección contra
// doble registro.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FoodLogEntry, InventoryItem } from "@foodos/types";
import { FoodOSProvider, macrosForQuantity, useFoodOS } from "@/lib/state";
import { ConsumeModal } from "./ConsumeModal";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useFoodOS>;
let container: HTMLDivElement;
let root: Root | null = null;

function makeCapture() {
  const holder: { current: Ctx | null } = { current: null };
  function Capture() {
    holder.current = useFoodOS();
    return null;
  }
  return { Capture, holder };
}

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "inv-1", name: "Pechuga de pollo", qty: 1000, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 4,
    kcal: 165, protein: 31, carbs: 0, fat: 3.6,
    ...overrides,
  };
}

async function mount(seed: (draft: Ctx["state"]) => void, invItem: InventoryItem, onClose = () => {}) {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => { holder.current!.mutate((draft) => seed(draft)); });
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /><ConsumeModal item={invItem} onClose={onClose} /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  return holder;
}

function setNativeValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function checkboxByLabel(text: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes(text));
  if (!label) throw new Error(`No hay <label> con «${text}»`);
  const input = label.querySelector('input[type="checkbox"]');
  if (!input) throw new Error(`El <label> «${text}» no contiene una casilla`);
  return input as HTMLInputElement;
}

function numberInputByLabel(text: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes(text));
  if (!label) throw new Error(`No hay <label> con «${text}»`);
  const input = label.querySelector('input[type="number"]');
  if (!input) throw new Error(`El <label> «${text}» no contiene un input numérico`);
  return input as HTMLInputElement;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`No hay botón con «${text}»`);
  return found as HTMLButtonElement;
}

function click(el: Element) {
  act(() => { (el as HTMLElement).click(); });
}

function lastEntry(holder: { current: Ctx | null }): FoodLogEntry {
  const log = holder.current!.state.foodLog;
  return log[log.length - 1];
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    act(() => { root!.unmount(); });
    root = null;
  }
  container.remove();
  localStorage.clear();
});

describe("ConsumeModal — modo «He pesado»: visible solo para inventario en gramos, desmarcado al abrir", () => {
  it("la casilla aparece para un item en 'g'", async () => {
    await mount((d) => { d.inventory = [item()]; }, item());
    expect(() => checkboxByLabel("He pesado")).not.toThrow();
  });

  it("la casilla NO aparece para un item en 'kg' y la interfaz explica por qué; el recorrido estimado sigue disponible", async () => {
    const kg = item({ unit: "kg", qty: 1.5 });
    const holder = await mount((d) => { d.inventory = [kg]; }, kg);
    expect(() => checkboxByLabel("He pesado")).toThrow();
    expect(container.textContent).toContain("solo está disponible con inventario en gramos");
    expect(() => numberInputByLabel("Cantidad (kg)")).not.toThrow();
    // El estimado de siempre registra sin quantityConfidence.
    click(buttonByText("Registrar consumo"));
    expect(lastEntry(holder).quantityConfidence).toBeUndefined();
  });

  it("la casilla NO aparece para un item en 'ud'", async () => {
    await mount((d) => { d.inventory = [item({ unit: "ud", qty: 5, unitSize: 60, unitSizeUnit: "g" })]; }, item({ unit: "ud", qty: 5 }));
    expect(() => checkboxByLabel("He pesado")).toThrow();
  });

  it("empieza desmarcada — el recorrido estimado (slider/presets) sigue visible por defecto", async () => {
    await mount((d) => { d.inventory = [item()]; }, item());
    expect(checkboxByLabel("He pesado").checked).toBe(false);
    expect(() => numberInputByLabel("Cantidad (g)")).not.toThrow();
  });
});

describe("ConsumeModal — modo «He pesado»: 200 g desde 1000 g", () => {
  it("registra con qty:200, unit:'g', quantityConfidence high con declaredGrams:200", async () => {
    const holder = await mount((d) => { d.inventory = [item()]; }, item());
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), "200");
    click(buttonByText("Registrar consumo"));

    const entry = lastEntry(holder);
    expect(entry.qty).toBe(200);
    expect(entry.unit).toBe("g");
    expect(entry.quantityConfidence).toEqual({ level: "high", declaredGrams: 200 });
    expect(holder.current!.state.inventory[0].qty).toBe(800);
  });
});

describe("ConsumeModal — precisión admitida (2 decimales): ni validación, ni vista previa, ni registro, ni stock redondean en silencio", () => {
  function macroCells() {
    return Array.from(container.querySelectorAll(".macro-val")).map((n) => n.textContent);
  }

  it.each(["233.6", "0.4"])("%s g: se acepta, la vista previa muestra los macros de ESA cantidad y se registra exactamente igual", async (typed) => {
    const grams = Number(typed);
    const holder = await mount((d) => { d.inventory = [item()]; }, item());
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), typed);
    expect(buttonByText("Registrar consumo").disabled).toBe(false);

    const expected = macrosForQuantity(item(), grams);
    expect(macroCells()).toEqual([String(expected.kcal), `${expected.protein}g`, `~${expected.carbs}g`, `~${expected.fat}g`]);
    expect(container.textContent).toContain(`Se registrarán ${grams} g`);

    click(buttonByText("Registrar consumo"));
    const entry = lastEntry(holder);
    expect(entry.qty).toBe(grams);
    expect(entry.qty!).toBeGreaterThan(0);
    expect(entry.quantityConfidence).toEqual({ level: "high", declaredGrams: grams });
    expect({ kcal: entry.kcal, protein: entry.protein, carbs: entry.carbs, fat: entry.fat }).toEqual(expected);
    expect(holder.current!.state.inventory[0].qty).toBe(Math.round((1000 - grams) * 100) / 100);
  });

  it.each(["233.456", "0.004", "200.004"])("%s g (más de 2 decimales): el botón se deshabilita y se explica, no se redondea", async (typed) => {
    const holder = await mount((d) => { d.inventory = [item()]; }, item());
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), typed);
    expect(buttonByText("Registrar consumo").disabled).toBe(true);
    expect(container.textContent).toContain("como máximo 2 decimales");
    expect(holder.current!.state.foodLog).toHaveLength(0);
  });

  it("declaración superior al stock (500 g sobre 200,6 g): avisa, muestra los macros de lo que de verdad se registra y registra 200,6 con low", async () => {
    const low = item({ qty: 200.6 });
    const holder = await mount((d) => { d.inventory = [low]; }, low);
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), "500");
    expect(container.textContent).toContain("Solo quedan 200.6 g. Se registrará esa cantidad; el peso registrado será distinto del que has indicado (500 g).");
    expect(container.textContent).not.toContain("confianza");

    const expected = macrosForQuantity(low, 200.6);
    expect(macroCells()[0]).toBe(String(expected.kcal));

    click(buttonByText("Registrar consumo"));
    const entry = lastEntry(holder);
    expect(entry.qty).toBe(200.6);
    expect(entry.quantityConfidence).toEqual({ level: "low" });
    expect({ kcal: entry.kcal, protein: entry.protein }).toEqual({ kcal: expected.kcal, protein: expected.protein });
  });
});

describe("ConsumeModal — validación: una declaración vacía o inválida no se envía, nunca se convierte en 0", () => {
  it("el botón está deshabilitado con el campo de gramos vacío", async () => {
    await mount((d) => { d.inventory = [item()]; }, item());
    click(checkboxByLabel("He pesado"));
    expect(buttonByText("Registrar consumo").disabled).toBe(true);
  });

  it("el botón está deshabilitado con 0 o un número negativo, y muestra un mensaje de error", async () => {
    await mount((d) => { d.inventory = [item()]; }, item());
    click(checkboxByLabel("He pesado"));
    const input = numberInputByLabel("Gramos pesados");

    setNativeValue(input, "0");
    expect(buttonByText("Registrar consumo").disabled).toBe(true);
    expect(container.textContent).toContain("Debe ser mayor que 0");

    setNativeValue(input, "-50");
    expect(buttonByText("Registrar consumo").disabled).toBe(true);
  });

  it("marcar y desmarcar la casilla limpia el campo de gramos (nunca se recuerda entre aperturas de este modo)", async () => {
    await mount((d) => { d.inventory = [item()]; }, item());
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), "200");
    click(checkboxByLabel("He pesado")); // desmarcar
    click(checkboxByLabel("He pesado")); // volver a marcar
    expect(numberInputByLabel("Gramos pesados").value).toBe("");
  });
});

describe("ConsumeModal — recorte real por stock: low, nunca high, aunque se registre igualmente", () => {
  it("declarar más de lo disponible registra lo que cabe, etiquetado low", async () => {
    const holder = await mount((d) => { d.inventory = [item({ qty: 100 })]; }, item({ qty: 100 })); // 100 g disponibles
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), "200");
    click(buttonByText("Registrar consumo"));

    const entry = lastEntry(holder);
    expect(entry.qty).toBe(100); // lo que cupo
    expect(entry.quantityConfidence).toEqual({ level: "low" });
  });
});

describe("ConsumeModal — la unidad real del item (draft) ya no coincide con la del momento de declarar: bloquea, conserva la declaración, permite reintentar", () => {
  // El modal recibe `item` como prop (el estado visible cuando se abrió) —
  // consumeInventoryItem SIEMPRE relee el item FRESCO del draft al escribir
  // (§20.3b). Sembrar el draft ya en "ud" mientras el prop sigue en "kg"
  // reproduce EXACTAMENTE esa discrepancia (misma causa real: otra pestaña/
  // acción cambió la unidad entre abrir el modal y confirmar) sin depender
  // de una mutación a mitad de test.
  it("bloquea sin escribir nada y conserva la declaración en el campo", async () => {
    const holder = await mount(
      (d) => { d.inventory = [item({ unit: "ud", qty: 5, unitSize: 60, unitSizeUnit: "g" })]; },
      item({ unit: "g", qty: 1000 }), // prop: lo que el modal "vio" al abrirse
    );
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), "200");

    click(buttonByText("Registrar consumo"));

    expect(holder.current!.state.foodLog).toHaveLength(0); // nada escrito
    expect(holder.current!.state.inventory[0].qty).toBe(5); // inventario intacto
    expect(container.textContent).toContain("La unidad de");
    expect(numberInputByLabel("Gramos pesados").value).toBe("200"); // la declaración se conserva
  });

  it("reintento tras corregir la unidad (modal reabierto con el item ya consistente) registra con normalidad", async () => {
    const holder = await mount(
      (d) => { d.inventory = [item({ unit: "g", qty: 1000 })]; },
      item({ unit: "g", qty: 1000 }), // ahora sí coincide — "se corrigió y se reabrió"
    );
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), "200");
    click(buttonByText("Registrar consumo"));

    expect(holder.current!.state.foodLog).toHaveLength(1);
    expect(lastEntry(holder).quantityConfidence).toEqual({ level: "high", declaredGrams: 200 });
  });
});

describe("ConsumeModal — protección contra doble registro (mismo patrón que CookModal)", () => {
  it("dos clics seguidos en 'Registrar consumo' producen como máximo UNA entrada", async () => {
    const holder = await mount((d) => { d.inventory = [item()]; }, item());
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), "200");
    const button = buttonByText("Registrar consumo");
    click(button);
    click(button); // el modal ya debería estar cerrándose, pero el guard protege aunque no lo estuviera

    const entries = holder.current!.state.foodLog.filter((e) => e.name === "Pechuga de pollo");
    expect(entries).toHaveLength(1);
  });
});

describe("ConsumeModal — recorrido estimado (slider/presets): sin cambios de comportamiento", () => {
  it("sigue registrando sin quantityConfidence cuando no se declara peso", async () => {
    const holder = await mount((d) => { d.inventory = [item()]; }, item());
    click(buttonByText("Registrar consumo"));
    const entry = lastEntry(holder);
    expect(entry.quantityConfidence).toBeUndefined();
  });
});
