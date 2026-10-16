"use client";

import { useState } from "react";
import { Modal } from "./Modal";

export interface PlaceOption {
  dateKey: string;
  label: string;
}

export interface PlaceSlot {
  key: string;
  label: string;
}

interface Props {
  recipeTitle: string;
  days: PlaceOption[];
  slots: PlaceSlot[];
  initialDateKey: string;
  /** Nombre de lo que hay hoy en ese día/franja, o null si está libre. */
  occupant: (dateKey: string, slot: string) => string | null;
  onConfirm: (dateKey: string, slot: string) => void;
  onClose: () => void;
}

/** Alternativa completa a arrastrar: elige día y franja con controles nativos. */
export function PlannerPlaceModal({ recipeTitle, days, slots, initialDateKey, occupant, onConfirm, onClose }: Props) {
  const [dateKey, setDateKey] = useState(initialDateKey);
  const [slot, setSlot] = useState(slots[0].key);
  const current = occupant(dateKey, slot);

  return (
    <Modal title={`Colocar ${recipeTitle}`} onClose={onClose}>
      <div className="pl-modal">
        <div className="pl-field">
          <label htmlFor="pl-place-day">Día</label>
          <select id="pl-place-day" data-modal-autofocus value={dateKey} onChange={(e) => setDateKey(e.target.value)}>
            {days.map((d) => <option key={d.dateKey} value={d.dateKey}>{d.label}</option>)}
          </select>
        </div>
        <div className="pl-field">
          <label htmlFor="pl-place-slot">Franja</label>
          <select id="pl-place-slot" value={slot} onChange={(e) => setSlot(e.target.value)}>
            {slots.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        <p className="pl-note" role="status">
          {current ? <>Reemplazará solo <strong>{current}</strong> en esa franja.</> : "Esa franja está libre."}
        </p>
        <div className="pl-modal-foot">
          <button type="button" className="pl-btn" onClick={onClose}>Cancelar</button>
          <button type="button" className="pl-btn pl-btn-primary" onClick={() => onConfirm(dateKey, slot)}>Colocar</button>
        </div>
      </div>
    </Modal>
  );
}
