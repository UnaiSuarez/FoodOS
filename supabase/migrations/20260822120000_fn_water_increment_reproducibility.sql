-- FoodOS — reproducibilidad: versionar fn_water_increment
-- Auditoría de reproducibilidad Supabase (2026-08-22): fn_water_increment
-- existe y funciona correctamente en producción (rwxysqzurjsrevdhbejy),
-- pero NUNCA se había versionado su creación — ni en supabase/schema.sql
-- ni en ninguna migración anterior. Solo estaban versionados sus permisos
-- (20260819190139_security_advisor_fixes.sql hace revoke/grant sobre
-- ella), que dan por hecho que la función ya existe. Confirmado con
-- pg_get_functiondef() sobre la base real y con
-- supabase_migrations.schema_migrations.statements (ninguna de las 13
-- migraciones registradas contiene un CREATE FUNCTION para ella): la
-- función se creó directamente contra la base remota por fuera del
-- control de versiones. Consecuencia real: una instalación nueva
-- siguiendo schema.sql + migraciones en orden fallaba exactamente en
-- 20260819190139 con "function public.fn_water_increment(date, integer)
-- does not exist" (ese REVOKE/GRANT no lleva IF EXISTS).
--
-- Esta migración NO cambia el comportamiento en producción — reproduce
-- EXACTAMENTE (mismo cuerpo, mismo SECURITY DEFINER, mismo search_path,
-- mismos permisos) lo que ya está vivo ahí, obtenido con
-- pg_get_functiondef(). CREATE OR REPLACE (nunca CREATE a secas) redefine
-- la función contra la misma definición ya existente — no lanza el error
-- de "ya existe" que un CREATE a secas sí lanzaría, y el resultado
-- converge exactamente al mismo estado que había antes.
--
-- Orden real de ejecución en una instalación nueva (schema.sql +
-- migraciones en orden por timestamp): schema.sql crea la función
-- primero; 20260819190139_security_advisor_fixes la encuentra ya creada
-- y reafirma sus permisos (su revoke/grant, sin tocar); esta migración
-- (20260822120000) corre después de ambas y vuelve a reconciliar
-- definición y permisos contra el mismo estado. No se toca
-- 20260819190139_security_advisor_fixes.sql: ya está aplicada y su
-- contenido debe seguir coincidiendo exactamente con el historial remoto
-- (supabase_migrations.schema_migrations).

create or replace function public.fn_water_increment(p_date date, p_delta integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  new_ml integer;
begin
  insert into public.water_log (user_id, log_date, ml)
  values (auth.uid(), p_date, greatest(0, p_delta))
  on conflict (user_id, log_date)
  do update set
    ml         = greatest(0, water_log.ml + p_delta),
    updated_at = now()
  returning ml into new_ml;
  return coalesce(new_ml, 0);
end;
$$;

revoke all on function public.fn_water_increment(date, integer) from public;
grant execute on function public.fn_water_increment(date, integer) to authenticated;
