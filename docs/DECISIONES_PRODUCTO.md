# Decisiones de producto (E00)

Decisiones tomadas para cerrar la Fase 0 del backlog maestro
(`docs/BACKLOG.md`, ÉPICA E00). Registradas aquí para no repetir la
conversación cada vez que un ticket dependa de ellas.

**Fecha:** 19 de agosto de 2026.

---

## E00-01 — Promesa principal

> FoodOS conecta lo que tienes en casa, lo que comes y lo que gastas —
> inventario, nutrición y finanzas, sin tener que llevarlos por separado.

Las tres áreas son igual de centrales — no hay un único pilar del que las
demás sean complemento. El diferencial de FoodOS frente a una app de
inventario, una de macros o una de gastos por separado es precisamente que
conecta las tres (p. ej., el presupuesto alimentario afecta a qué recetas
se sugieren; lo que caduca pronto afecta a qué se cocina; lo que se cocina
afecta a las calorías del día).

**Implicación práctica:** al priorizar trabajo, ningún módulo de los tres
debe recortarse para "simplificar" a costa de los otros — la propuesta de
E00-04 (definir los tres pilares) queda resuelta como: **Alimentación
(inventario+recetas), Nutrición, Finanzas**, los tres de primer nivel.

---

## E00-02 — Alcance de Finanzas

**Decisión: gestor financiero completo**, no solo presupuesto alimentario.

Finanzas cubre ingresos, gastos de cualquier categoría (no solo comida),
ahorro y proyecciones — ya es en gran parte lo que existe hoy en
`FinanceView.tsx` (categorías tipo "Vivienda", "Transporte", "Salud", no
solo comida). Esta decisión CONFIRMA el alcance actual en vez de recortarlo.

**Implicación práctica:**
- E13-05 ("Reestructurar según la decisión E00-02") queda resuelto como
  "sin recorte de alcance" — el trabajo pendiente de E13 sigue siendo
  claridad y confianza (ya en curso, ver Fase 0 del backlog), no reducir
  qué cubre.
- La integración bancaria (E13-19/E25-06, hoy P3) tiene sentido como
  evolución futura de un gestor financiero completo — se mantiene en el
  backlog, sin adelantarla.

---

## E00-03 — Futuro del Feed

**Decisión: eliminarlo.**

El Feed actual simula actividad social que no existe de verdad (posts
demo, likes con problemas de persistencia — ver E16-02) y no encaja con la
promesa de producto decidida en E00-01 (una app centrada en gestionar lo
propio, no en contenido social). Mantenerlo a medias — ni social de
verdad, ni completamente honesto sobre lo que es — daña más la confianza
que no tenerlo.

**Implicación práctica — qué falta por hacer (fuera de Fase 0, es E16-04,
Fase 4 del backlog):**
- Quitar la vista Feed, su entrada de navegación y el flujo "Cocinar desde
  Feed".
- Decidir qué pasa con `feed_posts`/`feed_post_likes`/`feed_comments` en
  Supabase (migración de borrado, o dejarlas sin usar si ya hay datos
  reales de algún usuario que prefiera conservar).
- Revisar si algo de valor del Feed (p. ej. "recetas guardadas") debe
  reaparecer en otro sitio (Recetas ya tiene favoritos/colecciones
  planeados en E08-16, cubre parte de ese hueco).

**Esta entrega (Fase 0) no incluye la eliminación en sí** — E00 solo pedía
decidir, no ejecutar; la ejecución es su propio ticket en su propia fase,
para no mezclar una decisión de producto con un borrado de código sin
haberlo hablado como una entrega aparte.
