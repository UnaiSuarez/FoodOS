-- FoodOS — PR8: integridad transaccional al aceptar/rechazar una propuesta de
-- ajuste adaptativo (ver docs/REVISION_NUTRICION_PR48-52.md, N2/N3/N12/N14).
--
-- Antes de esta migración, aceptar una propuesta eran 3 pasos independientes
-- desde el cliente (resolver la propuesta en Supabase, mutar el offset en
-- estado local, esperar a que el sync general guardara el perfil más tarde)
-- sin comprobar errores intermedios. Eso podía dejar: una propuesta aceptada
-- sin offset aplicado, un offset local sin propuesta resuelta, o una
-- propuesta resuelta en un dispositivo con el perfil desactualizado en otro.
--
-- fn_accept_nutrition_adjustment hace todo (o nada) en una única transacción:
--   1. Bloquea y valida la propuesta (pertenece al usuario, sigue pendiente).
--   2. Si se rechaza: solo cambia su estado.
--   3. Si se acepta: resuelve la propuesta, guarda el snapshot final del
--      ajuste, aplica el offset al perfil y actualiza el objetivo vigente —
--      las cuatro escrituras viven en la misma transacción de Postgres.
-- El SELECT ... FOR UPDATE también impide la doble aceptación: una segunda
-- llamada concurrente sobre la misma propuesta espera a que la primera
-- transacción termine y encuentra status <> 'pending'.

-- Nuevo trigger_reason para el snapshot que documenta el objetivo tras
-- aceptar un ajuste (distinto de 'adaptive_review', que es la revisión que
-- generó la propuesta, no el resultado de aceptarla).
alter table public.nutrition_calculation_snapshots
  drop constraint if exists nutrition_calculation_snapshots_trigger_reason_check;
alter table public.nutrition_calculation_snapshots
  add constraint nutrition_calculation_snapshots_trigger_reason_check
  check (trigger_reason in (
    'initial_calculation', 'profile_changed', 'goal_changed',
    'manual_recalculation', 'adaptive_review', 'manual_override',
    'adaptive_adjustment_accepted'
  ));

create or replace function public.fn_accept_nutrition_adjustment(
  p_proposal_id uuid,
  p_accepted boolean,
  p_new_offset_kcal integer default null,
  p_goal_date date default current_date,
  p_kcal_target integer default null,
  p_protein_g numeric default null,
  p_carbs_g numeric default null,
  p_fat_g numeric default null,
  p_mode text default null,
  p_snapshot jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_proposal record;
  v_snapshot_id uuid;
begin
  -- FOR UPDATE bloquea la fila: una segunda llamada concurrente sobre la
  -- misma propuesta espera aquí y, al continuar, ya ve status <> 'pending'.
  select * into v_proposal
  from public.nutrition_adjustment_proposals
  where id = p_proposal_id and user_id = auth.uid()
  for update;

  if not found then
    raise exception 'PROPOSAL_NOT_FOUND: no existe esa propuesta o no pertenece a este usuario';
  end if;

  if v_proposal.status <> 'pending' then
    raise exception 'PROPOSAL_NOT_PENDING: la propuesta ya se resolvió (estado actual: %) — probablemente desde otro dispositivo o pestaña', v_proposal.status;
  end if;

  if not p_accepted then
    update public.nutrition_adjustment_proposals
      set status = 'rejected', resolved_at = now()
      where id = p_proposal_id;
    return jsonb_build_object('ok', true, 'status', 'rejected', 'new_offset_kcal', null, 'snapshot_id', null);
  end if;

  if p_new_offset_kcal is null or p_kcal_target is null or p_snapshot is null then
    raise exception 'MISSING_PARAMS: faltan datos necesarios para aplicar el ajuste';
  end if;

  update public.nutrition_adjustment_proposals
    set status = 'accepted', resolved_at = now()
    where id = p_proposal_id;

  -- Snapshot inmutable del objetivo final, igual criterio que
  -- saveNutritionSnapshot/createAdjustmentReview (ver N14).
  insert into public.nutrition_calculation_snapshots (
    user_id, calculation_version, trigger_reason, input_snapshot,
    resting_energy, tdee, calorie_target, macros, safety
  ) values (
    auth.uid(),
    p_snapshot->>'calculation_version',
    'adaptive_adjustment_accepted',
    p_snapshot->'input_snapshot',
    p_snapshot->'resting_energy',
    p_snapshot->'tdee',
    p_snapshot->'calorie_target',
    p_snapshot->'macros',
    p_snapshot->'safety'
  )
  returning id into v_snapshot_id;

  -- El offset adaptativo vive en extra_state (jsonb), igual que
  -- trainingActivity/macroPreference — ver mapProfileRow en data-layer.ts.
  update public.user_profiles
    set extra_state = jsonb_set(coalesce(extra_state, '{}'::jsonb), '{adaptiveKcalOffsetKcal}', to_jsonb(p_new_offset_kcal)),
        updated_at = now()
    where user_id = auth.uid();

  insert into public.nutrition_goals (
    user_id, goal_date, kcal_target, protein_target_g, carbs_target_g, fat_target_g,
    mode, calculation_version, source_snapshot_id
  ) values (
    auth.uid(), p_goal_date, p_kcal_target, coalesce(p_protein_g, 0), coalesce(p_carbs_g, 0), coalesce(p_fat_g, 0),
    coalesce(p_mode, 'recomp'), p_snapshot->>'calculation_version', v_snapshot_id
  )
  on conflict (user_id, goal_date) do update set
    kcal_target = excluded.kcal_target,
    protein_target_g = excluded.protein_target_g,
    carbs_target_g = excluded.carbs_target_g,
    fat_target_g = excluded.fat_target_g,
    calculation_version = excluded.calculation_version,
    source_snapshot_id = excluded.source_snapshot_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'accepted',
    'new_offset_kcal', p_new_offset_kcal,
    'snapshot_id', v_snapshot_id
  );
end;
$function$;

comment on function public.fn_accept_nutrition_adjustment is
  'Acepta o rechaza una nutrition_adjustment_proposal de forma atómica: resuelve la propuesta, y si se acepta también guarda el snapshot final, aplica el offset al perfil y actualiza nutrition_goals — todo en una transacción, con bloqueo de fila para impedir doble aceptación concurrente.';

-- SECURITY DEFINER: la función necesita escribir en user_profiles y
-- nutrition_goals de forma atómica junto con nutrition_adjustment_proposals,
-- pero cada paso sigue comprobando auth.uid() explícitamente (igual que
-- fn_water_increment) — no es una puerta abierta, es la misma restricción de
-- "solo tus propias filas" que ya imponían las policies, aplicada dentro de
-- una sola transacción en vez de en tres llamadas sueltas del cliente.
revoke all on function public.fn_accept_nutrition_adjustment from public;
grant execute on function public.fn_accept_nutrition_adjustment to authenticated;
