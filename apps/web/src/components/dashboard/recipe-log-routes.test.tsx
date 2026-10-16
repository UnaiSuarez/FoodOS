// @vitest-environment jsdom
//
// Entrega «acciones claras»: las rutas que registran ingesta SIN pasar por
// CookModal (detalle de receta, receta IA, tarjeta del asistente). Cada una
// debe decir qué registra, no descontar inventario (su comportamiento actual,
// sin cambios) y no avisar de nada si la mutación no se aplicó.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InventoryItem, Recipe } from "@foodos/types";
import { FoodOSProvider, getToday, useFoodOS, useFoodOSUI } from "@/lib/state";
import { RecipeDetailModal } from "./RecipeDetailModal";
import { AiRecipeModal } from "./AiRecipeModal";
import { ChatRecipeCard } from "./views/AssistantView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useFoodOS> & {
  toast: ReturnType<typeof useFoodOSUI>["toast"];
  mascotMessage: ReturnType<typeof useFoodOSUI>["mascotMessage"];
};
let container: HTMLDivElement;
let root: Root | null = null;

const RECIPE: Recipe = {
  id: "r-route-1", title: "Bowl de prueba",
  ingredients: [{ name: "Pollo", quantity: 200, unit: "g" }],
  kcal: 500, protein: 40, carbs: 50, fat: 12, cost: 3, image: "/images/test.webp", time: 20, servings: 1,
  difficulty: "fácil", tags: [], steps: ["Cocina."],
};

const POLLO: InventoryItem = {
  id: "l-pollo", name: "Pollo", qty: 1000, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 2, kcal: 150, protein: 20,
};

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

async function mount(seed: (d: Ctx["state"]) => void, ui: (holder: { current: Ctx | null }) => React.ReactNode) {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => { holder.current!.mutate((d) => seed(d)); });
  await act(async () => {
    root!.render(<FoodOSProvider><Capture />{ui(holder)}</FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  return holder;
}

const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().includes(text));
  if (!found) throw new Error(`No hay botón con «${text}»`);
  return found as HTMLButtonElement;
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

describe("RecipeDetailModal — «Cocinar y registrar esta porción»", () => {
  const seed = (d: Ctx["state"]) => {
    d.foodLog = [];
    d.customRecipes = [structuredClone(RECIPE)];
    d.inventory = [structuredClone(POLLO)];
  };
  const detail = () => <RecipeDetailModal recipeId={RECIPE.id} onClose={() => {}} />;

  it("explica antes de confirmar qué registra y que NO descuenta inventario", async () => {
    await mount(seed, detail);
    const note = container.querySelector(".cook-log-summary")!.textContent!;
    expect(note).toContain("anota en tu diario personal");
    expect(note).toContain("1 ración · 500 kcal · 40 g de proteína");
    expect(note).toContain("hoy");
    expect(note).toContain("No descuenta ingredientes del inventario");
    expect(buttonByText("Cocinar y registrar esta porción")).toBeTruthy();
  });

  it("registra la ración en el diario, deja el inventario intacto y avisa con precisión", async () => {
    const holder = await mount(seed, detail);
    click(buttonByText("Cocinar y registrar esta porción"));

    const log = holder.current!.state.foodLog;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kcal: 500, protein: 40, source: "recipe", date: getToday(holder.current!.state) });
    expect(log[0].consumedIngredients).toBeUndefined();
    expect(holder.current!.state.inventory[0].qty).toBe(1000);
    expect(holder.current!.toast!.message).toBe("Bowl de prueba: porción registrada en tu diario · inventario sin cambios");
    expect(holder.current!.mascotMessage ?? "").not.toContain("Objetivos actualizados");
  });

  it("con 2 raciones el resumen y el registro usan las 2", async () => {
    const holder = await mount(seed, detail);
    const servings = container.querySelector('.scale-controls input[type="number"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(servings, "2");
      servings.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".cook-log-summary")!.textContent).toContain("2 raciones · 1000 kcal");
    click(buttonByText("Cocinar y registrar esta porción"));
    expect(holder.current!.state.foodLog[0].kcal).toBe(1000);
  });
});

describe("AiRecipeModal — «Guardar y registrar en el diario»", () => {
  const seed = (d: Ctx["state"]) => { d.foodLog = []; d.customRecipes = []; d.inventory = [structuredClone(POLLO)]; };
  const ai = () => <AiRecipeModal draft={structuredClone(RECIPE)} onClose={() => {}} />;

  it("distingue «Guardar receta» de «Guardar y registrar» y explica el efecto", async () => {
    await mount(seed, ai);
    const note = container.querySelector(".cook-log-summary")!.textContent!;
    expect(note).toContain("1 ración (500 kcal · 40 g de proteína)");
    expect(note).toContain("No descuenta ingredientes del inventario");
    expect(note).toContain("«Guardar receta» solo la guarda en tu colección");
    expect(buttonByText("Guardar y registrar en el diario")).toBeTruthy();
    expect(container.textContent).not.toContain("Guardar y cocinar");
  });

  it("«Guardar receta» no registra ingesta", async () => {
    const holder = await mount(seed, ai);
    click(buttonByText("Guardar receta"));
    expect(holder.current!.state.customRecipes).toHaveLength(1);
    expect(holder.current!.state.foodLog).toHaveLength(0);
    expect(holder.current!.toast!.message).toBe("Receta IA guardada");
  });

  it("«Guardar y registrar» guarda y registra 1 ración sin tocar el inventario", async () => {
    const holder = await mount(seed, ai);
    click(buttonByText("Guardar y registrar en el diario"));
    expect(holder.current!.state.customRecipes).toHaveLength(1);
    expect(holder.current!.state.foodLog).toHaveLength(1);
    expect(holder.current!.state.foodLog[0].kcal).toBe(500);
    expect(holder.current!.state.inventory[0].qty).toBe(1000);
    expect(holder.current!.toast!.message).toBe("Receta guardada y 1 ración registrada en tu diario · inventario sin cambios");
  });
});

describe("ChatRecipeCard (Asistente) — «Cocinar y registrar»", () => {
  function renderCard(onCook: () => boolean) {
    root = createRoot(container);
    act(() => {
      root!.render(<ChatRecipeCard recipe={RECIPE} onReview={() => {}} onCart={() => {}} onCook={onCook} />);
    });
  }

  it("explica el efecto y lo refleja en el nombre accesible", () => {
    renderCard(() => true);
    expect(container.querySelector(".cook-log-help")!.textContent).toContain("1 ración (500 kcal · 40 g de proteína)");
    expect(container.querySelector(".cook-log-help")!.textContent).toContain("no descuenta ingredientes del inventario");
    const button = buttonByText("Cocinar y registrar");
    expect(button.getAttribute("aria-label")).toContain("sin descontar inventario");
    expect(container.textContent).not.toContain("Cocinar ahora");
  });

  it("pasa a «Registrada ✓» solo si el registro se aplicó", () => {
    const onCook = vi.fn(() => true);
    renderCard(onCook);
    click(buttonByText("Cocinar y registrar"));
    expect(onCook).toHaveBeenCalledTimes(1);
    expect(buttonByText("Registrada ✓").disabled).toBe(true);
  });

  it("si la mutación no se aplicó (gate cerrado) el botón sigue disponible para reintentar", () => {
    const onCook = vi.fn(() => false);
    renderCard(onCook);
    click(buttonByText("Cocinar y registrar"));
    expect(buttonByText("Cocinar y registrar").disabled).toBe(false);
    expect(container.textContent).not.toContain("Registrada ✓");
  });
});
