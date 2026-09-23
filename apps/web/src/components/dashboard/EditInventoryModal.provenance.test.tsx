// @vitest-environment jsdom
//
// PR3a (corrección tras revisión) — EditInventoryModal permite cambiar
// kcal/protein pero antes conservaba sin más el nutrientStatus previo:
// un valor known_nonzero de OFF que el usuario reemplazaba a mano seguía
// atribuyéndose a la lectura original. Integración con el FoodOSProvider
// real (mismo patrón que InventoryView.provenance.test.tsx): confirma que
// SOLO el campo realmente editado pasa a known_*, que los campos no
// tocados conservan su procedencia tal cual, y que abrir y guardar sin
// tocar nada nunca eleva un dato antiguo sin etiqueta.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InventoryItem } from "@foodos/types";
import { FoodOSProvider, useFoodOS } from "@/lib/state";
import { EditInventoryModal } from "./EditInventoryModal";

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

function findFieldInput(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes(labelText));
  return label!.querySelector("input") as HTMLInputElement;
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

const SEED_ITEM: InventoryItem = {
  id: "test-item-1",
  name: "Pechuga de pollo OFF",
  qty: 300,
  unit: "g",
  storage: "Nevera",
  expires: "2099-01-01",
  price: 3.5,
  kcal: 165,
  protein: 31,
  carbs: 0,
  fat: 3.6,
  dataSource: "off",
  nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
  foodStateConfidence: "unknown",
};

async function renderEditModal() {
  const holder2 = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <FoodOSProvider>
        <holder2.Capture />
      </FoodOSProvider>
    );
    await Promise.resolve(); await Promise.resolve();
  });
  act(() => {
    holder2.holder.current!.mutate((draft) => { draft.inventory.push({ ...SEED_ITEM }); });
  });
  const seeded = holder2.holder.current!.state.inventory.find((i) => i.id === SEED_ITEM.id)!;

  await act(async () => {
    root!.render(
      <FoodOSProvider>
        <holder2.Capture />
        <EditInventoryModal item={seeded} onClose={() => {}} />
      </FoodOSProvider>
    );
    await Promise.resolve(); await Promise.resolve();
  });
  return holder2.holder;
}

function clickSave(container: HTMLElement) {
  const buttons = Array.from(container.querySelectorAll("button"));
  const saveBtn = buttons.find((b) => b.textContent?.includes("Guardar cambios")) as HTMLButtonElement;
  act(() => { saveBtn.click(); });
}

describe("EditInventoryModal — procedencia real al editar (FoodOSProvider sin mockear)", () => {
  it("editar SOLO kcal marca kcal como known_*; protein/carbs/fat conservan su procedencia original intacta", async () => {
    const holder = await renderEditModal();
    const kcalInput = findFieldInput(container, "kcal/100g");
    act(() => { setNativeValue(kcalInput, "200"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === SEED_ITEM.id)!;
    expect(saved.kcal).toBe(200);
    expect(saved.nutrientStatus?.kcal).toBe("known_nonzero"); // sigue known_nonzero, pero ahora por edición manual real
    // No se puede distinguir "known_nonzero de OFF" de "known_nonzero manual"
    // por el valor del enum solo — lo que importa es que protein/carbs/fat,
    // NUNCA tocados, no se movieron ni un poco:
    expect(saved.nutrientStatus?.protein).toBe("known_nonzero");
    expect(saved.nutrientStatus?.carbs).toBe("known_zero");
    expect(saved.nutrientStatus?.fat).toBe("known_nonzero");
    expect(saved.protein).toBe(31); // el número tampoco cambió
  });

  it("editar kcal a un valor EXPLÍCITO de 0 lo marca known_zero, no unknown", async () => {
    const holder = await renderEditModal();
    const kcalInput = findFieldInput(container, "kcal/100g");
    act(() => { setNativeValue(kcalInput, "0"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === SEED_ITEM.id)!;
    expect(saved.kcal).toBe(0);
    expect(saved.nutrientStatus?.kcal).toBe("known_zero");
  });

  it("editar kcal Y protein marca ambos como known_*, sin tocar carbs/fat", async () => {
    const holder = await renderEditModal();
    const kcalInput = findFieldInput(container, "kcal/100g");
    const proteinInput = findFieldInput(container, "Proteína/100g");
    act(() => { setNativeValue(kcalInput, "210"); });
    act(() => { setNativeValue(proteinInput, "18"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === SEED_ITEM.id)!;
    expect(saved.kcal).toBe(210);
    expect(saved.protein).toBe(18);
    expect(saved.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(saved.nutrientStatus?.protein).toBe("known_nonzero");
    expect(saved.nutrientStatus?.carbs).toBe("known_zero");
    expect(saved.nutrientStatus?.fat).toBe("known_nonzero");
  });

  it("guardar sin tocar kcal ni protein conserva el nutrientStatus original byte a byte", async () => {
    const holder = await renderEditModal();
    // Solo cambia un campo ajeno (precio) — kcal/protein se guardan
    // exactamente con el valor que ya traía el formulario.
    const priceInput = findFieldInput(container, "Precio €");
    act(() => { setNativeValue(priceInput, "4.20"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === SEED_ITEM.id)!;
    expect(saved.price).toBe(4.2);
    expect(saved.kcal).toBe(165);
    expect(saved.protein).toBe(31);
    expect(saved.nutrientStatus).toEqual(SEED_ITEM.nutrientStatus);
  });

  it("un item SIN nutrientStatus previo (legacy) guardado sin tocar kcal/protein no adquiere uno nuevo — abrir y guardar no eleva datos sin etiqueta", async () => {
    const holder2 = makeCapture();
    root = createRoot(container);
    await act(async () => {
      root!.render(<FoodOSProvider><holder2.Capture /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve();
    });
    act(() => {
      holder2.holder.current!.mutate((draft) => {
        draft.inventory.push({
          id: "legacy-item-1", name: "Arroz", qty: 500, unit: "g", storage: "Despensa",
          expires: "2099-01-01", price: 1.2, kcal: 130, protein: 2.7,
          // sin nutrientStatus — item anterior a PR3a
        });
      });
    });
    const seeded = holder2.holder.current!.state.inventory.find((i) => i.id === "legacy-item-1")!;
    await act(async () => {
      root!.render(
        <FoodOSProvider>
          <holder2.Capture />
          <EditInventoryModal item={seeded} onClose={() => {}} />
        </FoodOSProvider>
      );
      await Promise.resolve(); await Promise.resolve();
    });

    clickSave(container);

    const saved = holder2.holder.current!.state.inventory.find((i) => i.id === "legacy-item-1")!;
    expect(saved.kcal).toBe(130);
    expect(saved.nutrientStatus).toBeUndefined();
  });
});
