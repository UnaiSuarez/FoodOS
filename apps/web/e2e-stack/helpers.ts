// Validación de C0 contra un stack Supabase REAL pero DESECHABLE (Supabase CLI + Docker en el runner de CI):
// GoTrue (Auth) + PostgREST + Kong + Postgres 17 con las migraciones del repositorio. NO es un proyecto alojado
// (ver docs/NUTRITION_V4_C0_PLAN_STATE_PROTECTION.md §8: qué queda pendiente del servicio alojado).
//
// Reglas de este módulo:
//  - se niega a ejecutarse si la URL no es el stack local (127.0.0.1/localhost) o contiene el identificador de
//    cualquiera de los proyectos Supabase reales de la organización;
//  - la clave de servicio SOLO se usa para preparar y limpiar (crear/borrar cuentas QA sintéticas, fijar la
//    política de transición en las pruebas de §6); nunca para acreditar permisos del usuario;
//  - ninguna contraseña ni clave se imprime ni se guarda en evidencias.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import { PLAN_PROTOCOL_CLIENT_INFO } from "../src/lib/supabase";

const FORBIDDEN = ["rwxysqzurjsrevdhbejy", "qzwooagxilzohyjgdpjg", "supabase.co", "supabase.com"];

export const API_URL = process.env.STACK_API_URL ?? "";
export const ANON_KEY = process.env.STACK_ANON_KEY ?? "";
export const SERVICE_KEY = process.env.STACK_SERVICE_KEY ?? "";
export const RUN_ID = process.env.STACK_RUN_ID ?? randomUUID().slice(0, 8);

export function assertIsolated(): void {
  if (!API_URL || !ANON_KEY || !SERVICE_KEY) throw new Error("faltan STACK_API_URL / STACK_ANON_KEY / STACK_SERVICE_KEY (stack local de CI)");
  const u = new URL(API_URL);
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error(`STACK_API_URL no es el stack local: ${u.hostname}`);
  if (FORBIDDEN.some((f) => API_URL.includes(f))) throw new Error("STACK_API_URL apunta a un proyecto real");
}

const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

/** Cliente administrativo: SOLO preparar y limpiar. */
export function adminClient(): SupabaseClient {
  assertIsolated();
  return createClient(API_URL, SERVICE_KEY, { auth: noSession });
}

export interface QaUser { id: string; email: string; password: string }

/** Cuenta QA sintética, ya confirmada (sin enviar invitaciones ni correos). Dominio reservado `.invalid`. */
export async function createQaUser(label: string): Promise<QaUser> {
  const email = `qa-c0-${RUN_ID}-${label}@example.invalid`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`no se pudo crear la cuenta QA ${label}: ${error?.message}`);
  return { id: data.user.id, email, password };
}

export async function deleteQaUser(u: QaUser): Promise<void> {
  if (!u.email.startsWith(`qa-c0-${RUN_ID}-`)) throw new Error("solo se borran cuentas QA creadas en esta ejecución");
  await adminClient().auth.admin.deleteUser(u.id);
}

/** Sesión real con la clave pública. `legacy` = cliente antiguo: sin el marcador (cabecera por defecto de supabase-js). */
export async function signedClient(u: QaUser, opts: { legacy?: boolean } = {}): Promise<SupabaseClient> {
  assertIsolated();
  const c = createClient(API_URL, ANON_KEY, {
    auth: noSession,
    ...(opts.legacy ? {} : { global: { headers: { "X-Client-Info": PLAN_PROTOCOL_CLIENT_INFO } } }),
  });
  const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`inicio de sesión QA fallido: ${error.message}`);
  return c;
}

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Crea la fila base del perfil (como ensureBaseRows) con un offset de partida. */
export async function seedProfileRow(c: SupabaseClient, userId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const { error } = await c.from("user_profiles").upsert({ user_id: userId, extra_state: { adaptiveKcalOffsetKcal: 0, ...extra } }, { onConflict: "user_id" });
  if (error) throw new Error(`perfil base: ${error.message}`);
}

export async function planRead(c: SupabaseClient, goalDate: string | null = todayUtc()): Promise<PlanRead> {
  const { data, error } = await c.rpc("fn_plan_state_read", { p_goal_date: goalDate });
  if (error) throw new Error(`fn_plan_state_read: ${error.code} ${error.message}`);
  return data as PlanRead;
}
export interface PlanRead {
  protocol: number; clientProtocolLevel: number; serverDate: string; offset: number | null;
  calibrationStartedAt: string | null; lastTargetChangedAt: string | null; engineVersion: string | null;
  goal: { kcal: number; basisOffsetKcal: number | null; sourceSnapshotId: string | null } | null;
  conflicts: Array<{ id: string; kind: string; subject: string }>;
}

export const SNAP = (kcal: number) => ({ calculation_version: "nutrition-v3.1", input_snapshot: {}, resting_energy: {}, tdee: {}, calorie_target: { kcal }, macros: {}, safety: {} });

/** Inserta snapshot + propuesta pendiente con los permisos del propio usuario (SELECT/INSERT, como la app). */
export async function propose(c: SupabaseClient, userId: string, currentKcal: number, proposedKcal: number): Promise<string> {
  const s = await c.from("nutrition_calculation_snapshots").insert({
    user_id: userId, calculation_version: "nutrition-v3.1", trigger_reason: "adaptive_review",
    input_snapshot: {}, resting_energy: {}, tdee: {}, calorie_target: { kcal: proposedKcal }, macros: {}, safety: {},
  }).select("id").single();
  if (s.error) throw new Error(`snapshot: ${s.error.message}`);
  const p = await c.from("nutrition_adjustment_proposals").insert({
    user_id: userId, snapshot_id: s.data.id, current_target_kcal: currentKcal, proposed_target_kcal: proposedKcal,
    delta_kcal: proposedKcal - currentKcal, reason: "qa",
  }).select("id").single();
  if (p.error) throw new Error(`propuesta: ${p.error.message}`);
  return p.data.id as string;
}

export function acceptArgs(proposalId: string, o: { offset: number; date?: string; kcal: number; protein?: number; carbs?: number; fat?: number; snapshot?: unknown }) {
  return {
    p_proposal_id: proposalId, p_accepted: true, p_new_offset_kcal: o.offset, p_goal_date: o.date ?? todayUtc(),
    p_kcal_target: o.kcal, p_protein_g: o.protein ?? 160, p_carbs_g: o.carbs ?? 204, p_fat_g: o.fat ?? 54,
    p_mode: "fat_loss", p_snapshot: o.snapshot ?? SNAP(o.kcal),
  };
}

/** Estado del servidor leído con la sesión del propio usuario (no con la clave de servicio). */
export async function serverGoal(c: SupabaseClient, userId: string, date = todayUtc()) {
  const r = await c.from("nutrition_goals").select("kcal_target, basis_offset_kcal, source_snapshot_id, mode").eq("user_id", userId).eq("goal_date", date).maybeSingle();
  if (r.error) throw new Error(`objetivo: ${r.error.message}`);
  return r.data as { kcal_target: number; basis_offset_kcal: number | null; source_snapshot_id: string | null; mode: string } | null;
}
export async function serverOffset(c: SupabaseClient, userId: string): Promise<unknown> {
  const r = await c.from("user_profiles").select("extra_state").eq("user_id", userId).maybeSingle();
  if (r.error) throw new Error(`perfil: ${r.error.message}`);
  return (r.data?.extra_state as Record<string, unknown> | null)?.adaptiveKcalOffsetKcal;
}

/** Política de transición: solo con la clave de servicio, y solo en estas pruebas (restaurada al terminar). */
export async function setLegacyPolicy(policy: "allow_unsealed" | "reject"): Promise<void> {
  const { error } = await adminClient().rpc("fn_plan_set_legacy_goal_write_policy", { p_policy: policy });
  if (error) throw new Error(`política: ${error.message}`);
}
