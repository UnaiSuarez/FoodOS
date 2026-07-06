import type {
  ActivityLevel,
  FoodLogEntry,
  FoodOSState,
  GoalMode,
  IncomeFrequency,
  MealType,
  PhysicalProfile,
  Sex,
  StorageName,
} from "@foodos/types";
import type { SupabaseClient, User } from "@supabase/supabase-js";
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

const STORAGE_TYPE_BY_NAME: Record<StorageName, string> = {
  Nevera: "fridge",
  Congelador: "freezer",
  Despensa: "pantry",
};

const GOAL_MODES: GoalMode[] = ["fat_loss", "muscle_gain", "recomp", "maintain"];

function today(): string {
  return todayPlus(0);
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
  private pushing = false;
  private pushQueued: FoodOSState | null = null;

  get ready(): boolean {
    return this.client !== null;
  }

  /** true si hay un guardado local programado, en curso, o en cola de reintento.
      Se usa para que un refresco en tiempo real no pise con datos desactualizados
      un cambio local que aún no ha llegado al servidor (condición de carrera). */
  hasPendingPush(): boolean {
    return this.pushTimer !== null || this.pushing || this.pushQueued !== null;
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

    await client.from("user_profiles").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });

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

    const [profileRes, inventoryRes, cartRes, gastosRes, ingresosRes, goalRes, logRes, feedRes, waterRes, weightRes] = await Promise.all([
      client
        .from("user_profiles")
        .select(
          "mascot_id, weekly_food_budget, age, sex, height_cm, weight_kg, body_fat_pct, activity_level, goal, gym_days, allergies, excluded_foods, target_weight_kg, experience_level, equipment_access, extra_state"
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
        .from("feed_posts")
        .select("id, title, body, recipe_id, likes_count, user_id, feed_comments(body, user_id)")
        .eq("visibility", "public")
        .order("created_at", { ascending: true }),
      client
        .from("water_log")
        .select("log_date, ml")
        .eq("user_id", userId),
      client
        .from("weight_log")
        .select("log_date, kg")
        .eq("user_id", userId)
        .order("log_date", { ascending: true }),
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
      ["feed", feedRes],
      ["agua", waterRes],
      ["peso", weightRes],
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
          activityLevel: p.activity_level as ActivityLevel,
          goal: GOAL_MODES.includes(p.goal as GoalMode) ? (p.goal as GoalMode) : "maintain",
          gymDays: p.gym_days ?? [],
          allergies: p.allergies ?? [],
          excludedFoods: p.excluded_foods ?? [],
          targetWeightKg: p.target_weight_kg != null ? Number(p.target_weight_kg) : undefined,
          experienceLevel: (p.experience_level as PhysicalProfile["experienceLevel"]) ?? undefined,
          equipmentAccess: (p.equipment_access as PhysicalProfile["equipmentAccess"]) ?? undefined,
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
        if (typeof extra.debugDate === "string" || extra.debugDate === null) state.debugDate = extra.debugDate as string | null;
        if (extra.stepsLog && typeof extra.stepsLog === "object") state.stepsLog = extra.stepsLog as typeof state.stepsLog;
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

    state.feedPosts = (feedRes.data ?? []).map((row) => ({
      id: row.id,
      recipeId: row.recipe_id,
      author: row.user_id === userId ? "tu" : "comunidad",
      title: row.title ?? "Receta compartida",
      caption: row.body ?? "",
      likes: row.likes_count,
      comments: (row.feed_comments ?? []).map((comment: { body: string; user_id: string }) => ({
        author: comment.user_id === userId ? "Tú" : "Usuario",
        text: comment.body,
      })),
    }));

    return state;
  }

  // Push con debounce para no saturar la API en rachas de cambios.
  schedulePush(state: FoodOSState): void {
    if (!this.ready || !this.user) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.runPush(state);
    }, PUSH_DEBOUNCE_MS);
  }

  private async runPush(state: FoodOSState): Promise<void> {
    if (this.pushing) {
      this.pushQueued = state;
      return;
    }
    this.pushing = true;
    try {
      await this.pushState(state);
    } catch (error) {
      console.warn("FoodOS: fallo al sincronizar con Supabase", error);
    } finally {
      this.pushing = false;
      if (this.pushQueued) {
        const queued = this.pushQueued;
        this.pushQueued = null;
        this.schedulePush(queued);
      }
    }
  }

  async pushState(state: FoodOSState): Promise<void> {
    const client = this.client!;
    const userId = this.user!.id;

    await client
      .from("user_profiles")
      .update({
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
          debugDate:         state.debugDate         ?? null,
          stepsLog:          state.stepsLog          ?? {},
        },
        ...(state.profile
          ? {
              age: state.profile.age,
              sex: state.profile.sex,
              height_cm: state.profile.heightCm,
              weight_kg: state.profile.weightKg,
              body_fat_pct: state.profile.bodyFatPct,
              activity_level: state.profile.activityLevel,
              goal: state.profile.goal,
              gym_days: state.profile.gymDays,
              allergies: state.profile.allergies,
              excluded_foods: state.profile.excludedFoods,
              target_weight_kg: state.profile.targetWeightKg ?? null,
              experience_level: state.profile.experienceLevel ?? null,
              equipment_access: state.profile.equipmentAccess ?? null,
              onboarding_completed: true,
            }
          : {}),
      })
      .eq("user_id", userId);

    // water_log: se gestiona exclusivamente via fn_water_increment (RPC atómica).
    // No se incluye en el push completo para evitar conflictos de concurrencia entre tabs.

    // weight_log: upsert + delete de entradas borradas
    if ((state.weightLog ?? []).length > 0) {
      const weightRows = state.weightLog.map((e) => ({ user_id: userId, log_date: e.date, kg: e.kg }));
      await client.from("weight_log").upsert(weightRows, { onConflict: "user_id,log_date" });
      // Borrar entradas que ya no están en el estado
      const { data: existingWeights } = await client.from("weight_log").select("log_date").eq("user_id", userId);
      const keepDates = new Set(state.weightLog.map((e) => e.date));
      const toDeleteDates = (existingWeights ?? []).map((r) => r.log_date).filter((d) => !keepDates.has(d as string));
      if (toDeleteDates.length) {
        await client.from("weight_log").delete().eq("user_id", userId).in("log_date", toDeleteDates);
      }
    }

    await client.from("nutrition_goals").upsert(
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

    await this.syncTable(
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
    );

    await this.syncTable(
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
    );

    await this.syncTable(
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
    );

    await this.syncTable(
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
    );

    await this.syncTable(
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
    );

    // TODO feed: publicar posts propios requiere sembrar antes la tabla
    // `recipes` con las recetas demo. Ver README.
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

    let query = client.from(table).select("id");
    for (const [column, value] of Object.entries(ownershipFilter)) {
      query = query.eq(column, value);
    }
    const { data: existing } = await query;
    const keep = new Set(rows.map((row) => row.id));
    const toDelete = (existing ?? []).map((row) => row.id).filter((id) => !keep.has(id));
    if (toDelete.length) {
      await client.from(table).delete().in("id", toDelete);
    }
  }
}

export const remote = new RemoteAdapter();
