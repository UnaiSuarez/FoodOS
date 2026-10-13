// @vitest-environment jsdom
//
// Entrega «acciones claras»: las acciones del Panel reutilizan la señal del
// «+» universal. «Registrar comida» abre el modal en Registro y «Añadir
// alimento» enfoca el formulario de Inventario; la señal se consume UNA vez.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FoodOSProvider } from "@/lib/state";
import { HomeView } from "./views/HomeView";
import { DiaryView } from "./views/DiaryView";
import { InventoryView } from "./views/InventoryView";

vi.mock("@/lib/ai-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-config")>()),
  loadAIConfig: () => null,
}));
vi.mock("@/lib/food-lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/food-lookup")>()),
  searchOFFSuggestions: vi.fn(async () => []),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "foodos-quick-add-signal";
let container: HTMLDivElement;
let root: Root | null = null;

async function render(ui: React.ReactNode) {
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider>{ui}</FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function unmount() {
  await act(async () => { root!.unmount(); });
  root = null;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().includes(text));
  if (!found) throw new Error(`No hay botón con «${text}»`);
  return found as HTMLButtonElement;
}

const dialogOpen = () => document.body.querySelector('[role="dialog"]') !== null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) await unmount();
  container.remove();
  localStorage.clear();
  sessionStorage.clear();
});

describe("Panel → señal de acceso rápido", () => {
  it("«Registrar comida» deja la señal «meal» y navega a Registro", async () => {
    const goTo = vi.fn();
    await render(<HomeView goTo={goTo} openRecipe={() => {}} />);
    act(() => { buttonByText("Registrar comida").click(); });
    expect(sessionStorage.getItem(KEY)).toBe("meal");
    expect(goTo).toHaveBeenCalledWith("diary");
  });

  it("«Añadir alimento» deja la señal «food» y navega a Inventario", async () => {
    const goTo = vi.fn();
    await render(<HomeView goTo={goTo} openRecipe={() => {}} />);
    act(() => { buttonByText("Añadir alimento").click(); });
    expect(sessionStorage.getItem(KEY)).toBe("food");
    expect(goTo).toHaveBeenCalledWith("inventory");
  });
});

describe("Registro — apertura del modal y consumo único de la señal", () => {
  it("con la señal «meal», el modal se abre solo al montar y la señal se borra", async () => {
    sessionStorage.setItem(KEY, "meal");
    await render(<DiaryView />);
    expect(dialogOpen()).toBe(true);
    expect(document.body.textContent).toContain("¿Qué has comido?"); // título del modal
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("al volver a la vista (remontar) NO reaparece", async () => {
    sessionStorage.setItem(KEY, "meal");
    await render(<DiaryView />);
    expect(dialogOpen()).toBe(true);
    await unmount();
    document.body.querySelectorAll('[role="dialog"]').forEach((d) => d.remove());

    await render(<DiaryView />);
    expect(dialogOpen()).toBe(false);
  });

  it("sin señal, el modal no se abre y el acceso se llama «Registrar comida»", async () => {
    await render(<DiaryView />);
    expect(dialogOpen()).toBe(false);
    expect(buttonByText("Registrar comida").classList.contains("diary-log-btn")).toBe(true);
    expect(container.textContent).not.toContain("+ ¿Qué has comido?");
  });

  it("una señal de otro tipo se descarta sin abrir nada", async () => {
    sessionStorage.setItem(KEY, "food");
    await render(<DiaryView />);
    expect(dialogOpen()).toBe(false);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe("Inventario — foco del formulario y consumo único de la señal", () => {
  it("con la señal «food», el campo nombre recibe el foco y la señal se borra", async () => {
    sessionStorage.setItem(KEY, "food");
    await render(<InventoryView />);
    const nameInput = container.querySelector('input[name="name"]');
    expect(nameInput).not.toBeNull();
    expect(document.activeElement).toBe(nameInput);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("al volver a la vista, el foco NO se vuelve a forzar", async () => {
    sessionStorage.setItem(KEY, "food");
    await render(<InventoryView />);
    await unmount();
    (document.activeElement as HTMLElement | null)?.blur?.();

    await render(<InventoryView />);
    expect(document.activeElement).not.toBe(container.querySelector('input[name="name"]'));
  });
});
