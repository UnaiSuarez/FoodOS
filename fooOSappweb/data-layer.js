// data-layer.js — Capa de persistencia de FoodOS app web.
//
// Hoy la app guarda todo en localStorage. Este archivo aisla esa decision
// detras de `window.FoodOSData` para que conectar Supabase sea rellenar la
// config, no reescribir la app. El mapeo de tablas sigue `supabase/schema.sql`
// y `docs/data-model.md`.
//
// Modo local  : siempre activo. `loadLocal()` / `persist(state)`.
// Modo remoto : se activa solo si existen window.supabase (CDN) y
//               window.FOODOS_SUPABASE (supabase-config.js). Ver README.

(function () {
  const LOCAL_KEY = "foodos-appweb-state-v1";
  const PUSH_DEBOUNCE_MS = 1800;

  // ---------- Mapeos mock <-> schema.sql ----------

  const STORAGE_TYPE_BY_NAME = { Nevera: "fridge", Congelador: "freezer", Despensa: "pantry" };
  const STORAGE_NAME_BY_TYPE = { fridge: "Nevera", freezer: "Congelador", pantry: "Despensa" };

  const GOAL_MODE_TO_DB = {
    Recomposicion: "recomp",
    "Perdida de grasa": "fat_loss",
    "Ganancia muscular": "muscle_gain",
    Mantenimiento: "maintain",
  };
  const GOAL_MODE_FROM_DB = Object.fromEntries(
    Object.entries(GOAL_MODE_TO_DB).map(([label, db]) => [db, label])
  );

  function isUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  function ensureUuid(value) {
    return isUuid(value) ? value : crypto.randomUUID();
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  // ---------- Adaptador local (localStorage) ----------

  const local = {
    load(defaults) {
      try {
        const stored = JSON.parse(localStorage.getItem(LOCAL_KEY));
        return stored ? { ...structuredClone(defaults), ...stored } : structuredClone(defaults);
      } catch {
        return structuredClone(defaults);
      }
    },
    save(state) {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
    },
    clear() {
      localStorage.removeItem(LOCAL_KEY);
    },
  };

  // ---------- Adaptador remoto (Supabase) ----------

  const remote = {
    client: null,
    user: null,
    ready: false,
    almacenIdByName: {},
    shoppingListId: null,

    hasConfig() {
      return Boolean(
        window.supabase &&
        window.FOODOS_SUPABASE &&
        window.FOODOS_SUPABASE.url &&
        !window.FOODOS_SUPABASE.url.includes("TU-PROYECTO") &&
        window.FOODOS_SUPABASE.anonKey &&
        !window.FOODOS_SUPABASE.anonKey.includes("TU_ANON_KEY")
      );
    },

    async init() {
      if (!this.hasConfig()) return false;
      this.client = window.supabase.createClient(window.FOODOS_SUPABASE.url, window.FOODOS_SUPABASE.anonKey);
      const { data } = await this.client.auth.getSession();
      this.user = data.session ? data.session.user : null;
      this.ready = true;
      return true;
    },

    onAuthChange(callback) {
      if (!this.client) return;
      this.client.auth.onAuthStateChange((_event, session) => {
        this.user = session ? session.user : null;
        callback(this.user);
      });
    },

    async signInWithGoogle() {
      return this.client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.href },
      });
    },

    async signInWithMagicLink(email) {
      return this.client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.href },
      });
    },

    async signOut() {
      this.user = null;
      return this.client.auth.signOut();
    },

    // Crea (si faltan) perfil, almacenes base y lista de compra activa,
    // y cachea sus ids para el resto de operaciones.
    async ensureBaseRows() {
      const userId = this.user.id;

      await this.client.from("user_profiles").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });

      const { data: almacenes } = await this.client
        .from("almacenes")
        .select("id, name, type")
        .eq("owner_id", userId);
      const existing = almacenes || [];
      for (const [name, type] of Object.entries(STORAGE_TYPE_BY_NAME)) {
        let row = existing.find((a) => a.type === type);
        if (!row) {
          const { data: created, error } = await this.client
            .from("almacenes")
            .insert({ owner_id: userId, name, type })
            .select("id")
            .single();
          if (error) throw error;
          row = created;
          // El propietario tambien es miembro (lo exige la policy de insert de inventario).
          await this.client.from("almacen_members").upsert(
            { almacen_id: row.id, user_id: userId, role: "owner" },
            { onConflict: "almacen_id,user_id", ignoreDuplicates: true }
          );
        }
        this.almacenIdByName[name] = row.id;
      }

      const { data: lists } = await this.client
        .from("shopping_lists")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "active")
        .limit(1);
      if (lists && lists.length) {
        this.shoppingListId = lists[0].id;
      } else {
        const { data: created, error } = await this.client
          .from("shopping_lists")
          .insert({ user_id: userId, name: "Compra" })
          .select("id")
          .single();
        if (error) throw error;
        this.shoppingListId = created.id;
      }
    },

    // Lee las tablas y devuelve el estado con la misma forma que usa la app.
    async pullState(defaults) {
      const userId = this.user.id;
      const state = structuredClone(defaults);

      const [profileRes, inventoryRes, cartRes, gastosRes, ingresosRes, goalRes, logRes, feedRes] = await Promise.all([
        this.client.from("user_profiles").select("mascot_id, weekly_food_budget").eq("user_id", userId).maybeSingle(),
        this.client.from("inventory_items").select("id, name, quantity, unit, expiry_date, price_estimate, kcal_per_100, protein_per_100, almacen_id").eq("owner_id", userId),
        this.client.from("shopping_items").select("id, name, quantity, unit, estimated_price, store, checked").eq("user_id", userId).eq("list_id", this.shoppingListId),
        this.client.from("gastos").select("id, amount, description, category, txn_date").eq("user_id", userId).order("txn_date", { ascending: true }),
        this.client.from("ingresos_fuentes").select("id, name, amount").eq("user_id", userId).eq("active", true),
        this.client.from("nutrition_goals").select("kcal_target, protein_target_g, carbs_target_g, fat_target_g, mode").eq("user_id", userId).order("goal_date", { ascending: false }).limit(1),
        this.client.from("food_log").select("id, item_name, kcal, protein_g, carbs_g, fat_g").eq("user_id", userId).eq("log_date", today()),
        this.client.from("feed_posts").select("id, title, body, recipe_id, likes_count, user_id, feed_comments(body, user_id)").eq("visibility", "public").order("created_at", { ascending: true }),
      ]);

      const almacenNameById = Object.fromEntries(
        Object.entries(this.almacenIdByName).map(([name, id]) => [id, name])
      );

      if (profileRes.data) {
        state.mascotId = profileRes.data.mascot_id || state.mascotId;
        state.weeklyBudget = Number(profileRes.data.weekly_food_budget) || state.weeklyBudget;
      }

      state.inventory = (inventoryRes.data || []).map((row) => ({
        id: row.id,
        name: row.name,
        qty: Number(row.quantity),
        unit: row.unit,
        storage: almacenNameById[row.almacen_id] || "Despensa",
        expires: row.expiry_date || today(),
        price: Number(row.price_estimate) || 0,
        kcal: Number(row.kcal_per_100) || 0,
        protein: Number(row.protein_per_100) || 0,
      }));

      state.cart = (cartRes.data || []).map((row) => ({
        id: row.id,
        name: row.name,
        qty: Number(row.quantity),
        unit: row.unit,
        price: Number(row.estimated_price) || 0,
        store: row.store || "Mercadona",
        checked: row.checked,
      }));

      state.expenses = [
        ...(ingresosRes.data || []).map((row) => ({
          id: row.id,
          type: "income",
          amount: Number(row.amount),
          category: "Ahorro",
          description: row.name,
          date: today(),
        })),
        ...(gastosRes.data || []).map((row) => ({
          id: row.id,
          type: "expense",
          amount: Number(row.amount),
          category: row.category,
          description: row.description || "",
          date: row.txn_date,
        })),
      ];

      if (goalRes.data && goalRes.data.length) {
        const goal = goalRes.data[0];
        state.nutrition = {
          kcal: Number(goal.kcal_target),
          protein: Number(goal.protein_target_g),
          carbs: Number(goal.carbs_target_g),
          fat: Number(goal.fat_target_g),
          mode: GOAL_MODE_FROM_DB[goal.mode] || "Recomposicion",
        };
      }

      state.consumedMeals = (logRes.data || []).map((row) => ({
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

      state.feedPosts = (feedRes.data || []).map((row) => ({
        id: row.id,
        recipeId: row.recipe_id,
        author: row.user_id === userId ? "tu" : "comunidad",
        title: row.title || "Receta compartida",
        caption: row.body || "",
        likes: row.likes_count,
        comments: (row.feed_comments || []).map((comment) => ({
          author: comment.user_id === userId ? "Tú" : "Usuario",
          text: comment.body,
        })),
      }));

      return state;
    },

    // Sincroniza el estado completo del usuario (estrategia naive de MVP:
    // upsert de todo + borrado de lo que ya no existe). Suficiente para un
    // solo dispositivo; con multiusuario habria que pasar a mutaciones
    // por accion (TODO documentado en README).
    async pushState(state) {
      const userId = this.user.id;

      await this.client
        .from("user_profiles")
        .update({ mascot_id: state.mascotId, weekly_food_budget: state.weeklyBudget })
        .eq("user_id", userId);

      await this.client.from("nutrition_goals").upsert(
        {
          user_id: userId,
          goal_date: today(),
          kcal_target: state.nutrition.kcal,
          protein_target_g: state.nutrition.protein,
          carbs_target_g: state.nutrition.carbs,
          fat_target_g: state.nutrition.fat,
          mode: GOAL_MODE_TO_DB[state.nutrition.mode] || "recomp",
        },
        { onConflict: "user_id,goal_date" }
      );

      await this.syncTable("inventory_items", state.inventory, (item) => ({
        id: ensureUuid(item.id),
        owner_id: userId,
        almacen_id: this.almacenIdByName[item.storage] || this.almacenIdByName.Despensa,
        name: item.name,
        quantity: item.qty,
        unit: item.unit,
        expiry_date: item.expires || null,
        price_estimate: item.price || null,
        kcal_per_100: item.kcal || null,
        protein_per_100: item.protein || null,
      }), { owner_id: userId });

      await this.syncTable("shopping_items", state.cart, (item) => ({
        id: ensureUuid(item.id),
        list_id: this.shoppingListId,
        user_id: userId,
        name: item.name,
        quantity: item.qty,
        unit: item.unit,
        estimated_price: item.price || null,
        store: item.store || null,
        checked: Boolean(item.checked),
      }), { user_id: userId, list_id: this.shoppingListId });

      await this.syncTable("gastos", state.expenses.filter((entry) => entry.type === "expense"), (entry) => ({
        id: ensureUuid(entry.id),
        user_id: userId,
        amount: entry.amount,
        description: entry.description || null,
        category: entry.category,
        txn_date: entry.date || today(),
      }), { user_id: userId });

      await this.syncTable("ingresos_fuentes", state.expenses.filter((entry) => entry.type === "income"), (entry) => ({
        id: ensureUuid(entry.id),
        user_id: userId,
        name: entry.description || entry.category || "Ingreso",
        amount: entry.amount,
        frequency: "monthly",
      }), { user_id: userId });

      // food_log de hoy: se reescribe entero (los logs historicos no se tocan).
      await this.client.from("food_log").delete().eq("user_id", userId).eq("log_date", today());
      if ((state.consumedMeals || []).length) {
        await this.client.from("food_log").insert(
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

      // TODO feed: publicar posts propios requiere primero sembrar `recipes`
      // (las recetas demo viven hardcodeadas en script.js). Ver README paso 4.
    },

    // Upsert de filas actuales + delete de las que desaparecieron del estado.
    async syncTable(table, items, toRow, ownershipFilter) {
      const rows = items.map(toRow);
      // Reasigna ids no-uuid (estado antiguo) de forma estable dentro de esta pasada.
      items.forEach((item, index) => { item.id = rows[index].id; });

      if (rows.length) {
        const { error } = await this.client.from(table).upsert(rows, { onConflict: "id" });
        if (error) throw error;
      }

      let query = this.client.from(table).select("id");
      Object.entries(ownershipFilter).forEach(([column, value]) => { query = query.eq(column, value); });
      const { data: existing } = await query;
      const keep = new Set(rows.map((row) => row.id));
      const toDelete = (existing || []).map((row) => row.id).filter((id) => !keep.has(id));
      if (toDelete.length) {
        await this.client.from(table).delete().in("id", toDelete);
      }
    },
  };

  // ---------- Fachada publica ----------

  let pushTimer = null;
  let pushQueued = false;
  let pushing = false;

  window.FoodOSData = {
    local,
    remote,

    get mode() {
      return remote.ready && remote.user ? "supabase" : "local";
    },

    loadLocal(defaults) {
      return local.load(defaults);
    },

    // Guarda en local siempre; si hay sesion Supabase programa un push
    // remoto con debounce para no saturar la API en rachas de clicks.
    persist(state) {
      local.save(state);
      if (remote.ready && remote.user) this.schedulePush(state);
    },

    schedulePush(state) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(async () => {
        if (pushing) { pushQueued = true; return; }
        pushing = true;
        try {
          await remote.pushState(state);
        } catch (error) {
          console.warn("FoodOS: fallo al sincronizar con Supabase", error);
        } finally {
          pushing = false;
          if (pushQueued) { pushQueued = false; this.schedulePush(state); }
        }
      }, PUSH_DEBOUNCE_MS);
    },

    // Llamar una vez al arrancar. callbacks.onRemoteState(state) se invoca
    // cuando hay sesion y se ha hidratado el estado desde la base de datos.
    async init(defaults, callbacks = {}) {
      const ok = await remote.init().catch((error) => {
        console.warn("FoodOS: Supabase no disponible", error);
        return false;
      });
      if (!ok) return "local";

      const hydrate = async () => {
        await remote.ensureBaseRows();
        const stateFromDb = await remote.pullState(defaults);
        if (callbacks.onRemoteState) callbacks.onRemoteState(stateFromDb);
      };

      remote.onAuthChange(async (user) => {
        if (callbacks.onAuthChange) callbacks.onAuthChange(user);
        if (user) await hydrate().catch((error) => console.warn("FoodOS: fallo hidratando estado", error));
      });

      if (remote.user) await hydrate().catch((error) => console.warn("FoodOS: fallo hidratando estado", error));
      return "supabase";
    },
  };
})();
