# Verificación en un Postgres aislado — `inventory_items.nutrition_provenance`

Comprobaciones de la migración `20260924190000_inventory_nutrition_provenance.sql` y del valor
canónico de `numeric(p,2)` contra un **PostgreSQL real, aislado y en memoria** (PGlite, WebAssembly).
No tocan ninguna base de Supabase, ni la de producción ni otra, y no usan datos de nadie: la tabla se
recrea con la estructura real de `inventory_items` (27 columnas y restricciones, leídas del catálogo)
y vacía.

## Cómo ejecutarlas

```bash
cd supabase/verification/inventory-nutrition-provenance
npm install                                   # instala solo @electric-sql/pglite (fijado); no toca el package.json raíz
node --experimental-strip-types check_numeric.mjs
node check_migration.mjs
```

## Qué comprueban

- `check_numeric.mjs` — `canonicalNumeric2` (`apps/web/src/lib/pg-numeric.ts`, importado tal cual) frente a
  Postgres, por el camino de escritura de PostgREST (`json_populate_recordset` → `numeric(7,2)`), con 41
  valores fijos y ~36 000 aleatorios, incluidos los bordes `x,xx5`. Espera **0 diferencias**. Imprime también
  cuántas veces se equivoca el redondeo ingenuo `Math.round(v * 100) / 100` (446 en la última ejecución).
- `check_migration.mjs` — aplica la migración **dos veces** (idempotencia); comprueba la columna, el `CHECK`
  (acepta `NULL`, `{}` y objetos; rechaza arrays, texto, números y `jsonb 'null'`); que un `null` JSON que
  envía un cliente nuevo para un item sin procedencia llega como `NULL` de SQL (no viola el `CHECK`); y que un
  `upsert` con la forma exacta que genera PostgREST (`INSERT … (columnas del payload) … ON CONFLICT DO UPDATE SET
  col = EXCLUDED.col` solo para esas columnas) **conserva** `nutrition_provenance` cuando el cliente antiguo no la
  incluye, aunque cambie el nombre y los números.

## Lo que NO comprueban

- PostgREST en sí no se ejecuta. La generación de ese SQL se ha contrastado leyendo su código fuente
  (`src/library/PostgREST/Query/QueryBuilder.hs`, `mutatePlanToQuery`: `DO UPDATE SET` solo para las columnas
  de `iCols`, las del payload o el parámetro `columns`; rama `main`, commit `33823088da`, 24/09/2026), no la
  versión concreta que ejecuta Supabase en el proyecto de FoodOS.
- PGlite es PostgreSQL 18.3; el proyecto de FoodOS usa 17.6. El redondeo de `numeric` es el mismo.
- RLS y permisos no se modelan (la migración no los toca).
