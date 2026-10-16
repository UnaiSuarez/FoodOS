// @vitest-environment jsdom
//
// Planificador accesible: PlannerView con el FoodOSProvider REAL. Comprueba los efectos
// reales (plan, diario, inventario, gasto, carrito) y el foco, no solo textos.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InventoryItem, Recipe } from "@foodos/types";
import { FoodOSProvider, getToday, useFoodOS, useFoodOSUI } from "@/lib/state";
import { PlannerView, WEEK_MIN_WIDTH } from "./PlannerView";

vi.mock("@/lib/ai-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-config")>()),
  loadAIConfig: () => null,
}));
vi.mock("@/lib/food-lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/food-lookup")>()),
  searchOFFSuggestions: vi.fn(async () => []),
}));

// Simula el gate de hidratación cerrado con el contrato real de mutate():
// devuelve false y NO ejecuta el actualizador (ver state.tsx, mutationsBlocked).
const gate = vi.hoisted(() => ({ closed: false }));
vi.mock("@/lib/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state")>();
  return {
    ...actual,
    useFoodOS: () => {
      const ctx = actual.useFoodOS();
      return { ...ctx, mutate: (fn: Parameters<typeof ctx.mutate>[0]) => (gate.closed ? false : ctx.mutate(fn)) };
    },
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useFoodOS> & { toast: ReturnType<typeof useFoodOSUI>["toast"] };
let container: HTMLDivElement;
let root: Root | null = null;

// ─── Ancho útil simulado + ResizeObserver controlable ───────────────────────
let width = 0;
const observers: Array<() => void> = [];
const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
class FakeResizeObserver {
  cb: () => void;
  constructor(cb: () => void) { this.cb = cb; observers.push(cb); }
  observe() {}
  disconnect() { const i = observers.indexOf(this.cb); if (i >= 0) observers.splice(i, 1); }
}
function resizeTo(next: number) {
  width = next;
  act(() => { observers.slice().forEach((cb) => cb()); });
}

const RECIPE_A: Recipe = {
  id: "r-a", title: "Guiso planificado", ingredients: [{ name: "Pollo", quantity: 200, unit: "g" }],
  kcal: 600, protein: 40, carbs: 60, fat: 15, cost: 3, image: "/images/test.webp", time: 20, servings: 1,
  difficulty: "fácil", tags: [], steps: [],
};
const RECIPE_B: Recipe = { ...RECIPE_A, id: "r-b", title: "Ensalada templada de garbanzos, calabaza asada y vinagreta de mostaza antigua con semillas", kcal: 400, protein: 20, ingredients: [{ name: "Garbanzos", quantity: 100, unit: "g" }] };
const POLLO: InventoryItem = { id: "l-pollo", name: "Pollo", qty: 1000, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 2, kcal: 150, protein: 20 };

function seedBase(d: Ctx["state"]) {
  const today = getToday(d);
  d.foodLog = [];
  d.expenses = [];
  d.cart = [];
  d.inventory = [structuredClone(POLLO)];
  d.customRecipes = [structuredClone(RECIPE_A), structuredClone(RECIPE_B)];
  d.plannerQuickMeals = [{ id: "qm-1", name: "Bocata rápido", kcal: 350, protein: 20, carbs: 40, fat: 12, cost: 0 }];
  d.mealPlan = { [today]: { almuerzo: RECIPE_A.id, dinner: "qm-1" } };
}

function makeCapture() {
  const holder: { current: Ctx | null } = { current: null };
  function Capture() {
    const ctx = useFoodOS();
    const ui = useFoodOSUI();
    holder.current = { ...ctx, toast: ui.toast };
    return null;
  }
  return { Capture, holder };
}

async function mount(seed: (d: Ctx["state"]) => void = seedBase) {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => { holder.current!.mutate((d) => seed(d)); });
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /><PlannerView /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  return holder;
}

const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const all = (sel: string, scope: ParentNode = container) => Array.from(scope.querySelectorAll<HTMLElement>(sel));
const byLabel = (prefix: string, scope: ParentNode = container) => {
  const el = all("button", scope).find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").startsWith(prefix));
  if (!el) throw new Error(`No hay botón «${prefix}»`);
  return el;
};
const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const focusKey = () => (document.activeElement as HTMLElement | null)?.getAttribute("data-focus-key") ?? null;
const plan = (h: { current: Ctx | null }) => h.current!.state.mealPlan;
const todayOf = (h: { current: Ctx | null }) => getToday(h.current!.state);

function pressEsc() {
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
}
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  gate.closed = false;
  localStorage.clear();
  width = 0;
  observers.length = 0;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) { act(() => { root!.unmount(); }); root = null; }
  container.remove();
  localStorage.clear();
  if (realClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", realClientWidth);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
});

describe("Distribución según el ancho útil del propio planificador", () => {
  it("sin ancho suficiente: vista por día (selector + cinco franjas), sin cuadrícula semanal en el DOM", async () => {
    await mount();
    expect(container.querySelector(".pl-week")).toBeNull();
    expect(container.querySelector(".pl-day-strip")).not.toBeNull();
    expect(all(".pl-slot-item")).toHaveLength(5);
    expect(all(".pl-day-btn")).toHaveLength(7);
    expect(all(".pl-day-btn").filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
  });

  it("con ancho suficiente: semana completa (7 cabeceras × 5 franjas) y sin selector de día", async () => {
    width = WEEK_MIN_WIDTH;
    await mount();
    expect(container.querySelector(".pl-day-strip")).toBeNull();
    expect(all(".pl-head")).toHaveLength(7);
    expect(all(".pl-cellwrap")).toHaveLength(35);
  });

  it("justo por debajo del umbral sigue en vista por día", async () => {
    width = WEEK_MIN_WIDTH - 1;
    await mount();
    expect(container.querySelector(".pl-week")).toBeNull();
  });

  it("no deja controles duplicados: cada entrada tiene un único «Quitar» en el DOM en cualquier distribución", async () => {
    width = WEEK_MIN_WIDTH;
    const h = await mount((d) => { seedBase(d); const t = getToday(d); d.mealPlan[t] = { almuerzo: RECIPE_A.id, dinner: "qm-1", lunch: RECIPE_B.id }; });
    const weekRemoves = all('button[aria-label^="Quitar "]').length;
    expect(weekRemoves).toBe(3);
    resizeTo(500);
    expect(all('button[aria-label^="Quitar "]').length).toBe(3);
    expect(plan(h)[todayOf(h)]).toBeDefined();
  });
});

describe("Efectos de #152 conservados", () => {
  it("receta: «Cocinar y registrar» abre CookModal con fecha y MealType del hueco, sin escribir aún", async () => {
    const h = await mount();
    const btn = byLabel("Cocinar y registrar Guiso planificado");
    expect(btn.getAttribute("aria-label")).toContain("eliges si se descuentan ingredientes del inventario");
    click(btn);
    const d = dialog()!;
    expect(d.textContent).toContain("Cocinar y registrar: Guiso planificado");
    expect(d.querySelector(".cook-log-summary")!.textContent).toContain("hoy");
    expect(d.querySelector(".cook-log-summary")!.textContent).toContain("Snack"); // almuerzo → snack
    expect(h.current!.state.foodLog).toHaveLength(0);
  });

  it("receta: confirmar con descuento registra UNA entrada en la fecha/tipo del hueco y descuenta; devuelve el foco al hueco", async () => {
    const h = await mount();
    click(byLabel("Cocinar y registrar Guiso planificado"));
    click(all("button", dialog()!).find((b) => b.textContent!.startsWith("Cocinar y registrar 1 ración"))!);
    expect(dialog()).toBeNull();
    expect(h.current!.state.foodLog).toHaveLength(1);
    expect(h.current!.state.foodLog[0]).toMatchObject({ date: todayOf(h), mealType: "snack", kcal: 600 });
    expect(h.current!.state.inventory[0].qty).toBe(800);
    expect(focusKey()).toBe(`${todayOf(h)}:almuerzo:main`);
  });

  it("receta: cancelar el diálogo no registra nada y devuelve el foco al mismo botón", async () => {
    const h = await mount();
    click(byLabel("Cocinar y registrar Guiso planificado"));
    pressEsc();
    expect(dialog()).toBeNull();
    expect(h.current!.state.foodLog).toHaveLength(0);
    expect(focusKey()).toBe(`${todayOf(h)}:almuerzo:main`);
  });

  it("plato rápido: «Registrar» registra directamente (cena), una vez, sin tocar inventario ni gasto", async () => {
    const h = await mount();
    click(byLabel("Registrar Bocata rápido en el diario"));
    expect(h.current!.state.foodLog).toHaveLength(1);
    expect(h.current!.state.foodLog[0]).toMatchObject({ name: "Bocata rápido", mealType: "dinner", kcal: 350, date: todayOf(h) });
    expect(h.current!.state.inventory[0].qty).toBe(1000);
    expect(h.current!.state.expenses).toHaveLength(0);
    expect(h.current!.toast!.message).toBe('"Bocata rápido" registrado');
  });

  it("planificar (añadir, cambiar, quitar, colocar) nunca registra ingesta ni toca inventario/gasto", async () => {
    const h = await mount();
    click(byLabel("Añadir comida: Desayuno"));
    click(byLabel("Elegir Guiso planificado", dialog()!));
    click(byLabel("Cambiar Guiso planificado en Desayuno"));
    click(byLabel("Cambiar por esta Ensalada", dialog()!));
    click(byLabel("Quitar Ensalada"));
    expect(h.current!.state.foodLog).toHaveLength(0);
    expect(h.current!.state.expenses).toHaveLength(0);
    expect(h.current!.state.inventory[0].qty).toBe(1000);
  });

  it("la leyenda visible explica los dos efectos y que planificar no registra", async () => {
    await mount();
    const legend = container.querySelector(".pl-legend")!.textContent!;
    expect(legend).toContain("abre el diálogo donde eliges si se descuentan ingredientes del inventario");
    expect(legend).toContain("lo anota directamente en el diario");
    expect(legend).toContain("Planificar no registra nada");
  });
});

describe("Añadir / Cambiar / Quitar — solo el hueco elegido, con foco", () => {
  it("añadir una receta la coloca en la fecha y franja del hueco, y el foco queda en «Cambiar» de ese hueco", async () => {
    const h = await mount();
    const before = structuredClone(plan(h)[todayOf(h)]);
    click(byLabel("Añadir comida: Desayuno"));
    expect(dialog()!.textContent).toContain("Añadir: Desayuno");
    click(byLabel("Elegir Guiso planificado", dialog()!));
    expect(dialog()).toBeNull();
    expect(plan(h)[todayOf(h)]).toEqual({ ...before, breakfast: RECIPE_A.id });
    expect(focusKey()).toBe(`${todayOf(h)}:breakfast:edit`);
    expect(document.activeElement!.getAttribute("aria-label")).toContain("Cambiar Guiso planificado");
  });

  it("cancelar un reemplazo (botón o Esc) conserva la entrada anterior y devuelve el foco", async () => {
    const h = await mount();
    click(byLabel("Cambiar Guiso planificado"));
    expect(dialog()!.textContent).toContain("Solo se sustituye Guiso planificado");
    click(byLabel("Cancelar", dialog()!));
    expect(plan(h)[todayOf(h)].almuerzo).toBe(RECIPE_A.id);
    expect(focusKey()).toBe(`${todayOf(h)}:almuerzo:edit`);

    click(byLabel("Cambiar Guiso planificado"));
    pressEsc();
    expect(plan(h)[todayOf(h)].almuerzo).toBe(RECIPE_A.id);
    expect(focusKey()).toBe(`${todayOf(h)}:almuerzo:edit`);
  });

  it("cambiar sustituye SOLO ese hueco; el resto del plan queda igual", async () => {
    const h = await mount();
    click(byLabel("Cambiar Guiso planificado"));
    click(byLabel("Cambiar por esta Ensalada", dialog()!));
    expect(plan(h)[todayOf(h)]).toEqual({ almuerzo: RECIPE_B.id, dinner: "qm-1" });
    expect(h.current!.toast!.message).toContain("sustituye a Guiso planificado");
  });

  it("quitar elimina solo esa entrada y deja el foco en «Añadir» del mismo hueco", async () => {
    const h = await mount();
    click(byLabel("Quitar Guiso planificado"));
    expect(plan(h)[todayOf(h)]).toEqual({ dinner: "qm-1" });
    expect(focusKey()).toBe(`${todayOf(h)}:almuerzo:edit`);
    expect(document.activeElement!.getAttribute("aria-label")).toContain("Añadir comida: Almuerzo");
    expect(h.current!.state.foodLog).toHaveLength(0);
  });

  it("quitar y registrar son acciones hermanas: registrar no quita y quitar no registra", async () => {
    const h = await mount();
    click(byLabel("Registrar Bocata rápido"));
    expect(plan(h)[todayOf(h)].dinner).toBe("qm-1");
    click(byLabel("Quitar Bocata rápido"));
    expect(h.current!.state.foodLog).toHaveLength(1);
    for (const b of all("button")) expect(b.querySelector("button")).toBeNull();
  });

  it("buscar en el selector filtra por nombre y el nombre largo aparece completo", async () => {
    await mount();
    click(byLabel("Añadir comida: Desayuno"));
    const d = dialog()!;
    expect(d.textContent).toContain(RECIPE_B.title);
    type(d.querySelector('input[type="search"]') as HTMLInputElement, "guiso");
    expect(d.textContent).not.toContain("Ensalada templada");
    expect(d.textContent).toContain("Guiso planificado");
    expect(document.activeElement).toBe(d.querySelector('input[type="search"]'));
  });

  it("«Crear plato rápido…» reutiliza el modal real (campos y validación) y deja el plato en ese hueco", async () => {
    const h = await mount();
    click(byLabel("Añadir comida: Desayuno"));
    click(byLabel("Crear plato rápido…", dialog()!));
    const d = dialog()!;
    expect(d.textContent).toContain("Añadir plato al planificador");
    const confirm = all("button", d).find((b) => b.textContent!.includes("Añadir al planificador")) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // validación actual: sin nombre ni ingredientes no se confirma
    type(d.querySelector('input[aria-label="Nombre del plato"]') as HTMLInputElement, "Tostada (prueba)");
    click(confirm);
    expect(dialog()).toBeNull();
    const id = plan(h)[todayOf(h)].breakfast!;
    expect(h.current!.state.plannerQuickMeals!.find((q) => q.id === id)!.name).toBe("Tostada (prueba)");
    expect(focusKey()).toBe(`${todayOf(h)}:breakfast:edit`);
  });
});

describe("Colocar desde la biblioteca (alternativa a arrastrar)", () => {
  it("elige día y franja, avisa de qué reemplazará, y coloca solo ahí", async () => {
    const h = await mount();
    click(byLabel("Colocar Ensalada"));
    const d = dialog()!;
    const slot = d.querySelector("#pl-place-slot") as HTMLSelectElement;
    expect(d.textContent).toContain("Esa franja está libre"); // desayuno libre
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(slot, "almuerzo");
      slot.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(d.textContent).toContain("Reemplazará solo Guiso planificado");
    click(byLabel("Colocar", d));
    expect(plan(h)[todayOf(h)]).toEqual({ almuerzo: RECIPE_B.id, dinner: "qm-1" });
    expect(focusKey()).toBe(`${todayOf(h)}:almuerzo:edit`);
  });

  it("cancelar conserva el plan y devuelve el foco al botón «Colocar» de esa receta", async () => {
    const h = await mount();
    const before = structuredClone(plan(h));
    click(byLabel("Colocar Guiso"));
    click(byLabel("Cancelar", dialog()!));
    expect(plan(h)).toEqual(before);
    expect(focusKey()).toBe(`lib:${RECIPE_A.id}`);
  });
});

describe("Navegación de semana y día", () => {
  it("elegir día cambia la lista y el estado pulsado; el foco se queda en el botón de día", async () => {
    await mount();
    const buttons = all(".pl-day-btn");
    const todayIdx = buttons.findIndex((b) => b.hasAttribute("aria-current"));
    const other = buttons[(todayIdx + 1) % 7];
    other.focus();
    click(other);
    expect(other.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(other);
    expect(all(".pl-day-btn").filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
  });

  it("semana siguiente conserva la posición del día y no pierde el plan; «Hoy» vuelve", async () => {
    const h = await mount();
    const rangeBefore = container.querySelector(".pl-week-range")!.textContent;
    const headingBefore = container.querySelector(".pl-day-heading")!.textContent!.replace("Hoy", "").trim();
    const weekdayBefore = headingBefore.split(",")[0];
    const planBefore = structuredClone(plan(h));
    click(byLabel("Semana siguiente"));
    expect(container.querySelector(".pl-week-range")!.textContent).not.toBe(rangeBefore);
    expect(container.querySelector(".pl-day-heading")!.textContent!.split(",")[0]).toBe(weekdayBefore);
    expect(plan(h)).toEqual(planBefore);
    click(byLabel("Hoy"));
    expect(container.querySelector(".pl-week-range")!.textContent).toBe(rangeBefore);
    expect(container.querySelector(".pl-day-heading .pl-today-pill")).not.toBeNull();
  });

  it("«Comprar semana» usa las fechas de la semana MOSTRADA", async () => {
    const h = await mount((d) => {
      seedBase(d);
      d.inventory = [];
      const t = new Date(`${getToday(d)}T12:00:00`);
      t.setDate(t.getDate() + 7);
      const next = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      d.mealPlan = { [next]: { lunch: RECIPE_A.id } };
    });
    click(byLabel("🛒 Comprar semana")); // semana actual: nada planificado
    expect(h.current!.state.cart).toHaveLength(0);
    click(byLabel("Semana siguiente"));
    click(byLabel("🛒 Comprar semana"));
    expect(h.current!.state.cart.map((c) => c.name)).toContain("pollo");
  });
});

describe("Totales planificados", () => {
  it("dicen «planificado», y el objetivo solo se muestra para la fecha que lo tiene registrado", async () => {
    const h = await mount((d) => {
      seedBase(d);
      const today = getToday(d);
      d.nutritionGoalsHistory = { [today]: { kcal: 2200, protein: 150, carbs: 250, fat: 70, mode: "maintain", calculationVersion: "t", recordedAt: "2026-01-01T00:00:00Z" } } as never;
    });
    const chips = container.querySelector(".pl-chips")!.textContent!;
    expect(chips).toContain("kcal planificadas");
    expect(chips).toContain("proteína planificada");
    const total = container.querySelector(".pl-day-total")!.textContent!;
    expect(total).toContain("Total planificado");
    expect(total).toContain("de 2200 kcal"); // hoy sí tiene objetivo registrado
    expect(total).toContain("de 150 g de proteína");

    // Otro día con plan pero sin objetivo registrado: total SIN denominador (no se copia el de hoy).
    const next = all(".pl-day-btn").find((b) => b.getAttribute("aria-pressed") === "false")!;
    act(() => {
      h.current!.mutate((d) => { d.mealPlan = { ...d.mealPlan }; });
    });
    click(next);
    expect(container.querySelector(".pl-day-total")!.textContent).not.toContain(" de 2200");
  });
});

describe("Cambio de distribución con un modal abierto", () => {
  it("al cerrar tras pasar de semana a día, el foco vuelve a un control visible del hueco correcto", async () => {
    width = WEEK_MIN_WIDTH + 200;
    const h = await mount();
    const todayNum = Number(todayOf(h).slice(8));
    click(all("button").find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Añadir comida: Desayuno") && b.getAttribute("aria-label")!.endsWith(` ${todayNum}`))!);
    expect(dialog()).not.toBeNull();
    resizeTo(600); // la distribución cambia con el modal abierto
    expect(container.querySelector(".pl-week")).toBeNull();
    click(byLabel("Elegir Guiso planificado", dialog()!));
    expect(plan(h)[todayOf(h)].breakfast).toBe(RECIPE_A.id);
    expect(focusKey()).toBe(`${todayOf(h)}:breakfast:edit`);
    expect(document.activeElement!.isConnected).toBe(true);
  });
});

// ─── P1: planificar con «Crear plato rápido» no consume inventario ──────────
function pickSuggestion(name: string) {
  const input = document.body.querySelector('input[aria-label="Añadir ingrediente"]') as HTMLInputElement;
  type(input, name);
  const option = document.body.querySelector('[role="option"]') as HTMLElement;
  act(() => { option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
}
const confirmQuick = () => all("button", dialog()!).find((b) => b.textContent!.includes("Añadir al planificador")) as HTMLButtonElement;
const openQuick = (label: string) => { click(byLabel(label)); click(byLabel(label.startsWith("Cambiar") ? "Sustituir por un plato rápido…" : "Crear plato rápido…", dialog()!)); };

describe("Crear plato rápido: edita el plan sin tocar inventario, diario ni gasto", () => {
  it("con un ingrediente del inventario: stock, diario y gasto intactos; solo cambia el hueco elegido; ya no existe la opción de descontar", async () => {
    const h = await mount();
    const planBefore = structuredClone(plan(h)[todayOf(h)]);
    openQuick("Añadir comida: Desayuno");
    expect(dialog()!.textContent).not.toContain("Descontar del inventario");
    expect(dialog()!.textContent).toContain("Planificar no descuenta ingredientes del inventario");
    type(dialog()!.querySelector('input[aria-label="Nombre del plato"]') as HTMLInputElement, "Comida futura");
    pickSuggestion("Pollo");
    expect(dialog()!.textContent).toContain("150 kcal"); // 100 g de Pollo (150 kcal/100 g): macros conservados
    click(confirmQuick());

    expect(dialog()).toBeNull();
    expect(h.current!.state.inventory[0].qty).toBe(1000);
    expect(h.current!.state.foodLog).toHaveLength(0);
    expect(h.current!.state.expenses).toHaveLength(0);
    const day = plan(h)[todayOf(h)];
    expect(Object.keys(day).sort()).toEqual([...Object.keys(planBefore), "breakfast"].sort());
    const created = h.current!.state.plannerQuickMeals!.find((q) => q.id === day.breakfast)!;
    expect(created).toMatchObject({ name: "Comida futura", kcal: 150, protein: 20 });
    expect(day.almuerzo).toBe(planBefore.almuerzo);
    expect(day.dinner).toBe(planBefore.dinner);
  });

  it("«Guardar como receta» sigue funcionando y tampoco descuenta", async () => {
    const h = await mount();
    openQuick("Añadir comida: Desayuno");
    type(dialog()!.querySelector('input[aria-label="Nombre del plato"]') as HTMLInputElement, "Plato guardado");
    pickSuggestion("Pollo");
    click(dialog()!.querySelector('.lm-dish-options input[type="checkbox"]')!);
    click(confirmQuick());
    expect(h.current!.state.customRecipes.some((r) => r.title === "Plato guardado")).toBe(true);
    expect(h.current!.state.inventory[0].qty).toBe(1000);
    expect(h.current!.state.foodLog).toHaveLength(0);
  });

  it("sustituir un plato rápido y confirmar: cambia solo ese hueco y poda el huérfano", async () => {
    const h = await mount();
    openQuick("Cambiar Bocata rápido");
    type(dialog()!.querySelector('input[aria-label="Nombre del plato"]') as HTMLInputElement, "Nuevo plato");
    click(confirmQuick());
    const day = plan(h)[todayOf(h)];
    expect(day.almuerzo).toBe(RECIPE_A.id);
    expect(day.dinner).not.toBe("qm-1");
    const quicks = h.current!.state.plannerQuickMeals!;
    expect(quicks.map((q) => q.name)).toEqual(["Nuevo plato"]); // qm-1 ya no lo referencia nadie → podado
    expect(h.current!.state.inventory[0].qty).toBe(1000);
  });

  it("NO elimina un plato rápido que aún está referenciado en otro hueco", async () => {
    const h = await mount((d) => {
      seedBase(d);
      const t = getToday(d);
      d.mealPlan[t] = { almuerzo: RECIPE_A.id, dinner: "qm-1", merienda: "qm-1" }; // qm-1 en DOS huecos
    });
    openQuick("Cambiar Bocata rápido en Cena");
    type(dialog()!.querySelector('input[aria-label="Nombre del plato"]') as HTMLInputElement, "Otro");
    click(confirmQuick());
    const day = plan(h)[todayOf(h)];
    expect(day.merienda).toBe("qm-1");
    expect(h.current!.state.plannerQuickMeals!.map((q) => q.id)).toContain("qm-1");
    expect(h.current!.state.plannerQuickMeals!.some((q) => q.name === "Otro")).toBe(true);
  });

  it("cancelar el reemplazo (botón o Esc) conserva la entrada anterior y no crea el plato", async () => {
    const h = await mount();
    const quicksBefore = structuredClone(h.current!.state.plannerQuickMeals);
    openQuick("Cambiar Bocata rápido");
    type(dialog()!.querySelector('input[aria-label="Nombre del plato"]') as HTMLInputElement, "No debe guardarse");
    click(byLabel("Cancelar", dialog()!));
    expect(plan(h)[todayOf(h)].dinner).toBe("qm-1");
    expect(h.current!.state.plannerQuickMeals).toEqual(quicksBefore);
    openQuick("Cambiar Bocata rápido");
    pressEsc();
    expect(plan(h)[todayOf(h)].dinner).toBe("qm-1");
    expect(h.current!.state.inventory[0].qty).toBe(1000);
  });

  it("mutación bloqueada: sin cambios, sin aviso de éxito y sin cerrar; el reintento válido funciona", async () => {
    const h = await mount();
    openQuick("Añadir comida: Desayuno");
    type(dialog()!.querySelector('input[aria-label="Nombre del plato"]') as HTMLInputElement, "Plato bloqueado");
    gate.closed = true;
    click(confirmQuick());
    expect(dialog()).not.toBeNull();
    expect(plan(h)[todayOf(h)].breakfast).toBeUndefined();
    expect(h.current!.state.plannerQuickMeals).toHaveLength(1);
    expect(h.current!.toast?.message ?? "").not.toContain("añadido al planificador");
    gate.closed = false;
    click(confirmQuick());
    expect(dialog()).toBeNull();
    expect(plan(h)[todayOf(h)].breakfast).toBeDefined();
    expect(h.current!.toast!.message).toContain("añadido al planificador");
  });
});

// ─── P2: foco al cambiar de distribución desde un día distinto de hoy ───────
const WIDE = WEEK_MIN_WIDTH + 200;
const NARROW = 600;
const addBtnFor = (slot: string, notDay: string) =>
  all("button").find((b) => { const l = b.getAttribute("aria-label") ?? ""; return l.startsWith(`Añadir comida: ${slot}`) && !l.endsWith(` ${notDay}`); })!;
const dayNum = (key: string) => String(Number(key.slice(8)));
const selectedDayLabel = () => all(".pl-day-btn").find((b) => b.getAttribute("aria-pressed") === "true")?.getAttribute("aria-label") ?? "";
const changedKey = (h: { current: Ctx | null }) => Object.keys(plan(h)).find((k) => plan(h)[k].breakfast);

describe("Foco al cambiar de distribución desde un día distinto de hoy", () => {
  it("semana → día: elegir coloca en la fecha correcta, muestra ESE día y deja el foco en «Cambiar» del hueco", async () => {
    width = WIDE;
    const h = await mount();
    const btn = addBtnFor("Desayuno", dayNum(todayOf(h)));
    const dk = (() => { const n = btn.getAttribute("aria-label")!.split(" ").pop()!; return Object.keys({ [todayOf(h)]: 1 })[0].slice(0, 8) + n.padStart(2, "0"); })();
    click(btn);
    resizeTo(NARROW);
    click(byLabel("Elegir Ensalada", dialog()!)); // nombre largo
    expect(changedKey(h)).toBeDefined();
    const key = changedKey(h)!;
    expect(key.endsWith(String(dk.slice(8)))).toBe(true);
    expect(selectedDayLabel()).toContain(` ${dayNum(key)} de `); // el día destino pasa a ser visible
    expect(focusKey()).toBe(`${key}:breakfast:edit`);
    expect(document.activeElement!.getAttribute("aria-label")).toContain("Cambiar Ensalada");
    expect(document.activeElement!.hasAttribute("data-focus-fallback")).toBe(false);
  });

  it("semana → día: cancelar y Escape devuelven el foco a «Añadir» de ese hueco (día visible)", async () => {
    for (const how of ["cancelar", "esc"] as const) {
      width = WIDE;
      const h = await mount();
      const btn = addBtnFor("Desayuno", dayNum(todayOf(h)));
      const num = btn.getAttribute("aria-label")!.split(" ").pop()!;
      click(btn);
      resizeTo(NARROW);
      if (how === "cancelar") click(byLabel("Cancelar", dialog()!)); else pressEsc();
      expect(dialog()).toBeNull();
      expect(selectedDayLabel()).toContain(` ${num} de `);
      expect(document.activeElement!.getAttribute("aria-label")).toBe(btn.getAttribute("aria-label"));
      act(() => { root!.unmount(); }); root = null; container.replaceChildren();
    }
  });

  it("día → semana: el foco acaba en el hueco correcto de la semana", async () => {
    width = NARROW;
    const h = await mount();
    const other = all(".pl-day-btn").find((b) => b.getAttribute("aria-pressed") === "false")!;
    const num = other.getAttribute("aria-label")!.match(/ (\d+) de /)![1];
    click(other);
    click(all("button").find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Añadir comida: Desayuno"))!);
    resizeTo(WIDE);
    expect(container.querySelector(".pl-week")).not.toBeNull();
    click(byLabel("Elegir Guiso", dialog()!));
    const key = changedKey(h)!;
    expect(dayNum(key)).toBe(num);
    expect(focusKey()).toBe(`${key}:breakfast:edit`);
    expect(document.activeElement!.isConnected).toBe(true);
  });

  it("Colocar desde la biblioteca: cancelar tras cambiar de distribución conserva el retorno al botón de origen", async () => {
    width = WIDE;
    const h = await mount();
    const before = structuredClone(plan(h));
    click(byLabel("Colocar Ensalada"));
    resizeTo(NARROW);
    click(byLabel("Cancelar", dialog()!));
    expect(plan(h)).toEqual(before);
    expect(focusKey()).toBe(`lib:${RECIPE_B.id}`);
  });

  it("Colocar a otro día en vista por día muestra ese día y enfoca su «Cambiar»", async () => {
    width = NARROW;
    const h = await mount();
    click(byLabel("Colocar Ensalada"));
    const daySel = dialog()!.querySelector("#pl-place-day") as HTMLSelectElement;
    const target = Array.from(daySel.options).find((o) => o.value !== todayOf(h))!.value;
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(daySel, target);
      daySel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click(byLabel("Colocar", dialog()!));
    expect(plan(h)[target].almuerzo ?? plan(h)[target].breakfast).toBe(RECIPE_B.id);
    expect(selectedDayLabel()).toContain(` ${dayNum(target)} de `);
    expect(focusKey()).toBe(`${target}:breakfast:edit`);
  });
});