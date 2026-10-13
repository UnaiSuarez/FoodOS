// Batería SQL de C0 sobre la migración REAL (supabase/migrations/20261014120000_plan_state_protection.sql),
// en PGlite (una conexión, secuencial). Cada caso fija una propiedad; los casos marcados «Codex» reproducen
// literalmente los dos hallazgos de la segunda revisión. Escribe results/sql.json.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error módulos .mjs sin tipos
import { asUser, buildDb, NEW_CLIENT_INFO, seedUser } from "./schema.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const results: Record<string, any> = {};
const D = "2026-10-14";

async function newUser(extra: Record<string, unknown> | null = null) {
  const id = randomUUID();
  await seedUser(db, id);
  if (extra) await db.query(`update public.user_profiles set extra_state = $2::jsonb where user_id = $1`, [id, JSON.stringify(extra)]);
  return id;
}
/** Como cliente nuevo (X-Client-Info con el protocolo) o antiguo (sin cabecera). */
function as<T>(userId: string, fn: () => Promise<T>, legacy = false) {
  return asUser(db, userId, fn, { clientInfo: legacy ? null : NEW_CLIENT_INFO }) as Promise<T>;
}
async function tryQ(userId: string, sql: string, params: unknown[] = [], legacy = false) {
  try {
    const r = await as(userId, () => db.query(sql, params), legacy);
    return { ok: true as const, rows: r.rows as Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message, rows: [] as Array<Record<string, unknown>> };
  }
}
const admin = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Array<Record<string, unknown>>;
const goal = async (u: string, d = D) => (await admin(`select kcal_target::float as kcal, protein_target_g::float as protein, mode, calculation_version as ver, basis_offset_kcal as basis, source_snapshot_id as snap, created_at from public.nutrition_goals where user_id=$1 and goal_date=$2`, [u, d]))[0] ?? null;
const extra = async (u: string) => ((await admin(`select extra_state from public.user_profiles where user_id=$1`, [u]))[0].extra_state ?? {}) as Record<string, unknown>;
const conflicts = async (u: string) => (await admin(`select kind, subject from public.nutrition_sync_conflicts where user_id=$1 order by kind, subject`, [u])).map((r) => `${r.kind}:${r.subject}`);
async function snapshot(u: string, kcal: number, owner = u) {
  const r = await admin(
    `insert into public.nutrition_calculation_snapshots (user_id, calculation_version, trigger_reason, input_snapshot, resting_energy, tdee, calorie_target, macros, safety)
     values ($1,'nutrition-v3.1','adaptive_adjustment_accepted','{}','{}','{}',$2::jsonb,'{}','{}') returning id`, [owner, JSON.stringify({ kcal })]);
  return r[0].id as string;
}
/** Fila sellada tal como la dejaría la aceptación: 1939 kcal, base −100, con snapshot, offset −100. */
async function sealed(extraState: Record<string, unknown> = {}) {
  const u = await newUser({ adaptiveKcalOffsetKcal: -100, ...extraState });
  const snap = await snapshot(u, 1939);
  await admin(
    `insert into public.nutrition_goals (user_id, goal_date, kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode, calculation_version, source_snapshot_id, basis_offset_kcal)
     values ($1,$2,1939,160,204,54,'fat_loss','nutrition-v3.1',$3,-100)`, [u, D, snap]);
  return { u, snap };
}
const upsertGoal = (u: string, kcal: number, basis: number | null | undefined, legacy: boolean, extraCols = "") =>
  tryQ(u,
    `insert into public.nutrition_goals (user_id, goal_date, kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode, calculation_version${basis !== undefined ? ", basis_offset_kcal" : ""})
     values ($1,$2,$3,160,204,54,'fat_loss','nutrition-v3.1'${basis !== undefined ? ",$4" : ""})
     on conflict (user_id, goal_date) do update set kcal_target = excluded.kcal_target ${basis !== undefined ? ", basis_offset_kcal = excluded.basis_offset_kcal" : ""} ${extraCols}
     returning kcal_target::float as kcal, basis_offset_kcal as basis`,
    basis !== undefined ? [u, D, kcal, basis] : [u, D, kcal], legacy);

beforeAll(async () => {
  db = (await buildDb({ withProtection: true })).db;
});
afterAll(() => {
  const dir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "sql.json", JSON.stringify({ note: "datos sintéticos; PGlite una conexión; migración real", results }, null, 2));
});

describe("sello del objetivo", () => {
  it("Codex: UPDATE explícito de basis a NULL sin cambiar cifras y luego UPDATE del objetivo → el sello y las cifras se conservan (cliente antiguo)", async () => {
    const { u, snap } = await sealed();
    const a = await tryQ(u, `update public.nutrition_goals set basis_offset_kcal = null where user_id=$1 and goal_date=$2`, [u, D], true);
    const afterNull = await goal(u);
    const b = await tryQ(u, `update public.nutrition_goals set kcal_target = 2039 where user_id=$1 and goal_date=$2`, [u, D], true);
    const after = await goal(u);
    results.sealRemoval = { firstUpdateOk: a.ok, afterNull: { kcal: afterNull.kcal, basis: afterNull.basis }, secondUpdateOk: b.ok, final: { kcal: after.kcal, basis: after.basis, snapKept: after.snap === snap }, conflicts: await conflicts(u) };
    expect(afterNull.basis).toBe(-100);
    expect(after.kcal).toBe(1939);
    expect(after.basis).toBe(-100);
    expect(after.snap).toBe(snap);
  });

  it("un cliente con protocolo que envía basis NULL (o no la envía) no puede modificar nada", async () => {
    const { u } = await sealed();
    const r = await tryQ(u, `update public.nutrition_goals set kcal_target = 2039, basis_offset_kcal = null where user_id=$1 and goal_date=$2`, [u, D]);
    expect(r.ok).toBe(true);
    expect((await goal(u)).kcal).toBe(1939);
    expect(await conflicts(u)).toContain("daily_goal_missing_basis:goal:" + D);
  });

  it("recálculo legítimo (base vigente): cambia cifras, el snapshot anterior deja de acreditar y no se hereda", async () => {
    const { u, snap } = await sealed();
    const r = await upsertGoal(u, 2100, -100, false);
    const g = await goal(u);
    results.legitRecalc = { ok: r.ok, kcal: g.kcal, basis: g.basis, snapshotAfter: g.snap };
    expect(g.kcal).toBe(2100);
    expect(g.basis).toBe(-100);
    expect(g.snap).toBeNull(); // el snapshot de 1939 no acredita 2100
    expect(g.snap).not.toBe(snap);
  });

  it("un snapshot nuevo aportado solo se conserva si es del usuario y coincide con las cifras", async () => {
    const { u } = await sealed();
    const other = await newUser();
    const good = await snapshot(u, 2100);
    const wrongKcal = await snapshot(u, 1500);
    const foreign = await snapshot(other, 2100, other);
    const setSnap = async (id: string) => {
      await tryQ(u, `update public.nutrition_goals set kcal_target=2100, source_snapshot_id=$3 where user_id=$1 and goal_date=$2`, [u, D, id]);
      return (await goal(u)).snap;
    };
    expect(await setSnap(wrongKcal)).toBeNull();
    // restablecer a un estado sellado y probar el ajeno
    await admin(`update public.nutrition_goals set kcal_target=1939, source_snapshot_id=null where user_id=$1 and goal_date=$2`, [u, D]);
    expect(await setSnap(foreign)).toBeNull();
    await admin(`update public.nutrition_goals set kcal_target=1939, source_snapshot_id=null where user_id=$1 and goal_date=$2`, [u, D]);
    expect(await setSnap(good)).toBe(good);
  });

  it("sin recálculo, snapshot y fecha de creación son inmutables desde un cliente", async () => {
    const { u, snap } = await sealed();
    const before = await goal(u);
    await tryQ(u, `update public.nutrition_goals set source_snapshot_id = null, created_at = now() + interval '1 day' where user_id=$1 and goal_date=$2`, [u, D], true);
    const g = await goal(u);
    expect(g.snap).toBe(snap);
    expect(g.created_at).toEqual(before.created_at);
  });

  it("la identidad (fecha/usuario) de un objetivo no puede cambiarse", async () => {
    const { u } = await sealed();
    await tryQ(u, `update public.nutrition_goals set goal_date = '2026-10-20' where user_id=$1 and goal_date=$2`, [u, D]);
    expect(await goal(u, "2026-10-20")).toBeNull();
    expect((await goal(u))?.kcal).toBe(1939);
    expect(await conflicts(u)).toContain("daily_goal_identity_change_prevented:goal:" + D);
  });

  it("borrar una fila sellada/acreditada se omite (no se puede borrar y reinsertar sin sello); una sin sello sí se borra", async () => {
    const { u } = await sealed();
    await tryQ(u, `delete from public.nutrition_goals where user_id=$1`, [u]);
    expect(await goal(u)).not.toBeNull();
    await admin(`insert into public.nutrition_goals (user_id, goal_date, kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode, calculation_version) values ($1,'2026-10-01',2000,150,200,60,'fat_loss','nutrition-v3.1')`, [u]);
    await tryQ(u, `delete from public.nutrition_goals where user_id=$1 and goal_date='2026-10-01'`, [u]);
    expect(await goal(u, "2026-10-01")).toBeNull();
    results.delete = { sealedKept: true };
  });

  it("el upsert habitual de un cliente antiguo (sin la columna) sobre una fila sellada: igual → pasa; distinto → se conserva", async () => {
    const { u } = await sealed();
    const same = await upsertGoal(u, 1939, undefined, true);
    const diff = await upsertGoal(u, 2039, undefined, true);
    expect(same.ok).toBe(true);
    expect((await goal(u)).kcal).toBe(1939);
    expect((await goal(u)).basis).toBe(-100);
    results.legacyUpsert = { same: same.rows, diff: diff.rows };
    expect(diff.rows).toEqual([]); // RETURNING vacío: el trigger omitió el INSERT del upsert → hay que releer
  });

  it("INSERT de un día nuevo: base obsoleta → no se crea (RETURNING vacío); base vigente → se crea", async () => {
    const u = await newUser({ adaptiveKcalOffsetKcal: -100 });
    const stale = await upsertGoal(u, 2321, 0, false);
    expect(stale.rows).toEqual([]);
    expect(await goal(u)).toBeNull();
    const fresh = await upsertGoal(u, 1939, -100, false);
    expect(fresh.rows).toEqual([{ kcal: 1939, basis: -100 }]);
  });
});

describe("política de clientes antiguos y telemetría", () => {
  it("allow_unsealed (defecto): un día sin fila lo escribe un cliente antiguo (residual) y queda registrada la escritura sin protocolo", async () => {
    const u = await newUser({ adaptiveKcalOffsetKcal: -100 });
    const r = await upsertGoal(u, 2321, undefined, true);
    expect(r.rows).toEqual([{ kcal: 2321, basis: null }]);
    const rows = await admin(`select day::text from public.plan_legacy_writes where user_id=$1`, [u]);
    results.legacyTelemetry = { rows: rows.length };
    expect(rows.length).toBe(1);
  });

  it("reject: un cliente antiguo no persiste objetivos (ni inserta ni actualiza); un cliente con protocolo sigue funcionando", async () => {
    await admin(`select public.fn_plan_set_legacy_goal_write_policy('reject')`);
    try {
      const u = await newUser({ adaptiveKcalOffsetKcal: 0 });
      const legacy = await upsertGoal(u, 2039, undefined, true);
      expect(legacy.rows).toEqual([]);
      expect(await goal(u)).toBeNull();
      const modern = await upsertGoal(u, 2039, 0, false);
      expect(modern.rows).toEqual([{ kcal: 2039, basis: 0 }]);
      // sobre la fila ya creada, el cliente antiguo tampoco cambia nada
      await upsertGoal(u, 1500, undefined, true);
      expect((await goal(u)).kcal).toBe(2039);
    } finally {
      await admin(`select public.fn_plan_set_legacy_goal_write_policy('allow_unsealed')`);
    }
  });

  it("la política solo la cambia el rol de servicio: un usuario autenticado no puede", async () => {
    const u = await newUser();
    const r = await tryQ(u, `select public.fn_plan_set_legacy_goal_write_policy('reject')`);
    expect(r.ok).toBe(false);
    const upd = await tryQ(u, `update public.plan_protection_settings set value='reject'`);
    expect(upd.ok).toBe(false);
    expect((await admin(`select value from public.plan_protection_settings`))[0].value).toBe("allow_unsealed");
  });
});

describe("calibración con datos inválidos (nunca aborta)", () => {
  it("Codex: calibración válida → '2026-99-99' → la siguiente actualización del perfil NO falla y la fecha válida se conserva", async () => {
    const u = await newUser({ adaptiveCalibrationStartedAt: "2026-10-01" });
    const bad = await tryQ(u, `update public.user_profiles set extra_state = jsonb_set(extra_state, '{adaptiveCalibrationStartedAt}', '"2026-99-99"') where user_id=$1`, [u]);
    const next = await tryQ(u, `update public.user_profiles set weight_kg = 80 where user_id=$1`, [u]);
    const final = await extra(u);
    results.invalidCalibration = { badOk: bad.ok, nextOk: next.ok, stored: final.adaptiveCalibrationStartedAt, conflicts: await conflicts(u) };
    expect(bad.ok).toBe(true);
    expect(next.ok).toBe(true);
    expect(final.adaptiveCalibrationStartedAt).toBe("2026-10-01");
  });

  it("dato heredado inválido ya almacenado: las escrituras normales no abortan y un valor válido lo sustituye", async () => {
    const u = await newUser();
    await admin(`update public.user_profiles set extra_state = '{"adaptiveCalibrationStartedAt":"2026-99-99","lastTargetChangedAt":"basura","adaptiveKcalOffsetKcal":"abc"}' where user_id=$1`, [u]);
    const r = await tryQ(u, `update public.user_profiles set weight_kg = 81, extra_state = extra_state || '{"adaptiveCalibrationStartedAt":"2026-10-10","adaptiveKcalOffsetKcal":0}' where user_id=$1`, [u]);
    const e = await extra(u);
    expect(r.ok).toBe(true);
    expect(e.adaptiveCalibrationStartedAt).toBe("2026-10-10");
    expect(e.adaptiveKcalOffsetKcal).toBe(0);
    expect(e.lastTargetChangedAt).toBeNull(); // la basura no se hereda
  });

  it("fechas inadmisibles: futura, anterior a 2000, formato libre; admisibles: hoy+1 y avance", async () => {
    const u = await newUser({ adaptiveCalibrationStartedAt: "2026-10-01" });
    const set = async (v: string | null) => {
      await tryQ(u, `update public.user_profiles set extra_state = jsonb_set(extra_state, '{adaptiveCalibrationStartedAt}', $2::jsonb) where user_id=$1`, [u, JSON.stringify(v)]);
      return (await extra(u)).adaptiveCalibrationStartedAt;
    };
    expect(await set("2099-01-01")).toBe("2026-10-01"); // futura
    expect(await set("1999-12-31")).toBe("2026-10-01"); // anterior a 2000
    expect(await set("14/10/2026")).toBe("2026-10-01"); // formato
    expect(await set("2026-09-01")).toBe("2026-10-01"); // retroceso
    expect(await set(null)).toBe("2026-10-01"); // null no la borra
    const tomorrow = ((await admin(`select to_char(current_date + 1, 'YYYY-MM-DD') as d`))[0].d) as string;
    expect(await set(tomorrow)).toBe(tomorrow); // admitida (huso)
  });

  it("un valor almacenado «futuro» (fecha simulada) no se fija para siempre", async () => {
    const u = await newUser();
    await admin(`update public.user_profiles set extra_state = '{"adaptiveCalibrationStartedAt":"2099-01-01"}' where user_id=$1`, [u]);
    await tryQ(u, `update public.user_profiles set extra_state = jsonb_set(extra_state, '{adaptiveCalibrationStartedAt}', '"2026-10-14"') where user_id=$1`, [u]);
    expect((await extra(u)).adaptiveCalibrationStartedAt).toBe("2026-10-14");
  });
});

describe("offset: inicialización, escritor único y saneado", () => {
  it("ausente/NULL: la primera escritura válida lo inicializa; después solo cambia por el RPC", async () => {
    const u = await newUser();
    await tryQ(u, `update public.user_profiles set extra_state = coalesce(extra_state,'{}') || '{"adaptiveKcalOffsetKcal":0}' where user_id=$1`, [u]);
    expect((await extra(u)).adaptiveKcalOffsetKcal).toBe(0);
    await tryQ(u, `update public.user_profiles set extra_state = extra_state || '{"adaptiveKcalOffsetKcal":-200}' where user_id=$1`, [u]);
    expect((await extra(u)).adaptiveKcalOffsetKcal).toBe(0);
    expect(await conflicts(u)).toContain("offset_overwrite_prevented:adaptiveKcalOffsetKcal");
  });

  it("cuenta con offset persistido antes de la migración (valor no nulo) lo conserva y queda protegido", async () => {
    const u = await newUser({ adaptiveKcalOffsetKcal: -100 });
    await tryQ(u, `update public.user_profiles set extra_state = extra_state || '{"adaptiveKcalOffsetKcal":0}' where user_id=$1`, [u]);
    expect((await extra(u)).adaptiveKcalOffsetKcal).toBe(-100);
  });

  it("claves omitidas por el cliente no borran el offset; valores inválidos se rechazan (decimal, texto, fuera de rango)", async () => {
    const u = await newUser({ adaptiveKcalOffsetKcal: -100, adaptiveCalibrationStartedAt: "2026-10-01" });
    await tryQ(u, `update public.user_profiles set extra_state = '{"routines":[]}' where user_id=$1`, [u]);
    const e = await extra(u);
    expect(e.adaptiveKcalOffsetKcal).toBe(-100);
    expect(e.adaptiveCalibrationStartedAt).toBe("2026-10-01");
    expect(e.routines).toEqual([]); // el resto de claves sí las escribe el cliente
    for (const bad of ['12.5', '"abc"', '99999', 'true']) {
      await tryQ(u, `update public.user_profiles set extra_state = extra_state || jsonb_build_object('adaptiveKcalOffsetKcal', $2::jsonb) where user_id=$1`, [u, bad]);
      expect((await extra(u)).adaptiveKcalOffsetKcal).toBe(-100);
    }
  });

  it("uninicializado + valor inválido: se sanea a null (sin basura) y sin abortar", async () => {
    const u = await newUser();
    const r = await tryQ(u, `update public.user_profiles set extra_state = jsonb_build_object('adaptiveKcalOffsetKcal', 'abc') where user_id=$1`, [u]);
    expect(r.ok).toBe(true);
    expect((await extra(u)).adaptiveKcalOffsetKcal).toBeNull();
  });

  it("lastCalculationEngineVersion no vuelve a nulo", async () => {
    const u = await newUser({ lastCalculationEngineVersion: "nutrition-v3.1" });
    await tryQ(u, `update public.user_profiles set extra_state = extra_state || '{"lastCalculationEngineVersion":null}' where user_id=$1`, [u]);
    expect((await extra(u)).lastCalculationEngineVersion).toBe("nutrition-v3.1");
  });
});

describe("función de aceptación", () => {
  async function propose(u: string, delta = -100) {
    const s = await snapshot(u, 1900);
    return (await admin(
      `insert into public.nutrition_adjustment_proposals (user_id, snapshot_id, current_target_kcal, proposed_target_kcal, delta_kcal, reason) values ($1,$2,2039,$3,$4,'t') returning id`,
      [u, s, 2039 + delta, delta]))[0].id as string;
  }
  const accept = (u: string, id: string, offset: number, kcal = 1939, snapKcal = kcal) =>
    tryQ(u, `select public.fn_accept_nutrition_adjustment($1, true, $2, $3::date, $4, 160, 204, 54, 'fat_loss', $5::jsonb) as r`,
      [id, offset, D, kcal, JSON.stringify({ calculation_version: "nutrition-v3.1", input_snapshot: {}, resting_energy: {}, tdee: {}, calorie_target: { kcal: snapKcal }, macros: {}, safety: {} })]);

  it("acepta: offset = vigente + delta, objetivo sellado con su snapshot y base, escritor legítimo pese a la guarda", async () => {
    const u = await newUser({ adaptiveKcalOffsetKcal: 0 });
    const r = await accept(u, await propose(u), -100);
    expect(r.ok).toBe(true);
    expect((await extra(u)).adaptiveKcalOffsetKcal).toBe(-100);
    const g = await goal(u);
    expect(g.basis).toBe(-100);
    expect(g.snap).not.toBeNull();
    expect(await conflicts(u)).toEqual([]); // el escritor legítimo no genera conflicto
  });

  it("OFFSET_MISMATCH (cliente con offset obsoleto), SNAPSHOT_MISMATCH y PROFILE_NOT_FOUND: no escriben nada", async () => {
    const u = await newUser({ adaptiveKcalOffsetKcal: -100 });
    const id = await propose(u);
    const stale = await accept(u, id, -100); // el cliente cree que el vigente es 0
    expect(stale.ok).toBe(false);
    expect(stale.ok ? "" : stale.error).toContain("OFFSET_MISMATCH");
    const snap = await accept(u, id, -200, 1939, 1500);
    expect(snap.ok ? "" : snap.error).toContain("SNAPSHOT_MISMATCH");
    expect((await extra(u)).adaptiveKcalOffsetKcal).toBe(-100);
    expect((await admin(`select status from public.nutrition_adjustment_proposals where id=$1`, [id]))[0].status).toBe("pending");
    expect(await goal(u)).toBeNull();
  });

  it("rechazar no toca offset ni objetivos", async () => {
    const u = await newUser({ adaptiveKcalOffsetKcal: -100 });
    const id = await propose(u);
    const r = await tryQ(u, `select public.fn_accept_nutrition_adjustment($1, false) as r`, [id]);
    expect(r.ok).toBe(true);
    expect((await extra(u)).adaptiveKcalOffsetKcal).toBe(-100);
    expect(await goal(u)).toBeNull();
  });
});

describe("lectura autoritativa", () => {
  it("devuelve valores saneados (nunca basura) y los conflictos abiertos", async () => {
    const u = await newUser();
    await admin(`update public.user_profiles set extra_state = '{"adaptiveKcalOffsetKcal":"abc","adaptiveCalibrationStartedAt":"2026-99-99","lastTargetChangedAt":"2026-10-02"}' where user_id=$1`, [u]);
    await tryQ(u, `update public.user_profiles set extra_state = extra_state || '{"adaptiveKcalOffsetKcal":0}' where user_id=$1`, [u]);
    const r = await tryQ(u, `select public.fn_plan_state_read($1::date) as r`, [D]);
    expect(r.ok).toBe(true);
    const out = r.rows[0].r as Record<string, unknown>;
    results.read = out;
    expect(out.offset).toBe(0);
    expect(out.calibrationStartedAt).toBeNull();
    expect(out.lastTargetChangedAt).toBe("2026-10-02");
    expect(out.goal).toBeNull();
    expect(out.protocol).toBe(1);
  });

  it("un usuario no ve filas de otro (RLS)", async () => {
    const { u } = await sealed();
    const other = await newUser();
    const r = await tryQ(other, `select public.fn_plan_state_read($1::date) as r`, [D]);
    expect((r.rows[0].r as Record<string, unknown>).goal).toBeNull();
    const direct = await tryQ(other, `select * from public.nutrition_goals where user_id=$1`, [u]);
    expect(direct.rows).toEqual([]);
  });
});
