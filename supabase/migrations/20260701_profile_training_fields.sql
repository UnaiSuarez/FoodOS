-- FoodOS — Migración user_profiles: nivel de experiencia y material disponible
-- Nuevos campos del perfil físico usados por el asistente de generación de
-- rutinas con IA, para ajustar volumen/complejidad y qué ejercicios sugerir.
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.
--
-- NOTA (2026-08-21, reconciliación de historial CLI): mismo caso que
-- 20260630_inventory_extra_fields.sql — sin versión propia en remoto,
-- absorbida en "initial_schema" (20260629120159). Ver esa nota para el
-- detalle completo.

alter table public.user_profiles
  add column if not exists experience_level text
    check (experience_level is null or experience_level in ('beginner','intermediate','advanced')),
  add column if not exists equipment_access text
    check (equipment_access is null or equipment_access in ('full_gym','home_dumbbells','bodyweight'));

comment on column public.user_profiles.experience_level is
  'Nivel de experiencia entrenando (beginner/intermediate/advanced) — afina el volumen que sugiere la IA al generar rutinas.';

comment on column public.user_profiles.equipment_access is
  'Material disponible (full_gym/home_dumbbells/bodyweight) — afina qué ejercicios puede sugerir la IA.';
