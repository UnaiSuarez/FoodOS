-- FoodOS — Procedencia nutricional de un item de inventario (Nutrition v4, PR3a→PR3)
--
-- Contexto: PR3a captura, por cada InventoryItem, de dónde salió cada número
-- (nutrientStatus: medido/estimado/ausente/heredado), si la referencia describe
-- el alimento en el estado en que se consume (foodStateConfidence) y el origen
-- del lote (dataSource: local/off/usda/ai/manual). inventory_items no tenía
-- dónde guardarlo (la columna `source` existente es otra cosa: manual/barcode/
-- photo_ai/cart/bank_ticket, con otros valores y otro significado), así que tras
-- sincronizar y recargar esa captura se perdía y el item se leía como dato sin
-- procedencia (legacy_unlabeled). Seguro, pero impedía que la captura aportara
-- cobertura a Nutrition v4.
--
-- Esta migración añade UNA columna JSONB nullable con la procedencia, guardada
-- con la propia fila:
--
--   { "dataSource": "off",
--     "nutrientStatus": { "kcal": "known_nonzero", "fat": "unknown", ... },
--     "foodStateConfidence": "confirmed",
--     "basis": { "kcal": 165, "protein": 31, "carbs": 0, "fat": 3.6 } }
--
-- `basis` son los valores por 100 g/ml a los que describe la procedencia. Lo
-- lee el cliente para descartarla si los números de la fila cambiaron desde
-- fuera (ver «Clientes antiguos»). La validación fina del contenido (claves y
-- estados válidos, frescura) la hace el cliente al leer y al escribir
-- (apps/web/src/lib/inventory-provenance-persistence.ts); la base solo exige que,
-- si hay valor, sea un objeto JSON.
--
-- ─── Compatibilidad ────────────────────────────────────────────────────────
-- Migración COMPATIBLE HACIA DELANTE, igual que unit_size_dimension: solo añade
-- una columna nullable, sin valor por defecto, sin tocar filas ni ningún otro
-- objeto. Sin backfill: las filas existentes quedan en NULL, que el cliente lee
-- como «sin procedencia» (legacy_unlabeled) — no hay forma segura de inferir el
-- origen de un dato ya guardado.
--
-- Clientes antiguos (el código actualmente desplegado, que no conoce la columna):
--  * Leen con una lista explícita de columnas en su .select(): no la piden, no
--    les afecta.
--  * Escriben con upsert (on_conflict=id, Prefer: resolution=merge-duplicates).
--    supabase-js declara `columns` = las claves de su payload (comprobado en
--    postgrest-js, PostgrestQueryBuilder.upsert) y PostgREST solo actualiza esas
--    en el ON CONFLICT DO UPDATE: la columna nueva se conserva. (El lado del
--    servidor es el comportamiento documentado de PostgREST; no se ha ejercitado
--    contra esta base.) Lo que un cliente antiguo SÍ puede hacer es cambiar los
--    números por 100 de la fila sin tocar la procedencia; por eso `basis` — un
--    cliente nuevo descarta una procedencia cuyos números ya no coinciden en
--    vez de seguir afirmándola.
--
-- Seguridad de acceso: ninguna política ni permiso nuevo. La tabla ya tiene RLS
-- por fila (inventory_select_member / insert_member / update_owner /
-- delete_owner) y privilegios de tabla completos para `authenticated`; una
-- columna nueva los hereda. No se concede nada a `anon`.
--
-- ─── Orden de despliegue (IMPORTANTE) ─────────────────────────────────────
-- 1. Aplicar esta migración en remoto y verificarla (consulta al final).
-- 2. SOLO DESPUÉS, desplegar el código de la app que la lee y escribe. Ese
--    código referencia `nutrition_provenance` en el .select() de inventario y
--    en el upsert: sin la columna, PostgREST rechaza la petición entera
--    (inventario no sincroniza) — mismo riesgo y mismo orden que
--    unit_size_unit (20260908120000).
-- El orden inverso (código antes que migración) no es seguro; el código
-- antiguo con la migración aplicada sí lo es. Para deshacer: volver al código
-- anterior; la columna puede quedarse (nadie la lee) o eliminarse después con
-- `alter table public.inventory_items drop column nutrition_provenance;`.
--
-- ─── Reproducibilidad ─────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS (Postgres la salta entera si ya existe). El
-- constraint va en una sentencia aparte, con nombre explícito y estable y
-- guardada tras comprobar pg_constraint, así resiste una re-ejecución PARCIAL.
--
-- Verificación tras aplicar (debe devolver 1 fila: jsonb / YES):
--   select data_type, is_nullable from information_schema.columns
--   where table_schema = 'public' and table_name = 'inventory_items'
--     and column_name = 'nutrition_provenance';

alter table public.inventory_items
  add column if not exists nutrition_provenance jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_items_nutrition_provenance_check'
      and conrelid = 'public.inventory_items'::regclass
  ) then
    alter table public.inventory_items
      add constraint inventory_items_nutrition_provenance_check
      check (nutrition_provenance is null or jsonb_typeof(nutrition_provenance) = 'object');
  end if;
end $$;

comment on column public.inventory_items.nutrition_provenance is
  'Procedencia nutricional del item (Nutrition v4): {dataSource, nutrientStatus, foodStateConfidence, basis}. basis = valores por 100 a los que describe; si ya no coinciden con las columnas de la fila, el cliente la descarta. NULL = sin procedencia (dato anterior a PR3a): se lee como legacy_unlabeled. Ver apps/web/src/lib/inventory-provenance-persistence.ts.';
