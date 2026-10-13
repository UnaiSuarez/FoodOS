# Reproducción y verificación C0 — estado de plan frente a una sincronización obsoleta

Reproduce, en un **PostgreSQL aislado y en memoria** (PGlite), el caso «el dispositivo A acepta un ajuste; el
dispositivo B conserva el estado anterior y sincroniza después», ejecutando el **código real de cliente**
(`apps/web/src/lib/data-layer.ts`, `nutrition.ts`, `state.tsx`) contra el **esquema real** de
`supabase/migrations/`. No toca ninguna base de Supabase ni usa datos de nadie (perfiles y usuarios
sintéticos, `*@example.invalid`).

## Cómo ejecutarlo

```bash
cd supabase/verification/plan-state-staleness
npm install                      # @electric-sql/pglite 0.5.8 y vitest 4.1.11, fijados; no toca el workspace
npx vitest run --config vitest.config.ts                 # esquema vigente: documenta el defecto
C0_GUARD=1 npx vitest run --config vitest.config.ts      # + candidate-c0-guard.sql: verifica la protección
```

(En PowerShell: `$env:C0_GUARD='1'; npx vitest run --config vitest.config.ts`.) Cada ejecución escribe
`results/current.json` o `results/guarded.json`; `delta-translation.repro.test.ts` escribe
`results/delta-translation.json`. Los resultados de la última ejecución están versionados.

## Archivos

| Archivo | Qué es |
|---|---|
| `schema.mjs` | Construye el Postgres aislado aplicando las migraciones reales (16 de 20; se omiten 4 de Storage/depuración sin relación). Stubs mínimos: esquema `auth`, `auth.uid()`, roles `anon`/`authenticated`/`service_role`, publicación `supabase_realtime`. Los privilegios de `authenticated` replican la consulta de solo lectura a producción del 14/10/2026 |
| `postgrest.mjs` | Cliente con forma de supabase-js que traduce las llamadas del cliente real al SQL que PostgREST generaría, ejecutado como rol `authenticated` con `auth.uid()` fijado |
| `c0.repro.test.ts` | Batería R1–R5 (reproducción) y S1–S3 (contrato del servidor, solo con guarda) |
| `delta-translation.repro.test.ts` | Cómo un ajuste medio de ±100 kcal/día se convierte en objetivos diarios en v3.1 y en V4 |
| `candidate-c0-guard.sql` | **Candidato, no migración, no aplicado en ningún entorno real**: triggers, tabla de conflictos y `fn_accept_nutrition_adjustment` con aritmética de offset |
| `results/*.json` | Salidas de la última ejecución |

## Qué demuestra y qué no

| Nivel | Demostrado | NO demostrado |
|---|---|---|
| Cliente real + SQL real, **una conexión**, secuencial | Orden de escrituras `pushState` → `extra_state` y `nutrition_goals`; efecto de la función de aceptación; relectura con `pullState`; RLS/GRANT/triggers; que la protección candidata conserva offset, calibración y objetivo y registra el conflicto | — |
| Concurrencia real (dos conexiones, bloqueos, intercalado) | **Nada.** PGlite es de una sola conexión. Este defecto es de *orden* (último en escribir gana) y no necesita carrera; las carreras (doble aceptar, aceptar/rechazar a la vez, dos creaciones) quedan sin demostrar y exigen Postgres con varias conexiones | Todo lo de C2 |
| PostgREST, Supabase Auth, Realtime, Postgres 17.6 | Nada: PostgREST se emula (`postgrest.mjs`); PGlite es PostgreSQL 18.x | Comportamiento exacto de cabeceras `Prefer`, `RETURNING`, JWT |
| Cliente **nuevo** (envío de base, comparación de lo almacenado, reconciliación, reescritura de la cola) | **Nada**: aún no existe; solo el contrato del servidor (S1–S3) con cargas elaboradas a mano | Diseño de `docs/NUTRITION_V4_C0_PLAN_STATE_PROTECTION.md` §5 |
| Navegador / UI / cuentas QA | Nada | — |
| Que el cliente no pueda suplantar el rol del propietario | Razonado por semántica de PostgreSQL (`current_user` no lo fija el cliente; en Supabase el JWT de usuario solo selecciona `authenticated`/`anon`) | No comprobable en PGlite: la sesión es superusuario, `SET ROLE` siempre le está permitido |
