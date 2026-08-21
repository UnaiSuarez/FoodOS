-- FoodOS — Política de SELECT que faltaba en storage.objects para el bucket
-- product-images. La lectura pública de las fotos funciona sin ella (pasa por
-- /object/public/, que no usa RLS), pero la API de Storage SÍ necesita poder
-- ver la fila bajo RLS antes de poder borrarla: sin esta política, un DELETE
-- autenticado respondía 200 sin error pero no borraba nada (0 filas
-- afectadas). Idempotente.

do $$ begin
  create policy "product images: select own folder"
    on storage.objects for select to authenticated
    using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
exception when duplicate_object then null; end $$;
