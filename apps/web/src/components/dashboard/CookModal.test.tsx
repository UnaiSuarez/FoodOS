// @vitest-environment jsdom
//
// Entrega «acciones claras»: CookModal con el FoodOSProvider REAL. Comprueba
// que el diálogo dice, antes de confirmar, qué se registrará (raciones, kcal,
// fecha y tipo de comida reales), y que registro, inventario y avisos
// coinciden con la opción y el camino elegidos — incluida la falta de stock.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InventoryItem, Recipe } from "@foodos/types";
import { FoodOSProvider, getToday, useFoodOS, useFoodOSUI } from "@/lib/state";
import { CookModal } from "./CookModal";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useFoodOS> & { toast: ReturnType<typeof useFoodOSUI>["toast"]; mascotMessage: ReturnType<typeof useFoodOSUI>["mascotMessage"] };
let container: HTMLDivElement;
let root: Root | null = null;

const RECIPE: Recipe = {
  id: "r-cook-1", title: "Guiso de prueba",
  ingredients: [
    { name: "Pollo", quantity: 200, unit: "g" },
    { name: "Arroz", quantity: 80, unit: "g" },
  ],
  kcal: 600, protein: 40, carbs: 60, fat: 15, cost: 3, image: "", time: 20, servings: 1,
  difficulty: "fácil", tags: [], steps: [],
};

function lot(id: string, name: string, qty: number): InventoryItem {
  return { id, name, qty, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 2, kcal: 150, protein: 20 };
}

function makeCapture() {
  const holder: { current: Ctx | null } = { current: null };
  function Capture() {
    const ctx = useFoodOS();
    const ui = useFoodOSUI();
    holder.current = { ...ctx, toast: ui.toast, mascotMessage: ui.mascotMessage };
    return null;
  }
  return { Capture, holder };
}

async function mount(seed: (d: Ctx["state"]) => void, props: Partial<React.ComponentProps<typeof CookModal>> = {}) {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => { holder.current!.mutate((d) => seed(d)); });
  await act(async () => {
    root!.render(
      <FoodOSProvider>
        <Capture />
        <CookModal recipe={RECIPE} onClose={() => {}} {...props} />
      </FoodOSProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return holder;
}

const text = () => container.querySelector(".cook-log-summary")?.textContent ?? "";
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

function buttonStarting(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`No hay botón que empiece por «${label}»`);
  return found as HTMLButtonElement;
}

function setServings(target: number) {
  const plus = container.querySelector('button[aria-label="Más raciones"]')!;
  const minus = container.querySelector('button[aria-label="Menos raciones"]')!;
  let current = Number(container.querySelector(".servings-val")!.textContent);
  while (current < target) { click(plus); current += 0.5; }
  while (current > target) { click(minus); current -= 0.5; }
}

function invQty(holder: { current: Ctx | null }, id: string): number | undefined {
  return holder.current!.state.inventory.find((i) => i.id === id)?.qty;
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

describe("CookModal — dice qué se registrará antes de confirmar", () => {
  it("muestra raciones, kcal, fecha y tipo de comida REALES recibidos del Planificador", async () => {
    await mount((d) => { d.foodLog = []; d.inventory = []; }, { logDate: "2026-10-16", mealType: "dinner" });
    const summary = text();
    expect(summary).toContain("se registrará en tu diario personal");
    expect(summary).toContain("1 ración · 600 kcal · 40 g de proteína");
    expect(summary).toMatch(/viernes.*16.*octubre/i);
    expect(summary).toContain("Cena");
    expect(summary).not.toContain("según la hora actual");
    expect(summary).not.toMatch(/hoy · Comida/);
  });

  it("sin fecha ni tipo: hoy, y avisa de que el tipo sale de la hora", async () => {
    await mount((d) => { d.foodLog = []; d.inventory = []; });
    expect(text()).toContain("hoy");
    expect(text()).toContain("(según la hora actual)");
  });

  it("el título y el botón dicen «registrar», y no aparece «Objetivos actualizados»", async () => {
    const holder = await mount((d) => { d.foodLog = []; d.inventory = []; });
    expect(container.textContent).toContain("Cocinar y registrar");
    expect(buttonStarting("Cocinar y registrar 1 ración")).toBeTruthy();
    click(buttonStarting("Cocinar y registrar"));
    expect(holder.current!.mascotMessage ?? "").not.toContain("Objetivos actualizados");
  });
});

describe("CookModal — varias raciones y descuento activado", () => {
  it("3 raciones: el resumen y el registro usan las 3; se descuenta ×3 y el aviso lo dice", async () => {
    const holder = await mount((d) => {
      d.foodLog = [];
      d.inventory = [lot("l-pollo", "Pollo", 1000), lot("l-arroz", "Arroz", 1000)];
    });
    setServings(3);
    expect(text()).toContain("3 raciones · 1800 kcal");
    expect(text()).toContain("se descontarán los ingredientes");

    click(buttonStarting("Cocinar y registrar 3 raciones"));

    const log = holder.current!.state.foodLog;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kcal: 1800, protein: 120, source: "recipe", date: getToday(holder.current!.state) });
    expect(log[0].name).toContain("×3");
    expect(invQty(holder, "l-pollo")).toBe(400); // 1000 − 200·3
    expect(invQty(holder, "l-arroz")).toBe(760); // 1000 − 80·3
    const toast = holder.current!.toast!.message;
    expect(toast).toContain("3 raciones registradas en tu diario");
    expect(toast).toContain("ingredientes descontados");
  });

  it("con fecha y tipo del Planificador, la entrada se escribe en ESA fecha y tipo", async () => {
    const holder = await mount((d) => { d.foodLog = []; d.inventory = []; }, { logDate: "2026-10-16", mealType: "dinner" });
    click(buttonStarting("Cocinar y registrar"));
    expect(holder.current!.state.foodLog[0]).toMatchObject({ date: "2026-10-16", mealType: "dinner" });
  });
});

describe("CookModal — descuento desactivado", () => {
  it("registra en el diario pero no toca el inventario, y el aviso no habla de descuento", async () => {
    const holder = await mount((d) => {
      d.foodLog = [];
      d.inventory = [lot("l-pollo", "Pollo", 1000), lot("l-arroz", "Arroz", 1000)];
    });
    const toggle = container.querySelector(".cook-deduct-toggle input") as HTMLInputElement;
    click(toggle);
    expect(toggle.checked).toBe(false);
    expect(text()).toContain("no se modificará");

    click(buttonStarting("Cocinar y registrar 1 ración"));

    expect(holder.current!.state.foodLog).toHaveLength(1);
    expect(holder.current!.state.foodLog[0].consumedIngredients).toBeUndefined();
    expect(invQty(holder, "l-pollo")).toBe(1000);
    expect(invQty(holder, "l-arroz")).toBe(1000);
    const toast = holder.current!.toast!.message;
    expect(toast).toContain("1 ración registrada en tu diario");
    expect(toast).toContain("inventario sin cambios");
    expect(toast).not.toContain("descontados");
  });
});

describe("CookModal — ingredientes faltantes: nunca afirma que se descontó todo", () => {
  it("avisa antes de confirmar y, tras confirmar, dice que solo se descontó lo disponible", async () => {
    const holder = await mount((d) => {
      d.foodLog = [];
      d.inventory = [lot("l-pollo", "Pollo", 1000), lot("l-arroz", "Arroz", 30)]; // arroz: 30 g de 80 g
    });
    expect(text()).toContain("se descontará solo lo que tienes");
    expect(text()).toContain("1 ingrediente no llega");

    click(buttonStarting("Cocinar y registrar 1 ración"));

    // El registro se escribe igualmente; el descuento es parcial.
    expect(holder.current!.state.foodLog).toHaveLength(1);
    expect(invQty(holder, "l-pollo")).toBe(800);
    expect(invQty(holder, "l-arroz")).toBeUndefined(); // agotado: se retira del inventario
    const toast = holder.current!.toast!.message;
    expect(toast).toContain("descontado solo lo disponible (1 ingrediente sin stock suficiente)");
    expect(toast).not.toContain("ingredientes descontados");
  });

  it("con el descuento desactivado y faltantes, no menciona faltantes en el aviso: el inventario no se toca", async () => {
    const holder = await mount((d) => {
      d.foodLog = [];
      d.inventory = [lot("l-arroz", "Arroz", 30)];
    });
    click(container.querySelector(".cook-deduct-toggle input")!);
    click(buttonStarting("Cocinar y registrar"));
    expect(invQty(holder, "l-arroz")).toBe(30);
    expect(holder.current!.toast!.message).toContain("inventario sin cambios");
  });
});

describe("CookModal — protecciones existentes", () => {
  it("dos clics seguidos producen como máximo UNA entrada (IntentGuard)", async () => {
    const holder = await mount((d) => { d.foodLog = []; d.inventory = [lot("l-pollo", "Pollo", 1000)]; });
    const button = buttonStarting("Cocinar y registrar");
    click(button);
    click(button);
    expect(holder.current!.state.foodLog).toHaveLength(1);
    expect(invQty(holder, "l-pollo")).toBe(800); // descontado una sola vez
  });
});
