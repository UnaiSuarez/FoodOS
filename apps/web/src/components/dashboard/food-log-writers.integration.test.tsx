// @vitest-environment jsdom
//
// PR3 — cada escritor real de `foodLog` que vive en un componente, ejercido a
// través del componente REAL montado sobre el FoodOSProvider real (mismo patrón
// que EditInventoryModal.provenance.test.tsx): se pulsa el botón que el usuario
// pulsaría y se inspecciona la entrada que acaba en el estado. Solo se
// sustituyen las llamadas de red/IA (estimadores, búsqueda OFF, configuración
// de IA). Los escritores de state.tsx (cookRecipe, consumeInventoryItem,
// migración, demo) se prueban en lib/state.food-log-provenance.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FoodLogEntry, InventoryItem, NutrientStatus, Recipe } from "@foodos/types";
import { FoodOSProvider, getToday, useFoodOS } from "@/lib/state";
import { estimateMealMacros } from "@/lib/ai-inventory";
import { EditLogModal } from "./EditLogModal";
import { LogMealModal } from "./LogMealModal";
import { HomeView } from "./views/HomeView";
import { PlannerView } from "./views/PlannerView";
import { SettingsView } from "./views/SettingsView";

vi.mock("@/lib/ai-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-config")>()),
  loadAIConfig: () => ({ provider: "gemini", apiKey: "test-key", model: "test-model" }),
}));
vi.mock("@/lib/ai-inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-inventory")>()),
  estimateMealMacros: vi.fn(),
  estimateMealFromPhoto: vi.fn(),
}));
vi.mock("@/lib/food-lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/food-lookup")>()),
  searchOFFSuggestions: vi.fn(async () => []),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ctx = ReturnType<typeof useFoodOS>;
const KNOWN: NutrientStatus[] = ["known_nonzero", "known_zero"];
const MACROS = ["kcal", "protein", "carbs", "fat"] as const;

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

/** Monta el provider real, siembra el estado y monta `ui` encima. */
async function mount(seed: (draft: Ctx["state"]) => void, ui: React.ReactNode) {
  const { Capture, holder } = makeCapture();
  root = createRoot(container);
  await act(async () => {
    root!.render(<FoodOSProvider><Capture /></FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => { holder.current!.mutate((draft) => seed(draft)); });
  await act(async () => {
    root!.render(<FoodOSProvider><Capture />{ui}</FoodOSProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  return holder;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`No hay botón con «${text}»`);
  return found as HTMLButtonElement;
}

function click(el: Element) {
  act(() => { (el as HTMLElement).click(); });
}

function entriesOf(holder: { current: Ctx | null }): FoodLogEntry[] {
  return holder.current!.state.foodLog;
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(estimateMealMacros).mockReset();
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

const OFF_ITEM: InventoryItem = {
  id: "item-1", name: "Pechuga de pollo", qty: 500, unit: "g", storage: "Nevera", expires: "2099-01-01", price: 4,
  kcal: 165, protein: 31, carbs: 0, fat: 3.6, dataSource: "off",
  nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
  foodStateConfidence: "confirmed",
};

const RECIPE: Recipe = {
  id: "recipe-pr3", title: "Guiso de prueba PR3",
  ingredients: [{
    name: "Lentejas", quantity: 100, unit: "g", kcalPer100: 116, proteinPer100: 9, carbsPer100: 20, fatPer100: 0.4,
    nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_nonzero", fat: "known_nonzero" },
    foodStateConfidence: "confirmed",
  }],
  kcal: 420, protein: 30, carbs: 55, fat: 10, cost: 2, image: "", time: 30, servings: 1, difficulty: "fácil", tags: [], steps: [],
};

describe("LogMealModal — pestaña Inventario (→ consumeInventoryItem)", () => {
  it("registra con la procedencia que PR3a guardó en el item, y descuenta el inventario como siempre", async () => {
    const holder = await mount((d) => { d.inventory.push({ ...OFF_ITEM }); }, <LogMealModal onClose={() => {}} />);
    click(container.querySelector(".lm-inv-row")!);
    click(buttonByText("Registrar"));
    const [entry] = entriesOf(holder);
    expect(entry).toMatchObject({ name: "Pechuga de pollo", source: "inventory", qty: 500, unit: "g", kcal: 825, protein: 155 });
    expect(entry.nutrientStatus).toEqual({ kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" });
    expect(entry.foodStateConfidence).toBe("confirmed");
    expect(holder.current!.state.inventory).toHaveLength(0); // se consumió todo
  });
});

describe("LogMealModal — pestaña Receta (→ cookRecipe)", () => {
  it("registrar una receta la etiqueta legacy_unlabeled aunque sus ingredientes sean known_* (AC28)", async () => {
    const holder = await mount((d) => { d.customRecipes.push(structuredClone(RECIPE)); }, <LogMealModal onClose={() => {}} />);
    click(buttonByText("Receta"));
    const row = Array.from(container.querySelectorAll(".lm-recipe-row")).find((r) => r.textContent?.includes("Guiso de prueba PR3"))!;
    click(row);
    click(buttonByText("Registrar"));
    const entry = entriesOf(holder).find((e) => e.name === "Guiso de prueba PR3")!;
    expect(entry).toMatchObject({ kcal: 420, protein: 30, carbs: 55, fat: 10, source: "recipe" });
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    expect(entry.foodStateConfidence).toBe("unknown");
  });
});

describe("LogMealModal — pestaña Plato (confirmDish)", () => {
  it("el total de un plato compuesto es legacy_unlabeled, aunque su ingrediente del inventario sea known_*", async () => {
    const holder = await mount((d) => { d.inventory.push({ ...OFF_ITEM }); }, <LogMealModal onClose={() => {}} />);
    click(buttonByText("Plato"));
    const search = container.querySelector('input[aria-label="Añadir ingrediente"]') as HTMLInputElement;
    act(() => { setNativeValue(search, "Pechuga"); });
    const option = Array.from(container.querySelectorAll('li[role="option"]')).find((o) => o.textContent?.includes("Pechuga de pollo"))!;
    act(() => { option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    click(buttonByText("Registrar plato"));
    const entry = entriesOf(holder).find((e) => e.name === "Plato elaborado")!;
    expect(entry).toMatchObject({ kcal: 165, protein: 31, source: "manual", qty: null, unit: null });
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    for (const key of MACROS) expect(KNOWN).not.toContain(entry.nutrientStatus?.[key]);
    expect(entry.foodStateConfidence).toBe("unknown");
    // Descontó del inventario como siempre y conservó los ingredientes consumidos.
    expect(entry.consumedIngredients).toHaveLength(1);
  });
});

describe("LogMealModal — pestaña Externa (confirmExternal, IA)", () => {
  async function estimate(holder: { current: Ctx | null }) {
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => { setNativeValue(textarea, "menú del día con lentejas y postre"); });
    await act(async () => { buttonByText("Estimar con IA").click(); await Promise.resolve(); await Promise.resolve(); });
    expect(holder.current).not.toBeNull();
  }

  it("una estimación de IA lleva nutrientes estimated (nunca known_*), un macro omitido unknown, y foodStateConfidence not_applicable", async () => {
    vi.mocked(estimateMealMacros).mockResolvedValue({
      kcal: 700, protein: 35, carbs: 80, fat: 0,
      nutrientStatus: { kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "unknown" }, // la IA omitió la grasa
      foodStateConfidence: "not_applicable",
    });
    const holder = await mount(() => {}, <LogMealModal onClose={() => {}} />);
    click(buttonByText("Externa"));
    await estimate(holder);
    click(buttonByText("Registrar"));
    const entry = entriesOf(holder)[0];
    expect(entry).toMatchObject({ name: "menú del día con lentejas y postre", kcal: 700, protein: 35, carbs: 80, fat: 0, source: "manual", qty: null });
    expect(entry.nutrientStatus).toEqual({ kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "unknown" });
    for (const key of MACROS) expect(KNOWN).not.toContain(entry.nutrientStatus?.[key]);
    expect(entry.foodStateConfidence).toBe("not_applicable");
  });

  it("un macro que la persona ajusta a mano sigue estimated (incluso el omitido, y vaciarlo no da known_zero)", async () => {
    vi.mocked(estimateMealMacros).mockResolvedValue({
      kcal: 700, protein: 35, carbs: 80, fat: 0,
      nutrientStatus: { kcal: "estimated", protein: "estimated", carbs: "estimated", fat: "unknown" },
      foodStateConfidence: "not_applicable",
    });
    const holder = await mount(() => {}, <LogMealModal onClose={() => {}} />);
    click(buttonByText("Externa"));
    await estimate(holder);
    const numberInputs = Array.from(container.querySelectorAll(".lm-ext-macros input")) as HTMLInputElement[]; // kcal, proteína, carbs, grasa
    act(() => { setNativeValue(numberInputs[3], "25"); }); // la grasa que la IA omitió
    act(() => { setNativeValue(numberInputs[1], ""); }); // vaciar proteína → 0
    click(buttonByText("Registrar"));
    const entry = entriesOf(holder)[0];
    expect(entry).toMatchObject({ fat: 25, protein: 0 });
    expect(entry.nutrientStatus?.fat).toBe("estimated");
    expect(entry.nutrientStatus?.protein).toBe("estimated");
    expect(entry.nutrientStatus?.kcal).toBe("estimated");
    for (const key of MACROS) expect(KNOWN).not.toContain(entry.nutrientStatus?.[key]);
  });
});

describe("EditLogModal — reescalar una entrada conserva su procedencia", () => {
  const base: FoodLogEntry = {
    id: "log-1", date: "2026-09-20", time: "13:00", name: "Pechuga de pollo", qty: 100, unit: "g",
    kcal: 165, protein: 0.4, carbs: 0, fat: 3.6, source: "manual", mealType: "lunch",
    nutrientStatus: { kcal: "known_nonzero", protein: "known_nonzero", carbs: "known_zero", fat: "known_nonzero" },
    foodStateConfidence: "confirmed",
    quantityConfidence: { level: "low", reason: "missing_unit_size" },
  };

  /** Monta el provider real, siembra `seed` y abre EditLogModal sobre esa entrada. */
  async function openEdit(seed: FoodLogEntry) {
    const { Capture, holder } = makeCapture();
    root = createRoot(container);
    await act(async () => { root!.render(<FoodOSProvider><Capture /></FoodOSProvider>); await Promise.resolve(); await Promise.resolve(); });
    act(() => { holder.current!.mutate((d) => { d.foodLog.push(structuredClone(seed)); }); });
    const entry = holder.current!.state.foodLog[0];
    await act(async () => {
      root!.render(<FoodOSProvider><Capture /><EditLogModal entry={entry} onClose={() => {}} /></FoodOSProvider>);
      await Promise.resolve(); await Promise.resolve();
    });
    return holder;
  }

  function saveWithQty(qty: string) {
    act(() => { setNativeValue(container.querySelector('input[type="number"]') as HTMLInputElement, qty); });
    click(buttonByText("Guardar cambios"));
  }

  it("con una cantidad normal, los estados, foodStateConfidence y quantityConfidence se conservan y los números se reescalan", async () => {
    const holder = await openEdit(base);
    saveWithQty("200");
    const saved = holder.current!.state.foodLog[0];
    expect(saved).toMatchObject({ qty: 200, kcal: 330, protein: 0.8, carbs: 0, fat: 7.2 });
    expect(saved.nutrientStatus).toEqual(base.nutrientStatus);
    expect(saved.foodStateConfidence).toBe("confirmed");
    expect(saved.quantityConfidence).toEqual({ level: "low", reason: "missing_unit_size" });
  });

  it("un known_nonzero que tras reescalar se redondea a 0 pasa a estimated (coherencia con el número)", async () => {
    const holder = await openEdit(base);
    saveWithQty("5"); // 5 g: protein 0.02 → 0
    const saved = holder.current!.state.foodLog[0];
    expect(saved.protein).toBe(0);
    expect(saved.nutrientStatus?.protein).toBe("estimated");
    expect(saved.nutrientStatus?.kcal).toBe("known_nonzero"); // 8 kcal > 0
    expect(saved.nutrientStatus?.carbs).toBe("known_zero");
  });

  it("una entrada anterior a PR3 (sin metadatos) no adquiere ninguno al editarla", async () => {
    const legacy: FoodLogEntry = { ...base, id: "log-legacy" };
    delete legacy.nutrientStatus;
    delete legacy.foodStateConfidence;
    delete legacy.quantityConfidence;
    const holder = await openEdit(legacy);
    saveWithQty("150");
    const saved = holder.current!.state.foodLog[0];
    expect(saved.kcal).toBe(248);
    expect("nutrientStatus" in saved).toBe(false);
    expect(saved.foodStateConfidence).toBeUndefined();
    expect(saved.quantityConfidence).toBeUndefined();
  });

  // §20.6, punto 4 — limpieza proactiva: una declaración de peso describe
  // la cantidad ORIGINAL; si esa cantidad cambia aquí, deja de describir la
  // entrada y se limpia. El adaptador (§20.7B) también se defendería solo,
  // pero esta limpieza evita que una entrada editada quede con un "high"
  // incoherente esperando a que la relectura lo detecte.
  it("§20.6 — cambiar qty retira un quantityConfidence:high (la declaración ya no describe la nueva cantidad)", async () => {
    const weighed: FoodLogEntry = { ...base, id: "log-weighed", qty: 200, unit: "g", quantityConfidence: { level: "high", declaredGrams: 200 } };
    const holder = await openEdit(weighed);
    saveWithQty("150");
    const saved = holder.current!.state.foodLog[0];
    expect(saved.qty).toBe(150);
    expect(saved.quantityConfidence).toEqual({ level: "low" });
  });

  it("§20.6 — guardar SIN cambiar qty (mismo valor) conserva el quantityConfidence:high tal cual", async () => {
    const weighed: FoodLogEntry = { ...base, id: "log-weighed-2", qty: 200, unit: "g", quantityConfidence: { level: "high", declaredGrams: 200 } };
    const holder = await openEdit(weighed);
    saveWithQty("200"); // mismo valor que baseQty — no es un cambio real
    const saved = holder.current!.state.foodLog[0];
    expect(saved.quantityConfidence).toEqual({ level: "high", declaredGrams: 200 });
  });

  it("un quantityConfidence:low (p. ej. missing_unit_size) se conserva sin cambios al reescalar — la limpieza es exclusiva de 'high'", async () => {
    const holder = await openEdit(base); // base ya tiene level:"low", reason:"missing_unit_size"
    saveWithQty("200");
    expect(holder.current!.state.foodLog[0].quantityConfidence).toEqual({ level: "low", reason: "missing_unit_size" });
  });

});

describe("HomeView — 'Plan de hoy' (logPlanEntry)", () => {
  it("registrar la receta planificada la etiqueta legacy_unlabeled, con los números de siempre", async () => {
    const holder = await mount((d) => {
      d.customRecipes.push(structuredClone(RECIPE));
      d.mealPlan[getToday(d)] = { lunch: RECIPE.id };
    }, <HomeView goTo={() => {}} openRecipe={() => {}} />);
    click(buttonByText("Registrar"));
    const entry = entriesOf(holder).find((e) => e.name === "Guiso de prueba PR3")!;
    expect(entry).toMatchObject({ kcal: 420, protein: 30, carbs: 55, fat: 10, source: "recipe", mealType: "lunch", qty: null, unit: null });
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    expect(entry.foodStateConfidence).toBe("unknown");
  });

  it("registrar un plato rápido planificado también es legacy_unlabeled", async () => {
    const holder = await mount((d) => {
      d.plannerQuickMeals.push({ id: "qm-1", name: "Bocata rápido", kcal: 350, protein: 20, carbs: 40, fat: 12, cost: 0 });
      d.mealPlan[getToday(d)] = { dinner: "qm-1" };
    }, <HomeView goTo={() => {}} openRecipe={() => {}} />);
    click(buttonByText("Registrar"));
    const entry = entriesOf(holder).find((e) => e.name === "Bocata rápido")!;
    expect(entry).toMatchObject({ kcal: 350, protein: 20, carbs: 40, fat: 12, mealType: "dinner" });
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
  });
});

describe("PlannerView — 'plato rápido' registrado en el diario (logEntry)", () => {
  it("un plato rápido registrado desde el planificador es legacy_unlabeled", async () => {
    const holder = await mount((d) => {
      d.plannerQuickMeals.push({ id: "qm-2", name: "Ensalada rápida", kcal: 220, protein: 8, carbs: 18, fat: 12, cost: 0 });
      d.mealPlan[getToday(d)] = { lunch: "qm-2" };
    }, <PlannerView />);
    click(container.querySelector(".planner-cell-log")!);
    const entry = entriesOf(holder).find((e) => e.name === "Ensalada rápida")!;
    expect(entry).toMatchObject({ kcal: 220, protein: 8, carbs: 18, fat: 12, source: "recipe", qty: null, unit: null });
    for (const key of MACROS) expect(entry.nutrientStatus?.[key]).toBe("legacy_unlabeled");
    expect(entry.foodStateConfidence).toBe("unknown");
  });
});

describe("SettingsView — datos de demostración (seedHistorico y 'Cargar datos demo')", () => {
  // Ambos botones están en el bloque «Solo admin» de SettingsView (isAdmin), no a la vista de cualquier usuario.
  const props = {
    isAdmin: true, theme: "light" as const, onToggleTheme: () => {}, onOpenAI: () => {}, aiConfigured: false,
    onShowOnboarding: () => {}, onStartTour: () => {}, onExportData: () => {}, onImportData: () => {}, onRestoreImportBackup: () => {},
  };

  it("'Sembrar 7 días de historial' escribe SOLO filas synthetic:true, sin ninguna procedencia real", async () => {
    const real: FoodLogEntry = {
      id: "real-1", date: "2026-09-10", time: "10:00", name: "Comida real", qty: null, unit: null,
      kcal: 400, protein: 20, carbs: 40, fat: 15, source: "manual", mealType: "breakfast",
    };
    const holder = await mount((d) => { d.foodLog.push({ ...real }); }, <SettingsView {...props} />);
    click(buttonByText("Sembrar 7 días de historial"));
    const log = entriesOf(holder);
    const seeded = log.filter((e) => e.id !== "real-1");
    expect(seeded).toHaveLength(21); // 7 días × 3 comidas
    for (const entry of seeded) {
      expect(entry.synthetic).toBe(true);
      expect(entry.nutrientStatus).toBeUndefined();
      expect(entry.foodStateConfidence).toBeUndefined();
    }
    // La entrada real preexistente no se toca ni se marca.
    expect(log.find((e) => e.id === "real-1")).toEqual(real);
    // Pulsar dos veces no duplica (guarda por fecha+nombre, como antes).
    click(buttonByText("Sembrar 7 días de historial"));
    expect(entriesOf(holder)).toHaveLength(22);
  });

  it("'Cargar datos demo' marca como synthetic:true todas las comidas del historial demo", async () => {
    const holder = await mount(() => {}, <SettingsView {...props} />);
    click(buttonByText("Cargar datos demo"));
    const log = entriesOf(holder);
    expect(log.length).toBeGreaterThan(0);
    for (const entry of log) {
      expect(entry.synthetic).toBe(true);
      expect(entry.nutrientStatus).toBeUndefined();
    }
  });
});
