// Pruebas de CONCURRENCIA REAL de C0 sobre un PostgreSQL con varias conexiones.
//
// ESTADO: escritas y revisables, pero NO EJECUTADAS por quien las escribió (no hay Postgres local ni Docker
// en ese equipo). Se ejecutan en CI con un servicio postgres:17 aislado: .github/workflows/plan-state-concurrency.yml.
// PGlite (la otra batería) tiene UNA conexión y NO demuestra ninguna de estas carreras.
//
// Uso:  DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node concurrency/run.mjs
// Requiere una base VACÍA y desechable: crea los roles anon/authenticated/service_role y todo el esquema.
// NO usar nunca contra Supabase ni contra producción.
import assert from "node:assert/strict";
import pg from "pg";
import { NEW_CLIENT_INFO, schemaSteps } from "../schema.mjs";

const { Client } = pg;
const URL_ = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
if (/supabase\.co|supabase\.com|amazonaws/i.test(URL_)) throw new Error("DATABASE_URL apunta a un servicio gestionado: este script solo es para una base desechable de CI");

const D = "2026-10-14";
const D2 = "2026-10-15";
const results = [];
const note = (name, detail) => { results.push({ name, ...detail }); console.log(`OK  ${name}`, detail ?? ""); };

// Límites de tiempo: ninguna consulta ni espera de bloqueo puede colgar el job indefinidamente.
// Las esperas de bloqueo DESEADAS (K1–K3) duran milisegundos; 20 s sobran y 15 s de lock_timeout las acota.
const QUERY_TIMEOUT_MS = 30_000;
const GLOBAL_TIMEOUT_MS = 6 * 60_000;
const opened = new Set();
async function closeAll() {
  await Promise.allSettled([...opened].map((c) => Promise.race([c.end(), new Promise((r) => setTimeout(r, 3000))])));
  opened.clear();
}
const watchdog = setTimeout(() => {
  console.error(`FALLO: la verificación superó el límite global de ${GLOBAL_TIMEOUT_MS / 1000} s`);
  process.exit(2);
}, GLOBAL_TIMEOUT_MS);
watchdog.unref();

async function connect() {
  const c = new Client({ connectionString: URL_, connectionTimeoutMillis: 10_000, query_timeout: QUERY_TIMEOUT_MS, statement_timeout: QUERY_TIMEOUT_MS, lock_timeout: 15_000 });
  c.on("error", (e) => console.error("error de conexión", e.message));
  await c.connect();
  opened.add(c);
  c.pid = (await c.query("select pg_backend_pid() as p")).rows[0].p;
  return c;
}
async function asUser(c, userId, { legacy = false } = {}) {
  await c.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)", [userId, legacy ? "" : JSON.stringify({ "x-client-info": NEW_CLIENT_INFO })]);
  await c.query("set role authenticated");
}
const reset = (c) => c.query("reset role");

async function waitBlocked(admin, pid, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await admin.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.wait_event_type === "Lock") return;
    if (Date.now() - t0 > ms) throw new Error(`la conexión ${pid} no llegó a bloquearse (¿no hay espera de bloqueo donde se esperaba?)`);
    await new Promise((r2) => setTimeout(r2, 25));
  }
}

let admin;
let uidCounter = 0;
async function newUser(offset = 0) {
  const id = `00000000-0000-0000-0000-${String(++uidCounter).padStart(12, "0")}`;
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@example.invalid`]);
  await admin.query("insert into public.user_profiles (user_id, extra_state) values ($1, $2::jsonb)", [id, JSON.stringify({ adaptiveKcalOffsetKcal: offset })]);
  return id;
}
async function propose(u) {
  const s = (await admin.query(
    `insert into public.nutrition_calculation_snapshots (user_id, calculation_version, trigger_reason, input_snapshot, resting_energy, tdee, calorie_target, macros, safety)
     values ($1,'nutrition-v3.1','adaptive_review','{}','{}','{}','{"kcal":2039}','{}','{}') returning id`, [u])).rows[0].id;
  return (await admin.query(
    `insert into public.nutrition_adjustment_proposals (user_id, snapshot_id, current_target_kcal, proposed_target_kcal, delta_kcal, reason) values ($1,$2,2039,1939,-100,'t') returning id`,
    [u, s])).rows[0].id;
}
const SNAP = JSON.stringify({ calculation_version: "nutrition-v3.1", input_snapshot: {}, resting_energy: {}, tdee: {}, calorie_target: { kcal: 1939 }, macros: {}, safety: {} });
const acceptSql = (id, date = D, offset = -100) => ({
  text: "select public.fn_accept_nutrition_adjustment($1, true, $2, $3::date, 1939, 160, 204, 54, 'fat_loss', $4::jsonb) as r",
  values: [id, offset, date, SNAP],
});
const upsertGoalSql = (u, date, kcal, basis) => ({
  text: `insert into public.nutrition_goals (user_id, goal_date, kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode, calculation_version${basis === undefined ? "" : ", basis_offset_kcal"})
         values ($1,$2,$3,160,204,54,'fat_loss','nutrition-v3.1'${basis === undefined ? "" : ",$4"})
         on conflict (user_id, goal_date) do update set kcal_target = excluded.kcal_target${basis === undefined ? "" : ", basis_offset_kcal = excluded.basis_offset_kcal"}`,
  values: basis === undefined ? [u, date, kcal] : [u, date, kcal, basis],
});
const staleProfileSql = (u) => ({
  text: `update public.user_profiles set extra_state = extra_state || '{"adaptiveKcalOffsetKcal":0,"adaptiveCalibrationStartedAt":null}'::jsonb where user_id = $1`,
  values: [u],
});
const offsetOf = async (u) => (await admin.query("select extra_state->'adaptiveKcalOffsetKcal' as o from public.user_profiles where user_id=$1", [u])).rows[0].o;
const goalOf = async (u, d = D) => (await admin.query("select kcal_target::float as kcal, basis_offset_kcal as basis, source_snapshot_id is not null as sealed from public.nutrition_goals where user_id=$1 and goal_date=$2", [u, d])).rows[0] ?? null;

async function main() {
  admin = await connect();
  for (const step of schemaSteps({ withProtection: true })) await admin.query(step.sql);
  const [A, B, C] = [await connect(), await connect(), await connect()];

  // K1 — aceptación en curso (retiene perfil, propuesta y objetivo) frente a un push de perfil obsoleto
  {
    const u = await newUser(0); const id = await propose(u);
    await asUser(A, u); await A.query("begin"); await A.query(acceptSql(id));
    await asUser(B, u);
    const pB = B.query(staleProfileSql(u));
    await waitBlocked(admin, B.pid);
    await A.query("commit"); await reset(A);
    await pB; await reset(B);
    assert.equal(await offsetOf(u), -100);
    note("K1 aceptación abierta vs push de perfil obsoleto: el push espera y el offset aceptado se conserva", { offset: -100 });
  }

  // K2 — objetivo EXISTENTE de la misma fecha que sella la aceptación: la escritura obsoleta espera y se conserva el de la aceptación
  {
    const u = await newUser(0); const id = await propose(u);
    await admin.query(upsertGoalSql(u, D, 2039, undefined)); // fila previa sin sello (superusuario)
    await asUser(A, u); await A.query("begin"); await A.query(acceptSql(id));
    await asUser(B, u);
    const pB = B.query(upsertGoalSql(u, D, 2039, 0)); // base obsoleta (el offset aún era 0 al empezar)
    await waitBlocked(admin, B.pid);
    await A.query("commit"); await reset(A);
    await pB; await reset(B);
    const g = await goalOf(u);
    assert.equal(g.kcal, 1939); assert.equal(g.basis, -100); assert.equal(g.sealed, true);
    note("K2 objetivo existente: la escritura con base obsoleta espera a la aceptación y no la pisa", g);
  }

  // K3 — objetivo NUEVO (aún inexistente) que la escritura obsoleta inserta primero; la aceptación espera y lo sobrescribe
  {
    const u = await newUser(0); const id = await propose(u);
    await asUser(B, u); await B.query("begin"); await B.query(upsertGoalSql(u, D, 2039, 0)); // inserta la fila, sin confirmar
    await asUser(A, u);
    const pA = A.query(acceptSql(id));
    await waitBlocked(admin, A.pid);
    await B.query("commit"); await reset(B);
    const r = await pA; await reset(A);
    assert.equal(r.rows[0].r.ok, true);
    const g = await goalOf(u);
    assert.equal(g.kcal, 1939); assert.equal(g.basis, -100);
    assert.equal(await offsetOf(u), -100);
    note("K3 objetivo nuevo escrito antes: la aceptación espera, termina sin interbloqueo y su objetivo prevalece", g);
  }

  // K4 — fecha DISTINTA a la que sella la aceptación: la fila obsoleta de otra fecha puede quedar con base anterior (linealización B→A) y es detectable
  {
    const u = await newUser(0); const id = await propose(u);
    await asUser(B, u); await B.query("begin"); await B.query(upsertGoalSql(u, D2, 2039, 0)); // fecha D2, base 0 = vigente en ese instante
    await asUser(A, u); await A.query(acceptSql(id, D)); // fecha D: no comparte fila con B → no espera
    await reset(A);
    await B.query("commit"); await reset(B);
    const g2 = await goalOf(u, D2);
    assert.equal(g2.basis, 0);
    assert.equal(await offsetOf(u), -100);
    const read = (await (async () => { await asUser(A, u); const x = await A.query("select public.fn_plan_state_read($1::date) as r", [D2]); await reset(A); return x.rows[0].r; })());
    assert.equal(read.goal.basisOffsetKcal, 0); assert.equal(read.offset, -100); // el desfase queda visible para el cliente, que reescribe
    note("K4 fecha distinta: no se afirma prevención (linealización B→A); el desfase es detectable con fn_plan_state_read", { basisD2: g2.basis, offset: read.offset });
  }

  // K5 — aceptar y rechazar a la vez la MISMA propuesta: un único resultado terminal, sin interbloqueo
  for (let i = 0; i < 10; i++) {
    const u = await newUser(0); const id = await propose(u);
    await asUser(A, u); await asUser(B, u);
    const [ra, rb] = await Promise.allSettled([
      A.query(acceptSql(id)),
      B.query({ text: "select public.fn_accept_nutrition_adjustment($1, false) as r", values: [id] }),
    ]);
    await reset(A); await reset(B);
    for (const r of [ra, rb]) if (r.status === "rejected") assert.notEqual(r.reason.code, "40P01", "interbloqueo detectado");
    const status = (await admin.query("select status from public.nutrition_adjustment_proposals where id=$1", [id])).rows[0].status;
    assert.ok(status === "accepted" || status === "rejected");
    const okCount = [ra, rb].filter((r) => r.status === "fulfilled").length;
    assert.equal(okCount, 1, "exactamente una de las dos operaciones debe tener éxito");
    assert.equal(await offsetOf(u), status === "accepted" ? -100 : 0);
  }
  note("K5 aceptar vs rechazar simultáneos (10 iteraciones): un único estado terminal coherente, sin interbloqueos");

  // K6 — dos aceptaciones de propuestas distintas del mismo usuario: se serializan; la segunda falla con OFFSET_MISMATCH
  for (let i = 0; i < 10; i++) {
    const u = await newUser(0); const id1 = await propose(u); const id2 = await propose(u);
    await asUser(A, u); await asUser(B, u);
    const [r1, r2] = await Promise.allSettled([A.query(acceptSql(id1)), B.query(acceptSql(id2))]);
    await reset(A); await reset(B);
    for (const r of [r1, r2]) if (r.status === "rejected") assert.notEqual(r.reason.code, "40P01", "interbloqueo detectado");
    assert.equal([r1, r2].filter((r) => r.status === "fulfilled").length, 1);
    const rejected = [r1, r2].find((r) => r.status === "rejected");
    assert.match(rejected.reason.message, /OFFSET_MISMATCH/);
    assert.equal(await offsetOf(u), -100); // nunca -200
  }
  note("K6 dos aceptaciones concurrentes (10 iteraciones): un solo ajuste aplicado, el otro OFFSET_MISMATCH, sin interbloqueos");

  // K7 — estrés: aceptación + push de perfil obsoleto + objetivo con base obsoleta + objetivo de cliente antiguo + lecturas
  {
    const extra = [await connect(), await connect()];
    const conns = [A, B, C, ...extra];
    let deadlocks = 0;
    for (let i = 0; i < 30; i++) {
      const u = await newUser(0); const id = await propose(u);
      if (i % 2 === 0) await admin.query(upsertGoalSql(u, D, 2039, undefined)); // con y sin fila previa
      await Promise.all(conns.map((c, k) => asUser(c, u, { legacy: k === 3 })));
      const tasks = [
        conns[0].query(acceptSql(id)),
        conns[1].query(staleProfileSql(u)),
        conns[2].query(upsertGoalSql(u, D, 2039, 0)),
        conns[3].query(upsertGoalSql(u, D, 2039, undefined)),
        conns[4].query({ text: "select public.fn_plan_state_read($1::date)", values: [D] }),
      ];
      const settled = await Promise.allSettled(tasks);
      await Promise.all(conns.map(reset));
      for (const s of settled) if (s.status === "rejected" && (s.reason.code === "40P01" || s.reason.code === "40001")) deadlocks++;
      assert.equal(settled[0].status, "fulfilled", `la aceptación falló: ${settled[0].reason?.message}`);
      assert.equal(await offsetOf(u), -100);
      const g = await goalOf(u);
      assert.equal(g.basis, -100, `iteración ${i}: el objetivo final no es el de la aceptación`);
      assert.equal(g.kcal, 1939);
    }
    assert.equal(deadlocks, 0);
    note("K7 estrés (30 iteraciones × 5 conexiones): sin interbloqueos y siempre prevalece el offset y el objetivo de la aceptación", { deadlocks });
  }

  console.log(JSON.stringify({ ok: true, postgres: "ver select version() del servicio", scenarios: results.length }, null, 2));
}

main()
  .then(async () => { await closeAll(); clearTimeout(watchdog); })
  .catch(async (e) => { console.error("FALLO", e); await closeAll(); process.exit(1); });
