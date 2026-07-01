-- FoodOS — Migración inventory_items: campos extra de Open Food Facts
-- Añade: salt_per_100, sugars_per_100, unit_size, brand, allergen_tags.
-- (image_url, carbs_per_100, fat_per_100, fiber_per_100 ya existían en el schema
-- pero no se estaban leyendo/escribiendo desde la app — se corrige en data-layer.ts)
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.

alter table public.inventory_items
  add column if not exists salt_per_100 numeric(6,2),
  add column if not exists sugars_per_100 numeric(6,2),
  add column if not exists unit_size numeric(8,2),
  add column if not exists brand text,
  add column if not exists allergen_tags text[];

comment on column public.inventory_items.unit_size is
  'Gramos/ml que representa 1 unidad cuando unit=''ud'' (ej. una lata de 250 ml). Si es NULL, la app asume 60.';

comment on column public.inventory_items.allergen_tags is
  'Tags de alérgenos de Open Food Facts sin traducir (ej. "en:gluten", "en:milk").';
