import type {
  AcceptAdjustmentResult,
  ActivityLevel,
  AdjustmentDecision,
  AdjustmentProposal,
  AdjustmentProposalEvidence,
  FoodLogEntry,
  FoodOSState,
  GoalMode,
  IncomeFrequency,
  MealType,
  NutritionCalculationSnapshot,
  PhysicalProfile,
  Sex,
  StorageName,
} from "@foodos/types";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { migrateLegacyTrainingActivity } from "./nutrition";
import { getSupabase } from "./supabase";
import { ensureUuid, mealTypeFromTime, todayPlus } from "./utils";

// Capa de persistencia de FoodOS.
// - Local: localStorage, siempre activa.
// - Remota: Supabase (supabase/schema.sql). Se activa con .env.local y sesion.
//   pull = reconstruye el estado desde las tablas; push = sincroniza con
//   estrategia naive de MVP (upsert + delete de lo ausente), suficiente para
//   un usuario. Para multiusuario: pasar a mutaciones por accion.

const LOCAL_KEY = "foodos-appweb-state-v1";
const PUSH_DEBOUNCE_MS = 400;
const PUSH_RETRY_MS = 10_000;
const PUSH_ERROR_NOTIFY_THROTTLE_MS = 30_000;

const STORAGE_TYPE_BY_NAME: Record<StorageName, string> = {
  Nevera: "fridge",
  Congelador: "freezer",
  Despensa: "pantry",
};

const GOAL_MODES: GoalMode[] = ["fat_loss", "muscle_gain", "recomp", "maintain"];

function today(): string {
  return todayPlus(0);
}

/** Extrae un mensaje legible de cualquier error, sin asumir que sea una
    instancia de Error — un PostgrestError de supabase-js trae `.message`
    pero no siempre puede darse por hecho que sea `instanceof Error` en
    todas las versiones/builds. Sin este fallback, un error que no lo fuera
    se convertía en el inútil "[object Object]" al concatenarlo con String(). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

// ---------- Local ----------

export function loadLocalState(defaults: FoodOSState): FoodOSState {
  if (typeof window === "undefined") return structuredClone(defaults);
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "null");
    return stored ? { ...structuredClone(defaults), ...stored } : structuredClone(defaults);
  } catch {
    return structuredClone(defaults);
  }
}

export function saveLocalState(state: FoodOSState): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  } catch (error) {
    // Cuota de localStorage superada (~5MB, alcanzable con muchas fotos de
    // producto en base64): sin este catch, el setItem lanzaba dentro del
    // updater de React y rompía la mutación entera, no solo la persistencia.
    console.warn("FoodOS: no se pudo guardar el estado en localStorage", error);
  }
}

// Escritura diferida: serializar el estado completo (que puede superar 1MB con
// fotos en base64) en cada tecleo/clic bloqueaba el hilo principal. El debounce
// agrupa ráfagas de mutaciones en una sola escritura; flushLocalState() se
// invoca en pagehide para no perder los últimos ~300ms al cerrar o recargar.
const LOCAL_SAVE_DEBOUNCE_MS = 300;
let localSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLocalState: FoodOSState | null = null;

export function saveLocalStateDebounced(state: FoodOSState): void {
  pendingLocalState = state;
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    localSaveTimer = null;
    if (pendingLocalState) {
      saveLocalState(pendingLocalState);
      pendingLocalState = null;
    }
  }, LOCAL_SAVE_DEBOUNCE_MS);
}

export function flushLocalState(): void {
  if (localSaveTimer) {
    clearTimeout(localSaveTimer);
    localSaveTimer = null;
  }
  if (pendingLocalState) {
    saveLocalState(pendingLocalState);
    pendingLocalState = null;
  }
}

export function clearLocalState(): void {
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = null;
  pendingLocalState = null;
  localStorage.removeItem(LOCAL_KEY);
}

// ---------- Remota (Supabase) ----------

class RemoteAdapter {
  client: SupabaseClient | null = null;
  user: User | null = null;
  private almacenIdByName: Record<string, string> = {};
  private shoppingListId: string | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pushing = false;
  private pushQueued: FoodOSState | null = null;
  private lastPushErrorNotifiedAt = 0;
  /** La UI se engancha aquí para avisar al usuario de que un guardado no
      llegó al servidor (queda solo en este dispositivo hasta reintentar). */
  onPushError: ((error: unknown) => void) | null = null;
  /** E04-07: la UI se engancha aquí para mostrar el estado de sincronización
      en la cabecera (guardado/sincronizando/error). Se dispara al empezar un
      push ("syncing"), al terminarlo bien ("saved") o al fallar ("error") —
      independiente de onPushError, que solo dispara el toast (throttleado)
      de aviso; este callback sí debe reflejar cada transición para que el
      indicador no se quede "sincronizando" para siempre tras un error. */
  onStatusChange: ((status: "syncing" | "saved" | "error") => void) | null = null;

  get ready(): boolean {
    return this.client !== null;
  }

  /** true si hay un guardado local programado, en curso, en cola, o
      esperando su reintento tras un fallo. Se usa para que un refresco en
      tiempo real no pise con datos remotos desactualizados (o, tras un
      fallo parcial, directamente INCOMPLETOS) un cambio local que aún no ha
      llegado al servidor (condición de carrera).
      B2 (revisión externa, 2026-08-22): antes NO incluía pushRetryTimer —
      mientras un push fallido esperaba su reintento (hasta PUSH_RETRY_MS =
      10s), esta función ya devolvía false, así que un refresco en tiempo
      real de OTRA fila podía disparar una hidratación completa que pisara
      el estado local con el resultado a medias del push que aún no se
      había reintentado. Ver state.tsx (scheduleHydrate/onStatusChange) para
      la otra mitad del arreglo: ahora, mientras esto sea true, un refresco
      en tiempo real se difiere en vez de forzarse tras un margen fijo. */
  hasPendingPush(): boolean {
    return this.pushTimer !== null || this.pushing || this.pushQueued !== null || this.pushRetryTimer !== null;
  }

  async init(): Promise<boolean> {
    this.client = getSupabase();
    if (!this.client) return false;
    const { data } = await this.client.auth.getSession();
    this.user = data.session?.user ?? null;
    return true;
  }

  onAuthChange(callback: (user: User | null) => void): void {
    this.client?.auth.onAuthStateChange((_event, session) => {
      this.user = session?.user ?? null;
      callback(this.user);
    });
  }

  signInWithGoogle() {
    // El código PKCE se intercambia en /auth/callback antes de entrar al dashboard.
    // Si se redirige directamente a la página actual, el guard de auth puede
    // disparar antes de que termine el intercambio y devolver al landing.
    return this.client!.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  signUpWithPassword(email: string, password: string) {
    return this.client!.auth.signUp({ email, password });
  }

  signInWithPassword(email: string, password: string) {
    return this.client!.auth.signInWithPassword({ email, password });
  }

  signInWithMagicLink(email: string) {
    return this.client!.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  resetPassword(email: string) {
    return this.client!.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/dashboard`,
    });
  }

  async signOut() {
    this.user = null;
    return this.client!.auth.signOut();
  }

  resendConfirmation(email: string) {
    return this.client!.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
  }

  async deleteAccount(): Promise<{ error: string | null }> {
    if (!this.client || !this.user) return { error: "No hay sesión activa" };
    const { error } = await this.client.functions.invoke("delete-account");
    if (error) return { error: error.message };
    return { error: null };
  }

  /** Sube una foto de producto (data-URL JPEG ya comprimida) a Storage y
      devuelve su URL pública. null si no hay sesión — el caller decide el
      fallback (guardar el base64 en el estado, modo local). Así el estado
      solo lleva URLs y no ~30-80KB de base64 por foto en cada serialización. */
  async uploadProductImage(dataUrl: string): Promise<string | null> {
    if (!this.client || !this.user) return null;
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${this.user.id}/${crypto.randomUUID()}.jpg`;
    const { error } = await this.client.storage
      .from("product-images")
      .upload(path, blob, { contentType: "image/jpeg" });
    if (error) throw error;
    return this.client.storage.from("product-images").getPublicUrl(path).data.publicUrl;
  }

  /** Borra una foto de producto de Storage cuando ya no la referencia ningún
      item (comprobarlo antes con isImageUrlReferencedElsewhere). No lanza: es
      limpieza de mejor esfuerzo, un fallo aquí no debe romper la mutación que
      la disparó (borrar/editar el item). Ignora URLs que no sean de nuestro
      bucket (fotos base64 legacy, o una URL externa pegada a mano). */
  async deleteProductImage(url: string): Promise<void> {
    if (!this.client || !this.user) return;
    const marker = "/product-images/";
    const idx = url.indexOf(marker);
    if (idx === -1) return;
    const path = url.slice(idx + marker.length);
    if (!path.startsWith(`${this.user.id}/`)) return; // defensivo: solo la carpeta propia
    const { error } = await this.client.storage.from("product-images").remove([path]);
    if (error) console.warn("FoodOS: no se pudo borrar la imagen huérfana de Storage", error);
  }

  /** Guarda un snapshot inmutable de cómo se calculó un objetivo nutricional y
      enlaza nutrition_goals de hoy con él (source_snapshot_id). Llamar SOLO
      desde eventos explícitos del usuario (guardar perfil, cambiar objetivo,
      recalcular manualmente) — nunca desde un render o el sync periódico, o
      generaría un snapshot por cada tecla. No lanza: si falla, el perfil ya
      se guardó igualmente — perder la trazabilidad de un snapshot no debe
      bloquear al usuario. */
  async saveNutritionSnapshot(snapshot: NutritionCalculationSnapshot): Promise<void> {
    if (!this.client || !this.user) return;
    const userId = this.user.id;
    try {
      const { data, error } = await this.client
        .from("nutrition_calculation_snapshots")
        .insert({
          user_id: userId,
          calculation_version: snapshot.calculationVersion,
          trigger_reason: snapshot.triggerReason,
          input_snapshot: snapshot.inputSnapshot,
          resting_energy: snapshot.restingEnergy,
          tdee: snapshot.tdee,
          calorie_target: snapshot.calorieTarget,
          macros: snapshot.macros,
          safety: snapshot.safety,
        })
        .select("id")
        .single();
      if (error || !data) { console.warn("FoodOS: no se pudo guardar el snapshot nutricional", error); return; }

      await this.client
        .from("nutrition_goals")
        .update({ source_snapshot_id: data.id, calculation_version: snapshot.calculationVersion })
        .eq("user_id", userId)
        .eq("goal_date", today());
    } catch (err) {
      console.warn("FoodOS: error guardando el snapshot nutricional", err);
    }
  }

  /**
   * Objetivos calóricos históricos por fecha (nutrition_goals), para
   * construir el targetByDate real que necesita calcIntakeCoverage — ver
   * docs/NUTRITION_V3_DECISIONES.md §2.3. La tabla ya guarda una fila por
   * (user_id, goal_date) desde antes de v3 (upsert en pushState y en
   * fn_accept_nutrition_adjustment, nunca delete); lo que faltaba era leer
   * el rango en vez de solo la última fila. `fromDateKey`/`toDateKey`
   * inclusive, formato YYYY-MM-DD. No lanza: si falla, el caller debe tratar
   * el resultado vacío como "sin histórico disponible para esa ventana"
   * (calcIntakeCoverage ya excluye días sin dato, así que un array vacío es
   * un estado válido, no un error). */
  async getNutritionGoalsRange(
    fromDateKey: string,
    toDateKey: string,
  ): Promise<Array<{ goalDate: string; kcalTarget: number }>> {
    if (!this.client || !this.user) return [];
    try {
      const { data, error } = await this.client
        .from("nutrition_goals")
        .select("goal_date, kcal_target")
        .eq("user_id", this.user.id)
        .gte("goal_date", fromDateKey)
        .lte("goal_date", toDateKey)
        .order("goal_date", { ascending: true });
      if (error || !data) {
        console.warn("FoodOS: no se pudo leer el histórico de nutrition_goals", error);
        return [];
      }
      return data.map((row) => ({ goalDate: row.goal_date as string, kcalTarget: Number(row.kcal_target) }));
    } catch (err) {
      console.warn("FoodOS: error de red leyendo el histórico de nutrition_goals", err);
      return [];
    }
  }

  /** Mapea una fila de nutrition_adjustment_proposals al tipo de la app. */
  private mapAdjustmentProposalRow(row: {
    id: string;
    current_target_kcal: number;
    proposed_target_kcal: number;
    delta_kcal: number;
    reason: string;
    status: AdjustmentProposal["status"];
    created_at: string;
    resolved_at: string | null;
    evidence?: AdjustmentProposalEvidence | null;
  }): AdjustmentProposal {
    return {
      id: row.id,
      currentTargetKcal: row.current_target_kcal,
      proposedTargetKcal: row.proposed_target_kcal,
      deltaKcal: row.delta_kcal,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      evidence: row.evidence ?? undefined,
    };
  }

  /** Crea el snapshot de una revisión adaptativa (trigger_reason:
      'adaptive_review') y, solo si la decisión dice que procede, la propuesta
      de ajuste enlazada a él — con toda la evidencia numérica que la sustenta
      (cobertura, tendencia, TDEE, confianza...), nunca vacía (ver N13).
      Llamar SOLO desde el botón explícito "Generar propuesta" — nunca
      automáticamente desde un render o temporizador. Devuelve la propuesta
      creada (o null si no procedía o falló). */
  async createAdjustmentReview(params: {
    snapshot: NutritionCalculationSnapshot;
    decision: AdjustmentDecision;
    evidence: AdjustmentProposalEvidence;
  }): Promise<AdjustmentProposal | null> {
    if (!this.client || !this.user) return null;
    const userId = this.user.id;
    try {
      const { snapshot, decision, evidence } = params;
      const { data: snapshotRow, error: snapshotError } = await this.client
        .from("nutrition_calculation_snapshots")
        .insert({
          user_id: userId,
          calculation_version: snapshot.calculationVersion,
          trigger_reason: snapshot.triggerReason,
          input_snapshot: snapshot.inputSnapshot,
          resting_energy: snapshot.restingEnergy,
          tdee: snapshot.tdee,
          calorie_target: snapshot.calorieTarget,
          macros: snapshot.macros,
          safety: snapshot.safety,
        })
        .select("id")
        .single();
      if (snapshotError || !snapshotRow) {
        console.warn("FoodOS: no se pudo guardar el snapshot de revisión adaptativa", snapshotError);
        return null;
      }

      if (!decision.shouldPropose) return null;

      const { data: proposalRow, error: proposalError } = await this.client
        .from("nutrition_adjustment_proposals")
        .insert({
          user_id: userId,
          snapshot_id: snapshotRow.id,
          current_target_kcal: decision.proposedTargetKcal - decision.deltaKcal,
          proposed_target_kcal: decision.proposedTargetKcal,
          delta_kcal: decision.deltaKcal,
          reason: decision.reason,
          evidence,
        })
        .select("id, current_target_kcal, proposed_target_kcal, delta_kcal, reason, status, created_at, resolved_at, evidence")
        .single();
      if (proposalError || !proposalRow) {
        console.warn("FoodOS: no se pudo guardar la propuesta de ajuste", proposalError);
        return null;
      }

      return this.mapAdjustmentProposalRow(proposalRow);
    } catch (err) {
      console.warn("FoodOS: error creando la revisión adaptativa", err);
      return null;
    }
  }

  /**
   * Acepta o rechaza una propuesta de ajuste pendiente a través de
   * fn_accept_nutrition_adjustment (RPC transaccional — ver
   * supabase/migrations/20260819_nutrition_adjustment_accept_rpc.sql).
   * A diferencia de la versión anterior (update directo + mutación local por
   * separado), aquí resolver la propuesta, guardar el snapshot final, aplicar
   * el offset al perfil y actualizar el objetivo vigente ocurren en una sola
   * transacción — y el resultado SIEMPRE indica si de verdad se aplicó.
   * El caller (UI) NO debe tocar ningún estado local salvo que ok sea true:
   * un error de Supabase aquí no lanza necesariamente una excepción (llega
   * como el campo `error` de la respuesta), así que ignorarlo dejaría a la UI
   * mostrando "aplicado" sin que el servidor hiciera nada (ver N3).
   */
  async acceptAdjustmentProposal(params: {
    proposalId: string;
    accepted: boolean;
    goalDate: string;
    /** Obligatorios solo cuando accepted es true — el RPC los ignora al rechazar. */
    newOffsetKcal?: number | null;
    kcalTarget?: number | null;
    proteinG?: number | null;
    carbsG?: number | null;
    fatG?: number | null;
    mode?: GoalMode | null;
    finalSnapshot?: NutritionCalculationSnapshot | null;
  }): Promise<AcceptAdjustmentResult> {
    if (!this.client || !this.user) {
      return { ok: false, error: "Sin conexión con el servidor — no se pudo aplicar el cambio." };
    }
    try {
      const s = params.finalSnapshot;
      const { data, error } = await this.client.rpc("fn_accept_nutrition_adjustment", {
        p_proposal_id: params.proposalId,
        p_accepted: params.accepted,
        p_new_offset_kcal: params.accepted ? params.newOffsetKcal ?? null : null,
        p_goal_date: params.goalDate,
        p_kcal_target: params.accepted ? params.kcalTarget ?? null : null,
        p_protein_g: params.accepted ? params.proteinG ?? null : null,
        p_carbs_g: params.accepted ? params.carbsG ?? null : null,
        p_fat_g: params.accepted ? params.fatG ?? null : null,
        p_mode: params.accepted ? params.mode ?? null : null,
        p_snapshot: params.accepted && s
          ? {
              calculation_version: s.calculationVersion,
              input_snapshot: s.inputSnapshot,
              resting_energy: s.restingEnergy,
              tdee: s.tdee,
              calorie_target: s.calorieTarget,
              macros: s.macros,
              safety: s.safety,
            }
          : null,
      });
      if (error) {
        console.warn("FoodOS: fn_accept_nutrition_adjustment devolvió un error", error);
        return { ok: false, error: error.message };
      }
      const row = data as { ok: boolean; status: "accepted" | "rejected"; new_offset_kcal: number | null };
      if (!row?.ok) {
        return { ok: false, error: "El servidor no confirmó el cambio." };
      }
      return { ok: true, status: row.status, newOffsetKcal: row.new_offset_kcal };
    } catch (err) {
      console.warn("FoodOS: error de red respondiendo a la propuesta de ajuste", err);
      return { ok: false, error: err instanceof Error ? err.message : "Error de red desconocido." };
    }
  }

  /** Incremento atómico de agua: evita conflictos de concurrencia entre tabs/dispositivos. */
  async incrementWater(date: string, deltaMl: number): Promise<number> {
    if (!this.client || !this.user) return 0;
    const { data, error } = await this.client.rpc("fn_water_increment", {
      p_date: date,
      p_delta: deltaMl,
    });
    if (error) throw error;
    return data as number;
  }

  /**
   * Suscripción Realtime con dos niveles de respuesta:
   * - onPatch: cambio puntual en water_log o weight_log → aplica el dato del payload
   *   directamente en estado, sin re-fetch. Latencia ≈ solo el WebSocket (~50-200ms).
   * - onRefresh: resto de tablas → re-fetch completo con debounce breve.
   */
  subscribeRealtime(
    onRefresh: () => void,
    onPatch: (table: string, newRow: Record<string, unknown>) => void,
    onStatus?: (connected: boolean) => void,
  ): () => void {
    if (!this.client || !this.user) return () => {};
    const userId = this.user.id;
    const patch = (table: string) =>
      (payload: { new: Record<string, unknown> }) => {
        if (payload.new && Object.keys(payload.new).length > 0) {
          onPatch(table, payload.new);
        } else {
          onRefresh();
        }
      };
    const channel = this.client
      .channel(`foodos-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory_items",  filter: `owner_id=eq.${userId}` }, onRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "gastos",           filter: `user_id=eq.${userId}` }, onRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items",   filter: `user_id=eq.${userId}` }, onRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "food_log",         filter: `user_id=eq.${userId}` }, onRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "user_profiles",    filter: `user_id=eq.${userId}` }, onRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "nutrition_goals",  filter: `user_id=eq.${userId}` }, onRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "ingresos_fuentes", filter: `user_id=eq.${userId}` }, onRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "water_log",        filter: `user_id=eq.${userId}` }, patch("water_log"))
      .on("postgres_changes", { event: "*", schema: "public", table: "weight_log",       filter: `user_id=eq.${userId}` }, patch("weight_log"))
      .subscribe((status) => {
        onStatus?.(status === "SUBSCRIBED");
      });
    return () => { void this.client?.removeChannel(channel); };
  }

  // Crea (si faltan) perfil, almacenes base y lista de compra, y cachea ids.
  async ensureBaseRows(): Promise<void> {
    const client = this.client!;
    const userId = this.user!.id;

    // B2 (revisión externa, 2026-08-22): sin comprobar el error aquí, un
    // fallo creando la fila base del perfil (RLS, constraint...) pasaba
    // desapercibido y todo lo que dependiera de que esa fila existe fallaría
    // más tarde con un error mucho más confuso (o, peor, un pushState()
    // posterior que actualiza 0 filas sin avisar — ver el comentario grande
    // sobre el upsert de perfil en pushState()).
    const { error: baseProfileError } = await client
      .from("user_profiles")
      .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
    if (baseProfileError) throw baseProfileError;

    const { data: almacenes } = await client.from("almacenes").select("id, name, type").eq("owner_id", userId);
    const existing = almacenes ?? [];
    for (const [name, type] of Object.entries(STORAGE_TYPE_BY_NAME)) {
      let row = existing.find((a) => a.type === type);
      if (!row) {
        const { data: created, error } = await client
          .from("almacenes")
          .insert({ owner_id: userId, name, type })
          .select("id")
          .single();
        if (error) throw error;
        row = { id: created.id, name, type };
        // El propietario tambien es miembro (lo exige la policy de inventario).
        await client.from("almacen_members").upsert(
          { almacen_id: row.id, user_id: userId, role: "owner" },
          { onConflict: "almacen_id,user_id", ignoreDuplicates: true }
        );
      }
      this.almacenIdByName[name] = row.id;
    }

    const { data: lists } = await client
      .from("shopping_lists")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1);
    if (lists?.length) {
      this.shoppingListId = lists[0].id;
    } else {
      const { data: created, error } = await client
        .from("shopping_lists")
        .insert({ user_id: userId, name: "Compra" })
        .select("id")
        .single();
      if (error) throw error;
      this.shoppingListId = created.id;
    }
  }

  // Reconstruye el estado de la app desde las tablas.
  async pullState(defaults: FoodOSState): Promise<FoodOSState> {
    const client = this.client!;
    const userId = this.user!.id;
    const state = structuredClone(defaults);

    // Defensivo: si ensureBaseRows() no llegó a fijar shoppingListId (no debería
    // pasar si no lanzó, pero evita una consulta con list_id=null que "tendría
    // éxito" devolviendo 0 filas — preferimos fallar alto y mantener el estado
    // local anterior a mostrar un carrito vacío falso).
    if (!this.shoppingListId) {
      throw new Error("pullState: shoppingListId no está listo (ensureBaseRows no se completó)");
    }

    const [profileRes, inventoryRes, cartRes, gastosRes, ingresosRes, goalRes, logRes, waterRes, weightRes, proposalRes] = await Promise.all([
      client
        .from("user_profiles")
        .select(
          "mascot_id, weekly_food_budget, age, sex, height_cm, weight_kg, body_fat_pct, body_fat_source, activity_level, goal, gym_days, allergies, excluded_foods, target_weight_kg, experience_level, equipment_access, activity_model_version, extra_state"
        )
        .eq("user_id", userId)
        .maybeSingle(),
      client
        .from("inventory_items")
        .select("id, name, quantity, unit, expiry_date, price_estimate, kcal_per_100, protein_per_100, carbs_per_100, fat_per_100, salt_per_100, fiber_per_100, sugars_per_100, unit_size, brand, image_url, allergen_tags, almacen_id")
        .eq("owner_id", userId),
      client
        .from("shopping_items")
        .select("id, name, quantity, unit, estimated_price, store, checked, unit_size")
        .eq("user_id", userId)
        .eq("list_id", this.shoppingListId),
      client.from("gastos").select("id, amount, description, category, txn_date").eq("user_id", userId),
      client.from("ingresos_fuentes").select("id, name, amount, frequency, day_of_month, active").eq("user_id", userId),
      client
        .from("nutrition_goals")
        .select("kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode")
        .eq("user_id", userId)
        .order("goal_date", { ascending: false })
        .limit(1),
      client
        .from("food_log")
        .select("id, log_date, created_at, item_name, quantity_g, kcal, protein_g, carbs_g, fat_g, source, client_meta")
        .eq("user_id", userId)
        .order("log_date", { ascending: false })
        .limit(500),
      client
        .from("water_log")
        .select("log_date, ml")
        .eq("user_id", userId),
      client
        .from("weight_log")
        .select("log_date, kg")
        .eq("user_id", userId)
        .order("log_date", { ascending: true }),
      client
        .from("nutrition_adjustment_proposals")
        .select("id, current_target_kcal, proposed_target_kcal, delta_kcal, reason, status, created_at, resolved_at, evidence")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

    // Supabase-js NO lanza excepción en fallos de consulta (400, RLS, etc.):
    // devuelve {data: null, error}. Sin esta comprobación, cualquier consulta
    // fallida se traduciría en "no hay datos" y borraría silenciosamente esa
    // parte del estado en el próximo hydrateRemote(). Preferimos lanzar y que
    // el catch de hydrateRemote() conserve el estado local anterior.
    const namedResults: Array<[string, { error: { message: string } | null }]> = [
      ["perfil", profileRes],
      ["inventario", inventoryRes],
      ["carrito", cartRes],
      ["gastos", gastosRes],
      ["ingresos", ingresosRes],
      ["objetivos nutricionales", goalRes],
      ["diario", logRes],
      ["agua", waterRes],
      ["peso", weightRes],
      ["propuesta de ajuste", proposalRes],
    ];
    const failed = namedResults.find(([, res]) => res.error);
    if (failed) {
      const [label, res] = failed;
      throw new Error(`pullState: fallo consultando "${label}": ${res.error!.message}`);
    }

    const almacenNameById = Object.fromEntries(
      Object.entries(this.almacenIdByName).map(([name, id]) => [id, name])
    );

    if (profileRes.data) {
      const p = profileRes.data;
      state.mascotId = p.mascot_id ?? state.mascotId;
      state.weeklyBudget = Number(p.weekly_food_budget) || state.weeklyBudget;
      // El perfil fisico solo existe si se completo el onboarding.
      if (p.age && p.sex && p.height_cm && p.weight_kg && p.activity_level && p.goal) {
        state.profile = {
          age: Number(p.age),
          sex: p.sex as Sex,
          heightCm: Number(p.height_cm),
          weightKg: Number(p.weight_kg),
          bodyFatPct: p.body_fat_pct != null ? Number(p.body_fat_pct) : null,
          bodyFatSource: (p.body_fat_source as PhysicalProfile["bodyFatSource"]) ?? null,
          activityLevel: p.activity_level as ActivityLevel,
          goal: GOAL_MODES.includes(p.goal as GoalMode) ? (p.goal as GoalMode) : "maintain",
          gymDays: p.gym_days ?? [],
          allergies: p.allergies ?? [],
          excludedFoods: p.excluded_foods ?? [],
          targetWeightKg: p.target_weight_kg != null ? Number(p.target_weight_kg) : undefined,
          experienceLevel: (p.experience_level as PhysicalProfile["experienceLevel"]) ?? undefined,
          equipmentAccess: (p.equipment_access as PhysicalProfile["equipmentAccess"]) ?? undefined,
          activityModelVersion: (p.activity_model_version as PhysicalProfile["activityModelVersion"]) ?? "legacy_total_pal",
        };
      }
      // extra_state: campos de app no tabulados (routines, workoutLog, etc.)
      const extra = p.extra_state as Record<string, unknown> | null;
      if (extra) {
        if (Array.isArray(extra.routines))         state.routines         = extra.routines;
        if (Array.isArray(extra.workoutLog))       state.workoutLog       = extra.workoutLog;
        if (Array.isArray(extra.recurringExpenses)) state.recurringExpenses = extra.recurringExpenses;
        if (Array.isArray(extra.customRecipes))    state.customRecipes    = extra.customRecipes;
        if (Array.isArray(extra.savedRecipeIds))    state.savedRecipeIds    = extra.savedRecipeIds;
        if (Array.isArray(extra.dismissedSuggestions)) state.dismissedSuggestions = extra.dismissedSuggestions;
        if (extra.mealPlan && typeof extra.mealPlan === "object") state.mealPlan = extra.mealPlan as typeof state.mealPlan;
        if (Array.isArray(extra.plannerQuickMeals)) state.plannerQuickMeals = extra.plannerQuickMeals;
        if (extra.categoryBudgets && typeof extra.categoryBudgets === "object") state.categoryBudgets = extra.categoryBudgets as typeof state.categoryBudgets;
        if (extra.settings && typeof extra.settings === "object") state.settings = { ...state.settings, ...(extra.settings as typeof state.settings) };
        if (typeof extra.savingsGoalPct === "number") state.savingsGoalPct = extra.savingsGoalPct;
        if (typeof extra.bankSynced === "boolean") state.bankSynced = extra.bankSynced;
        if (typeof extra.recipeTag === "string") state.recipeTag = extra.recipeTag;
        if (["higher_carbohydrate", "balanced", "higher_fat"].includes(extra.macroPreference as string)) {
          state.macroPreference = extra.macroPreference as typeof state.macroPreference;
        }
        if (typeof extra.debugDate === "string" || extra.debugDate === null) state.debugDate = extra.debugDate as string | null;
        if (extra.stepsLog && typeof extra.stepsLog === "object") state.stepsLog = extra.stepsLog as typeof state.stepsLog;
        // trainingActivity vive dentro de profile pero se persiste en extra_state
        // (igual que macroPreference): es aditivo, no requiere migración de
        // columna. Sí necesita migración de FORMA: perfiles guardados antes
        // de nutrition-v3 tienen el avgSessionDurationMin legacy compartido
        // entre fuerza y cardio — migrateLegacyTrainingActivity lo convierte
        // a la forma v3 marcando legacyDurationUnconfirmed (ver
        // docs/NUTRITION_V3_DECISIONES.md §2.1/§10). Si ya viene en forma
        // v3, la devuelve tal cual.
        if (state.profile && extra.trainingActivity && typeof extra.trainingActivity === "object") {
          state.profile.trainingActivity = migrateLegacyTrainingActivity(
            extra.trainingActivity as Record<string, unknown>
          );
        }
        // adaptiveKcalOffsetKcal vive dentro de profile pero se persiste en
        // extra_state (igual que trainingActivity/macroPreference): es
        // aditivo, no requiere migración. Solo lo escribe aceptar/rechazar
        // una AdjustmentProposal (PR6), nunca un guardado normal de perfil.
        if (state.profile && typeof extra.adaptiveKcalOffsetKcal === "number") {
          state.profile.adaptiveKcalOffsetKcal = extra.adaptiveKcalOffsetKcal;
        }
        // adaptiveCalibrationStartedAt/lastTargetChangedAt (PR9): mismo
        // criterio que adaptiveKcalOffsetKcal — viven en extra_state, aditivo.
        if (state.profile && (typeof extra.adaptiveCalibrationStartedAt === "string" || extra.adaptiveCalibrationStartedAt === null)) {
          state.profile.adaptiveCalibrationStartedAt = extra.adaptiveCalibrationStartedAt as string | null;
        }
        if (state.profile && (typeof extra.lastTargetChangedAt === "string" || extra.lastTargetChangedAt === null)) {
          state.profile.lastTargetChangedAt = extra.lastTargetChangedAt as string | null;
        }
      }
    }

    // water_log: Record<date, ml>
    state.waterLog = Object.fromEntries(
      (waterRes.data ?? []).map((row) => [row.log_date as string, Number(row.ml)])
    );

    // weight_log: serie temporal ordenada
    if ((weightRes.data ?? []).length > 0) {
      state.weightLog = (weightRes.data ?? []).map((row) => ({
        date: row.log_date as string,
        kg:   Number(row.kg),
      }));
    }

    // Propuesta de ajuste más reciente: si sigue pendiente, la UI la muestra
    // para aceptar/rechazar; si ya se resolvió, solo guardamos la fecha para
    // el cooldown (no proponer otra vez inmediatamente).
    const proposalRow = proposalRes.data?.[0];
    if (proposalRow && proposalRow.status === "pending") {
      state.pendingAdjustmentProposal = {
        id: proposalRow.id,
        currentTargetKcal: Number(proposalRow.current_target_kcal),
        proposedTargetKcal: Number(proposalRow.proposed_target_kcal),
        deltaKcal: Number(proposalRow.delta_kcal),
        reason: proposalRow.reason,
        status: proposalRow.status,
        createdAt: proposalRow.created_at,
        resolvedAt: proposalRow.resolved_at,
        evidence: (proposalRow.evidence as AdjustmentProposalEvidence | null) ?? undefined,
      };
      state.lastAdjustmentDecisionAt = null;
    } else {
      state.pendingAdjustmentProposal = null;
      state.lastAdjustmentDecisionAt = proposalRow?.resolved_at ? String(proposalRow.resolved_at).slice(0, 10) : null;
    }

    state.inventory = (inventoryRes.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      qty: Number(row.quantity),
      unit: row.unit,
      storage: (almacenNameById[row.almacen_id] ?? "Despensa") as StorageName,
      expires: row.expiry_date ?? today(),
      price: Number(row.price_estimate) || 0,
      kcal: Number(row.kcal_per_100) || 0,
      protein: Number(row.protein_per_100) || 0,
      carbs: row.carbs_per_100 != null ? Number(row.carbs_per_100) : undefined,
      fat: row.fat_per_100 != null ? Number(row.fat_per_100) : undefined,
      salt: row.salt_per_100 != null ? Number(row.salt_per_100) : undefined,
      fiber: row.fiber_per_100 != null ? Number(row.fiber_per_100) : undefined,
      sugars: row.sugars_per_100 != null ? Number(row.sugars_per_100) : undefined,
      unitSize: row.unit_size != null ? Number(row.unit_size) : undefined,
      brand: row.brand ?? undefined,
      imageUrl: row.image_url ?? undefined,
      allergenTags: row.allergen_tags ?? undefined,
    }));

    state.cart = (cartRes.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      qty: Number(row.quantity),
      unit: row.unit,
      price: Number(row.estimated_price) || 0,
      store: row.store ?? "Mercadona",
      checked: row.checked,
      unitSize: row.unit_size != null ? Number(row.unit_size) : undefined,
    }));

    state.expenses = (gastosRes.data ?? []).map((row) => ({
      id: row.id,
      type: Number(row.amount) < 0 ? "income" as const : "expense" as const,
      amount: Math.abs(Number(row.amount)),
      category: row.category,
      description: row.description ?? "",
      date: row.txn_date,
    }));

    state.incomeSources = (ingresosRes.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      amount: Number(row.amount),
      frequency: (row.frequency ?? "monthly") as IncomeFrequency,
      dayOfMonth: row.day_of_month != null ? Number(row.day_of_month) : null,
      active: Boolean(row.active),
    }));

    const goal = goalRes.data?.[0];
    if (goal) {
      state.nutrition = {
        kcal: Number(goal.kcal_target),
        protein: Number(goal.protein_target_g),
        carbs: Number(goal.carbs_target_g),
        fat: Number(goal.fat_target_g),
        mode: GOAL_MODES.includes(goal.mode as GoalMode) ? (goal.mode as GoalMode) : "recomp",
      };
    }

    state.foodLog = (logRes.data ?? []).map((row) => {
      // client_meta trae qty/unit reales y los datos de devolución al inventario.
      // Fallback a las columnas tabulares para entradas antiguas sin client_meta.
      const meta = (row.client_meta ?? {}) as Partial<FoodLogEntry> & { qty?: number | null; unit?: string | null };
      const fallbackTime = row.created_at ? new Date(row.created_at).toTimeString().slice(0, 5) : "12:00";
      const time = meta.time ?? fallbackTime;
      const mealType: MealType = meta.mealType ?? mealTypeFromTime(time);
      const qty = meta.qty !== undefined ? meta.qty : (row.quantity_g != null ? Number(row.quantity_g) : null);
      const unit = meta.unit !== undefined ? meta.unit : (row.quantity_g != null ? "g" : null);
      return {
        id: row.id,
        date: row.log_date,
        time,
        name: row.item_name,
        qty,
        unit,
        kcal: Number(row.kcal) || 0,
        protein: Number(row.protein_g) || 0,
        carbs: Number(row.carbs_g) || 0,
        fat: Number(row.fat_g) || 0,
        source: (["recipe", "inventory", "manual"].includes(row.source) ? row.source : "manual") as
          | "recipe"
          | "inventory"
          | "manual",
        mealType,
        ...(meta.inventoryItemId != null && { inventoryItemId: meta.inventoryItemId }),
        ...(meta.inventorySnapshot != null && { inventorySnapshot: meta.inventorySnapshot }),
        ...(meta.consumedIngredients != null && { consumedIngredients: meta.consumedIngredients }),
      };
    });
    // TODO water_log: ejecutar supabase/schema.sql actualizado (tabla water_log)
    // y añadir aqui el pull/push del agua.

    return state;
  }

  // Push con debounce para no saturar la API en rachas de cambios.
  schedulePush(state: FoodOSState): void {
    if (!this.ready || !this.user) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    // Una edición nueva ya incluye (por ser snapshot completo) lo que un
    // reintento pendiente iba a reenviar — cancelarlo evita un push duplicado.
    if (this.pushRetryTimer) {
      clearTimeout(this.pushRetryTimer);
      this.pushRetryTimer = null;
    }
    // Aviso inmediato: sin esto el indicador se queda en "guardado" hasta que
    // vence el debounce (PUSH_DEBOUNCE_MS) y arranca runPush de verdad — una
    // edición que tarda en confirmarse parecería ya sincronizada.
    this.onStatusChange?.("syncing");
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.runPush(state);
    }, PUSH_DEBOUNCE_MS);
  }

  /** B2 (revisión externa, 2026-08-21 y 2026-08-22): el bug original era
      que pushState() nunca lanzaba en la mayoría de sus escrituras (ver el
      comentario grande sobre pushState), así que el try/catch de aquí
      nunca se disparaba para esos casos y "saved" se marcaba con datos
      perdidos en el servidor. Ya arreglado — pero quedaba una segunda
      carrera, más sutil, en ESTA función: "saved" se emitía en cuanto ESTE
      push individual terminaba bien, sin comprobar si mientras tanto había
      quedado otra escritura pendiente (una edición nueva del usuario en
      pushQueued/pushTimer, o un reintento en pushRetryTimer). Como
      RealtimeHydrationGate libera un refresco en tiempo real diferido en
      cuanto ve "saved" (ver realtime-hydration-gate.ts), ese "saved"
      prematuro podía disparar una hidratación que pisara la edición más
      reciente (aún sin confirmar) con el snapshot ANTERIOR ya persistido.
      Secuencia exacta que esto cierra: push A en curso, llega un evento
      realtime (se difiere), el usuario edita y crea el snapshot B mientras
      A sigue en vuelo (B queda en pushQueued o pushTimer), A termina bien
      — ese éxito de A NO debe soltar el refresco diferido, porque B sigue
      sin confirmar; solo cuando B (el ÚLTIMO snapshot) termina bien Y no
      queda nada más pendiente se emite "saved" de verdad.
      "saved" pasa a significar "el último snapshot programado está
      confirmado y no queda ninguna escritura pendiente", no "este push
      concreto terminó". */
  private async runPush(state: FoodOSState): Promise<void> {
    if (this.pushing) {
      this.pushQueued = state;
      return;
    }
    this.pushing = true;
    this.onStatusChange?.("syncing");
    let succeeded = false;
    try {
      await this.pushState(state);
      succeeded = true; // se registra aquí; el "saved" real se decide en el finally (ver arriba)
    } catch (error) {
      console.warn("FoodOS: fallo al sincronizar con Supabase", error);
      this.notifyPushError(error);
      this.onStatusChange?.("error");
      // Reintenta este mismo guardado tras una pausa, salvo que ya haya una
      // edición más reciente en camino (esa ya lo incluye, al ser snapshot completo).
      this.pushRetryTimer = setTimeout(() => {
        this.pushRetryTimer = null;
        if (!this.pushQueued && !this.pushTimer) void this.runPush(state);
      }, PUSH_RETRY_MS);
    } finally {
      this.pushing = false;
      if (this.pushQueued) {
        // Hay una edición más reciente esperando: se encadena sin emitir
        // "saved" todavía — ese snapshot (state, el que acaba de terminar)
        // ya está obsoleto frente a `queued`.
        const queued = this.pushQueued;
        this.pushQueued = null;
        this.schedulePush(queued);
      } else if (succeeded && !this.pushTimer && !this.pushRetryTimer) {
        // Nada más pendiente: este SÍ era el último snapshot, y tuvo éxito.
        this.onStatusChange?.("saved");
      }
    }
  }

  /** Throttlea los avisos de error de sync: en una caída prolongada, los
      reintentos no deben generar un toast nuevo cada vez. */
  private notifyPushError(error: unknown): void {
    if (!this.onPushError) return;
    const now = Date.now();
    if (now - this.lastPushErrorNotifiedAt < PUSH_ERROR_NOTIFY_THROTTLE_MS) return;
    this.lastPushErrorNotifiedAt = now;
    this.onPushError(error);
  }

  /**
   * Sincroniza el snapshot completo del estado local con Supabase.
   *
   * Fail-closed frente a errores de escritura (B2, revisión externa,
   * 2026-08-21): antes, NINGUNA de las llamadas de este método comprobaba
   * `{ error }` en la respuesta de Supabase-js — salvo el upsert dentro de
   * syncTable(), que sí lanzaba. Supabase-js NO lanza excepciones en
   * fallos de escritura (permiso denegado por RLS, columna inválida,
   * violación de constraint...): los reporta como `{ data: null, error }`
   * con la promesa resuelta igualmente. Sin comprobar ese campo, un
   * pushState() que fallara a medias (p.ej. el perfil no se pudo guardar
   * por RLS, pero el resto de tablas sí) terminaba SIN lanzar, así que
   * runPush() lo trataba como éxito total: onStatusChange?.("saved") y el
   * indicador de la UI decía "guardado" con el perfil realmente perdido en
   * el servidor.
   *
   * Cada escritura relevante (perfil, pesos + su borrado, objetivos
   * nutricionales, y cada syncTable) se intenta con mejor esfuerzo — un
   * fallo en una no impide intentar las demás, porque son tablas
   * independientes sin relación entre sí. Los fallos se acumulan y, si hay
   * alguno, se lanza al final UN error agregado: eso es lo que hace que
   * runPush() (que si envuelve pushState en try/catch) NO marque
   * onStatusChange?.("saved") y programe un reintento (ver runPush más
   * abajo). El reintento reenvía el MISMO snapshot completo: como cada
   * operación es upsert (onConflict) + delete del complemento, repetir una
   * escritura que ya tuvo éxito es un no-op idempotente — no duplica filas
   * ni pierde las que sí se guardaron a la primera. Solo lo que de verdad
   * falló necesita reintentarse, y reintentarlo junto con lo que ya
   * funcionó no tiene coste de corrección, solo un poco de red de más.
   */
  async pushState(state: FoodOSState): Promise<void> {
    const client = this.client!;
    const userId = this.user!.id;
    const failures: string[] = [];

    // upsert(onConflict: "user_id"), NO update().eq("user_id", userId) (B2,
    // revisión externa, 2026-08-22): un UPDATE que no encuentra ninguna fila
    // que coincida (RLS que filtra la fila sin marcarlo como error, o la
    // fila base todavía no existe pese a ensureBaseRows()) devuelve
    // { error: null } de todos modos — "éxito" con CERO filas afectadas.
    // pushState() daría el perfil por guardado sin haberse escrito nada. Un
    // upsert con la fila garantiza que, si no existía, se crea; si existía,
    // se actualiza — no hay ningún resultado silencioso de "no hice nada".
    const { error: profileError } = await client
      .from("user_profiles")
      .upsert({
        user_id: userId,
        mascot_id: state.mascotId,
        weekly_food_budget: state.weeklyBudget,
        extra_state: {
          routines:          state.routines          ?? [],
          workoutLog:        state.workoutLog        ?? [],
          recurringExpenses: state.recurringExpenses ?? [],
          customRecipes:     state.customRecipes     ?? [],
          savedRecipeIds:    state.savedRecipeIds    ?? [],
          dismissedSuggestions: state.dismissedSuggestions ?? [],
          mealPlan:          state.mealPlan          ?? {},
          plannerQuickMeals: state.plannerQuickMeals ?? [],
          categoryBudgets:   state.categoryBudgets   ?? {},
          settings:          state.settings,
          savingsGoalPct:    state.savingsGoalPct    ?? 20,
          bankSynced:        state.bankSynced        ?? false,
          recipeTag:         state.recipeTag         ?? "todos",
          macroPreference:   state.macroPreference    ?? "balanced",
          debugDate:         state.debugDate         ?? null,
          stepsLog:          state.stepsLog          ?? {},
          trainingActivity:  state.profile?.trainingActivity ?? null,
          adaptiveKcalOffsetKcal: state.profile?.adaptiveKcalOffsetKcal ?? 0,
          adaptiveCalibrationStartedAt: state.profile?.adaptiveCalibrationStartedAt ?? null,
          lastTargetChangedAt: state.profile?.lastTargetChangedAt ?? null,
        },
        ...(state.profile
          ? {
              age: state.profile.age,
              sex: state.profile.sex,
              height_cm: state.profile.heightCm,
              weight_kg: state.profile.weightKg,
              body_fat_pct: state.profile.bodyFatPct,
              body_fat_source: state.profile.bodyFatSource ?? null,
              activity_level: state.profile.activityLevel,
              goal: state.profile.goal,
              gym_days: state.profile.gymDays,
              allergies: state.profile.allergies,
              excluded_foods: state.profile.excludedFoods,
              target_weight_kg: state.profile.targetWeightKg ?? null,
              experience_level: state.profile.experienceLevel ?? null,
              equipment_access: state.profile.equipmentAccess ?? null,
              activity_model_version: state.profile.activityModelVersion ?? "legacy_total_pal",
              onboarding_completed: true,
            }
          : {}),
      }, { onConflict: "user_id" });
    if (profileError) failures.push(`perfil: ${profileError.message}`);

    // water_log: se gestiona exclusivamente via fn_water_increment (RPC atómica).
    // No se incluye en el push completo para evitar conflictos de concurrencia entre tabs.

    // weight_log: upsert de lo que hay + borrado de lo que ya no está. El
    // chequeo de borrado corre SIEMPRE, incluso si el estado local se quedó
    // sin ninguna entrada — antes el bloque entero se saltaba cuando
    // weightLog estaba vacío, así que borrar la ÚLTIMA entrada de peso local
    // nunca se propagaba: la fila quedaba huérfana en remoto para siempre.
    // Si el upsert falla, se salta el borrado de esta pasada — sin saber qué
    // filas llegaron a persistirse de verdad, borrar por diferencia podría
    // eliminar datos válidos; el reintento completo (mismo snapshot) lo
    // resuelve limpiamente en el siguiente intento.
    {
      const weightRows = (state.weightLog ?? []).map((e) => ({ user_id: userId, log_date: e.date, kg: e.kg }));
      let weightUpsertOk = true;
      if (weightRows.length > 0) {
        const { error: weightUpsertError } = await client.from("weight_log").upsert(weightRows, { onConflict: "user_id,log_date" });
        if (weightUpsertError) {
          failures.push(`peso (guardado): ${weightUpsertError.message}`);
          weightUpsertOk = false;
        }
      }
      if (weightUpsertOk) {
        const { data: existingWeights, error: weightSelectError } = await client.from("weight_log").select("log_date").eq("user_id", userId);
        if (weightSelectError) {
          failures.push(`peso (lectura para borrado): ${weightSelectError.message}`);
        } else {
          const keepDates = new Set(weightRows.map((r) => r.log_date));
          const toDeleteDates = (existingWeights ?? []).map((r) => r.log_date as string).filter((d) => !keepDates.has(d));
          if (toDeleteDates.length) {
            const { error: weightDeleteError } = await client.from("weight_log").delete().eq("user_id", userId).in("log_date", toDeleteDates);
            if (weightDeleteError) failures.push(`peso (borrado): ${weightDeleteError.message}`);
          }
        }
      }
    }

    const { error: goalError } = await client.from("nutrition_goals").upsert(
      {
        user_id: userId,
        goal_date: state.debugDate ?? today(),
        kcal_target: state.nutrition.kcal,
        protein_target_g: state.nutrition.protein,
        carbs_target_g: state.nutrition.carbs,
        fat_target_g: state.nutrition.fat,
        mode: state.nutrition.mode,
      },
      { onConflict: "user_id,goal_date" }
    );
    if (goalError) failures.push(`objetivos nutricionales: ${goalError.message}`);

    // Cada syncTable() es independiente de las demás (tablas sin relación
    // entre sí) — un fallo en una no impide intentar el resto; se recoge el
    // error para el agregado final en vez de dejar que aborte todo pushState.
    await this.trySyncTable(failures, "inventario", () =>
      this.syncTable(
        "inventory_items",
        state.inventory,
        (item) => ({
          id: ensureUuid(item.id),
          owner_id: userId,
          almacen_id: this.almacenIdByName[item.storage] ?? this.almacenIdByName.Despensa,
          name: item.name,
          quantity: item.qty,
          unit: item.unit,
          expiry_date: item.expires || null,
          price_estimate: item.price || null,
          kcal_per_100: item.kcal || null,
          protein_per_100: item.protein || null,
          carbs_per_100: item.carbs ?? null,
          fat_per_100: item.fat ?? null,
          salt_per_100: item.salt ?? null,
          fiber_per_100: item.fiber ?? null,
          sugars_per_100: item.sugars ?? null,
          unit_size: item.unitSize ?? null,
          brand: item.brand ?? null,
          image_url: item.imageUrl ?? null,
          allergen_tags: item.allergenTags ?? null,
        }),
        { owner_id: userId }
      )
    );

    await this.trySyncTable(failures, "carrito", () =>
      this.syncTable(
        "shopping_items",
        state.cart,
        (item) => ({
          id: ensureUuid(item.id),
          list_id: this.shoppingListId,
          user_id: userId,
          name: item.name,
          quantity: item.qty,
          unit: item.unit,
          estimated_price: item.price || null,
          store: item.store || null,
          checked: Boolean(item.checked),
          unit_size: item.unitSize ?? null,
        }),
        { user_id: userId, list_id: this.shoppingListId! }
      )
    );

    await this.trySyncTable(failures, "gastos", () =>
      this.syncTable(
        "gastos",
        state.expenses,
        (entry) => ({
          id: ensureUuid(entry.id),
          user_id: userId,
          amount: entry.type === "income" ? -Math.abs(entry.amount) : Math.abs(entry.amount),
          description: entry.description || null,
          category: entry.category,
          txn_date: entry.date || today(),
        }),
        { user_id: userId }
      )
    );

    await this.trySyncTable(failures, "ingresos", () =>
      this.syncTable(
        "ingresos_fuentes",
        state.incomeSources,
        (source) => ({
          id: ensureUuid(source.id),
          user_id: userId,
          name: source.name,
          amount: source.amount,
          frequency: source.frequency,
          day_of_month: source.dayOfMonth,
          active: source.active,
        }),
        { user_id: userId }
      )
    );

    await this.trySyncTable(failures, "diario", () =>
      this.syncTable(
        "food_log",
        state.foodLog,
        (entry) => ({
          id: ensureUuid(entry.id),
          user_id: userId,
          log_date: entry.date,
          item_name: entry.name,
          quantity_g: entry.unit === "g" || entry.unit === "ml" ? entry.qty : null,
          kcal: entry.kcal,
          protein_g: entry.protein,
          carbs_g: entry.carbs,
          fat_g: entry.fat,
          source: entry.source,
          // Metadata no tabular: qty/unit reales (para "ud"), hora, y los datos que
          // permiten devolver al inventario al borrar (item origen o ingredientes).
          client_meta: {
            qty: entry.qty,
            unit: entry.unit,
            time: entry.time,
            mealType: entry.mealType,
            ...(entry.inventoryItemId != null && { inventoryItemId: entry.inventoryItemId }),
            ...(entry.inventorySnapshot != null && { inventorySnapshot: entry.inventorySnapshot }),
            ...(entry.consumedIngredients != null && { consumedIngredients: entry.consumedIngredients }),
          },
        }),
        { user_id: userId }
      )
    );

    // Fail-closed: si CUALQUIER escritura falló, se lanza aquí — esto es lo
    // que hace que runPush() (ver más abajo) NO marque onStatusChange?.("saved")
    // y programe un reintento con el mismo snapshot en vez de darlo por bueno.
    if (failures.length > 0) {
      throw new Error(`pushState: fallo(s) sincronizando — ${failures.join(" | ")}`);
    }
  }

  /** Ejecuta un syncTable() capturando su error (si lo lanza) en `failures`
      en vez de dejar que se propague — así el resto de tablas de pushState
      se siguen intentando aunque esta falle (ver el comentario grande de
      pushState). */
  private async trySyncTable(failures: string[], label: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      failures.push(`${label}: ${errorMessage(err)}`);
    }
  }

  // Upsert de filas actuales + delete de las que desaparecieron del estado.
  private async syncTable<T extends { id: string }>(
    table: string,
    items: T[],
    toRow: (item: T) => Record<string, unknown> & { id: string },
    ownershipFilter: Record<string, string>
  ): Promise<void> {
    const client = this.client!;
    const rows = items.map(toRow);
    // Reasigna ids no-uuid (estado antiguo) de forma estable en esta pasada.
    items.forEach((item, index) => {
      item.id = rows[index].id;
    });

    if (rows.length) {
      const { error } = await client.from(table).upsert(rows, { onConflict: "id" });
      if (error) throw error;
    }

    // El chequeo de borrado (lectura de ids existentes + delete del
    // complemento) también tiene que lanzar en error — antes ninguno de los
    // dos se comprobaba, así que un fallo aquí dejaba filas borradas
    // localmente pero nunca borradas en remoto, y pushState() lo daba por
    // sincronizado igualmente (B2, revisión externa 2026-08-21). Si la
    // LECTURA falla no sabemos qué ids existen de verdad en remoto — lanzar
    // aquí y no intentar el delete evita borrar de más con un `existing`
    // incompleto o vacío por error.
    let query = client.from(table).select("id");
    for (const [column, value] of Object.entries(ownershipFilter)) {
      query = query.eq(column, value);
    }
    const { data: existing, error: selectError } = await query;
    if (selectError) throw selectError;
    const keep = new Set(rows.map((row) => row.id));
    const toDelete = (existing ?? []).map((row) => row.id).filter((id) => !keep.has(id));
    if (toDelete.length) {
      const { error: deleteError } = await client.from(table).delete().in("id", toDelete);
      if (deleteError) throw deleteError;
    }
  }
}

export const remote = new RemoteAdapter();
