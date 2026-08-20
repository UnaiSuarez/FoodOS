"use client";

import { useEffect } from "react";

/**
 * E18-03/06: cierra con Escape. Varios modales de la app se escribieron a
 * mano (overlay + onClick para cerrar al pulsar fuera) en vez de usar el
 * componente compartido Modal.tsx — que ya trae Escape, trampa de foco y
 * devolución de foco — porque tienen una cabecera con layout propio que no
 * encaja en el título simple de Modal. Este hook les da al menos el cierre
 * por teclado sin necesitar esa reestructuración mayor.
 */
export function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}
