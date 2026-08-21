"use client";

import { useState } from "react";
import type { PurchaseReviewItem } from "@/lib/state";
import { eur } from "@/lib/utils";
import { Modal } from "./Modal";

const STORES = ["Mercadona", "Lidl", "Aldi", "Carrefour", "Alcampo", "Frutería", "Carnicería", "Online"];

/** E10-03/05/07: repaso antes de confirmar una compra — productos,
    cantidades, precio real (distinto del estimado del carrito), tienda y
    caducidad propuesta, todo editable, con el total recalculándose. Sin
    esto, completar una compra aplicaba en silencio el precio que llevaba
    el item en el carrito (a veces desde hace días) y una caducidad
    adivinada, sin dar ocasión de corregir ninguno de los dos antes de que
    lleguen a Finanzas e Inventario. */
export function ReviewPurchaseModal({
  items,
  onClose,
  onConfirm,
}: {
  items: PurchaseReviewItem[];
  onClose: () => void;
  onConfirm: (reviewed: PurchaseReviewItem[]) => void;
}) {
  const [rows, setRows] = useState<PurchaseReviewItem[]>(items);

  function updateRow(cartItemId: string, patch: Partial<PurchaseReviewItem>) {
    setRows((prev) => prev.map((row) => (row.cartItemId === cartItemId ? { ...row, ...patch } : row)));
  }

  const total = rows.reduce((sum, row) => sum + Number(row.price || 0), 0);
  const estimatedTotal = rows.reduce((sum, row) => sum + Number(row.estimatedPrice || 0), 0);
  const hasNegative = rows.some((row) => Number(row.price) < 0 || Number.isNaN(row.price));

  return (
    <Modal title="Revisar compra" onClose={onClose}>
      <p className="form-intro">
        Confirma o corrige lo que pagaste de verdad por cada producto, la tienda y cuándo caduca —
        el precio del carrito era solo una estimación.
      </p>
      <div className="review-purchase-list">
        {rows.map((row) => {
          const priceChanged = Number(row.price) !== Number(row.estimatedPrice);
          return (
            <div key={row.cartItemId} className="review-purchase-row">
              <div className="review-purchase-name">
                <strong>{row.name}</strong>
                <small>{row.qty} {row.unit}</small>
              </div>
              <label className="review-purchase-field">
                Precio real
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={row.price}
                  onChange={(e) => updateRow(row.cartItemId, { price: Number(e.target.value) })}
                />
                {/* E10-07: nunca se presenta el precio estimado como definitivo —
                    mientras no se edite, se avisa de que sigue siendo una estimación. */}
                {!priceChanged && (
                  <small className="review-purchase-hint">estimado, no confirmado</small>
                )}
              </label>
              <label className="review-purchase-field">
                Tienda
                <select
                  value={row.store}
                  onChange={(e) => updateRow(row.cartItemId, { store: e.target.value })}
                >
                  {!STORES.includes(row.store) && <option value={row.store}>{row.store}</option>}
                  {STORES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="review-purchase-field">
                Caduca
                <input
                  type="date"
                  value={row.expires}
                  onChange={(e) => updateRow(row.cartItemId, { expires: e.target.value })}
                />
              </label>
            </div>
          );
        })}
      </div>
      <div className="review-purchase-total">
        <span>Total real: <strong>{eur(total)}</strong></span>
        {total !== estimatedTotal && (
          <small className="review-purchase-hint">estimado del carrito: {eur(estimatedTotal)}</small>
        )}
      </div>
      <div className="meta-row mt-12">
        <button className="secondary-button" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="primary-button"
          disabled={hasNegative}
          onClick={() => onConfirm(rows)}
        >
          Confirmar compra
        </button>
      </div>
    </Modal>
  );
}
