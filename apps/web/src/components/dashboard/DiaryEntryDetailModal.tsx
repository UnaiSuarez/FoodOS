"use client";

import type { FoodLogEntry, MealType } from "@foodos/types";
import { useFoodOS } from "@/lib/state";
import { Modal } from "./Modal";

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: "🌅 Desayuno",
  lunch:     "☀️ Comida",
  snack:     "🌤 Snack",
  dinner:    "🌙 Cena",
};

const MEAL_CLS: Record<MealType, string> = {
  breakfast: "breakfast",
  lunch:     "lunch",
  snack:     "snack",
  dinner:    "dinner",
};

const SOURCE_ICONS:  Record<string, string> = { recipe: "🍽", inventory: "🥕", manual: "🥘" };
const SOURCE_LABELS: Record<string, string> = { recipe: "Receta cocinada", inventory: "Del inventario", manual: "Registro manual" };

interface Props {
  entry: FoodLogEntry;
  onClose: () => void;
  onEdit: () => void;
}

export function DiaryEntryDetailModal({ entry, onClose, onEdit }: Props) {
  const { mutate, showToast } = useFoodOS();

  // Caloric contribution for the macro bar
  const cals = entry.protein * 4 + entry.carbs * 4 + entry.fat * 9;
  const protPct  = cals > 0 ? Math.round((entry.protein * 4 / cals) * 100) : 0;
  const carbsPct = cals > 0 ? Math.round((entry.carbs  * 4 / cals) * 100) : 0;
  const fatPct   = cals > 0 ? Math.round((entry.fat    * 9 / cals) * 100) : 0;

  function handleDelete() {
    mutate((draft) => {
      if (entry.source === "inventory" && (entry.qty ?? 0) > 0) {
        const matches = draft.inventory.filter((item) => {
          const n = item.name.toLowerCase();
          const en = entry.name.toLowerCase();
          return n === en || n.includes(en.split(" ")[0]) || en.includes(n.split(" ")[0]);
        });
        if (matches.length > 0) {
          matches[0].qty = Math.round((matches[0].qty + (entry.qty ?? 0)) * 100) / 100;
        }
      }
      draft.foodLog = draft.foodLog.filter((x) => x.id !== entry.id);
    });
    showToast(
      entry.source === "inventory"
        ? "Comida eliminada · cantidad devuelta al inventario"
        : "Comida eliminada"
    );
    onClose();
  }

  return (
    <Modal title={entry.name} onClose={onClose}>
      <div className="diary-detail">
        {/* Meta: source + meal + time */}
        <div className="diary-detail-meta">
          <span className="diary-detail-source">
            {SOURCE_ICONS[entry.source] ?? "🍽"} {SOURCE_LABELS[entry.source] ?? entry.source}
          </span>
          <span className={`meal-chip ${MEAL_CLS[entry.mealType] ?? ""} active`}>
            {MEAL_LABELS[entry.mealType] ?? entry.mealType}
          </span>
          <span className="diary-detail-time">{entry.time} · {entry.date}</span>
        </div>

        {entry.qty != null && (
          <p className="diary-detail-qty">
            {entry.qty} <span>{entry.unit ?? "g"}</span>
          </p>
        )}

        {/* Main kcal + macro grid */}
        <div className="diary-detail-macros">
          <div className="diary-detail-kcal-block">
            <span className="diary-detail-kcal-val">{Math.round(entry.kcal)}</span>
            <span className="diary-detail-kcal-lbl">kcal</span>
          </div>
          <div className="diary-detail-macro-grid">
            {[
              { val: entry.protein, label: "proteína", pct: protPct,  cls: "prot" },
              { val: entry.carbs,   label: "carbos",   pct: carbsPct, cls: "carb" },
              { val: entry.fat,     label: "grasas",   pct: fatPct,   cls: "fat"  },
            ].map(({ val, label, pct, cls }) => (
              <div key={cls} className={`diary-detail-macro-item diary-detail-macro-${cls}`}>
                <span className="diary-detail-macro-val">{Math.round(val * 10) / 10}g</span>
                <span className="diary-detail-macro-lbl">{label}</span>
                <span className="diary-detail-macro-pct">{pct}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* Macro bar */}
        <div className="diary-detail-bar" title={`Proteína ${protPct}% · Carbos ${carbsPct}% · Grasas ${fatPct}%`}>
          <div className="diary-detail-bar-prot" style={{ width: `${protPct}%` }} />
          <div className="diary-detail-bar-carb" style={{ width: `${carbsPct}%` }} />
          <div className="diary-detail-bar-fat"  style={{ width: `${fatPct}%`  }} />
        </div>

        <div className="recipe-detail-actions">
          <button className="small-action bad" type="button" onClick={handleDelete} style={{ marginRight: "auto" }}>
            Eliminar
          </button>
          <button className="secondary-button" onClick={onClose}>Cerrar</button>
          <button className="primary-button" onClick={() => { onClose(); onEdit(); }}>
            Editar cantidad
          </button>
        </div>
      </div>
    </Modal>
  );
}
