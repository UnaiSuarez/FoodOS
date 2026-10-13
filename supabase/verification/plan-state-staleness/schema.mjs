// Construye un Postgres aislado (PGlite, en memoria, sin datos de nadie) con el esquema REAL del
// repositorio: aplica, en orden, las migraciones de supabase/migrations/ sobre stubs mínimos de lo que
// Supabase aporta (esquema auth, roles anon/authenticated/service_role, auth.uid(), publicación realtime).
//
// `withProtection:false` omite la migración C0 (estado «vigente en producción»); `true` la aplica tal cual,
// el fichero real, no una copia. Los privilegios de `authenticated` se aplican ANTES de la migración C0
// (como en producción), de modo que sus propios GRANT/REVOKE son los que cuentan.
//
// Límites declarados: es PGlite (PostgreSQL 18.x, UNA sola conexión), no el Postgres 17 de Supabase;
// RLS y GRANT SÍ se aplican (se cambia de rol con SET ROLE), pero PostgREST no se ejecuta (postgrest.mjs).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
export const C0_MIGRATION = "20261014120000_plan_state_protection.sql";

// Migraciones que dependen de Storage (buckets/políticas de objetos) o de trabajo temporal de depuración:
// no tienen relación con perfil, objetivos ni propuestas.
const SKIP = new Set([
  "20260707103518_product_images_bucket.sql",
  "20260713132657_temp_debug_auth_uid.sql",
  "20260713134758_product_images_select_policy.sql",
  "20260714074136_drop_temp_debug_auth_uid.sql",
]);

export const BOOTSTRAP_SQL = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  create publication supabase_realtime;
`;

// Privilegios de tabla de `authenticated` en producción (consulta de solo lectura a
// information_schema.role_table_grants, 14/10/2026): CRUD en user_profiles y nutrition_goals; solo
// SELECT/INSERT en las dos tablas de propuestas/snapshots (migración 20260828190000). El resto: CRUD.
export const PRODUCTION_GRANTS_SQL = `
  grant select, insert, update, delete on all tables in schema public to authenticated;
  revoke all on public.nutrition_adjustment_proposals, public.nutrition_calculation_snapshots from authenticated;
  grant select, insert on public.nutrition_adjustment_proposals, public.nutrition_calculation_snapshots to authenticated;
`;

/** Lista ordenada de pasos SQL (cada uno: {name, sql}) — la comparten PGlite y el Postgres real de CI. */
export function schemaSteps({ withProtection = true } = {}) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const steps = [{ name: "bootstrap", sql: BOOTSTRAP_SQL }];
  let grantsApplied = false;
  for (const file of files) {
    if (SKIP.has(file)) continue;
    if (file === C0_MIGRATION) {
      steps.push({ name: "production-grants", sql: PRODUCTION_GRANTS_SQL });
      grantsApplied = true;
      if (!withProtection) continue;
    } else if (file > C0_MIGRATION && !grantsApplied) {
      steps.push({ name: "production-grants", sql: PRODUCTION_GRANTS_SQL });
      grantsApplied = true;
    }
    // gen_random_uuid() es nativa desde PG13: solo se omite la línea de la extensión pgcrypto.
    const sql = readFileSync(MIGRATIONS_DIR + file, "utf8").replace(/create extension if not exists pgcrypto;/gi, "");
    steps.push({ name: file, sql });
  }
  if (!grantsApplied) steps.push({ name: "production-grants", sql: PRODUCTION_GRANTS_SQL });
  return steps;
}

export async function buildDb({ withProtection = true, extraSql = [] } = {}) {
  const db = new PGlite();
  const applied = [];
  for (const step of schemaSteps({ withProtection })) {
    try {
      await db.exec(step.sql);
      applied.push(step.name);
    } catch (e) {
      throw new Error(`paso ${step.name} falló en el Postgres aislado: ${e.message}`);
    }
  }
  for (const sql of extraSql) await db.exec(sql);
  return { db, applied };
}

export const USER_A = "00000000-0000-0000-0000-00000000000a";
export const USER_B = "00000000-0000-0000-0000-00000000000b";

/** Crea un usuario con su fila de perfil base (como ensureBaseRows) — sin datos reales. */
export async function seedUser(db, userId) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [userId, `${userId}@example.invalid`]);
  await db.query(`insert into public.user_profiles (user_id) values ($1) on conflict do nothing`, [userId]);
}

export const NEW_CLIENT_INFO = "foodos-web plan-protocol/1";

/**
 * Ejecuta `fn` como el rol `authenticated` con auth.uid() = userId (lo que haría PostgREST con un JWT).
 * `clientInfo` simula la cabecera X-Client-Info que PostgREST expone en request.headers (null = cliente
 * antiguo o conexión directa).
 */
export async function asUser(db, userId, fn, { clientInfo = null } = {}) {
  const headers = clientInfo ? JSON.stringify({ "x-client-info": clientInfo }) : "";
  await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [userId, headers]);
  await db.exec(`set role authenticated`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role`);
    await db.exec(`select set_config('request.jwt.claim.sub', '', false), set_config('request.headers', '', false)`);
  }
}
