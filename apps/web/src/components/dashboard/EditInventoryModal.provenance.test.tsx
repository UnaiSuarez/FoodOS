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

async function renderEditModal(seedItem: InventoryItem = SEED_ITEM) {
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
    holder2.holder.current!.mutate((draft) => { draft.inventory.push({ ...seedItem }); });
  });
  const seeded = holder2.holder.current!.state.inventory.find((i) => i.id === seedItem.id)!;

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

// Ronda de corrección posterior: el modal también permite editar `name`.
// foodStateConfidence se calculó comparando el texto de la referencia
// original contra el nombre de entonces, y ese texto no se conserva — un
// cambio real de nombre no se puede recalcular, así que un "confirmed"
// previo se rebaja a "unknown" y un guardado sin cambio de nombre lo conserva.
const RICE_RAW_CONFIRMED: InventoryItem = {
  id: "rice-item-1",
  name: "arroz crudo",
  qty: 500,
  unit: "g",
  storage: "Despensa",
  expires: "2099-01-01",
  price: 1.5,
  kcal: 360,
  protein: 7,
  nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero" },
  foodStateConfidence: "confirmed",
};

describe("EditInventoryModal — renombrar y foodStateConfidence", () => {
  it("cambiar «arroz crudo» → «arroz cocido» rebaja confirmed a unknown", async () => {
    const holder = await renderEditModal(RICE_RAW_CONFIRMED);
    const nameInput = findFieldInput(container, "Nombre");
    act(() => { setNativeValue(nameInput, "arroz cocido"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === RICE_RAW_CONFIRMED.id)!;
    expect(saved.name).toBe("arroz cocido");
    expect(saved.foodStateConfidence).toBe("unknown");
    // El renombrado no toca la procedencia numérica: kcal/protein no cambiaron.
    expect(saved.nutrientStatus).toEqual(RICE_RAW_CONFIRMED.nutrientStatus);
    expect(saved.kcal).toBe(360);
  });

  it("guardar SIN cambiar el nombre conserva confirmed", async () => {
    const holder = await renderEditModal(RICE_RAW_CONFIRMED);
    const priceInput = findFieldInput(container, "Precio €");
    act(() => { setNativeValue(priceInput, "1.80"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === RICE_RAW_CONFIRMED.id)!;
    expect(saved.price).toBe(1.8);
    expect(saved.name).toBe("arroz crudo");
    expect(saved.foodStateConfidence).toBe("confirmed");
  });

  it("un cambio solo de mayúsculas/espacios no cuenta como cambio real de nombre", async () => {
    const holder = await renderEditModal(RICE_RAW_CONFIRMED);
    const nameInput = findFieldInput(container, "Nombre");
    act(() => { setNativeValue(nameInput, "  Arroz  crudo "); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === RICE_RAW_CONFIRMED.id)!;
    expect(saved.foodStateConfidence).toBe("confirmed");
  });

  it("renombrar un item cuya confianza ya era unknown no la cambia ni la eleva", async () => {
    const holder = await renderEditModal({ ...RICE_RAW_CONFIRMED, id: "rice-item-2", foodStateConfidence: "unknown" });
    const nameInput = findFieldInput(container, "Nombre");
    act(() => { setNativeValue(nameInput, "arroz cocido"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === "rice-item-2")!;
    expect(saved.foodStateConfidence).toBe("unknown");
  });

  it("renombrar un item incompatible sigue siendo incompatible — renombrar no demuestra que el conflicto desapareciera", async () => {
    const holder = await renderEditModal({ ...RICE_RAW_CONFIRMED, id: "rice-item-3", foodStateConfidence: "incompatible" });
    const nameInput = findFieldInput(container, "Nombre");
    act(() => { setNativeValue(nameInput, "arroz cocido"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === "rice-item-3")!;
    expect(saved.foodStateConfidence).toBe("incompatible");
  });

  it("renombrar un item sin foodStateConfidence previo (legacy) no le inventa uno", async () => {
    const { foodStateConfidence: _omit, ...legacy } = RICE_RAW_CONFIRMED;
    void _omit;
    const holder = await renderEditModal({ ...legacy, id: "rice-item-4" });
    const nameInput = findFieldInput(container, "Nombre");
    act(() => { setNativeValue(nameInput, "arroz cocido"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === "rice-item-4")!;
    expect(saved.foodStateConfidence).toBeUndefined();
  });
});

// Ronda de corrección: editar kcal/proteina a mano no debe conservar de forma
// automatica la confianza de estado calculada para la referencia anterior.
const OFF_CONFIRMED: InventoryItem = {
  id: "off-confirmed-1",
  name: "arroz cocido",
  qty: 500, unit: "g", storage: "Despensa", expires: "2099-01-01", price: 1.5,
  kcal: 130, protein: 2.7, carbs: 28, fat: 0.3,
  dataSource: "off",
  nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero" },
  foodStateConfidence: "confirmed",
};

const MANUAL_CONFIRMED: InventoryItem = {
  id: "manual-confirmed-1",
  name: "arroz cocido",
  qty: 500, unit: "g", storage: "Despensa", expires: "2099-01-01", price: 1.5,
  kcal: 130, protein: 2.7,
  nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero" },
  foodStateConfidence: "confirmed",
};

describe("EditInventoryModal — edicion manual de kcal/proteina y foodStateConfidence", () => {
  it("override de un resultado OFF confirmed (solo kcal): kcal known_*, el resto de la referencia intacto, confirmed pasa a unknown", async () => {
    const holder = await renderEditModal(OFF_CONFIRMED);
    act(() => { setNativeValue(findFieldInput(container, "kcal/100g"), "200"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === OFF_CONFIRMED.id)!;
    expect(saved.kcal).toBe(200);
    expect(saved.nutrientStatus).toEqual(OFF_CONFIRMED.nutrientStatus);
    expect(saved.foodStateConfidence).toBe("unknown");
  });

  it("editar kcal Y proteina sobre un item con carbs/fat de la referencia sigue siendo unknown", async () => {
    const holder = await renderEditModal({ ...OFF_CONFIRMED, id: "off-confirmed-2" });
    act(() => { setNativeValue(findFieldInput(container, "kcal/100g"), "200"); });
    act(() => { setNativeValue(findFieldInput(container, "Proteína/100g"), "9"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === "off-confirmed-2")!;
    expect(saved.protein).toBe(9);
    expect(saved.foodStateConfidence).toBe("unknown");
  });

  it("abrir y guardar sin editar macros ni nombre conserva confirmed y los estados existentes", async () => {
    const holder = await renderEditModal({ ...OFF_CONFIRMED, id: "off-confirmed-3" });
    act(() => { setNativeValue(findFieldInput(container, "Precio €"), "2.10"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === "off-confirmed-3")!;
    expect(saved.price).toBe(2.1);
    expect(saved.foodStateConfidence).toBe("confirmed");
    expect(saved.nutrientStatus).toEqual(OFF_CONFIRMED.nutrientStatus);
  });

  it("item 100 % manual con nombre que declara un estado: reescribir kcal recalcula por el nombre y mantiene confirmed", async () => {
    const holder = await renderEditModal(MANUAL_CONFIRMED);
    act(() => { setNativeValue(findFieldInput(container, "kcal/100g"), "140"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === MANUAL_CONFIRMED.id)!;
    expect(saved.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(saved.foodStateConfidence).toBe("confirmed");
  });

  it("renombrar y reescribir SOLO kcal: la proteina sin reescribir se tecleo bajo el nombre anterior, asi que unknown", async () => {
    const holder = await renderEditModal({ ...MANUAL_CONFIRMED, id: "manual-confirmed-2" });
    act(() => { setNativeValue(findFieldInput(container, "Nombre"), "arroz crudo"); });
    act(() => { setNativeValue(findFieldInput(container, "kcal/100g"), "350"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === "manual-confirmed-2")!;
    expect(saved.name).toBe("arroz crudo");
    expect(saved.foodStateConfidence).toBe("unknown");
  });

  it("renombrar y reescribir kcal Y proteina en un item 100 % manual: todos los numeros son del nombre nuevo, confirmed", async () => {
    const holder = await renderEditModal({ ...MANUAL_CONFIRMED, id: "manual-confirmed-3" });
    act(() => { setNativeValue(findFieldInput(container, "Nombre"), "arroz crudo"); });
    act(() => { setNativeValue(findFieldInput(container, "kcal/100g"), "350"); });
    act(() => { setNativeValue(findFieldInput(container, "Proteína/100g"), "7"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === "manual-confirmed-3")!;
    expect(saved.nutrientStatus).toEqual({ kcal: "known_nonzero", protein: "known_nonzero" });
    expect(saved.foodStateConfidence).toBe("confirmed");
  });

  it("item antiguo sin metadatos: editar kcal etiqueta solo kcal; la proteina sigue sin estado y un nombre sin estado da unknown", async () => {
    const holder = await renderEditModal({
      id: "legacy-edit-1", name: "arroz", qty: 500, unit: "g", storage: "Despensa",
      expires: "2099-01-01", price: 1.2, kcal: 130, protein: 2.7,
    });
    act(() => { setNativeValue(findFieldInput(container, "kcal/100g"), "135"); });

    clickSave(container);

    const saved = holder.current!.state.inventory.find((i) => i.id === "legacy-edit-1")!;
    expect(saved.nutrientStatus).toEqual({ kcal: "known_nonzero" });
    expect(saved.foodStateConfidence).toBe("unknown");
  });
});
