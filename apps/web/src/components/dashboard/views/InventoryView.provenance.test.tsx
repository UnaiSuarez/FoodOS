// @vitest-environment jsdom
//
// PR3a — procedencia en el punto de captura de InventoryView (el flujo de
// "Añadir alimento"). Integración con el FoodOSProvider REAL (mismo patrón
// que RecipesView.deleteIntegration.test.tsx): demuestra que lo que
// realmente queda guardado en el estado —no un mock de mutate()— conserva
// nutrientStatus/foodStateConfidence, y que un campo nunca tocado por el
// usuario NUNCA se guarda como known_zero solo porque su valor de interfaz
// sea 0.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FoodOSProvider, useFoodOS } from "@/lib/state";
import { InventoryView } from "./InventoryView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useFoodOS>;

function makeCapture() {
  const holder: { current: Ctx | null } = { current: null };
  function Capture() {
    const ctx = useFoodOS();
    holder.current = ctx;
    return null;
  }
  return { Capture, holder };
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector("form")!;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

let container: HTMLDivElement;
let root: Root | null = null;

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

async function renderInventoryView() {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <FoodOSProvider>
        <Capture />
        <InventoryView />
      </FoodOSProvider>
    );
    await Promise.resolve(); await Promise.resolve();
  });
  return holder;
}

describe("InventoryView — procedencia real al guardar (FoodOSProvider sin mockear)", () => {
  it("elegir una sugerencia del catálogo local guarda legacy_unlabeled, nunca known_*, y no confirma el estado del alimento sin base para hacerlo", async () => {
    const holder = await renderInventoryView();

    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement;
    act(() => { setNativeValue(nameInput, "Pechuga de pollo"); });

    const suggestion = container.querySelector("#inv-name-option-0") as HTMLLIElement;
    expect(suggestion).not.toBeNull();
    expect(suggestion.textContent).toContain("Pechuga de pollo");
    act(() => { suggestion.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });

    act(() => { submitForm(container); });

    const saved = holder.current!.state.inventory.find((i) => i.name === "Pechuga de pollo");
    expect(saved).toBeDefined();
    expect(saved!.nutrientStatus?.kcal).toBe("legacy_unlabeled");
    expect(saved!.nutrientStatus?.protein).toBe("legacy_unlabeled");
    expect(saved!.nutrientStatus?.carbs).toBe("legacy_unlabeled");
    expect(saved!.nutrientStatus?.fat).toBe("legacy_unlabeled");
    // Ni la búsqueda ni la ficha declaran un estado (crudo/cocido/...): unknown.
    expect(saved!.foodStateConfidence).toBe("unknown");
  });

  it("guardar sin tocar kcal/proteína NUNCA produce known_zero: el nutrientStatus ni se guarda, aunque el número visible sea 0", async () => {
    const holder = await renderInventoryView();

    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement;
    act(() => { setNativeValue(nameInput, "Z"); }); // 1 carácter: no dispara la búsqueda OFF con debounce
    const expiresInput = container.querySelector('input[name="expires"]') as HTMLInputElement;
    act(() => { setNativeValue(expiresInput, "2099-01-01"); });

    act(() => { submitForm(container); });

    const saved = holder.current!.state.inventory.find((i) => i.name === "Z");
    expect(saved).toBeDefined();
    expect(saved!.kcal).toBe(0);
    expect(saved!.protein).toBe(0);
    expect(saved!.nutrientStatus).toBeUndefined();
  });

  it("escribir kcal a mano marca SOLO ese nutriente como known_*; la proteína sin tocar sigue sin guardarse como known_zero", async () => {
    const holder = await renderInventoryView();

    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement;
    act(() => { setNativeValue(nameInput, "Z"); });
    const expiresInput = container.querySelector('input[name="expires"]') as HTMLInputElement;
    act(() => { setNativeValue(expiresInput, "2099-01-01"); });
    const kcalInput = container.querySelector('input[name="kcal"]') as HTMLInputElement;
    act(() => { setNativeValue(kcalInput, "50"); });

    act(() => { submitForm(container); });

    const saved = holder.current!.state.inventory.find((i) => i.name === "Z");
    expect(saved).toBeDefined();
    expect(saved!.kcal).toBe(50);
    expect(saved!.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(saved!.nutrientStatus?.protein).toBeUndefined();
    expect(saved!.protein).toBe(0);
  });
});
