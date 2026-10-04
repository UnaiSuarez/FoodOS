-- FoodOS — Dimensión de unit_size (masa vs. volumen)
--
-- Contexto (revisión externa, ronda de cierre de auditoría 2026-09-08):
-- unit_size es un número ambiguo — un 60 podría ser "60 g" (ej. 1 huevo) o
-- "60 ml" (ej. una salsa embotellada por unidades). Nada en la fila declara
-- cuál de los dos es, así que ninguna conversión estricta (convertQty, ver
-- apps/web/src/lib/utils.ts) puede usarlo para cruzar "ud" a masa o volumen
-- sin arriesgarse a tratar mililitros como si fueran gramos o viceversa.
--
-- Esta columna cierra ese hueco: declara explícitamente la magnitud de
-- unit_size. Sin ella (NULL, dato legacy previo a esta migración), convertQty
-- se rehúsa a convertir "ud" a masa o volumen — el lote/ingrediente
-- simplemente no cuenta para ese cálculo, nunca se asume, hasta que el
-- usuario lo confirme al editar (EditInventoryModal/CreateRecipeModal ya
-- piden esta magnitud de forma explícita).
--
-- Idempotente: usa ADD COLUMN IF NOT EXISTS. NO reescribe filas existentes
-- (no hay forma segura de inferir la magnitud de datos ya guardados sin
-- inventarla) — es exactamente la misma filosofía de "no adivinar" ya
-- aplicada al resto de esta ronda de corrección.
--
-- IMPORTANTE: esta migración debe aplicarse ANTES de desplegar el código que
-- la acompaña (fix/inventory-unit-safety) — ese código empieza a escribir
-- unit_size_unit en inventory_items/shopping_items en cuanto se despliega.

alter table public.inventory_items
  add column if not exists unit_size_unit text
    check (unit_size_unit is null or unit_size_unit in ('g', 'ml'));

comment on column public.inventory_items.unit_size_unit is
  'Dimensión de unit_size: ''g'' (sólido) o ''ml'' (líquido). NULL = legacy, sin declarar — no usable para convertir "ud" a masa/volumen (ver convertQty en utils.ts).';

alter table public.shopping_items
  add column if not exists unit_size_unit text
    check (unit_size_unit is null or unit_size_unit in ('g', 'ml'));

comment on column public.shopping_items.unit_size_unit is
  'Dimensión de unit_size, heredada del item de inventario origen. Ver comentario en inventory_items.unit_size_unit.';
