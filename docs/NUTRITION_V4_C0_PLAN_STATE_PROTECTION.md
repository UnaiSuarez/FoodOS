# C0 — protección del estado de plan frente a una sincronización obsoleta

Estado: **implementado y revisable; migración SIN aplicar en ningún entorno remoto; V4 sin activar.** Este documento describe lo que hay en la rama `feature/plan-state-protection-c0` (base `origin/main` = `8d1b6a0`), no un candidato. Las decisiones de V4 (comparación, propuestas persistidas, activación) siguen fuera de esta entrega.

> **C0 protege el offset adaptativo, la calibración y el objetivo diario de HOY. NO protege las columnas decisionales del perfil** (`goal`, `weight_kg`, `activity_level`, `age`…): siguen con «el último escritor gana». Eso es C0b/C1 y no debe presentarse como protección del perfil. La reproducción R2 lo muestra.

---

## 1. Defecto

Un dispositivo con el estado anterior reenvía su snapshot **completo** en cuanto hace cualquier mutación («gana el pendiente local», `state.tsx` / `SYNC_DECISIONES.md`). `pushState` escribe, sin comprobar vigencia frente al servidor:

| Escritura | Qué arrastra del estado local |
|---|---|
| `user_profiles` (upsert, `extra_state` **reemplazado entero**) | `adaptiveKcalOffsetKcal`, `adaptiveCalibrationStartedAt`, `lastTargetChangedAt`, `lastCalculationEngineVersion` |
| `nutrition_goals` (upsert por `(user_id, goal_date)`) | Los objetivos de hoy, siempre que el ledger local coincida con `state.nutrition` — coherencia *interna* que un dispositivo obsoleto cumple igual que uno vigente |

Resultado reproducido (cliente real + esquema real, `results/repro.json`, esquema «previo»): A acepta −100 kcal/día; B obsoleto registra un peso y sincroniza → offset **0**, objetivo de hoy **2039** (el de antes), mientras la propuesta y el snapshot siguen diciendo «aceptado». Con respuesta perdida, el propio dispositivo que aceptó se deshace en su siguiente push.

## 2. Modelo de propiedad

| Dato | Naturaleza | Regla en servidor | Cambio legítimo posible desde un push |
|---|---|---|---|
| `adaptiveKcalOffsetKcal` | Resultado de una decisión explícita (el tipo ya decía «nunca lo escribe nada salvo aceptar una propuesta») | **Escritor único: `fn_accept_nutrition_adjustment`.** Un valor válido ya almacenado no cambia por un push. **Sin valor válido almacenado (ausente, NULL, inválido) la primera escritura válida lo inicializa** | Solo la inicialización |
| `adaptiveCalibrationStartedAt`, `lastTargetChangedAt` | Fecha del último reinicio por un cambio de perfil relevante en *cualquier* dispositivo | Fusión monótona: la mayor fecha **válida y admitida**; nunca retrocede ni vuelve a null; el valor inválido se sanea a null sin abortar | Sí: un reinicio legítimo pone «hoy» ≥ la anterior |
| `lastCalculationEngineVersion` | Sello de transición de motor | No vuelve a null/ausente | Sí: un sello nuevo |
| `nutrition_goals` de una fecha | Caché derivada de perfil + offset + tipo de día | Solo se acepta con una **base declarada** (`basis_offset_kcal`) igual al offset del servidor; el sello no se quita; identidad y procedencia inmutables salvo recálculo legítimo | Sí: un recálculo con la base vigente |
| `nutrition_sync_conflicts` | Informativo | Lo insertan las guardas (o el cliente); **no concede autoridad** | — |

## 3. Servidor (`20261014120000_plan_state_protection.sql`)

Principio: **nunca lanza, conserva, registra y devuelve lo almacenado.** Un push obsoleto no puede fallar en bucle (los clientes antiguos no saben tratar el error); el cliente nuevo detecta el conflicto releyendo con `fn_plan_state_read`.

### 3.1 Sello y procedencia del objetivo (corrección de la revisión)

La reproducción de Codex —`UPDATE … SET basis_offset_kcal = NULL` sin cambiar cifras y luego `UPDATE kcal_target`— terminaba en 2039/base NULL. Ahora:

- Un cliente **sin protocolo** nunca *declara* una base. Sobre una fila sellada, la base entrante (NULL o igual a la almacenada) se descarta, el sello se restaura y **las cifras no pueden cambiar** (`sealed_row_legacy_write`).
- **Dos caminos distintos, no confundir:** (a) el `UPDATE` SQL explícito de la columna a NULL, que Codex reprodujo y que ahora se neutraliza; (b) el upsert habitual del cliente antiguo, cuyo `DO UPDATE SET` solo nombra las columnas de su payload y por tanto **no menciona** `basis_offset_kcal`. **No se ha demostrado que un cliente antiguo quite el sello en su uso normal**; (b) se prueba aparte (`c0.sql.test.ts`: «el upsert habitual de un cliente antiguo…», y `c0.repro.test.ts`: «cliente antiguo»).
- Un cliente **con protocolo** siempre declara: sin base → `missing_basis`; base ≠ offset del servidor → `basis_stale`. En ambos casos se conserva lo almacenado (UPDATE → `OLD`; INSERT de un upsert → fila omitida) y se registra un conflicto.
- `source_snapshot_id`: si una escritura legítima cambia cifras o base, el snapshot anterior **deja de acreditar** el objetivo y pasa a NULL, salvo que se aporte uno nuevo del mismo usuario cuya **kcal** coincida. Si no se recalcula nada, snapshot y `created_at` son inmutables desde un cliente.
- La identidad (`goal_date`, `user_id`) no puede cambiarse; un objetivo sellado o acreditado por un snapshot no se borra desde un cliente (impide «borrar y reinsertar sin sello»). El borrado en cascada de la cuenta corre como propietario y no se ve afectado.
- **Alcance de la procedencia: solo se valida la kcal del snapshot.** Macros, versión de cálculo y modo del snapshot los aporta el cliente y no se comprueban; que un snapshot figure como `source_snapshot_id` acredita la cifra de kcal, no el resto.

### 3.2 Snapshot estricto (corrección de la revisión)

`fn_plan_snapshot_kcal(calorie_target)` devuelve la kcal **solo** si `calorie_target` es un objeto con la clave `kcal` numérica; en cualquier otro caso devuelve NULL de forma explícita (ausente, JSON null, texto, array, objeto sin la clave, kcal no numérica). Los llamadores comparan con `IS NULL` —nunca `<>` sobre un posible NULL, que no entra en un `IF` y dejó pasar `calorie_target: {}`—. La aceptación exige además que el snapshot sea un objeto (`SNAPSHOT_INVALID`) y que su kcal coincida con la que se sella (`SNAPSHOT_MISMATCH`). La función auxiliar de procedencia aplica el mismo criterio. Pruebas: 11 formas × (función auxiliar, aceptación con **rollback completo**: propuesta sigue `pending`, offset intacto, ni snapshot nuevo ni objetivo ni conflicto) y formas no-objeto del snapshot completo.

### 3.3 Fechas y valores inválidos (corrección de la revisión)

El caso de Codex (`2026-99-99` aceptado y luego `date/time field value out of range` en la siguiente escritura) venía de un cast sin protección. Ahora toda interpretación pasa por funciones que **no abortan** (`fn_plan_safe_date`, `fn_plan_admissible_date`, `fn_plan_safe_offset`):

- Política temporal ÚNICA: fecha de calendario existente ∧ ≥ 2000-01-01 ∧ ≤ referencia + 1 día. Servidor: referencia = `current_date` (UTC), el +1 absorbe el huso. Cliente: referencia = `serverDate` de la lectura (no el reloj del host); solo al cargar estado local, donde aún no hay lectura, la fecha local del dispositivo.
- Valor entrante inválido → se sanea a null (calibración) o no se acepta (offset); valor **almacenado** inválido o «futuro» (p. ej. una fecha simulada) se trata como ausente y es corregible.
- La reconciliación del cliente aplica el mismo criterio **a ambos lados** de `max(local, servidor)`, así que no puede reintroducir una fecha inválida o futura. Un valor legítimo de otro huso cerca de medianoche (local = UTC±1) se conserva sin eliminarse ni reintroducirse en bucle (prueba específica).

### 3.4 Inicialización, importaciones y reinicios (revisados antes de imponer el escritor único)

| Ruta existente | Comportamiento con C0 |
|---|---|
| Cuenta nueva / primer `pushState` | El offset llega como `0`: **inicialización** aceptada; a partir de ahí protegido |
| Cuenta con offset ya persistido por `pushState` antes de la migración | Valor numérico válido: se conserva y queda protegido |
| `ensureBaseRows` (fila de perfil sin `extra_state`) | Sin valor válido → la primera escritura lo inicializa |
| Editar el perfil (`NutritionView`) | Ya conservaba el offset localmente; ahora además el servidor |
| `resetAll` | Solo rehidrata desde la nube: no envía un estado por defecto |
| `seedDemo` (admin) | Parte de `defaultState` (offset 0, calibración null): por análisis, el servidor conserva el offset y la calibración y registra un conflicto — efecto deseado (no cubierto por una prueba propia) |
| **Importar datos** (`DashboardShell.importData`) y **Restaurar copia** | Hacen `Object.assign` del estado entero, offset y calibración incluidos. **Con C0 un archivo no puede cambiar el offset aceptado ni retroceder la calibración**: el servidor los conserva y el cliente reconcilia hacia el servidor (el aviso dice «otro dispositivo había ajustado tu plan»). No existe hoy una acción explícita de «restablecer ajuste»; si se quisiera, tendría que ser una función propia con confirmación (C2), no una escritura de estado |
| Valores inválidos ya guardados | Se sanean al cargar (`normalizeState`) y al leer (pull); el servidor los trata como ausentes |

### 3.5 Cambio en la función de aceptación (misma firma)

Bloquea en el orden global **perfil → propuesta**; exige `p_new_offset_kcal = offset vigente + delta` (`OFFSET_MISMATCH`) en vez de escribir un absoluto calculado por un cliente posiblemente obsoleto; valida el snapshot (§3.2); `PROFILE_NOT_FOUND` en vez de «aceptar» sin poder persistir; sella el objetivo con la base y — corrección de un defecto previo — **actualiza también `mode`** en el objetivo del día (antes solo lo escribía al insertar). **No** añade idempotencia ante respuesta perdida: el reintento sigue lanzando `PROPOSAL_NOT_PENDING` (es C2; reproducido en R4).

## 4. Protocolo de bloqueo

Orden global: **perfil (P) → propuesta (R) → objetivo del día (G) → inserciones hoja (snapshot, conflictos, telemetría)**.

| Ruta | Bloqueos que mantiene | Espera a… |
|---|---|---|
| `fn_accept_nutrition_adjustment` | P, R, G (en ese orden) | P, R, G, y la fila de objetivo de otro escritor |
| Rechazo (misma función) | P, R | P, R |
| Push de perfil (upsert) | P (una sentencia) | P |
| Push de objetivo (upsert / update) | G (una sentencia) | G; **lee** P sin bloquearlo |
| Guardas (triggers) | los de su sentencia | nada más |
| Inserciones hoja (conflictos, telemetría) | índice único parcial | solo a otra transacción que inserte *la misma clave*, que ya posee P o G de esa misma fila |

Solo la aceptación toma más de un bloqueo y siempre en el mismo orden; los demás escritores mantienen uno y solo leen lo demás → **no hay ciclos posibles**. No se añade `FOR UPDATE`/`FOR SHARE` sobre el perfil dentro del trigger de objetivos precisamente porque invertiría el orden (G→P frente a P→G) y crearía el interbloqueo que se quería evitar.

La guarda de objetivos lee el offset sin coordinarse con la aceptación, y es correcto por estas razones, que las pruebas de concurrencia (§8) deben confirmar:

1. Si el push obsoleto ya tiene bloqueada la fila del objetivo, la aceptación espera y la **sobrescribe al final** (resultado: el de la aceptación).
2. Si la aceptación ya tiene la fila, el push espera; al reanudarse, el trigger `BEFORE UPDATE` se ejecuta tras el bloqueo y lee el offset ya confirmado (cada sentencia plpgsql toma instantánea propia en READ COMMITTED) → base obsoleta → se conserva.
3. **Límite explícito:** un push con la base *vigente en ese instante* sobre una fecha **distinta** a la que sella la aceptación, o sobre una fila aún inexistente, puede confirmarse justo antes de la aceptación (linealización B→A). Esa fila queda con la base anterior; **no se afirma prevención**: es detectable (`fn_plan_state_read` devuelve `basisOffsetKcal` ≠ offset) y el cliente la reescribe (§6). Prueba K4.

## 5. El marcador de protocolo NO es una prueba de autoridad

El cliente nuevo envía `X-Client-Info: foodos-web plan-protocol/1` (cabecera que supabase-js ya incluye y que CORS ya admite; comprobado en el código instalado que `global.headers` sustituye el valor por defecto). El servidor lo lee de `request.headers`. Es **un marcador de compatibilidad aportado por el cliente**: sirve para distinguir clientes que declaran base de los que no, y para la telemetría de transición. Cualquiera puede falsificarlo; la protección de datos **no** depende de él (la excepción a las guardas es el rol del escritor — `current_user` — y el cliente no puede cambiarlo). Verificación post-despliegue: `fn_plan_state_read` devuelve `clientProtocolLevel`, de modo que con una cuenta QA se comprueba que la cabecera llega a la base. **No verificado todavía contra el PostgREST/CORS reales.**

## 6. Cliente

Todo en `apps/web/src/lib/` (`plan-state.ts` puro; cambios acotados en `data-layer.ts`, `state.tsx`, `supabase.ts`; una llave en `DashboardShell.tsx`).

- **Sonda de capacidad** (una vez por sesión) que distingue: servidor **anterior confirmado** (`PGRST202`/`42883`/«could not find the function») → el cliente se comporta como antes; **error de red, permisos, respuesta inválida o protocolo desconocido** → el push **falla de forma visible, no escribe nada, no cachea** y reintenta con el mecanismo normal (el pendiente sigue en la outbox). No se degrada en silencio a «sin protección».
- **Base**: el upsert de objetivos incluye `basis_offset_kcal` (offset local saneado, o 0).
- **Lectura autoritativa explícita** tras escribir: `fn_plan_state_read(fecha)`; no se supone nada del `RETURNING` (un INSERT omitido no devuelve fila). Cada lectura toma un número al emitirse y una respuesta más antigua que otra ya aplicada **se descarta** (la época de sesión no distingue lecturas dentro de la misma cuenta). La identidad (userId, época) viaja con la lectura y se comprueba al entregarla y de nuevo en el proveedor.
- **Reconciliación** (`handlePlanReadback`): (1) offset del servidor manda; calibración por fusión monótona de valores admisibles de ambos lados; versión de motor solo si el local no tiene; (2) con el plan al día compara el **objetivo de HOY** (`classifyGoalReadback`; nunca otras fechas): sin fila o base distinta o versión distinta → re-envío (`mutate` sin cambios de datos) con tope de 2; mismas base y distintas cifras → refresco desde el servidor (tope de 2), **sin copiar cifras ni sobrescribir**; (3) los conflictos solo se reconocen cuando la lectura confirma que todo coincide (`in_sync`); (4) con una mutación local más nueva en cola, no se concluye nada sobre el objetivo. Aplica sobre el estado **más reciente**; si el cambio no puede aplicarse (mutaciones bloqueadas) o se agotan los reintentos, queda una **relectura pendiente** y no se presenta como reconciliado.
- **Relectura pendiente, durable y acotada**: marca en `localStorage` por usuario; espera creciente 5/15/45/120/300 s; no emite «guardado» mientras exista; agotada, el estado es «error» y la marca permanece (se retoma tras recargar, sin esperar otra edición). No se retoma para otro usuario ni tras un cambio de época.
- **No toca**: el resto del perfil, las ediciones pendientes del usuario, el ledger de fechas pasadas (el recalculado de HOY lo hace la función existente `recordTodayNutritionGoal`).
- `mutate()` admite devolver `false` («nada que cambiar») sin escribir outbox ni programar push — evita bucles cuando el estado ya está reconciliado.

## 7. Transición de clientes antiguos

La migración se despliega con `legacy_goal_write_policy = allow_unsealed` (orden seguro: migración → bundle). En ese modo **queda un residual**: un cliente antiguo y obsoleto puede escribir la fila de un día **aún sin sellar** con el offset obsoleto (prueba S1/K4). Publicar el bundle nuevo **no** lo cierra por sí solo (pestañas abiertas, otros clientes). Se cierra con datos:

1. **Medir**: cada escritura de objetivos sin marcador deja como máximo una fila por usuario y día en `plan_legacy_writes`.
   ```sql
   select day, count(*) as usuarios_sin_protocolo
   from public.plan_legacy_writes where day >= current_date - 14 group by day order by day;
   ```
2. **Criterio para pasar a `reject`** (propuesto, a aprobar): ningún usuario con escritura sin protocolo durante **14 días consecutivos posteriores a publicar el bundle**, y comprobación en una cuenta QA de que `clientProtocolLevel = 1`.
3. **Fijarlo**: `select public.fn_plan_set_legacy_goal_write_policy('reject');` (solo rol de servicio). Efecto: un cliente sin marcador **no persiste objetivos** (ni inserta ni actualiza); sigue sincronizando el resto. Un cliente con marcador no se ve afectado. Cada intento queda como conflicto `daily_goal_overwrite_prevented` con `reason: legacy_policy_reject` (monitorizable).
4. **Reversible**: `select public.fn_plan_set_legacy_goal_write_policy('allow_unsealed');`.

**Qué no cubre** (declarado): un cliente antiguo que reaparezca después de `reject` simplemente no persiste objetivos (su caché diaria no llega al servidor; los datos locales y el resto de tablas sí); la telemetría solo ve usuarios que escriben objetivos; **C0 no debe darse por completo para producción hasta que `reject` esté fijado y verificado**. El residual de columnas del perfil (§ cabecera) permanece para clientes antiguos y nuevos hasta C0b/C1.

## 8. Evidencia y límites

| Qué | Dónde | Resultado | Qué demuestra / NO demuestra |
|---|---|---|---|
| Batería SQL (30) | `supabase/verification/plan-state-staleness/c0.sql.test.ts` | 30/30 | Migración real en PGlite, rol `authenticated`, **una conexión**: sello, procedencia, identidad, borrado, snapshot estricto, fechas inválidas, offset (init/escritor único/saneado), políticas, RLS, lectura. **No** concurrencia, **no** PostgREST, **no** Postgres 17 (PGlite es 18.x) |
| Reproducción de extremo a extremo (11) | `c0.repro.test.ts` | 11/11 | Cliente **real** (`pushState`, `pullState`, aceptación, `plan-state.ts`) contra el esquema «previo» (defecto) y «migrado» (protección y reconciliación); R1–R5 y cliente antiguo. PostgREST **emulado**; el «dispositivo» aplica la reconciliación sobre un estado en memoria (sin outbox ni hidratación) |
| Pruebas de plan-state (22) y de capa de datos con cliente falso (16) | `apps/web/src/lib/plan-state.test.ts`, `data-layer.plan-state.test.ts` | 38/38 | **Simulado**: política temporal (incl. otro huso), clasificación del objetivo, presupuestos, sonda (servidor antiguo / error / inválida), lecturas fuera de orden, A→B/época, relectura pendiente |
| **FoodOSProvider real** (5) | `plan-state-provider.test.tsx` | 5/5 | react-dom + jsdom: pendiente tras recarga, edición durante sincronización en vuelo, lectura de mutación anterior con otra más nueva en cola, A→B con lectura en vuelo, lectura fallida + recarga. Servidor = **modelo en memoria** |
| Suite completa web / engine | `apps/web`, `packages/engine` | 1279/1279 · 833/833 | `tsc` limpio en ambos; `next build` y comprobación de bundle correctos |
| **Concurrencia real** | `supabase/verification/plan-state-staleness/concurrency/run.mjs` + `.github/workflows/plan-state-concurrency.yml` (PostgreSQL 17, varias conexiones) | **NO EJECUTADA** | Escrita (K1–K7: aceptación vs push de perfil, vs objetivo existente, vs objetivo nuevo, fecha distinta, aceptar/rechazar, dos aceptaciones, estrés 30×5 sin interbloqueos). No hay Postgres ni Docker local. Hasta que el job esté en verde, **no se declara validada la serialización** |

**Sin demostrar**: concurrencia real; PostgREST/Supabase reales (incl. que `request.headers` y CORS admitan el marcador); cliente en navegador real y cuentas QA; migración en una rama de base de Supabase; comportamiento de `request.headers` con el pooler.

## 9. Despliegue y recuperación

Orden: (1) revisión + CI verde incluido el job de concurrencia; (2) aplicar la migración en una **rama de base** y repetir `fn_plan_state_read` + la batería; (3) aplicar en producción (**requiere aprobación; aquí no se ha hecho**) — con `allow_unsealed`; (4) publicar el bundle; (5) verificar con QA `clientProtocolLevel`; (6) medir (§7); (7) fijar `reject`. Preflight al migrar (solo lectura): reconsultar `pg_get_functiondef('public.fn_accept_nutrition_adjustment'::regproc)` y confirmar que sigue siendo la de `20260819124430` (el 13/10/2026 coincidía; es una observación fechada), que `nutrition_goals` no tiene ya una columna `basis_offset_kcal` ajena, y que los privilegios de `authenticated` sobre `user_profiles`/`nutrition_goals` siguen siendo CRUD y sobre propuestas/snapshots `SELECT, INSERT` (las pruebas los asumen).

Rollback: la migración es aditiva (columna nullable, tablas nuevas, triggers y funciones). Para desactivar la protección sin perder datos: `drop trigger trg_guard_plan_state_profile on public.user_profiles; drop trigger trg_guard_plan_state_goals on public.nutrition_goals;` y restaurar la función de aceptación anterior. Los datos escritos (objetivos sellados, conflictos) se conservan; **revertir código no revierte datos**.

## 10. Decisiones de C0

| Id | Decisión | Estado |
|---|---|---|
| C0-D1 | Conservar-y-registrar frente a rechazar con error | **Cerrada** (conservar y registrar), con reconciliación visible en el cliente nuevo |
| C0-D2 | Calibración | **Cerrada**: avanza solo con fechas válidas y admitidas |
| C0-D3 | Residual de clientes antiguos | **Abierta**: resuelta solo cuando `reject` esté fijado y verificado (§7) |
| C0-D4 | Conflictos informativos insertables por el cliente | **Cerrada**: informativos, sin autoridad |
| C0-D5 | Retención de conflictos | **Abierta** (propuesta: hasta ser vistos + 90 días); no hay limpieza automática |
| C0-D6 | Columnas decisionales del perfil | **Fuera de C0** → C0b/C1 |
