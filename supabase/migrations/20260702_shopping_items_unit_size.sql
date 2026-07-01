-- FoodOS — Migración shopping_items: tamaño de unidad
-- El carrito perdía el unitSize de un item "ud" (ej. lata de 250ml) en cuanto
-- se sincronizaba con Supabase, porque shopping_items no tenía dónde guardarlo:
-- el siguiente pull traía el item sin unitSize y sobreescribía el estado local.
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.

alter table public.shopping_items
  add column if not exists unit_size numeric(10,2);

comment on column public.shopping_items.unit_size is
  'Gramos/ml que representa 1 unidad cuando unit=''ud'', heredado del item de inventario origen.';
