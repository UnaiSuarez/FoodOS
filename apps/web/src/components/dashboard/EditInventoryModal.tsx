"use client";

import { useState } from "react";
import type { InventoryItem, StorageName } from "@foodos/types";
import { useFoodOS } from "@/lib/state";
import { Modal } from "./Modal";

export function EditInventoryModal({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const { mutate, showToast } = useFoodOS();
  const [form, setForm] = useState({
    name: item.name,
    qty: item.qty,
    unit: item.unit,
    storage: item.storage as StorageName,
    expires: item.expires,
    price: item.price,
    kcal: item.kcal,
    protein: item.protein,
  });

  function setField<K extends keyof typeof form>(key: K, val: typeof form[K]) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function save() {
    if (!form.name.trim()) { showToast("El nombre no puede estar vacío"); return; }
    mutate((draft) => {
      const it = draft.inventory.find((x) => x.id === item.id);
      if (!it) return;
      it.name = form.name.trim();
      it.qty = form.qty;
      it.unit = form.unit;
      it.storage = form.storage;
      it.expires = form.expires;
      it.price = form.price;
      it.kcal = form.kcal;
      it.protein = form.protein;
    });
    showToast("Alimento actualizado");
    onClose();
  }

  return (
    <Modal title="Editar alimento" onClose={onClose}>
      <div className="form-grid">
        <label>
          Nombre
          <input value={form.name} onChange={(e) => setField("name", e.target.value)} required />
        </label>
        <label>
          Cantidad
          <input
            type="number" min="0" step="0.1" value={form.qty}
            onChange={(e) => setField("qty", Number(e.target.value))}
          />
        </label>
        <label>
          Unidad
          <select value={form.unit} onChange={(e) => setField("unit", e.target.value)}>
            <option>g</option><option>ml</option><option>ud</option><option>kg</option><option>L</option>
          </select>
        </label>
        <label>
          Almacén
          <select value={form.storage} onChange={(e) => setField("storage", e.target.value as StorageName)}>
            <option>Nevera</option><option>Congelador</option><option>Despensa</option>
          </select>
        </label>
        <label>
          Caduca
          <input type="date" value={form.expires} onChange={(e) => setField("expires", e.target.value)} />
        </label>
        <label>
          Precio €
          <input type="number" step="0.01" min="0" value={form.price} onChange={(e) => setField("price", Number(e.target.value))} />
        </label>
        <label>
          kcal/100g
          <input type="number" min="0" value={form.kcal} onChange={(e) => setField("kcal", Number(e.target.value))} />
        </label>
        <label>
          Proteína/100g
          <input type="number" min="0" step="0.1" value={form.protein} onChange={(e) => setField("protein", Number(e.target.value))} />
        </label>
      </div>
      <div className="recipe-detail-actions">
        <button className="secondary-button" onClick={onClose}>Cancelar</button>
        <button className="primary-button" onClick={save}>Guardar cambios</button>
      </div>
    </Modal>
  );
}
