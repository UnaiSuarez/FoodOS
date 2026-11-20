# Propuesta de coherencia visual entre vistas — inventario de diferencias y alcance de la primera entrega

Base: `origin/main` = `a252a59` (tras #154). **No se ha modificado la aplicación**; esta carpeta solo contiene la propuesta, 24 capturas y las medidas (`medidas.json`). Fuera de alcance: NutritionView, cálculos, sincronización, esquema, C0/V4.

Método: app compilada (`next build`/`next start`, modo solo-local, datos demo «Cargar datos demo»), reloj fijado a las 12:00 del 20/11/2026 para que las medidas no dependan de la hora, 6 vistas (Panel, Registro, Inventario, Recetas, Planificador, Carrito) × escritorio 1440 / móvil 390 × claro/oscuro = 24 capturas de página completa; estilos computados de títulos, botones, paneles y tamaño de objetivos; `@axe-core/playwright` (WCAG 2 A/AA) sobre `.view`. Lo que **no** cubre: dispositivo físico, lector de pantalla, sesión autenticada, Nutrición/Finanzas/Ejercicios/Estadísticas/Asistente/Ajustes.

## 1. Qué ya está resuelto del diagnóstico anterior
H1–H5 y H8 (#152: acciones claras, ARIA de Inventario), H6–H7 (#154: Planificador táctil/teclado/tema claro) y el contraste del `eyebrow` nocturno y el pie del selector (PR de detalles). axe: **0 violaciones** en las seis vistas, ambos temas y ambos anchos.

## 2. Inventario de diferencias (medido)

| # | Diferencia | Evidencia (escritorio claro; el móvil se indica aparte) | Tipo |
|---|---|---|---|
| D1 | **Escala de títulos distinta en el Panel y en el resto.** El `h1` de la barra superior mide 72 px en escritorio (23 px en móvil); cada vista repite un `h2` de 42 px (28 px en móvil) dentro de la tarjeta; el Panel no tiene `h2` y titula sus tarjetas con `h3` de ~19 px. | Registro `h2`=38 px, Inventario/Recetas/Planificador/Carrito `h2`=42 px, Panel: 0 `h2`. | Presentación |
| D2 | **Estructura de encabezados pobre o duplicada.** Registro: el único `h2` es un valor («💧 0,00 L de 2,5 L»). Inventario: `h2` «Añadir alimento» **antes** que `h2` «Inventario». Carrito: `h2` «Añadir manualmente» antes que «Carrito». Solo 4 de 6 vistas usan `eyebrow` (Inventario y Carrito no). | Lista de `h2` por vista en `medidas.json`. | Presentación/copy |
| D3 | **Tres sistemas de botón conviviendo.** Clases compartidas (`primary-button`, `secondary-button`: 42 px; `small-action`: 34 px), botones sin clase de sistema («otro»: alturas de 18 a 46 px, hasta 365 px de ancho) y los `pl-btn` propios del Planificador (44 px, tokens `--pl-*`). En móvil una media query lo iguala todo a 44 px; en escritorio no. | Alturas por clase en cada vista (escritorio vs móvil). | Presentación |
| D4 | **Objetivos de pulsación por debajo de 24 px (WCAG 2.2, 2.5.8)** que no son decorativos: enlaces de nombre del Registro (21 px de alto), chips de tipo de comida del Registro (18 px, y son botones que abren un selector), «Ir al planificador» del Panel (20 px), × de descartar sugerencia del Carrito (12×14 px). También en móvil, donde el resto ya mide 44 px. | Medido a 1440 px: 10 en Registro, 1 en Panel, 2 en Carrito (a 390 px: 9, 1 y 2). | Presentación |
| D5 | **Dos conjuntos de tokens paralelos** por vista: `--hv-*` (Panel, 34 declaraciones, acotado a `.home-v2`) y `--pl-*` (Planificador, 26, acotado a `.pl-root/.pl-modal`) con el mismo propósito (marca verde, fondo de «hoy», borde de control) y valores propios. El resto de vistas usa los tokens globales (`--green`, `--surface`…). | `16-home-v2.css`, `18-planificador.css`. | Presentación (CSS) |
| D6 | **Colores fijos pensados para el tema oscuro** que obligan a overrides en claro: 98 usos de `rgba(240,244,238,…)`/`rgba(7,10,5,…)` y 144 hex fijos frente a 1218 `var(--…)`; 66 overrides `[data-theme="light"]`. Ya causó dos fallos (índigo `#818cf8` en la cena: 2,9:1; el `#0d120a` del modal). | Recuento sobre `dashboard/styles/*.css`. | Presentación (CSS) |
| D7 | **Contenido de estados vacíos** desigual (Inventario vacío dice «no hay alimentos que coincidan con el filtro»; Registro no menciona el botón de arriba; Planificador solo tiene la nota de semana vacía). | H12 del diagnóstico; no re-medido. | Copy |
| D8 | **Feedback al guardar** desigual (Carrito sin «Deshacer», «Comprar semana» sin «Ver carrito», errores de IA en bruto). | H15; no re-medido. | Copy / C menor |
| D9 | **Móvil:** el formulario precede a la lista en Inventario y Carrito. | H16; capturas `inventario-movil-*`, `carrito-movil-*`. | Presentación |
| D10 | **Comportamiento** (no coherencia visual): «Al carrito» del Inventario envía el stock actual y duplica líneas; unidad de texto libre en el Carrito. | H13, H14. | Comportamiento — fuera |

Lo que está bien y no hay que tocar: panel redondeado uniforme (todas las tarjetas de las seis vistas usan 19 px), foco visible con contorno propio, borrado con deshacer en Inventario/Registro, etiquetas de procedencia, modal de consumo.

## 3. Propuesta de primera entrega (pequeña)

**Entrega «Títulos y objetivos de pulsación»** — solo presentación y estructura de encabezados, **sin tocar la barra superior global** ni la lógica:

1. **Cabecera de vista compartida** (una clase CSS + el mismo marcado en las cuatro vistas que ya tienen `eyebrow`/`h2`): `eyebrow` + título descriptivo de 22–26 px (la escala del Panel), en lugar de 42 px. Se aplica a Registro, Inventario, Recetas, Planificador y Carrito. El Panel no cambia.
2. **Títulos descriptivos y orden correcto (D2)**: Registro «Hidratación» (el valor pasa a un texto secundario), Inventario «Tu despensa» **antes** que «Añadir alimento», Carrito «Tu lista de la compra» antes que «Añadir manualmente»; `eyebrow` también en Inventario y Carrito.
3. **Objetivos de pulsación (D4)**: los 5 elementos listados pasan a ≥ 24 px de alto en escritorio y ≥ 44 px en táctil **sin cambiar su apariencia** (área de pulsación con `padding`/`min-height` + `::before`), incluida la × del Carrito.
4. **Fuera de esta entrega**: D3 (unificar botones), D5/D6 (tokens compartidos y limpieza de colores fijos), D7–D9 (copy, feedback, orden móvil), D10 (comportamiento), y la barra superior global (72 px).

Por qué esta: es lo más visible al saltar de Panel a las demás vistas (D1) y lo único medible que sigue fallando criterios de accesibilidad (D4); no cambia datos, estado ni cálculos y es revertible por archivo CSS.

### Archivos previsibles
`styles/02-paneles-y-tarjetas.css` o un `19-cabecera-vista.css` nuevo (clase de cabecera), `DiaryView.tsx`, `InventoryView.tsx`, `RecipesView.tsx`, `PlannerView.tsx`, `CartView.tsx` (solo marcado de la cabecera) y el CSS de `.diary-entry-name-link`, `.meal-chip`, `.link-button`, `.suggest-dismiss`. Sin `state.tsx`, `data-layer.ts`, esquema ni NutritionView.

### Criterios de aceptación
- En las cinco vistas el `h2` de cabecera mide ≤ 26 px en escritorio y móvil; ninguna vista tiene un valor como único título ni dos `h2` repetidos con el mismo texto que el `h1`; en Inventario y Carrito el título de la lista precede al formulario.
- Ningún control interactivo de las seis vistas mide < 24×24 px en escritorio; < 44×44 px solo si no es táctil (medido en 1440 y 390 px, ambos temas).
- axe sin violaciones y contraste real (no solo axe) ≥ 4,5:1 en los títulos nuevos, ambos temas.
- Capturas antes/después (las 24 de base ya están aquí) y pruebas: títulos accesibles por rol (`getByRole("heading", …)`) en cada vista y tamaño de objetivos con el DOM real; suites, tipos, build, bundle y e2e en el commit final.

### Riesgos y decisiones para revisar
1. **¿Se toca la barra superior global (`.topbar h1`, 72 px)?** Es la causa principal de D1 pero es el shell de todas las pantallas (incluidas Nutrición, Finanzas…). Propongo dejarlo para una entrega aparte con su propia revisión; la cabecera de vista reducida ya baja el peso visual sin tocarlo.
2. **¿Mínimo de pulsación en escritorio 24 px (WCAG 2.2 AA) o 44 px?** Propongo 24 en puntero y 44 en táctil para no alterar la densidad del Registro.
3. Cambiar títulos es copy visible: «Tu despensa», «Hidratación», «Tu lista de la compra» deberían revisarse (tono y mayúsculas) antes de implementarlos.
4. No se probó dispositivo físico ni lector de pantalla; el reloj fijado evita la dependencia horaria del Panel pero no sustituye la comprobación con la hora real.

## 4. Archivos de esta propuesta
- `capturas-actuales/<vista>-<escritorio|movil>-<claro|oscuro>.png` (24).
- `capturas-actuales/medidas.json`: títulos (texto y px), clases de botón con alturas/radios, objetivos < 44 y < 24 px, radios de panel, desbordes y axe por vista, tema y ancho.
