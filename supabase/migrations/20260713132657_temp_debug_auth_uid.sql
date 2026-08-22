-- FoodOS — temp_debug_auth_uid (reconciliación de historial, 2026-08-22)
-- Representación local exacta, recuperada de
-- supabase_migrations.schema_migrations.statements, de una migración
-- histórica ya aplicada y ya revertida en remoto (rwxysqzurjsrevdhbejy).
-- No tenía archivo local — nunca se comiteó al repo en su momento; se
-- aplicó y revirtió directamente contra la base durante una sesión de
-- depuración puntual de RLS (comprobar qué veía auth.uid() desde el
-- cliente). Se documenta aquí tal cual porque el historial es real, no
-- porque haga falta reaplicarla: 20260714074136_drop_temp_debug_auth_uid.sql
-- la revierte por completo (DROP FUNCTION), efecto neto cero sobre el
-- esquema actual. Añadir este archivo NO ejecuta nada contra la base real
-- — ambas versiones ya están registradas en
-- supabase_migrations.schema_migrations.

create or replace function public.debug_auth_uid()
returns text
language sql
security invoker
as $$ select auth.uid()::text $$;

grant execute on function public.debug_auth_uid() to authenticated;
