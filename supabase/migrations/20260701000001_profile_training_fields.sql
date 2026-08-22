-- FoodOS — Migración user_profiles: nivel de experiencia y material disponible
-- Nuevos campos del perfil físico usados por el asistente de generación de
-- rutinas con IA, para ajustar volumen/complejidad y qué ejercicios sugerir.
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.
--
-- NOTA (2026-08-22, corrección de la reconciliación de historial del
-- 2026-08-21): mismo caso que 20260630000000_inventory_extra_fields.sql
-- — la nota anterior decía "absorbida en initial_schema", incorrecto (ver
-- el detalle completo en ese archivo). Las columnas y sus CHECK
-- constraints sí existen en producción, exactamente como declara el ALTER
-- TABLE de más abajo (confirmado por pg_get_constraintdef). Lo que NO
-- existe en producción son los dos COMMENT ON COLUMN que este archivo
-- llevaba — confirmado con pg_catalog.col_description: ambos comentarios
-- están NULL en remoto. Se retiran de aquí para que el archivo reproduzca
-- exactamente lo que hay, no lo que se pretendía documentar en su momento
-- y nunca se llegó a ejecutar. Renombrado de 20260701 a 20260701000001
-- (distinto de 20260701000000_food_log_client_meta.sql, que compartía el
-- mismo "20260701" sin hora — colisión de versión real, ambos archivos se
-- comitearon en el mismo commit el 2026-07-01). Este archivo por sí solo
-- NO cambia nada en remoto — la versión 20260701000001 no está registrada
-- todavía en supabase_migrations.schema_migrations.

alter table public.user_profiles
  add column if not exists experience_level text
    check (experience_level is null or experience_level in ('beginner','intermediate','advanced')),
  add column if not exists equipment_access text
    check (equipment_access is null or equipment_access in ('full_gym','home_dumbbells','bodyweight'));
