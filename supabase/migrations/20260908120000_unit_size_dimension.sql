-- FoodOS — Dimension de unit_size (masa vs. volumen)
--
-- Contexto (revision externa, ronda de cierre de auditoria 2026-09-08):
-- unit_size es un numero ambiguo — un 60 podria ser "60 g" (ej. 1 huevo) o
-- "60 ml" (ej. una salsa embotellada por unidades). Nada en la fila declara
-- cual de los dos es, asi que ninguna conversion estricta (convertQty, ver
-- apps/web/src/lib/utils.ts) puede usarlo para cruzar "ud" a masa o volumen
-- sin arriesgarse a tratar mililitros como si fueran gramos o viceversa.
--
-- Esta columna cierra ese hueco: declara explicitamente la magnitud de
-- unit_size. Es una migracion COMPATIBLE HACIA DELANTE: solo anade una
-- columna nullable, no toca filas existentes ni ningun otro objeto — el
-- codigo actualmente desplegado (que no conoce esta columna) sigue
-- funcionando exactamente igual antes y despues de aplicarla.
--
-- Sin backfill especulativo: no hay forma segura de inferir la magnitud de
-- datos ya guardados sin inventarla, asi que las filas existentes quedan en
-- NULL. Con NULL (dato legacy o aun sin declarar), convertQty se rehusa a
-- convertir "ud" a masa o volumen — el lote/ingrediente simplemente no
-- cuenta para ese calculo, nunca se asume, hasta que el usuario lo confirme
-- al editar (EditInventoryModal/CreateRecipeModal ya piden esta magnitud de
-- forma explicita en el codigo de la app que consume esta columna).
--
-- Reproducibilidad: columna con ADD COLUMN IF NOT EXISTS (Postgres la salta
-- entera, constraint incluido, si ya existe con ese nombre). El constraint
-- de valores va en una sentencia APARTE, con nombre explicito y estable
-- (nunca el autogenerado de Postgres), guardada tras comprobar pg_constraint
-- — así resiste tambien una re-ejecucion PARCIAL (ej. la columna ya se creo
-- en un intento previo pero el constraint no llego a aplicarse).
--
-- Orden de despliegue: esta migracion se aplica y verifica ANTES de
-- desplegar el codigo de la app que empieza a leer/escribir
-- unit_size_unit (ver PR fix/inventory-unit-safety) — ese codigo no se
-- abre/mergea hasta que esta migracion este aplicada en remoto.

alter table public.inventory_items
  add column if not exists unit_size_unit text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_items_unit_size_unit_check'
      and conrelid = 'public.inventory_items'::regclass
  ) then
    alter table public.inventory_items
      add constraint inventory_items_unit_size_unit_check
      check (unit_size_unit in ('g', 'ml') or unit_size_unit is null);
  end if;
end $$;

comment on column public.inventory_items.unit_size_unit is
  'Dimension de unit_size: ''g'' (solido) o ''ml'' (liquido). NULL = legacy, sin declarar — no usable para convertir "ud" a masa/volumen (ver convertQty en utils.ts).';

alter table public.shopping_items
  add column if not exists unit_size_unit text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shopping_items_unit_size_unit_check'
      and conrelid = 'public.shopping_items'::regclass
  ) then
    alter table public.shopping_items
      add constraint shopping_items_unit_size_unit_check
      check (unit_size_unit in ('g', 'ml') or unit_size_unit is null);
  end if;
end $$;

comment on column public.shopping_items.unit_size_unit is
  'Dimension de unit_size, heredada del item de inventario origen. Ver comentario en inventory_items.unit_size_unit.';
