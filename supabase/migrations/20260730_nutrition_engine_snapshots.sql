-- FoodOS — Motor nutricional: versionado del modelo de actividad, snapshots
-- de cálculo y propuestas de ajuste (infraestructura para TDEE adaptativo).
-- Idempotente: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS en todo.

-- ── 1. Versionado del modelo de actividad ───────────────────────────────────
-- No cambia ningún cálculo todavía. Todos los perfiles existentes y nuevos
-- quedan en 'legacy_total_pal' (activity_level = PAL total, vida + entreno)
-- hasta que una futura versión de la app ofrezca el cuestionario del modelo
-- 'lifestyle_plus_training' y el usuario lo guarde explícitamente. Sin esto,
-- reinterpretar activity_level con otro significado cambiaría el TDEE de
-- perfiles ya guardados sin que el usuario tocara nada.
alter table public.user_profiles
  add column if not exists activity_model_version text not null default 'legacy_total_pal'
    check (activity_model_version in ('legacy_total_pal', 'lifestyle_plus_training'));

comment on column public.user_profiles.activity_model_version is
  'Qué modelo interpreta activity_level: legacy_total_pal (PAL = vida+entreno, el único que existe hoy) o lifestyle_plus_training (futuro, PAL solo vida + asignación de entreno aparte).';

-- ── 2. Trazabilidad en nutrition_goals ───────────────────────────────────────
alter table public.nutrition_goals
  add column if not exists calculation_version text not null default 'nutrition-v1',
  add column if not exists source_snapshot_id uuid;

comment on column public.nutrition_goals.calculation_version is
  'Con qué lógica de nutrition.ts se generó este objetivo — permite saber si un cambio de fórmula futuro afecta a un plan concreto.';
comment on column public.nutrition_goals.source_snapshot_id is
  'Snapshot de nutrition_calculation_snapshots que originó este objetivo (null en filas anteriores a esta migración).';

-- ── 3. Snapshots de cálculo (inmutables) ─────────────────────────────────────
-- Un snapshot por cada vez que se recalculan los objetivos (guardar perfil,
-- cambiar objetivo, futura revisión adaptativa...). Nunca se actualiza ni se
-- borra: es la explicación de "por qué tenías este objetivo en esta fecha".
create table if not exists public.nutrition_calculation_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  calculation_version text not null,
  trigger_reason text not null check (trigger_reason in (
    'initial_calculation', 'profile_changed', 'goal_changed',
    'manual_recalculation', 'adaptive_review', 'manual_override'
  )),
  input_snapshot jsonb not null,
  resting_energy jsonb not null,
  tdee jsonb not null,
  calorie_target jsonb not null,
  macros jsonb not null,
  safety jsonb not null
);

comment on table public.nutrition_calculation_snapshots is
  'Historial inmutable de cómo se calculó cada objetivo nutricional — nunca se actualiza ni se borra (salvo borrado de cuenta vía cascade).';

create index if not exists nutrition_snapshots_user_created_idx
  on public.nutrition_calculation_snapshots (user_id, created_at desc);

alter table public.nutrition_goals
  drop constraint if exists nutrition_goals_source_snapshot_fk;
alter table public.nutrition_goals
  add constraint nutrition_goals_source_snapshot_fk
  foreign key (source_snapshot_id)
  references public.nutrition_calculation_snapshots(id)
  on delete set null;

alter table public.nutrition_calculation_snapshots enable row level security;

drop policy if exists "nutrition_snapshots_select_own" on public.nutrition_calculation_snapshots;
create policy "nutrition_snapshots_select_own" on public.nutrition_calculation_snapshots
  for select using (user_id = auth.uid());

drop policy if exists "nutrition_snapshots_insert_own" on public.nutrition_calculation_snapshots;
create policy "nutrition_snapshots_insert_own" on public.nutrition_calculation_snapshots
  for insert with check (user_id = auth.uid());

-- Sin policy de update/delete a propósito: un snapshot es inmutable.

-- ── 4. Propuestas de ajuste (para el futuro motor adaptativo) ───────────────
-- Vacía hasta que exista el TDEE adaptativo — se crea ahora porque es barata
-- y evita otra migración cuando llegue esa fase.
create table if not exists public.nutrition_adjustment_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_id uuid not null references public.nutrition_calculation_snapshots(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  current_target_kcal integer not null,
  proposed_target_kcal integer not null,
  delta_kcal integer not null check (delta_kcal between -150 and 150),
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','expired')),
  resolved_at timestamptz
);

comment on table public.nutrition_adjustment_proposals is
  'Ajustes de calorías propuestos por el motor adaptativo (aún sin implementar) — nunca se aplican solos, requieren aceptación explícita del usuario.';

create index if not exists nutrition_proposals_user_status_idx
  on public.nutrition_adjustment_proposals (user_id, status);

alter table public.nutrition_adjustment_proposals enable row level security;

drop policy if exists "nutrition_proposals_select_own" on public.nutrition_adjustment_proposals;
create policy "nutrition_proposals_select_own" on public.nutrition_adjustment_proposals
  for select using (user_id = auth.uid());

drop policy if exists "nutrition_proposals_insert_own" on public.nutrition_adjustment_proposals;
create policy "nutrition_proposals_insert_own" on public.nutrition_adjustment_proposals
  for insert with check (user_id = auth.uid());

drop policy if exists "nutrition_proposals_update_own" on public.nutrition_adjustment_proposals;
create policy "nutrition_proposals_update_own" on public.nutrition_adjustment_proposals
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
