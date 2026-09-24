// @vitest-environment jsdom
//
// PR3a (corrección tras revisión) — todos los eventos de edición manual de
// macros deben mantener sincronizados el número, nutrientStatus y
// foodStateConfidence. Integración con el FoodOSProvider REAL (sin mockear
// mutate) para InventoryView, CreateRecipeModal y EditRecipeModal; el cuarto
// sitio, EditInventoryModal, está en EditInventoryModal.provenance.test.tsx.
//
// Regla probada: cada base de evidencia cubre solo sus números. Una entrada
// 100 % manual con el nombre declarando UN estado es "confirmed" (débil);
// sustituir a mano parte de una referencia rebaja "confirmed" a "unknown";
// solo si se reescriben todos los números de la referencia se recalcula por
// el nombre. Guardar sin editar conserva los metadatos existentes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Recipe } from "@foodos/types";
import { FoodOSProvider, useFoodOS } from "@/lib/state";
import { InventoryView } from "./views/InventoryView";
import { CreateRecipeModal } from "./CreateRecipeModal";
import { EditRecipeModal } from "./EditRecipeModal";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useFoodOS>;

function makeCapture() {
  const holder: { current: Ctx | null } = { current: null };
  function Capture() {
    holder.current = useFoodOS();
    return null;
  }
  return { Capture, holder };
}

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const OFF_PRODUCT = {
  product_name_es: "Xyzquinoa cocida",
  nutriments: { "energy-kcal_100g": 120, proteins_100g: 4, carbohydrates_100g: 22, fat_100g: 1 },
};

function stubFetch(products: unknown[] = [OFF_PRODUCT]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/food-search")) return { ok: true, json: async () => ({ products }) };
      return { ok: false, json: async () => ({}) };
    }),
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  stubFetch();
});

afterEach(() => {
  if (root) {
    act(() => { root!.unmount(); });
    root = null;
  }
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function renderWith(children: (holder: { current: Ctx | null }) => React.ReactNode) {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <FoodOSProvider>
        <Capture />
        {children(holder)}
      </FoodOSProvider>,
    );
    await Promise.resolve(); await Promise.resolve();
  });
  return holder;
}

// ─── InventoryView ───────────────────────────────────────────────────────────

const invInput = (name: string) => container.querySelector(`input[name="${name}"]`) as HTMLInputElement;
const submitInventoryForm = () => act(() => {
  container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});

describe("InventoryView — entrada manual nueva", () => {
  it.each([
    ["Xyz cocido", "confirmed"],
    ["Xyz", "unknown"],
    ["Xyz deshidratado para preparar", "unknown"],
  ])("nombre %j con kcal tecleado → foodStateConfidence %s, kcal known_nonzero, proteína sin tocar sin estado", async (name, expected) => {
    const holder = await renderWith(() => <InventoryView />);
    act(() => { setNativeValue(invInput("name"), name); });
    act(() => { setNativeValue(invInput("expires"), "2099-01-01"); });
    act(() => { setNativeValue(invInput("kcal"), "130"); });

    submitInventoryForm();

    const saved = holder.current!.state.inventory.find((i) => i.name === name)!;
    expect(saved.kcal).toBe(130);
    expect(saved.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(saved.nutrientStatus?.protein).toBeUndefined();
    expect(saved.protein).toBe(0);
    expect(saved.foodStateConfidence).toBe(expected);
  });
});

async function pickOffSuggestion(name: string) {
  act(() => { setNativeValue(invInput("name"), name); });
  await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
  const option = container.querySelector("#inv-name-option-0") as HTMLLIElement;
  expect(option).not.toBeNull();
  act(() => { option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
}

describe("InventoryView — override de un resultado OFF con estado previamente confirmed", () => {
  it("sin editar nada, guardar conserva confirmed y los estados known_* de la referencia", async () => {
    const holder = await renderWith(() => <InventoryView />);
    await pickOffSuggestion("Xyzquinoa cocida");
    act(() => { setNativeValue(invInput("expires"), "2099-01-01"); });

    submitInventoryForm();

    const saved = holder.current!.state.inventory.find((i) => i.name === "Xyzquinoa cocida")!;
    expect(saved.foodStateConfidence).toBe("confirmed");
    expect(saved.nutrientStatus).toEqual({ kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero" });
  });

  it("reescribir kcal a mano: el número queda known_* del usuario, la referencia conserva el resto, y confirmed se rebaja a unknown", async () => {
    const holder = await renderWith(() => <InventoryView />);
    await pickOffSuggestion("Xyzquinoa cocida");
    act(() => { setNativeValue(invInput("expires"), "2099-01-01"); });
    act(() => { setNativeValue(invInput("kcal"), "999"); });

    submitInventoryForm();

    const saved = holder.current!.state.inventory.find((i) => i.name === "Xyzquinoa cocida")!;
    expect(saved.kcal).toBe(999);
    expect(saved.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(saved.nutrientStatus?.carbs).toBe("known_nonzero"); // carbs/fat no se pueden teclear: siguen siendo de la referencia
    expect(saved.foodStateConfidence).toBe("unknown");
  });

  it("reescribir kcal Y proteína sigue siendo unknown mientras queden carbs/fat de la referencia", async () => {
    const holder = await renderWith(() => <InventoryView />);
    await pickOffSuggestion("Xyzquinoa cocida");
    act(() => { setNativeValue(invInput("expires"), "2099-01-01"); });
    act(() => { setNativeValue(invInput("kcal"), "999"); });
    act(() => { setNativeValue(invInput("protein"), "40"); });

    submitInventoryForm();

    const saved = holder.current!.state.inventory.find((i) => i.name === "Xyzquinoa cocida")!;
    expect(saved.foodStateConfidence).toBe("unknown");
  });
});

describe("InventoryView — Completar datos (referencia solo de kcal y proteína)", () => {
  async function fillFromCatalog(holder: { current: Ctx | null }) {
    act(() => { setNativeValue(invInput("name"), "Garbanzos (cocidos)"); });
    const fillButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Completar datos")) as HTMLButtonElement;
    await act(async () => {
      fillButton.click();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    void holder;
  }

  it("la referencia trae estado confirmed y solo kcal/proteína (sin estados huérfanos de carbs/fat)", async () => {
    const holder = await renderWith(() => <InventoryView />);
    await fillFromCatalog(holder);

    submitInventoryForm();

    const saved = holder.current!.state.inventory.find((i) => i.name === "Garbanzos (cocidos)")!;
    expect(saved.foodStateConfidence).toBe("confirmed");
    expect(saved.nutrientStatus).toEqual({ kcal: "legacy_unlabeled", protein: "legacy_unlabeled" });
  });

  it("reescribir solo kcal: queda proteína de la referencia → unknown", async () => {
    const holder = await renderWith(() => <InventoryView />);
    await fillFromCatalog(holder);
    act(() => { setNativeValue(invInput("kcal"), "300"); });

    submitInventoryForm();

    const saved = holder.current!.state.inventory.find((i) => i.name === "Garbanzos (cocidos)")!;
    expect(saved.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(saved.nutrientStatus?.protein).toBe("legacy_unlabeled");
    expect(saved.foodStateConfidence).toBe("unknown");
  });

  it("reescribir kcal Y proteína: ya no queda nada de la referencia → se recalcula por el nombre (confirmed, débil)", async () => {
    const holder = await renderWith(() => <InventoryView />);
    await fillFromCatalog(holder);
    act(() => { setNativeValue(invInput("kcal"), "300"); });
    act(() => { setNativeValue(invInput("protein"), "12"); });

    submitInventoryForm();

    const saved = holder.current!.state.inventory.find((i) => i.name === "Garbanzos (cocidos)")!;
    expect(saved.nutrientStatus).toEqual({ kcal: "known_nonzero", protein: "known_nonzero" });
    expect(saved.foodStateConfidence).toBe("confirmed");
  });
});

// ─── CreateRecipeModal ───────────────────────────────────────────────────────

const ingredientNameInput = (n: number) => container.querySelector(`input[aria-label="Nombre del ingrediente ${n}"]`) as HTMLInputElement;
const macroInputs = () => Array.from(container.querySelectorAll("input.ing-macro-input")) as HTMLInputElement[];
const buttonWithText = (text: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

async function typeIngredientAndSearch(name: string) {
  act(() => { setNativeValue(ingredientNameInput(1), name); });
  await act(async () => {
    buttonWithText("Buscar macros").click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

function saveCreatedRecipe() {
  const titleInput = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes("Nombre de la receta"))!.querySelector("input") as HTMLInputElement;
  act(() => { setNativeValue(titleInput, "Receta de prueba"); });
  act(() => { buttonWithText("Guardar receta").click(); });
}

describe("CreateRecipeModal — ingrediente editado a mano", () => {
  it("encontrado en OFF con confirmed: guardar sin editar conserva confirmed", async () => {
    const holder = await renderWith(() => <CreateRecipeModal onClose={() => {}} />);
    await typeIngredientAndSearch("Xyzquinoa cocida");

    saveCreatedRecipe();

    const ing = holder.current!.state.customRecipes[0].ingredients[0];
    expect(ing.foodStateConfidence).toBe("confirmed");
    expect(ing.nutrientStatus?.kcal).toBe("known_nonzero");
  });

  it("reescribir un macro de un resultado OFF confirmed: ese macro known_*, el resto de la referencia intacto, confirmed → unknown", async () => {
    const holder = await renderWith(() => <CreateRecipeModal onClose={() => {}} />);
    await typeIngredientAndSearch("Xyzquinoa cocida");
    act(() => { setNativeValue(macroInputs()[0], "999"); });

    saveCreatedRecipe();

    const ing = holder.current!.state.customRecipes[0].ingredients[0];
    expect(ing.kcalPer100).toBe(999);
    expect(ing.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(ing.nutrientStatus?.protein).toBe("known_nonzero");
    expect(ing.proteinPer100).toBe(4);
    expect(ing.foodStateConfidence).toBe("unknown");
  });

  it("reescribir los 4 macros de la referencia recalcula por el nombre: confirmed (débil, un solo lado)", async () => {
    const holder = await renderWith(() => <CreateRecipeModal onClose={() => {}} />);
    await typeIngredientAndSearch("Xyzquinoa cocida");
    macroInputs().forEach((input, index) => act(() => { setNativeValue(input, String(10 + index)); }));

    saveCreatedRecipe();

    const ing = holder.current!.state.customRecipes[0].ingredients[0];
    expect(ing.nutrientStatus).toEqual({ kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero" });
    expect(ing.foodStateConfidence).toBe("confirmed");
  });

  it.each([
    ["xyzarroz cocido", "confirmed"],
    ["xyzarroz", "unknown"],
  ])("ingrediente no encontrado (manual) %j con un macro tecleado → foodStateConfidence %s; los macros sin teclear siguen unknown", async (name, expected) => {
    stubFetch([]);
    const holder = await renderWith(() => <CreateRecipeModal onClose={() => {}} />);
    await typeIngredientAndSearch(name);
    act(() => { setNativeValue(macroInputs()[0], "130"); });

    saveCreatedRecipe();

    const ing = holder.current!.state.customRecipes[0].ingredients[0];
    expect(ing.kcalPer100).toBe(130);
    expect(ing.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(ing.nutrientStatus?.protein).toBe("unknown");
    expect(ing.proteinPer100).toBe(0);
    expect(ing.foodStateConfidence).toBe(expected);
  });
});

// ─── EditRecipeModal ─────────────────────────────────────────────────────────

const REFERENCE_INGREDIENT = {
  name: "Xyzquinoa cocida", quantity: 100, unit: "g",
  kcalPer100: 120, proteinPer100: 4, carbsPer100: 22, fatPer100: 1,
  nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero" },
  foodStateConfidence: "confirmed",
} as const;

function recipeWith(ingredients: Recipe["ingredients"]): Recipe {
  return {
    id: "recipe-edit-1", title: "Quinoa", ingredients, kcal: 120, protein: 4, carbs: 22, fat: 1,
    cost: 2, image: "", time: 20, servings: 1, difficulty: "fácil", tags: [], steps: ["Cocer"],
  };
}

async function renderEditRecipe(recipe: Recipe) {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
    await Promise.resolve(); await Promise.resolve();
  });
  act(() => { holder.current!.mutate((draft) => { draft.customRecipes.push(recipe); }); });
  const seeded = holder.current!.state.customRecipes.find((r) => r.id === recipe.id)!;
  await act(async () => {
    root!.render(
      <FoodOSProvider>
        <Capture />
        <EditRecipeModal recipe={seeded} onClose={() => {}} />
      </FoodOSProvider>,
    );
    await Promise.resolve(); await Promise.resolve();
  });
  return holder;
}

describe("EditRecipeModal — ingrediente recargado y editado a mano", () => {
  it("guardar sin editar conserva nutrientStatus y foodStateConfidence existentes", async () => {
    const holder = await renderEditRecipe(recipeWith([{ ...REFERENCE_INGREDIENT }]));

    act(() => { buttonWithText("Guardar receta").click(); });

    const ing = holder.current!.state.customRecipes.find((r) => r.id === "recipe-edit-1")!.ingredients[0];
    expect(ing.nutrientStatus).toEqual(REFERENCE_INGREDIENT.nutrientStatus);
    expect(ing.foodStateConfidence).toBe("confirmed");
  });

  it("reescribir un macro de un ingrediente con confirmed: known_* ese macro, confirmed → unknown", async () => {
    const holder = await renderEditRecipe(recipeWith([{ ...REFERENCE_INGREDIENT }]));
    act(() => { setNativeValue(macroInputs()[0], "999"); });

    act(() => { buttonWithText("Guardar receta").click(); });

    const ing = holder.current!.state.customRecipes.find((r) => r.id === "recipe-edit-1")!.ingredients[0];
    expect(ing.kcalPer100).toBe(999);
    expect(ing.nutrientStatus?.kcal).toBe("known_nonzero");
    expect(ing.nutrientStatus?.protein).toBe("known_nonzero");
    expect(ing.foodStateConfidence).toBe("unknown");
  });

  it("un ingrediente antiguo sin metadatos guardado sin editar solo recibe el piso legacy_unlabeled — nunca known_* ni un estado de alimento", async () => {
    const holder = await renderEditRecipe(recipeWith([
      { name: "Arroz", quantity: 100, unit: "g", kcalPer100: 130, proteinPer100: 2.7, carbsPer100: 28, fatPer100: 0.3 },
    ]));

    act(() => { buttonWithText("Guardar receta").click(); });

    const ing = holder.current!.state.customRecipes.find((r) => r.id === "recipe-edit-1")!.ingredients[0];
    expect(Object.values(ing.nutrientStatus ?? {}).every((s) => s === "legacy_unlabeled")).toBe(true);
    expect(ing.foodStateConfidence).toBeUndefined();
  });
});
