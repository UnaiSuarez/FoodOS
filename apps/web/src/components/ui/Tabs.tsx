"use client";

import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface TabItem {
  id: string;
  label: ReactNode;
}

interface TabsProps {
  /** Nombre accesible de la lista de pestañas (aria-label del tablist). */
  label: string;
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
  /** Clase para cada botón de pestaña — para adoptar el patrón ARIA en un
      sitio que ya tenía su propio estilo visual (ej. "nutrition-tab") sin
      tener que reescribir ese CSS. Se le añade "active" a la pestaña
      seleccionada, igual que hacían las implementaciones sueltas de antes. */
  tabClassName?: string;
  /** Prefijo para los id de tab/panel — necesario si hay más de un <Tabs>
      en la misma página, para que los id generados no choquen. */
  idPrefix?: string;
}

/**
 * E03-14/E18-07: patrón ARIA "Tabs" (APG) — antes cada vista con pestañas
 * (Nutrición, Carrito, LogMealModal, planificador...) montaba su propio
 * grupo de botones sin roles ni navegación por teclado; visualmente eran
 * pestañas pero para un lector de pantalla eran botones sueltos sin
 * relación entre sí, y solo Tab (no las flechas) movía el foco entre ellas.
 *
 * Implementa activación automática (mover el foco con flechas activa la
 * pestaña, no hace falta pulsar Enter aparte — comportamiento recomendado
 * por el WAI-ARIA Authoring Practices Guide para listas de pestañas donde
 * cambiar de panel es barato) y tabindex itinerante (roving tabindex): solo
 * la pestaña activa es alcanzable con Tab desde fuera; dentro de la lista,
 * las flechas mueven el foco.
 *
 * Se empareja con <TabPanel> (mismo idPrefix) para los paneles — ver ese
 * componente.
 */
export function Tabs({ label, tabs, activeId, onChange, className, tabClassName, idPrefix = "tabs" }: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function focusAndSelect(id: string) {
    onChange(id);
    refs.current[id]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((t) => t.id === activeId);
    if (index === -1) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusAndSelect(tabs[(index + 1) % tabs.length].id);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusAndSelect(tabs[(index - 1 + tabs.length) % tabs.length].id);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAndSelect(tabs[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAndSelect(tabs[tabs.length - 1].id);
    }
  }

  return (
    <div role="tablist" aria-label={label} className={className} onKeyDown={handleKeyDown}>
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            ref={(el) => { refs.current[tab.id] = el; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={active ? 0 : -1}
            className={[tabClassName, active && "active"].filter(Boolean).join(" ") || undefined}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Panel asociado a una pestaña de <Tabs> — mismo id/idPrefix que su tab. */
export function TabPanel({
  id,
  activeId,
  idPrefix = "tabs",
  className,
  children,
}: {
  id: string;
  activeId: string;
  idPrefix?: string;
  className?: string;
  children: ReactNode;
}) {
  if (id !== activeId) return null;
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${id}`}
      aria-labelledby={`${idPrefix}-tab-${id}`}
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
}
