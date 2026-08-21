"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useInertBackground } from "@/lib/use-inert-background";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Elementos enfocables visibles dentro del modal (offsetParent null = oculto).
  function focusables(): HTMLElement[] {
    const overlay = overlayRef.current;
    if (!overlay) return [];
    return [...overlay.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (el) => !el.hasAttribute("disabled") && el.offsetParent !== null
    );
  }

  // E18-09: bloquea de verdad (foco, puntero y árbol de accesibilidad) todo
  // lo que quede fuera del modal — ver el comentario de use-inert-background.ts.
  useInertBackground(overlayRef);

  // Gestión de foco: al abrir, entra al modal; al cerrar, vuelve al elemento
  // que lo abrió. Solo al montar/desmontar — si se re-ejecutara en cada
  // render robaría el foco al usuario mientras escribe en un campo del modal.
  //
  // El botón "×" de cerrar es siempre el primer elemento enfocable del DOM
  // (va en la cabecera, antes del contenido) — sin este matiz, cualquier
  // hijo que quisiera empezar con el foco en OTRO sitio (ej. el campo de
  // texto de GlobalSearchModal) lo perdía en cuanto este efecto lo
  // devolvía al botón de cerrar. data-modal-autofocus, no el prop
  // autoFocus de React: React implementa autoFocus llamando a .focus() en
  // el commit, sin reflejar ningún atributo "autofocus" real en el DOM —
  // buscar [autofocus] aquí nunca encontraría nada.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const autofocusTarget = overlayRef.current?.querySelector<HTMLElement>("[data-modal-autofocus]");
    (autofocusTarget ?? focusables()[0])?.focus();
    return () => opener?.focus?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // Trap de foco: Tab/Shift+Tab ciclan dentro del modal en vez de escapar
      // a la página de detrás (aria-modal no lo impone por sí solo).
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      const inside = overlayRef.current?.contains(active) ?? false;
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <article className="modal">
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" aria-label="Cerrar" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </article>
    </div>
  );
}
