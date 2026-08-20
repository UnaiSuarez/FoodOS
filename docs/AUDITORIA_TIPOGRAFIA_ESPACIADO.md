# Auditoría de tipografía, espaciado, radios, sombras y ruido — E03-05/06/07/08/09/10/11/13

Continuación de [AUDITORIA_COLORES.md](AUDITORIA_COLORES.md) (E03-01/02/03/04), misma épica.

## E03-06 — Escala tipográfica

`dashboard.css` tiene **más de 370 declaraciones `font-size`** repartidas en dos sub-sistemas que no coinciden entre sí: uno en `px` (9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 42 — 25 valores distintos) y otro en `rem` (0.64 a 1.6, 16 valores más). No hay una escala real, cada componente eligió su propio tamaño.

**Hecho:** se define una escala de 9 pasos (`--text-2xs` a `--text-3xl`) en `globals.css`, disponible para código nuevo.
**No hecho:** migrar las 370+ declaraciones existentes a la escala — volumen alto, riesgo bajo por sitio pero alto en conjunto (cambia el tamaño visual de casi cada texto de la app). Queda para la limpieza de E03-16/17, idealmente ya con `dashboard.css` dividido en módulos más pequeños para poder revisar cada migración por partes.

## E03-07 — Mínimo de texto funcional

Se encontraron 19 declaraciones de texto funcional (etiquetas de macros, contadores, badges de estado, divisores con texto) en 9px (1) o 10px (18) — por debajo del mínimo legible recomendado. Subidas todas a 11px.

## E03-08 — Números tabulares

La fuente `--mono` (DM Mono) usada en la mayoría de métricas ya da ancho uniforme por dígito al ser monoespaciada, así que `font-variant-numeric: tabular-nums` era redundante ahí. El problema real estaba en las métricas que **no** usan `--mono` y heredan la fuente proporcional (`--sans`): saldo y estadísticas de Finanzas (`.finance-balance-num`, `.finance-stats strong/span`), valores de macros del diario (`.diary-detail-macro-val`) y estadísticas de adherencia (`.adherence-stat span`). Añadido `font-variant-numeric: tabular-nums` a esas 5 reglas. (`.log-sets-count`, de Ejercicios, ya lo tenía — sirvió de referencia del patrón.)

## E03-05 — Colores de macros

Proteína/carbohidratos/grasa ya usaban colores más o menos constantes (verde/ámbar/azul) pero directamente vía los tokens decorativos genéricos (`--green`, `--amber`, `--blue`), sin nombre semántico propio — y `.diary-detail-macro-fat`/`.diary-detail-bar-fat` usaban además un `#60a5fa` hardcodeado en vez de `var(--blue)`, mismo valor, técnica inconsistente. La fibra no tenía color asignado en ningún sitio.

Definidos `--macro-protein`/`--macro-carbs`/`--macro-fat`/`--macro-fiber` en `globals.css` (mismo valor que antes, nombre propio) y migradas las 9 reglas CSS + 1 relleno de SVG (`NutritionView.tsx`, gráfico de proteína semanal) que fijaban estos colores.

## E03-09 — Escala de espaciado

Mismo patrón que E03-06: se define la escala (`--space-1` a `--space-8`, pasos 4/8/12/16/24/32/48/64) en `globals.css`; la migración de los paddings/márgenes/gaps existentes (volumen similar al de tipografía) queda para E03-16/17.

## E03-10 — Radios unificados

La escala de radios (`--radius-sm/md/lg/xl`) ya existía desde antes de esta auditoría, pero `dashboard.css` tiene 100+ valores de `border-radius` en píxeles sueltos (1 a 40px, más `999px` para píldoras) que no la usan. Igual que tipografía/espaciado: la escala ya está disponible, la migración completa queda para la limpieza de E03-16/17.

## E03-11 — Sombras (auditado, sin cambios)

De 28 declaraciones `box-shadow` en `dashboard.css`, solo 2 usan el token compartido `var(--shadow)` (`.card`/`.panel` — sombra suave, `0 24px 80px rgba(0,0,0,0.42)`). Las 26 restantes son deliberadamente más marcadas, pero **todas pertenecen a UI flotante o superpuesta** (`.modal`, `.modal-card`, `.autocomplete-dropdown`, `.planner-drag-ghost`, `.mascot-bubble`, tarjetas de onboarding a pantalla completa...), nunca a una tarjeta normal de contenido. El criterio de aceptación ("las tarjetas normales no usan sombras pesadas") ya se cumplía — no hizo falta ningún cambio.

## E03-13 — Textura de ruido

`.noise` es una capa `position: fixed; inset: 0` con `opacity: 0.04` sobre toda la app, incluidos formularios y listas densas. Bajada a `0.025` — sigue siendo perceptible en superficies grandes vacías pero interfiere menos con texto pequeño denso (inventario, tablas, formularios).

## Pendiente (fuera de este lote)

- **E03-12** (P1, M): sustituir los iconos Unicode (⌂ ≣ □ ◌ ✓ € ↗ % ✦ ⊞ ⊙...) por una librería SVG — cambio transversal a `dashboard-views.ts`, sidebar, botones de acción; efecto suficientemente grande y visible como para hacerlo en su propia tanda.
- **E03-14** (P1, L): componentes UI base (`Button`, `IconButton`, `Card`, `Badge`, `Field`, `Tabs`, `Dialog`, `EmptyState`) — no existen hoy, cada vista repite su propio marcado; requiere decidir una API de componentes antes de tocar código, mejor como diseño aparte.
- Migración completa de tipografía, espaciado y radios a las escalas ya definidas — E03-16/17 (P2).
