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
import { FoodOSProvider, useFoodOS } from "@/lib/state";
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
    id: "inv-1", name: "Pechuga de pollo", qty: 1, unit: "kg", storage: "Nevera", expires: "2099-01-01", price: 4,
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

describe("ConsumeModal — modo «He pesado»: visible solo para g/kg, desmarcado al abrir", () => {
  it("la casilla aparece para un item en 'kg'", async () => {
    await mount((d) => { d.inventory = [item()]; }, item());
    expect(() => checkboxByLabel("He pesado")).not.toThrow();
  });

  it("la casilla NO aparece para un item en 'ud'", async () => {
    await mount((d) => { d.inventory = [item({ unit: "ud", qty: 5, unitSize: 60, unitSizeUnit: "g" })]; }, item({ unit: "ud", qty: 5 }));
    expect(() => checkboxByLabel("He pesado")).toThrow();
  });

  it("empieza desmarcada — el recorrido estimado (slider/presets) sigue visible por defecto", async () => {
    await mount((d) => { d.inventory = [item()]; }, item());
    expect(checkboxByLabel("He pesado").checked).toBe(false);
    expect(() => numberInputByLabel("Cantidad (kg)")).not.toThrow();
  });
});

describe("ConsumeModal — modo «He pesado»: 200 g desde 1 kg (ejemplo obligatorio de §20)", () => {
  it("registra con qty:0.2, unit:'kg', quantityConfidence high con declaredGrams:200", async () => {
    const holder = await mount((d) => { d.inventory = [item()]; }, item());
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), "200");
    click(buttonByText("Registrar consumo"));

    const entry = lastEntry(holder);
    expect(entry.qty).toBe(0.2);
    expect(entry.unit).toBe("kg");
    expect(entry.quantityConfidence).toEqual({ level: "high", declaredGrams: 200 });
    expect(holder.current!.state.inventory[0].qty).toBe(0.8);
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
    const holder = await mount((d) => { d.inventory = [item({ qty: 0.1 })]; }, item({ qty: 0.1 })); // 100 g disponibles
    click(checkboxByLabel("He pesado"));
    setNativeValue(numberInputByLabel("Gramos pesados"), "200");
    click(buttonByText("Registrar consumo"));

    const entry = lastEntry(holder);
    expect(entry.qty).toBe(0.1); // lo que cupo
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
      item({ unit: "kg", qty: 1 }), // prop: lo que el modal "vio" al abrirse
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
      (d) => { d.inventory = [item({ unit: "kg", qty: 1 })]; },
      item({ unit: "kg", qty: 1 }), // ahora sí coincide — "se corrigió y se reabrió"
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
