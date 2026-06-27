"use client";

import { useState } from "react";
import type { StorageName } from "@foodos/types";
import type { ScannedItem } from "@/lib/ai-inventory";
import { useFoodOS } from "@/lib/state";
import { uid, todayPlus } from "@/lib/utils";

interface Props {
  items: ScannedItem[];
  onClose: () => void;
}

const STORAGES: StorageName[] = ["Nevera", "Congelador", "Despensa"];

export function BulkImportModal({ items, onClose }: Props) {
  const { mutate, showToast } = useFoodOS();
  const [selected, setSelected] = useState<Set<number>>(new Set(items.map((_, i) => i)));
  const [editedItems, setEditedItems] = useState<ScannedItem[]>(items);

  function toggleItem(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function updateItem(index: number, field: keyof ScannedItem, value: string | number) {
    setEditedItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function importSelected() {
    const toImport = editedItems.filter((_, i) => selected.has(i));
    if (toImport.length === 0) return;
    mutate((draft) => {
      for (const item of toImport) {
        draft.inventory.push({
          id: uid(),
          name: item.name,
          qty: item.qty,
          unit: item.unit,
          storage: item.storage,
          expires: todayPlus(item.expiryDays),
          price: item.price,
          kcal: item.kcal,
          protein: item.protein,
        });
      }
    });
    showToast(`${toImport.length} producto${toImport.length !== 1 ? "s" : ""} añadido${toImport.length !== 1 ? "s" : ""} al inventario`);
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal bulk-import-modal">
        <div className="modal-head">
          <h2>🧾 Productos detectados</h2>
          <button className="close-btn" onClick={onClose} aria-label="Cerrar">✕</button>
        </div>

        <p className="bulk-hint">
          {items.length > 0
            ? `${items.length} producto${items.length !== 1 ? "s" : ""} detectado${items.length !== 1 ? "s" : ""}. Edita si es necesario y marca los que quieras importar.`
            : "No se detectaron alimentos en la imagen."}
        </p>

        {items.length > 0 && (
          <>
            <div className="bulk-list">
              {editedItems.map((item, i) => (
                <label key={i} className={`bulk-item ${selected.has(i) ? "selected" : ""}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(i)}
                    onChange={() => toggleItem(i)}
                    className="bulk-checkbox"
                  />
                  <div className="bulk-fields">
                    <input
                      className="bulk-name"
                      value={item.name}
                      onChange={(e) => updateItem(i, "name", e.target.value)}
                      placeholder="Nombre del producto"
                    />
                    <div className="bulk-row">
                      <input
                        type="number"
                        className="bulk-qty"
                        value={item.qty}
                        onChange={(e) => updateItem(i, "qty", Number(e.target.value))}
                        min="0"
                        title="Cantidad"
                      />
                      <select
                        className="bulk-unit"
                        value={item.unit}
                        onChange={(e) => updateItem(i, "unit", e.target.value)}
                      >
                        <option>g</option>
                        <option>ml</option>
                        <option>ud</option>
                        <option>kg</option>
                        <option>L</option>
                      </select>
                      <select
                        className="bulk-storage"
                        value={item.storage}
                        onChange={(e) => updateItem(i, "storage", e.target.value as StorageName)}
                      >
                        {STORAGES.map((s) => <option key={s}>{s}</option>)}
                      </select>
                      <input
                        type="number"
                        className="bulk-num"
                        value={item.kcal}
                        onChange={(e) => updateItem(i, "kcal", Number(e.target.value))}
                        min="0"
                        title="kcal por 100g"
                        placeholder="kcal"
                      />
                      <span className="bulk-label">kcal</span>
                      <input
                        type="number"
                        className="bulk-num"
                        value={item.protein}
                        onChange={(e) => updateItem(i, "protein", Number(e.target.value))}
                        min="0"
                        title="Proteína g por 100g"
                        placeholder="prot"
                      />
                      <span className="bulk-label">g prot</span>
                      <input
                        type="number"
                        className="bulk-num bulk-price"
                        value={item.price}
                        onChange={(e) => updateItem(i, "price", Number(e.target.value))}
                        min="0"
                        step="0.01"
                        title="Precio €"
                        placeholder="€"
                      />
                      <span className="bulk-label">€</span>
                    </div>
                  </div>
                </label>
              ))}
            </div>

            <div className="modal-actions">
              <button className="secondary-button" onClick={onClose}>Cancelar</button>
              <button
                className="primary-button"
                onClick={importSelected}
                disabled={selected.size === 0}
              >
                Importar {selected.size > 0 ? `${selected.size} ` : ""}producto{selected.size !== 1 ? "s" : ""}
              </button>
            </div>
          </>
        )}

        {items.length === 0 && (
          <div className="modal-actions">
            <button className="primary-button" onClick={onClose}>Cerrar</button>
          </div>
        )}
      </div>
    </div>
  );
}
