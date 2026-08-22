-- FoodOS — Migración food_log: metadata de cliente para devolución al inventario
-- La app necesita, al borrar una entrada del diario, saber de qué item de
-- inventario salió (o de qué ingredientes, si fue receta/plato) para devolver
-- la cantidad consumida. Esos datos no caben en columnas tabulares: van en JSONB.
-- También arregla la pérdida de qty/unit para unidades ("ud"), que antes solo
-- se guardaba en quantity_g (numérico en gramos).
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.
--
-- NOTA (2026-08-22, corrección de la reconciliación de historial del
-- 2026-08-21): mismo caso que 20260630000000_inventory_extra_fields.sql
-- — la nota anterior decía "absorbida en initial_schema", incorrecto (ver
-- el detalle completo en ese archivo). La columna client_meta sí existe
-- en producción con este mismo tipo (jsonb) y nullabilidad, aplicada por
-- fuera de cualquier historial de migraciones rastreado. El comentario de
-- más abajo se corrigió para coincidir EXACTAMENTE con el que está vivo
-- en producción (confirmado leyendo pg_catalog.col_description) — la
-- versión anterior de este archivo envolvía la lista de campos entre
-- llaves "{ }", que el comentario real nunca tuvo. Renombrado de 20260701
-- a 20260701000000. Este archivo por sí solo NO cambia nada en remoto —
-- la versión 20260701000000 no está registrada todavía en
-- supabase_migrations.schema_migrations.

alter table public.food_log
  add column if not exists client_meta jsonb;

comment on column public.food_log.client_meta is
  'Metadata de cliente no tabular: qty, unit, time, mealType, inventoryItemId, inventorySnapshot, consumedIngredients. Permite devolver al inventario lo consumido al borrar la entrada.';
