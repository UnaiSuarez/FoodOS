# Verificación de C0 — estado de plan frente a una sincronización obsoleta

Ejecuta la **migración real** `supabase/migrations/20261014120000_plan_state_protection.sql` (y todas las anteriores) en
bases **aisladas y desechables**; no toca ninguna base de Supabase ni usa datos de nadie (usuarios sintéticos
`*@example.invalid`). Diseño y decisiones: `docs/NUTRITION_V4_C0_PLAN_STATE_PROTECTION.md`.

## Qué hay y cómo ejecutarlo

```bash
cd supabase/verification/plan-state-staleness
npm install                      # @electric-sql/pglite, pg y vitest fijados; no toca el workspace

# 1) PGlite (en memoria, UNA conexión) — no necesita nada instalado:
npx vitest run --config vitest.config.ts

# 2) PostgreSQL con VARIAS conexiones (lo ejecuta CI; ver .github/workflows/plan-state-concurrency.yml).
#    Requiere una base VACÍA y desechable (crea roles y todo el esquema). NUNCA contra Supabase ni producción.
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node concurrency/run.mjs
```

En PowerShell: `$env:DATABASE_URL='…'; node concurrency/run.mjs`. Los resultados de la última ejecución de PGlite quedan
en `results/` (`sql.json`, `repro.json`).

| Archivo | Qué es |
|---|---|
| `schema.mjs` | Construye el esquema real: aplica `supabase/migrations/` sobre stubs mínimos (esquema `auth`, `auth.uid()`, roles `anon`/`authenticated`/`service_role`, publicación realtime). Con `withProtection:false` omite C0 (estado de producción hoy). Los privilegios de `authenticated` replican una consulta de solo lectura a producción (14/10/2026) y se aplican **antes** de la migración C0. Lo comparten PGlite y el Postgres real de CI |
| `postgrest.mjs` | Cliente con forma de supabase-js que traduce las llamadas del cliente real al SQL que PostgREST generaría, como rol `authenticated` con `auth.uid()` fijado y la cabecera `X-Client-Info` simulada |
| `c0.sql.test.ts` | 30 casos SQL: sello (incluida la reproducción de Codex), procedencia, identidad, borrado, snapshot estricto con rollback, fechas inválidas, offset, políticas de clientes antiguos, aceptación, lectura |
| `c0.repro.test.ts` | 11 casos de extremo a extremo con el **cliente real** en dos esquemas («previo» y «migrado»): R1 aceptación + dispositivo obsoleto, R2 calibración, R3 cambio legítimo, R4 respuesta perdida, R5 cambio de cuenta, y cliente antiguo |
| `concurrency/run.mjs` | Carreras reales K1–K7 (**no ejecutadas por su autora**, ver abajo) |

## Qué demuestra y qué NO

| Nivel | Demostrado | NO demostrado |
|---|---|---|
| Cliente real + SQL real, **una conexión**, secuencial (PGlite) | Orden de escrituras de `pushState`, efecto de la aceptación, lectura con `pullState`, RLS/GRANT/triggers, las guardas y la reconciliación del cliente | Concurrencia, PostgREST, Postgres 17 (PGlite es 18.x) |
| **Varias conexiones** (`concurrency/run.mjs`) | **Nada hasta que el job de CI esté en verde.** Está escrito para confirmar el protocolo de bloqueo P→R→G, la espera de la escritura obsoleta frente a la aceptación, objetivo existente/nuevo/de otra fecha y la ausencia de interbloqueos | — |
| PostgREST / Supabase reales | Nada: PostgREST se emula. Falta confirmar que `request.headers` incluye `x-client-info` y que CORS lo admite | Cabeceras `Prefer`, `RETURNING`, JWT |
| Suplantación del rol propietario | Razonado por semántica de PostgreSQL (`current_user` no lo fija el cliente) | No comprobable en PGlite: la sesión es superusuario y `SET ROLE` siempre le está permitido |
| Navegador, cuentas QA, despliegue | Nada | — |

Las pruebas del cliente con el `FoodOSProvider` real (cola, hidratación, A→B, pendiente tras recarga) están en
`apps/web/src/lib/plan-state-provider.test.tsx` y forman parte de la suite normal de `apps/web`.
