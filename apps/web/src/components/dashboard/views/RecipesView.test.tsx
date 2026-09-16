// @vitest-environment jsdom
//
// Borrado de recetas personalizadas — tests de la lógica PROPIA del
// componente (confirmación, mensaje de aviso, gating por isCustom, y la
// decisión de mostrar o no el toast de éxito según lo que mutate()
// devuelve), con `useFoodOS()` mockeado para poder controlar exactamente
// qué devuelve `mutate()` en cada caso — deliberado y aceptado para estos
// escenarios: aquí NO se prueba que mutate() persista de verdad (eso ya
// está cubierto por foodos-provider.test.tsx y por
// RecipesView.deleteIntegration.test.tsx, que sí usa el FoodOSProvider
// real). Las funciones puras (allRecipes, getRecipeMatch, getBudgetLeft,
// countUpcomingMealPlanUsages, removeCustomRecipeFromDraft, getToday,
// defaultState) se mantienen REALES vía importOriginal — solo useFoodOS()
// se sustituye.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FoodOSState, Recipe } from "@foodos/types";
import { RecipesView } from "./RecipesView";

const mutateMock = vi.fn<(fn: (draft: FoodOSState) => void) => boolean>();
const showToastMock = vi.fn();
let fakeState: FoodOSState;

vi.mock("@/lib/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state")>();
  return {
    ...actual,
    useFoodOS: () => ({
      state: fakeState,
      mutate: mutateMock,
      showToast: showToastMock,
      setMascotMessage: vi.fn(),
    }),
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeCustomRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "custom-1",
    title: "Bowl de pollo",
    ingredients: [],
    kcal: 500,
    protein: 40,
    carbs: 50,
    fat: 15,
    cost: 3,
    image: "",
    time: 20,
    servings: 1,
    difficulty: "fácil",
    tags: [],
    steps: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  const { defaultState } = await import("@/lib/state");
  fakeState = { ...defaultState, customRecipes: [makeCustomRecipe()], mealPlan: {} };
  mutateMock.mockReset();
  mutateMock.mockReturnValue(true);
  showToastMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    act(() => { root!.unmount(); });
    root = null;
  }
  container.remove();
  vi.restoreAllMocks();
});

async function renderRecipesView() {
  root = createRoot(container);
  await act(async () => {
    root!.render(<RecipesView openRecipe={() => {}} />);
    await Promise.resolve();
  });
}

function getDeleteButton(title = "Bowl de pollo"): HTMLButtonElement | null {
  return container.querySelector(`[aria-label="Eliminar receta ${title}"]`);
}

describe("RecipesView — botón «Eliminar» de recetas personalizadas", () => {
  it("cancelar el confirm nativo: no llama a mutate ni muestra el toast de éxito", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderRecipesView();

    act(() => { getDeleteButton()!.click(); });

    expect(mutateMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalledWith(expect.stringContaining("eliminada"));
  });

  it("el mensaje de confirmación es simple cuando la receta no está planificada", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderRecipesView();

    act(() => { getDeleteButton()!.click(); });

    expect(confirmSpy).toHaveBeenCalledWith('¿Eliminar la receta "Bowl de pollo"?');
  });

  it("el mensaje de confirmación indica cuántas planificaciones de hoy o próximos días se retirarán", async () => {
    fakeState.mealPlan = {
      "2099-06-15": { lunch: "custom-1" },
      "2099-06-16": { dinner: "custom-1" },
    };
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderRecipesView();

    act(() => { getDeleteButton()!.click(); });

    expect(confirmSpy).toHaveBeenCalledWith(
      '¿Eliminar la receta "Bowl de pollo"? Está planificada 2 veces hoy o en los próximos días — esos huecos quedarán vacíos.'
    );
  });

  it("una planificación de HOY mismo también cuenta en el aviso (no solo días estrictamente futuros)", async () => {
    const { getToday } = await import("@/lib/state");
    const todayKey = getToday(fakeState);
    fakeState.mealPlan = { [todayKey]: { lunch: "custom-1" } };
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderRecipesView();

    act(() => { getDeleteButton()!.click(); });

    expect(confirmSpy).toHaveBeenCalledWith(
      '¿Eliminar la receta "Bowl de pollo"? Está planificada 1 vez hoy o en los próximos días — esos huecos quedarán vacíos.'
    );
  });

  it("una receta del catálogo (DEMO_RECIPES, no está en customRecipes) nunca muestra el botón Eliminar", async () => {
    const { DEMO_RECIPES } = await import("@/lib/recipes");
    fakeState.customRecipes = [];
    await renderRecipesView();

    expect(getDeleteButton(DEMO_RECIPES[0].title)).toBeNull();
  });

  it("confirmación aceptada + mutate() devuelve true: llama a mutate una vez y muestra el toast de éxito", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mutateMock.mockReturnValue(true);
    await renderRecipesView();

    act(() => { getDeleteButton()!.click(); });

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith('"Bowl de pollo" eliminada');
  });

  it("confirmación aceptada + mutate() devuelve false (gate cerrado): NUNCA muestra el toast de éxito", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mutateMock.mockReturnValue(false);
    await renderRecipesView();

    act(() => { getDeleteButton()!.click(); });

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).not.toHaveBeenCalled();
  });
});
