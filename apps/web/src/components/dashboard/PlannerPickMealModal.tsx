"use client";

import { useState } from "react";
import type { Recipe } from "@foodos/types";
import { eur } from "@/lib/utils";
import { Modal } from "./Modal";

interface Props {
  /** «Añadir: Desayuno · viernes 16 de octubre» (franja y fecha reales del hueco). */
  title: string;
  recipes: Recipe[];
  /** Nombre de la entrada que se sustituiría; undefined = el hueco está vacío. */
  replacingName?: string;
  onPick: (recipeId: string) => void;
  onNewQuick: () => void;
  onClose: () => void;
}

/**
 * Elige receta para un hueco concreto (añadir o cambiar). Solo edita el plan:
 * quien llama aplica `setMeal` al pulsar «Elegir»; cancelar/cerrar no toca nada
 * y, por tanto, conserva la entrada anterior.
 */
export function PlannerPickMealModal({ title, recipes, replacingName, onPick, onNewQuick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const list = query.trim() ? recipes.filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase())) : recipes;
  const verb = replacingName ? "Cambiar por esta" : "Elegir";

  return (
    <Modal title={title} onClose={onClose}>
      <div className="pl-modal">
        {replacingName && (
          <p className="pl-note" role="note">
            Solo se sustituye <strong>{replacingName}</strong> en este hueco. Si cancelas, se conserva.
          </p>
        )}
        <input
          type="search"
          className="pl-search"
          placeholder="Buscar receta…"
          aria-label="Buscar recetas"
          data-modal-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="pl-pick-list">
          {list.map((r) => (
            <li key={r.id} className="pl-pick-row">
              <span className="pl-pick-text">
                <span className="pl-pick-name">{r.title}</span>
                <span className="pl-pick-meta">{r.kcal} kcal · {r.protein} g P · {eur(r.cost)}</span>
              </span>
              <button type="button" className="pl-btn pl-btn-primary" aria-label={`${verb} ${r.title}`} onClick={() => onPick(r.id)}>
                {replacingName ? "Cambiar" : "Elegir"}
              </button>
            </li>
          ))}
        </ul>
        {list.length === 0 && <p className="pl-empty">Sin resultados.</p>}
        <div className="pl-modal-foot">
          <button type="button" className="pl-btn" onClick={onNewQuick}>
            {replacingName ? "Sustituir por un plato rápido…" : "Crear plato rápido…"}
          </button>
          <button type="button" className="pl-btn" onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </Modal>
  );
}
