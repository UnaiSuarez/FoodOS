"use client";

import { useRef, useState } from "react";
import type { CartItem } from "@foodos/types";
import { useFoodOS } from "@/lib/state";
import { Modal } from "./Modal";

const DEFAULT_STORES = ["Mercadona", "Lidl", "Frutería", "Carnicería", "Otro"];

export function EditCartItemModal({ item, onClose }: { item: CartItem; onClose: () => void }) {
  const { mutate, showToast } = useFoodOS();
  const [name, setName] = useState(item.name);
  const [qty, setQty] = useState(item.qty);
  const [unit, setUnit] = useState(item.unit);
  const [price, setPrice] = useState(item.price);
  const [store, setStore] = useState(item.store);
  // Precio unitario para regla de 3
  const unitPriceRef = useRef<number>(item.qty > 0 ? item.price / item.qty : 0);

  function handleQtyChange(newQty: number) {
    setQty(newQty);
    if (unitPriceRef.current > 0 && newQty > 0) {
      setPrice(Math.round(unitPriceRef.current * newQty * 100) / 100);
    }
  }

  function handlePriceChange(newPrice: number) {
    setPrice(newPrice);
    unitPriceRef.current = qty > 0 ? newPrice / qty : 0;
  }

  function save() {
    if (!name.trim()) { showToast("El nombre no puede estar vacío"); return; }
    mutate((draft) => {
      const c = draft.cart.find((x) => x.id === item.id);
      if (!c) return;
      c.name = name.trim();
      c.qty = qty;
      c.unit = unit;
      c.price = price;
      c.store = store;
    });
    showToast("Ítem actualizado");
    onClose();
  }

  return (
    <Modal title="Editar ítem del carrito" onClose={onClose}>
      <div className="form-grid compact">
        <label>
          Producto
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Cantidad
          <input
            type="number" min="0" step="0.1" value={qty}
            onChange={(e) => handleQtyChange(Number(e.target.value))}
          />
        </label>
        <label>
          Unidad
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {["ud", "g", "kg", "ml", "L", "oz", "lb"].map((u) => <option key={u}>{u}</option>)}
          </select>
        </label>
        <label>
          Precio €
          <input
            type="number" step="0.01" min="0" value={price}
            onChange={(e) => handlePriceChange(Number(e.target.value))}
          />
        </label>
        <label>
          Tienda
          <select value={store} onChange={(e) => setStore(e.target.value)}>
            {DEFAULT_STORES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <div className="recipe-detail-actions">
        <button className="secondary-button" onClick={onClose}>Cancelar</button>
        <button className="primary-button" onClick={save}>Guardar cambios</button>
      </div>
    </Modal>
  );
}
