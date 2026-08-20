"use client";

import { useState, type KeyboardEvent } from "react";

// E18-08: patrón ARIA "Combobox with List Autocomplete" (APG) — los
// desplegables de sugerencias de esta app (Inventario, LogMealModal,
// PlannerAddMealModal) solo se podían elegir con el ratón (onMouseDown en
// cada <li>); no había forma de navegarlos ni elegir una opción con
// teclado, y el propio <input>/<ul> no llevaban ningún atributo ARIA de
// combobox — para un lector de pantalla eran una lista suelta sin relación
// con el campo de texto.
//
// Este hook solo lleva el índice resaltado y traduce flechas/Enter/Escape
// en índices sobre una lista PLANA de opciones — cada sitio sigue siendo
// dueño de sus propios datos y lógica de filtrado (que aquí varían: unas
// agrupan resultados de inventario/base local/Open Food Facts, otras no),
// solo hace falta que aplane su lista visible a un array antes de usarlo.
export function useComboboxKeyboard(
  optionCount: number,
  onSelect: (index: number) => void,
  onClose: () => void,
) {
  const [activeIndex, setActiveIndex] = useState(-1);

  function reset() {
    setActiveIndex(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (optionCount === 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % optionCount);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + optionCount) % optionCount);
        break;
      case "Enter":
        if (activeIndex >= 0 && activeIndex < optionCount) {
          // No preventDefault indiscriminado: en un <input> dentro de un
          // <form>, Enter sin una opción resaltada debe poder enviar el
          // formulario con normalidad (ver InventoryView, cuyo campo de
          // nombre vive dentro del form de alta rápida).
          event.preventDefault();
          onSelect(activeIndex);
          reset();
        }
        break;
      case "Escape":
        reset();
        onClose();
        break;
      default:
        break;
    }
  }

  return { activeIndex, onKeyDown, reset };
}
