// @vitest-environment jsdom
//
// Entrega «acciones claras»: Carrito, Planificador e Inventario (ARIA) con el
// FoodOSProvider REAL. Comprueba textos y también los efectos reales de cada
// acción (registro, inventario y gasto según el camino).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FoodOSProvider, allRecipes, defaultState, useFoodOS, useFoodOSUI } from "@/lib/state";
import { CartView } from "./CartView";
import { InventoryView } from "./InventoryView";

vi.mock("@/lib/ai-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-config")>()),
  loadAIConfig: () => null,
}));
vi.mock("@/lib/food-lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/food-lookup")>()),
  searchOFFSuggestions: vi.fn(async () => []),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useFoodOS> & { toast: ReturnType<typeof useFoodOSUI>["toast"] };
let container: HTMLDivElement;
let root: Root | null = null;

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

async function mount(seed: (d: Ctx["state"]) => void, ui: React.ReactNode) {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => { holder.current!.mutate((d) => seed(d)); });
  await act(async () => {
    root!.render(<FoodOSProvider><Capture />{ui}</FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  return holder;
}

const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim().includes(text));
  if (!found) throw new Error(`No hay botón con «${text}»`);
  return found as HTMLButtonElement;
}

const PROFILE = {
  age: 30, sex: "male", heightCm: 178, weightKg: 78, bodyFatPct: null,
  activityLevel: "moderate", goal: "maintain", gymDays: [1, 3, 5], allergies: [], excludedFoods: [],
} as unknown as Ctx["state"]["profile"];

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
  document.body.querySelectorAll('[role="dialog"]').forEach((d) => d.remove());
  localStorage.clear();
});

describe("Carrito — «Plan sugerido» y estados que hablan solo de él", () => {
  it("la pestaña se llama «Plan sugerido» y la explicación es visible al seleccionarla", async () => {
    await mount((d) => { d.cart = []; d.profile = null; }, <CartView />);
    expect(container.textContent).not.toContain("Del plan semanal");
    expect(container.textContent).not.toContain("Generado automáticamente"); // pestaña «Stock bajo» activa

    click(buttonByText("Plan sugerido", container.querySelector(".suggest-tabs")!));
    expect(container.querySelector(".suggest-note")!.textContent).toBe(
      "Generado automáticamente; no corresponde a las comidas que has colocado en el Planificador.",
    );
  });

  it("sin perfil, el estado vacío se refiere al plan sugerido", async () => {
    await mount((d) => { d.cart = []; d.profile = null; }, <CartView />);
    click(buttonByText("Plan sugerido", container.querySelector(".suggest-tabs")!));
    expect(container.querySelector(".suggest-empty")!.textContent).toBe(
      "Configura tu perfil físico para generar el plan sugerido.",
    );
  });

  it("con todo cubierto, «todo cubierto» se refiere al plan sugerido, no al Planificador", async () => {
    await mount((d) => {
      d.cart = [];
      d.profile = PROFILE;
      // Stock enorme de cada ingrediente de cada receta: el plan sugerido no necesita comprar nada.
      const seen = new Set<string>();
      d.inventory = [];
      for (const recipe of allRecipes(structuredClone(defaultState))) {
        for (const ing of recipe.ingredients) {
          if (seen.has(ing.name.toLowerCase())) continue;
          seen.add(ing.name.toLowerCase());
          d.inventory.push({
            id: `big-${seen.size}`, name: ing.name, qty: 100000, unit: ing.unit, unitSize: ing.unitSize, unitSizeUnit: ing.unitSizeUnit,
            storage: "Despensa", expires: "2099-01-01", price: 1, kcal: 100, protein: 5,
          });
        }
      }
    }, <CartView />);
    click(buttonByText("Plan sugerido", container.querySelector(".suggest-tabs")!));
    expect(container.querySelector(".suggest-empty")!.textContent).toBe(
      "Para el plan sugerido no falta ningún ingrediente: todo está en tu despensa ✓",
    );
    expect(container.textContent).not.toContain("ingredientes del plan están en tu despensa");
  });

  it("el contador de la cabecera también dice «plan sugerido»", async () => {
    await mount((d) => { d.cart = []; d.profile = null; }, <CartView />);
    expect(container.querySelector(".suggest-counts")!.textContent).toContain("del plan sugerido");
  });
});

describe("Carrito — «Completar compra» primaria y «Mover a despensa» secundaria, con su efecto real", () => {
  const seedChecked = (d: Ctx["state"]) => {
    d.profile = null;
    d.inventory = [];
    d.expenses = [];
    d.cart = [{ id: "c-1", name: "Avena", qty: 500, unit: "g", price: 1.9, store: "Mercadona", checked: true }];
  };

  it("«Completar compra» es la primera acción y la primaria; la ayuda es visible y está enlazada", async () => {
    await mount(seedChecked, <CartView />);
    const actions = container.querySelector(".panel-actions")!;
    const first = actions.querySelector("button")!;
    expect(first.textContent).toBe("Completar compra");
    expect(first.classList.contains("primary-button")).toBe(true);

    const move = buttonByText("Mover a despensa");
    expect(move.classList.contains("secondary-button")).toBe(true);
    const hint = container.querySelector(`#${move.getAttribute("aria-describedby")}`)!;
    expect(hint.textContent).toContain("sin registrar gasto");
    expect(hint.textContent).toContain("caducidades predeterminadas");
    expect(hint.textContent).toContain("registra el gasto");
  });

  it("«Mover a despensa» pasa al inventario SIN registrar gasto y lo dice", async () => {
    const holder = await mount(seedChecked, <CartView />);
    click(buttonByText("Mover a despensa"));
    expect(holder.current!.state.inventory.map((i) => i.name)).toContain("Avena");
    expect(holder.current!.state.expenses).toHaveLength(0);
    expect(holder.current!.state.cart).toHaveLength(0);
    expect(holder.current!.toast!.message).toBe("1 producto movido a despensa (sin registrar gasto)");
  });

  it("«Completar compra» (tras el repaso) registra el gasto y da de alta el producto", async () => {
    const holder = await mount(seedChecked, <CartView />);
    click(buttonByText("Completar compra"));
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    click(buttonByText("Confirmar compra", dialog));
    expect(holder.current!.state.expenses).toHaveLength(1);
    expect(holder.current!.state.expenses[0]).toMatchObject({ category: "Comida", type: "expense" });
    expect(holder.current!.state.inventory.map((i) => i.name)).toContain("Avena");
    expect(holder.current!.toast!.message).toBe("Compra completada");
  });
});

describe("Inventario — grupos etiquetados en lugar de tablist (ARIA)", () => {
  it("no queda ningún role=tablist y los filtros son grupos con nombre y aria-pressed", async () => {
    await mount((d) => { d.inventory = []; }, <InventoryView />);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="tab"]')).toBeNull();

    const groups = Array.from(container.querySelectorAll('[role="group"]'));
    const store = groups.find((g) => g.getAttribute("aria-label") === "Filtro de almacén")!;
    const quick = groups.find((g) => g.getAttribute("aria-label") === "Filtro rápido")!;
    expect(store).toBeTruthy();
    expect(quick).toBeTruthy();
    for (const group of [store, quick]) {
      const buttons = Array.from(group.querySelectorAll("button"));
      expect(buttons.length).toBeGreaterThan(1);
      for (const b of buttons) expect(["true", "false"]).toContain(b.getAttribute("aria-pressed"));
      expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    }
  });
});

