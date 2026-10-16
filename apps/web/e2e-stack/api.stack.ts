// §3, §5 y §6 de la validación: Auth + PostgREST REALES (supabase-js con la clave pública y sesiones de usuario),
// sin SQL manual ni cabeceras simuladas. Los clientes «antiguos» son supabase-js sin el marcador (cabecera por
// defecto), exactamente lo que enviaría una pestaña anterior a este cambio.
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  acceptArgs, adminClient, assertIsolated, createQaUser, deleteQaUser, planRead, propose, seedProfileRow, serverGoal,
  serverOffset, setLegacyPolicy, signedClient, todayUtc, SNAP, type QaUser,
} from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

const evidence: Record<string, unknown> = {};
let A: QaUser; let B: QaUser;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  assertIsolated();
  A = await createQaUser("a");
  B = await createQaUser("b");
  await setLegacyPolicy("allow_unsealed");
});
test.afterAll(async () => {
  await setLegacyPolicy("allow_unsealed");
  await deleteQaUser(A); await deleteQaUser(B);
  mkdirSync("stack-evidence", { recursive: true });
  writeFileSync("stack-evidence/api.json", JSON.stringify({ note: "datos sintéticos; stack local desechable; sin secretos", evidence }, null, 2));
});

/** Estado de partida: perfil con offset 0 y un objetivo de hoy sin sello (como lo dejaría un cliente nuevo). */
async function startState(c: SupabaseClient, u: QaUser, kcal = 2039) {
  await seedProfileRow(c, u.id);
  const w = await c.from("nutrition_goals").upsert({
    user_id: u.id, goal_date: todayUtc(), kcal_target: kcal, protein_target_g: 160, carbs_target_g: 204, fat_target_g: 54,
    mode: "fat_loss", calculation_version: "nutrition-v3.1", basis_offset_kcal: 0,
  }, { onConflict: "user_id,goal_date" });
  expect(w.error).toBeNull();
}
async function accept(c: SupabaseClient, u: QaUser, from = 2039, to = 1939) {
  const id = await propose(c, u.id, from, to);
  const r = await c.rpc("fn_accept_nutrition_adjustment", acceptArgs(id, { offset: to - from, kcal: to }));
  expect(r.error, r.error?.message).toBeNull();
  return id;
}

test.describe("§3 protocolo y API reales", () => {
  test("X-Client-Info llega a PostgREST: cliente nuevo = nivel 1; sesión antigua sin marcador = nivel 0", async () => {
    const modern = await signedClient(A);
    const legacy = await signedClient(A, { legacy: true });
    const m = await planRead(modern); const l = await planRead(legacy);
    evidence.protocolo = { nuevo: m.clientProtocolLevel, antiguo: l.clientProtocolLevel, protocol: m.protocol };
    expect(m.clientProtocolLevel).toBe(1);
    expect(l.clientProtocolLevel).toBe(0);
  });

  test("errores distinguibles: función ausente (PGRST202), permiso (42501/…) y red; ninguno es un éxito silencioso", async () => {
    const c = await signedClient(A);
    const absent = await c.rpc("fn_plan_funcion_que_no_existe", {});
    expect(absent.error?.code).toBe("PGRST202");
    const denied = await c.rpc("fn_plan_set_legacy_goal_write_policy", { p_policy: "reject" });
    expect(denied.error).not.toBeNull();
    expect(denied.error?.code).not.toBe("PGRST202");
    const bad = (await import("@supabase/supabase-js")).createClient("http://127.0.0.1:9", "x", { auth: { persistSession: false } });
    const netErr = await bad.rpc("fn_plan_state_read", { p_goal_date: null });
    expect(netErr.error).not.toBeNull();
    expect(netErr.error?.code).not.toBe("PGRST202");
    evidence.errores = { ausente: absent.error?.code, permiso: denied.error?.code, red: netErr.error?.code ?? "sin código (fallo de red)" };
  });
});

test.describe("§5 permisos y entradas inválidas", () => {
  test("aislamiento: B no lee ni modifica objetivos, propuestas, snapshots ni conflictos de A", async () => {
    const a = await signedClient(A); const b = await signedClient(B);
    await startState(a, A);
    await accept(a, A);
    // conflicto de A: un cliente antiguo y obsoleto de A deja constancia (informativo)
    await (await signedClient(A, { legacy: true })).from("user_profiles").update({ extra_state: { adaptiveKcalOffsetKcal: 0 } }).eq("user_id", A.id);
    for (const t of ["nutrition_goals", "nutrition_adjustment_proposals", "nutrition_calculation_snapshots", "nutrition_sync_conflicts"]) {
      const r = await b.from(t).select("*").eq("user_id", A.id);
      expect(r.error).toBeNull();
      expect(r.data, `B ve filas de A en ${t}`).toEqual([]);
    }
    const upd = await b.from("nutrition_goals").update({ kcal_target: 9999 }).eq("user_id", A.id).select();
    expect(upd.data ?? []).toEqual([]);
    const ins = await b.from("nutrition_goals").insert({ user_id: A.id, goal_date: "2026-01-02", kcal_target: 1, protein_target_g: 1, carbs_target_g: 1, fat_target_g: 1, mode: "fat_loss", calculation_version: "x" });
    // Con el trigger de C0 un INSERT sin base declarada se OMITE antes de evaluar RLS (sin error); lo que importa es
    // que no se escriba nada en la cuenta de A. Con base declarada, la política RLS WITH CHECK lo rechaza o se omite.
    const ins2 = await b.from("nutrition_goals").insert({ user_id: A.id, goal_date: "2026-01-02", kcal_target: 1, protein_target_g: 1, carbs_target_g: 1, fat_target_g: 1, mode: "fat_loss", calculation_version: "x", basis_offset_kcal: -100 });
    const planted = await a.from("nutrition_goals").select("goal_date").eq("user_id", A.id).eq("goal_date", "2026-01-02");
    expect(planted.data ?? []).toEqual([]);
    evidence.insert_ajeno = { sinBase: ins.error?.message ?? "omitido sin error", conBase: ins2.error?.message ?? "omitido sin error", filasEnA: (planted.data ?? []).length };
    const del = await b.from("nutrition_goals").delete().eq("user_id", A.id).select();
    expect(del.data ?? []).toEqual([]);
    const read = await planRead(b);
    expect(read.goal).toBeNull(); // B no tiene objetivo: no ve el de A
    expect(await serverOffset(a, A.id)).toBe(-100);
    expect((await serverGoal(a, A.id))?.kcal_target).toBe(1939);
    evidence.aislamiento = "B: 0 filas de A en 4 tablas; update/insert/delete ajenos sin efecto";
  });

  test("el usuario no cambia la política de transición (RPC ni tabla)", async () => {
    const a = await signedClient(A);
    const rpc = await a.rpc("fn_plan_set_legacy_goal_write_policy", { p_policy: "reject" });
    expect(rpc.error).not.toBeNull();
    const upd = await a.from("plan_protection_settings").update({ value: "reject" }).eq("key", "legacy_goal_write_policy").select();
    expect((upd.data ?? []).length).toBe(0);
    const { data } = await adminClient().from("plan_protection_settings").select("value").eq("key", "legacy_goal_write_policy").single();
    expect(data?.value).toBe("allow_unsealed");
  });

  test("no puede quitar el sello ni borrar/reinsertar una fila protegida", async () => {
    const a = await signedClient(A);
    const before = await serverGoal(a, A.id);
    expect(before?.source_snapshot_id).not.toBeNull();
    await a.from("nutrition_goals").update({ basis_offset_kcal: null }).eq("user_id", A.id).eq("goal_date", todayUtc());
    await a.from("nutrition_goals").update({ source_snapshot_id: null, kcal_target: 2039 }).eq("user_id", A.id).eq("goal_date", todayUtc());
    await a.from("nutrition_goals").delete().eq("user_id", A.id).eq("goal_date", todayUtc());
    await a.from("nutrition_goals").insert({ user_id: A.id, goal_date: todayUtc(), kcal_target: 2039, protein_target_g: 160, carbs_target_g: 204, fat_target_g: 54, mode: "fat_loss", calculation_version: "nutrition-v3.1", basis_offset_kcal: 0 });
    const after = await serverGoal(a, A.id);
    expect(after).toEqual(before);
    evidence.sello = { antes: before, despues: after };
  });

  test("snapshots inválidos se rechazan y la transacción revierte por completo", async () => {
    const a = await signedClient(A);
    await seedProfileRow(a, A.id); // no pisa el offset ya protegido
    const off0 = await serverOffset(a, A.id);
    const goal0 = await serverGoal(a, A.id);
    const id = await propose(a, A.id, 1939, 1839);
    for (const bad of [{}, { ...SNAP(1839), calorie_target: {} }, { ...SNAP(1839), calorie_target: { kcal: "x" } }, { ...SNAP(1839), calorie_target: null }]) {
      const r = await a.rpc("fn_accept_nutrition_adjustment", acceptArgs(id, { offset: -200, kcal: 1839, snapshot: bad }));
      expect(r.error, `aceptó ${JSON.stringify(bad)}`).not.toBeNull();
    }
    const st = await a.from("nutrition_adjustment_proposals").select("status").eq("id", id).single();
    expect(st.data?.status).toBe("pending");
    expect(await serverOffset(a, A.id)).toBe(off0);
    expect(await serverGoal(a, A.id)).toEqual(goal0);
  });

  test("fechas inválidas de calibración no bloquean escrituras posteriores", async () => {
    const a = await signedClient(A);
    const w1 = await a.from("user_profiles").update({ extra_state: { adaptiveKcalOffsetKcal: -100, adaptiveCalibrationStartedAt: "2026-99-99" } }).eq("user_id", A.id);
    expect(w1.error).toBeNull();
    const w2 = await a.from("user_profiles").update({ weight_kg: 81 }).eq("user_id", A.id);
    expect(w2.error).toBeNull();
    const r = await a.from("user_profiles").select("weight_kg, extra_state").eq("user_id", A.id).single();
    expect(Number(r.data?.weight_kg)).toBe(81);
    expect((r.data?.extra_state as Record<string, unknown>).adaptiveKcalOffsetKcal).toBe(-100);
  });
});

test.describe("§6 clientes antiguos (solo en este stack desechable)", () => {
  test("allow_unsealed: residual conocido — un cliente antiguo escribe un día aún sin sellar; el día sellado y el offset se conservan", async () => {
    await setLegacyPolicy("allow_unsealed");
    const a = await signedClient(A); const old = await signedClient(A, { legacy: true });
    const day = "2026-01-15";
    const w = await old.from("nutrition_goals").upsert({ user_id: A.id, goal_date: day, kcal_target: 2321, protein_target_g: 1, carbs_target_g: 1, fat_target_g: 1, mode: "fat_loss", calculation_version: "nutrition-v3.1" }, { onConflict: "user_id,goal_date" }).select("kcal_target");
    evidence.residual_allow_unsealed = { escritoPorAntiguo: w.data, error: w.error?.message ?? null };
    expect(w.error).toBeNull();
    expect((await serverGoal(a, A.id, day))?.kcal_target).toBe(2321);
    expect((await serverGoal(a, A.id))?.kcal_target).toBe(1939);
    expect(await serverOffset(a, A.id)).toBe(-100);
  });

  test("reject: el antiguo que vuelve tras estar offline no revierte el ajuste, no toca el objetivo sellado y no inserta objetivos; el nuevo sigue funcionando", async () => {
    await setLegacyPolicy("reject");
    try {
      const a = await signedClient(A); const old = await signedClient(A, { legacy: true });
      const goal0 = await serverGoal(a, A.id);
      const p = await old.from("user_profiles").update({ extra_state: { adaptiveKcalOffsetKcal: 0, adaptiveCalibrationStartedAt: null } }).eq("user_id", A.id);
      expect(p.error).toBeNull(); // el antiguo no recibe error: simplemente no persiste el retroceso
      const g = await old.from("nutrition_goals").upsert({ user_id: A.id, goal_date: todayUtc(), kcal_target: 2039, protein_target_g: 160, carbs_target_g: 204, fat_target_g: 54, mode: "fat_loss", calculation_version: "nutrition-v3.1" }, { onConflict: "user_id,goal_date" }).select("kcal_target");
      const day2 = "2026-01-20";
      const n = await old.from("nutrition_goals").insert({ user_id: A.id, goal_date: day2, kcal_target: 2039, protein_target_g: 160, carbs_target_g: 204, fat_target_g: 54, mode: "fat_loss", calculation_version: "nutrition-v3.1" }).select("kcal_target");
      expect(await serverOffset(a, A.id)).toBe(-100);
      expect(await serverGoal(a, A.id)).toEqual(goal0);
      expect(await serverGoal(a, A.id, day2)).toBeNull();
      // el cliente nuevo sigue pudiendo escribir un día nuevo con la base vigente
      const day3 = "2026-01-21";
      const ok = await a.from("nutrition_goals").insert({ user_id: A.id, goal_date: day3, kcal_target: 1939, protein_target_g: 160, carbs_target_g: 204, fat_target_g: 54, mode: "fat_loss", calculation_version: "nutrition-v3.1", basis_offset_kcal: -100 }).select("kcal_target");
      expect(ok.error).toBeNull();
      expect((await serverGoal(a, A.id, day3))?.kcal_target).toBe(1939);
      evidence.reject = {
        antiguo_ve: { perfil: p.error ? "error" : "OK sin efecto", objetivo_hoy: g.error?.message ?? (g.data ?? []).length === 0 ? "sin filas devueltas (omitido)" : "devuelto", insert_nuevo: n.error?.message ?? ((n.data ?? []).length === 0 ? "sin filas devueltas (omitido)" : "devuelto") },
        offset: -100, objetivoSellado: goal0, nuevoEscribe: true,
      };
    } finally { await setLegacyPolicy("allow_unsealed"); }
  });
});

test("C: respuesta de aceptación perdida tras confirmar en servidor — el ajuste se conserva; límite conocido de C2 (el reintento da PROPOSAL_NOT_PENDING)", async () => {
  const c = await createQaUser("c");
  try {
    const s = await signedClient(c);
    await startState(s, c);
    const id = await propose(s, c.id, 2039, 1939);
    // «respuesta perdida»: el servidor confirma, el cliente descarta el resultado
    await s.rpc("fn_accept_nutrition_adjustment", acceptArgs(id, { offset: -100, kcal: 1939 }));
    const s2 = await signedClient(c); // dispositivo que no recibió la respuesta
    expect(await serverOffset(s2, c.id)).toBe(-100);
    expect((await serverGoal(s2, c.id))?.kcal_target).toBe(1939);
    const retry = await s2.rpc("fn_accept_nutrition_adjustment", acceptArgs(id, { offset: -100, kcal: 1939 }));
    expect(retry.error?.message ?? "").toMatch(/PROPOSAL_NOT_PENDING/);
    expect(await serverOffset(s2, c.id)).toBe(-100); // el reintento no duplica ni pierde el ajuste
    evidence.C_respuesta_perdida = { offset: -100, objetivo: 1939, reintento: "PROPOSAL_NOT_PENDING (límite conocido de C2)" };
  } finally { await deleteQaUser(c); }
});
