# Decisiones — infraestructura de sincronización (rama `sync/outbox-session-safety`)

Este documento registra el diseño y las decisiones tomadas para la fase de
corrección de persistencia de FoodOS cuyo objetivo era garantizar que un
cambio del usuario no pueda perderse, sobrescribirse ni enviarse a otra
sesión cuando Supabase tarda, falla, el usuario recarga o cambia de cuenta.

El diseño se revisó en tres rondas antes de implementarse; lo que sigue es
el resultado final aprobado, no el historial completo de la discusión.

## Diagnóstico original (8 puntos, confirmados en código antes de diseñar)

1. La cola de push remoto vivía solo en memoria del singleton `RemoteAdapter`
   (`pushTimer`, `pushRetryTimer`, `pushing`, `pushQueued`) — una recarga o
   un fallo de red la perdía sin dejar rastro persistente.
2. `pagehide` solo vaciaba el debounce de `localStorage` (300 ms) — no
   existía una outbox ni una marca persistente de "cambio no confirmado".
3. `hydrateRemoteState()` podía tratar un snapshot remoto desactualizado
   como autoritativo y sobrescribir un cambio local todavía pendiente de
   confirmar.
4. `schedulePush()` devolvía silenciosamente si `!ready || !user` — un
   cambio podía quedar sin programar sin que nada lo indicara.
5. `signOut()` y los cambios de sesión no cancelaban `pushTimer` /
   `pushRetryTimer` / `pushQueued` ni las cachés en memoria.
6. **Severidad alta**: `pushState()` leía `this.user!.id` en el momento de
   EJECUTARSE, no al programarse. Si el usuario B iniciaba sesión mientras
   el push de A seguía en `pushTimer`/`pushRetryTimer`, el snapshot de A se
   escribía bajo el `user_id` de B — cruce real de datos entre cuentas.
7. El dashboard permitía seguir editando (`mutate()`) libremente durante la
   hidratación remota inicial.
8. Doble hidratación inicial: `onAuthChange` dispara con `INITIAL_SESSION`
   si ya hay sesión (comportamiento de `supabase-js`) y el código además
   llamaba a `hydrateRemote()` explícitamente justo después — dos
   `pullState()` concurrentes.

## Invariantes garantizados por este diseño

- **Un único `setItem` por escritura de estado pendiente.** El envelope
  (`{schemaVersion, userId, state, pending}`) vive en una sola clave de
  `localStorage` por usuario (`foodos-user-state-v2-<userId>`). Nunca hay
  dos claves separadas que puedan desacoplarse si el proceso muere entre
  dos escrituras.
- **`mutationId` (no `revision`) es la única clave de compare-and-delete.**
  `revision` solo sirve para orden/depuración; con dos pestañas podría
  colisionar. Borrar el `pending` de un usuario requiere que el
  `mutationId` coincida exactamente con lo que sigue en el envelope en ese
  momento — un push tardío de una mutación vieja nunca borra una más
  nueva.
- **`sessionEpoch` protege contra cruce de sesión (A→B).** Cada operación
  programada captura `{userId, epoch, mutationId, signal}` de forma
  inmutable en el momento de programarse. `pushState()` nunca lee
  `this.user`, solo el contexto que recibió explícitamente. `checkAlive()`
  revalida `signal.aborted || epoch !== sessionEpoch` entre cada tabla
  dentro de `pushState()`.
- **`activePush` con token identificado sustituye al booleano `pushing`.**
  Solo el código que ve `activePush.token === token` puede tocar
  cola/badge/outbox. `resetSessionState()` limpia `activePush`
  síncronamente al cambiar de sesión, así que la sesión nueva nunca tiene
  que esperar al `finally` de la sesión vieja para poder arrancar su propio
  push.
- **`LOCAL_KEY` nunca se importa automáticamente a una cuenta.** Si no
  existe un envelope para el `userId`, se hidrata desde Supabase. Migrar
  datos sin propietario a una cuenta requiere una decisión explícita del
  usuario, fuera del alcance de este módulo.
- **El envelope pendiente se escribe de forma síncrona, nunca con
  debounce**, para un usuario autenticado: `mutate()` → `writeEnvelope`
  síncrono → actualiza React → programa el push. `pagehide` queda como
  defensa adicional, no como el mecanismo principal.
- **Logout explícito centralizado en `requestSignOut()`.** Si hay cambios
  pendientes, se ofrece una decisión explícita (esperar y salir / cancelar
  / salir descartando) — nunca se cierra sesión en silencio con datos sin
  confirmar. Al completar un logout explícito (confirmado o con descarte
  explícito) se borra siempre el envelope completo de ese usuario en este
  dispositivo.
- **Expulsión involuntaria de sesión aparca el pendiente**, no lo
  descarta: `foodos-parked-v1-<userId>`, con TTL de 24 h
  (`PARKED_TTL_MS`), purgado al arrancar la app y restaurado solo si el
  mismo usuario vuelve a iniciar sesión en este dispositivo dentro del TTL.
- **El estado global "saved" (`confirmed` en la UI) agrega todas las
  fuentes de pendiente**: sin envelope con `pending`, sin push en
  curso/retry, y sin agua (`incrementWaterDurable`, ver la tercera ronda
  más abajo para su diseño actual — upsert absoluto, no RPC)
  pendiente/en error. Si el agua falla, el estado global nunca muestra
  "saved" aunque el resto del snapshot esté confirmado.
- **`savingsGoal`** se incluye ahora en `extra_state` tanto al escribir
  (`pushState`) como al leer (`pullState`) — antes se perdía en cada
  sincronización porque `pushState()` no lo escribía.
- **`TOKEN_REFRESHED` / `USER_UPDATED` / `SIGNED_IN` del mismo usuario no
  cancelan nada.** Solo un cambio real de usuario o `SIGNED_OUT`
  incrementa `sessionEpoch` (ver `classifyAuthTransition`). Un doble
  `signOut()` o un callback `SIGNED_OUT` repetido es idempotente.

## Segunda ronda — revisión del código real tras la primera implementación

Una revisión posterior, hecha sobre el diff real (no sobre el diseño),
encontró 8 puntos donde la primera implementación de esta rama no cumplía
todavía las garantías de arriba. Se corrigieron todos antes de abrir el PR
— quedan documentados aquí porque cambian invariantes que la primera
versión de este documento afirmaba sin que fueran ciertas todavía:

1. **El envelope activo no se aplicaba a React al recargar.** La UI
   pintaba `defaultState` (o el `LOCAL_KEY` antiguo) mientras
   `createHydrationCoordinator` reenviaba en segundo plano una mutación
   pendiente — si el usuario editaba en ese hueco, `mutate()` clonaba ese
   estado incompleto y sustituía el envelope correcto. Corregido con
   `resolveInitialStateForSession()`: aplica el envelope activo (o el
   recién restaurado desde el aparcado) a React de inmediato, antes de
   esperar a cualquier pull remoto.
2. **La cola de agua durable no era durable de verdad.** `waterQueue`
   vivía solo en memoria — una recarga mientras un reintento seguía
   pendiente la perdía sin dejar rastro. Corregido: cada cambio se
   persiste en disco (`foodos-water-pending-v1-<userId>`,
   `readWaterPending`/`writeWaterPending` en outbox.ts) y
   `resumePendingWaterFor()` lo recupera al iniciar/reanudar una sesión.
   (Nota: el mecanismo de reintento descrito aquí — "lee el remoto y
   calcula la diferencia" — se sustituyó por un upsert absoluto en la
   tercera ronda de revisión; ver más abajo.)
3. **Mutaciones de agua fuera de la RPC durable.** `SettingsView.clearToday()`,
   su deshacer y `seedHistorico()` escribían `waterLog` a través de
   `mutate()` genérico — pero `pushState()` excluye `water_log` a
   propósito (RPC atómica independiente, para evitar conflictos de
   concurrencia entre tabs), así que ese cambio nunca llegaba a Supabase
   aunque la outbox genérica se confirmara y el badge dijera "Guardado".
   Corregido: se añadió `setWaterAbsolute()` al contexto y los tres
   callsites lo usan en vez de tocar `draft.waterLog` dentro de `mutate()`.
4. **`deleteIfMatches()` podía informar éxito sin haber persistido el
   borrado.** Si `writeEnvelope()` fallaba (cuota de `localStorage`,
   fallo de serialización), la función devolvía `true` de todos modos.
   Corregido: solo devuelve `true` si el `mutationId` coincidía Y la
   escritura del borrado tuvo éxito real (`EnvelopeWriteResult.ok`).
5. **`restoreParked()` podía perder la única copia de un pendiente.**
   Borraba el aparcado ANTES de escribir el envelope activo — si esa
   escritura fallaba, no quedaba ni aparcado ni activo. Corregido: ahora
   escribe primero el activo y solo borra el aparcado si esa escritura
   tuvo éxito; si falla, el aparcado se conserva intacto para reintentar.
6. **Expulsión involuntaria sin `pending` dejaba el envelope indefinido.**
   `parkIfPending()` no hacía nada si no había nada pendiente, y nada más
   lo sustituía — un `FoodOSState` completo quedaba en `localStorage` sin
   TTL. Corregido con `resolveInvoluntaryLoss()`: aparca si hay pendiente
   (delega en `parkIfPending`), y si no lo hay, borra el envelope activo
   (ya sincronizado, sin razón para seguir en el dispositivo).
7. **`flushPendingOrTimeout()` ignoraba el agua y tenía una carrera.** Solo
   miraba la outbox genérica (nunca `hasPendingWater()`) y sustituía
   temporalmente `remote.onStatusChange` entero — arriesgando perder una
   confirmación que llegara entre leer el handler previo e instalar el
   propio, y pisando cualquier otro oyente instalado mientras tanto.
   Corregido: `RemoteAdapter.addStatusListener()` (nuevo) permite
   suscribirse SIN sustituir nada — `onStatusChange` sigue siendo el único
   canal de la UI principal, pero ahora hay un segundo mecanismo aditivo
   para utilidades internas. `flushPendingOrTimeout()` y la nueva
   `waitForMutationConfirmed()` (usada por la hidratación, ver el punto
   siguiente) lo usan, comprueban el agua además de la outbox, y
   vuelven a comprobar el estado justo tras suscribirse para cerrar la
   ventana de carrera.
8. **`hasPendingPush()` no veía el envelope persistido.** Solo miraba
   temporizadores en memoria — justo tras una recarga, todos arrancan en
   `null` aunque el envelope siga teniendo un `pending` real que todavía
   no se ha vuelto a programar, dejando una ventana en la que un refresco
   en tiempo real podía pisarlo. Corregido: `hasPendingPush()` y
   `hasPendingWater()` consultan también `outbox.hasPending()`/
   `outbox.readWaterPending()` cuando los temporizadores en memoria están
   vacíos.

## Tercera ronda — revisión del diseño de agua sobre el código real (esquema y RLS)

Una tercera revisión, hecha comprobando el esquema real de `water_log` y su
policy RLS (no solo el diseño en abstracto), encontró que la
implementación de agua de la segunda ronda todavía tenía dos P0 y varios P1:

1. **P0, severidad alta — el agua de A podía escribirse en la cuenta de
   B.** `processWaterQueue()` hacía `select` (filtrado por `op.userId`) y
   LUEGO llamaba a `fn_water_increment(delta)` — una RPC que usa
   `auth.uid()` internamente, ignorando el `userId` que se le pasaba. Si
   la sesión cambiaba de A a B mientras el `select` estaba en vuelo, la
   RPC se ejecutaba bajo `auth.uid() = B`, aplicando el delta de A a la
   cuenta de B — el mismo cruce A→B que este PR existe para eliminar,
   reintroducido por la RPC de agua. **Corregido de raíz**: se sustituyó
   `select + fn_water_increment(delta)` por un **upsert absoluto**
   (`{user_id, log_date, ml, updated_at}`, `onConflict: "user_id,log_date"`)
   con el `userId` explícito en el payload — la tabla `water_log` ya tiene
   `primary key (user_id, log_date)` y la policy `water_log_own` exige
   `user_id = auth.uid()` tanto para leer como para escribir. Si la sesión
   ya cambió a B cuando la petición sale, RLS **rechaza** la escritura
   (nunca se aplica ni como agua de A ni, mucho menos, como agua de B) —
   a diferencia de la RPC anterior, este cruce queda cerrado
   estructuralmente por la base de datos, no solo por una comprobación de
   epoch en el cliente (que se mantiene, como primera línea de defensa,
   inmediatamente antes Y después de cada `await`). Ningún cambio de
   esquema ni migración: la tabla y su policy ya lo permitían.
2. **P0 — leer-y-luego-incrementar no fijaba un objetivo absoluto de
   forma atómica.** Si otro dispositivo cambiaba el remoto ENTRE la
   lectura y el envío, el resultado final podía no ser el objetivo pedido
   (la reconciliación de la segunda ronda solo evitaba repetir el MISMO
   delta tras un fallo ambiguo, no garantizaba el objetivo final).
   **Corregido por el mismo cambio de diseño**: el upsert absoluto nunca
   lee el remoto antes de escribir — cada intento (el primero y cualquier
   reintento) fija `ml` al objetivo exacto, sin depender de lo que hubiera
   antes. Repetirlo tras cualquier fallo (ambiguo o no) es un no-op
   idempotente que siempre converge al objetivo pedido.
3. **P1 — `writeWaterPending()` ignoraba en silencio un fallo de
   persistencia.** Devolvía `void`; si `localStorage.setItem` fallaba
   (cuota, serialización), el caller no tenía forma de saberlo y podía
   seguir tratando la operación como "durable" sin serlo. Corregido:
   devuelve `WriteResult` (`{ok:true}|{ok:false,error}`); un fallo dispara
   `RemoteAdapter.onUnsyncedWrite()` (nuevo, mismo criterio que un fallo
   de `writeEnvelope()` en `mutate()`), forzando `SyncStatus === "unsynced"`
   hasta que una escritura posterior sí persista.
4. **P1 — el agua pendiente no tenía TTL en una expulsión involuntaria.**
   `resolveInvoluntaryLoss()` solo gestionaba el envelope genérico;
   `foodos-water-pending-v1-<userId>` quedaba indefinidamente tras una
   pérdida de sesión. Corregido con un aparcado PARALELO específico para
   el agua (`foodos-water-parked-v1-<userId>`, `parkWaterIfPending`/
   `restoreParkedWater`/`purgeExpiredParkedWater`/`discardParkedWater`),
   con el MISMO `PARKED_TTL_MS` y el mismo orden seguro
   (escribir-antes-de-borrar) que el envelope genérico, orquestado desde
   los mismos puntos de entrada únicos (`resolveInvoluntaryLoss()`,
   `signOut()`, el arranque de `FoodOSProvider`). Se mantiene como
   almacén SEPARADO (no fusionado en el mismo blob que el envelope)
   porque puede existir agua pendiente sin que exista ningún envelope
   activo todavía — forzar un `state: FoodOSState` para aparcar solo el
   agua habría exigido inventar un snapshot que no existe.
5. **P1 — las consultas de pendiente no eran por usuario.**
   `userIsFullyIdle(userId)` terminaba llamando a
   `remote.hasPendingWater()` (sin argumento — consulta la sesión
   VIGENTE, `this.user`), no necesariamente `userId`. Corregido con APIs
   explícitas por usuario: `hasPendingWaterFor(userId)`,
   `resumePendingWaterFor(userId)`, `pendingWaterTargetFor(userId, date)`
   — `flushPendingOrTimeout(userId)` y `waitForMutationConfirmed(userId, …)`
   ahora comprueban exactamente ese usuario, nunca la sesión activa por
   accidente.
6. **P1 — un evento de Realtime antiguo podía pisar temporalmente un
   objetivo local más nuevo.** El patch de `water_log` aplicaba siempre
   `newRow.ml` a React. Corregido: antes de aplicar, se comprueba
   `remote.pendingWaterTargetFor(userId, date)` — si hay un objetivo
   local todavía sin confirmar para esa fecha, el evento se ignora hasta
   que el upsert absoluto lo confirme (momento en el que React ya
   muestra ese valor, aplicado de forma optimista al programarlo).
7. **P1 — side effects dentro del updater de `setState`.**
   `setWaterAbsolute()`/`addWater()` llamaban a
   `remote.incrementWaterDurable()` DENTRO del updater — los updaters
   deben ser puros (Strict Mode puede invocarlos dos veces; renderizado
   concurrente puede descartar la invocación). Corregido: se extrajo
   `applyWaterTarget()` (pura, exportada y testeada de forma aislada) para
   el updater; el efecto externo (`remote.incrementWaterDurable`) se
   quedó fuera, en el cuerpo del callback, que React nunca reinvoca por su
   cuenta. Un `waterLogRef` sincronizado de forma SÍNCRONA (nunca solo vía
   `useEffect`, que llegaría un tick tarde) permite que `addWater()` lea
   el valor previo correcto aunque se llame varias veces seguidas en el
   mismo evento. `saveLocalStateDebounced()` se queda dentro del updater a
   propósito — es un debounce que coalesce, invocarlo de más es trabajo
   redundante, nunca una operación duplicada de verdad (a diferencia de la
   llamada de red/outbox, que si sale del updater).

Adicionalmente, la hidratación remota (`createHydrationCoordinator`) ya no
pide un pull remoto de inmediato cuando hay una mutación pendiente al
empezar (se iba a descartar igualmente) — ahora espera EXPLÍCITAMENTE a
que esa mutación se confirme (`waitForMutationConfirmed()`, con timeout) en
vez de depender de que un evento de Realtime dispare un pull posterior "por
casualidad". Y se implementó un listener de `storage` en `FoodOSProvider`
(propuesto en el diseño pero no implementado en la primera versión de esta
rama) que converge la UI de una pestaña al último envelope físicamente
escrito por OTRA pestaña del mismo usuario — ver la limitación de varias
pestañas más abajo para lo que esto SÍ y NO resuelve.

## Cuarta ronda — propiedad del worker de agua, confirmación seguida de fallo local, y varios P1

Una cuarta revisión, otra vez sobre el código real (no el diseño en
abstracto), encontró que el upsert absoluto de la tercera ronda todavía
tenía dos P0 relacionados con la CONCURRENCIA entre workers/sesiones, no
con la escritura remota en sí:

1. **P0 — propiedad incorrecta de `waterProcessing` entre sesiones.**
   `resetSessionState()` ponía `waterProcessing = false` incondicionalmente
   al cambiar de sesión (correcto: una sesión nueva no debe esperar a la
   anterior) — pero el WORKER antiguo de A, si seguía en vuelo, ejecutaba
   en su propio `finally` el MISMO `waterProcessing = false`, sin
   comprobar si esa bandera ya pertenecía al worker de una sesión B
   arrancada mientras tanto. Con un booleano compartido, el `finally` de A
   podía liberar la exclusión mutua de B mientras el upsert de B seguía en
   vuelo, permitiendo que una edición posterior de B arrancara un SEGUNDO
   worker concurrente — dos upserts absolutos de B completándose fuera de
   orden podían dejar en remoto el objetivo antiguo aunque la cola
   terminara vacía. **Corregido con el mismo patrón que `activePush`**
   (ver la segunda ronda): `activeWaterWorker: {token} | null` sustituye al
   booleano — todo acceso a `waterPending`/`waterHasError`/
   `waterRetryTimer`/`notifyStatus("error"|"saved")` desde dentro de un
   worker comprueba primero `activeWaterWorker?.token === token` (antes Y
   después de cada `await`), igual que `activePush.token` para el push
   genérico. `resetSessionState()` sigue liberando `activeWaterWorker`
   incondicionalmente (para que la sesión nueva nunca espere), pero el
   `finally` del worker viejo ya no puede pisarlo.
2. **P0 — confirmación remota seguida de fallo al limpiar la cola
   durable.** `processWaterQueue()` hacía upsert remoto → `waterPending.delete(date)`
   → `persistWaterPending()` (disco) — si el `removeItem`/`setItem` de
   disco fallaba, la operación ya había desaparecido del mapa EN MEMORIA
   sin que se programara ningún reintento; solo se disparaba
   `onUnsyncedWrite`. Si en disco quedaba un objetivo persistido antiguo,
   podía quedar ahí indefinidamente — y una recarga posterior
   (`resumePendingWaterFor()`) lo habría recuperado y podría haber
   REVERTIDO el agua remota al valor antiguo. **Corregido con rollback**:
   `persistWaterPending()` devuelve su `WriteResult`; si falla, la entrada
   se reinserta en `waterPending` (mismo objetivo, mismo `op`) y se lanza
   un error que reutiliza el MISMO camino de reintento que un fallo de
   upsert (idempotente: reenviar el mismo objetivo confirmado es un no-op
   seguro) — nunca se emite "saved" ni se pierde la intención mientras la
   cola durable no la refleje de verdad.

Y varios P1:

3. **`hadUnsyncedWrite` mezclaba fuentes independientes.** Un único
   booleano se limpiaba con CUALQUIER `recordMutation()` correcto —una
   escritura genérica exitosa podía borrar el aviso de un fallo durable
   del agua sin resolver. Corregido: `hadUnsyncedEnvelopeWrite` y
   `hadUnsyncedWaterWrite` por separado, combinados en una función PURA
   `computeSyncStatus()` (exportada y testeada aparte) — "unsynced" se
   mantiene mientras CUALQUIERA de las dos siga en `true`; cada fuente se
   limpia solo con su propio éxito. `RemoteAdapter.onUnsyncedWrite` pasó a
   notificarse en CADA intento de persistencia de agua (éxito o fallo, no
   solo el fallo) para que el flag del agua tenga su propia señal de
   "recuperado", sin depender de una escritura ajena.
4. **Validación de la cola de agua.** `readWaterPending()`/
   `restoreParkedWater()` aceptaban, vía cast, cualquier objeto JSON de
   disco. Corregido con `sanitizeWaterPendingByDate()`: cada entrada se
   valida (clave con forma `YYYY-MM-DD`, valor numérico finito, no
   negativo, por debajo de un límite superior generoso pero defensivo) y
   se descarta si no cumple, sin romper la lectura completa por una sola
   entrada corrupta; `restoreParkedWater()` además valida que `parkedAt`
   sea una fecha real antes de calcular el TTL contra ella.
5. **Límites de privacidad al cerrar sesión.** `discard()`/
   `discardWaterPending()`/`discardParkedWater()` tragaban cualquier fallo
   de `removeItem` pese a que el comentario afirmaba una garantía absoluta
   — en realidad era solo "mejor esfuerzo". Corregido: las tres devuelven
   `WriteResult`; `signOut()` agrega el resultado en `cleanupOk`, y
   `resolveSignOutChoice()`/`requestSignOut()` (state.tsx) avisan por
   toast si la limpieza local no se pudo confirmar, en vez de afirmar en
   silencio algo que no ocurrió.

Limpieza adicional de esta ronda: `incrementWaterDurable()` se renombró a
`setWaterTargetDurable()` (ya no incrementa — fija un objetivo absoluto);
se corrigió el comentario de `pushState()` que todavía decía que
`water_log` se gestiona "exclusivamente vía `fn_water_increment`" (esa RPC
ya no se usa, sustituida en la tercera ronda). **Nota sobre el alcance de
la verificación**: la garantía de que RLS rechaza un cruce A→B depende de
la policy real de Supabase — los tests de este archivo usan un cliente
Supabase FALSO (sin red) y comprueban el CONTRATO del lado del cliente
(el payload del upsert siempre lleva el `userId` capturado al programarse,
nunca `this.user` ambiente); no se ha ejecutado contra una base Postgres
real con la policy `water_log_own` activa. No se ha escrito en producción
ni ejecutado Supabase local para verificar esto en esta rama.

## Limitaciones residuales conocidas (deliberadas, documentadas, no resueltas en este PR)

- **Varias pestañas: se detecta y se converge la UI, pero no se resuelve
  del todo — NUNCA "no se pierden cambios" en este escenario.** Cada
  pestaña tiene su propio `clientId` (`sessionStorage`, no
  `localStorage`) y su propio `mutationId` por mutación, así que una
  pestaña nunca borra por error el `pending` de otra (ver
  `outbox.test.ts`, "dos pestañas... ninguna borra el pending de la
  otra"). El listener de `storage` hace que una pestaña que se quedó
  desactualizada vuelva a mostrar el último envelope físico en cuanto otra
  pestaña escribe — pero eso es una convergencia de LECTURA, no una
  resolución de conflicto de ESCRITURA: el último `setItem` físico sigue
  ganando en disco, y dos pushes completos de pestañas distintas pueden
  llegar a Supabase en cualquier orden — un cambio hecho en una pestaña
  puede perderse frente a otro hecho en paralelo en otra. No hay bloqueo
  entre pestañas (`navigator.locks` ni equivalente) en este PR — es la
  fase siguiente natural si se necesita una resolución real (p.ej.
  versión optimista en servidor). No se presenta ni debe presentarse este
  sistema como si "nunca perdiera cambios" en el escenario de varias
  pestañas — la garantía real es únicamente "una pestaña nunca borra el
  pending de otra por error".
- **Push parcial posible sin cancelación real de red.** La versión de
  `postgrest-js` en uso no expone un `.abortSignal()` encadenable en las
  llamadas de este proyecto, así que cuando `sessionEpoch` cambia durante
  un push en vuelo, la petición de red que ya salió puede seguir
  completándose en el servidor — lo que se garantiza es que el **resultado**
  se descarta siempre (vía el token de `activePush` y `checkAlive()`), no
  que la escritura de red se cancele a mitad de camino. Nunca se escribe
  bajo el `userId` incorrecto porque `pushState()` recibe el `userId` como
  parte de un contexto inmutable, nunca lo relee de `this.user`.
- **Política de conflicto multidispositivo: "gana el último local sin
  confirmar", no una fusión real.** Si el mismo usuario edita desde otro
  dispositivo mientras hay algo pendiente en este, el pendiente local de
  este dispositivo se sigue enviando tal cual al reconectar — no hay
  detección de conflicto entre dispositivos distintos (solo entre pestañas
  del mismo dispositivo, y solo para no perder datos, no para fusionarlos).

## Quinta ronda — envelope aparcado en el logout, aparcados huérfanos, flags por sesión

Una quinta revisión encontró 4 P1 y 1 P2 más, todos sobre el código real:

1. **El logout no eliminaba el envelope GENÉRICO aparcado.** `signOut()`
   borraba el envelope activo, el agua activa y el agua aparcada, pero
   nunca `foodos-parked-v1-<userId>` — no existía un `discardParked()`
   equivalente a `discardParkedWater()`. Un logout explícito tras una
   expulsión involuntaria anterior nunca resuelta podía dejar un
   `FoodOSState` completo aparcado pese a "cerrar sesión limpiando todo".
   **Corregido**: `outbox.discardParked(userId)` nuevo; `signOut()` ahora
   intenta borrar las CUATRO claves posibles (envelope activo, envelope
   aparcado, agua activa, agua aparcada) y `cleanupOk` es `false` si
   cualquiera falla.
2. **Un aparcado antiguo podía reaplicarse y revertir datos
   posteriores.** Tanto `restoreParked()` como `restoreParkedWater()`
   escribían primero la clave activa y luego borraban la aparcada — si la
   escritura activa funcionaba pero el `removeItem()` del aparcado
   fallaba, quedaban las DOS copias vivas. En una sesión posterior, esa
   copia aparcada "huérfana" podía restaurarse OTRA VEZ y sobrescribir un
   estado/objetivo más reciente. **Corregido con una regla de seguridad
   nueva**: si YA existe una copia ACTIVA válida, un aparcado nunca la
   sobrescribe ciegamente — solo rellena un hueco vacío. Ambas funciones
   devuelven ahora `RestoreResult<T> = {value, cleanupOk}` en vez de
   `T | null`, para que el caller sepa si quedó una copia aparcada
   obsoleta sin limpiar (inofensiva a partir de la regla de arriba, pero
   el caller debe saberlo).
3. **`hadUnsyncedEnvelopeWrite`/`hadUnsyncedWaterWrite` no estaban
   aislados por sesión.** Eran booleanos globales del provider — si A
   sufría un fallo durable y la sesión cambiaba a B, B aparecía como
   "unsynced" desde el primer instante sin haber fallado nada él mismo, y
   podía quedarse así hasta hacer su propia operación de esa fuente (un
   guardado genérico de B no limpia el flag de agua, por diseño de la
   cuarta ronda). **Corregido**: ambos flags se reinician en CADA cambio
   REAL de sesión (`classifyAuthTransition() === "real_change"` — login,
   logout, cambio de cuenta), nunca en un `TOKEN_REFRESHED`/
   `USER_UPDATED`/`SIGNED_IN` del mismo usuario. El estado persistido
   (outbox/agua aparcada o pendiente) es quien de verdad lleva la cuenta
   de qué sigue sin confirmar entre sesiones — este flag es solo un aviso
   efímero de UI y no debe sobrevivir al límite de una sesión.
4. **El resultado de `auth.signOut()` se ignoraba.** `remote.signOut()`
   devuelve `{error, cleanupOk}`, pero `requestSignOut()`/
   `resolveSignOutChoice()` solo miraban `cleanupOk` y siempre devolvían
   "signed_out" aunque Supabase hubiera devuelto un error al cerrar
   sesión remotamente. **Corregido**: `SignOutOutcome` ahora incluye
   `authError` por separado de `cleanupOk` (son dos fallos
   independientes: uno es limpieza LOCAL, el otro es el cierre REMOTO);
   `reportSignOutIssues()` avisa de cada uno con un mensaje DISTINTO,
   nunca los mezcla en un toast genérico que sugiera "todo salió bien".
   El estado LOCAL de la app se sigue tratando como desconectado
   incondicionalmente (`remote.user = null` ya se aplica dentro de
   `signOut()` antes de llamar a `auth.signOut()` — decisión de diseño ya
   existente de rondas anteriores, no revisada en esta) — lo que cambia
   es que la UI ya no lo presenta como un éxito sin matices si el
   servidor no lo confirmó.
5. **P2 — validación incompleta del agua.** `DATE_KEY_RE` solo comprobaba
   la FORMA `YYYY-MM-DD`, aceptando fechas imposibles como `2026-99-99` o
   `2026-02-30`; también aceptaba decimales aunque `water_log.ml` sea
   `integer`. **Corregido**: `isValidCalendarDateKey()` reconstruye la
   fecha con `Date.UTC` y comprueba que año/mes/día no cambiaron (rechaza
   cualquier fecha que JS "normalizaría" silenciosamente);
   `isValidWaterTarget()` exige `Number.isInteger`. La MISMA validación se
   aplica ahora también en `setWaterTargetDurable()` (la entrada PÚBLICA,
   no solo al leer `localStorage`) — un `NaN`/`Infinity`/decimal/fecha
   imposible se rechaza con un aviso, sin encolarse. `parkedAt` también
   rechaza un futuro implausible (tolerancia de reloj de 5 minutos) en
   vez de aceptarlo como "recién aparcado" con un TTL negativo.

Verificación de regresión de los dos P1 principales de "aparcado huérfano":
la regla de seguridad "nunca sobrescribir un activo existente" se retiró
temporalmente en `restoreParked()` y en `restoreParkedWater()` por
separado — en ambos casos el test dedicado (secuencia exacta: aparcar →
fallo de `removeItem()` en la restauración → el activo evoluciona → una
restauración posterior) falló, confirmando que revertía el valor más
reciente al antiguo — y se restauró.

## Sexta ronda — el logout ya no podía informar falsamente "sesión cerrada"

1. **P1 bloqueante — se informaba "sesión cerrada" aunque `auth.signOut()`
   fallara.** `remote.signOut()` hacía `resetSessionState()`/
   `this.user = null` y borraba las cuatro claves ANTES de llamar a
   `auth.signOut()` — confirmado contra `@supabase/auth-js`: `_signOut()`
   devuelve el error ANTES de ejecutar `_removeSession()` para errores
   que no sean los casos explícitamente ignorados, así que la sesión
   persistida en Supabase podía sobrevivir a una recarga pese a que la
   app ya se había puesto a sí misma en "sin sesión". `AccountModal`/
   `SettingsView` además mostraban su toast de éxito para CUALQUIER
   resultado que no fuera `"cancelled"`, incluido un fallo real.
   **Corregido**: `remote.signOut()` llama a `auth.signOut()` PRIMERO; si
   falla, no toca `resetSessionState()`, `this.user`, ni las cuatro
   claves — devuelve `{ok: false, error, cleanupOk: true}` y la sesión
   sigue activa, reintentable. `SignOutOutcome.status` gana
   `"sign_out_failed"` (nunca `"signed_out"` en ese caso);
   `requestSignOut()` devuelve `"failed"` y muestra «No se pudo cerrar la
   sesión. Comprueba la conexión e inténtalo de nuevo.». Los dos
   callsites de UI ahora hacen `if (result !== "signed_out") return;` —
   ni cierran el modal ni muestran el toast de éxito para `"cancelled"`
   ni para `"failed"`.
2. **P1 — el purgado global no rechazaba `parkedAt` inválido o futuro.**
   `restoreParked()`/`restoreParkedWater()` ya usaban
   `isPlausibleParkedAt()` (quinta ronda), pero `purgeExpiredParked()`/
   `purgeExpiredParkedWater()` seguían comparando solo
   `now - parkedAt > PARKED_TTL_MS` — un `parkedAt` corrupto (`NaN`) o
   futuro (diferencia negativa) nunca superaba ese umbral, así que un
   aparcado así podía quedar indefinidamente en un dispositivo
   compartido si ese usuario nunca volvía a iniciar sesión (el único
   momento en que `restoreParked()` sí lo habría validado). **Corregido**:
   ambos purgados aplican ahora `isPlausibleParkedAt()` también.
3. **P2 — la validación remota ocurría después de modificar el estado
   local.** `setWaterTargetDurable()` validaba correctamente, pero
   `setWaterAbsolute()`/`addWater()` en `state.tsx` ya habían tocado
   `waterLogRef`, el estado de React y `LOCAL_KEY` antes de llegar ahí —
   un `NaN` o un decimal podía quedar visible localmente mientras la
   escritura remota se descartaba en silencio. **Corregido**: la MISMA
   validación (`outbox.isValidCalendarDateKey`/`isValidWaterTarget`) se
   aplica ahora en el PUNTO DE ENTRADA del contexto — antes de tocar el
   ref, `setState`, o `saveLocalStateDebounced` — así que el mismo valor
   se acepta o se rechaza simultáneamente para local y remoto. Limitación
   reconocida: no hay `@testing-library` en este proyecto para renderizar
   `FoodOSProvider` y comprobar en tiempo de ejecución que el ref/estado
   de React de verdad no cambian — la garantía se apoya en que la
   validación es la PRIMERA sentencia ejecutable de ambos callbacks
   (verificado por inspección directa del código, no por un test que
   renderice el hook).

Verificación de regresión: el reordenamiento de `signOut()` se revirtió
temporalmente (limpiar antes de conocer el resultado) — el test dedicado
detectó que `remote.user` se ponía a `null` pese al error, confirmando el
bug — y se restauró. Los dos guards de `isPlausibleParkedAt()` en los
purgados se retiraron por separado — en ambos casos el aparcado
corrupto/futuro sobrevivía al purgado — y se restauraron.

## Alcance deliberadamente fuera de este PR

Documentado para PRs futuros, sin implementar aquí:

- UX del bloqueo por procedencia del `%` graso en Nutrición
  (`fix/nutricion-bodyfat-source-error`, ya fusionada como PR #122 en una
  fase anterior; el test de `bodyFatSource` queda pendiente como deuda de
  UX en un PR pequeño aparte).
- Errores sin comprobar en `ensureBaseRows` (`almacen_members`, selects).
- Sincronización destructiva por snapshot completo en escenarios
  multidispositivo (ver limitación residual arriba).
- Errores silenciosos en `saveNutritionSnapshot`.
- Suite de integración dedicada a Supabase Auth + RLS.
- Resolución real de conflicto entre pestañas (bloqueo o versión de
  servidor), más allá de la detección actual.
