"use client";

import { useState } from "react";
import { Trash2, Star, Search } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import { Modal } from "./Modal";

const BUTTON_VARIANTS: ButtonVariant[] = ["primary", "secondary", "text", "danger"];
const BADGE_TONES: BadgeTone[] = ["neutral", "green", "amber", "red", "blue", "purple"];

/**
 * E03-15: documentación visual de `components/ui/*` — el sistema de
 * componentes base creado en E03-14. Vive como modal admin en Ajustes (mismo
 * sitio que el resto de herramientas de desarrollo) en vez de como una
 * página o ruta nueva: no hay build de Storybook que mantener, y renderiza
 * los componentes REALES contra el CSS real de la app — si alguien rompe una
 * clase compartida (.primary-button, .badge, etc.) esta vista lo muestra
 * roto tal cual, no una copia congelada en un doc aparte.
 *
 * `Dialog` (components/ui/Dialog.tsx) es un re-export de este mismo Modal
 * que aloja la vista — no se demuestra en vivo aquí para evitar anidar un
 * modal dentro de sí mismo; se documenta solo con texto.
 */
export function StyleGuideModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState("uno");

  return (
    <Modal title="Documentación de componentes" onClose={onClose}>
      <div className="style-guide">
        <p className="form-intro">
          Componentes base de <code>src/components/ui/</code> (E03-14), con sus variantes y
          estados. Son los mismos componentes que usa el resto de la app — esta vista no es una
          copia, es <code>import</code> directo.
        </p>

        {/* Button */}
        <section className="style-guide-section">
          <h3>Button</h3>
          <p className="style-guide-desc">
            4 variantes (<code>variant</code>), <code>type=&quot;button&quot;</code> por defecto.
          </p>
          <div className="style-guide-row">
            {BUTTON_VARIANTS.map((v) => (
              <Button key={v} variant={v}>{v}</Button>
            ))}
          </div>
          <p className="style-guide-desc">Estado deshabilitado:</p>
          <div className="style-guide-row">
            {BUTTON_VARIANTS.map((v) => (
              <Button key={v} variant={v} disabled>{v}</Button>
            ))}
          </div>
        </section>

        {/* Badge */}
        <section className="style-guide-section">
          <h3>Badge</h3>
          <p className="style-guide-desc">6 tonos (<code>tone</code>), &quot;neutral&quot; sin modificador de color.</p>
          <div className="style-guide-row">
            {BADGE_TONES.map((t) => (
              <Badge key={t} tone={t}>{t}</Badge>
            ))}
          </div>
        </section>

        {/* IconButton */}
        <section className="style-guide-section">
          <h3>IconButton</h3>
          <p className="style-guide-desc">
            <code>aria-label</code> obligatorio por tipo — no se puede construir uno sin nombre
            accesible. Variante <code>danger</code> opcional.
          </p>
          <div className="style-guide-row">
            <IconButton aria-label="Buscar (ejemplo)"><Search size={16} /></IconButton>
            <IconButton aria-label="Favorito (ejemplo)"><Star size={16} /></IconButton>
            <IconButton aria-label="Eliminar (ejemplo)" danger><Trash2 size={16} /></IconButton>
          </div>
        </section>

        {/* Card */}
        <section className="style-guide-section">
          <h3>Card</h3>
          <p className="style-guide-desc"><code>title</code> opcional — se omite si la vista ya trae su propia cabecera.</p>
          <div className="style-guide-row" style={{ alignItems: "flex-start" }}>
            <Card title="Con título" style={{ maxWidth: 220 }}>
              <p>Contenido de ejemplo.</p>
            </Card>
            <Card style={{ maxWidth: 220 }}>
              <p>Sin título — para cuando la vista aporta su propia cabecera.</p>
            </Card>
          </div>
        </section>

        {/* Field */}
        <section className="style-guide-section">
          <h3>Field</h3>
          <p className="style-guide-desc">
            <code>label</code> obligatorio: es imposible construir un campo sin su etiqueta
            asociada (E18-05). <code>hint</code> opcional bajo la etiqueta.
          </p>
          <div className="style-guide-row" style={{ alignItems: "flex-start" }}>
            <Field label="Nombre">
              <input type="text" placeholder="Ej. Pechuga de pollo" />
            </Field>
            <Field label="Cantidad" hint="(opcional)">
              <input type="number" placeholder="0" />
            </Field>
          </div>
        </section>

        {/* EmptyState */}
        <section className="style-guide-section">
          <h3>EmptyState</h3>
          <p className="style-guide-desc">
            <code>action</code> opcional — un estado vacío debería explicar qué hacer a
            continuación, no solo que está vacío.
          </p>
          <EmptyState>Sin resultados.</EmptyState>
          <EmptyState action={<Button variant="text">Añadir el primero</Button>}>
            Todavía no hay nada aquí.
          </EmptyState>
        </section>

        {/* Tabs */}
        <section className="style-guide-section">
          <h3>Tabs</h3>
          <p className="style-guide-desc">
            Patrón ARIA Tabs (APG): activación automática con flechas, tabindex itinerante. Prueba
            las flechas ←/→ con el foco en una pestaña.
          </p>
          <Tabs
            label="Ejemplo de pestañas"
            tabs={[{ id: "uno", label: "Uno" }, { id: "dos", label: "Dos" }, { id: "tres", label: "Tres" }]}
            activeId={activeTab}
            onChange={setActiveTab}
            idPrefix="style-guide-demo"
          />
          <TabPanel id="uno" activeId={activeTab} idPrefix="style-guide-demo">
            <p style={{ marginTop: 8 }}>Panel uno.</p>
          </TabPanel>
          <TabPanel id="dos" activeId={activeTab} idPrefix="style-guide-demo">
            <p style={{ marginTop: 8 }}>Panel dos.</p>
          </TabPanel>
          <TabPanel id="tres" activeId={activeTab} idPrefix="style-guide-demo">
            <p style={{ marginTop: 8 }}>Panel tres.</p>
          </TabPanel>
        </section>

        {/* Dialog / Modal — documentado sin renderizar en vivo */}
        <section className="style-guide-section">
          <h3>Dialog</h3>
          <p className="style-guide-desc">
            Re-export de <code>Modal</code> (<code>components/dashboard/Modal.tsx</code>) con el
            nombre del sistema de diseño. Es el propio contenedor de esta ventana — no se
            demuestra en vivo aquí para no anidar un modal dentro de sí mismo. Trae de serie:
            trampa de foco (Tab cicla dentro), cierre con Escape, devolución del foco a quien lo
            abrió, fondo <code>inert</code> (E18-09) y <code>data-modal-autofocus</code> para fijar
            qué campo recibe el foco al abrir.
          </p>
        </section>
      </div>
    </Modal>
  );
}
