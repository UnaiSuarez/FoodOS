-- FoodOS — Migración sync v2
-- Añade: weight_log, extra_state en user_profiles, target_weight_kg,
-- y habilita realtime en water_log y weight_log.
-- Idempotente: usa IF NOT EXISTS y ADD COLUMN IF NOT EXISTS.

-- ---------- user_profiles: nuevas columnas ----------

alter table public.user_profiles
  add column if not exists target_weight_kg numeric(5,1),
  add column if not exists extra_state jsonb not null default '{}';

comment on column public.user_profiles.extra_state is
  'JSONB blob con datos de app no tabulados: routines, workoutLog, customRecipes, mealPlan, plannerQuickMeals, categoryBudgets, savingsGoalPct.';

comment on column public.user_profiles.target_weight_kg is
  'Peso objetivo del usuario en kg (perfil físico). Separado de extra_state para filtrarlo en Realtime fácilmente.';

-- ---------- weight_log: serie temporal de peso corporal ----------

create table if not exists public.weight_log (
  user_id  uuid    not null references auth.users(id) on delete cascade,
  log_date date    not null,
  kg       numeric(5,1) not null check (kg > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, log_date)
);

alter table public.weight_log enable row level security;

create policy "weight_log_own" on public.weight_log
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace trigger trg_weight_log_updated_at
  before update on public.weight_log
  for each row execute function public.set_updated_at();

-- ---------- Realtime: habilitar broadcast para las nuevas tablas ----------
-- Ejecuta esto si no lo tienes ya habilitado desde el dashboard de Supabase:
-- Database → Replication → Tables → activar water_log y weight_log.

do $$
begin
  begin
    alter publication supabase_realtime add table public.water_log;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.weight_log;
  exception when duplicate_object then null;
  end;
end $$;
