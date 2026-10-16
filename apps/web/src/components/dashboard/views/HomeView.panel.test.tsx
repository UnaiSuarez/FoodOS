// @vitest-environment jsdom
//
// Panel diario v2 — HomeView REAL montado sobre el FoodOSProvider real.
// Fija las reglas de producto de la entrega: lo planificado no cuenta como
// consumido, nada de «N de 5 comidas» ni horas inventadas, la barra de energía
// no oculta el exceso, y los hábitos (agua/pasos) siguen siendo accesibles.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FoodLogEntry, Recipe } from "@foodos/types";
import { FoodOSProvider, getToday, useFoodOS } from "@/lib/state";
import { HomeView } from "./HomeView";

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

async function mount(seed: (draft: Ctx["state"]) => void) {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => { holder.current!.mutate((draft) => seed(draft)); });
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /><HomeView goTo={() => {}} openRecipe={() => {}} /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  return holder;
}

function setNativeValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(el: Element) {
  act(() => { (el as HTMLElement).click(); });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = container.querySelector(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`No hay botón con aria-label «${label}»`);
  return found as HTMLButtonElement;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().includes(text));
  if (!found) throw new Error(`No hay botón con «${text}»`);
  return found as HTMLButtonElement;
}

const text = () => container.textContent ?? "";

const RECIPE: Recipe = {
  id: "r-home-1", title: "Guiso de prueba", ingredients: [],
  kcal: 420, protein: 30, carbs: 55, fat: 10, cost: 3, image: "", time: 20, servings: 1,
  difficulty: "fácil", tags: [], steps: [],
};

function logEntry(d: Ctx["state"], over: Partial<FoodLogEntry>): FoodLogEntry {
  return {
    id: crypto.randomUUID(), date: getToday(d), time: "08:10", name: "Avena", qty: null, unit: null,
    kcal: 300, protein: 20, carbs: 30, fat: 8, source: "manual", mealType: "breakfast",
    ...over,
  };
}

// Reloj fijo para TODO el archivo (mediodía): ninguna prueba depende de la hora
// real en la que se ejecuta la suite. Las que necesitan otra hora la cambian con
// `hourSpy.mockReturnValue(...)` antes de montar.
let hourSpy: MockInstance<() => number>;

beforeEach(() => {
  hourSpy = vi.spyOn(Date.prototype, "getHours").mockReturnValue(12);
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
  hourSpy.mockRestore(); // restaura Date.prototype.getHours: no afecta a otras pruebas
});

describe("Panel diario — día sin registros", () => {
  it("dice que no hay comidas registradas y muestra 0 kcal, sin recuentos «N de 5» ni horas", async () => {
    await mount((d) => { d.foodLog = []; });
    expect(text()).toContain("Sin comidas registradas hoy");
    expect(container.querySelector(".hv-hero-num")?.textContent).toBe("0");
    expect(text()).not.toMatch(/\d+ de \d+ comidas/);
    expect(text()).not.toMatch(/\bAhora\b\s*·/);
  });

  it("tiene los cuatro bloques: banda, plan, inventario y presupuesto, y la mascota", async () => {
    await mount((d) => { d.foodLog = []; });
    expect(container.querySelector('[data-tour="panel-macros"]')).not.toBeNull();
    expect(container.querySelector(".today-plan-panel")).not.toBeNull();
    expect(container.querySelector(".hv-watch")).not.toBeNull();
    expect(container.querySelector(".hv-budget")).not.toBeNull();
    expect(container.querySelector(".hv-pet")).not.toBeNull();
  });
});

describe("Panel diario — lo planificado no cuenta como consumido", () => {
  it("con un plato planificado y NADA registrado, el total sigue en 0 y el plan se muestra aparte", async () => {
    await mount((d) => {
      d.foodLog = [];
      d.customRecipes.push(structuredClone(RECIPE));
      d.mealPlan[getToday(d)] = { lunch: RECIPE.id };
    });
    expect(container.querySelector(".hv-hero-num")?.textContent).toBe("0");
    expect(text()).toContain("En tu plan de hoy");
    expect(text()).toContain("no cuenta como consumido");
    // El plan está en la línea temporal como «Planificado», nunca como registrado.
    const plan = container.querySelector(".hv-step.plan");
    expect(plan?.textContent).toContain("Guiso de prueba");
    expect(plan?.textContent).toContain("Planificado");
    expect(container.querySelector(".hv-step.reg")).toBeNull();
    // El plan no entra en la barra: ancho 0 %.
    expect((container.querySelector(".hv-meter-fill") as HTMLElement).style.width).toBe("0%");
  });

  it("registrado y planificado conviven: la cifra principal es solo lo registrado", async () => {
    await mount((d) => {
      d.foodLog = [];
      d.foodLog.push(logEntry(d, { name: "Avena", kcal: 500, protein: 25 }));
      d.customRecipes.push(structuredClone(RECIPE));
      d.mealPlan[getToday(d)] = { dinner: RECIPE.id };
    });
    expect(container.querySelector(".hv-hero-num")?.textContent).toBe("500");
    expect(container.querySelector(".hv-step.reg")?.textContent).toContain("08:10");
    expect(container.querySelector(".hv-step.plan")?.textContent).toContain("Cena");
    // La hora que se ve es la real del registro; la comida planificada no inventa ninguna.
    expect(container.querySelector(".hv-step.plan .hv-step-time")?.textContent).toBe("Cena");
  });

  it("el «Registrar» del plan dice, visible y en su nombre accesible, que NO descuenta inventario, y así es", async () => {
    const holder = await mount((d) => {
      d.foodLog = [];
      d.inventory = [{ id: "l-pollo", name: "Pollo", qty: 1000, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 2, kcal: 150, protein: 20 }];
      d.customRecipes.push({ ...structuredClone(RECIPE), ingredients: [{ name: "Pollo", quantity: 200, unit: "g" }] });
      d.mealPlan[getToday(d)] = { lunch: RECIPE.id };
    });
    expect(container.querySelector(".hv-foot")!.textContent).toContain("no descuenta ingredientes del inventario");
    const button = container.querySelector('button[title="Registrar en el diario"]') as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe(
      "Registrar «Guiso de prueba» en el diario. No descuenta ingredientes del inventario",
    );
    click(button);
    expect(holder.current!.state.foodLog).toHaveLength(1);
    expect(holder.current!.state.inventory[0].qty).toBe(1000); // efecto real: inventario intacto
  });

  it("«Cocinar y registrar» (sugerencias) lo dice en su texto y en su nombre accesible", async () => {
    // El panel «¿Qué como ahora?» lista recetas con el mismo botón.
    await mount((d) => { d.foodLog = []; });
    click(buttonByText("¿Qué como ahora?"));
    const cook = container.querySelector('.what-to-eat-actions button.good') as HTMLButtonElement;
    expect(cook.textContent).toBe("Cocinar y registrar");
    expect(cook.getAttribute("aria-label")).toContain("anota la ración en tu diario");
  });

  it("avisa si ya hay un registro con el mismo nombre que la comida planificada, sin tocar los totales", async () => {
    await mount((d) => {
      d.foodLog = [];
      d.foodLog.push(logEntry(d, { name: "Guiso de prueba", kcal: 420 }));
      d.customRecipes.push(structuredClone(RECIPE));
      d.mealPlan[getToday(d)] = { lunch: RECIPE.id };
    });
    expect(text()).toContain("Ya hay un registro con este nombre hoy");
    expect(buttonByText("Registrar otra vez")).toBeTruthy();
    expect(container.querySelector(".hv-hero-num")?.textContent).toBe("420");
  });
});

describe("Panel diario — exceso del objetivo", () => {
  it("muestra el exceso en kcal y en gramos, y la barra deja de ser proporcional al 100 %", async () => {
    const holder = await mount((d) => {
      d.foodLog = [];
      d.nutrition = { ...d.nutrition, kcal: 2000, protein: 100, carbs: 200, fat: 60 };
      d.foodLog.push(logEntry(d, { name: "Banquete", kcal: 2600, protein: 130, carbs: 260, fat: 80 }));
    });
    expect(holder.current!.state.nutrition.kcal).toBe(2000);
    expect(text()).toContain("+600 kcal sobre el objetivo");
    expect(text()).toContain("+30 g sobre el objetivo"); // proteína
    // Con exceso aparece la marca del objetivo y el relleno no oculta nada: 2000/2600.
    expect(container.querySelector(".hv-meter-goal")).not.toBeNull();
    const width = parseFloat((container.querySelector(".hv-meter-fill") as HTMLElement).style.width);
    expect(width).toBeGreaterThan(99);
    const goalLeft = parseFloat((container.querySelector(".hv-meter-goal") as HTMLElement).style.left);
    expect(goalLeft).toBeCloseTo((2000 / 2600) * 100, 1);
  });

  it("sin exceso no hay marca ni aviso", async () => {
    await mount((d) => {
      d.foodLog = [];
      d.nutrition = { ...d.nutrition, kcal: 2000 };
      d.foodLog.push(logEntry(d, { kcal: 500 }));
    });
    expect(container.querySelector(".hv-meter-goal")).toBeNull();
    expect(text()).not.toContain("sobre el objetivo");
  });
});

describe("Panel diario — hábitos accesibles", () => {
  it("los tres incrementos de agua están a mano y suman al registro de hoy", async () => {
    const holder = await mount((d) => { d.foodLog = []; d.waterLog = {}; });
    click(buttonByLabel("Añadir 250 ml de agua"));
    click(buttonByLabel("Añadir 500 ml de agua"));
    click(buttonByLabel("Añadir 750 ml de agua"));
    const today = getToday(holder.current!.state);
    expect(holder.current!.state.waterLog[today]).toBe(1500);
    expect(buttonByLabel("Quitar 250 ml de agua")).toBeTruthy();
  });

  it("los pasos se registran desde el propio panel", async () => {
    const holder = await mount((d) => { d.foodLog = []; d.stepsLog = {}; });
    const input = container.querySelector('input[aria-label="Pasos de hoy"]') as HTMLInputElement;
    setNativeValue(input, "4200");
    click(buttonByText("Guardar"));
    const today = getToday(holder.current!.state);
    expect(holder.current!.state.stepsLog[today]).toBe(4200);
  });
});

describe("Panel diario — Zana y acciones", () => {
  // `mascotInsight` (lógica de producto existente, sin cambios) depende de la
  // hora real: a partir de las 20:00 con >300 kcal pendientes cambia de mensaje.
  // El reloj se fija con un espía de `getHours` — sin temporizadores simulados,
  // que podrían interferir con la hidratación asíncrona del proveedor — y el
  // espía se restaura en el `afterEach` global de este archivo.
  const zanaSeed = (d: Ctx["state"]) => {
    d.foodLog = [];
    d.inventory = []; // sin caducidades urgentes, que tienen prioridad sobre ambos mensajes
    d.nutrition = { ...d.nutrition, kcal: 2200, protein: 150, carbs: 225, fat: 70 };
  };

  it("de día, con el diario vacío, Zana dice la proteína pendiente (mensaje diurno)", async () => {
    hourSpy.mockReturnValue(12);
    const holder = await mount(zanaSeed);
    const bubble = container.querySelector(".hv-bubble")!;
    expect(bubble.textContent).toContain("Zana");
    expect(bubble.textContent).toContain("Te faltan 150 g de proteína para cerrar el día.");
    expect(bubble.textContent).not.toMatch(/Son las \d+h/);
    expect(holder.current!.state.mascotId).toBeTruthy();
  });

  it("de noche (≥ 20:00) con kcal pendientes, Zana cambia al mensaje de cierre del día (mensaje nocturno)", async () => {
    hourSpy.mockReturnValue(21);
    await mount(zanaSeed);
    const bubble = container.querySelector(".hv-bubble")!;
    expect(bubble.textContent).toContain("Zana");
    expect(bubble.textContent).toContain("Son las 21h y faltan 2200 kcal");
    expect(bubble.textContent).not.toContain("Te faltan 150 g de proteína");
  });

  it("en el límite, a las 19:59 aún es el mensaje diurno y a las 20:00 el nocturno", async () => {
    hourSpy.mockReturnValue(19);
    await mount(zanaSeed);
    expect(container.querySelector(".hv-bubble")!.textContent).toContain("Te faltan 150 g de proteína");
    act(() => { root!.unmount(); });
    root = null;

    hourSpy.mockReturnValue(20);
    await mount(zanaSeed);
    expect(container.querySelector(".hv-bubble")!.textContent).toContain("Son las 20h y faltan 2200 kcal");
  });

  it("las cinco acciones frecuentes siguen presentes", async () => {
    await mount((d) => { d.foodLog = []; });
    for (const label of ["Registrar comida", "Añadir alimento", "Carrito", "Recetas", "¿Qué como ahora?"]) {
      expect(buttonByText(label)).toBeTruthy();
    }
  });
});
