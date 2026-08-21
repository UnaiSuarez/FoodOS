"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Apple, CalendarDays, ChefHat, Dumbbell, LayoutDashboard, NotebookPen, Package, Search,
  Settings, ShoppingCart, Sparkles, TrendingUp, Wallet, type LucideIcon,
} from "lucide-react";
import { allRecipes, useFoodOS } from "@/lib/state";
import { VIEWS } from "@/lib/dashboard-views";
import { useComboboxKeyboard } from "@/lib/use-combobox-keyboard";
import { setOpenRecipeSignal } from "@/lib/open-recipe-signal";
import { Modal } from "./Modal";

const VIEW_ICONS: Record<string, LucideIcon> = {
  "layout-dashboard": LayoutDashboard, "notebook-pen": NotebookPen, package: Package,
  "chef-hat": ChefHat, "shopping-cart": ShoppingCart, apple: Apple, wallet: Wallet,
  "trending-up": TrendingUp, "calendar-days": CalendarDays, dumbbell: Dumbbell, sparkles: Sparkles,
};

interface SearchResult {
  key: string;
  section: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

// E04-10/11/12: buscador global — antes encontrar una receta, un alimento
// del inventario o una rutina exigía saber de antemano en qué sección
// vive y navegar hasta allí a ciegas. Busca en recetas, inventario,
// rutinas y las propias secciones de la app a la vez, y lleva
// directamente al resultado (no solo a su sección — ver
// open-recipe-signal.ts para por qué hace falta una señal aparte).
export function GlobalSearchModal({ onClose }: { onClose: () => void }) {
  const { state } = useFoodOS();
  const router = useRouter();
  const [query, setQuery] = useState("");

  function go(path: string) {
    onClose();
    router.push(path);
  }

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    const out: SearchResult[] = [];

    for (const view of VIEWS) {
      if (view.label.toLowerCase().includes(q)) {
        out.push({
          key: `view-${view.id}`,
          section: "Sección",
          label: view.title,
          icon: VIEW_ICONS[view.icon] ?? LayoutDashboard,
          onSelect: () => go(view.id === "dashboard" ? "/dashboard" : `/dashboard/${view.id}`),
        });
      }
    }
    if ("ajustes".includes(q)) {
      out.push({ key: "view-settings", section: "Sección", label: "Ajustes de la app", icon: Settings, onSelect: () => go("/dashboard/settings") });
    }

    for (const recipe of allRecipes(state)) {
      if (out.filter((r) => r.section === "Receta").length >= 6) break;
      if (recipe.title.toLowerCase().includes(q)) {
        out.push({
          key: `recipe-${recipe.id}`,
          section: "Receta",
          label: recipe.title,
          icon: ChefHat,
          onSelect: () => { setOpenRecipeSignal(recipe.id); go("/dashboard/recipes"); },
        });
      }
    }

    const seenFood = new Set<string>();
    for (const item of state.inventory) {
      if (out.filter((r) => r.section === "Alimento").length >= 6) break;
      const key = item.name.toLowerCase();
      if (seenFood.has(key) || !key.includes(q)) continue;
      seenFood.add(key);
      out.push({
        key: `food-${item.id}`,
        section: "Alimento",
        label: item.name,
        icon: Package,
        onSelect: () => go("/dashboard/inventory"),
      });
    }

    for (const routine of state.routines ?? []) {
      if (out.filter((r) => r.section === "Rutina").length >= 6) break;
      if (routine.name.toLowerCase().includes(q)) {
        out.push({
          key: `routine-${routine.id}`,
          section: "Rutina",
          label: routine.name,
          icon: Dumbbell,
          onSelect: () => go("/dashboard/ejercicios"),
        });
      }
    }

    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, state.inventory, state.customRecipes, state.routines]);

  const combobox = useComboboxKeyboard(results.length, (index) => results[index]?.onSelect(), onClose);

  return (
    <Modal title="Buscar" onClose={onClose}>
      <div className="global-search">
        <div className="global-search-input-wrap">
          <Search size={16} aria-hidden="true" />
          <input
            data-modal-autofocus="true"
            type="text"
            placeholder="Recetas, alimentos, rutinas, secciones…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); combobox.reset(); }}
            onKeyDown={combobox.onKeyDown}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="global-search-listbox"
            aria-autocomplete="list"
            aria-activedescendant={combobox.activeIndex >= 0 ? `global-search-option-${combobox.activeIndex}` : undefined}
            aria-label="Buscar en FoodOS"
          />
        </div>
        {query.trim().length > 0 && (
          results.length > 0 ? (
            <ul className="global-search-results" role="listbox" id="global-search-listbox" aria-label="Resultados de la búsqueda">
              {results.map((r, i) => (
                <li
                  key={r.key}
                  id={`global-search-option-${i}`}
                  role="option"
                  aria-selected={i === combobox.activeIndex}
                  className={`global-search-item${i === combobox.activeIndex ? " active" : ""}`}
                  onMouseDown={r.onSelect}
                >
                  <r.icon size={16} aria-hidden="true" />
                  <span className="global-search-item-label">{r.label}</span>
                  <span className="global-search-item-section">{r.section}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Sin resultados para "{query}".</p>
          )
        )}
      </div>
    </Modal>
  );
}
