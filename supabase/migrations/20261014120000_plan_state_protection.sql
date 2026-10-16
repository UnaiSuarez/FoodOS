-- FoodOS — C0: protección del estado de plan (offset adaptativo, calibración y objetivos diarios)
-- frente a una sincronización obsoleta. Ver docs/NUTRITION_V4_C0_PLAN_STATE_PROTECTION.md.
--
-- ESTA MIGRACIÓN NO SE HA APLICADO EN NINGÚN ENTORNO REMOTO. Orden de despliegue (ver §Despliegue del
-- documento): 1) aplicar esta migración; 2) publicar el cliente nuevo; 3) tras comprobar con las consultas
-- de telemetría que no quedan clientes antiguos escribiendo objetivos, fijar la política `reject`.
--
-- Qué protege (todo lo que hoy escribe pushState como copia completa y posiblemente obsoleta):
--   1. user_profiles.extra_state->'adaptiveKcalOffsetKcal'    escritor único: fn_accept_nutrition_adjustment
--   2. user_profiles.extra_state->'adaptiveCalibrationStartedAt' / 'lastTargetChangedAt'  solo avanzan y
--      solo con fechas válidas y admitidas (2000-01-01 … hoy+1)
--   3. user_profiles.extra_state->'lastCalculationEngineVersion'  no vuelve a nulo
--   4. nutrition_goals  solo con base (basis_offset_kcal) vigente; un objetivo sellado conserva sello,
--      identidad y procedencia (snapshot/versión) salvo recálculo legítimo con base vigente
--
-- NO protege las columnas decisionales de user_profiles (goal, weight_kg, activity_level…): siguen con
-- «último escritor gana». Eso es C0b/C1, y esta migración no debe presentarse como protección del perfil.
--
-- Principio: «nunca lanza, conserva, registra y devuelve lo almacenado». Un push obsoleto no debe fallar en
-- bucle (los clientes antiguos no saben tratar el error). El cliente nuevo lo detecta releyendo
-- explícitamente con fn_plan_state_read (un INSERT omitido por el trigger no devuelve fila).
--
-- La excepción de las guardas es «escribe un rol distinto de authenticated/anon» (current_user): una
-- función SECURITY DEFINER de propietario postgres. Ningún parámetro, GUC ni cabecera del cliente la activa.
--
-- PROTOCOLO DE BLOQUEO (orden global; solo la aceptación toma más de un bloqueo):
--   perfil (P)  →  propuesta (R)  →  objetivo del día (G)  →  inserciones hoja (snapshot, conflictos)
--   - fn_accept_nutrition_adjustment: P → R → G, siempre en ese orden.
--   - Escrituras de cliente: pushState es una petición (transacción) por tabla; cada una mantiene UN
--     bloqueo (P o G) y las guardas solo LEEN (sin FOR UPDATE) las filas que no poseen. Sin ciclos posibles.
--   - La guarda de objetivos lee el offset sin bloquear el perfil: es correcto porque la aceptación escribe
--     su propio objetivo DESPUÉS de actualizar el offset y, si un push con la base anterior ya tenía la fila
--     bloqueada, la aceptación espera y la sobrescribe (el resultado final es siempre el de la aceptación);
--     si la aceptación ya comprometió, el trigger BEFORE UPDATE lee el offset nuevo tras esperar el bloqueo
--     de fila (cada sentencia plpgsql toma instantánea propia en READ COMMITTED).
--   Añadir FOR UPDATE/FOR SHARE al perfil dentro del trigger de objetivos invertiría el orden (G→P) frente
--   a la aceptación (P→G) y crearía un interbloqueo posible; por eso NO se hace.

-- ── 0. Funciones auxiliares: validación sin abortar ──────────────────────────────────────────────
create or replace function public.fn_plan_safe_date(p_text text)
returns date language plpgsql immutable set search_path = public, pg_temp
as $fn$
begin
  if p_text is null or p_text !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p_text::date;
exception when others then
  return null;
end;
$fn$;

-- Política temporal ÚNICA (el cliente usa la misma): fecha de calendario válida, >= 2000-01-01 y <= hoy+1
-- (holgura de un día por huso horario). Devuelve NULL si no la cumple; nunca lanza.
create or replace function public.fn_plan_admissible_date(p_text text)
returns date language plpgsql stable set search_path = public, pg_temp
as $fn$
declare
  v_date date := public.fn_plan_safe_date(p_text);
begin
  if v_date is null or v_date < date '2000-01-01' or v_date > current_date + 1 then
    return null;
  end if;
  return v_date;
end;
$fn$;

create or replace function public.fn_plan_json_text(p_value jsonb)
returns text language sql immutable set search_path = public, pg_temp
as $fn$
  select case when jsonb_typeof(p_value) = 'string' then p_value #>> '{}' end;
$fn$;

-- Offset válido: número entero con |valor| <= 10000. Cualquier otra cosa (texto, decimal, fuera de rango,
-- ausente) se considera «no inicializado»; nunca lanza.
create or replace function public.fn_plan_safe_offset(p_value jsonb)
returns integer language plpgsql immutable set search_path = public, pg_temp
as $fn$
declare
  v_num numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then
    return null;
  end if;
  v_num := (p_value #>> '{}')::numeric;
  if v_num <> trunc(v_num) or abs(v_num) > 10000 then
    return null;
  end if;
  return v_num::integer;
exception when others then
  return null;
end;
$fn$;

-- Marcador de protocolo: el cliente nuevo fija X-Client-Info = '… plan-protocol/1 …' (cabecera ya admitida
-- por CORS en supabase-js). PostgREST la expone en el GUC request.headers. Sin cabecera (conexión directa,
-- cliente antiguo) → nivel 0.
create or replace function public.fn_plan_protocol_level()
returns integer language plpgsql stable set search_path = public, pg_temp
as $fn$
declare
  v_headers text := current_setting('request.headers', true);
begin
  if v_headers is null or v_headers = '' then
    return 0;
  end if;
  if position('plan-protocol/1' in lower(coalesce((v_headers::json) ->> 'x-client-info', ''))) > 0 then
    return 1;
  end if;
  return 0;
exception when others then
  return 0;
end;
$fn$;

-- ── 1. Tablas y columnas ─────────────────────────────────────────────────────────────────────────
alter table public.nutrition_goals
  add column if not exists basis_offset_kcal integer;
comment on column public.nutrition_goals.basis_offset_kcal is
  'Offset adaptativo (kcal/día) con el que se calculó este objetivo (el «sello»). NULL = fila anterior a esta columna o escrita por un cliente que no la conoce. Una vez presente no puede quitarse desde un cliente.';

create table if not exists public.nutrition_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  detected_at timestamptz not null default now(),
  kind text not null check (kind in (
    'offset_overwrite_prevented', 'offset_invalid_value_rejected',
    'calibration_regression_prevented', 'calibration_invalid_value_rejected',
    'engine_version_regression_prevented',
    'daily_goal_overwrite_prevented', 'daily_goal_missing_basis',
    'daily_goal_delete_prevented', 'daily_goal_identity_change_prevented'
  )),
  subject text not null,
  kept jsonb,
  attempted jsonb,
  acknowledged_at timestamptz
);
comment on table public.nutrition_sync_conflicts is
  'Escrituras de estado de plan que una guarda conservó en vez de aplicar. Informativa: no concede autoridad (un cliente puede insertar filas propias).';
create unique index if not exists nutrition_sync_conflicts_open_uidx
  on public.nutrition_sync_conflicts (user_id, kind, subject, md5(coalesce(attempted::text, '')))
  where acknowledged_at is null;
create index if not exists nutrition_sync_conflicts_user_open_idx
  on public.nutrition_sync_conflicts (user_id, detected_at) where acknowledged_at is null;
alter table public.nutrition_sync_conflicts enable row level security;
drop policy if exists nutrition_sync_conflicts_select_own on public.nutrition_sync_conflicts;
create policy nutrition_sync_conflicts_select_own on public.nutrition_sync_conflicts for select using (user_id = auth.uid());
drop policy if exists nutrition_sync_conflicts_insert_own on public.nutrition_sync_conflicts;
create policy nutrition_sync_conflicts_insert_own on public.nutrition_sync_conflicts for insert with check (user_id = auth.uid());
drop policy if exists nutrition_sync_conflicts_ack_own on public.nutrition_sync_conflicts;
create policy nutrition_sync_conflicts_ack_own on public.nutrition_sync_conflicts for update using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.nutrition_sync_conflicts from public, anon, authenticated;
grant select, insert on public.nutrition_sync_conflicts to authenticated;
grant update (acknowledged_at) on public.nutrition_sync_conflicts to authenticated;
grant all on public.nutrition_sync_conflicts to service_role;

-- Política operativa de la transición de clientes antiguos (una sola fila).
create table if not exists public.plan_protection_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
insert into public.plan_protection_settings (key, value)
values ('legacy_goal_write_policy', 'allow_unsealed')
on conflict (key) do nothing;
comment on table public.plan_protection_settings is
  'legacy_goal_write_policy: allow_unsealed (por defecto: un cliente sin protocolo puede escribir un día aún sin sellar) | reject (un cliente sin protocolo nunca persiste objetivos). Se cambia con fn_plan_set_legacy_goal_write_policy.';
alter table public.plan_protection_settings enable row level security;
drop policy if exists plan_protection_settings_select on public.plan_protection_settings;
create policy plan_protection_settings_select on public.plan_protection_settings for select using (true);
revoke all on public.plan_protection_settings from public, anon, authenticated;
grant select on public.plan_protection_settings to authenticated;
grant all on public.plan_protection_settings to service_role;

-- Telemetría mínima y sin punto caliente: como máximo una fila por usuario y día con escritura de
-- objetivos desde un cliente SIN protocolo. El operador cuenta usuarios distintos por día antes de
-- fijar la política `reject`.
create table if not exists public.plan_legacy_writes (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  first_seen timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.plan_legacy_writes enable row level security;
drop policy if exists plan_legacy_writes_insert_own on public.plan_legacy_writes;
create policy plan_legacy_writes_insert_own on public.plan_legacy_writes for insert with check (user_id = auth.uid());
drop policy if exists plan_legacy_writes_select_own on public.plan_legacy_writes;
create policy plan_legacy_writes_select_own on public.plan_legacy_writes for select using (user_id = auth.uid());
revoke all on public.plan_legacy_writes from public, anon, authenticated;
grant select, insert on public.plan_legacy_writes to authenticated;
grant all on public.plan_legacy_writes to service_role;

-- Solo el rol de servicio (o el propietario) cambia la política.
create or replace function public.fn_plan_set_legacy_goal_write_policy(p_policy text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $fn$
begin
  if p_policy not in ('allow_unsealed', 'reject') then
    raise exception 'INVALID_POLICY: % (permitidos: allow_unsealed, reject)', p_policy;
  end if;
  update public.plan_protection_settings set value = p_policy, updated_at = now()
   where key = 'legacy_goal_write_policy';
end;
$fn$;
revoke all on function public.fn_plan_set_legacy_goal_write_policy(text) from public, anon, authenticated;
grant execute on function public.fn_plan_set_legacy_goal_write_policy(text) to service_role;

-- ── 2. Registro de conflictos (invoker: usa el permiso INSERT propio del usuario) ────────────────
create or replace function public.fn_plan_record_conflict(
  p_user uuid, p_kind text, p_subject text, p_kept jsonb, p_attempted jsonb
) returns void language plpgsql set search_path = public, pg_temp
as $fn$
begin
  insert into public.nutrition_sync_conflicts (user_id, kind, subject, kept, attempted)
  values (p_user, p_kind, p_subject, p_kept, p_attempted)
  on conflict do nothing;
exception when others then
  -- Informativo: un fallo al registrar nunca debe abortar la sincronización.
  null;
end;
$fn$;

-- ── 3. user_profiles: offset, calibración y versión de motor ─────────────────────────────────────
create or replace function public.fn_guard_plan_state_profile()
returns trigger language plpgsql set search_path = public, pg_temp
as $fn$
declare
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_raw_old jsonb;
  v_raw_new jsonb;
  v_o_off integer;
  v_n_off integer;
  v_o_date date;
  v_n_date date;
  v_final date;
begin
  if current_user not in ('authenticated', 'anon') then
    return NEW;
  end if;

  v_old := case when TG_OP = 'UPDATE' and jsonb_typeof(OLD.extra_state) = 'object' then OLD.extra_state else '{}'::jsonb end;
  v_new := case when jsonb_typeof(NEW.extra_state) = 'object' then NEW.extra_state else '{}'::jsonb end;

  -- (1) Offset: un valor válido ya almacenado solo lo cambia el RPC de aceptación. Si no hay valor
  --     válido almacenado, la primera escritura válida lo inicializa (cuentas nuevas y cuentas con
  --     offset persistido por pushState antes de esta migración, que conservan su valor).
  v_raw_old := v_old -> 'adaptiveKcalOffsetKcal';
  v_raw_new := v_new -> 'adaptiveKcalOffsetKcal';
  v_o_off := public.fn_plan_safe_offset(v_raw_old);
  v_n_off := public.fn_plan_safe_offset(v_raw_new);
  if v_o_off is not null then
    if v_raw_new is distinct from to_jsonb(v_o_off) then
      v_new := jsonb_set(v_new, '{adaptiveKcalOffsetKcal}', to_jsonb(v_o_off));
      if v_raw_new is not null and jsonb_typeof(v_raw_new) <> 'null' then
        perform public.fn_plan_record_conflict(
          NEW.user_id,
          case when v_n_off is not null then 'offset_overwrite_prevented' else 'offset_invalid_value_rejected' end,
          'adaptiveKcalOffsetKcal', to_jsonb(v_o_off), v_raw_new);
      end if;
    end if;
  elsif v_raw_new is not null and v_n_off is null then
    -- Sin valor almacenado válido y un valor entrante inválido: se sanea a null (no se guarda basura).
    v_new := jsonb_set(v_new, '{adaptiveKcalOffsetKcal}', 'null'::jsonb);
    if jsonb_typeof(v_raw_new) <> 'null' then
      perform public.fn_plan_record_conflict(NEW.user_id, 'offset_invalid_value_rejected', 'adaptiveKcalOffsetKcal', null, v_raw_new);
    end if;
  end if;

  -- (2) Calibración: fecha válida y admitida; solo avanza. Un valor almacenado inválido o «futuro»
  --     no se protege (se trata como ausente) para no fijar basura y para que sea corregible.
  foreach v_key in array array['adaptiveCalibrationStartedAt', 'lastTargetChangedAt'] loop
    v_raw_old := v_old -> v_key;
    v_raw_new := v_new -> v_key;
    v_o_date := public.fn_plan_admissible_date(public.fn_plan_json_text(v_raw_old));
    v_n_date := public.fn_plan_admissible_date(public.fn_plan_json_text(v_raw_new));
    v_final := case
      when v_o_date is null then v_n_date
      when v_n_date is null then v_o_date
      else greatest(v_o_date, v_n_date)
    end;
    if v_final is null then
      if v_raw_new is not null and jsonb_typeof(v_raw_new) <> 'null' then
        v_new := jsonb_set(v_new, array[v_key], 'null'::jsonb);
        perform public.fn_plan_record_conflict(NEW.user_id, 'calibration_invalid_value_rejected', v_key, null, v_raw_new);
      end if;
    elsif v_n_date is distinct from v_final then
      v_new := jsonb_set(v_new, array[v_key], to_jsonb(to_char(v_final, 'YYYY-MM-DD')));
      if v_raw_new is not null then
        perform public.fn_plan_record_conflict(
          NEW.user_id,
          case when v_n_date is null and jsonb_typeof(v_raw_new) = 'string' then 'calibration_invalid_value_rejected'
               else 'calibration_regression_prevented' end,
          v_key, to_jsonb(to_char(v_final, 'YYYY-MM-DD')), v_raw_new);
      end if;
    end if;
  end loop;

  -- (3) Versión del motor con la que se confirmó la ventana: no vuelve a nulo/ausente.
  v_raw_old := v_old -> 'lastCalculationEngineVersion';
  v_raw_new := v_new -> 'lastCalculationEngineVersion';
  if jsonb_typeof(v_raw_old) = 'string' and jsonb_typeof(v_raw_new) is distinct from 'string' then
    v_new := jsonb_set(v_new, '{lastCalculationEngineVersion}', v_raw_old);
    if v_raw_new is not null then
      perform public.fn_plan_record_conflict(NEW.user_id, 'engine_version_regression_prevented', 'lastCalculationEngineVersion', v_raw_old, v_raw_new);
    end if;
  end if;

  NEW.extra_state := v_new;
  return NEW;
end;
$fn$;

drop trigger if exists trg_guard_plan_state_profile on public.user_profiles;
create trigger trg_guard_plan_state_profile
  before insert or update on public.user_profiles
  for each row execute function public.fn_guard_plan_state_profile();

-- ── 4. nutrition_goals: sello, identidad y procedencia ───────────────────────────────────────────
-- Extrae la kcal de un `calorie_target` de snapshot SOLO si es un objeto con la clave `kcal` numérica.
-- Cualquier otra forma (ausente, JSON null, texto, array, objeto sin la clave) devuelve NULL de forma
-- explícita; los llamadores comparan con IS NULL, nunca con `<>` sobre un posible NULL (una condición
-- NULL no entra en un IF y habría dejado pasar un snapshot incompleto).
create or replace function public.fn_plan_snapshot_kcal(p_calorie_target jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp
as $fn$
begin
  if p_calorie_target is null or jsonb_typeof(p_calorie_target) <> 'object' then
    return null;
  end if;
  if not (p_calorie_target ? 'kcal') or jsonb_typeof(p_calorie_target -> 'kcal') <> 'number' then
    return null;
  end if;
  return (p_calorie_target ->> 'kcal')::numeric;
exception when others then
  return null;
end;
$fn$;

-- Un snapshot respalda un objetivo solo si es del mismo usuario y su kcal coincide con la de la fila.
-- ALCANCE: únicamente se comprueba la kcal. NO se validan macros, versión de cálculo ni modo: que un
-- snapshot figure como `source_snapshot_id` acredita la cifra de kcal, no el resto del objetivo.
create or replace function public.fn_plan_valid_snapshot(p_user uuid, p_snapshot uuid, p_kcal numeric)
returns uuid language plpgsql stable set search_path = public, pg_temp
as $fn$
declare
  v_kcal numeric;
  v_target jsonb;
begin
  if p_snapshot is null or p_kcal is null then
    return null;
  end if;
  select calorie_target into v_target
    from public.nutrition_calculation_snapshots
   where id = p_snapshot and user_id = p_user;
  if not found then
    return null;
  end if;
  v_kcal := public.fn_plan_snapshot_kcal(v_target);
  if v_kcal is null or v_kcal <> p_kcal then
    return null;
  end if;
  return p_snapshot;
exception when others then
  return null;
end;
$fn$;

create or replace function public.fn_guard_plan_state_goals()
returns trigger language plpgsql set search_path = public, pg_temp
as $fn$
declare
  v_level integer;
  v_policy text;
  v_existing public.nutrition_goals%rowtype;
  v_has boolean := false;
  v_server_offset integer;
  v_reason text;
  v_figures_changed boolean;
  v_declared boolean;
  v_kind text;
begin
  if current_user not in ('authenticated', 'anon') then
    if TG_OP = 'DELETE' then
      return OLD;
    end if;
    return NEW;
  end if;

  -- Borrado: una fila sellada o acreditada por un snapshot no se borra desde un cliente (se omitiría el
  -- sello con «borrar y reinsertar»). El borrado en cascada de la cuenta corre como propietario.
  if TG_OP = 'DELETE' then
    if OLD.basis_offset_kcal is not null or OLD.source_snapshot_id is not null then
      perform public.fn_plan_record_conflict(OLD.user_id, 'daily_goal_delete_prevented', 'goal:' || OLD.goal_date::text,
        jsonb_build_object('kcal', OLD.kcal_target, 'basisOffsetKcal', OLD.basis_offset_kcal), null);
      return null;
    end if;
    return OLD;
  end if;

  v_level := public.fn_plan_protocol_level();

  if TG_OP = 'UPDATE' then
    -- Identidad inmutable desde un cliente (mover un objetivo sellado a otra fecha/usuario).
    if NEW.user_id <> OLD.user_id or NEW.goal_date <> OLD.goal_date then
      perform public.fn_plan_record_conflict(OLD.user_id, 'daily_goal_identity_change_prevented', 'goal:' || OLD.goal_date::text,
        jsonb_build_object('userId', OLD.user_id, 'goalDate', OLD.goal_date),
        jsonb_build_object('userId', NEW.user_id, 'goalDate', NEW.goal_date));
      return OLD;
    end if;
    v_existing := OLD;
    v_has := true;
  else
    select * into v_existing from public.nutrition_goals
     where user_id = NEW.user_id and goal_date = NEW.goal_date;
    v_has := found;
  end if;

  if v_level = 0 then
    insert into public.plan_legacy_writes (user_id, day) values (NEW.user_id, current_date)
    on conflict do nothing;
  end if;

  v_policy := coalesce((select value from public.plan_protection_settings where key = 'legacy_goal_write_policy'), 'allow_unsealed');
  v_server_offset := coalesce(public.fn_plan_safe_offset(
    (select extra_state -> 'adaptiveKcalOffsetKcal' from public.user_profiles where user_id = NEW.user_id)), 0);

  v_figures_changed := v_has and (
    (v_existing.kcal_target, v_existing.protein_target_g, v_existing.carbs_target_g, v_existing.fat_target_g, v_existing.mode)
    is distinct from (NEW.kcal_target, NEW.protein_target_g, NEW.carbs_target_g, NEW.fat_target_g, NEW.mode));

  -- ¿Declara el escritor una base? Un cliente sin protocolo NUNCA la declara: si la fila ya estaba sellada
  -- y la base entrante coincide con la almacenada es el valor heredado de un UPDATE que no la menciona (o
  -- que la puso a NULL y se restauró), no una afirmación. Un cliente con protocolo siempre declara.
  v_declared := NEW.basis_offset_kcal is not null
    and not (v_level = 0 and v_has and v_existing.basis_offset_kcal is not null
             and NEW.basis_offset_kcal = v_existing.basis_offset_kcal);

  if v_level = 0 and v_policy = 'reject' then
    v_reason := 'legacy_policy_reject';
  elsif v_declared then
    if NEW.basis_offset_kcal <> v_server_offset then
      v_reason := 'basis_stale';
    end if;
  elsif v_level >= 1 then
    v_reason := 'missing_basis';
  elsif v_has and v_existing.basis_offset_kcal is not null then
    -- Cliente sin protocolo sobre una fila sellada: el sello no puede quitarse (UPDATE explícito a NULL
    -- incluido) y las cifras no pueden cambiar.
    NEW.basis_offset_kcal := v_existing.basis_offset_kcal;
    if v_figures_changed then
      v_reason := 'sealed_row_legacy_write';
    end if;
  end if;

  if v_reason is not null then
    v_kind := case v_reason when 'missing_basis' then 'daily_goal_missing_basis' else 'daily_goal_overwrite_prevented' end;
    perform public.fn_plan_record_conflict(NEW.user_id, v_kind, 'goal:' || NEW.goal_date::text,
      case when v_has then jsonb_build_object('kcal', v_existing.kcal_target, 'protein', v_existing.protein_target_g,
             'carbs', v_existing.carbs_target_g, 'fat', v_existing.fat_target_g, 'mode', v_existing.mode,
             'basisOffsetKcal', v_existing.basis_offset_kcal) end,
      jsonb_build_object('kcal', NEW.kcal_target, 'protein', NEW.protein_target_g, 'carbs', NEW.carbs_target_g,
             'fat', NEW.fat_target_g, 'mode', NEW.mode, 'basisOffsetKcal', NEW.basis_offset_kcal, 'reason', v_reason));
    -- Se conserva lo almacenado: en UPDATE se devuelve OLD; en INSERT (camino de un upsert) se omite la
    -- fila y RETURNING queda vacío → el cliente relee con fn_plan_state_read.
    if TG_OP = 'UPDATE' then
      return OLD;
    end if;
    return null;
  end if;

  -- Procedencia: una actualización legítima (base vigente) que cambia cifras o base ya no está acreditada
  -- por el snapshot anterior; solo conserva un snapshot nuevo aportado y coherente. Si nada se recalcula,
  -- snapshot y fecha de creación son inmutables desde un cliente.
  if TG_OP = 'UPDATE' then
    if v_figures_changed or NEW.basis_offset_kcal is distinct from OLD.basis_offset_kcal then
      NEW.source_snapshot_id := public.fn_plan_valid_snapshot(
        NEW.user_id,
        case when NEW.source_snapshot_id is distinct from OLD.source_snapshot_id then NEW.source_snapshot_id end,
        NEW.kcal_target);
    else
      NEW.source_snapshot_id := OLD.source_snapshot_id;
    end if;
    NEW.created_at := OLD.created_at;
  elsif not v_has then
    NEW.source_snapshot_id := public.fn_plan_valid_snapshot(NEW.user_id, NEW.source_snapshot_id, NEW.kcal_target);
  end if;

  return NEW;
end;
$fn$;

drop trigger if exists trg_guard_plan_state_goals on public.nutrition_goals;
create trigger trg_guard_plan_state_goals
  before insert or update or delete on public.nutrition_goals
  for each row execute function public.fn_guard_plan_state_goals();

-- ── 5. Lectura autoritativa (explícita: el INSERT omitido no devuelve fila) ───────────────────────
create or replace function public.fn_plan_state_read(p_goal_date date default null)
returns jsonb language plpgsql stable set search_path = public, pg_temp
as $fn$
declare
  v_extra jsonb;
  v_goal public.nutrition_goals%rowtype;
  v_goal_found boolean := false;
  v_cal date;
  v_ltc date;
begin
  select extra_state into v_extra from public.user_profiles where user_id = auth.uid();
  if p_goal_date is not null then
    select * into v_goal from public.nutrition_goals where user_id = auth.uid() and goal_date = p_goal_date;
    v_goal_found := found;
  end if;
  v_cal := public.fn_plan_admissible_date(public.fn_plan_json_text(v_extra -> 'adaptiveCalibrationStartedAt'));
  v_ltc := public.fn_plan_admissible_date(public.fn_plan_json_text(v_extra -> 'lastTargetChangedAt'));
  return jsonb_build_object(
    'protocol', 1,
    'serverDate', to_char(current_date, 'YYYY-MM-DD'),
    'offset', public.fn_plan_safe_offset(v_extra -> 'adaptiveKcalOffsetKcal'),
    'calibrationStartedAt', case when v_cal is not null then to_char(v_cal, 'YYYY-MM-DD') end,
    'lastTargetChangedAt', case when v_ltc is not null then to_char(v_ltc, 'YYYY-MM-DD') end,
    'engineVersion', public.fn_plan_json_text(v_extra -> 'lastCalculationEngineVersion'),
    'goal', case when v_goal_found then jsonb_build_object(
        'goalDate', to_char(v_goal.goal_date, 'YYYY-MM-DD'), 'kcal', v_goal.kcal_target, 'protein', v_goal.protein_target_g,
        'carbs', v_goal.carbs_target_g, 'fat', v_goal.fat_target_g, 'mode', v_goal.mode,
        'basisOffsetKcal', v_goal.basis_offset_kcal, 'calculationVersion', v_goal.calculation_version,
        'sourceSnapshotId', v_goal.source_snapshot_id) end,
    'conflicts', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'subject', c.subject) order by c.detected_at)
        from (select id, kind, subject, detected_at from public.nutrition_sync_conflicts
               where user_id = auth.uid() and acknowledged_at is null
               order by detected_at desc limit 20) c), '[]'::jsonb)
  );
end;
$fn$;
revoke all on function public.fn_plan_state_read(date) from public, anon;
grant execute on function public.fn_plan_state_read(date) to authenticated;

-- ── 6. fn_accept_nutrition_adjustment: orden de bloqueo, aritmética del offset y sello ───────────
-- Misma firma y mismo contrato que la vigente (20260819124430) salvo:
--   (a) bloqueo en el orden global P → R (la vigente bloqueaba solo R, y el perfil sin bloquear);
--   (b) el offset recibido debe ser EXACTAMENTE el vigente + delta de la propuesta (OFFSET_MISMATCH)
--       en vez de escribir un absoluto calculado por un cliente posiblemente obsoleto;
--   (c) el snapshot debe ser un objeto con calorie_target.kcal numérico (SNAPSHOT_INVALID) y esa kcal debe
--       coincidir con el objetivo que se sella (SNAPSHOT_MISMATCH). SOLO se valida la kcal: macros, versión
--       de cálculo y modo del snapshot los aporta el cliente y NO se comprueban;
--   (d) PROFILE_NOT_FOUND en vez de «aceptar» sin poder persistir el offset;
--   (e) el objetivo se sella con basis_offset_kcal.
-- La idempotencia ante respuesta perdida NO está aquí (es C2).
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
  v_uid uuid := auth.uid();
  v_proposal record;
  v_snapshot_id uuid;
  v_extra jsonb;
  v_current integer;
  v_profile_found boolean;
  v_snapshot_kcal numeric;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- P: perfil primero (orden global P → R → G).
  select extra_state into v_extra from public.user_profiles where user_id = v_uid for update;
  v_profile_found := found;

  -- R: propuesta.
  select * into v_proposal
  from public.nutrition_adjustment_proposals
  where id = p_proposal_id and user_id = v_uid
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

  if not v_profile_found then
    raise exception 'PROFILE_NOT_FOUND: no hay perfil donde persistir el ajuste';
  end if;

  v_current := coalesce(public.fn_plan_safe_offset(v_extra -> 'adaptiveKcalOffsetKcal'), 0);
  if p_new_offset_kcal <> v_current + v_proposal.delta_kcal then
    raise exception 'OFFSET_MISMATCH: el ajuste vigente es % y la propuesta (% kcal) no produce %', v_current, v_proposal.delta_kcal, p_new_offset_kcal;
  end if;

  -- Estructura, presencia y tipo explícitos (ver fn_plan_snapshot_kcal): solo se valida la kcal.
  if jsonb_typeof(p_snapshot) is distinct from 'object' then
    raise exception 'SNAPSHOT_INVALID: el snapshot debe ser un objeto JSON';
  end if;
  v_snapshot_kcal := public.fn_plan_snapshot_kcal(p_snapshot -> 'calorie_target');
  if v_snapshot_kcal is null then
    raise exception 'SNAPSHOT_INVALID: falta calorie_target.kcal numérico en el snapshot';
  end if;
  if v_snapshot_kcal <> p_kcal_target then
    raise exception 'SNAPSHOT_MISMATCH: la kcal del snapshot (%) no coincide con el objetivo que se va a aplicar (%)', v_snapshot_kcal, p_kcal_target;
  end if;

  update public.nutrition_adjustment_proposals
    set status = 'accepted', resolved_at = now()
    where id = p_proposal_id;

  insert into public.nutrition_calculation_snapshots (
    user_id, calculation_version, trigger_reason, input_snapshot,
    resting_energy, tdee, calorie_target, macros, safety
  ) values (
    v_uid,
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

  update public.user_profiles
    set extra_state = jsonb_set(coalesce(extra_state, '{}'::jsonb), '{adaptiveKcalOffsetKcal}', to_jsonb(p_new_offset_kcal)),
        updated_at = now()
    where user_id = v_uid;

  -- G: objetivo del día, el último en escribirse (ver protocolo de bloqueo).
  insert into public.nutrition_goals (
    user_id, goal_date, kcal_target, protein_target_g, carbs_target_g, fat_target_g,
    mode, calculation_version, source_snapshot_id, basis_offset_kcal
  ) values (
    v_uid, p_goal_date, p_kcal_target, coalesce(p_protein_g, 0), coalesce(p_carbs_g, 0), coalesce(p_fat_g, 0),
    coalesce(p_mode, 'recomp'), p_snapshot->>'calculation_version', v_snapshot_id, p_new_offset_kcal
  )
  on conflict (user_id, goal_date) do update set
    kcal_target = excluded.kcal_target,
    protein_target_g = excluded.protein_target_g,
    carbs_target_g = excluded.carbs_target_g,
    fat_target_g = excluded.fat_target_g,
    mode = excluded.mode,
    calculation_version = excluded.calculation_version,
    source_snapshot_id = excluded.source_snapshot_id,
    basis_offset_kcal = excluded.basis_offset_kcal;

  return jsonb_build_object(
    'ok', true,
    'status', 'accepted',
    'new_offset_kcal', p_new_offset_kcal,
    'snapshot_id', v_snapshot_id
  );
end;
$function$;

revoke all on function public.fn_accept_nutrition_adjustment from public;
grant execute on function public.fn_accept_nutrition_adjustment to authenticated;
