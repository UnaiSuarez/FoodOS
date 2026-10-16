// Recorrido REAL de navegador: Chromium → app (supabase-js con la clave pública) → Auth/PostgREST → Postgres.
// El «dispositivo B» es la aplicación en el navegador con una sesión real; el «dispositivo A» es otra sesión de
// la MISMA cuenta (cliente supabase-js en Node) que acepta el ajuste. Fallos de red/respuesta se inyectan en el
// NAVEGADOR con page.route (red real del navegador), no con dobles del cliente.
//
// Límites declarados: el cambio de cuenta A→B dentro de una misma pestaña no se maneja desde la interfaz (la
// pantalla de acceso recarga la página); se cubre el logout con la lectura en vuelo y A→B en las pruebas del
// proveedor (plan-state-provider.test.tsx).
import { test, expect, type Page, type Request, type Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  acceptArgs, assertIsolated, createQaUser, deleteQaUser, propose, serverGoal, serverOffset, signedClient, todayUtc, type QaUser,
} from "./helpers";
import { PLAN_PROTOCOL_CLIENT_INFO } from "../src/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const evidence: Record<string, unknown> = {};
test.describe.configure({ mode: "serial" });
test.beforeAll(() => assertIsolated());
test.afterAll(() => {
  mkdirSync("stack-evidence", { recursive: true });
  writeFileSync("stack-evidence/browser.json", JSON.stringify({ note: "datos sintéticos; stack local desechable; sin secretos", evidence }, null, 2));
});

const READBACK = "**/rest/v1/rpc/fn_plan_state_read";
const isGoalReadback = (req: Request): boolean => {
  try { return (req.postDataJSON() as { p_goal_date?: string | null } | null)?.p_goal_date != null; } catch { return false; }
};
const badge = (page: Page) => page.locator(".sync-status-badge");

async function uiLogin(page: Page, u: QaUser) {
  await page.addInitScript(() => {
    window.localStorage.setItem("foodos-ob-done", "1");
    window.localStorage.setItem("foodos-tour-done", "1");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Iniciar sesión" }).first().click();
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Contraseña").fill(u.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/dashboard/);
}
/** Estado local de la sesión: con cuenta vive en el envelope por usuario (`foodos-user-state-v2-<id>`), sin cuenta en la clave local. */
const localState = (page: Page) => page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) ?? "";
    if (k.startsWith("foodos-user-state-v2-")) {
      try { return ((JSON.parse(localStorage.getItem(k) ?? "{}") as { state?: Record<string, any> }).state ?? {}) as Record<string, any>; } catch { /* envelope ilegible */ }
    }
  }
  return JSON.parse(localStorage.getItem("foodos-appweb-state-v1") ?? "{}") as Record<string, any>;
});
const setting = (s: Record<string, any>) => s.settings?.expiryWarnDays as number | undefined;
/** Edición legítima y mínima del usuario que dispara una sincronización completa (mutate → pushState). */
let bumpN = 0;
async function bump(page: Page): Promise<number> {
  const v = [4, 5, 6, 7, 2, 1][bumpN++ % 6];
  await page.locator('input[type="range"]').first().fill(String(v));
  return v;
}

/** Cuenta QA + perfil sintético + sesión en el navegador + espera a que el servidor tenga el objetivo de hoy. */
async function bootDevice(page: Page, label: string) {
  const failedRest: string[] = [];
  page.on("response", (res) => { if (res.url().includes("/rest/v1/") && res.status() >= 400) failedRest.push(`${res.request().method()} ${res.url().split("/rest/v1/")[1]?.split("?")[0]} ${res.status()}`); });
  const user = await createQaUser(label);
  // Estado de partida sintético sembrado con la sesión DEL USUARIO (clave pública): perfil físico completo y un
  // pesaje del diario. Así la app arranca con perfil (sin pasar por el onboarding) y hay datos legítimos con los
  // que detectar efectos secundarios.
  const seed = await signedClient(user);
  const p = await seed.from("user_profiles").upsert({
    user_id: user.id, age: 32, sex: "male", height_cm: 178, weight_kg: 80, activity_level: "moderate", goal: "fat_loss",
    gym_days: [1, 3, 5], onboarding_completed: true, extra_state: { adaptiveKcalOffsetKcal: 0 },
  }, { onConflict: "user_id" });
  if (p.error) throw new Error(`perfil sintético: ${p.error.message}`);
  const wl = await seed.from("weight_log").upsert({ user_id: user.id, log_date: "2026-10-01", kg: 80.0 }, { onConflict: "user_id,log_date" });
  if (wl.error) throw new Error(`pesaje sintético: ${wl.error.message}`);
  await uiLogin(page, user);
  await gotoSettings(page);
  await expect(badge(page)).toHaveText("Guardado", { timeout: 60_000 }); // hidratación terminada
  await bump(page); // edición mínima: dispara la sincronización completa, que registra y envía el objetivo de hoy
  const a = await signedClient(user); // sesión independiente de la misma cuenta = dispositivo A
  try {
    await expect.poll(async () => (await serverGoal(a, user.id)) !== null, { timeout: 60_000, message: "el servidor no recibió el objetivo de hoy" }).toBe(true);
  } catch (e) {
    // Diagnóstico (sin secretos): qué hay en el servidor y en el cliente cuando el objetivo no llega.
    const prof = await a.from("user_profiles").select("weight_kg, goal, extra_state").eq("user_id", user.id).maybeSingle();
    const goals = await a.from("nutrition_goals").select("goal_date, kcal_target, basis_offset_kcal").eq("user_id", user.id);
    const conf = await a.from("nutrition_sync_conflicts").select("kind, subject").eq("user_id", user.id);
    const ls = await localState(page);
    throw new Error(`${(e as Error).message}\nDIAGNÓSTICO ${JSON.stringify({
      perfilServidor: prof.data ?? prof.error?.message, objetivosServidor: goals.data ?? goals.error?.message, conflictos: conf.data,
      insignia: await badge(page).textContent(), perfilLocal: !!ls.profile, offsetLocal: ls.profile?.adaptiveKcalOffsetKcal,
      libroLocal: Object.keys(ls.nutritionGoalsHistory ?? {}), nutricionLocal: ls.nutrition, respuestasNoOk: failedRest.slice(0, 12),
    })}`);
  }
  await expect(badge(page)).toHaveText("Guardado", { timeout: 60_000 });
  const goal = (await serverGoal(a, user.id))!;
  return { user, a, goal, weightRows: async () => ((await a.from("weight_log").select("log_date, kg").eq("user_id", user.id)).data ?? []) };
}
async function serverSetting(c: SupabaseClient, userId: string): Promise<unknown> {
  const r = await c.from("user_profiles").select("extra_state").eq("user_id", userId).maybeSingle();
  return ((r.data?.extra_state as Record<string, any> | null)?.settings as Record<string, unknown> | undefined)?.expiryWarnDays;
}
async function acceptOnA(a: SupabaseClient, user: QaUser, fromKcal: number, delta = -100) {
  const id = await propose(a, user.id, fromKcal, fromKcal + delta);
  const r = await a.rpc("fn_accept_nutrition_adjustment", acceptArgs(id, { offset: delta, kcal: fromKcal + delta }));
  expect(r.error, r.error?.message).toBeNull();
}
async function gotoSettings(page: Page) {
  await page.goto("/dashboard/settings");
  await expect(page.locator('input[type="range"]').first()).toBeVisible();
}

test("§3 navegador: X-Client-Info llega a PostgREST, CORS permite las peticiones y el servidor ve nivel 1", async ({ page }) => {
  const user = await createQaUser("p");
  try {
    const seen: Array<{ info: string | undefined; status: number; acao: string | undefined; level: unknown }> = [];
    const consoleErrors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("response", async (res) => {
      if (!res.url().includes("/rest/v1/rpc/fn_plan_state_read")) return;
      let level: unknown = null;
      try { level = ((await res.json()) as { clientProtocolLevel?: number }).clientProtocolLevel; } catch { /* sin cuerpo */ }
      seen.push({ info: res.request().headers()["x-client-info"], status: res.status(), acao: res.headers()["access-control-allow-origin"], level });
    });
    await uiLogin(page, user);
    await page.goto("/dashboard/settings");
    await page.getByRole("button", { name: "Cargar datos demo" }).click(); // perfil sintético → push completo → lectura autoritativa
    await expect.poll(() => seen.length, { timeout: 60_000 }).toBeGreaterThan(0);
    evidence.protocolo_navegador = { llamadas: seen.length, ejemplo: seen[0], erroresConsola: consoleErrors.filter((e) => /CORS|cross-origin/i.test(e)).length };
    for (const s of seen) {
      expect(s.info).toBe(PLAN_PROTOCOL_CLIENT_INFO);
      expect(s.status).toBe(200);
      expect(s.acao).toBeTruthy();
      expect(s.level).toBe(1);
    }
    expect(consoleErrors.filter((e) => /CORS|cross-origin/i.test(e))).toEqual([]);
  } finally { await deleteQaUser(user); }
});

test("A: dos dispositivos, B desconectado con el estado anterior → offset, calibración y objetivo protegido no retroceden; edición legítima y diario/inventario intactos", async ({ page, context }) => {
  const { user, a, goal, weightRows } = await bootDevice(page, "a1");
    const weightsBefore = await weightRows();
  try {
    await gotoSettings(page);
    const before = await localState(page);
    const invBefore = (before.inventory ?? []).length;
    await context.setOffline(true);
    const edited = await bump(page); // edición legítima de B, sin red
    await expect.poll(async () => setting(await localState(page))).toBe(edited);
    await acceptOnA(a, user, goal.kcal_target); // A acepta el ajuste mientras B está desconectado
    await context.setOffline(false);
    await expect(badge(page)).toHaveText("Guardado", { timeout: 90_000 });
    await expect.poll(async () => ((await localState(page)).profile?.adaptiveKcalOffsetKcal), { timeout: 60_000 }).toBe(-100);

    const srvGoal = await serverGoal(a, user.id);
    const off = await serverOffset(a, user.id);
    const local = await localState(page);
    evidence.A = {
      antes: { offset: 0, objetivoKcal: goal.kcal_target },
      despues: { offsetServidor: off, objetivoServidor: srvGoal, offsetLocalB: local.profile?.adaptiveKcalOffsetKcal, objetivoLocalB: local.nutritionGoalsHistory?.[todayUtc()]?.kcal, ajusteEditado: setting(local), inventario: (local.inventory ?? []).length - invBefore },
    };
    expect(off).toBe(-100);
    expect(srvGoal?.kcal_target).toBe(goal.kcal_target - 100);
    expect(srvGoal?.basis_offset_kcal).toBe(-100);
    expect(srvGoal?.source_snapshot_id).not.toBeNull();
    expect(local.nutritionGoalsHistory?.[todayUtc()]?.kcal).toBe(goal.kcal_target - 100);
    // La edición legítima hecha sin red debe llegar a ambos lados (con margen: la reconciliación reenvía en segundo plano).
    const timeline: string[] = [];
    try { await expect.poll(async () => {
      const l = setting(await localState(page)); const s = await serverSetting(a, user.id);
      timeline.push(`local=${l} servidor=${s}`);
      return l === edited && s === edited;
    }, { timeout: 60_000 }).toBe(true); } catch (e) { throw new Error(`la edición sin red (${edited}) no llegó a ambos lados; serie: ${Array.from(new Set(timeline)).join(" | ")}\n${(e as Error).message}`); }
    evidence.A_edicion = { editada: edited, tiempoHastaConvergir: timeline.length, serie: Array.from(new Set(timeline)) };
    // efectos secundarios: el diario (pesajes) y las columnas del perfil no cambian por la reconciliación
    expect(await weightRows()).toEqual(weightsBefore);
    const prof = await a.from("user_profiles").select("weight_kg, goal, age").eq("user_id", user.id).single();
    expect({ w: Number(prof.data?.weight_kg), g: prof.data?.goal, age: prof.data?.age }).toEqual({ w: 80, g: "fat_loss", age: 32 });
    expect((local.inventory ?? []).length).toBe(invBefore);
    await page.reload(); // tras recargar sigue igual (el servidor es la fuente)
    await expect.poll(async () => ((await localState(page)).profile?.adaptiveKcalOffsetKcal), { timeout: 60_000 }).toBe(-100);
    expect(setting(await localState(page))).toBe(edited);
  } finally { await deleteQaUser(user); }
});

test("B: edición legítima mientras la lectura de la sincronización está en vuelo → se conserva y solo cambia lo que corresponde", async ({ page }) => {
  const { user, a, goal } = await bootDevice(page, "b1");
  try {
    await gotoSettings(page);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = 0;
    await page.route(READBACK, async (route: Route) => {
      if (!isGoalReadback(route.request())) return route.continue();
      held++; await gate; return route.continue();
    });
    await acceptOnA(a, user, goal.kcal_target); // el servidor ya tiene el ajuste; B aún no lo sabe
    await bump(page); // 1.ª edición → push → lectura retenida
    await expect.poll(() => held, { timeout: 60_000 }).toBeGreaterThan(0);
    const second = await bump(page); // 2.ª edición con la lectura en vuelo
    release();
    await expect(badge(page)).toHaveText("Guardado", { timeout: 90_000 });
    await expect.poll(async () => ((await localState(page)).profile?.adaptiveKcalOffsetKcal), { timeout: 60_000 }).toBe(-100);
    const local = await localState(page);
    evidence.B = { ajusteEsperado: second, ajusteLocal: setting(local), offsetLocal: local.profile?.adaptiveKcalOffsetKcal, objetivoServidor: await serverGoal(a, user.id) };
    expect(setting(local)).toBe(second);
    expect(await serverOffset(a, user.id)).toBe(-100);
    expect((await serverGoal(a, user.id))?.kcal_target).toBe(goal.kcal_target - 100);
  } finally { await deleteQaUser(user); }
});

test("D: falla la lectura posterior → la recuperación persiste, sobrevive a recargar y solo se retira al confirmar", async ({ page }) => {
  const { user, a } = await bootDevice(page, "d1");
  try {
    await gotoSettings(page);
    const markKey = `foodos-plan-recheck-v1-${user.id}`;
    let failing = true; let aborted = 0;
    await page.route(READBACK, (route) => {
      if (failing && isGoalReadback(route.request())) { aborted++; return route.abort("failed"); }
      return route.continue();
    });
    await bump(page);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k) !== null, markKey), { timeout: 60_000 }).toBe(true);
    await expect(badge(page)).not.toHaveText("Guardado");
    await page.reload(); // la marca durable sobrevive a recargar
    expect(await page.evaluate((k) => localStorage.getItem(k) !== null, markKey)).toBe(true);
    failing = false; // el servidor vuelve a responder
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), markKey), { timeout: 120_000 }).toBeNull();
    await expect(badge(page)).toHaveText("Guardado", { timeout: 60_000 });
    evidence.D = { lecturasAbortadas: aborted, marcaTrasRecarga: true, retiradaAlConfirmar: true, offsetServidor: await serverOffset(a, user.id) };
  } finally { await deleteQaUser(user); }
});

test("E: respuesta VÁLIDA que no se puede reconciliar → no «guardado», presupuesto acotado, marca durable y sin más peticiones al agotarlo", async ({ page }) => {
  await page.clock.install(); // reloj controlable: los reintentos de 5/15/45/120/300 s no se esperan en tiempo real
  const { user } = await bootDevice(page, "e1");
  try {
    await gotoSettings(page);
    const markKey = `foodos-plan-recheck-v1-${user.id}`;
    let reads = 0;
    await page.route(READBACK, async (route) => {
      if (!isGoalReadback(route.request())) return route.continue();
      reads++;
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      return route.fulfill({ response: res, json: { ...body, goal: null } }); // válida, pero el objetivo de hoy «no existe»
    });
    await bump(page);
    for (let i = 0; i < 25; i++) await page.clock.runFor(30_000); // ~750 s virtuales > 5+15+45+120+300
    await expect(badge(page)).not.toHaveText("Guardado");
    expect(await page.evaluate((k) => localStorage.getItem(k) !== null, markKey)).toBe(true);
    const readsAtExhaustion = reads;
    for (let i = 0; i < 20; i++) await page.clock.runFor(30_000);
    evidence.E = { lecturas: readsAtExhaustion, lecturasTrasAgotar: reads, estado: await badge(page).textContent(), marcaDurable: true };
    expect(readsAtExhaustion).toBeLessThan(30);
    expect(reads).toBe(readsAtExhaustion); // sin temporizadores huérfanos
  } finally { await deleteQaUser(user); }
});

test("F: logout con la lectura de A en vuelo → nada de A se aplica después; una cuenta distinta no hereda estado ni recuperación", async ({ page, browser }) => {
  const { user, a, goal } = await bootDevice(page, "f1");
  const other = await createQaUser("f2");
  try {
    await gotoSettings(page);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = 0;
    await page.route(READBACK, async (route) => {
      if (!isGoalReadback(route.request())) return route.continue();
      held++; await gate; return route.continue();
    });
    await acceptOnA(a, user, goal.kcal_target);
    await bump(page);
    await expect.poll(() => held, { timeout: 60_000 }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Cerrar sesión" }).click();
    // La mutación sigue «sin confirmar» (su confirmación espera a la lectura retenida): la app ofrece esperar, cancelar o salir.
    // Se elige salir descartando la copia local; en el servidor la escritura ya estaba confirmada.
    await page.getByRole("button", { name: "Salir y descartar esos cambios" }).click({ timeout: 15_000 });
    // El cierre de sesión espera a que la operación en vuelo termine (la lectura retenida): sigue «sincronizando».
    await page.waitForTimeout(2_000);
    release(); // la respuesta de A llega MIENTRAS se cierra la sesión
    await page.waitForTimeout(6_000); // margen para que cualquier efecto tardío de A se manifestase
    const after = await localState(page);
    evidence.F_logout = { offsetLocalTrasLogout: after.profile?.adaptiveKcalOffsetKcal ?? null };
    expect(after.profile?.adaptiveKcalOffsetKcal ?? 0).not.toBe(-100);
    // Otra cuenta, en un contexto nuevo del mismo navegador: no ve nada de A
    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await uiLogin(p2, other);
    await p2.goto("/dashboard/settings");
    await expect(p2.locator('input[type="range"]').first()).toBeVisible();
    const s2 = await localState(p2);
    expect(s2.profile?.adaptiveKcalOffsetKcal ?? 0).toBe(0);
    expect(await p2.evaluate((k) => localStorage.getItem(k), `foodos-plan-recheck-v1-${user.id}`)).toBeNull();
    const bClient = await signedClient(other);
    expect(await serverGoal(bClient, other.id)).toBeNull(); // nada de A se escribió en B
    await ctx.close();
  } finally { await deleteQaUser(user); await deleteQaUser(other); }
});
