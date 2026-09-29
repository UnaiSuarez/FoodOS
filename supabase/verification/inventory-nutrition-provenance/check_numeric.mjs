// Ejecutar: node --experimental-strip-types check_numeric.mjs   (ver README.md)
// Contrasta canonicalNumeric2 (el del repo, importado tal cual) con PostgreSQL REAL (PGlite, aislado).
// El camino de PostgREST para un upsert de un array JSON es json_populate_recordset(null::tabla, $1):
// el número llega como TEXTO decimal y se coerciona a numeric(p,2) de la columna.
import { PGlite } from "@electric-sql/pglite";
import { canonicalNumeric2 } from "../../../apps/web/src/lib/pg-numeric.ts";

const db = new PGlite();
const version = (await db.query("select version() as v")).rows[0].v;
console.log("Postgres:", version.split(",")[0]);

await db.exec("create table t (id int, kcal numeric(7,2), prot numeric(6,2), usz numeric(8,2))");

const fixed = [
  165.0051, 165.005, 165.0049, 165.01, 165, 165.00, 1.005, 2.675, 0.005, 0.0049, 0.004, 0.015, 999.995, 9.995,
  31.004, 31.006, 31.01, 0.1 + 0.2, 1e-7, 1.5e-3, 5e-3, 0.0050000001, 12345.675, 1.115, 1.125, 1.135, 8.345,
  10.075, 0.285, 4.35, 1.4999999, 33.335, 0.995, 0.994999, 1e-6, 4.999e-3, 5.001e-3, 99999.994, 0.1, 0.7, 350.25,
];
// fuzz reproducible (LCG) con 0–7 decimales, incluyendo valores en el borde de x.xx5
let seed = 123456789;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const fuzz = [];
for (let i = 0; i < 30000; i++) {
  const decimals = Math.floor(rnd() * 8);
  const whole = Math.floor(rnd() * 20000);
  const v = Number((whole + rnd()).toFixed(decimals));
  fuzz.push(v);
  if (i % 5 === 0) fuzz.push(Number((whole + Math.floor(rnd() * 100) / 100 + 0.005).toFixed(3))); // justo en el borde
}
const values = [...fixed, ...fuzz].filter((v) => Math.abs(v) < 99999.99);

const jsonText = JSON.stringify(values.map((v, i) => ({ id: i, kcal: v, prot: v % 9999, usz: v })));
await db.query("insert into t select * from json_populate_recordset(null::t, $1::json)", [jsonText]);
const rows = (await db.query("select id, kcal::text as kcal from t order by id")).rows;

let bad = 0;
const naive = { mismatch: 0, examples: [] };
values.forEach((v, i) => {
  const pg = rows[i].kcal; // texto tal como lo devuelve Postgres
  const js = canonicalNumeric2(v);
  if (Number(pg) !== js) {
    bad++;
    if (bad <= 10) console.log("DIFERENCIA", { valor: v, json: JSON.stringify(v), postgres: pg, canonicalNumeric2: js });
  }
  const naiveRound = Math.round(v * 100) / 100;
  if (naiveRound !== Number(pg)) {
    naive.mismatch++;
    if (naive.examples.length < 5) naive.examples.push({ valor: v, postgres: pg, ingenuo: naiveRound });
  }
});
console.log(`valores comprobados: ${values.length} (${fixed.length} fijos + ${values.length - fixed.length} aleatorios)`);
console.log(`canonicalNumeric2 ≠ Postgres: ${bad}`);
console.log(`Math.round(v*100)/100 ≠ Postgres: ${naive.mismatch}  ejemplos:`, JSON.stringify(naive.examples));

// Los casos concretos de la revisión, contra Postgres y contra la función
for (const v of [165.0051, 165.005, 1.005, 2.675]) {
  const r = (await db.query("select ($1::numeric)::numeric(7,2)::text as pg", [String(v)])).rows[0].pg;
  console.log(`  ${String(v).padEnd(9)} → Postgres ${r.padEnd(7)} | canonicalNumeric2 ${canonicalNumeric2(v)}`);
}
process.exit(bad === 0 ? 0 : 1);
