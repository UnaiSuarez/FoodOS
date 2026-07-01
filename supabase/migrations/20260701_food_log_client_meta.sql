-- FoodOS — Migración food_log: metadata de cliente para devolución al inventario
-- La app necesita, al borrar una entrada del diario, saber de qué item de
-- inventario salió (o de qué ingredientes, si fue receta/plato) para devolver
-- la cantidad consumida. Esos datos no caben en columnas tabulares: van en JSONB.
-- También arregla la pérdida de qty/unit para unidades ("ud"), que antes solo
-- se guardaba en quantity_g (numérico en gramos).
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.

alter table public.food_log
  add column if not exists client_meta jsonb;

comment on column public.food_log.client_meta is
  'Metadata de cliente no tabular: { qty, unit, time, mealType, inventoryItemId, inventorySnapshot, consumedIngredients }. Permite devolver al inventario lo consumido al borrar la entrada.';
