# Auditoría de accesibilidad — E18-01 (P0)

Base para el resto de E18. Cubre contraste, elementos clicables no semánticos, nombres accesibles de iconos y asociación de labels — los 5 tickets P0 de la épica.

## 1. Contraste (E18-01/02)

Script propio (WCAG 2.2, fórmula de luminancia relativa) contra los 3 fondos de cada tema (`--bg`, `--surface`, `--surface-2`) para todos los tokens de texto/estado.

**Encontrado y corregido:** `--hint` fallaba el mínimo de AA (4.5:1) para texto normal en **ambos** temas:

| | Antes | Después |
| --- | --- | --- |
| Oscuro (vs `--surface-2`, el fondo más claro donde aparece) | 2.25:1 | 4.92:1 |
| Claro (vs `--bg`) | 3.96:1 | 5.18:1 |

`--hint` se usa en textos funcionales reales de 11-12px (horas, porcentajes, etiquetas de sección de navegación — ver [[e04-nav-groups]]), no decorativos, así que necesitaba el 4.5:1 de texto normal y no el 3:1 de texto grande. Nuevos valores: `#8a9880` (oscuro) / `#527049` (claro) — ver `globals.css`.

**Revisado, sin acción necesaria:**
- `--green-dark` "falla" contra los 3 fondos (2.99-3.97:1), pero no se usa nunca como `color` de texto — solo en fondos/bordes/gradientes, donde la regla de contraste de texto no aplica directamente.
- `--green`/`--amber`/`--red` como texto sobre `--surface-2` en tema claro salen justo por debajo de 4.5:1 en una prueba con fondo sólido, pero su uso real (`.badge.*`) es sobre su propio fondo traslúcido muy claro (`rgba(color, 0.11-0.13)`), no sobre `--surface-2` — con ese fondo real el contraste es sustancialmente mayor. No se ha encontrado un caso real de estos tres colores como texto sobre `--surface-2` sólido.

## 2. Elementos clicables no semánticos (E18-03)

Búsqueda de `onClick` en `<div>`/`<span>`/`<strong>`. La mayoría de resultados son el patrón estándar de "click fuera para cerrar" en overlays de modal (`<div className="modal-overlay" onClick={onClose}>`) — aceptable en sí mismo *siempre que* exista una vía de teclado alternativa, no hace falta que el propio overlay sea un `<button>` (envolver toda la pantalla en un botón sería semánticamente peor).

**Encontrado y corregido:**
- `ExercisesView.tsx` — `.routine-card-header` (expandir/colapsar una rutina) era un `<div onClick>`: inalcanzable por teclado. Convertido a `<button>` con `aria-expanded`.
- 4 modales con overlay escrito a mano (`BarcodeScannerModal`, `BulkImportModal`, `InventoryDetailModal`, el modal de sesión de `ExercisesView`) no usaban el componente compartido `Modal.tsx` — que ya trae cierre por Escape, trampa de foco y devolución de foco — porque tienen una cabecera con layout propio. Se les añadió cierre por Escape (`lib/use-escape-key.ts`, hook nuevo) sin forzar la reestructuración completa a `Modal.tsx`.

**Pendiente (no bloqueante, documentado para otra tanda):** varios `<li onClick>` como patrón de "fila seleccionable" (p. ej. `LogMealModal.tsx` lista de recetas, filas de inventario) — funcionan con ratón/touch pero no son alcanzables por teclado. Convertirlos requiere revisar cada patrón de selección individualmente (algunos ya tienen un checkbox/input dentro, otros no) — se deja fuera de esta tanda P0 por volumen.

## 3. Nombres accesibles en iconos (E18-04)

Todos los botones de icono (`class="icon-button"` y variantes) ya tenían `aria-label` salvo el toggle de mostrar/ocultar clave de IA en `AIConfigModal.tsx` (corregido). Búsqueda más amplia de botones cuyo contenido es un único glifo (×, ✕, flechas, etc.): **7 botones "quitar/×"** sin `aria-label` en formularios de recetas, comidas y planificador (identifican qué se quita solo por posición visual) — corregidos con etiquetas específicas (`Quitar ingrediente`, `Quitar paso`, `Quitar {nombre}`...).

De paso, E04-08 ya había añadido `aria-label`/`title` a los ítems de navegación del sidebar (necesario ahí para el modo colapsado a solo iconos).

## 4. Labels en inputs (E18-05)

Script de auditoría: para cada `<input>`/`<textarea>` con `placeholder`, comprueba si tiene `aria-label` propio o está envuelto en un `<label>` en las líneas anteriores. La mayoría de formularios (Finanzas, Nutrición, cuenta/login) ya envuelven cada campo en su propio `<label>` — patrón correcto, nada que hacer ahí.

**Encontrado y corregido: 25 inputs/textareas** dependían solo del placeholder — sobre todo en buscadores (`Buscar receta…`, `Buscar producto`), campos de modales de registro rápido (`LogMealModal`, `PlannerAddMealModal`) y filas de `BulkImportModal` donde un mismo `<label>` envolvía por error varios controles a la vez (el checkbox y 4 campos más — un `<label>` solo puede asociarse de forma fiable a un control). Todos con `aria-label` ahora.

## Pendiente (P1/P2, fuera de esta tanda)

E18-06 a E18-18: foco visible consistente, patrón ARIA de tabs, combobox de autocompletados, `inert` en fondos, foco en onboarding/tour, alternativas de texto para gráficos, no depender solo del color, objetivos táctiles ≥44px (parcialmente ya cubierto por la barra inferior de E04-03), zoom/tamaño de fuente, pruebas Axe/teclado/lector de pantalla en CI.
