-- FoodOS — Migración inventory_items: campos extra de Open Food Facts
-- Añade: salt_per_100, sugars_per_100, unit_size, brand, allergen_tags.
-- (image_url, carbs_per_100, fat_per_100, fiber_per_100 ya existían en el schema
-- pero no se estaban leyendo/escribiendo desde la app — se corrige en data-layer.ts)
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.
--
-- NOTA (2026-08-22, corrección de la reconciliación de historial del
-- 2026-08-21): la nota anterior decía que estas columnas "quedaron
-- absorbidas dentro de la migración initial_schema (20260629120159)" —
-- **incorrecto**, verificado leyendo el SQL exacto de esa migración
-- (supabase_migrations.schema_migrations.statements): initial_schema no
-- las menciona en absoluto. Lo que sí se confirmó (y sigue siendo cierto)
-- es que las columnas existen en producción con exactamente el tipo,
-- precisión, nullabilidad y comentarios que este archivo declara — se
-- aplicaron directamente contra la base (SQL Editor u otro medio) SIN
-- pasar por ningún historial de migraciones rastreado, ni bajo esta
-- versión ni bajo ninguna otra — mismo patrón sin rastro que
-- fn_water_increment (ver 20260819180000_fn_water_increment_reproducibility.sql).
-- Renombrado de 20260630 a 20260630000000 (timestamp completo de 14
-- dígitos, requerido por el CLI) como parte de esa misma reconciliación.
-- Este archivo por sí solo NO cambia nada en remoto — la versión
-- 20260630000000 no está registrada todavía en
-- supabase_migrations.schema_migrations; falta la reconciliación
-- explícita (fuera de esta rama, ver plan de reconciliación) que la marque
-- como aplicada sin re-ejecutar el SQL.

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
