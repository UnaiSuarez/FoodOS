import type {
  ActivityLevel,
  FoodOSState,
  GoalMode,
  IncomeFrequency,
  MealType,
  Sex,
  StorageName,
} from "@foodos/types";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import { ensureUuid, mealTypeFromTime } from "./utils";

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
  return new Date().toISOString().slice(0, 10);
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
  localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
}

export function clearLocalState(): void {
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
    return this.client!.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
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
      options: { emailRedirectTo: window.location.href },
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

    const [profileRes, inventoryRes, cartRes, gastosRes, ingresosRes, goalRes, logRes, feedRes, waterRes, weightRes] = await Promise.all([
      client
        .from("user_profiles")
        .select(
          "mascot_id, weekly_food_budget, age, sex, height_cm, weight_kg, body_fat_pct, activity_level, goal, gym_days, allergies, excluded_foods, target_weight_kg, extra_state"
        )
        .eq("user_id", userId)
        .maybeSingle(),
      client
        .from("inventory_items")
        .select("id, name, quantity, unit, expiry_date, price_estimate, kcal_per_100, protein_per_100, almacen_id")
        .eq("owner_id", userId),
      client
        .from("shopping_items")
        .select("id, name, quantity, unit, estimated_price, store, checked")
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
        .select("id, log_date, created_at, item_name, quantity_g, kcal, protein_g, carbs_g, fat_g, source")
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
        };
      }
      // extra_state: campos de app no tabulados (routines, workoutLog, etc.)
      const extra = p.extra_state as Record<string, unknown> | null;
      if (extra) {
        if (Array.isArray(extra.routines))         state.routines         = extra.routines;
        if (Array.isArray(extra.workoutLog))       state.workoutLog       = extra.workoutLog;
        if (Array.isArray(extra.customRecipes))    state.customRecipes    = extra.customRecipes;
        if (extra.mealPlan && typeof extra.mealPlan === "object") state.mealPlan = extra.mealPlan as typeof state.mealPlan;
        if (Array.isArray(extra.plannerQuickMeals)) state.plannerQuickMeals = extra.plannerQuickMeals;
        if (extra.categoryBudgets && typeof extra.categoryBudgets === "object") state.categoryBudgets = extra.categoryBudgets as typeof state.categoryBudgets;
        if (typeof extra.savingsGoalPct === "number") state.savingsGoalPct = extra.savingsGoalPct;
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
    }));

    state.cart = (cartRes.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      qty: Number(row.quantity),
      unit: row.unit,
      price: Number(row.estimated_price) || 0,
      store: row.store ?? "Mercadona",
      checked: row.checked,
    }));

    state.expenses = (gastosRes.data ?? []).map((row) => ({
      id: row.id,
      type: "expense" as const,
      amount: Number(row.amount),
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
      const time = row.created_at ? new Date(row.created_at).toTimeString().slice(0, 5) : "12:00";
      // meal_type columna pendiente de añadir al schema; mientras, se infiere de la hora.
      const mealType: MealType = mealTypeFromTime(time);
      return {
        id: row.id,
        date: row.log_date,
        time,
        name: row.item_name,
        qty: row.quantity_g != null ? Number(row.quantity_g) : null,
        unit: row.quantity_g != null ? "g" : null,
        kcal: Number(row.kcal) || 0,
        protein: Number(row.protein_g) || 0,
        carbs: Number(row.carbs_g) || 0,
        fat: Number(row.fat_g) || 0,
        source: (["recipe", "inventory", "manual"].includes(row.source) ? row.source : "manual") as
          | "recipe"
          | "inventory"
          | "manual",
        mealType,
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
    this.pushTimer = setTimeout(() => void this.runPush(state), PUSH_DEBOUNCE_MS);
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
          customRecipes:     state.customRecipes     ?? [],
          mealPlan:          state.mealPlan          ?? {},
          plannerQuickMeals: state.plannerQuickMeals ?? [],
          categoryBudgets:   state.categoryBudgets   ?? {},
          savingsGoalPct:    state.savingsGoalPct    ?? 20,
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
        goal_date: today(),
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
      }),
      { user_id: userId, list_id: this.shoppingListId! }
    );

    await this.syncTable(
      "gastos",
      state.expenses.filter((entry) => entry.type === "expense"),
      (entry) => ({
        id: ensureUuid(entry.id),
        user_id: userId,
        amount: entry.amount,
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
