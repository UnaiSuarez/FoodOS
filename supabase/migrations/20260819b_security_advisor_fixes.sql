-- FoodOS — E20-05: correcciones detectadas por el linter de seguridad de
-- Supabase (get_advisors). Ninguna era una vulnerabilidad de RLS real (no
-- hay tablas sin RLS ni políticas que permitan leer/escribir datos de otro
-- usuario) — son dos endurecimientos de superficie de ataque + un defecto
-- de search_path, todos de bajo riesgo pero baratos de cerrar:
--
-- 1. fn_water_increment e is_almacen_member eran ejecutables por el rol
--    `anon` (sin sesión) vía /rest/v1/rpc/. Ambas ya se protegen
--    internamente con auth.uid() (devuelven una fila con user_id=NULL o
--    false sin sesión, nunca datos ajenos), pero no hay motivo para que una
--    petición sin autenticar pueda invocarlas — se cierra explícitamente.
-- 2. set_updated_at() (trigger de updated_at) no fijaba search_path —
--    mismo criterio que fn_water_increment/fn_accept_nutrition_adjustment,
--    que ya lo hacían.

alter function public.set_updated_at() set search_path to 'public';

revoke all on function public.fn_water_increment(date, integer) from public;
grant execute on function public.fn_water_increment(date, integer) to authenticated;

revoke all on function public.is_almacen_member(uuid) from public;
grant execute on function public.is_almacen_member(uuid) to authenticated;
