// @vitest-environment jsdom
//
// Panel de diagnóstico — montado sobre el FoodOSProvider REAL (mismo patrón
// que food-log-writers.integration.test.tsx), nunca sobre un stub. Cubre:
// diario vacío, entradas sintéticas, umbrales inválidos y el caso de
// cobertura fiable que coincide con provisionalidad — y, sobre todo, que
// interactuar con el panel NUNCA muta el estado ni persiste nada.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FoodLogEntry } from "@foodos/types";
import { FoodOSProvider, useFoodOS } from "@/lib/state";
import { todayPlus } from "@/lib/utils";
import { NutritionV4CoveragePanel, parseThresholdInput } from "./NutritionV4CoveragePanel";

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
    root!.render(<FoodOSProvider><Capture /><NutritionV4CoveragePanel /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  return holder;
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`No hay botón con «${text}»`);
  return found as HTMLButtonElement;
}

function inputByLabel(labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes(labelText));
  if (!label) throw new Error(`No hay <label> con «${labelText}»`);
  const input = label.querySelector("input");
  if (!input) throw new Error(`El <label> «${labelText}» no contiene un <input>`);
  return input;
}

function setNativeValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(el: Element) {
  act(() => { (el as HTMLElement).click(); });
}

function stateSnapshot(holder: { current: Ctx | null }): string {
  return JSON.stringify(holder.current!.state);
}

const OFF_CONFIRMED: Pick<FoodLogEntry, "nutrientStatus" | "foodStateConfidence"> = {
  nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
  foodStateConfidence: "confirmed",
};

function entry(overrides: Partial<FoodLogEntry>): FoodLogEntry {
  return {
    id: overrides.id ?? "e1", date: overrides.date ?? "2026-01-01", time: "13:00", name: "entrada",
    qty: null, unit: null, kcal: 500, protein: 40, carbs: 0, fat: 15, source: "manual", mealType: "lunch",
    ...overrides,
  };
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

describe("parseThresholdInput — nunca convierte una entrada inválida en 0 en silencio", () => {
  it("vacío -> error, no 0", () => { expect(parseThresholdInput("")).toEqual({ error: expect.any(String) }); });
  it("fuera de rango (negativo) -> error", () => { expect(parseThresholdInput("-0.1")).toEqual({ error: expect.any(String) }); });
  it("fuera de rango (>1) -> error", () => { expect(parseThresholdInput("1.5")).toEqual({ error: expect.any(String) }); });
  it("no numérico ('abc', inalcanzable vía <input type=number> pero defendido igual) -> error, no NaN ni 0", () => {
    expect(parseThresholdInput("abc")).toEqual({ error: expect.any(String) });
  });
  it("0 y 1 son válidos (límites inclusive)", () => {
    expect(parseThresholdInput("0")).toEqual({ value: 0 });
    expect(parseThresholdInput("1")).toEqual({ value: 1 });
  });
});

describe("NutritionV4CoveragePanel — diario vacío", () => {
  it("con el diario vacío, calcula sin romper: unloggedDays = 28, ninguna petición de red", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => { throw new Error("no debe llamar a fetch"); }) as unknown as typeof fetch;
    const holder = await mount(() => {});
    click(buttonByText("Calcular diagnóstico"));
    expect(container.textContent).toContain("Sin registrar");
    expect(container.textContent).toMatch(/28/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
    void holder;
  });
});

describe("NutritionV4CoveragePanel — entradas sintéticas", () => {
  it("una entrada synthetic:true dentro de la ventana no cuenta como día registrado", async () => {
    const today = todayPlus(0);
    const holder = await mount((d) => {
      d.foodLog.push({ ...entry({ date: today }), synthetic: true } as FoodLogEntry);
    });
    click(buttonByText("Calcular diagnóstico"));
    // Con solo una entrada sintética, todos los días siguen "sin registrar".
    expect(container.textContent).toMatch(/Sin registrar[\s\S]*28/);
    void holder;
  });
});

describe("NutritionV4CoveragePanel — umbrales inválidos: no se convierten en 0 en silencio", () => {
  it("un umbral vacío muestra un mensaje de error y no calcula ningún resultado", async () => {
    await mount(() => {});
    click(buttonByText("Calcular diagnóstico"));
    const dailyInput = inputByLabel("Umbral diario de fiabilidad");
    setNativeValue(dailyInput, "");
    expect(container.textContent).toContain("Obligatorio");
    expect(container.textContent).not.toContain("Días de la ventana");
  });

  it("un umbral fuera de [0,1] muestra un mensaje de error, no se trata como 0 ni como 1", async () => {
    await mount(() => {});
    click(buttonByText("Calcular diagnóstico"));
    const provisionalInputEl = inputByLabel("Umbral de kcal provisional");
    setNativeValue(provisionalInputEl, "1.5");
    expect(container.textContent).toContain("Debe estar entre 0 y 1");
    expect(container.textContent).not.toContain("Días de la ventana");
  });

});

describe("NutritionV4CoveragePanel — un día puede ser fiable Y provisional a la vez", () => {
  it("una entrada known_nonzero+confirmed dentro de la ventana cuenta cobertura fiable y, a la vez, un día provisional", async () => {
    const today = todayPlus(0);
    const holder = await mount((d) => {
      d.foodLog.push(entry({ date: today, kcal: 500, protein: 40, carbs: 0, fat: 15, ...OFF_CONFIRMED }));
    });
    click(buttonByText("Calcular diagnóstico"));
    expect(container.textContent).toMatch(/Provisionales[\s\S]*[1-9]/); // al menos 1 día provisional
    // La fila de Kcal debe mostrar cobertura > 0% — cuenta como fiable.
    const kcalRow = Array.from(container.querySelectorAll("tr")).find((tr) => tr.textContent?.startsWith("Kcal"));
    expect(kcalRow?.textContent).toMatch(/[1-9][0-9.]*%/);
    expect(container.textContent).toContain("Un día puede contar a la vez como");
    void holder;
  });

  it("fibra/azúcares/sal se muestran como 'sin datos disponibles', nunca como 0% de cobertura", async () => {
    const today = todayPlus(0);
    await mount((d) => {
      d.foodLog.push(entry({ date: today, ...OFF_CONFIRMED }));
    });
    click(buttonByText("Calcular diagnóstico"));
    const fiberRow = Array.from(container.querySelectorAll("tr")).find((tr) => tr.textContent?.startsWith("Fibra"));
    expect(fiberRow?.textContent).toContain("sin datos disponibles");
    expect(fiberRow?.textContent).not.toMatch(/0\.0%/);
  });
});

describe("NutritionV4CoveragePanel — nunca muta el estado ni persiste nada", () => {
  it("abrir el panel y cambiar los umbrales no cambia state en absoluto", async () => {
    const today = todayPlus(0);
    const holder = await mount((d) => {
      d.foodLog.push(entry({ date: today, ...OFF_CONFIRMED }));
    });
    const before = stateSnapshot(holder);

    click(buttonByText("Calcular diagnóstico"));
    const dailyInput = inputByLabel("Umbral diario de fiabilidad");
    setNativeValue(dailyInput, "0.5");
    const provisionalInputEl = inputByLabel("Umbral de kcal provisional");
    setNativeValue(provisionalInputEl, "0.9");
    click(buttonByText("Ocultar diagnóstico"));
    click(buttonByText("Calcular diagnóstico"));

    expect(stateSnapshot(holder)).toBe(before);
  });

  it("no añade ninguna clave nueva a localStorage al interactuar con el panel", async () => {
    const today = todayPlus(0);
    await mount((d) => {
      d.foodLog.push(entry({ date: today, ...OFF_CONFIRMED }));
    });
    // Deja asentar cualquier guardado local disparado por el propio seed,
    // ANTES de medir — lo que nos interesa es lo que añade el panel, no el seed.
    await act(async () => { await Promise.resolve(); });
    const keysBefore = Object.keys(localStorage).sort();
    const valuesBefore = keysBefore.map((k) => localStorage.getItem(k));

    click(buttonByText("Calcular diagnóstico"));
    setNativeValue(inputByLabel("Umbral diario de fiabilidad"), "0.5");

    expect(Object.keys(localStorage).sort()).toEqual(keysBefore);
    expect(keysBefore.map((k) => localStorage.getItem(k))).toEqual(valuesBefore);
  });
});
