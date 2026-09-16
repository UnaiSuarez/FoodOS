// @vitest-environment jsdom
//
// Borrado de recetas personalizadas — prueba de integración con el
// FoodOSProvider REAL (sin mockear @/lib/state en absoluto, igual que
// ImagePickerField.test.tsx): demuestra que confirmar el borrado hace que
// la receta desaparezca de verdad del DOM renderizado, porque se ejecuta el
// callback REAL de mutate() (clona el estado, filtra customRecipes, aplica
// setState) — un mock que solo devolviera `true` no probaría esto. Los
// demás escenarios (cancelación, mensaje de aviso, gating por catálogo,
// mutate()===false → sin toast) están en RecipesView.test.tsx, donde SÍ se
// mockea useFoodOS() para aislar la lógica propia del componente.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FoodOSProvider, useFoodOS } from "@/lib/state";
import { RecipesView } from "./RecipesView";

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
  vi.restoreAllMocks();
});

describe("RecipesView + FoodOSProvider real — el borrado persiste de verdad en el estado renderizado", () => {
  it("confirmar el borrado hace desaparecer la receta de la lista renderizada (callback de mutate() real, no mockeado)", async () => {
    const { Capture, holder } = makeCapture();

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <FoodOSProvider>
          <Capture />
          <RecipesView openRecipe={() => {}} />
        </FoodOSProvider>
      );
      await Promise.resolve(); await Promise.resolve();
    });

    // Modo local (sin Supabase configurado en el entorno de test): el gate
    // ya está abierto desde el principio — este mutate() es el real de
    // producción, sin ningún mock.
    act(() => {
      holder.current!.mutate((draft) => {
        draft.customRecipes.push({
          id: "custom-real-1",
          title: "Bowl de pollo real",
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
        });
      });
    });

    const findButton = () => container.querySelector('[aria-label="Eliminar receta Bowl de pollo real"]') as HTMLButtonElement | null;
    expect(findButton()).not.toBeNull();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    act(() => { findButton()!.click(); });

    expect(findButton()).toBeNull();
    expect(holder.current!.state.customRecipes.some((r) => r.id === "custom-real-1")).toBe(false);
  });
});
