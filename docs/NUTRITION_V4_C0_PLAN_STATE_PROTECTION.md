# C0 — protección del estado de plan frente a sincronización obsoleta (diseño mínimo)

Diseño y reproducción verificable. **No hay cambios de producto**, ni SQL aplicado a ningún entorno real. El candidato de SQL vive en `supabase/verification/plan-state-staleness/` y no es una migración. Fecha: 14/10/2026. Base: `origin/main` = `8d1b6a0` (#151) incorporada a la rama por *merge* (el commit `763ab75` se conserva).

---

## 1. Defecto y alcance

### 1.1 Mecanismo (código vigente)

Un dispositivo que conserva el estado anterior reenvía **su snapshot completo** en cuanto hace cualquier mutación (la política documentada es «gana el pendiente local», `state.tsx:282-296`, `SYNC_DECISIONES.md:381-386`). `pushState` escribe, en este orden y sin ninguna comprobación de vigencia frente al servidor:

| Escritura | Dónde | Qué arrastra del estado local |
|---|---|---|
| `user_profiles` (upsert) con `extra_state` **reemplazado entero** | `data-layer.ts:1982-2032` | `adaptiveKcalOffsetKcal`, `adaptiveCalibrationStartedAt`, `lastTargetChangedAt`, `lastCalculationEngineVersion` y, además, las columnas del perfil |
| `nutrition_goals` (upsert por `(user_id, goal_date)`) | `data-layer.ts:2087-2114` | Los objetivos del día, **siempre que el ledger local coincida con `state.nutrition`**: una condición de coherencia *interna* que un dispositivo obsoleto cumple igual que uno vigente |

La aceptación (`fn_accept_nutrition_adjustment`) escribe offset y objetivo del día en una transacción, pero nada impide que la siguiente sincronización de otro dispositivo —o del mismo, tras perder la respuesta— los reemplace.

### 1.2 Reproducción (resumen; detalle en §6)

Cliente real y esquema real, una conexión. A acepta −100 kcal/día; B (estado anterior) registra un peso y sincroniza:

| Dato tras relectura | Vigente | Con la guarda candidata |
|---|---|---|
| Offset (`extra_state`) | **0** (el −100 aceptado desaparece) | −100 |
| Objetivo del día | **2039** (el de antes del ajuste; sigue apuntando al snapshot de la aceptación) | 1939 |
| Propuesta / snapshot de aceptación | `accepted` / 1 | igual |
| `lastAdjustmentDecisionAt` | fecha de la aceptación (el cooldown sigue activo) | igual |
| Conflicto señalado | ninguno | `offset_overwrite_prevented`, `daily_goal_overwrite_prevented` |

El historial dice «ajuste aceptado» mientras el offset y el objetivo ya no lo reflejan, y V3.1 seguiría con cooldown activo sobre un ajuste que no existe.

### 1.3 Qué cubre C0 y qué no

| Cubierto por C0 | Fuera de C0 (declarado) |
|---|---|
| Offset adaptativo | Columnas decisionales del perfil (`goal`, `weight_kg`, `activity_level`…): siguen con «último escritor gana». La reproducción R2 muestra que un push obsoleto revierte un cambio legítimo de actividad. Es el mismo mecanismo que V4 necesita (revisión CAS del plan) → **C0b/C1** |
| Calibración (`adaptiveCalibrationStartedAt`, `lastTargetChangedAt`) y `lastCalculationEngineVersion` | Cualquier otra clave de `extra_state` (rutinas, ajustes, planificador…) |
| Objetivos diarios `nutrition_goals` | Peso, diario, inventario |
| Señalización de conflictos y reconciliación del estado local y de las escrituras pendientes | Idempotencia del RPC y propuestas V4 (C2) |

---

## 2. Modelo de propiedad

El principio: cada dato del estado de plan tiene **un propietario**, y la regla de fusión depende de qué *es* ese dato.

| Dato | Naturaleza | Propietario / regla | Cambio legítimo posible desde un push |
|---|---|---|---|
| `adaptiveKcalOffsetKcal` | Resultado de una decisión explícita, nunca de una edición de perfil (`types/index.ts`: «nunca lo escribe nada salvo aceptar una `AdjustmentProposal`») | **Escritor único: `fn_accept_nutrition_adjustment`**. Un push no puede cambiar un valor numérico ya almacenado | Ninguno |
| `adaptiveCalibrationStartedAt`, `lastTargetChangedAt` | Fecha de reinicio por un cambio de perfil relevante en *cualquier* dispositivo | **Fusión monótona**: gana la fecha mayor; nunca retrocede ni vuelve a `null` | Sí: un reinicio legítimo pone «hoy» ≥ la anterior |
| `lastCalculationEngineVersion` | Sello de transición de motor | Un valor ya almacenado no vuelve a `null` | Sí: un sello nuevo |
| `nutrition_goals` (fila del día) | **Caché derivada** de perfil + offset + preferencia + tipo de día | Solo se acepta si declara con qué offset se calculó (`basis_offset_kcal`) y coincide con el vigente. Sin base (cliente antiguo): una fila ya sellada con base no cambia | Sí: una edición legítima recalcula con el offset vigente |
| Conflictos | Informativos | Los inserta la guarda (o el cliente); sin autoridad. El usuario solo puede marcarlos como vistos | — |

Cambios legítimos preservados: (a) una edición de perfil en B se conserva (columnas, calibración posterior, objetivo recalculado tras reconciliar); (b) el offset de A no se pierde; (c) un reinicio de calibración legítimo avanza.

---

## 3. Diseño del servidor

Candidato ejecutable: `supabase/verification/plan-state-staleness/candidate-c0-guard.sql`.

### 3.1 Principio de la guarda: «nunca lanza, conserva, registra y devuelve lo almacenado»

Un push obsoleto no debe *fallar* en bucle: los clientes antiguos no saben tratar el error, el reintento reenviaría el mismo snapshot indefinidamente y el estado de sincronización quedaría en «error». La guarda **conserva** el valor protegido, **registra** el conflicto y la escritura termina con éxito devolviendo lo realmente almacenado. El cliente nuevo detecta la diferencia **comparando lo almacenado con lo enviado** (§5).

### 3.2 Piezas

| Pieza | Comportamiento |
|---|---|
| Trigger `BEFORE UPDATE` en `user_profiles` (`SECURITY INVOKER`) | Si la escritura la hace `authenticated`/`anon`: restaura el offset almacenado si el recibido difiere o falta; aplica fusión monótona a la calibración; impide que `lastCalculationEngineVersion` vuelva a nulo. Un valor «futuro» (>1 día por delante del servidor, p. ej. fecha simulada) **no** se protege |
| Trigger `BEFORE INSERT OR UPDATE` en `nutrition_goals` | Con `basis_offset_kcal` declarada: debe igualar el offset vigente del servidor, si no la fila se omite (INSERT) o se conserva (UPDATE). Sin base: no modifica una fila ya sellada con base |
| Columna `nutrition_goals.basis_offset_kcal` | Nullable; `NULL` = fila anterior o de un cliente que no la conoce |
| Tabla `nutrition_sync_conflicts` | `kind`, `subject`, `kept`, `attempted`, `acknowledged_at`; RLS «propias»; índice único parcial (mismo conflicto abierto no se duplica por reintentos) |
| `fn_accept_nutrition_adjustment` (misma firma) | Bloquea la fila de perfil; exige `p_new_offset_kcal = offset vigente + delta de la propuesta` (`OFFSET_MISMATCH`); sella el objetivo con `basis_offset_kcal`. **No** añade idempotencia (es C2) |

### 3.3 Por qué la excepción no es falsificable

La guarda se salta únicamente cuando `current_user` **no** es `authenticated`/`anon`. La aceptación es una función `SECURITY DEFINER` de propietario `postgres`: dentro de ella `current_user = postgres`. Un cliente solo controla qué rol selecciona su JWT (`authenticated`); no hay ningún parámetro, GUC ni cabecera que ponga `current_user` en otro rol. No existe «bandera de RPC» que el cliente pueda fijar. Límites honestos: lo reproducido en PGlite no puede demostrar que el cliente no suplante al propietario (su sesión es superusuario); es un argumento por semántica de PostgreSQL. Los registros de conflicto sí pueden ser insertados por el cliente: son informativos y no conceden nada.

### 3.4 Matriz de clientes

| Cliente | Offset | Calibración | Objetivo del día | Conflicto |
|---|---|---|---|---|
| Nuevo (envía base, compara lo almacenado, reconcilia) | Protegido | Protegida | Protegido y **autocorregido** (reescribe con la base correcta) | Visto y mostrado |
| Antiguo, vigente | Sin diferencia → no hay conflicto | igual | Sin base: si la fila ya está sellada y no cambia, pasa | Ninguno |
| Antiguo, obsoleto | Conservado | Conservada | **Fila sellada: conservada. Día sin fila o sin sellar: se escribe con el offset obsoleto** (residual §3.5) | Registrado; el cliente antiguo no lo muestra |

### 3.5 Residual documentado: cliente antiguo, día todavía sin sellar

Un cliente antiguo y obsoleto puede insertar la fila de un día que aún no tiene fila (o no sellada) con objetivos calculados con el offset obsoleto (reproducción S1/R3). No se resuelve en servidor sin inventar una heurística. Acotación: el cliente nuevo no lo hace; el conflicto de offset del mismo push queda registrado; la fila de hoy se reescribe al hidratar (recordTodayNutritionGoal). Alternativa (pendiente, C0-D3): correlacionar con un conflicto de offset abierto reciente y conservar la fila, con el coste de falsos positivos para clientes antiguos vigentes.

---

## 4. Rutas de escritura y por qué la guarda las cubre

| Camino | Efecto con la guarda |
|---|---|
| `pushState` normal | Cubierto por los dos triggers |
| `fn_accept_nutrition_adjustment` | Es el escritor legítimo; ahora verifica la aritmética del offset |
| Realtime → `onRefresh` → `pullState` | Solo lectura; reconcilia hacia el servidor (ya existente) |
| Reenvío de un pendiente tras recarga/aparcado (`restoreParked`, TTL 24 h) | Es el mismo `pushState`: cubierto; el cliente nuevo reconcilia al ver la diferencia |
| `seedDemo` (herramienta admin) | Construye estado desde el defecto: ahora el offset/calibración se conservan y se registra conflicto (efecto deseado) |
| Edición manual de `extra_state` en el panel de Supabase/rol de servicio | Fuera: `current_user` no es `authenticated` |

---

## 5. Diseño del cliente (no implementado; a revisar antes de C0)

### 5.1 Contrato cliente

1. **Enviar la base**: `pushState` incluye `basis_offset_kcal = profile.adaptiveKcalOffsetKcal ?? 0` en la fila de objetivos.
2. **No tratar el éxito de la escritura como confirmación del valor**: tras el upsert de `user_profiles` y de `nutrition_goals`, pedir `.select()` de las claves protegidas / de la fila y **comparar con lo enviado**. Cualquier diferencia ⇒ conflicto.
3. **Conflicto ⇒ reconciliar**, no reintentar.

### 5.2 Reconciliación (`reconcilePlanSlice`, función pura de estado)

Entrada: estado local `S` y trozo autoritativo del servidor `Σ = {offset, calibración, lastTargetChangedAt, engineVersion, objetivoDeHoy|null, conflictos abiertos}`.

1. `S.profile.adaptiveKcalOffsetKcal := Σ.offset` (el servidor manda; el local nunca es autoritativo para el offset).
2. `adaptiveCalibrationStartedAt`, `lastTargetChangedAt := max(local, Σ)`; `lastCalculationEngineVersion` solo si el servidor tiene valor.
3. **Nada más del perfil se toca**: las ediciones legítimas pendientes del usuario permanecen.
4. Recalcular `state.nutrition` y la entrada de HOY del ledger con la función existente `recordTodayNutritionGoal` (solo hoy; los días pasados nunca se reescriben).
5. Registrar un único aviso no bloqueante («otro dispositivo había ajustado tu plan; ya está al día») y marcar los conflictos vistos **después** de mostrarlo.
6. Reenviar con base correcta.

### 5.3 Escrituras pendientes

| Situación | Tratamiento |
|---|---|
| Push **en vuelo** | No se puede cancelar (`postgrest-js` sin `abortSignal`); la guarda del servidor lo cubre; su respuesta se compara (5.1.2) |
| Snapshot **en cola o reintento** (outbox) | Tras reconciliar, el estado reconciliado **sustituye** al pendiente con una mutación nueva (`recordMutation`, mismo mecanismo atómico de un solo `setItem`); el `compare-and-delete` por `mutationId` existente impide que el resultado de la mutación vieja borre la nueva |
| Pendiente **aparcado** (expulsión, TTL 24 h) | Al restaurarse recorre la hidratación normal: gana el pendiente, se envía, el servidor conserva, el cliente compara y reconcilia. No pierde el cambio legítimo del usuario |
| **Cambio de cuenta A→B** | Las comprobaciones de época existentes (`checkAlive`, `sessionIdentityChanged`) descartan el resultado; la reconciliación solo se aplica si el `userId`/época coinciden (R5) |
| **Respuesta perdida** de la aceptación | Hoy el cliente cree que falló y su siguiente push revierte lo confirmado (R4). Con C0 el servidor lo conserva y el cliente lo adopta al reconciliar; **el reintento sigue sin ser idempotente** (error `PROPOSAL_NOT_PENDING`) hasta C2 y la UI debe mostrar «puede que ya se haya aplicado; actualizando…» en vez de «no se pudo aplicar» |

### 5.4 Cambios previstos en archivos (a declarar antes de implementar)

`apps/web/src/lib/data-layer.ts` (`pushState`: base y comparación; `pullState`: conflictos abiertos), `apps/web/src/lib/state.tsx` (`reconcilePlanSlice` y su integración en la hidratación/push), nuevo `apps/web/src/lib/plan-state.ts` (puro), y como máximo un aviso en `NutritionView`. **No** `HomeView`, `DashboardShell` ni estilos.

---

## 6. Reproducciones

Procedimiento y límites: `supabase/verification/plan-state-staleness/README.md`. Resultados versionados en `results/`.

| Caso | Escenario | Vigente | Con guarda |
|---|---|---|---|
| **R1** | A acepta; B obsoleto registra un peso y sincroniza | offset 0, objetivo del día 2039, nueva cuenta lee offset 0 | −100, 1939, −100; conflictos offset + objetivo |
| **R2** | A reinicia calibración (cambio legítimo); B obsoleto sincroniza | calibración y `lastTargetChangedAt` → `null`; `activity_level` vuelve a `moderate` | calibración y fecha conservadas; **`activity_level` sigue revirtiéndose** (residual, §1.3) |
| **R3** | Cambio **legítimo** en B (actividad, calibración posterior) tras la aceptación de A | offset 0; cambio de B conservado | offset −100; cambio de B conservado; objetivo de hoy conservado; fila de un día nuevo escrita sin base (residual §3.5) |
| **R4** | Respuesta perdida tras confirmar; el mismo dispositivo sincroniza otra edición | cliente ve `ok:false`; reintento → `PROPOSAL_NOT_PENDING`; **su push revierte el offset ya confirmado** | offset conservado; reintento sigue sin ser idempotente |
| **R5** | Cambio de cuenta durante el push (sesión B, contexto de A; y época obsoleta) | push rechazado (RLS) y abortado; A y B sin cambios | igual |
| **S1** | Contrato de objetivos: base vigente / obsoleta / sin base sobre fila sellada / día nuevo con base obsoleta / día nuevo sin base | — | 1111 (vigente) · conservado · conservado · no se crea · **se crea (residual)** |
| **S2** | Escritura directa del offset por el cliente; aceptación con offset ≠ vigente+delta | — | offset conservado; `OFFSET_MISMATCH`; propuesta sigue pendiente |
| **S3** | Calibración «futura» no fijada para siempre | — | corregible |

### 6.1 Nivel de evidencia

| Nivel | Estado |
|---|---|
| Simulado (cliente real + backend falso) | Cubierto por las pruebas existentes de `data-layer.test.ts`; esta entrega no añade pruebas simuladas |
| **Una conexión**, esquema y función reales (PGlite) | **R1–R5, S1–S3 ejecutadas**, ambos modos |
| Concurrencia real | **Sin demostrar** (no hay Docker, `psql` ni Postgres local; ver bloqueos) |
| Cliente nuevo (§5) | **Sin demostrar** (no existe) |
| Navegador / cuentas QA / despliegue | **Sin demostrar** |

---

## 7. Decisiones propias de C0 (pendientes)

| Id | Decisión | Alternativas | Recomendación y efecto |
|---|---|---|---|
| C0-D1 | Ante conflicto: ¿conservar-y-registrar o rechazar con error? | a) conservar y registrar; b) `RAISE` con código | **a)**: no deja a clientes antiguos en bucle de reintento. Efecto: el cliente antiguo ve «guardado» y no sabe que no se aplicó |
| C0-D2 | Calibración | a) fusión monótona; b) servidor único escritor | **a)**: la fecha depende de ediciones de perfil que ocurren en cualquier dispositivo |
| C0-D3 | Residual de cliente antiguo con fila sin sellar | a) aceptarlo y acotarlo; b) correlacionar con conflicto abierto | **a)** + retirar clientes antiguos con el despliegue; b) da falsos positivos |
| C0-D4 | Conflictos informativos: ¿quién los inserta? | a) el propio trigger con permiso de inserción al cliente; b) función definer + sin permiso | **a)** por simplicidad (son informativos); b) si se quiere impedir ruido forjado |
| C0-D5 | Retención de conflictos | a) hasta marcar visto + 90 d; b) indefinida | **a)** (no es historial de usuario) |
| C0-D6 | Columnas decisionales del perfil | a) C0b: CAS por `plan_revision` solo con base enviada; b) dejarlo a C1 | **a)** en el mismo PR que C1 (necesita la misma revisión) |

---

## 8. Bloqueos concretos

1. **Sin concurrencia real**: no hay Docker ni Postgres con varias conexiones en este equipo. Para demostrar carreras (doble aceptación, aceptar/rechazar simultáneos, creación desde dos dispositivos) hace falta: (a) un Postgres local (contenedor o binarios) o (b) una **rama de base de datos** de Supabase. Ambas requieren autorización; no se ha instalado ni creado nada.
2. **Cliente nuevo no implementado**: §5 es diseño; su corrección (reconciliación, reescritura de la cola, aviso) solo se demuestra implementándolo, con pruebas de componente sobre el `FoodOSProvider` real.
3. **PostgREST real**: no se ha ejecutado; la emulación reproduce el SQL descrito en la documentación del propio repositorio. Una comprobación contra una rama de Supabase cerraría esto.
4. **Aprobación**: el candidato no debe promoverse a migración sin revisión; la función de aceptación se sustituye con la misma firma.
