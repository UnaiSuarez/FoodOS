"use client";

import { useMemo, useState } from "react";
import type { InventoryItem } from "@foodos/types";
import { actions, macrosForQuantity, useFoodOS } from "@/lib/state";
import { Modal } from "./Modal";

// Consumo parcial de un alimento: eliges cuanto y ves sus macros en vivo.
export function ConsumeModal({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const { mutate, showToast, setMascotMessage } = useFoodOS();
  const [qty, setQty] = useState(item.unit === "ud" ? 1 : Math.min(item.qty, 100));

  const safeQty = Math.max(0, Math.min(qty, item.qty));
  const macros = useMemo(() => macrosForQuantity(item, safeQty), [item, safeQty]);
  const remaining = Math.round((item.qty - safeQty) * 100) / 100;
  const pct = Math.round((safeQty / item.qty) * 100);

  const presets =
    item.unit === "ud"
      ? [1, Math.max(1, Math.round(item.qty / 2)), item.qty].filter((v, i, a) => a.indexOf(v) === i)
      : [Math.round(item.qty * 0.25), Math.round(item.qty * 0.5), item.qty].filter((v) => v > 0);

  return (
    <Modal title={`Consumir ${item.name}`} onClose={onClose}>
      <p className="consume-available">
        Tienes <strong>
          {item.qty} {item.unit}
        </strong>{" "}
        en {item.storage.toLowerCase()} · {item.kcal} kcal y {item.protein} g de proteína por 100 g.
      </p>

      <div className="consume-controls">
        <label>
          Cantidad ({item.unit})
          <input
            type="number"
            min="0"
            max={item.qty}
            step={item.unit === "ud" ? 1 : 5}
            value={qty}
            onChange={(event) => setQty(Number(event.target.value))}
            autoFocus
          />
        </label>
        <input
          className="consume-slider"
          type="range"
          min="0"
          max={item.qty}
          step={item.unit === "ud" ? 1 : 5}
          value={safeQty}
          onChange={(event) => setQty(Number(event.target.value))}
          aria-label="Cantidad a consumir"
        />
        <div className="consume-presets">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`filter ${safeQty === preset ? "active" : ""}`}
              onClick={() => setQty(preset)}
            >
              {preset === item.qty ? "Todo" : `${preset} ${item.unit}`}
            </button>
          ))}
        </div>
      </div>

      <div className="recipe-macros-row">
        <div className="macro-item">
          <span className="macro-val">{macros.kcal}</span>
          <span className="macro-lbl">kcal</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{macros.protein}g</span>
          <span className="macro-lbl">proteína</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">~{macros.carbs}g</span>
          <span className="macro-lbl">carbos est.</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">~{macros.fat}g</span>
          <span className="macro-lbl">grasas est.</span>
        </div>
      </div>

      <p className="consume-remaining">
        {remaining > 0 ? (
          <>
            Consumes el {pct}% — quedarán{" "}
            <strong>
              {remaining} {item.unit}
            </strong>{" "}
            en tu inventario.
          </>
        ) : (
          <>Consumes todo: el alimento se eliminará del inventario.</>
        )}
      </p>

      <div className="recipe-detail-actions">
        <button className="secondary-button" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="primary-button"
          disabled={safeQty <= 0}
          onClick={() => {
            mutate((draft) => actions.consumeInventoryItem(draft, item.id, safeQty));
            setMascotMessage("Consumo registrado en tu diario.");
            showToast(`${item.name}: ${safeQty} ${item.unit} registrados (${macros.kcal} kcal)`);
            onClose();
          }}
        >
          Registrar consumo
        </button>
      </div>
    </Modal>
  );
}
