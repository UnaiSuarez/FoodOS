-- FoodOS — drop_temp_debug_auth_uid (reconciliación de historial, 2026-08-22)
-- Representación local exacta, recuperada de
-- supabase_migrations.schema_migrations.statements. Revierte por completo
-- 20260713132657_temp_debug_auth_uid.sql — efecto neto cero sobre el
-- esquema actual (la función no existe en remoto; confirmado por consulta
-- directa a pg_proc antes de escribir este archivo). Añadir este archivo
-- NO ejecuta nada contra la base real — la versión 20260714074136 ya está
-- registrada en supabase_migrations.schema_migrations.

drop function if exists public.debug_auth_uid();
