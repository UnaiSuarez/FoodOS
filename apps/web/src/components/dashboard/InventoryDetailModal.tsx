"use client";

import { useState } from "react";
import type { InventoryItem } from "@foodos/types";
import { expiryBadge, matchAllergens, useFoodOS } from "@/lib/state";
import { daysUntil, eur } from "@/lib/utils";
import { Modal } from "./Modal";

interface Props {
  item: InventoryItem;
  onClose: () => void;
  onEdit: () => void;
  onConsume: () => void;
}

function NutrRow({ label, value, unit }: { label: string; value?: number; unit: string }) {
  if (value == null) return null;
  return (
    <div className="detail-nutr-row">
      <span className="detail-nutr-label">{label}</span>
      <span className="detail-nutr-value">{value}{unit}</span>
    </div>
  );
}

export function InventoryDetailModal({ item, onClose, onEdit, onConsume }: Props) {
  const { state } = useFoodOS();
  const [zoom, setZoom] = useState(false);
  const badge = expiryBadge(item.expires);
  const days = daysUntil(item.expires);
  const isWeightUnit = item.unit === "g" || item.unit === "ml";
  const allergenWarnings = matchAllergens(state, item.allergenTags);

  const totalKcal = isWeightUnit ? Math.round(item.kcal * item.qty / 100) : null;
  const totalProtein = isWeightUnit ? Math.round(item.protein * item.qty / 100 * 10) / 10 : null;
  const totalCarbs = (isWeightUnit && item.carbs != null) ? Math.round(item.carbs * item.qty / 100 * 10) / 10 : null;
  const totalFat = (isWeightUnit && item.fat != null) ? Math.round(item.fat * item.qty / 100 * 10) / 10 : null;

  const hasExtra = item.carbs != null || item.fat != null || item.salt != null ||
    item.fiber != null || item.sugars != null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card detail-modal" onClick={(e) => e.stopPropagation()}>

        <div className="modal-head">
          <h2 className="detail-name">{item.name}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Cerrar">×</button>
        </div>

        <div className="form-product-preview">
          <button
            type="button"
            className="image-picker-thumb"
            onClick={() => item.imageUrl && setZoom(true)}
            aria-label={item.imageUrl ? "Ver imagen más grande" : "Sin imagen"}
          >
            {item.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.imageUrl} alt="" />
            ) : (
              <span className="image-picker-placeholder" aria-hidden="true">🍽️</span>
            )}
          </button>
          {item.brand && <span className="form-product-brand">{item.brand}</span>}
        </div>

        {zoom && item.imageUrl && (
          <Modal title="Imagen del producto" onClose={() => setZoom(false)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.imageUrl} alt="" className="image-lightbox-full" />
          </Modal>
        )}

        {allergenWarnings.length > 0 && (
          <p className="allergen-warning" role="alert">
            ⚠ Contiene {allergenWarnings.join(", ")} — lo tienes marcado como alergia en tu perfil.
          </p>
        )}

        {/* Lote */}
        <section className="detail-section">
          <h3 className="detail-section-title">Lote</h3>
          <div className="detail-lote-grid">
            <div className="detail-lote-item">
              <span className="detail-lote-val">{item.qty}{item.unit}</span>
              <span className="detail-lote-lbl">Cantidad</span>
            </div>
            <div className="detail-lote-item">
              <span className="detail-lote-val">{item.storage}</span>
              <span className="detail-lote-lbl">Almacén</span>
            </div>
            <div className="detail-lote-item">
              <span className={`badge ${badge.cls}`}>{badge.label}</span>
              <span className="detail-lote-lbl">
                {days >= 0 ? `${item.expires}` : "Caducado"}
              </span>
            </div>
            <div className="detail-lote-item">
              <span className="detail-lote-val">{eur(item.price)}</span>
              <span className="detail-lote-lbl">Precio</span>
            </div>
          </div>
        </section>

        {/* Nutrición por 100g */}
        <section className="detail-section">
          <h3 className="detail-section-title">Por 100{item.unit === "ml" || item.unit === "L" ? "ml" : "g"}</h3>
          <div className="detail-nutr-grid">
            <NutrRow label="Energía" value={item.kcal} unit=" kcal" />
            <NutrRow label="Proteína" value={item.protein} unit="g" />
            {hasExtra && <>
              <NutrRow label="Hidratos" value={item.carbs} unit="g" />
              <NutrRow label="Grasas" value={item.fat} unit="g" />
              <NutrRow label="Azúcares" value={item.sugars} unit="g" />
              <NutrRow label="Fibra" value={item.fiber} unit="g" />
              <NutrRow label="Sal" value={item.salt} unit="g" />
            </>}
          </div>
          {!hasExtra && (
            <p className="detail-hint">
              Escanea el código de barras para obtener más nutrientes (grasas, hidratos, sal…)
            </p>
          )}
        </section>

        {/* Totales del lote */}
        {totalKcal !== null && (
          <section className="detail-section detail-totals">
            <h3 className="detail-section-title">Total lote ({item.qty}{item.unit})</h3>
            <div className="detail-nutr-grid">
              <NutrRow label="Energía" value={totalKcal} unit=" kcal" />
              <NutrRow label="Proteína" value={totalProtein ?? undefined} unit="g" />
              {totalCarbs != null && <NutrRow label="Hidratos" value={totalCarbs} unit="g" />}
              {totalFat != null && <NutrRow label="Grasas" value={totalFat} unit="g" />}
              <div className="detail-nutr-row">
                <span className="detail-nutr-label">Coste</span>
                <span className="detail-nutr-value">{eur(item.price)}</span>
              </div>
            </div>
          </section>
        )}

        <div className="detail-actions">
          <button className="secondary-button" onClick={onConsume}>Consumir</button>
          <button className="secondary-button" onClick={onEdit}>Editar</button>
          <button className="primary-button" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
