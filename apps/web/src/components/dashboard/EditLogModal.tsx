"use client";

import { useMemo, useState } from "react";
import type { FoodLogEntry } from "@foodos/types";
import { actions, useFoodOS } from "@/lib/state";
import { Modal } from "./Modal";

interface Props {
  entry: FoodLogEntry;
  onClose: () => void;
}

export function EditLogModal({ entry, onClose }: Props) {
  const { state, mutate, showToast } = useFoodOS();
  const baseQty = entry.qty ?? 100;
  const [qty, setQty] = useState(baseQty);

  const unit = entry.unit ?? "g";
  const isUnit = unit === "ud";
  const step = isUnit ? 1 : 5;

  // For inventory entries: find matching lots and calculate available stock
  const inventoryAvailable = useMemo(() => {
    if (entry.source !== "inventory") return Infinity;
    return state.inventory
      .filter((item) => {
        const n = item.name.toLowerCase();
        const e = entry.name.toLowerCase();
        return n === e || n.includes(e.split(" ")[0]) || e.includes(n.split(" ")[0]);
      })
      .reduce((sum, item) => sum + item.qty, 0);
  }, [entry, state.inventory]);

  // Max = original logged + what's still in inventory
  const maxQty = entry.source === "inventory"
    ? Math.round((baseQty + inventoryAvailable) * 10) / 10
    : Math.max(baseQty * 4, isUnit ? 10 : 1000);

  const scale = baseQty > 0 ? qty / baseQty : 0;
  const preview = {
    kcal: Math.round(entry.kcal * scale),
    protein: Math.round(entry.protein * scale * 10) / 10,
    carbs: Math.round(entry.carbs * scale * 10) / 10,
    fat: Math.round(entry.fat * scale * 10) / 10,
  };

  function handleChange(val: number) {
    setQty(Math.min(maxQty, Math.max(0, val)));
  }

  function save() {
    const delta = qty - baseQty; // positive = consuming more, negative = returning
    mutate((draft) => {
      // Update log entry
      const e = draft.foodLog.find((x) => x.id === entry.id);
      if (!e) return;
      e.qty = qty;
      e.kcal = preview.kcal;
      e.protein = preview.protein;
      e.carbs = preview.carbs;
      e.fat = preview.fat;

      // Sync inventory if this entry came from inventory
      if (entry.source === "inventory" && delta !== 0) {
        const matches = draft.inventory
          .filter((item) => {
            const n = item.name.toLowerCase();
            const en = entry.name.toLowerCase();
            return n === en || n.includes(en.split(" ")[0]) || en.includes(n.split(" ")[0]);
          })
          .sort((a, b) => a.expires.localeCompare(b.expires));

        if (delta > 0) {
          // Deduct more from inventory (FIFO)
          let remaining = delta;
          for (const match of matches) {
            if (remaining <= 0) break;
            const take = Math.min(match.qty, remaining);
            match.qty = Math.round((match.qty - take) * 100) / 100;
            remaining -= take;
          }
          draft.inventory = draft.inventory.filter((i) => i.qty > 0);
        } else {
          // Return to inventory: add back to matching lot, or recreate it if it was fully consumed
          actions.returnQtyToInventory(draft, entry, Math.abs(delta));
        }
      }
    });
    showToast("Entrada actualizada");
    onClose();
  }

  function deleteEntry() {
    mutate((draft) => {
      actions.returnEntryToInventory(draft, entry);
      draft.foodLog = draft.foodLog.filter((x) => x.id !== entry.id);
    });
    showToast("Entrada eliminada");
    onClose();
  }

  return (
    <Modal title={`Editar: ${entry.name}`} onClose={onClose}>
      <div className="consume-controls">
        <label>
          Cantidad ({unit})
          {entry.source === "inventory" && (
            <small style={{ color: "var(--muted)", marginLeft: 8 }}>
              máx. {maxQty} {unit}
            </small>
          )}
          <input
            type="number"
            min="0"
            max={maxQty}
            step={step}
            value={qty}
            onChange={(e) => handleChange(Number(e.target.value))}
            autoFocus
          />
        </label>
        <input
          className="consume-slider"
          type="range"
          min="0"
          max={maxQty}
          step={step}
          value={qty}
          onChange={(e) => handleChange(Number(e.target.value))}
        />
      </div>

      <div className="recipe-macros-row">
        <div className="macro-item">
          <span className="macro-val">{preview.kcal}</span>
          <span className="macro-lbl">kcal</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{preview.protein}g</span>
          <span className="macro-lbl">proteína</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{preview.carbs}g</span>
          <span className="macro-lbl">carbos</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{preview.fat}g</span>
          <span className="macro-lbl">grasas</span>
        </div>
      </div>

      <div className="recipe-detail-actions">
        <button
          className="small-action bad"
          type="button"
          onClick={deleteEntry}
          style={{ marginRight: "auto" }}
        >
          Eliminar
        </button>
        <button className="secondary-button" onClick={onClose}>Cancelar</button>
        <button className="primary-button" onClick={save}>Guardar cambios</button>
      </div>
    </Modal>
  );
}
