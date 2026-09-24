// Ejecutar: node check_migration.mjs   (ver README.md)
// Ejecuta la migración REAL (el fichero del repo) sobre un Postgres aislado (PGlite) con una copia de la
// estructura REAL de inventory_items (las 27 columnas y restricciones inspeccionadas en el catálogo de
// FoodOS, sin datos), dos veces (idempotencia), y ejercita el camino de escritura de PostgREST.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(fileURLToPath(new URL("../../migrations/20260924190000_inventory_nutrition_provenance.sql", import.meta.url)), "utf8");
const db = new PGlite();
console.log("Postgres:", (await db.query("select version() as v")).rows[0].v.split(",")[0]);

await db.exec(`
  create schema auth; create table auth.users (id uuid primary key);
  create table public.almacenes (id uuid primary key);
  create table public.inventory_items (
    id uuid primary key default gen_random_uuid(),
    almacen_id uuid not null references public.almacenes(id) on delete cascade,
    owner_id uuid not null references auth.users(id) on delete cascade,
    name text not null, category text, barcode text,
    quantity numeric(10,2) not null default 1 check (quantity >= 0),
    unit text not null default 'ud', expiry_date date, image_url text,
    kcal_per_100 numeric(7,2), protein_per_100 numeric(6,2), carbs_per_100 numeric(6,2), fat_per_100 numeric(6,2),
    fiber_per_100 numeric(6,2), price_estimate numeric(8,2), is_cooked boolean not null default false, open_food_id text,
    source text not null default 'manual' check (source in ('manual','barcode','photo_ai','cart','bank_ticket')),
    added_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    salt_per_100 numeric(6,2), sugars_per_100 numeric(6,2), unit_size numeric(8,2), brand text, allergen_tags text[],
    unit_size_unit text check (unit_size_unit in ('g','ml') or unit_size_unit is null)
  );
  insert into auth.users values ('00000000-0000-0000-0000-000000000001');
  insert into public.almacenes values ('00000000-0000-0000-0000-0000000000a1');
`);

// 1) la migración, dos veces
await db.exec(MIGRATION);
await db.exec(MIGRATION);
const col = (await db.query(`select data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='inventory_items' and column_name='nutrition_provenance'`)).rows;
console.log("columna (verificación del propio fichero):", JSON.stringify(col));
const cons = (await db.query(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid='public.inventory_items'::regclass and conname like '%provenance%'`)).rows;
console.log("constraint tras aplicarla 2 veces:", JSON.stringify(cons));
const cnt = (await db.query(`select count(*)::int as n from pg_constraint where conrelid='public.inventory_items'::regclass and conname='inventory_items_nutrition_provenance_check'`)).rows[0].n;
console.log("constraints con ese nombre (idempotente = 1):", cnt);
console.log("comentario:", (await db.query(`select left(col_description('public.inventory_items'::regclass, (select attnum from pg_attribute where attrelid='public.inventory_items'::regclass and attname='nutrition_provenance')),60) as c`)).rows[0].c + "…");

// 2) el CHECK
const O = "'00000000-0000-0000-0000-000000000001'", A = "'00000000-0000-0000-0000-0000000000a1'";
async function tryInsert(label, value) {
  try {
    await db.query(`insert into public.inventory_items (almacen_id, owner_id, name, nutrition_provenance) values (${A}, ${O}, 'x', $1::jsonb)`, [value]);
    console.log(`  CHECK ${label.padEnd(22)} → aceptado`);
  } catch (e) { console.log(`  CHECK ${label.padEnd(22)} → rechazado (${e.message.split("\n")[0].slice(0, 70)})`); }
}
await tryInsert("SQL NULL", null);
await tryInsert("objeto {}", "{}");
await tryInsert("objeto con datos", JSON.stringify({ dataSource: "off", basis: { name: "a", unit: "g", kcal: 1, protein: 2 } }));
await tryInsert("array []", "[]");
await tryInsert("texto \"x\"", '"x"');
await tryInsert("número 5", "5");
await tryInsert("JSON null (jsonb 'null')", "null");

// 3) el camino de PostgREST: json_populate_recordset con `null` JSON en la columna jsonb
await db.exec("truncate public.inventory_items");
const legacyPayload = JSON.stringify([{ id: "10000000-0000-4000-8000-000000000001", almacen_id: "00000000-0000-0000-0000-0000000000a1", owner_id: "00000000-0000-0000-0000-000000000001", name: "Legacy", quantity: 1, unit: "g", kcal_per_100: 350, nutrition_provenance: null }]);
try {
  const legacyCols = ["id", "almacen_id", "owner_id", "name", "quantity", "unit", "kcal_per_100", "nutrition_provenance"].map((c) => `"${c}"`).join(", ");
  await db.query(`insert into public.inventory_items (${legacyCols}) select ${legacyCols} from json_populate_recordset(null::public.inventory_items, $1::json) _`, [legacyPayload]);
  const r = (await db.query(`select nutrition_provenance is null as es_sql_null, nutrition_provenance::text as valor from public.inventory_items`)).rows[0];
  console.log("  PostgREST-shaped INSERT con {nutrition_provenance: null} →", JSON.stringify(r), "(un item anterior a PR3a escribe NULL y no viola el CHECK)");
} catch (e) { console.log("  ¡FALLO! insert con null JSON:", e.message); }

// 4) upsert como lo genera PostgREST (merge-duplicates + columns): SET solo de las columnas del payload
async function postgrestUpsert(rows, columns) {
  const cols = columns.map((c) => `"${c}"`).join(", ");
  const set = columns.map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ");
  await db.query(
    `insert into public.inventory_items (${cols}) select ${cols} from json_populate_recordset(null::public.inventory_items, $1::json) _ on conflict ("id") do update set ${set}`,
    [JSON.stringify(rows)],
  );
}
const ID = "20000000-0000-4000-8000-000000000002";
const base = { id: ID, almacen_id: "00000000-0000-0000-0000-0000000000a1", owner_id: "00000000-0000-0000-0000-000000000001", name: "Arroz crudo", quantity: 1000, unit: "g", kcal_per_100: 350, protein_per_100: 7 };
const prov = { dataSource: "off", foodStateConfidence: "confirmed", basis: { name: "Arroz crudo", unit: "g", kcal: 350, protein: 7 } };
// cliente NUEVO: incluye la columna
await postgrestUpsert([{ ...base, nutrition_provenance: prov }], [...Object.keys(base), "nutrition_provenance"]);
const read = async () => (await db.query(`select name, kcal_per_100::float as kcal, nutrition_provenance as p from public.inventory_items where id = '${ID}'`)).rows[0];
console.log("  tras cliente NUEVO:", JSON.stringify(await read()));
// cliente ANTIGUO: cambia nombre y kcal, NO conoce la columna (no está en su payload ni en `columns`)
await postgrestUpsert([{ ...base, name: "arroz cocido", kcal_per_100: 130 }], Object.keys(base));
const after = await read();
console.log("  tras cliente ANTIGUO (renombra y cambia kcal):", JSON.stringify(after));
const same = (await db.query(`select nutrition_provenance = $1::jsonb as igual from public.inventory_items where id = '${ID}'`, [JSON.stringify(prov)])).rows[0].igual;
console.log("  → la columna se CONSERVA (igualdad jsonb):", same, "| el nombre y kcal SÍ cambiaron:", after.name === "arroz cocido" && after.kcal === 130);
// cliente NUEVO de un item sin procedencia: limpia
await postgrestUpsert([{ ...base, nutrition_provenance: null }], [...Object.keys(base), "nutrition_provenance"]);
console.log("  tras cliente NUEVO que escribe null:", JSON.stringify(await read()));
