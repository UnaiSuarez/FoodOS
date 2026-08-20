-- FoodOS — E16-04: ejecuta la decisión de producto E00-03 (docs/DECISIONES_PRODUCTO.md)
-- de eliminar el Feed. Las tres tablas estaban vacías (0 filas, comprobado
-- antes de escribir esta migración) — no hay contenido real de ningún
-- usuario que perder.

drop table if exists public.feed_comments;
drop table if exists public.feed_post_likes;
drop table if exists public.feed_posts;
