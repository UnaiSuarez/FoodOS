import type { FoodOSState } from "@foodos/types";

// ─── Outbox de sincronización — v2, envelope atómico (ver docs/SYNC_DECISIONES.md) ──
//
// Un cambio del usuario nunca debe poder perderse, sobrescribirse ni
// enviarse a otra sesión cuando Supabase tarda, falla, el usuario recarga o
// cambia de cuenta. Este módulo es la ÚNICA fuente de verdad de "qué hay
// pendiente de confirmar" — nunca se reconstruye a partir de LOCAL_KEY ni de
// ningún otro estado en memoria.
//
// Diseño (revisión de 3 rondas, ver conversación de diseño):
// - UNA sola clave de localStorage por usuario contiene estado + metadatos
//   pendientes en el MISMO objeto — un único setItem, nunca dos claves que
//   deban mantenerse sincronizadas manualmente (eso fue un bloqueante
//   explícito de la ronda 2 del diseño: dos claves separadas permiten que
//   metadatos y payload queden desacoplados si el proceso muere entre las
//   dos escrituras).
// - `mutationId` (crypto.randomUUID()) es la ÚNICA clave de comparación
//   para "compare-and-delete" al confirmar un push — NUNCA `revision`
//   (revision solo sirve para orden/depuración, y con dos pestañas podría
//   colisionar; mutationId no).
// - `LOCAL_KEY` (el estado de antes de este cambio, sin dueño identificado)
//   NUNCA se copia automáticamente a la outbox de un usuario — ver
//   `readEnvelope`: si no existe la clave, devuelve null, punto. Migrar
//   datos sin propietario a una cuenta requiere una decisión explícita del
//   usuario, fuera de alcance de este módulo.

export interface OutboxPending {
  mutationId: string;
  /** Solo para orden/depuración — NUNCA se usa como clave de borrado. */
  revision: number;
  queuedAt: string;
  clientId: string;
}

export interface PersistedUserEnvelope {
  schemaVersion: 2;
  userId: string;
  state: FoodOSState;
  pending: OutboxPending | null;
}

interface ParkedEnvelope extends PersistedUserEnvelope {
  parkedAt: string;
  reason: "involuntary_session_loss";
}

export type EnvelopeWriteResult =
  | { ok: true; envelope: PersistedUserEnvelope }
  | { ok: false; error: unknown };

const ENVELOPE_PREFIX = "foodos-user-state-v2-";
const PARKED_PREFIX = "foodos-parked-v1-";
/** TTL del aparcado por expulsión involuntaria de sesión — ver §4 del
    diseño. Nunca indefinido: un dispositivo compartido no debe conservar
    datos personales de una cuenta más allá de este plazo. */
export const PARKED_TTL_MS = 24 * 60 * 60 * 1000;
/** Tolerancia de reloj para `parkedAt` — corrección de revisión (P2): un
    `parkedAt` en el futuro (reloj de sistema mal ajustado, o un valor
    corrupto/manipulado) daba un TTL negativo que el chequeo `> PARKED_TTL_MS`
    aceptaba como "recién aparcado" en vez de rechazarlo. Una pequeña
    tolerancia evita falsos rechazos por relojes ligeramente desincronizados
    entre el momento de aparcar y el de comprobar, sin dejar pasar un
    `parkedAt` claramente absurdo. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** `parkedAt` es una fecha ISO válida y no está en un futuro implausible
    (más allá de la tolerancia de reloj). Compartido por restoreParked()/
    restoreParkedWater(). */
function isPlausibleParkedAt(parkedAt: string): boolean {
  const t = new Date(parkedAt).getTime();
  if (Number.isNaN(t)) return false;
  return t <= Date.now() + CLOCK_SKEW_TOLERANCE_MS;
}

/** Exportada para que otros módulos (p.ej. el listener de `storage` entre
    pestañas en state.tsx) puedan reconocer si una clave de localStorage
    corresponde al envelope de un usuario concreto, sin duplicar el prefijo. */
export function envelopeKey(userId: string): string {
  return `${ENVELOPE_PREFIX}${userId}`;
}
function parkedKey(userId: string): string {
  return `${PARKED_PREFIX}${userId}`;
}

function isValidEnvelope(parsed: unknown, userId: string): parsed is PersistedUserEnvelope {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    (parsed as PersistedUserEnvelope).schemaVersion === 2 &&
    (parsed as PersistedUserEnvelope).userId === userId
  );
}

/** Lee el envelope del usuario dado. null si no existe o está corrupto —
    NUNCA cae de vuelta a LOCAL_KEY ni a datos de otro usuario. */
export function readEnvelope(userId: string): PersistedUserEnvelope | null {
  try {
    const raw = localStorage.getItem(envelopeKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isValidEnvelope(parsed, userId) ? parsed : null;
  } catch {
    return null;
  }
}

/** Única función que escribe el envelope — siempre un solo `setItem` con
    estado+pendiente juntos. Nunca debilitar esto con un debounce que separe
    ambos campos en el tiempo (ver comentario del módulo). */
export function writeEnvelope(
  userId: string,
  updater: (current: PersistedUserEnvelope) => PersistedUserEnvelope,
): EnvelopeWriteResult {
  try {
    const current = readEnvelope(userId) ?? {
      schemaVersion: 2 as const,
      userId,
      state: null as unknown as FoodOSState,
      pending: null,
    };
    const next = updater(current);
    localStorage.setItem(envelopeKey(userId), JSON.stringify(next));
    return { ok: true, envelope: next };
  } catch (error) {
    console.warn("FoodOS: no se pudo escribir el envelope de sincronización", error);
    return { ok: false, error };
  }
}

/** Registra una mutación nueva: sustituye `state` y crea un `pending` nuevo
    con un `mutationId` propio. Llamar SIEMPRE de forma síncrona desde
    mutate() — nunca en un debounce (ver diseño §2, corrección obligatoria). */
export function recordMutation(userId: string, state: FoodOSState, clientId: string): EnvelopeWriteResult {
  return writeEnvelope(userId, (env) => ({
    schemaVersion: 2,
    userId,
    state,
    pending: {
      mutationId: crypto.randomUUID(),
      revision: (env.pending?.revision ?? 0) + 1,
      queuedAt: new Date().toISOString(),
      clientId,
    },
  }));
}

/** Compare-and-delete: borra `pending` solo si sigue siendo EXACTAMENTE esa
    `mutationId` para ese usuario. Si mientras tanto apareció una mutación
    más reciente (mutationId distinto), no hace nada y devuelve false — esa
    mutación más nueva sigue pendiente y su propio push se encargará. */
export function deleteIfMatches(userId: string, mutationId: string): boolean {
  const current = readEnvelope(userId);
  if (!current || current.pending?.mutationId !== mutationId) return false;
  // Corrección de revisión (P1): antes se devolvía `true` con solo haber
  // INTENTADO el borrado — si writeEnvelope() fallaba (cuota de
  // localStorage, fallo de serialización), `pending` seguía en disco pero
  // el caller ya creía confirmado el push y podía emitir "saved". Ahora
  // solo cuenta como borrado real si la escritura tuvo éxito de verdad.
  const result = writeEnvelope(userId, (env) => ({ ...env, pending: null }));
  return result.ok;
}

export function hasPending(userId: string): boolean {
  return readEnvelope(userId)?.pending != null;
}

/** Logout explícito confirmado (o descarte explícito): borra TODO el
    envelope de este usuario en este dispositivo, exista o no `pending` —
    la INTENCIÓN es que un logout explícito nunca deje datos personales
    atrás (§4), pero `localStorage.removeItem` puede fallar (cuota,
    almacenamiento bloqueado) — corrección de revisión (P1): antes esto
    se ignoraba en silencio, así que la garantía era solo "mejor
    esfuerzo" pese a lo que decía el comentario. Ahora devuelve el
    resultado para que el caller (signOut() en data-layer.ts) pueda saber
    si de verdad se limpió y avisar en vez de afirmar algo que no ocurrió. */
export function discard(userId: string): WriteResult {
  try {
    localStorage.removeItem(envelopeKey(userId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Borra el envelope genérico APARCADO de `userId` (`foodos-parked-v1-`),
    no el activo — corrección de revisión (P1, quinta ronda): signOut()
    borraba el envelope activo, el agua activa y el agua aparcada, pero NO
    esta clave. Un logout explícito tras una expulsión involuntaria
    anterior nunca resuelta podía dejar un FoodOSState completo aparcado
    en el dispositivo pese a haber "cerrado sesión limpiando todo". */
export function discardParked(userId: string): WriteResult {
  try {
    localStorage.removeItem(parkedKey(userId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Resuelve la pérdida de sesión INVOLUNTARIA (expulsión, token inválido —
    nunca un signOut() explícito, que ya descarta por su cuenta): si había
    algo pendiente, lo aparca con TTL (parkIfPending) para poder
    recuperarlo si el mismo usuario vuelve a este dispositivo; si NO había
    nada pendiente, el envelope activo (ya completamente sincronizado) no
    tiene ninguna razón para seguir en este dispositivo y se borra —
    corrección de revisión (P1): antes, una expulsión SIN pending no
    tocaba nada, así que un FoodOSState completo quedaba en localStorage
    sin TTL, contradiciendo la garantía de privacidad del diseño. */
export function resolveInvoluntaryLoss(userId: string): void {
  if (hasPending(userId)) {
    parkIfPending(userId);
  } else {
    discard(userId);
  }
  // Misma política para el agua pendiente (P1) — almacén separado, ver el
  // comentario grande junto a parkWaterIfPending: aparca con TTL si había
  // algo, no hace nada si no (no hay nada que "descartar" explícitamente
  // aquí porque parkWaterIfPending ya deja la clave vacía/inexistente).
  parkWaterIfPending(userId);
}

// ─── Aparcado temporal por expulsión involuntaria de sesión ────────────────

/** Se llama SOLO cuando la sesión termina sin que la haya iniciado
    requestSignOut() (token inválido, expulsión desde otro dispositivo...).
    Si había algo pendiente, lo copia a una clave por usuario con TTL y
    limpia el envelope activo — nunca dos copias vivas del mismo pendiente. */
export function parkIfPending(userId: string): void {
  const current = readEnvelope(userId);
  if (!current?.pending) return;
  try {
    const parked: ParkedEnvelope = {
      ...current,
      parkedAt: new Date().toISOString(),
      reason: "involuntary_session_loss",
    };
    localStorage.setItem(parkedKey(userId), JSON.stringify(parked));
    localStorage.removeItem(envelopeKey(userId));
  } catch (error) {
    console.warn("FoodOS: no se pudo aparcar el envelope pendiente", error);
  }
}

/** Resultado enriquecido de una restauración desde aparcado — corrección
    de revisión (P1, quinta ronda): antes `restoreParked()` devolvía solo
    `PersistedUserEnvelope | null`, sin forma de distinguir "no había nada
    que restaurar" de "había algo pero no se pudo limpiar del todo".
    `cleanupOk` es `true` cuando no queda ninguna copia aparcada obsoleta
    sin limpiar tras la llamada (incluye el caso "no había nada"); `false`
    si quedó una copia aparcada que no se pudo borrar — el caller no debe
    darse por completamente resuelto en ese caso. */
export interface RestoreResult<T> {
  value: T | null;
  cleanupOk: boolean;
}

/** Al volver a iniciar sesión como este mismo usuario: si hay un aparcado
    vigente (dentro del TTL), lo restaura como envelope activo y lo borra de
    la zona de aparcado. Nunca se aplica a un usuario distinto del que lo
    generó. Vencido el TTL, se descarta sin restaurar (purgeExpiredParked ya
    debería haberlo limpiado en el arranque, esto es una red de seguridad).
    Corrección de revisión (P1, quinta ronda) — regla de seguridad nueva:
    si YA existe un envelope ACTIVO válido para este usuario, un aparcado
    NUNCA lo sobrescribe ciegamente. Sin esta regla, un aparcado que
    quedara "huérfano" (p.ej. porque un intento de restauración anterior
    escribió el activo con éxito pero el removeItem() del aparcado falló,
    dejando las dos copias vivas) podía reaplicarse en una sesión
    POSTERIOR y revertir datos más recientes a un estado más antiguo — el
    activo existente es siempre la fuente de verdad más reciente para
    este dispositivo, el aparcado solo debe rellenar un hueco vacío. */
export function restoreParked(userId: string): RestoreResult<PersistedUserEnvelope> {
  try {
    const raw = localStorage.getItem(parkedKey(userId));
    if (!raw) return { value: null, cleanupOk: true };
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isValidEnvelope(parsed, userId) || !("parkedAt" in parsed) ||
      typeof (parsed as { parkedAt: unknown }).parkedAt !== "string" ||
      !isPlausibleParkedAt((parsed as { parkedAt: string }).parkedAt)
    ) {
      // Corrupto, de otro usuario, o con un parkedAt implausible (no es
      // fecha válida, o está en un futuro más allá de la tolerancia de
      // reloj — P2): no hay nada recuperable, se limpia.
      const cleanupOk = safeRemoveItem(parkedKey(userId));
      return { value: null, cleanupOk };
    }
    const parked = parsed as ParkedEnvelope;
    if (Date.now() - new Date(parked.parkedAt).getTime() > PARKED_TTL_MS) {
      // Vencido: se descarta sin restaurar, pero SÍ se limpia — dejarlo
      // sería la misma fuga de privacidad que purgeExpiredParked() evita.
      const cleanupOk = safeRemoveItem(parkedKey(userId));
      return { value: null, cleanupOk };
    }

    // Regla de seguridad: nunca sobrescribir un activo ya existente.
    if (readEnvelope(userId)) {
      const cleanupOk = safeRemoveItem(parkedKey(userId));
      if (!cleanupOk) {
        console.warn("FoodOS: había un aparcado obsoleto junto a un envelope activo, pero no se pudo limpiar — el activo NO se tocó (regla de seguridad, nunca se sobrescribe ciegamente)");
      }
      return { value: null, cleanupOk };
    }

    const restored: PersistedUserEnvelope = {
      schemaVersion: 2,
      userId: parked.userId,
      state: parked.state,
      pending: parked.pending,
    };
    // Corrección de revisión (P1): antes se borraba el aparcado ANTES de
    // escribir el envelope activo — si esa escritura fallaba (cuota,
    // serialización), se perdía la ÚNICA copia (ni aparcada ni activa).
    // Ahora el orden es: validar → escribir el activo → solo si tuvo éxito,
    // borrar el aparcado. Si la escritura del activo falla, el aparcado
    // permanece intacto y esta función devuelve null (recuperable en un
    // intento posterior) en vez de fingir una restauración que no llegó a
    // persistirse. Si la escritura del activo SÍ tiene éxito pero el
    // removeItem() del aparcado falla, la restauración en sí es válida
    // (se devuelve el envelope) pero cleanupOk:false avisa de que quedó
    // una copia aparcada obsoleta — inofensiva a partir de aquí gracias a
    // la regla de arriba (nunca se sobrescribirá el activo que se acaba
    // de escribir), pero el caller debe saber que la limpieza no se
    // completó del todo.
    const written = writeEnvelope(userId, () => restored);
    if (!written.ok) {
      console.warn("FoodOS: no se pudo restaurar el envelope aparcado — se conserva aparcado para reintentar", written.error);
      return { value: null, cleanupOk: false };
    }
    const cleanupOk = safeRemoveItem(parkedKey(userId));
    if (!cleanupOk) {
      console.warn("FoodOS: el envelope se restauró correctamente pero no se pudo limpiar la copia aparcada — quedará ignorada en el futuro (nunca sobrescribe un activo existente)");
    }
    return { value: restored, cleanupOk };
  } catch {
    return { value: null, cleanupOk: false };
  }
}

/** `localStorage.removeItem` que nunca lanza — devuelve si de verdad tuvo
    éxito (o si la clave ya no existía, que es el mismo resultado deseado). */
function safeRemoveItem(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Se llama una vez al arrancar la app: borra cualquier aparcado de
    cualquier usuario que ya haya superado el TTL — nunca queda un snapshot
    completo de otra cuenta indefinidamente en un dispositivo compartido. */
export function purgeExpiredParked(): void {
  try {
    const now = Date.now();
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PARKED_PREFIX)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as ParkedEnvelope | null;
        // Corrección de revisión (P1, sexta ronda): antes solo comparaba
        // `now - parkedAt > PARKED_TTL_MS` — un `parkedAt` corrupto (NaN)
        // o implausiblemente futuro (diferencia negativa) NUNCA superaba
        // ese umbral, así que el purgado global lo dejaba pasar
        // indefinidamente en un dispositivo compartido si ese usuario no
        // volvía a iniciar sesión (restoreParked() sí lo validaba, pero
        // purgeExpiredParked() es el único que actúa sin que nadie inicie
        // sesión como ese usuario). isPlausibleParkedAt() ya rechaza
        // ambos casos, no solo el vencimiento normal.
        if (!parsed?.parkedAt || !isPlausibleParkedAt(parsed.parkedAt) || now - new Date(parsed.parkedAt).getTime() > PARKED_TTL_MS) {
          toRemove.push(key);
        }
      } catch {
        toRemove.push(key);
      }
    }
    toRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* localStorage no disponible (SSR) — nada que purgar */
  }
}

// ─── Objetivos de agua pendientes (corrección de revisión, P0) ─────────────
// La cola de agua durable (RemoteAdapter.waterPending, ver data-layer.ts)
// vivía SOLO en memoria: una recarga o el cierre de la pestaña mientras un
// reintento seguía pendiente la perdía sin dejar rastro. Este pequeño
// almacén, con la misma disciplina de "un solo setItem" por usuario que el
// envelope principal, hace que sobreviva a una recarga: se escribe cada vez
// que cambia el conjunto de fechas pendientes y se relee al iniciar/
// reanudar la sesión (resumePendingWater() en data-layer.ts). Guarda el
// OBJETIVO absoluto por fecha (no un delta) — ver el diseño de
// setWaterTargetDurable() para por qué eso hace que reintentar sea seguro
// sin duplicar mililitros.
const WATER_PENDING_PREFIX = "foodos-water-pending-v1-";
function waterPendingKey(userId: string): string {
  return `${WATER_PENDING_PREFIX}${userId}`;
}

/** fecha (YYYY-MM-DD) → mililitros objetivo todavía sin confirmar en remoto. */
export type WaterPendingByDate = Record<string, number>;

/** Resultado de una escritura que no necesita devolver un envelope (agua,
    aparcado) — corrección de revisión (P1): antes writeWaterPending()
    devolvía `void` y se tragaba el error; el caller no tenía forma de
    saber que la persistencia había fallado y podía seguir tratando la
    operación como "durable" sin serlo. */
export type WriteResult = { ok: true } | { ok: false; error: unknown };

/** Límite superior defensivo para un objetivo de agua de un solo día —
    generoso frente a cualquier uso real (el valor por defecto de
    waterGoalMl es 2500 ml), pensado solo para descartar basura evidente
    (un valor corrupto, un id colado por error donde iba un número) antes
    de que llegue al upsert — nunca para limitar un registro legítimo
    agresivo. */
const MAX_PLAUSIBLE_WATER_ML = 50_000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ¿`date` tiene forma YYYY-MM-DD Y es una fecha de calendario real y
    canónica? Corrección de revisión (P2): la regex por sí sola aceptaba
    fechas imposibles como "2026-99-99" o "2026-02-30" — se reconstruye la
    fecha con Date.UTC y se comprueba que año/mes/día no cambiaron (JS
    "normaliza" silenciosamente un día 30 de febrero a marzo, por ejemplo
    — si el resultado no coincide con la entrada, la fecha no era real). */
export function isValidCalendarDateKey(date: string): boolean {
  if (!DATE_KEY_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** ¿`ml` es un objetivo de agua válido? Corrección de revisión (P2):
    `water_log.ml` es `integer` en el esquema — un decimal, `NaN`,
    `Infinity` o un valor fuera de rango nunca debe llegar al upsert.
    Exportada para que data-layer.ts la use también en la entrada PÚBLICA
    setWaterTargetDurable() — la validación de localStorage por sí sola no
    basta si un valor inválido puede colarse por la llamada directa. */
export function isValidWaterTarget(ml: number): boolean {
  return Number.isInteger(ml) && ml >= 0 && ml <= MAX_PLAUSIBLE_WATER_ML;
}

/** Corrección de revisión (P1): readWaterPending()/restoreParkedWater()
    aceptaban, vía cast, cualquier objeto JSON que hubiera en disco —
    datos corruptos (de una versión anterior, de una escritura a medias,
    o manipulados a mano) podían llegar tal cual hasta el upsert. Cada
    entrada se valida: clave con forma de fecha de CALENDARIO REAL
    (YYYY-MM-DD, sin fechas imposibles), valor entero, finito, no
    negativo, dentro de un límite superior plausible. Cualquier entrada
    que no cumpla se DESCARTA (no se lanza, no rompe la lectura completa
    por una sola entrada corrupta). */
function sanitizeWaterPendingByDate(parsed: unknown): WaterPendingByDate {
  if (!parsed || typeof parsed !== "object") return {};
  const clean: WaterPendingByDate = {};
  for (const [date, ml] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidCalendarDateKey(date)) continue;
    if (typeof ml !== "number" || !isValidWaterTarget(ml)) continue;
    clean[date] = ml;
  }
  return clean;
}

export function readWaterPending(userId: string): WaterPendingByDate {
  try {
    const raw = localStorage.getItem(waterPendingKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeWaterPendingByDate(parsed);
  } catch {
    return {};
  }
}

/** Sustituye el conjunto completo de pendientes de agua de este usuario por
    `pending` — un objeto vacío borra la clave (nada que persistir). */
export function writeWaterPending(userId: string, pending: WaterPendingByDate): WriteResult {
  try {
    if (Object.keys(pending).length === 0) {
      localStorage.removeItem(waterPendingKey(userId));
    } else {
      localStorage.setItem(waterPendingKey(userId), JSON.stringify(pending));
    }
    return { ok: true };
  } catch (error) {
    console.warn("FoodOS: no se pudo persistir el agua pendiente de sincronizar", error);
    return { ok: false, error };
  }
}

export function discardWaterPending(userId: string): WriteResult {
  try {
    localStorage.removeItem(waterPendingKey(userId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// ─── Aparcado del agua pendiente por expulsión involuntaria (P1) ───────────
// Corrección de revisión: antes foodos-water-pending-v1-<userId> no tenía
// ningún TTL ni se tocaba en una expulsión involuntaria — quedaba
// indefinidamente en el dispositivo. Se mantiene como almacén SEPARADO del
// aparcado del envelope genérico (en vez de fusionarlos en un único blob)
// porque el agua puede tener pendientes sin que exista ningún envelope
// activo todavía (setWaterTargetDurable() no depende de que mutate() se
// haya llamado antes) — forzar un `state: FoodOSState` para poder aparcar
// solo el agua sería inventar un snapshot que no existe. La política es la
// MISMA en los dos almacenes (mismo TTL, mismo orden escribir-antes-de-
// borrar, mismos puntos de entrada únicos: resolveInvoluntaryLoss()/
// signOut()/purgeExpiredParked() ya cubren ambos) — dos claves físicas, una
// sola política.
const WATER_PARKED_PREFIX = "foodos-water-parked-v1-";
function waterParkedKey(userId: string): string {
  return `${WATER_PARKED_PREFIX}${userId}`;
}
interface ParkedWaterPending {
  parkedAt: string;
  pending: WaterPendingByDate;
}

/** Aparca el agua pendiente de `userId` con TTL — no hace nada si no había
    ninguna (mismo criterio que parkIfPending para el envelope genérico). */
export function parkWaterIfPending(userId: string): void {
  const pending = readWaterPending(userId);
  if (Object.keys(pending).length === 0) return;
  try {
    const parked: ParkedWaterPending = { parkedAt: new Date().toISOString(), pending };
    localStorage.setItem(waterParkedKey(userId), JSON.stringify(parked));
    localStorage.removeItem(waterPendingKey(userId));
  } catch (error) {
    console.warn("FoodOS: no se pudo aparcar el agua pendiente", error);
  }
}

/** Restaura el agua aparcada de `userId` (dentro del TTL) como pendiente
    activo de nuevo. Mismo orden seguro que restoreParked(): escribe
    primero, borra el aparcado solo si esa escritura tuvo éxito. */
/** Corrección de revisión (P1, quinta ronda) — misma regla de seguridad
    que restoreParked(): si YA existe agua activa pendiente para este
    usuario, un aparcado nunca la sobrescribe ciegamente (podría revertir
    un objetivo más reciente a uno más antiguo si un removeItem() previo
    hubiera fallado dejando las dos copias vivas). Devuelve
    RestoreResult para que el caller sepa si la copia aparcada obsoleta
    se pudo limpiar del todo, no solo si "algo" se restauró. */
export function restoreParkedWater(userId: string): RestoreResult<WaterPendingByDate> {
  try {
    const raw = localStorage.getItem(waterParkedKey(userId));
    if (!raw) return { value: null, cleanupOk: true };
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed || typeof parsed !== "object" ||
      !("parkedAt" in parsed) || typeof (parsed as { parkedAt: unknown }).parkedAt !== "string" ||
      !isPlausibleParkedAt((parsed as { parkedAt: string }).parkedAt) ||
      !("pending" in parsed)
    ) {
      // Corrección de revisión (P1): antes solo comprobaba que las claves
      // EXISTIERAN, no que `parkedAt` fuera una fecha válida — un valor
      // corrupto habría pasado el chequeo de TTL de forma impredecible
      // (NaN en la resta de fechas), o un `parkedAt` absurdamente futuro
      // habría dado un TTL negativo, aceptándolo como "recién aparcado".
      const cleanupOk = safeRemoveItem(waterParkedKey(userId));
      return { value: null, cleanupOk };
    }
    const parked = parsed as ParkedWaterPending;
    if (Date.now() - new Date(parked.parkedAt).getTime() > PARKED_TTL_MS) {
      const cleanupOk = safeRemoveItem(waterParkedKey(userId));
      return { value: null, cleanupOk };
    }

    // Regla de seguridad: nunca sobrescribir agua activa ya existente.
    if (Object.keys(readWaterPending(userId)).length > 0) {
      const cleanupOk = safeRemoveItem(waterParkedKey(userId));
      if (!cleanupOk) {
        console.warn("FoodOS: había agua aparcada obsoleta junto a agua activa, pero no se pudo limpiar — la activa NO se tocó (regla de seguridad)");
      }
      return { value: null, cleanupOk };
    }

    // Igual que readWaterPending(): cada entrada de `pending` se valida
    // (fecha con forma de calendario real, mililitros enteros finitos, no
    // negativos, dentro de un límite plausible) antes de restaurarla como
    // activa — nunca debe llegar basura corrupta hasta el upsert.
    const sanitized = sanitizeWaterPendingByDate(parked.pending);
    const written = writeWaterPending(userId, sanitized);
    if (!written.ok) {
      console.warn("FoodOS: no se pudo restaurar el agua aparcada — se conserva aparcada para reintentar", written.error);
      return { value: null, cleanupOk: false };
    }
    const cleanupOk = safeRemoveItem(waterParkedKey(userId));
    if (!cleanupOk) {
      console.warn("FoodOS: el agua se restauró correctamente pero no se pudo limpiar la copia aparcada — quedará ignorada en el futuro (nunca sobrescribe una activa existente)");
    }
    return { value: sanitized, cleanupOk };
  } catch {
    return { value: null, cleanupOk: false };
  }
}

export function discardParkedWater(userId: string): WriteResult {
  try {
    localStorage.removeItem(waterParkedKey(userId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Se llama junto a purgeExpiredParked() al arrancar la app: borra agua
    aparcada vencida de CUALQUIER usuario sin tocar la vigente. */
export function purgeExpiredParkedWater(): void {
  try {
    const now = Date.now();
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(WATER_PARKED_PREFIX)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as ParkedWaterPending | null;
        // Ver el comentario en purgeExpiredParked() — misma corrección
        // (P1, sexta ronda): un parkedAt corrupto o futuro no debe
        // sobrevivir al purgado global.
        if (!parsed?.parkedAt || !isPlausibleParkedAt(parsed.parkedAt) || now - new Date(parsed.parkedAt).getTime() > PARKED_TTL_MS) {
          toRemove.push(key);
        }
      } catch {
        toRemove.push(key);
      }
    }
    toRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* localStorage no disponible (SSR) — nada que purgar */
  }
}

// ─── Identidad de pestaña ────────────────────────────────────────────────
// sessionStorage, NO localStorage: cada pestaña debe tener su propio
// clientId — si viviera en localStorage lo compartirían todas las pestañas
// del mismo navegador, perdiendo su utilidad para diagnosticar qué pestaña
// escribió cada entrada (ver §5 del diseño, "varias pestañas").
let cachedClientId: string | null = null;
export function getTabClientId(): string {
  if (cachedClientId) return cachedClientId;
  try {
    const existing = sessionStorage.getItem("foodos-tab-client-id");
    if (existing) {
      cachedClientId = existing;
      return existing;
    }
    const created = crypto.randomUUID();
    sessionStorage.setItem("foodos-tab-client-id", created);
    cachedClientId = created;
    return created;
  } catch {
    cachedClientId = crypto.randomUUID();
    return cachedClientId;
  }
}

/** Solo para tests: resetea el clientId cacheado en memoria. */
export function resetTabClientIdCacheForTests(): void {
  cachedClientId = null;
}
