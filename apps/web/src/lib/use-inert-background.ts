"use client";

import { useLayoutEffect, type RefObject } from "react";

// E18-09: ninguno de los diálogos/overlays de esta app usa un portal — se
// montan en el mismo sitio del árbol donde vive la vista que los abrió, no
// en document.body. Un trap de foco por teclado (Tab/Shift+Tab, ver
// Modal.tsx) impide TABULAR hacia el fondo, pero no evita que un lector de
// pantalla en modo de navegación por flechas/rotor siga leyendo o
// interactuando con el contenido de detrás — aria-modal="true" es solo una
// pista, no todos los lectores/navegadores la respetan igual. El atributo
// `inert` nativo sí lo impide de verdad (foco, puntero Y árbol de
// accesibilidad) en TODO lo que quede fuera del nodo dado.
//
// Sin portal, no hay un único "contenedor de fondo" que inertar: hay que
// subir desde el propio overlay hasta <body>, inertando en cada nivel a los
// hermanos del elemento por el que se pasa (nunca al propio ancestro, que
// contiene el overlay). Cuenta de referencias por elemento porque un
// diálogo puede abrir otro por encima (p. ej. el visor de imagen dentro de
// InventoryDetailModal) — con dos overlays activos, un mismo hermano puede
// recibir inert de ambos; solo se quita cuando ninguno lo necesita ya.
const inertRefCounts = new WeakMap<Element, number>();

function walkInertLevels(node: Element, visitSibling: (sibling: HTMLElement) => void) {
  let current: Element = node;
  while (current !== document.body && current.parentElement) {
    const parent = current.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === current) continue;
      if (sibling instanceof HTMLElement) visitSibling(sibling);
    }
    current = parent;
  }
}

function lockBackgroundOutside(node: Element) {
  walkInertLevels(node, (sibling) => {
    const count = inertRefCounts.get(sibling) ?? 0;
    if (count === 0) sibling.inert = true;
    inertRefCounts.set(sibling, count + 1);
  });
}

function unlockBackgroundOutside(node: Element) {
  walkInertLevels(node, (sibling) => {
    const count = inertRefCounts.get(sibling);
    if (count === undefined) return;
    if (count <= 1) {
      inertRefCounts.delete(sibling);
      sibling.inert = false;
    } else {
      inertRefCounts.set(sibling, count - 1);
    }
  });
}

/** Mientras el nodo referenciado esté montado, marca `inert` a todo lo que
    quede fuera de él (subiendo hasta <body>) y lo deshace al desmontar. Usar
    con el overlay raíz de cualquier diálogo/menú/paso de onboarding que
    deba bloquear el contenido de detrás — ver el comentario de arriba.

    useLayoutEffect, no useEffect: al desmontar, React ejecuta la limpieza
    de un useEffect DESPUÉS de quitar el nodo del árbol — el walk de abajo
    necesita node.parentElement para subir hasta <body>, así que con
    useEffect llegaba siempre con el nodo ya huérfano y no deshacía nada
    (el fondo se quedaba inert para siempre tras cerrar). La limpieza de
    useLayoutEffect corre síncrona ANTES de esa mutación, con el nodo
    todavía en su sitio. */
export function useInertBackground(ref: RefObject<Element | null>): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    lockBackgroundOutside(node);
    return () => unlockBackgroundOutside(node);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
