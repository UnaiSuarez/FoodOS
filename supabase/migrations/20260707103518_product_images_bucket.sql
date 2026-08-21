-- FoodOS — Bucket de Storage para fotos de producto (cámara/galería)
-- Hasta ahora las fotos se guardaban como data-URLs base64 DENTRO del estado
-- de la app: cada foto (~30-80KB) viajaba en cada serialización a localStorage
-- y en cada push del inventario a Supabase, con riesgo de superar la cuota de
-- 5MB de localStorage. Con este bucket, en el estado solo se guarda la URL.
-- Idempotente.

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Subida/borrado solo autenticado y solo dentro de la carpeta propia (userId/...).
-- Lectura: el bucket es público, los objetos se sirven por URL pública directa.
do $$ begin
  create policy "product images: insert own folder"
    on storage.objects for insert to authenticated
    with check (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "product images: delete own folder"
    on storage.objects for delete to authenticated
    using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
exception when duplicate_object then null; end $$;
