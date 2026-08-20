# Auditoría de colores — E03-01

Inventario de cómo se usa el color hoy en la app (`globals.css`, `apps/web/src/app/dashboard/dashboard.css`, `apps/web/src/app/landing.css`), como base para E03-02/03/04.

## 1. Arquitectura de tokens

Los tokens de color viven en `globals.css`, en `:root` (tema oscuro, por defecto) y `[data-theme="light"]` (tema claro, activado por `data-theme` en `<html>`). `dashboard.css` y `landing.css` solo deberían *consumir* `var(--token)`, no declarar colores propios — en la práctica no siempre es así (ver §3).

Tokens de paleta (decorativos, antes de esta auditoría): `--bg`, `--bg-2`, `--bg-3`, `--surface`, `--surface-2`, `--text`, `--muted`, `--hint`, `--green`, `--green-dim`, `--green-dark`, `--amber`, `--red`, `--blue`, `--purple`, `--border`, `--shadow`.

## 2. Bug encontrado: tokens usados pero nunca definidos

`var(--nombre)` sin segundo argumento no tiene *fallback*: si `--nombre` no está definido en ningún selector que aplique, la declaración entera se ignora silenciosamente (no es un error visible, ni en consola). Comparando todos los `var(--x)` usados contra todos los `--x:` definidos, aparecieron **12 nombres usados en cientos de sitios que jamás se definieron**:

| Token usado | Usos | Efecto real (antes del fix) |
| --- | --: | --- |
| `--accent` | 35 | Casillas sin `accent-color` (azul del navegador), bordes de "seleccionado"/foco invisibles, botones activos sin fondo. |
| `--fg-muted` | 17 | Texto secundario de Finanzas sin color (heredaba el del padre). |
| `--surface2` *(typo, sin guion)* | 15 | Tarjetas/inputs de recetas, lista de la compra y cocina sin fondo — incluye el centro del anillo de kcal, que además tenía un fallback fijo `#111a0d` (oscuro en cualquier tema). |
| `--fg` | 3 | Texto sin color en varias filas de Finanzas. |
| `--bg-card` / `--bg-elevated` | 6 / 6 | Tarjetas y "tips" de Finanzas sin fondo. |
| `--danger` | 3 | Tenían fallback (`#e05252`), así que funcionaban pero con un rojo distinto al resto de la app (`--red` es `#f87171`). |
| `--bg-soft` | 3 | Tenían fallback (`#f3f3f3`), miniaturas de producto sin fondo en modo oscuro (el fallback es un gris claro fijo). |
| `--surface-alt` | 9 | Parcialmente con fallback, inconsistente entre sitios. |
| `--surface-3` / `--surface3` *(typo)* | 1 + 1 | Un hover sin fondo, un autocompletado con fallback fijo. |

**Fix aplicado (E03-02/04):** en vez de tocar cada uno de los ~250 sitios afectados, se definieron estos 12 nombres en `globals.css :root` como alias de los tokens reales (`--accent: var(--color-brand)`, `--fg: var(--text)`, `--surface2: var(--surface-2)`, etc.). Bajo riesgo, corrige todos los usos a la vez, y al ser `var()` encadenados siguen respetando el tema claro/oscuro automáticamente.

## 3. Colores repetidos como literales en vez de tokens

Conteo de literales hexadecimales sueltos (no `var()`) por archivo — la mayoría son variaciones sin catalogar de los mismos 5-6 colores de estado:

- `dashboard.css`: ~100 literales. Destacan `#f87171`/`#ef4444` (rojo, 2 tonos distintos para "peligro" — unificado a `var(--color-danger)` en E03-02 dentro de la zona de peligro de Ajustes), `#60a5fa` (azul info), `#f59e0b`/`#fbbf24` (ámbar, 2 tonos), `#4ade80` (verde éxito).
- `globals.css`: todos los literales están dentro de la definición de los propios tokens (correcto, es donde deben vivir).
- `landing.css`: solo tonos de fondo oscuro (`#071005`, `#070a05`...), sin colores de estado.

**No se ha hecho** una migración completa de estos literales a tokens en este ticket (P0) — es un cambio de alto volumen y bajo riesgo individual, más propio de E03-17/18 (P2, limpieza de estilos muertos/repetidos). Se ha priorizado:
1. Los tokens **rotos** (§2) — bug real, cualquier usuario los está sufriendo hoy.
2. Los usos de color como **estado semántico** (positivo/negativo de dinero, "éxito", "peligro") — ver E03-02 más abajo.

## 4. Solapamiento de significado (E03-02)

Antes de este ticket, `--green` se usaba a la vez como color de **marca** (logo, iconos activos, checkboxes) y como color de **éxito** (saldo positivo, mensajes de confirmación) — el mismo token, dos significados. Un cambio de marca futuro habría alterado sin querer el significado de "positivo". Se separaron en tokens de rol propio (`--color-brand`, `--color-success`, `--color-info`, `--color-warning`, `--color-danger`), hoy con el mismo valor que la paleta decorativa pero desacoplados, y se migraron los usos de estado más visibles (`.money.positive/negative`, `.finance-balance-num.*`, `.success-hint`, la "zona de peligro" de Ajustes).

## 5. Tema claro (E03-03)

`--surface`/`--surface-2` (fondo de tarjeta) eran un verde sage saturado (`#d5e5cc`/`#c8dcc0`). Con ~40 usos directos o indirectos (incluyendo los del bug de §2, que antes no se veían por estar rotos) y sin override propio por componente, muchas tarjetas se habrían visto verde intenso en vez de neutras. Cambiado a blanco/casi-blanco (`#ffffff`/`#eef1ea`); el acento de marca se mantiene en iconos, badges y estados vía `--green`.

## Pendiente (fuera de este P0)

- E03-05 a E03-13: escala tipográfica, espaciado, radios, sombras, iconos SVG (hoy Unicode), textura de ruido.
- E03-14: componentes UI base (`Button`, `Card`, `Badge`...) — no existen, cada vista repite su propio marcado.
- E03-16/17/18 (P2): dividir `dashboard.css` (9000+ líneas en un solo archivo), eliminar estilos inline repetidos y selectores muertos, incluida la migración completa de literales hex de §3.
