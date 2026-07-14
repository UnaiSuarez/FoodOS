"use client";

import { useState } from "react";
import type { InventoryItem, StorageName } from "@foodos/types";
import { isImageUrlReferencedElsewhere, useFoodOS } from "@/lib/state";
import { remote } from "@/lib/data-layer";
import { Modal } from "./Modal";
import { ImagePickerField } from "./ImagePickerField";

export function EditInventoryModal({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const { state, mutate, showToast } = useFoodOS();
  const [form, setForm] = useState({
    name: item.name,
    qty: item.qty,
    unit: item.unit,
    storage: item.storage as StorageName,
    expires: item.expires,
    price: item.price,
    kcal: item.kcal,
    protein: item.protein,
    unitSize: item.unitSize ?? 60,
    imageUrl: item.imageUrl as string | undefined,
  });

  function setField<K extends keyof typeof form>(key: K, val: typeof form[K]) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  function save() {
    if (!form.name.trim()) { showToast("El nombre no puede estar vacío"); return; }
    const newImageUrl = form.imageUrl?.trim() || undefined;
    // Si se reemplazó o quitó la foto, limpiar la anterior de Storage — salvo
    // que otro lote la siga usando (comprobado con el estado ANTES de mutar).
    if (item.imageUrl && item.imageUrl !== newImageUrl && !isImageUrlReferencedElsewhere(state, item.imageUrl, item.id)) {
      void remote.deleteProductImage(item.imageUrl);
    }
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
      it.unitSize = form.unit === "ud" ? form.unitSize : undefined;
      it.imageUrl = newImageUrl;
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
        {form.unit === "ud" && (
          <label>
            Tamaño por unidad (g/ml)
            <input
              type="number" min="1" step="1" value={form.unitSize}
              onChange={(e) => setField("unitSize", Number(e.target.value))}
            />
          </label>
        )}
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

      <ImagePickerField imageUrl={form.imageUrl} onChange={(url) => setField("imageUrl", url)} />
      <div className="recipe-detail-actions">
        <button className="secondary-button" onClick={onClose}>Cancelar</button>
        <button className="primary-button" onClick={save}>Guardar cambios</button>
      </div>
    </Modal>
  );
}
