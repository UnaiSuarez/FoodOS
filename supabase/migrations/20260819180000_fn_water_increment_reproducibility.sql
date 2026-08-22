-- FoodOS — reproducibilidad: versionar fn_water_increment
-- Auditoría de reproducibilidad Supabase (2026-08-22): fn_water_increment
-- existe y funciona correctamente en producción (rwxysqzurjsrevdhbejy),
-- pero NUNCA se había versionado su creación — ni en supabase/schema.sql
-- ni en ninguna migración anterior. Solo estaban versionados sus permisos
-- (20260819190139_security_advisor_fixes.sql hace revoke/grant sobre
-- ella), que dan por hecho que la función ya existe. Confirmado con
-- pg_get_functiondef() sobre la base real y con
-- supabase_migrations.schema_migrations.statements (ninguna migración
-- registrada contiene un CREATE FUNCTION para ella): la función se creó
-- directamente contra la base remota por fuera del control de versiones.
--
-- Esta migración NO cambia el comportamiento en producción — reproduce
-- EXACTAMENTE (mismo cuerpo, mismo SECURITY DEFINER, mismo search_path,
-- mismos permisos) lo que ya está vivo ahí, obtenido con
-- pg_get_functiondef(). CREATE OR REPLACE (nunca CREATE a secas) redefine
-- la función contra la misma definición ya existente — no lanza el error
-- de "ya existe" que un CREATE a secas sí lanzaría, y el resultado
-- converge exactamente al mismo estado que había antes.
--
-- Versión deliberadamente ANTERIOR a 20260819190139_security_advisor_fixes
-- (revisión externa, reconciliación de historial 2026-08-22): un `supabase
-- db reset`/`db push` desde vacío solo conoce supabase/migrations/ (no
-- ejecuta schema.sql) y aplica en orden estricto de timestamp. Con
-- 20260819180000 < 20260819190139, esta migración crea la función ANTES
-- de que 20260819190139 intente su revoke/grant sobre ella — sin esto, ese
-- revoke/grant (que no lleva IF EXISTS) fallaría con "function ... does
-- not exist" en cualquier replay puramente por CLI. No se toca
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
