import type { FoodOSState, NutritionMode, StorageName } from "@foodos/types";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import { ensureUuid } from "./utils";

// Capa de persistencia de FoodOS.
// - Local: localStorage, siempre activa.
// - Remota: Supabase (supabase/schema.sql). Se activa con .env.local y sesion.
//   pull = reconstruye el estado desde las tablas; push = sincroniza con
//   estrategia naive de MVP (upsert + delete de lo ausente), suficiente para
//   un usuario. Para multiusuario: pasar a mutaciones por accion.

const LOCAL_KEY = "foodos-appweb-state-v1";
const PUSH_DEBOUNCE_MS = 1800;

const STORAGE_TYPE_BY_NAME: Record<StorageName, string> = {
  Nevera: "fridge",
  Congelador: "freezer",
  Despensa: "pantry",
};

const GOAL_MODE_TO_DB: Record<NutritionMode, string> = {
  Recomposicion: "recomp",
  "Perdida de grasa": "fat_loss",
  "Ganancia muscular": "muscle_gain",
  Mantenimiento: "maintain",
};
const GOAL_MODE_FROM_DB = Object.fromEntries(
  Object.entries(GOAL_MODE_TO_DB).map(([label, db]) => [db, label])
) as Record<string, NutritionMode>;

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

  signInWithMagicLink(email: string) {
    return this.client!.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href },
    });
  }

  async signOut() {
    this.user = null;
    return this.client!.auth.signOut();
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

    const [profileRes, inventoryRes, cartRes, gastosRes, ingresosRes, goalRes, logRes, feedRes] = await Promise.all([
      client.from("user_profiles").select("mascot_id, weekly_food_budget").eq("user_id", userId).maybeSingle(),
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
      client.from("ingresos_fuentes").select("id, name, amount").eq("user_id", userId).eq("active", true),
      client
        .from("nutrition_goals")
        .select("kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode")
        .eq("user_id", userId)
        .order("goal_date", { ascending: false })
        .limit(1),
      client
        .from("food_log")
        .select("id, item_name, kcal, protein_g, carbs_g, fat_g")
        .eq("user_id", userId)
        .eq("log_date", today()),
      client
        .from("feed_posts")
        .select("id, title, body, recipe_id, likes_count, user_id, feed_comments(body, user_id)")
        .eq("visibility", "public")
        .order("created_at", { ascending: true }),
    ]);

    const almacenNameById = Object.fromEntries(
      Object.entries(this.almacenIdByName).map(([name, id]) => [id, name])
    );

    if (profileRes.data) {
      state.mascotId = profileRes.data.mascot_id ?? state.mascotId;
      state.weeklyBudget = Number(profileRes.data.weekly_food_budget) || state.weeklyBudget;
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

    state.expenses = [
      ...(ingresosRes.data ?? []).map((row) => ({
        id: row.id,
        type: "income" as const,
        amount: Number(row.amount),
        category: "Ahorro",
        description: row.name,
        date: today(),
      })),
      ...(gastosRes.data ?? []).map((row) => ({
        id: row.id,
        type: "expense" as const,
        amount: Number(row.amount),
        category: row.category,
        description: row.description ?? "",
        date: row.txn_date,
      })),
    ];

    const goal = goalRes.data?.[0];
    if (goal) {
      state.nutrition = {
        kcal: Number(goal.kcal_target),
        protein: Number(goal.protein_target_g),
        carbs: Number(goal.carbs_target_g),
        fat: Number(goal.fat_target_g),
        mode: GOAL_MODE_FROM_DB[goal.mode] ?? "Recomposicion",
      };
    }

    state.consumedMeals = (logRes.data ?? []).map((row) => ({
      id: row.id,
      icon: "🍽",
      name: row.item_name,
      kcal: Number(row.kcal) || 0,
      protein: Number(row.protein_g) || 0,
      carbs: Number(row.carbs_g) || 0,
      fat: Number(row.fat_g) || 0,
    }));
    state.consumed = state.consumedMeals.reduce(
      (totals, meal) => ({
        kcal: totals.kcal + meal.kcal,
        protein: totals.protein + meal.protein,
        carbs: totals.carbs + meal.carbs,
        fat: totals.fat + meal.fat,
      }),
      { kcal: 0, protein: 0, carbs: 0, fat: 0 }
    );

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
      .update({ mascot_id: state.mascotId, weekly_food_budget: state.weeklyBudget })
      .eq("user_id", userId);

    await client.from("nutrition_goals").upsert(
      {
        user_id: userId,
        goal_date: today(),
        kcal_target: state.nutrition.kcal,
        protein_target_g: state.nutrition.protein,
        carbs_target_g: state.nutrition.carbs,
        fat_target_g: state.nutrition.fat,
        mode: GOAL_MODE_TO_DB[state.nutrition.mode] ?? "recomp",
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
      state.expenses.filter((entry) => entry.type === "income"),
      (entry) => ({
        id: ensureUuid(entry.id),
        user_id: userId,
        name: entry.description || entry.category || "Ingreso",
        amount: entry.amount,
        frequency: "monthly",
      }),
      { user_id: userId }
    );

    // food_log de hoy: se reescribe entero (los logs historicos no se tocan).
    await client.from("food_log").delete().eq("user_id", userId).eq("log_date", today());
    if (state.consumedMeals.length) {
      await client.from("food_log").insert(
        state.consumedMeals.map((meal) => ({
          id: ensureUuid(meal.id),
          user_id: userId,
          log_date: today(),
          item_name: meal.name,
          kcal: meal.kcal,
          protein_g: meal.protein,
          carbs_g: meal.carbs,
          fat_g: meal.fat,
          source: "recipe",
        }))
      );
    }

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
