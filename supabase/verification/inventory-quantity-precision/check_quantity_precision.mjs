// Verificación de solo lectura/simulación, en un PostgreSQL aislado en
// memoria (PGlite) — nunca toca el Supabase real de FoodOS. Reproduce el
// hallazgo del PR #150: inventory_items.quantity es numeric(10,2) en el
// esquema real (confirmado también con una consulta de solo lectura contra
// el proyecto real, rwxysqzurjsrevdhbejy, fuera de este script), así que
// redondear el estado local a 3 decimales (1 g de fidelidad, §20.6b) no
// garantiza que Supabase conserve esos decimales — Postgres trunca/redondea
// al escribir, con independencia de lo que el cliente envíe.
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();

// Misma definición EXACTA que supabase/migrations/20260629120159_initial_schema.sql,
// confirmada además contra el esquema real (information_schema.columns).
await db.exec(`create table inventory_items (quantity numeric(10,2) not null);`);

console.log("=== 1. Confirmación directa: numeric(10,2) trunca a 2 decimales al INSERT ===");
await db.exec(`insert into inventory_items (quantity) values (1.267);`);
const r1 = await db.query(`select quantity from inventory_items;`);
console.log(`Insertado 1.267 -> leído de vuelta: ${r1.rows[0].quantity} (${r1.rows[0].quantity === "1.27" ? "TRUNCADO a 2 decimales, como se esperaba" : "INESPERADO"})`);

console.log("\n=== 2. Caso obligatorio: 1,5 kg - 233 g ===");
const stockBefore = 1.5;
const declaredGrams = 233;
// Misma aritmética que consumeInventoryItem (state.tsx) tras la corrección
// de §20.6b: redondeo a gramos enteros, 1g de fidelidad LOCAL.
const consumedKg = Math.round(declaredGrams) / 1000; // 0.233
const remainingLocal = Math.round((stockBefore - consumedKg) * 1000) / 1000; // 1.267, 3 decimales LOCALES
console.log(`Local (antes de sincronizar): consumedKg=${consumedKg}, remainingLocal=${remainingLocal}`);

await db.exec(`delete from inventory_items;`);
await db.query(`insert into inventory_items (quantity) values ($1);`, [remainingLocal]);
const r2 = await db.query(`select quantity from inventory_items;`);
const remainingPersisted = Number(r2.rows[0].quantity);
console.log(`pushState() inserta ${remainingLocal} -> Postgres almacena y devuelve: ${r2.rows[0].quantity}`);
console.log(`pullState() leería de vuelta: ${remainingPersisted} kg (NO ${remainingLocal} kg)`);
console.log(`Pérdida de precisión real: ${Math.round((remainingLocal - remainingPersisted) * 1000)} g`);

console.log("\n=== 3. food_log.client_meta (JSONB) — SIN la misma limitación ===");
await db.exec(`create table food_log_sim (client_meta jsonb);`);
await db.query(`insert into food_log_sim (client_meta) values ($1::jsonb);`, [JSON.stringify({ qty: consumedKg, unit: "kg" })]);
const r3 = await db.query(`select client_meta->>'qty' as qty from food_log_sim;`);
console.log(`JSONB (diario, client_meta.qty) round-trip de ${consumedKg} -> ${r3.rows[0].qty} (SIN truncar — JSONB no tiene precisión numérica fija)`);

// ── 4. Ruta que SÍ se admite tras la corrección del PR #150: solo gramos, como
// mucho 2 decimales. La cantidad declarada se registra tal cual (sin redondear)
// y el stock restante, calculado en gramos con 2 decimales, sobrevive íntegro
// a numeric(10,2) / numeric(8,2). Aritmética idéntica a consumeInventoryItem.
console.log("\n=== 4. Ruta en gramos (≤ 2 decimales): sobrevive a la sincronización ===");
await db.exec(`create table inv_g (quantity numeric(10,2) not null); create table log_g (quantity_g numeric(8,2), client_meta jsonb);`);
let okAll = true;
for (const [stock, declared] of [[500, 233.6], [500, 0.4], [1000, 200], [200.6, 200.6], [500, 0.01]]) {
  const consumed = Math.min(declared, stock);
  const remaining = Math.round((stock - consumed) * 100) / 100;
  await db.exec(`delete from inv_g; delete from log_g;`);
  await db.query(`insert into inv_g (quantity) values ($1);`, [remaining]);
  await db.query(`insert into log_g (quantity_g, client_meta) values ($1, $2::jsonb);`, [consumed, JSON.stringify({ qty: consumed, unit: "g" })]);
  const inv = Number((await db.query(`select quantity from inv_g;`)).rows[0].quantity);
  const logRow = (await db.query(`select quantity_g, client_meta->>'qty' as qty from log_g;`)).rows[0];
  const ok = inv === remaining && Number(logRow.quantity_g) === consumed && Number(logRow.qty) === consumed;
  okAll &&= ok;
  console.log(`stock ${stock} g, declarado ${declared} g → registrado ${consumed} g, restante ${remaining} g | releído: stock ${inv}, quantity_g ${logRow.quantity_g}, client_meta.qty ${logRow.qty} → ${ok ? "ÍNTEGRO" : "PÉRDIDA"}`);
}

// Un peso con 3 decimales NO se admite (la app lo rechaza): aquí se ve por qué —
// numeric(…,2) lo alteraría en silencio al persistir.
await db.exec(`delete from inv_g;`);
await db.query(`insert into inv_g (quantity) values ($1);`, [200.004]);
const lost = (await db.query(`select quantity from inv_g;`)).rows[0].quantity;
console.log(`Referencia: 200.004 g en numeric(10,2) vuelve como ${lost} → por eso se rechaza en la app, no se redondea en silencio.`);

console.log("\n=== Conclusión ===");
console.log("declaredGrams (JSONB, food_log.client_meta): precisión completa, round-trip exacto.");
console.log("item.qty / stock restante (inventory_items.quantity numeric(10,2)): en kg con 3 decimales se trunca a 2 al sincronizar — por eso el modo pesado se limita a gramos (≤ 2 decimales), donde sobrevive íntegro (sección 4).");
if (!okAll) process.exitCode = 1;

await db.close();
