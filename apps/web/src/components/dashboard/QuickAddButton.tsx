"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dumbbell, NotebookPen, Package, Plus, Receipt, Scale } from "lucide-react";
import { Modal } from "./Modal";
import { setQuickAddSignal, type QuickAddType } from "@/lib/quick-add-signal";

interface QuickAddOption {
  type: QuickAddType | null;
  label: string;
  icon: typeof Plus;
  path: string;
}

// E04-04: acción universal "Añadir" — antes registrar una comida, un
// alimento, el peso, un gasto o una sesión exigía primero navegar a la
// sección correspondiente para encontrar el botón/formulario correcto. Este
// botón vive en la cabecera (visible en cualquier vista) y navega +
// deja la señal (ver quick-add-signal.ts) que la vista de destino consume
// para abrir/enfocar su formulario de alta nada más montar.
const OPTIONS: QuickAddOption[] = [
  { type: "meal", label: "Registrar comida", icon: NotebookPen, path: "/dashboard/diary" },
  { type: "food", label: "Añadir alimento", icon: Package, path: "/dashboard/inventory" },
  { type: "weight", label: "Registrar peso", icon: Scale, path: "/dashboard/nutrition" },
  { type: "expense", label: "Añadir gasto", icon: Receipt, path: "/dashboard/finance" },
  // Registrar una sesión exige elegir antes QUÉ rutina — no hay un "log
  // genérico" al que saltar sin ese dato, así que esta opción solo navega
  // (sin señal) y deja elegir la rutina en Ejercicios.
  { type: null, label: "Registrar sesión de entreno", icon: Dumbbell, path: "/dashboard/ejercicios" },
];

export function QuickAddButton() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  function choose(option: QuickAddOption) {
    if (option.type) setQuickAddSignal(option.type);
    setOpen(false);
    router.push(option.path);
  }

  return (
    <>
      <button
        type="button"
        className="icon-button quick-add-btn"
        aria-label="Añadir"
        title="Añadir…"
        onClick={() => setOpen(true)}
      >
        <Plus size={20} aria-hidden="true" />
      </button>
      {open && (
        <Modal title="Añadir" onClose={() => setOpen(false)}>
          <ul className="quick-add-list">
            {OPTIONS.map((option) => (
              <li key={option.label}>
                <button type="button" className="quick-add-option" onClick={() => choose(option)}>
                  <option.icon size={18} aria-hidden="true" />
                  {option.label}
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}
