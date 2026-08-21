-- FoodOS — Nutrition v3: edad mínima 18 años en user_profiles
-- Ver docs/NUTRITION_V3_DECISIONES.md §2.2 — el motor nutricional (Mifflin-St
-- Jeor, guardarraíles de déficit, modelo adaptativo) está calibrado para
-- adultos; FoodOS no implementa un motor pediátrico. El formulario aceptaba
-- age >= 14 (bug real, ver OnboardingFlow.tsx), y el CHECK de la tabla nunca
-- tuvo un mínimo por encima de 0.
--
-- Auditoría previa a esta migración (2026-08-21, proyecto rwxysqzurjsrevdhbejy):
--   total_perfiles=3, menores_18=0, edad_minima=24, edad_maxima=25.
-- Sin filas afectadas. Aun así, esta migración NO asume que seguirá siendo
-- así en cualquier entorno donde se aplique (staging, otro proyecto, un
-- re-seed con datos antiguos): si existiera algún perfil con age < 18, el
-- ALTER TABLE de más abajo falla con el error nativo de Postgres por
-- violación del CHECK — no hay UPDATE silencioso que "corrija" la edad para
-- que la migración pase. Si eso ocurre, el caso debe revisarse a mano.
--
-- Aplicada ya en remoto vía MCP apply_migration (2026-08-21) antes de
-- renombrar este archivo — el timestamp del nombre (20260821202150) se
-- ajustó para coincidir EXACTAMENTE con la versión que quedó registrada
-- en el historial remoto (supabase_migrations.schema_migrations), no con
-- la fecha real de creación del archivo. MCP genera su propio timestamp
-- al aplicar, distinto del nombre de archivo local original (que además
-- no llevaba hora, solo fecha) — sin este ajuste, `supabase migration
-- list` tras enlazar el proyecto habría mostrado esta migración como no
-- reconciliada. El SQL en sí no se re-ejecuta al renombrar.

alter table public.user_profiles
  drop constraint if exists user_profiles_age_check;

alter table public.user_profiles
  add constraint user_profiles_age_check
  check (age is null or (age >= 18 and age < 120));

comment on column public.user_profiles.age is
  'Edad en años. Mínimo 18 — el motor nutricional (nutrition.ts) está calibrado para adultos, ver docs/NUTRITION_V3_DECISIONES.md §2.2.';
