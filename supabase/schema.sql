-- FoodOS Supabase schema v0.1
-- Base: PDF tecnico + mock funcional fooOSappweb.
-- Run in a fresh Supabase project after enabling auth.

create extension if not exists pgcrypto;

-- ---------- Helpers ----------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- Catalogs ----------

create table if not exists public.mascots (
  id text primary key,
  name text not null,
  color text not null,
  tagline text not null,
  image_url text,
  sort_order integer not null default 0
);

insert into public.mascots (id, name, color, tagline, sort_order) values
  ('zana','Zana','#fb923c','Energetica y motivadora',1),
  ('basil','Basil','#a3e635','Sereno y experto',2),
  ('froggy','Froggy','#22c55e','Curioso y con humor',3),
  ('sage','Sage','#c084fc','Tranquilo y analitico',4),
  ('chip','Chip','#60a5fa','Neutro y eficiente',5),
  ('mushi','Mushi','#f472b6','Sonadora y creativa',6),
  ('bruno','Bruno','#a78bfa','Carinoso y protector',7),
  ('pica','Pica','#ef4444','Intensa y retadora',8),
  ('okto','Okto','#06b6d4','Organizado y multitarea',9),
  ('kiri','Kiri','#f97316','Carismatico y creativo',10),
  ('vera','Vera','#86efac','Calmada y equilibrada',11),
  ('pingo','Pingo','#7dd3fc','Metodico y ordenado',12),
  ('volt','Volt','#fde047','Hiperactivo y explosivo',13),
  ('leo','Leo','#fbbf24','Fuerte y motivador',14),
  ('luna','Luna','#818cf8','Misteriosa y tranquila',15)
on conflict (id) do update set
  name = excluded.name,
  color = excluded.color,
  tagline = excluded.tagline,
  sort_order = excluded.sort_order;

-- ---------- User profile ----------

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  mascot_id text not null default 'zana' references public.mascots(id),
  age integer check (age is null or (age > 0 and age < 120)),
  sex text check (sex is null or sex in ('male','female')),
  height_cm numeric(5,1),
  weight_kg numeric(5,1),
  body_fat_pct numeric(4,1),
  activity_level text check (activity_level is null or activity_level in ('sedentary','light','moderate','active','very_active')),
  goal text check (goal is null or goal in ('fat_loss','muscle_gain','recomp','maintain')),
  gym_days integer[] not null default '{}',
  excluded_foods text[] not null default '{}',
  allergies text[] not null default '{}',
  weekly_food_budget numeric(10,2) not null default 70,
  push_token text,
  bank_sync_enabled boolean not null default false,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_user_profiles_updated_at
before update on public.user_profiles
for each row execute function public.set_updated_at();

-- ---------- Inventory / almacenes ----------

create table if not exists public.almacenes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'custom' check (type in ('fridge','freezer','pantry','custom')),
  emoji text not null default '📦',
  is_shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.almacen_members (
  almacen_id uuid not null references public.almacenes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (almacen_id, user_id)
);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  almacen_id uuid not null references public.almacenes(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text,
  barcode text,
  quantity numeric(10,2) not null default 1 check (quantity >= 0),
  unit text not null default 'ud',
  expiry_date date,
  image_url text,
  kcal_per_100 numeric(7,2),
  protein_per_100 numeric(6,2),
  carbs_per_100 numeric(6,2),
  fat_per_100 numeric(6,2),
  fiber_per_100 numeric(6,2),
  price_estimate numeric(8,2),
  is_cooked boolean not null default false,
  open_food_id text,
  source text not null default 'manual' check (source in ('manual','barcode','photo_ai','cart','bank_ticket')),
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_almacenes_owner on public.almacenes(owner_id);
create index if not exists idx_almacen_members_user on public.almacen_members(user_id);
create index if not exists idx_inventory_almacen_expiry on public.inventory_items(almacen_id, expiry_date);
create index if not exists idx_inventory_owner_name on public.inventory_items(owner_id, lower(name));

create trigger trg_almacenes_updated_at
before update on public.almacenes
for each row execute function public.set_updated_at();

create trigger trg_inventory_items_updated_at
before update on public.inventory_items
for each row execute function public.set_updated_at();

-- ---------- Recipes ----------

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  image_url text,
  video_url text,
  video_thumbnail text,
  prep_minutes integer not null default 0 check (prep_minutes >= 0),
  servings integer not null default 1 check (servings > 0),
  difficulty text check (difficulty is null or difficulty in ('easy','medium','hard')),
  visibility text not null default 'private' check (visibility in ('private','shared','public')),
  tags text[] not null default '{}',
  kcal_per_serving numeric(7,2),
  protein_per_serving numeric(6,2),
  carbs_per_serving numeric(6,2),
  fat_per_serving numeric(6,2),
  cost_per_serving numeric(8,2),
  likes_count integer not null default 0,
  saves_count integer not null default 0,
  generated_by_ai boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  name text not null,
  quantity numeric(10,2),
  unit text,
  kcal_per_100 numeric(7,2),
  protein_per_100 numeric(6,2),
  carbs_per_100 numeric(6,2),
  fat_per_100 numeric(6,2),
  required boolean not null default true,
  sort_order integer not null default 0
);

create table if not exists public.recipe_steps (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  step_order integer not null,
  body text not null,
  image_url text,
  unique (recipe_id, step_order)
);

create table if not exists public.recipe_saves (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  saved_at timestamptz not null default now(),
  primary key (recipe_id, user_id)
);

create table if not exists public.recipe_likes (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  liked_at timestamptz not null default now(),
  primary key (recipe_id, user_id)
);

create index if not exists idx_recipes_author on public.recipes(author_id);
create index if not exists idx_recipes_public on public.recipes(visibility, created_at desc);
create index if not exists idx_recipe_ingredients_recipe on public.recipe_ingredients(recipe_id);
create index if not exists idx_recipe_steps_recipe on public.recipe_steps(recipe_id, step_order);

create trigger trg_recipes_updated_at
before update on public.recipes
for each row execute function public.set_updated_at();

-- ---------- Shopping cart ----------

create table if not exists public.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Compra',
  store text,
  status text not null default 'active' check (status in ('active','completed','archived')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.shopping_lists(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  quantity numeric(10,2) not null default 1,
  unit text not null default 'ud',
  estimated_price numeric(8,2),
  store text,
  checked boolean not null default false,
  source text not null default 'manual' check (source in ('manual','recipe','nutrition','bank_prompt')),
  source_recipe_id uuid references public.recipes(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_shopping_lists_user_status on public.shopping_lists(user_id, status);
create index if not exists idx_shopping_items_list on public.shopping_items(list_id, checked);

create trigger trg_shopping_lists_updated_at
before update on public.shopping_lists
for each row execute function public.set_updated_at();

create trigger trg_shopping_items_updated_at
before update on public.shopping_items
for each row execute function public.set_updated_at();

-- ---------- Feed ----------

create table if not exists public.feed_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid references public.recipes(id) on delete set null,
  title text,
  body text,
  image_url text,
  video_url text,
  visibility text not null default 'public' check (visibility in ('public','followers','private')),
  likes_count integer not null default 0,
  comments_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.feed_post_likes (
  post_id uuid not null references public.feed_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  liked_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.feed_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feed_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_feed_posts_public on public.feed_posts(visibility, created_at desc);
create index if not exists idx_feed_comments_post on public.feed_comments(post_id, created_at);

create trigger trg_feed_posts_updated_at
before update on public.feed_posts
for each row execute function public.set_updated_at();

create trigger trg_feed_comments_updated_at
before update on public.feed_comments
for each row execute function public.set_updated_at();

-- ---------- Nutrition ----------

create table if not exists public.nutrition_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_date date not null default current_date,
  kcal_target numeric(7,2) not null default 2200,
  protein_target_g numeric(6,2) not null default 150,
  carbs_target_g numeric(6,2) not null default 225,
  fat_target_g numeric(6,2) not null default 70,
  mode text not null default 'recomp' check (mode in ('fat_loss','muscle_gain','recomp','maintain')),
  created_at timestamptz not null default now(),
  unique (user_id, goal_date)
);

create table if not exists public.food_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  log_date date not null default current_date,
  meal_type text check (meal_type is null or meal_type in ('breakfast','lunch','dinner','snack')),
  item_name text not null,
  quantity_g numeric(8,2),
  kcal numeric(7,2),
  protein_g numeric(6,2),
  carbs_g numeric(6,2),
  fat_g numeric(6,2),
  source text not null default 'manual' check (source in ('manual','recipe','inventory','barcode')),
  source_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_food_log_user_date on public.food_log(user_id, log_date);
create index if not exists idx_nutrition_goals_user_date on public.nutrition_goals(user_id, goal_date);

-- ---------- Finance ----------

create table if not exists public.gastos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(10,2) not null,
  description text,
  category text not null,
  subcategory text,
  frequency text not null default 'once' check (frequency in ('once','weekly','monthly','yearly')),
  txn_date date not null default current_date,
  source text not null default 'manual' check (source in ('manual','bank','foodos_cart','csv','pdf','photo')),
  bank_txn_id text unique,
  bank_account_id text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.ingresos_fuentes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  amount numeric(10,2) not null,
  frequency text not null check (frequency in ('weekly','biweekly','monthly','yearly')),
  day_of_month integer check (day_of_month is null or day_of_month between 1 and 31),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.objetivos_ahorro (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  emoji text not null default '🎯',
  target_amount numeric(10,2) not null,
  current_amount numeric(10,2) not null default 0,
  target_date date,
  is_completed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.bank_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'nordigen',
  institution_id text not null,
  institution_name text,
  requisition_id text not null,
  account_ids text[] not null default '{}',
  status text not null default 'pending' check (status in ('active','expired','pending','revoked')),
  last_sync timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.bank_connections is 'Solo IDs de Nordigen/GoCardless. Credenciales bancarias nunca se almacenan aqui.';

create index if not exists idx_gastos_user_date on public.gastos(user_id, txn_date desc);
create index if not exists idx_gastos_category on public.gastos(user_id, category);
create index if not exists idx_income_sources_user on public.ingresos_fuentes(user_id, active);
create index if not exists idx_bank_connections_user on public.bank_connections(user_id, status);

-- ---------- AI/search support ----------

create table if not exists public.ingredient_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  required_ingredients text[] not null,
  excluded_ingredients text[] not null default '{}',
  optional_ingredients text[] not null default '{}',
  mode text not null,
  result_count integer,
  ai_generated boolean not null default false,
  searched_at timestamptz not null default now()
);

create table if not exists public.ai_recipe_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text unique not null,
  recipes_json jsonb not null,
  ai_model text not null default 'gemini-1.5-flash',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '6 hours'
);

create table if not exists public.ai_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  provider text,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  estimated_cost numeric(10,6),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('expiry','budget','macro','bank','recipe','system')),
  title text not null,
  body text,
  entity_table text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_ingredient_searches_user on public.ingredient_searches(user_id, searched_at desc);
create index if not exists idx_ai_cache_key on public.ai_recipe_cache(cache_key);
create index if not exists idx_ai_cache_expires on public.ai_recipe_cache(expires_at);
create index if not exists idx_notification_events_user on public.notification_events(user_id, created_at desc);

-- ---------- RLS ----------

alter table public.user_profiles enable row level security;
alter table public.almacenes enable row level security;
alter table public.almacen_members enable row level security;
alter table public.inventory_items enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.recipe_steps enable row level security;
alter table public.recipe_saves enable row level security;
alter table public.recipe_likes enable row level security;
alter table public.shopping_lists enable row level security;
alter table public.shopping_items enable row level security;
alter table public.feed_posts enable row level security;
alter table public.feed_post_likes enable row level security;
alter table public.feed_comments enable row level security;
alter table public.nutrition_goals enable row level security;
alter table public.food_log enable row level security;
alter table public.gastos enable row level security;
alter table public.ingresos_fuentes enable row level security;
alter table public.objetivos_ahorro enable row level security;
alter table public.bank_connections enable row level security;
alter table public.ingredient_searches enable row level security;
alter table public.ai_recipe_cache enable row level security;
alter table public.ai_events enable row level security;
alter table public.notification_events enable row level security;

create or replace function public.is_almacen_member(target_almacen_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.almacen_members m
    where m.almacen_id = target_almacen_id
      and m.user_id = auth.uid()
  );
$$;

-- Profiles
create policy "profiles_select_own" on public.user_profiles for select using (user_id = auth.uid());
create policy "profiles_insert_own" on public.user_profiles for insert with check (user_id = auth.uid());
create policy "profiles_update_own" on public.user_profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Mascots are public read-only
alter table public.mascots enable row level security;
create policy "mascots_select_all" on public.mascots for select using (true);

-- Almacenes
create policy "almacenes_select_member" on public.almacenes
for select using (owner_id = auth.uid() or public.is_almacen_member(id));
create policy "almacenes_insert_owner" on public.almacenes
for insert with check (owner_id = auth.uid());
create policy "almacenes_update_owner" on public.almacenes
for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "almacenes_delete_owner" on public.almacenes
for delete using (owner_id = auth.uid());

create policy "almacen_members_select_member" on public.almacen_members
for select using (user_id = auth.uid() or public.is_almacen_member(almacen_id));
create policy "almacen_members_insert_owner" on public.almacen_members
for insert with check (
  exists (select 1 from public.almacenes a where a.id = almacen_id and a.owner_id = auth.uid())
);
create policy "almacen_members_delete_owner" on public.almacen_members
for delete using (
  user_id = auth.uid()
  or exists (select 1 from public.almacenes a where a.id = almacen_id and a.owner_id = auth.uid())
);

create policy "inventory_select_member" on public.inventory_items
for select using (owner_id = auth.uid() or public.is_almacen_member(almacen_id));
create policy "inventory_insert_member" on public.inventory_items
for insert with check (owner_id = auth.uid() and public.is_almacen_member(almacen_id));
create policy "inventory_update_owner" on public.inventory_items
for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "inventory_delete_owner" on public.inventory_items
for delete using (owner_id = auth.uid());

-- Recipes: public recipes visible, private only author.
create policy "recipes_select_public_or_own" on public.recipes
for select using (visibility = 'public' or author_id = auth.uid());
create policy "recipes_insert_own" on public.recipes
for insert with check (author_id = auth.uid());
create policy "recipes_update_own" on public.recipes
for update using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy "recipes_delete_own" on public.recipes
for delete using (author_id = auth.uid());

create policy "recipe_ingredients_select_visible_recipe" on public.recipe_ingredients
for select using (exists (select 1 from public.recipes r where r.id = recipe_id and (r.visibility = 'public' or r.author_id = auth.uid())));
create policy "recipe_ingredients_modify_author" on public.recipe_ingredients
for all using (exists (select 1 from public.recipes r where r.id = recipe_id and r.author_id = auth.uid()))
with check (exists (select 1 from public.recipes r where r.id = recipe_id and r.author_id = auth.uid()));

create policy "recipe_steps_select_visible_recipe" on public.recipe_steps
for select using (exists (select 1 from public.recipes r where r.id = recipe_id and (r.visibility = 'public' or r.author_id = auth.uid())));
create policy "recipe_steps_modify_author" on public.recipe_steps
for all using (exists (select 1 from public.recipes r where r.id = recipe_id and r.author_id = auth.uid()))
with check (exists (select 1 from public.recipes r where r.id = recipe_id and r.author_id = auth.uid()));

-- Generic own-row policies
create policy "recipe_saves_own" on public.recipe_saves for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "recipe_likes_own" on public.recipe_likes for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "shopping_lists_own" on public.shopping_lists for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "shopping_items_own" on public.shopping_items for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "nutrition_goals_own" on public.nutrition_goals for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "food_log_own" on public.food_log for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "gastos_own" on public.gastos for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "ingresos_fuentes_own" on public.ingresos_fuentes for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "objetivos_ahorro_own" on public.objetivos_ahorro for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "bank_connections_own" on public.bank_connections for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "ingredient_searches_own" on public.ingredient_searches for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "notification_events_own" on public.notification_events for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Feed public read, author/comment owner writes.
create policy "feed_posts_select_visible" on public.feed_posts
for select using (visibility = 'public' or user_id = auth.uid());
create policy "feed_posts_insert_own" on public.feed_posts
for insert with check (user_id = auth.uid());
create policy "feed_posts_update_own" on public.feed_posts
for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "feed_posts_delete_own" on public.feed_posts
for delete using (user_id = auth.uid());

create policy "feed_post_likes_own" on public.feed_post_likes for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "feed_comments_select_public_posts" on public.feed_comments
for select using (exists (select 1 from public.feed_posts p where p.id = post_id and (p.visibility = 'public' or p.user_id = auth.uid())));
create policy "feed_comments_insert_own" on public.feed_comments
for insert with check (user_id = auth.uid());
create policy "feed_comments_update_own" on public.feed_comments
for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "feed_comments_delete_own" on public.feed_comments
for delete using (user_id = auth.uid());

-- AI cache is read for authenticated users; writes should be service role/API route.
create policy "ai_recipe_cache_select_auth" on public.ai_recipe_cache for select using (auth.uid() is not null);
create policy "ai_events_select_own" on public.ai_events for select using (user_id = auth.uid());


-- ---------- Water log (registro de agua diario) ----------

create table if not exists public.water_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  log_date date not null default current_date,
  ml integer not null default 0 check (ml >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, log_date)
);

alter table public.water_log enable row level security;
create policy "water_log_own" on public.water_log for all using (user_id = auth.uid()) with check (user_id = auth.uid());
