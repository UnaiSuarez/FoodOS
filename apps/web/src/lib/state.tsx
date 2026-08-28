"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AuthChangeEvent, User } from "@supabase/supabase-js";
import type { AppSettings, DailyTargets, FoodLogEntry, FoodOSState, GoalMode, InventoryItem, InventorySnapshot, MacroTotals, MealType, Recipe, StorageName, WeightEntry } from "@foodos/types";
import { Modal } from "@/components/dashboard/Modal";
import { clearLocalState, flushLocalState, loadLocalState, remote, saveLocalState, saveLocalStateDebounced, waitForMutationConfirmed, type PendingPush, type SyncPushStatus } from "./data-layer";
import * as outbox from "./outbox";
import { RealtimeHydrationGate } from "./realtime-hydration-gate";
import { hasSupabaseConfig } from "./supabase";
import { DEMO_RECIPES } from "./recipes";
import { getMascot } from "./mascots";
import { applyEngineVersionTransition, calcDailyTargets, isGymDay, monthlyAmountOf, weeklyCycle } from "./nutrition";
import { findExactFood } from "./food-db";
import { addDaysToDateKey, dateFromKey, dateOffset, daysUntil, eur, mealTypeFromTime, namesMatch, seededJitter, todayMinus, todayPlus, toGrams, uid } from "./utils";

export const DEFAULT_SETTINGS: AppSettings = {
  expiryWarnDays: 3,
  waterGoalMl: 2500,
  dinnerSuggestionHour: 18,
  budgetWarnPct: 80,
  defaultStore: "Mercadona",
  lowStockThresholds: { g: 200, ml: 300, L: 0.5, kg: 0.3, ud: 2 },
  extraExpenseCategories: [],
  stepsGoal: 8000,
};

export const defaultState: FoodOSState = {
  inventory: [],
  cart: [],
  expenses: [],
  incomeSources: [],
  recurringExpenses: [],
  savingsGoalPct: 20,
  savingsGoal: null,
  foodLog: [],
  waterLog: {},
  weightLog: [],
  customRecipes: [],
  savedRecipeIds: [],
  profile: null,
  nutrition: { kcal: 2200, protein: 150, carbs: 225, fat: 70, mode: "recomp" },
  weeklyBudget: 70,
  bankSynced: false,
  mascotId: "zana",
  recipeTag: "todos",
  macroPreference: "balanced",
  settings: DEFAULT_SETTINGS,
  dismissedSuggestions: [],
  mealPlan: {},
  plannerQuickMeals: [],
  debugDate: null,
  categoryBudgets: {},
  routines: [],
  workoutLog: [],
  stepsLog: {},
  pendingAdjustmentProposal: null,
  lastAdjustmentDecisionAt: null,
};

// Migra estados guardados con formatos antiguos (modos en español,
// ingredientes como strings) y aplica el ciclado del dia si hay perfil.
const LEGACY_MODES: Record<string, GoalMode> = {
  Recomposicion: "recomp",
  "Perdida de grasa": "fat_loss",
  "Ganancia muscular": "muscle_gain",
  Mantenimiento: "maintain",
};

export function normalizeState(state: FoodOSState): FoodOSState {
  const next = structuredClone(state);
  const legacyMode = LEGACY_MODES[next.nutrition.mode as unknown as string];
  if (legacyMode) next.nutrition.mode = legacyMode;
  next.incomeSources ||= [];
  next.recurringExpenses ||= [];
  next.savingsGoalPct ??= 20;
  next.savingsGoal ??= null;
  next.foodLog ||= [];
  next.waterLog ||= {};
  next.weightLog ||= [];
  next.mealPlan ||= {};
  next.plannerQuickMeals ||= [];
  next.categoryBudgets ||= {};
  next.routines ||= [];
  next.workoutLog ||= [];
  next.stepsLog ||= {};
  next.settings = { ...DEFAULT_SETTINGS, ...(next.settings ?? {}), lowStockThresholds: { ...DEFAULT_SETTINGS.lowStockThresholds, ...(next.settings?.lowStockThresholds ?? {}) } };
  // Migracion: las comidas antiguas sin fecha (consumedMeals) pasan al diario datado.
  const legacy = next as FoodOSState & { consumedMeals?: Array<MacroTotals & { id: string; name: string }>; consumed?: MacroTotals };
  if (legacy.consumedMeals?.length) {
    legacy.consumedMeals.forEach((meal) => {
      next.foodLog.push({
        id: meal.id || uid(),
        date: getToday(next),
        time: "12:00",
        name: meal.name,
        qty: null,
        unit: null,
        kcal: meal.kcal,
        protein: meal.protein,
        carbs: meal.carbs,
        fat: meal.fat,
        source: "recipe",
        mealType: "lunch",
      });
    });
  }
  delete legacy.consumedMeals;
  delete legacy.consumed;
  // Migra entradas del diario sin mealType (datos guardados antes de esta version).
  next.foodLog = next.foodLog.map((entry) => ({
    ...entry,
    mealType: (entry as FoodLogEntry & { mealType?: MealType }).mealType ?? mealTypeFromTime(entry.time),
  }));
  next.customRecipes = (next.customRecipes || []).map((recipe) => ({
    ...recipe,
    ingredients: (recipe.ingredients || []).map((ing) =>
      typeof ing === "string" ? { name: ing, quantity: 100, unit: "g" } : ing
    ),
  }));
  if (next.profile) {
    // nutrition-v3.1 (corrección de revisión — riesgo de carrera en el
    // arranque, ver FoodOSProvider): la transición de motor se aplica AQUÍ,
    // en la capa de estado, sobre CUALQUIER perfil que pase por
    // normalizeState — tanto el local (arranque en modo solo-local, o
    // antes de que la hidratación remota complete) como el remoto recién
    // hidratado. Nunca desde un componente visual ni en un efecto separado
    // que pudiera disparar un guardado mientras la hidratación remota
    // autoritativa sigue en curso. Pura, sin efectos secundarios — quien
    // llama decide si además hace falta persistir el cambio (ver los dos
    // call sites en FoodOSProvider).
    const transitioned = applyEngineVersionTransition(next.profile, getToday(next));
    if (transitioned) next.profile = transitioned;

    const targets = calcDailyTargets(next.profile, isGymDay(next.profile, stateDate(next)), next.macroPreference);
    next.nutrition = {
      kcal: targets.kcal,
      protein: targets.protein,
      carbs: targets.carbs,
      fat: targets.fat,
      mode: next.profile.goal,
    };
  }
  return next;
}

/** Núcleo PURO de una escritura de agua a un objetivo absoluto — clona y
    fija `waterLog[date]`, sin tocar nada externo (red, outbox, localStorage
    directo). Corrección de revisión (P1): setWaterAbsolute()/addWater()
    usan esto DENTRO del updater de setState (donde React exige pureza —
    puede invocarlo más de una vez en Strict Mode o descartar la
    invocación bajo renderizado concurrente); el efecto externo
    (remote.setWaterTargetDurable) vive fuera del updater, en el cuerpo del
    callback, que React nunca reinvoca por su cuenta. Exportada para poder
    probar la pureza sin renderizar React (no hay @testing-library en este
    proyecto): invocarla dos veces con los mismos argumentos (simulando lo
    que Strict Mode le haría al updater que la envuelve) nunca toca
    `remote` ni `outbox` — ver state.test.tsx. */
export function applyWaterTarget(state: FoodOSState, date: string, targetMl: number): FoodOSState {
  const draft = structuredClone(state);
  draft.waterLog[date] = Math.max(0, targetMl);
  return draft;
}

export interface HydrateDeps {
  ensureBaseRows: () => Promise<void>;
  pullState: (defaults: FoodOSState) => Promise<FoodOSState>;
  schedulePush: (op: PendingPush) => void;
  /** true si la sesión (epoch) para la que se llamó ya no es la vigente —
      se revalida en cada punto de reanudación tras un `await`. */
  epochChanged: () => boolean;
  /** Espera EXPLÍCITAMENTE (sin depender de que un evento de Realtime
      llegue "por casualidad") a que `mutationId` se confirme, se sustituya
      por una más nueva, o venza el plazo — ver waitForMutationConfirmed en
      data-layer.ts. Corrección de revisión (P0). */
  waitForMutationConfirmed: (userId: string, mutationId: string) => Promise<"confirmed" | "superseded" | "timeout">;
}

export interface HydrationCoordinator {
  /** Comparte una única promesa entre llamadas con el mismo `userId+epoch`
      (dedup real de INITIAL_SESSION + comprobación directa de sesión) —
      otro usuario, u otro epoch del mismo usuario, obtiene una petición
      real aparte. Nunca aplica un resultado a una sesión que ya cambió. */
  hydrate(userId: string, epoch: number, defaults: FoodOSState, deps: HydrateDeps): Promise<FoodOSState | null>;
}

/**
 * Coordinador de hidratación remota — con IDENTIDAD DE INSTANCIA (creado
 * por FoodOSProvider vía useRef, nunca un Map a nivel de módulo compartido
 * entre renders/tests — corrección de revisión, bloqueante §8). Cada
 * instancia de FoodOSProvider tiene su propio mapa de promesas en vuelo;
 * los tests crean una instancia nueva cada vez, sin fugas entre casos.
 *
 * Política ante el pendiente local (outbox) — ver diseño, "no lo llames
 * reconciliación": si hay algo sin confirmar para `userId` ANTES de pedir a
 * Supabase, se reenvía y se ESPERA explícitamente (waitForMutationConfirmed,
 * sin depender de que un evento de Realtime llegue "por casualidad") a que
 * esa mutación se confirme — el pull remoto no se pide hasta entonces,
 * porque se descartaría igualmente (corrección de revisión, P0: la versión
 * anterior pedía el pull de inmediato solo para tirarlo). Si aparece un
 * pending NUEVO mientras el pull SÍ está en vuelo, se vuelve a comprobar
 * justo antes de aplicar y también gana el local. Esto es "el último local
 * sin confirmar gana", no una fusión campo a campo — riesgo documentado: si
 * el MISMO usuario editó desde otro dispositivo mientras este tenía algo
 * pendiente, ese cambio se pierde al reenviar. La solución real (versionado
 * optimista en el servidor) queda fuera de este PR. Importante: el
 * ESTADO VISIBLE en React nunca depende de este pull — FoodOSProvider ya
 * pinta el envelope activo (con o sin pending) de inmediato al conocer el
 * usuario, antes de llamar a hydrate() (ver el efecto de hidratación).
 */
export function createHydrationCoordinator(): HydrationCoordinator {
  const inFlight = new Map<string, Promise<FoodOSState | null>>();
  return {
    hydrate(userId, epoch, defaults, deps) {
      const key = `${userId}:${epoch}`;
      const existing = inFlight.get(key);
      if (existing) return existing;

      const promise = (async (): Promise<FoodOSState | null> => {
        await deps.ensureBaseRows();

        const envelopeBefore = outbox.readEnvelope(userId);
        if (envelopeBefore?.pending) {
          const mutationId = envelopeBefore.pending.mutationId;
          deps.schedulePush({
            userId, epoch,
            mutationId,
            revision: envelopeBefore.pending.revision,
            state: envelopeBefore.state,
          });
          // Corrección de revisión (P0): antes se pedía el estado remoto YA
          // (que se iba a descartar de todos modos, por seguir habiendo un
          // pending) y se confiaba en que algo externo — un evento de
          // Realtime — disparase un pull posterior una vez confirmado. Eso
          // no está garantizado. Ahora se espera EXPLÍCITAMENTE, con la
          // outbox como fuente de verdad, a que ESTA mutación concreta se
          // resuelva antes de pedir nada — sin bloquear indefinidamente si
          // la red no coopera (timeout) ni si una edición más nueva la
          // reemplaza (esa sigue su propio ciclo).
          const outcome = await deps.waitForMutationConfirmed(userId, mutationId);
          if (deps.epochChanged()) return null;
          if (outcome !== "confirmed") return null; // "timeout" o "superseded": el envelope activo ya está en pantalla (ver FoodOSProvider), no hay nada más que hacer en ESTE ciclo
        }

        const pulled = await deps.pullState(defaults);
        if (deps.epochChanged()) return null;

        const envelopeAfter = outbox.readEnvelope(userId);
        if (envelopeAfter?.pending) {
          // Llegado aquí, cualquier pending es necesariamente NUEVO (el que
          // hubiera al principio ya se resolvió arriba, o esta función ya
          // habría vuelto null) — se reprograma su envío sin condición.
          deps.schedulePush({
            userId, epoch,
            mutationId: envelopeAfter.pending.mutationId,
            revision: envelopeAfter.pending.revision,
            state: envelopeAfter.state,
          });
          return null; // gana el pendiente local — el remoto se descarta para la UI esta vez
        }

        const remoteState = normalizeState(pulled);
        outbox.writeEnvelope(userId, (env) => ({ ...env, userId, state: remoteState, pending: null }));
        // Transición de motor v3.1 (u otra futura migración de solo
        // lectura→escritura): si normalizeState() cambió el perfil, se
        // persiste también en remoto — derivado del estado recién llegado
        // del servidor, nunca del snapshot local.
        if (pulled.profile?.lastCalculationEngineVersion !== remoteState.profile?.lastCalculationEngineVersion) {
          const written = outbox.recordMutation(userId, remoteState, outbox.getTabClientId());
          if (written.ok && written.envelope.pending) {
            deps.schedulePush({ userId, epoch, mutationId: written.envelope.pending.mutationId, revision: written.envelope.pending.revision, state: remoteState });
          }
        }
        return remoteState;
      })();

      inFlight.set(key, promise);
      void promise.finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      });
      return promise;
    },
  };
}

/** Decide qué estado debe verse en React AL CONOCER una sesión (login,
    recarga con sesión ya activa, o recuperación de un aparcado por
    expulsión involuntaria) — ANTES de esperar a ningún pull remoto.
    Corrección de revisión (P0, hallazgo de mayor severidad de esta ronda):
    antes se pintaba SIEMPRE defaultState y se esperaba a que
    createHydrationCoordinator resolviera — pero si ya existía un envelope
    activo con `pending` (p.ej. una mutación hecha justo antes de recargar
    la página, en la MISMA sesión), el coordinador reprograma su reenvío
    pero devuelve null (gana el pendiente local, nunca se pisa con un pull
    remoto desactualizado) — y como devuelve null, la UI se quedaba
    mostrando defaultState mientras el envío seguía en marcha en segundo
    plano; si el usuario editaba en ese hueco, mutate() clonaba ese
    defaultState y sustituía el envelope correcto por un snapshot
    incompleto. Ahora se aplica el envelope activo (restaurado o ya
    existente) de inmediato, sin esperar a nada remoto.
    Pura y testeada aparte — mismo motivo que classifyAuthTransition: no
    depender de renderizar el árbol completo de React (no hay
    @testing-library en este proyecto). restoreParked() SÍ tiene efecto
    secundario (mueve el aparcado a activo) — se llama aquí una única vez,
    nunca por duplicado, así que quien la invoque no debe volver a llamarla
    por su cuenta para el mismo `userId`. */
export function resolveInitialStateForSession(userId: string, defaults: FoodOSState): FoodOSState {
  // restoreParked() (P1, quinta ronda) nunca sobrescribe un envelope
  // activo ya existente — si `value` viene null porque ya había uno, el
  // siguiente readEnvelope() lo recoge igual. `cleanupOk` no se propaga
  // aquí a propósito: no hay decisión de usuario que tomar al iniciar
  // sesión (a diferencia del logout, donde sí se avisa) — un aparcado
  // obsoleto que no se pudo limpiar queda simplemente ignorado a partir
  // de ahora (nunca sobrescribirá nada) hasta que purgeExpiredParked()
  // lo retire por TTL.
  const restored = outbox.restoreParked(userId);
  const active = restored.value ?? outbox.readEnvelope(userId);
  return active ? normalizeState(active.state) : structuredClone(defaults);
}

/**
 * ¿Este evento de Supabase Auth es un cambio REAL de sesión (debe
 * incrementar epoch, cancelar timers/retries, reiniciar hidratación) o solo
 * una renovación lógica del mismo usuario (debe conservarse tal cual — un
 * TOKEN_REFRESHED no puede cancelar un guardado en curso)? Pura y testeada
 * aparte (bloqueante §7 de la revisión):
 * - Mismo userId (ninguno de los dos es null) + TOKEN_REFRESHED/
 *   USER_UPDATED/SIGNED_IN → "same_session" (incluye el doble SIGNED_IN del
 *   mismo usuario — idempotente, p.ej. eco de nuestra propia acción).
 * - Cualquier otra combinación (userId distinto, SIGNED_OUT, o el primer
 *   login desde null) → "real_change".
 */
export function classifyAuthTransition(
  prevUserId: string | null,
  newUserId: string | null,
  event: AuthChangeEvent,
): "same_session" | "real_change" {
  const sameUser = newUserId !== null && newUserId === prevUserId;
  if (sameUser && (event === "TOKEN_REFRESHED" || event === "USER_UPDATED" || event === "SIGNED_IN")) {
    return "same_session";
  }
  return "real_change";
}

/** Espera hasta `timeoutMs` a que TODO lo pendiente de `userId` quede
    confirmado (push genérico Y RPC de agua) — usado por
    requestSignOut()/resolveSignOutChoice() en la opción "esperar y salir".
    Función de nivel de módulo (no un hook) para poder probarla directamente
    con el mismo patrón de cliente Supabase falso + timers controlados que
    el resto de data-layer.test.ts, sin necesitar renderizar FoodOSProvider.
    "confirmed" solo si de verdad se vació; "timeout" si se agotó el plazo
    antes; "error" no se usa hoy (el push reintenta solo hasta el timeout)
    pero queda en el contrato para un futuro fail-fast explícito.
    Corrección de revisión (P1): la versión anterior (a) solo miraba la
    outbox genérica, nunca el agua pendiente — un logout con SOLO agua
    pendiente salía en silencio con el cambio sin confirmar; (b) sustituía
    temporalmente remote.onStatusChange entero, arriesgando perder una
    confirmación que llegara entre leer el handler previo e instalar el
    propio (y pisando cualquier otro oyente instalado mientras tanto);
    ahora usa remote.addStatusListener() (nunca sustituye nada) y vuelve a
    comprobar el estado justo tras suscribirse. Usa
    remote.hasPendingWaterFor(userId) — EXPLÍCITO por userId, nunca
    remote.hasPendingWater() (que consulta la sesión vigente, que en el
    momento de resolverse esta promesa podría ya ser otro usuario). */
export function flushPendingOrTimeout(userId: string, timeoutMs: number): Promise<"confirmed" | "timeout" | "error"> {
  const isIdle = () => !outbox.hasPending(userId) && !remote.hasPendingWaterFor(userId);
  if (isIdle()) return Promise.resolve("confirmed");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: "confirmed" | "timeout" | "error") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const unsubscribe = remote.addStatusListener((status) => {
      if (status === "saved" && isIdle()) finish("confirmed");
    });
    if (isIdle()) finish("confirmed"); // cierra la ventana de carrera entre el primer chequeo y quedar suscrito
  });
}

/**
 * Aplica la decisión que el usuario tomó frente al diálogo de "tienes
 * cambios sin sincronizar" (§4 del diseño) — separada de requestSignOut()
 * para poder probarla sin React. NUNCA cierra sesión automáticamente en
 * "wait" si el flush no confirmó de verdad (timeout o error): en ese caso
 * vuelve "cancelled_timeout"/"cancelled_error" y la sesión sigue abierta,
 * con el mismo diálogo disponible para reintentar.
 */
export interface SignOutOutcome {
  /** Corrección de revisión (P1, sexta ronda): antes `status` era
      "signed_out" incluso cuando `auth.signOut()` devolvía error — la app
      ya se había puesto a sí misma en "sin sesión" (remote.user = null,
      resetSessionState()) ANTES de conocer el resultado remoto.
      Confirmado contra `@supabase/auth-js`: `_signOut()` devuelve el
      error ANTES de ejecutar `_removeSession()` para errores que no sean
      los casos explícitamente ignorados — la sesión persistida en
      Supabase podía sobrevivir a una recarga pese a que la UI ya decía
      "sesión cerrada". Ahora `remote.signOut()` NO toca nada local si
      falla (ver su comentario grande en data-layer.ts), así que
      "sign_out_failed" es un resultado real: la sesión (en memoria y en
      Supabase) sigue activa, recuperable, reintentable. */
  status: "signed_out" | "sign_out_failed" | "cancelled" | "cancelled_timeout" | "cancelled_error";
  /** Corrección de revisión (P1): discard()/discardWaterPending()/
      discardParkedWater() tragaban cualquier fallo de removeItem pese a
      que el comentario afirmaba una garantía absoluta de privacidad —
      solo era "mejor esfuerzo". `cleanupOk` le dice al caller si de
      verdad se limpiaron los datos locales, para poder avisar en vez de
      afirmar algo que no ocurrió. Solo tiene sentido cuando
      `status === "signed_out"` (con cualquier otro status, `true`: no se
      intentó limpiar nada, así que no hay "fallo de limpieza" que avisar). */
  cleanupOk: boolean;
  /** El error que devolvió `auth.signOut()`, si lo hubo — presente
      exactamente cuando `status === "sign_out_failed"`. */
  authError: unknown;
}

export async function resolveSignOutChoice(
  userId: string,
  choice: "wait" | "cancel" | "discard",
): Promise<SignOutOutcome> {
  if (choice === "cancel") return { status: "cancelled", cleanupOk: true, authError: null };
  if (choice === "discard") {
    const { ok, error, cleanupOk } = await remote.signOut();
    return ok ? { status: "signed_out", cleanupOk, authError: null } : { status: "sign_out_failed", cleanupOk: true, authError: error };
  }
  const result = await flushPendingOrTimeout(userId, 15_000);
  if (result === "timeout") return { status: "cancelled_timeout", cleanupOk: true, authError: null };
  if (result === "error") return { status: "cancelled_error", cleanupOk: true, authError: null };
  const { ok, error, cleanupOk } = await remote.signOut();
  return ok ? { status: "signed_out", cleanupOk, authError: null } : { status: "sign_out_failed", cleanupOk: true, authError: error };
}

/** Avisa por toast si el logout SÍ se confirmó pero la limpieza local no
    se pudo completar del todo — corrección de revisión (P1): antes se
    afirmaba una garantía absoluta de privacidad que en realidad era solo
    "mejor esfuerzo". Solo tiene sentido llamarla cuando `status` ya es
    "signed_out" — el fallo de cierre REMOTO (`sign_out_failed`) se avisa
    aparte, con su propio mensaje, porque es un problema completamente
    distinto ("puede que el servidor siga viendo la sesión como activa",
    no "puede que quede un rastro en este dispositivo"). */
export function reportCleanupIssue(showToast: (message: string) => void, cleanupOk: boolean): void {
  if (!cleanupOk) {
    showToast("Sesión cerrada, pero no se pudieron borrar por completo los datos locales de este dispositivo.");
  }
}

function stateDate(state: Pick<FoodOSState, "debugDate">): Date {
  return dateFromKey(state.debugDate ?? todayPlus(0));
}

function relativeDate(state: Pick<FoodOSState, "debugDate">, days: number): string {
  return state.debugDate ? addDaysToDateKey(state.debugDate, days) : todayPlus(days);
}

export type MascotState = "idle" | "wave" | "thinking" | "celebrate" | "alert" | "suggest" | "sleep" | "success_buy" | "streak";
const LOOP_MASCOT_STATES: MascotState[] = ["idle", "thinking", "sleep"];

/** Duración de un toast con acción de deshacer. Exportado para que quien
    difiera efectos secundarios irreversibles hasta que expire la ventana de
    deshacer (ej. borrar la foto de Storage) use el mismo plazo. */
export const UNDO_TOAST_MS = 5000;

/** Acción opcional de un toast (ej. "Deshacer" tras un borrado). Mientras el
    toast tiene acción permanece visible más tiempo (UNDO_TOAST_MS) para dar
    margen a pulsarla. */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

/** E10-03: fila editable del repaso de compra, antes de darla por buena. Ver
    actions.proposePurchaseReview (propuesta inicial) y
    actions.completePurchase (aplica lo confirmado/editado). */
export interface PurchaseReviewItem {
  cartItemId: string;
  name: string;
  qty: number;
  unit: string;
  unitSize?: number;
  storage: StorageName;
  store: string;
  /** Precio tal cual estaba en el carrito — puede llevar ahí días y no ser
      lo que se pagó de verdad. Se muestra distinto de `price` mientras el
      usuario no lo confirme/edite (E10-07). */
  estimatedPrice: number;
  /** Precio real a registrar en Finanzas — arranca igual a estimatedPrice,
      editable en el repaso. */
  price: number;
  expires: string;
}

/** E04-07: estado de guardado que muestra la cabecera.
    - "local": no hay Supabase configurado — todo vive solo en este dispositivo,
      no hay "servidor" con el que estar sincronizado o no.
    - "saved": ni el snapshot genérico ni la RPC de agua tienen nada
      pendiente/en curso/en reintento — el último cambio de CUALQUIERA de
      los dos ya llegó al servidor.
    - "syncing": hay un guardado remoto (snapshot o agua) programado o en curso.
    - "offline": el navegador no tiene conexión (navigator.onLine) — un push
      fallaría igualmente, así que se distingue de "error" (que sí lo intentó).
    - "error": el último intento de push (snapshot o agua) falló y no ha
      vuelto a resolverse (reintenta solo — ver PUSH_RETRY_MS en data-layer.ts).
    - "unsynced": corrección de revisión — ni siquiera se pudo ESCRIBIR la
      outbox local (cuota de localStorage superada, fallo de
      serialización...). Peor que "error": no hay ni una copia durable del
      cambio en este dispositivo. Se mantiene hasta que una mutación
      posterior consiga escribir la outbox correctamente — nunca se resuelve
      solo a "saved" en silencio. */
export type SyncStatus = "local" | "saved" | "syncing" | "offline" | "error" | "unsynced";

/** Calcula el SyncStatus final combinando todas las fuentes — extraída
    como función PURA (corrección de revisión, P1) para poder testear que
    "unsynced" agrega fuentes INDEPENDIENTES sin renderizar React: antes,
    `hadUnsyncedWrite` era un único booleano compartido entre el fallo
    durable del envelope genérico (mutate()) y el fallo durable del agua
    (remote.onUnsyncedWrite) — un guardado genérico correcto limpiaba el
    flag entero, incluso si el problema real seguía siendo el agua sin
    persistir. Ahora cada fuente tiene su propio booleano; "unsynced" se
    mantiene mientras CUALQUIERA de las dos siga en true, y cada éxito
    limpia solo la suya. */
export function computeSyncStatus(params: {
  hasSupabaseConfig: boolean;
  isOnline: boolean;
  hadUnsyncedEnvelopeWrite: boolean;
  hadUnsyncedWaterWrite: boolean;
  pushStatus: SyncPushStatus;
}): SyncStatus {
  if (!params.hasSupabaseConfig) return "local";
  if (!params.isOnline) return "offline";
  if (params.hadUnsyncedEnvelopeWrite || params.hadUnsyncedWaterWrite) return "unsynced";
  return params.pushStatus;
}

interface FoodOSContextValue {
  state: FoodOSState;
  hydrated: boolean;
  remoteReady: boolean;
  /** true cuando ya se conoce el estado del servidor (o no hay Supabase). */
  remoteHydrated: boolean;
  authUser: User | null;
  /** true cuando el canal de Supabase Realtime está SUBSCRIBED */
  realtimeConnected: boolean;
  /** E04-07: ver SyncStatus. */
  syncStatus: SyncStatus;
  showToast: (message: string, action?: ToastAction) => void;
  setMascotMessage: (message: string) => void;
  triggerMascot: (anim: MascotState, message?: string) => void;
  mutate: (fn: (draft: FoodOSState) => void) => void;
  /** Incrementa/decrementa el agua del día de forma atómica (sin conflictos entre tabs). */
  addWater: (ml: number) => void;
  /** Fija el agua de una fecha concreta a un valor absoluto — usar para
      "borrar hoy", deshacer, o poblar datos de ejemplo/demo. NUNCA escribir
      waterLog a través de mutate() genérico (ver el comentario grande
      sobre setWaterAbsolute más arriba): pushState() excluye water_log a
      propósito y el cambio no llegaría a Supabase. */
  setWaterAbsolute: (date: string, targetMl: number) => void;
  resetAll: () => void;
  seedDemo: () => void;
  /** ÚNICO punto de entrada para cerrar sesión — nunca llamar a
      remote.signOut() directamente desde un componente (ver diseño §4/§7).
      Si hay cambios sin sincronizar, muestra la decisión explícita
      (esperar y salir / cancelar / salir descartando) antes de proceder.
      Devuelve "cancelled" si el usuario decide no cerrar sesión.
      Devuelve "failed" (corrección de revisión, P1, sexta ronda) si
      `auth.signOut()` no confirmó el cierre remoto — la sesión sigue
      activa tal cual estaba, ya se avisó por toast, y el caller (el
      componente) NO debe cerrar ningún modal ni mostrar un mensaje de
      éxito. */
  requestSignOut: () => Promise<"signed_out" | "cancelled" | "failed">;
}

/** Estado efímero de UI (toast + mascota) en un contexto aparte: cambia
    constantemente (cada toast dispara mostrar+ocultar, la mascota reacciona a
    actividad del ratón) y en el contexto principal re-renderizaba TODOS los
    consumidores de useFoodOS() en cada parpadeo. Solo lo consumen el toast del
    shell y el widget de la mascota. */
interface FoodOSUIValue {
  toast: { message: string; action?: ToastAction } | null;
  mascotMessage: string;
  mascotState: MascotState;
}

const FoodOSContext = createContext<FoodOSContextValue | null>(null);
const FoodOSUIContext = createContext<FoodOSUIValue | null>(null);

export function FoodOSProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FoodOSState>(defaultState);
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<FoodOSUIValue["toast"]>(null);
  const [mascotMessage, setMascotMessage] = useState("Lista para organizar tu comida.");
  const [mascotState, setMascotState] = useState<MascotState>("idle");
  const mascotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [remoteReady, setRemoteReady] = useState(false);
  // true cuando ya sabemos qué hay en el servidor: tras la primera hidratación
  // remota (ok o fallo), o de inmediato en modo solo-local. La usa el onboarding
  // para no mostrarse a un usuario que SÍ tiene perfil pero aún no ha hidratado.
  const [remoteHydrated, setRemoteHydrated] = useState(false);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  // E04-07: "saved" de entrada — sin Supabase se sobreescribe a "local" más
  // abajo antes del primer paint útil; con Supabase asumimos sincronizado
  // hasta el primer cambio (no hay nada pendiente al arrancar).
  const [pushStatus, setPushStatus] = useState<SyncPushStatus>("saved");
  // true si la ÚLTIMA escritura durable de esa fuente falló (cuota de
  // localStorage, fallo de serialización) — fuerza "unsynced" incluso si
  // el push por sí solo llega a tener éxito, hasta que una escritura
  // posterior de esa MISMA fuente consiga persistir de verdad
  // (corrección de revisión, bloqueante §9 punto 3). Corrección de
  // revisión (P1, cuarta ronda): antes era UN solo booleano compartido
  // entre el envelope genérico y el agua — un guardado genérico correcto
  // (mutate()) limpiaba el aviso aunque el problema real siguiera siendo
  // el agua sin persistir. Ahora cada fuente tiene el suyo — ver
  // computeSyncStatus(), que exige que AMBAS estén en false para salir de
  // "unsynced".
  const [hadUnsyncedEnvelopeWrite, setHadUnsyncedEnvelopeWrite] = useState(false);
  const [hadUnsyncedWaterWrite, setHadUnsyncedWaterWrite] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtimeUnsubRef = useRef<(() => void) | null>(null);
  const realtimeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // B2 (revisión externa, 2026-08-22): decide cuándo es seguro hidratar
  // desde un refresco en tiempo real frente a un push local sin confirmar
  // — lógica pura, testeada aparte en realtime-hydration-gate.test.ts (ver
  // ese archivo y data-layer.ts/hasPendingPush() para el porqué completo).
  const hydrationGateRef = useRef(new RealtimeHydrationGate());
  const hydrateRemoteRef = useRef<() => Promise<void>>(async () => {});
  // Identidad de instancia (bloqueante §8) — nunca un Map a nivel de módulo.
  const hydrationCoordinatorRef = useRef(createHydrationCoordinator());
  // Copia síncrona de authUser para leer dentro del callback de onAuthChange
  // sin depender de una clausura sobre el estado de React (que quedaría
  // obsoleta — el callback se registra una sola vez).
  const authUserRef = useRef<User | null>(null);
  // Petición de decisión al usuario cuando requestSignOut() encuentra algo
  // pendiente — ver el modal renderizado al final de este componente.
  const [signOutPrompt, setSignOutPrompt] = useState<{ resolve: (choice: "wait" | "cancel" | "discard") => void } | null>(null);

  // Con la escritura de localStorage diferida (debounce), al cerrar/recargar la
  // pestaña hay que volcar lo pendiente o se perderían los últimos ~300ms.
  useEffect(() => {
    window.addEventListener("pagehide", flushLocalState);
    return () => window.removeEventListener("pagehide", flushLocalState);
  }, []);

  // Corrección de revisión (P1) — estrategia entre pestañas: la v2 del
  // diseño proponía un listener de `storage` que nunca se llegó a
  // implementar en la primera versión de este PR (el test existente solo
  // comprobaba que clientId vive en sessionStorage, no probaba dos
  // pestañas de verdad). Este listener SOLO detecta y converge esta
  // pestaña al último envelope físicamente escrito en disco por OTRA
  // pestaña del mismo usuario — nunca fusiona campo a campo. Límite
  // documentado explícitamente (ver docs/SYNC_DECISIONES.md): dos pestañas
  // pueden seguir generando mutaciones simultáneas con distinto
  // mutationId — ninguna borra el `pending` de la otra por diseño de
  // outbox.ts, pero "el último setItem físico gana" en disco, y dos
  // pushes completos pueden llegar a Supabase en cualquier orden; esto NO
  // resuelve esa carrera, solo evita que ESTA pestaña se quede mostrando
  // un estado obsoleto sin ningún indicio de que otra pestaña ya avanzó.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      const userId = authUserRef.current?.id;
      if (!userId || event.key !== outbox.envelopeKey(userId)) return;
      if (!event.newValue) return; // borrado (logout/discard) — lo gestiona el propio flujo de auth de ESTA pestaña, no este listener
      const envelope = outbox.readEnvelope(userId);
      if (envelope) setState(normalizeState(envelope.state));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Hidratacion: primero localStorage, despues Supabase si hay sesion.
  useEffect(() => {
    outbox.purgeExpiredParked(); // una vez al arrancar — nunca queda un aparcado vencido (§4)
    outbox.purgeExpiredParkedWater(); // misma política, almacén separado del agua (P1)

    // Pintado instantáneo desde LOCAL_KEY (modo solo-local, o el hueco antes
    // de saber si hay sesión) — nunca se copia a la outbox de una cuenta
    // (bloqueante §1): esto es solo la primera pintura, se sustituye por
    // completo en cuanto se conoce el usuario real más abajo.
    const localLoaded = normalizeState(loadLocalState(defaultState));
    setState(localLoaded);
    setHydrated(true);

    if (!hasSupabaseConfig()) {
      saveLocalState(localLoaded);
      setRemoteHydrated(true);
      return;
    }
    let cancelled = false;

    const hydrateForUser = async (userId: string, epoch: number) => {
      setRemoteHydrated(false);
      try {
        const result = await hydrationCoordinatorRef.current.hydrate(userId, epoch, defaultState, {
          ensureBaseRows: () => remote.ensureBaseRows(),
          pullState: (defaults) => remote.pullState(defaults),
          schedulePush: (op) => remote.schedulePush(op),
          epochChanged: () => remote.sessionEpoch !== epoch,
          waitForMutationConfirmed: (uid, mutationId) => waitForMutationConfirmed(uid, mutationId),
        });
        if (cancelled || remote.sessionEpoch !== epoch) return; // la sesión ya cambió: no aplicar nada
        if (result) {
          setState(result);
          setMascotMessage("Datos sincronizados desde Supabase.");
        }
      } catch (error) {
        console.warn("FoodOS: fallo hidratando desde Supabase", error);
      } finally {
        if (!cancelled && remote.sessionEpoch === epoch) setRemoteHydrated(true);
      }
    };
    // Envoltorio sin argumentos para los callers que no conocen epoch/userId
    // (el refresco en tiempo real, el "saved" diferido) — siempre usa la
    // sesión VIGENTE en el momento de llamar, nunca una capturada antes.
    const hydrateRemote = () => {
      const uid = remote.user?.id;
      if (!uid) return Promise.resolve();
      return hydrateForUser(uid, remote.sessionEpoch);
    };
    hydrateRemoteRef.current = hydrateRemote;

    // Si hay un guardado local sin confirmar (debounce, en curso, en cola, o
    // esperando su reintento — remote.hasPendingPush(), ver el comentario
    // grande en data-layer.ts), un pull ahora mismo pisaría ese cambio con
    // un estado remoto desactualizado o, tras un fallo parcial, directamente
    // INCOMPLETO (B2, revisión externa, 2026-08-22). Antes se reintentaba
    // hasta 6 veces (1.8s) y LUEGO se hidrataba de todos modos como "red de
    // seguridad" — pero el reintento de un push fallido tarda hasta
    // PUSH_RETRY_MS (10s), así que esa red de seguridad se disparaba
    // sistemáticamente ANTES de que el reintento pudiera siquiera empezar.
    // Ahora, si hay un push pendiente, el refresco se DIFIERE (sin límite de
    // tiempo) en vez de forzarse — hydrationGateRef decide cuándo es seguro
    // procesarlo (ver el onStatusChange más abajo, que dispara
    // hydrateRemote() al ver "saved" si quedó algo diferido).
    function scheduleHydrate() {
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
      realtimeDebounceRef.current = setTimeout(() => {
        if (cancelled) return;
        if (!hydrationGateRef.current.onRealtimeRefresh(remote.hasPendingPush())) return;
        void hydrateRemote();
      }, 300);
    }

    function setupRealtime() {
      realtimeUnsubRef.current?.();
      realtimeUnsubRef.current = remote.subscribeRealtime(
        () => {
          if (cancelled) return;
          // Debounce: evita re-hidrataciones en cascada cuando llegan varios
          // eventos seguidos (scheduleHydrate ya cancela cualquier timer anterior).
          scheduleHydrate();
        },
        (table, newRow) => {
          if (cancelled) return;
          // Parche directo: no requiere ida a Supabase → prácticamente instantáneo.
          if (table === "water_log") {
            const { log_date, ml } = newRow as { log_date: string; ml: number };
            // Corrección de revisión (P1): si hay un objetivo LOCAL más
            // nuevo todavía sin confirmar para esta fecha, este evento
            // puede ser el eco de una escritura ANTERIOR (o de otro
            // dispositivo) que ya quedó obsoleta — aplicarlo pisaría
            // temporalmente el valor que el usuario ya ve. Se ignora hasta
            // que el upsert absoluto confirme y borre el pending; en ese
            // momento el estado local YA muestra el objetivo (se aplicó
            // de forma optimista al programarlo), así que no hace falta
            // ningún otro paso para "aceptar el valor confirmado".
            const uid = remote.user?.id;
            if (uid && remote.pendingWaterTargetFor(uid, log_date) !== null) return;
            setState((cur) => {
              const next = { ...cur, waterLog: { ...cur.waterLog, [log_date]: Number(ml) } };
              saveLocalStateDebounced(next);
              return next;
            });
          } else if (table === "weight_log") {
            const { log_date, kg } = newRow as { log_date: string; kg: number };
            setState((cur) => {
              const entries = cur.weightLog.filter((e) => e.date !== log_date);
              entries.push({ date: log_date, kg: Number(kg) });
              entries.sort((a, b) => a.date.localeCompare(b.date));
              const next = { ...cur, weightLog: entries };
              saveLocalStateDebounced(next);
              return next;
            });
          }
        },
        (connected) => {
          if (!cancelled) setRealtimeConnected(connected);
        },
      );
    }

    void remote.init().then((ok) => {
      if (cancelled || !ok) return;
      setRemoteReady(true);
      remote.onAuthChange((event: AuthChangeEvent, user) => {
        const newId = user?.id ?? null;
        const prevId = authUserRef.current?.id ?? null;

        // Bloqueante §7: un refresco de token del mismo usuario NO es un
        // cambio de sesión — no incrementa epoch, no cancela nada, no
        // reinicia hidratación. Idempotente frente a un doble SIGNED_IN del
        // mismo usuario (p.ej. eco de nuestra propia acción). Lógica
        // extraída a classifyAuthTransition() (pura, testeada aparte) para
        // no depender de renderizar el efecto completo en los tests.
        if (classifyAuthTransition(prevId, newId, event) === "same_session") {
          authUserRef.current = user;
          setAuthUser(user);
          return;
        }

        // Cambio REAL de sesión (login, logout, o cambio de cuenta).
        if (prevId && !remote.explicitSignOutInProgress) {
          // SIGNED_OUT sin que lo iniciara requestSignOut(): expulsión
          // involuntaria. Corrección de revisión (P1): antes, sin `pending`,
          // no se hacía nada — el FoodOSState completo del usuario saliente
          // se quedaba en localStorage sin TTL. resolveInvoluntaryLoss()
          // aparca lo pendiente con TTL si lo hay (§4); si no hay nada
          // pendiente, borra el envelope activo (ya sincronizado, sin razón
          // para seguir en este dispositivo). Si fue un logout explícito,
          // signOut() YA descartó el envelope por completo — no hay nada
          // que resolver aquí.
          outbox.resolveInvoluntaryLoss(prevId);
        }
        remote.resetSessionState();
        const epoch = remote.sessionEpoch;
        authUserRef.current = user;
        setAuthUser(user);
        realtimeUnsubRef.current?.();
        realtimeUnsubRef.current = null;
        // Corrección de revisión (P1, quinta ronda): hadUnsyncedEnvelopeWrite/
        // hadUnsyncedWaterWrite eran booleanos GLOBALES del provider, no
        // aislados por sesión/usuario — si A sufría un fallo durable y la
        // sesión cambiaba a B, B aparecía como "unsynced" desde el primer
        // instante aunque no tuviera ningún fallo propio (y, al no
        // limpiarse con un guardado genérico ajeno a esa fuente, podía
        // quedarse así hasta que B hiciera su propia operación de esa
        // fuente). Se reinician aquí, en cada cambio REAL de sesión — nunca
        // en un TOKEN_REFRESHED/USER_UPDATED/SIGNED_IN del mismo usuario
        // (esta rama de código no se alcanza para esos casos, ver el
        // `return` de arriba) — el estado persistido (outbox/agua
        // aparcada/pendiente) es lo que de verdad lleva la cuenta de qué
        // sigue sin confirmar entre sesiones; este flag efímero de UI no
        // debe sobrevivir al límite de una sesión.
        setHadUnsyncedEnvelopeWrite(false);
        setHadUnsyncedWaterWrite(false);

        if (newId) {
          clearLocalState();
          // resolveInitialStateForSession() restaura un aparcado si lo hay
          // (efecto secundario, se llama UNA sola vez aquí) y aplica el
          // envelope activo resultante a React de inmediato — ver su
          // comentario grande para el porqué (P0). El propio coordinador de
          // hidratación (ver createHydrationCoordinator) relee ese mismo
          // envelope y reprograma su push si tiene `pending` — no hace
          // falta programarlo aquí también.
          setState(resolveInitialStateForSession(newId, defaultState));
          outbox.restoreParkedWater(newId); // recupera agua aparcada (misma política de TTL que el envelope genérico — P1)
          remote.resumePendingWaterFor(newId); // agua persistida (aparcada o de una recarga) de este dispositivo (P0)
          void hydrateForUser(newId, epoch).then(() => { if (!cancelled) setupRealtime(); });
        } else {
          clearLocalState();
          setState(structuredClone(defaultState));
          setRealtimeConnected(false);
        }
      });
      // Deliberadamente SIN un `if (remote.user) hydrateRemote()` aparte
      // (bloqueante §8, doble hidratación inicial): supabase-js dispara
      // onAuthStateChange inmediatamente con INITIAL_SESSION si ya hay
      // sesión — el bloque de arriba ya la cubre. Duplicarlo aquí lanzaba
      // dos pullState() concurrentes para el mismo usuario al arrancar.
    });

    return () => {
      cancelled = true;
      realtimeUnsubRef.current?.();
      realtimeUnsubRef.current = null;
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
    };
  }, []);

  const showToast = useCallback((message: string, action?: ToastAction) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const dismiss = () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast(null);
    };
    setToast({
      message,
      // Al pulsar la acción, además de ejecutarla se cierra el toast al momento.
      action: action ? { label: action.label, onAction: () => { dismiss(); action.onAction(); } } : undefined,
    });
    toastTimer.current = setTimeout(() => setToast(null), action ? UNDO_TOAST_MS : 2600);
  }, []);

  // Avisa si un guardado no llegó a Supabase (queda solo en este dispositivo
  // hasta que remote.schedulePush lo reintente).
  useEffect(() => {
    remote.onPushError = () => {
      showToast("No se pudo sincronizar con el servidor, reintentando…");
    };
    return () => { remote.onPushError = null; };
  }, [showToast]);

  // Corrección de revisión (P1): si ni siquiera se pudo escribir la copia
  // LOCAL durable del agua pendiente (cuota de localStorage, fallo de
  // serialización — ver persistWaterPending en data-layer.ts), es tan
  // grave como el mismo fallo en mutate()/outbox.recordMutation() — pero
  // en su PROPIO flag (hadUnsyncedWaterWrite), nunca compartido con el del
  // envelope genérico (corrección de revisión, P1, cuarta ronda: antes un
  // guardado genérico correcto podía limpiar el aviso de un fallo de agua
  // que seguía sin resolverse). Se llama con cada intento (éxito o fallo),
  // así que también es quien limpia esta fuente cuando por fin persiste.
  useEffect(() => {
    remote.onUnsyncedWrite = (ok) => setHadUnsyncedWaterWrite(!ok);
    return () => { remote.onUnsyncedWrite = null; };
  }, []);

  // E04-07: refleja en la cabecera cada transición de guardado remoto.
  // B2 (revisión externa, 2026-08-22): además, delega en hydrationGateRef
  // (ver scheduleHydrate más arriba y realtime-hydration-gate.ts) si esta
  // transición debe procesar un refresco en tiempo real que se había
  // diferido — solo ocurre en "saved" y solo si de verdad quedó algo
  // diferido esperando.
  useEffect(() => {
    remote.onStatusChange = (status) => {
      setPushStatus(status);
      if (hydrationGateRef.current.onPushStatusChange(status)) {
        void hydrateRemoteRef.current();
      }
    };
    return () => { remote.onStatusChange = null; };
  }, []);

  // E04-07: navigator.onLine — un push fallaría igualmente estando offline,
  // así que la cabecera lo distingue de un error de servidor real.
  useEffect(() => {
    setIsOnline(navigator.onLine);
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const syncStatus: SyncStatus = computeSyncStatus({
    hasSupabaseConfig: hasSupabaseConfig(),
    isOnline,
    hadUnsyncedEnvelopeWrite,
    hadUnsyncedWaterWrite,
    pushStatus,
  });

  // Toda mutacion pasa por aqui: clona, aplica, persiste (local + remoto).
  // Corrección de revisión (bloqueante §2 del diseño): para un usuario
  // autenticado, la outbox (state+pending juntos, un solo setItem — ver
  // outbox.ts) se escribe de forma SÍNCRONA aquí, ANTES de programar el
  // push — nunca en un debounce que pudiera perder la mutación entera si
  // el proceso muere antes de que dispare (pagehide sigue existiendo como
  // defensa adicional para LOCAL_KEY del modo sin sesión, no como
  // requisito para que la outbox exista).
  const mutate = useCallback((fn: (draft: FoodOSState) => void) => {
    setState((current) => {
      const draft = structuredClone(current);
      fn(draft);
      // Si hay perfil, los objetivos del dia siempre derivan de el.
      if (draft.profile) {
        const targets = calcDailyTargets(draft.profile, isGymDay(draft.profile, stateDate(draft)), draft.macroPreference);
        draft.nutrition = {
          kcal: targets.kcal,
          protein: targets.protein,
          carbs: targets.carbs,
          fat: targets.fat,
          mode: draft.profile.goal,
        };
      }

      const userId = remote.user?.id ?? null;
      if (userId === null) {
        // Sin sesión: LOCAL_KEY es la única fuente de verdad, sin outbox.
        saveLocalStateDebounced(draft);
        return draft;
      }

      const epoch = remote.sessionEpoch;
      const written = outbox.recordMutation(userId, draft, outbox.getTabClientId());
      if (!written.ok) {
        // Corrección de revisión (P1, cuarta ronda): SOLO su propia
        // fuente (hadUnsyncedEnvelopeWrite) — nunca la del agua, que es
        // un problema totalmente independiente.
        setHadUnsyncedEnvelopeWrite(true);
        showToast("No se pudo guardar de forma segura en este dispositivo.");
        // Mejor esfuerzo: se intenta igualmente el push, pero con un
        // mutationId que NUNCA podrá hacer compare-and-delete en la
        // outbox (no llegó a escribirse) — así que runPush() jamás podrá
        // emitir "saved" por esta mutación en concreto, ni aunque la red
        // funcione — hadUnsyncedEnvelopeWrite es lo único que puede
        // limpiar esto.
        remote.schedulePush({ userId, epoch, mutationId: crypto.randomUUID(), revision: 0, state: draft });
        return draft;
      }
      setHadUnsyncedEnvelopeWrite(false);
      const pending = written.envelope.pending!;
      remote.schedulePush({ userId, epoch, mutationId: pending.mutationId, revision: pending.revision, state: draft });
      return draft;
    });
  }, [showToast]);

  // Corrección de revisión (P1): setWaterAbsolute()/addWater() llamaban a
  // remote.setWaterTargetDurable() DENTRO del updater de setState — los
  // updaters deben ser puros (React puede invocarlos más de una vez en
  // Strict Mode, o descartar la invocación bajo renderizado concurrente);
  // llamar a un efecto externo (red, outbox) ahí dentro arriesgaba
  // duplicar la operación. waterLogRef se mantiene sincronizado de forma
  // SÍNCRONA (nunca vía useEffect, que llegaría un tick tarde) en cada
  // llamada — así dos llamadas consecutivas en el mismo tick ya ven el
  // valor correcto sin depender de que React haya vuelto a renderizar.
  // El propio updater queda puro: solo clona y aplica applyWaterTarget();
  // el efecto externo se dispara UNA vez, fuera de él.
  const waterLogRef = useRef(state.waterLog);
  useEffect(() => { waterLogRef.current = state.waterLog; }); // sin deps: resincroniza tras CUALQUIER commit (hidratación, Realtime, undo...)

  /** Fija el agua de una fecha a un valor absoluto — optimista en local Y
      durable en remoto (reconciliación por objetivo, ver
      setWaterTargetDurable en data-layer.ts). Corrección de revisión (P0):
      TODA mutación de waterLog debe pasar por aquí (o por addWater más
      abajo, que la usa) — nunca por mutate() genérico, porque pushState()
      excluye water_log a propósito (ver el comentario en pushState) y el
      cambio nunca llegaría a Supabase aunque el badge dijera "Guardado"
      (ver SettingsView.clearToday/deshacer/seedHistorico). */
  const setWaterAbsolute = useCallback((date: string, targetMl: number) => {
    const clamped = Math.max(0, targetMl);
    // Corrección de revisión (P2, sexta ronda): antes esta validación solo
    // vivía en remote.setWaterTargetDurable() — el ref, React y LOCAL_KEY
    // ya se habían modificado por entonces, así que un NaN/decimal podía
    // quedar visible localmente mientras la escritura remota se descartaba
    // en silencio (local y remoto dejaban de coincidir en el mismo
    // objetivo). Se valida AQUÍ, en el punto de entrada del contexto,
    // antes de tocar el ref/React/almacenamiento — el mismo valor se
    // acepta o se rechaza a la vez para ambos lados. Math.max() de arriba
    // es cómputo puro, no toca nada compartido todavía.
    if (!outbox.isValidCalendarDateKey(date) || !outbox.isValidWaterTarget(clamped)) {
      console.warn("FoodOS: setWaterAbsolute() recibió una fecha/objetivo inválido — se ignora, no toca local ni remoto", { date, targetMl });
      return;
    }
    waterLogRef.current = { ...waterLogRef.current, [date]: clamped };
    setState((current) => {
      const next = applyWaterTarget(current, date, clamped);
      // saveLocalStateDebounced() se queda dentro del updater a propósito
      // (a diferencia de remote.setWaterTargetDurable(), que NO): es un
      // debounce que coalesce en una sola escritura final — invocarlo de
      // más (Strict Mode) es, como mucho, trabajo redundante, nunca una
      // operación duplicada de verdad (no tiene estado de reintento ni
      // efectos de red). applyWaterTarget() en sí sigue siendo pura.
      saveLocalStateDebounced(next);
      return next;
    });
    remote.setWaterTargetDurable(date, clamped); // UNA sola vez, fuera del updater
  }, []);

  const addWater = useCallback((ml: number) => {
    // Respeta la fecha simulada (debugDate) en vez de asumir siempre "hoy" real.
    const date = state.debugDate ?? todayPlus(0);
    // Lee del ref (sincronizado al instante por la propia llamada anterior,
    // nunca solo por el efecto) — no del `state` capturado en el cierre del
    // callback, que podría estar un render por detrás si addWater() se
    // llama varias veces seguidas en el mismo evento.
    const target = Math.max(0, (waterLogRef.current[date] ?? 0) + ml);
    // Ver el comentario en setWaterAbsolute (P2, sexta ronda) — misma
    // validación, en el mismo punto de entrada, antes de tocar nada
    // compartido. Leer waterLogRef.current es una lectura pura, no muta.
    if (!outbox.isValidCalendarDateKey(date) || !outbox.isValidWaterTarget(target)) {
      console.warn("FoodOS: addWater() calculó un objetivo inválido — se ignora, no toca local ni remoto", { date, ml, target });
      return;
    }
    waterLogRef.current = { ...waterLogRef.current, [date]: target };
    setState((current) => {
      const next = applyWaterTarget(current, date, target);
      saveLocalStateDebounced(next); // ver el comentario en setWaterAbsolute — idempotente, se queda dentro
      return next;
    });
    // RPC atómica y durable (cola + reintento propios, integrados en el
    // estado de sync global — ver setWaterTargetDurable en data-layer.ts):
    // un fallo aquí ya no se pierde en un simple .catch(console.warn), y
    // un reintento tras un fallo ambiguo nunca duplica mililitros (upsert
    // absoluto e idempotente, ver processWaterQueue). UNA sola vez, fuera
    // del updater.
    remote.setWaterTargetDurable(date, target);
  }, [state.debugDate]);

  /** ÚNICO punto de entrada para cerrar sesión (bloqueante §7) — centraliza
      la decisión sobre datos pendientes en un solo sitio, para que ningún
      callsite pueda saltársela llamando a remote.signOut() directamente. La
      decisión en sí (flushPendingOrTimeout, resolveSignOutChoice) vive como
      funciones exportadas de nivel de módulo — testeables directamente con
      Vitest sin renderizar React. */
  const requestSignOut = useCallback(async (): Promise<"signed_out" | "cancelled" | "failed"> => {
    const userId = remote.user?.id;
    // Corrección de revisión (P1): antes solo miraba outbox.hasPending(),
    // nunca el agua pendiente — un cierre de sesión con SOLO agua
    // pendiente (sin ningún cambio en el snapshot genérico) salía en
    // silencio, sin ofrecer la decisión explícita del diseño §4.
    // hasPendingWaterFor(userId) — explícito, coherente con el resto de
    // esta corrección de revisión.
    if (!userId || (!outbox.hasPending(userId) && !remote.hasPendingWaterFor(userId))) {
      const { ok, cleanupOk } = await remote.signOut();
      if (!ok) {
        // Corrección de revisión (P1, sexta ronda): remote.signOut() ya NO
        // tocó nada local (la sesión sigue activa tal cual) — nunca
        // afirmar "sesión cerrada" en este caso.
        showToast("No se pudo cerrar la sesión. Comprueba la conexión e inténtalo de nuevo.");
        return "failed";
      }
      reportCleanupIssue(showToast, cleanupOk);
      return "signed_out";
    }
    const choice = await new Promise<"wait" | "cancel" | "discard">((resolve) => setSignOutPrompt({ resolve }));
    setSignOutPrompt(null);
    const { status, cleanupOk } = await resolveSignOutChoice(userId, choice);
    if (status === "cancelled_timeout" || status === "cancelled_error") {
      showToast(status === "cancelled_timeout" ? "Sigue sin sincronizar — inténtalo de nuevo." : "No se pudo sincronizar — inténtalo de nuevo.");
      return "cancelled";
    }
    if (status === "cancelled") return "cancelled";
    if (status === "sign_out_failed") {
      showToast("No se pudo cerrar la sesión. Comprueba la conexión e inténtalo de nuevo.");
      return "failed";
    }
    reportCleanupIssue(showToast, cleanupOk);
    return "signed_out";
  }, [showToast]);

  const resetAll = useCallback(() => {
    clearLocalState();
    setState(structuredClone(defaultState));
    showToast("Datos locales borrados");
  }, [showToast]);

  const seedDemo = useCallback(() => {
    const demo = structuredClone(defaultState);
    demo.inventory = [
      { id: uid(), name: "Pechuga de pollo", qty: 260, unit: "g", storage: "Nevera", expires: todayPlus(1), price: 2.8, kcal: 165, protein: 31 },
      { id: uid(), name: "Arroz integral", qty: 500, unit: "g", storage: "Despensa", expires: todayPlus(60), price: 1.7, kcal: 360, protein: 8 },
      { id: uid(), name: "Tomate cherry", qty: 180, unit: "g", storage: "Nevera", expires: todayPlus(3), price: 1.4, kcal: 18, protein: 1 },
      { id: uid(), name: "Yogur griego", qty: 1, unit: "ud", unitSize: 125, storage: "Nevera", expires: todayPlus(2), price: 0.9, kcal: 95, protein: 10 },
      { id: uid(), name: "Huevos", qty: 6, unit: "ud", unitSize: 60, storage: "Nevera", expires: todayPlus(12), price: 1.8, kcal: 155, protein: 13 },
    ];
    demo.cart = [{ id: uid(), name: "Avena", qty: 1, unit: "ud", price: 1.4, store: "Mercadona", checked: false }];
    demo.incomeSources = [
      { id: uid(), name: "Nómina", amount: 1450, frequency: "monthly", dayOfMonth: 28, active: true },
    ];
    demo.recurringExpenses = [
      { id: uid(), name: "Alquiler", amount: 620, frequency: "monthly", category: "Vivienda", active: true },
      { id: uid(), name: "Luz + agua", amount: 65, frequency: "monthly", category: "Suministros", active: true },
      { id: uid(), name: "Internet", amount: 38, frequency: "monthly", category: "Suministros", active: true },
      { id: uid(), name: "Spotify", amount: 11.99, frequency: "monthly", category: "Suscripciones", active: true },
    ];
    demo.expenses = [
      { id: uid(), type: "expense", amount: 38.4, category: "Comida", description: "Mercadona demo", date: todayMinus(1) },
      { id: uid(), type: "expense", amount: 22.5, category: "Comida", description: "Frutería demo", date: todayMinus(5) },
      { id: uid(), type: "expense", amount: 24.2, category: "Salud", description: "Suplementos demo", date: todayMinus(10) },
      { id: uid(), type: "expense", amount: 47.9, category: "Comida", description: "Lidl demo", date: todayMinus(16) },
      { id: uid(), type: "expense", amount: 19.6, category: "Ocio", description: "Cena fuera demo", date: todayMinus(23) },
      { id: uid(), type: "expense", amount: 32.0, category: "Ocio", description: "Fin de semana demo", date: todayMinus(28) },
    ];
    // Historial demo del diario: ayer y anteayer con comidas y agua.
    demo.foodLog = [
      { id: uid(), date: todayMinus(1), time: "09:10", name: "Tostada de huevo y yogur", qty: null, unit: null, kcal: 480, protein: 32, carbs: 48, fat: 18, source: "recipe", mealType: "breakfast" },
      { id: uid(), date: todayMinus(1), time: "14:25", name: "Bowl proteico de pollo", qty: null, unit: null, kcal: 610, protein: 54, carbs: 72, fat: 12, source: "recipe", mealType: "lunch" },
      { id: uid(), date: todayMinus(1), time: "21:05", name: "Yogur griego", qty: 125, unit: "g", kcal: 119, protein: 12.5, carbs: 5, fat: 6, source: "inventory", mealType: "dinner" },
      { id: uid(), date: todayMinus(2), time: "13:40", name: "Pasta rápida con atún", qty: null, unit: null, kcal: 690, protein: 42, carbs: 96, fat: 14, source: "recipe", mealType: "lunch" },
      { id: uid(), date: todayMinus(2), time: "20:50", name: "Lentejas de despensa", qty: null, unit: null, kcal: 540, protein: 28, carbs: 92, fat: 7, source: "recipe", mealType: "dinner" },
    ];
    demo.waterLog = { [todayMinus(1)]: 2250, [todayMinus(2)]: 1750 };
    // Historial de peso demo: últimas 2 semanas con tendencia descendente ligera.
    // E21-20: ruido determinista (seed fija), no Math.random() — los tests
    // e2e que cargan datos demo necesitan el mismo resultado en cada carga.
    const weightJitter = seededJitter(20260101);
    demo.weightLog = Array.from({ length: 14 }, (_, i) => ({
      date: todayMinus(13 - i),
      kg: Math.round((78.4 - i * 0.12 + (weightJitter() - 0.5) * 0.3) * 10) / 10,
    }));
    saveLocalState(demo);
    const userId = remote.user?.id ?? null;
    if (userId) {
      const written = outbox.recordMutation(userId, demo, outbox.getTabClientId());
      if (written.ok && written.envelope.pending) {
        remote.schedulePush({ userId, epoch: remote.sessionEpoch, mutationId: written.envelope.pending.mutationId, revision: written.envelope.pending.revision, state: demo });
      }
      // demo.waterLog NO viaja en el snapshot genérico de arriba (pushState
      // excluye water_log a propósito) — cada fecha se fija por separado a
      // través de la RPC durable, igual que cualquier otra escritura de
      // agua (ver setWaterAbsolute).
      Object.entries(demo.waterLog).forEach(([date, ml]) => remote.setWaterTargetDurable(date, ml));
    }
    setState(demo);
    setMascotMessage("Datos demo cargados. Configura tu perfil en Nutrición.");
    showToast("Datos demo cargados");
  }, [showToast]);

  const triggerMascot = useCallback((anim: MascotState, message?: string) => {
    if (mascotTimer.current) clearTimeout(mascotTimer.current);
    setMascotState(anim);
    if (message) setMascotMessage(message);
    if (!LOOP_MASCOT_STATES.includes(anim)) {
      mascotTimer.current = setTimeout(() => setMascotState("idle"), 2800);
    }
  }, []);

  // Memoizado para que los cambios del contexto de UI (toast/mascota, muy
  // frecuentes) no invaliden este valor y re-rendericen a los 30+ consumidores
  // de useFoodOS(). Todos los callbacks son estables (useCallback).
  const mainValue = useMemo<FoodOSContextValue>(
    () => ({
      state,
      hydrated,
      remoteReady,
      remoteHydrated,
      authUser,
      realtimeConnected,
      syncStatus,
      showToast,
      setMascotMessage,
      triggerMascot,
      mutate,
      addWater,
      setWaterAbsolute,
      resetAll,
      seedDemo,
      requestSignOut,
    }),
    [state, hydrated, remoteReady, remoteHydrated, authUser, realtimeConnected, syncStatus, showToast, triggerMascot, mutate, addWater, setWaterAbsolute, resetAll, seedDemo, requestSignOut]
  );

  const uiValue = useMemo<FoodOSUIValue>(
    () => ({ toast, mascotMessage, mascotState }),
    [toast, mascotMessage, mascotState]
  );

  return (
    <FoodOSContext.Provider value={mainValue}>
      <FoodOSUIContext.Provider value={uiValue}>
        {children}
        {signOutPrompt && (
          <Modal title="Tienes cambios sin sincronizar" onClose={() => signOutPrompt.resolve("cancel")}>
            <p>
              Hay un cambio que todavía no ha llegado al servidor. Si cierras sesión ahora sin
              esperar, podría perderse en este dispositivo.
            </p>
            <div className="recipe-detail-actions" style={{ marginTop: 20, flexDirection: "column", gap: 10 }}>
              <button className="primary-button" onClick={() => signOutPrompt.resolve("wait")}>
                Esperar a que se guarde y salir
              </button>
              <button className="secondary-button" onClick={() => signOutPrompt.resolve("cancel")}>
                Cancelar
              </button>
              <button className="danger-button danger-button--small" onClick={() => signOutPrompt.resolve("discard")}>
                Salir y descartar esos cambios
              </button>
            </div>
          </Modal>
        )}
      </FoodOSUIContext.Provider>
    </FoodOSContext.Provider>
  );
}

export function useFoodOS(): FoodOSContextValue {
  const context = useContext(FoodOSContext);
  if (!context) throw new Error("useFoodOS debe usarse dentro de <FoodOSProvider>");
  return context;
}

/** Estado efímero de UI (toast + mascota). Contexto aparte a propósito:
    consumirlo desde useFoodOS() re-renderizaba toda la app en cada toast. */
export function useFoodOSUI(): FoodOSUIValue {
  const context = useContext(FoodOSUIContext);
  if (!context) throw new Error("useFoodOSUI debe usarse dentro de <FoodOSProvider>");
  return context;
}

// ---------- Selectores y helpers de dominio ----------

export function allRecipes(state: FoodOSState): Recipe[] {
  return [...state.customRecipes, ...DEMO_RECIPES];
}

export function findRecipe(state: FoodOSState, recipeId: string): Recipe | undefined {
  return allRecipes(state).find((recipe) => recipe.id === recipeId);
}

/** Devuelve "hoy" teniendo en cuenta la fecha de depuración si está activa. */
export function getToday(state: FoodOSState): string {
  return state.debugDate ?? todayPlus(0);
}

/** Resuelve un ID del planificador buscando en recetas y en platos rápidos. */
export function findPlanEntry(
  state: FoodOSState,
  id: string
): { title: string; kcal: number; protein: number; carbs: number; fat: number; cost: number; image?: string } | null {
  const r = allRecipes(state).find((x) => x.id === id);
  if (r) return { title: r.title, kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, cost: r.cost, image: r.image };
  const q = (state.plannerQuickMeals ?? []).find((x) => x.id === id);
  if (q) return { title: q.name, kcal: q.kcal, protein: q.protein, carbs: q.carbs, fat: q.fat, cost: q.cost };
  return null;
}

/** Quita de plannerQuickMeals los platos rápidos que ningún slot del
    planificador referencia ya (se quitaron o se reemplazaron por otra cosa).
    Sin esto, cada plato rápido creado se quedaba para siempre en el estado,
    aunque se borrara del plan — llamar tras cualquier mutación de mealPlan. */
export function pruneOrphanedQuickMeals(draft: FoodOSState): void {
  if (!draft.plannerQuickMeals?.length) return;
  const referencedIds = new Set(
    Object.values(draft.mealPlan ?? {}).flatMap((day) => Object.values(day as Record<string, string>))
  );
  draft.plannerQuickMeals = draft.plannerQuickMeals.filter((qm) => referencedIds.has(qm.id));
}

/** Gramos/ml disponibles en inventario para un ingrediente, sumando todos
    los lotes cuyo nombre casa (namesMatch). */
function availableForIngredient(state: FoodOSState, ingredientName: string): number {
  return state.inventory
    .filter((item) => namesMatch(item.name, ingredientName))
    .reduce((sum, item) => sum + toGrams(item.qty, item.unit, item.unitSize), 0);
}

/** E08-06: antes "tener" un ingrediente era solo que existiera ALGO con ese
    nombre en inventario, aunque fueran 5g de los 500g que pide la receta.
    Ahora compara cantidades (convertidas a gramos/ml vía toGrams, misma
    lógica que el resto de la app) — "tener" significa tener lo suficiente. */
function hasEnoughForIngredient(state: FoodOSState, ingredient: Recipe["ingredients"][number]): boolean {
  const available = availableForIngredient(state, ingredient.name);
  if (available <= 0) return false;
  return available >= toGrams(ingredient.quantity, ingredient.unit);
}

export function getRecipeMatch(state: FoodOSState, recipe: Recipe) {
  const matches = recipe.ingredients.filter((ingredient) => hasEnoughForIngredient(state, ingredient));
  return { matches, pct: Math.round((matches.length / Math.max(1, recipe.ingredients.length)) * 100) };
}

export function getIngredientStatus(state: FoodOSState, recipe: Recipe) {
  return recipe.ingredients.map((ingredient) => ({
    name: ingredient.name,
    quantity: ingredient.quantity,
    unit: ingredient.unit,
    has: hasEnoughForIngredient(state, ingredient),
  }));
}

export function bestRecipe(state: FoodOSState): Recipe {
  return [...allRecipes(state)].sort(
    (a, b) => getRecipeMatch(state, b).pct - getRecipeMatch(state, a).pct || b.protein - a.protein
  )[0];
}

// ---------- Diario de comidas y agua ----------

function nowTime(): string {
  return new Date().toTimeString().slice(0, 5);
}

/** Entradas del diario de hoy, ordenadas por hora. */
export function getTodayLog(state: FoodOSState): FoodLogEntry[] {
  const today = getToday(state);
  return state.foodLog
    .filter((entry) => entry.date === today)
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** Totales consumidos hoy (derivados del diario — se reinician solos cada dia). */
export function getConsumedToday(state: FoodOSState): MacroTotals {
  return getTodayLog(state).reduce(
    (totals, entry) => ({
      kcal: totals.kcal + entry.kcal,
      protein: totals.protein + entry.protein,
      carbs: totals.carbs + entry.carbs,
      fat: totals.fat + entry.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
}

export function getWaterToday(state: FoodOSState): number {
  return state.waterLog[getToday(state)] ?? 0;
}

export function getStepsToday(state: FoodOSState): number {
  return state.stepsLog?.[getToday(state)] ?? 0;
}

/** kcal quemadas en sesiones de entrenamiento registradas hoy. */
export function getKcalBurnedToday(state: FoodOSState): number {
  const today = getToday(state);
  return (state.workoutLog ?? [])
    .filter((s) => s.date === today && (s.kcalBurned ?? 0) > 0)
    .reduce((sum, s) => sum + (s.kcalBurned ?? 0), 0);
}

/** Diario agrupado por dia (mas reciente primero), con totales. */
export function getLogByDay(state: FoodOSState): Array<{
  date: string;
  entries: FoodLogEntry[];
  totals: MacroTotals;
  water: number;
}> {
  const byDate = new Map<string, FoodLogEntry[]>();
  state.foodLog.forEach((entry) => {
    const list = byDate.get(entry.date) ?? [];
    list.push(entry);
    byDate.set(entry.date, list);
  });
  Object.keys(state.waterLog).forEach((date) => {
    if (!byDate.has(date) && state.waterLog[date] > 0) byDate.set(date, []);
  });
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, entries]) => ({
      date,
      entries: entries.sort((a, b) => b.time.localeCompare(a.time)),
      totals: entries.reduce(
        (totals, entry) => ({
          kcal: totals.kcal + entry.kcal,
          protein: totals.protein + entry.protein,
          carbs: totals.carbs + entry.carbs,
          fat: totals.fat + entry.fat,
        }),
        { kcal: 0, protein: 0, carbs: 0, fat: 0 }
      ),
      water: state.waterLog[date] ?? 0,
    }));
}

/** Macros que quedan por consumir hoy.
 *  El gasto de entrenamiento (getKcalBurnedToday) NO se suma aquí — pero OJO
 *  con la razón correcta (nutrition-v3 §3.2): NO es que "el PAL/perfil ya
 *  incluya la actividad habitual" — LIFESTYLE_ONLY_FACTORS (modelo
 *  lifestyle_plus_training) cubre solo trabajo/desplazamientos/tareas, el
 *  entrenamiento deliberado NO está ahí. La razón real es que el
 *  entrenamiento habitual ya entra en calcTDEE() vía
 *  replacementIncrementKcal (calcTdeeBreakdown en nutrition.ts) — sumar
 *  además el gasto de la sesión registrada volvería a contar ese mismo
 *  componente. El gasto se muestra en la UI como dato informativo, no como
 *  presupuesto extra — ver TodayRingPanel. */
export function getPendingMacros(state: FoodOSState): MacroTotals {
  const consumed = getConsumedToday(state);
  return {
    kcal: Math.max(0, state.nutrition.kcal - consumed.kcal),
    protein: Math.max(0, state.nutrition.protein - consumed.protein),
    carbs: Math.max(0, state.nutrition.carbs - consumed.carbs),
    fat: Math.max(0, state.nutrition.fat - consumed.fat),
  };
}

/** Macros de una cantidad concreta de un alimento del inventario.
    Carbos y grasas se estiman (el inventario solo guarda kcal y proteina por 100). */
export function macrosForQuantity(item: InventoryItem, qty: number): MacroTotals {
  const grams = toGrams(qty, item.unit, item.unitSize);
  const kcal = (item.kcal * grams) / 100;
  const protein = (item.protein * grams) / 100;
  const fat = item.fat != null
    ? (item.fat * grams) / 100
    : Math.max(0, (kcal * 0.25) / 9);
  const carbs = item.carbs != null
    ? (item.carbs * grams) / 100
    : Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
  return {
    kcal: Math.round(kcal),
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fat: Math.round(fat * 10) / 10,
  };
}

/** Busca el tamaño por unidad ("ud") que el usuario ya indicó para un producto con
    este nombre: primero en el inventario actual, si no en el historial del diario
    (snapshot guardado al consumir). Evita tener que reintroducirlo cada vez que se
    vuelve a comprar el mismo producto (ej. una lata de Monster). */
export function findRememberedUnitSize(state: FoodOSState, name: string): number | undefined {
  const key = name.toLowerCase().trim();
  if (!key) return undefined;
  const fromInventory = state.inventory.find(
    (item) => item.name.toLowerCase().trim() === key && item.unitSize != null
  );
  if (fromInventory) return fromInventory.unitSize;
  for (let i = state.foodLog.length - 1; i >= 0; i--) {
    const entry = state.foodLog[i];
    if (entry.name.toLowerCase().trim() === key && entry.inventorySnapshot?.unitSize != null) {
      return entry.inventorySnapshot.unitSize;
    }
  }
  return undefined;
}

/** Precio POR UNIDAD (€/g, €/ml o €/ud) del lote de inventario más reciente con
    ese nombre, para prefijar el precio al re-añadir un alimento sin reescribirlo.
    Del inventario (price/qty es un precio unitario bien definido); si no queda
    ningún lote, undefined — no se puede derivar del diario porque el snapshot
    guarda el precio del lote entero, no la cantidad original. */
export function findRememberedUnitPrice(state: FoodOSState, name: string): number | undefined {
  const key = name.toLowerCase().trim();
  if (!key) return undefined;
  const lot = state.inventory.find(
    (item) => item.name.toLowerCase().trim() === key && item.qty > 0 && item.price > 0
  );
  if (!lot) return undefined;
  return lot.price / lot.qty;
}

// Traduce los tags de alérgenos de Open Food Facts (taxonomía en inglés, prefijo "en:")
// a términos en español para poder cruzarlos con profile.allergies (texto libre del usuario).
const OFF_ALLERGEN_TERMS: Record<string, string[]> = {
  "en:gluten":      ["gluten", "trigo", "cebada", "centeno"],
  "en:milk":        ["leche", "lactosa", "lácteos", "lacteos"],
  "en:eggs":        ["huevo", "huevos"],
  "en:nuts":        ["frutos secos", "almendra", "nuez", "nueces", "avellana", "anacardo", "pistacho"],
  "en:peanuts":     ["cacahuete", "cacahuetes", "maní", "mani"],
  "en:soybeans":    ["soja"],
  "en:fish":        ["pescado"],
  "en:crustaceans": ["crustáceo", "crustaceo", "marisco", "gamba", "langostino"],
  "en:molluscs":    ["molusco", "mejillón", "mejillon", "calamar", "pulpo"],
  "en:sesame-seeds":["sésamo", "sesamo"],
  "en:celery":      ["apio"],
  "en:mustard":     ["mostaza"],
  "en:sulphur-dioxide-and-sulphites": ["sulfito", "sulfitos"],
  "en:lupin":       ["altramuz", "altramuces"],
};

/** Cruza los alérgenos de un producto (tags OFF) con las alergias declaradas por el
    usuario (texto libre). Devuelve las alergias del usuario que coinciden, para avisar
    antes de guardar el producto en el inventario. */
export function matchAllergens(state: FoodOSState, allergenTags?: string[]): string[] {
  const allergies = state.profile?.allergies ?? [];
  if (!allergenTags?.length || !allergies.length) return [];
  const productTerms = allergenTags.flatMap((tag) => OFF_ALLERGEN_TERMS[tag] ?? [tag.replace(/^en:/, "")]);
  const matched = new Set<string>();
  for (const allergy of allergies) {
    const a = allergy.toLowerCase().trim();
    if (!a) continue;
    if (productTerms.some((term) => a.includes(term) || term.includes(a))) {
      matched.add(allergy);
    }
  }
  return [...matched];
}

/**
 * Sugerencia de cena para cerrar macros (PDF §9.5 + §15):
 * solo se activa entre las 18:30 y las 23:00 cuando quedan macros relevantes.
 * Prioriza recetas que usen alimentos a punto de caducar.
 */
export function getDinnerSuggestion(state: FoodOSState): {
  recipe: Recipe;
  pendingKcal: number;
  pendingProtein: number;
  usedExpiringItem: InventoryItem | undefined;
} | null {
  const now = new Date();
  const timeDecimal = now.getHours() + now.getMinutes() / 60;
  const dinnerFrom = (state.settings?.dinnerSuggestionHour ?? 18) + 0.5;
  if (timeDecimal < dinnerFrom || timeDecimal >= 23) return null;

  const pending = getPendingMacros(state);
  if (pending.kcal < 100 && pending.protein < 10) return null;

  const expiringItems = state.inventory
    .filter((item) => item.qty > 0 && daysUntil(item.expires) <= 3)
    .sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires));

  const budgetLeft = getBudgetLeft(state);

  const best = allRecipes(state)
    .filter((r) => r.cost <= Math.max(budgetLeft, 1.5))
    .map((r) => {
      const usedExpiringItem = expiringItems.find((item) =>
        r.ingredients.some((ing) => namesMatch(item.name, ing.name))
      );
      const matchPct = getRecipeMatch(state, r).pct;
      // Penalidad: cuanto más se aleja del kcal pendiente, peor puntuacion.
      const kcalDiff = Math.abs(r.kcal - pending.kcal) / Math.max(pending.kcal, 1);
      return { r, usedExpiringItem, matchPct, kcalDiff };
    })
    .filter((e) => e.matchPct >= 20 || e.usedExpiringItem)
    .sort((a, b) => {
      if (a.usedExpiringItem && !b.usedExpiringItem) return -1;
      if (!a.usedExpiringItem && b.usedExpiringItem) return 1;
      return a.kcalDiff - b.kcalDiff;
    })[0];

  if (!best) return null;
  return {
    recipe: best.r,
    pendingKcal: Math.round(pending.kcal),
    pendingProtein: Math.round(pending.protein),
    usedExpiringItem: best.usedExpiringItem,
  };
}

/** Última entrada del historial de peso, o null si no hay registros. */
export function getLatestWeight(state: FoodOSState): WeightEntry | null {
  if (!state.weightLog.length) return null;
  return [...state.weightLog].sort((a, b) => b.date.localeCompare(a.date))[0];
}

// ---------- Plan semanal automático (PDF §9.5) ----------

export interface WeeklyDayPlan {
  date: string;
  dayName: string;
  isGym: boolean;
  targets: DailyTargets;
  breakfast: Recipe | null;
  lunch: Recipe | null;
  dinner: Recipe | null;
}

/**
 * Genera un plan de 7 días: para cada día asigna 3 recetas (desayuno/comida/cena)
 * ajustadas al ciclado gym/descanso, respetando alergias y variando cada día.
 */
export function generateWeeklyPlan(state: FoodOSState): WeeklyDayPlan[] {
  if (!state.profile) return [];

  const DAY_NAMES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const excluded = [
    ...(state.profile.allergies ?? []),
    ...(state.profile.excludedFoods ?? []),
  ].map((s) => s.toLowerCase());

  const eligible = allRecipes(state).filter(
    (r) =>
      !excluded.some(
        (ex) =>
          r.title.toLowerCase().includes(ex) ||
          r.ingredients.some((ing) => ing.name.toLowerCase().includes(ex))
      )
  );

  if (!eligible.length) return [];

  const pick = (targetKcal: number, dayIndex: number, already: string[]): Recipe | null => {
    const pool = eligible.filter((r) => !already.includes(r.id));
    if (!pool.length) return eligible[dayIndex % eligible.length] ?? null;
    const sorted = [...pool].sort((a, b) => Math.abs(a.kcal - targetKcal) - Math.abs(b.kcal - targetKcal));
    return sorted[dayIndex % sorted.length] ?? sorted[0];
  };

  const planBase = state.debugDate ?? todayPlus(0);
  return Array.from({ length: 7 }, (_, i) => {
    const date = dateOffset(planBase, i);
    const dayOfWeek = new Date(date + "T12:00:00").getDay();
    const isGym = state.profile!.gymDays.includes(dayOfWeek);
    const targets = calcDailyTargets(state.profile!, isGym, state.macroPreference);

    const breakfast = pick(targets.kcal * 0.25, i, []);
    const lunch = pick(targets.kcal * 0.35, i + 1, breakfast ? [breakfast.id] : []);
    const dinner = pick(
      targets.kcal * 0.40,
      i + 2,
      [breakfast?.id, lunch?.id].filter(Boolean) as string[]
    );

    return { date, dayName: DAY_NAMES[dayOfWeek], isGym, targets, breakfast, lunch, dinner };
  });
}

// Gasto de comida de los ultimos 7 dias (ventana del presupuesto semanal).
export function getFoodSpend(state: FoodOSState): number {
  const weekAgo = dateFromKey(getToday(state));
  weekAgo.setDate(weekAgo.getDate() - 7);
  weekAgo.setHours(0, 0, 0, 0);
  return state.expenses
    .filter((expense) => expense.type === "expense" && expense.category === "Comida")
    .filter((expense) => dateFromKey(expense.date || getToday(state)) >= weekAgo)
    .reduce((sum, expense) => sum + Number(expense.amount), 0);
}

export function getBudgetLeft(state: FoodOSState): number {
  return Math.max(0, Number(state.weeklyBudget) - getFoodSpend(state));
}

/** Cuánto puedes gastar en variables (comida, ocio…) esta semana y seguir
 *  cumpliendo tu meta de ahorro: ingresos fijos − gastos fijos − ahorro
 *  objetivo, todo prorrateado a semana (mes / 4.345). 0 si no hay ingresos
 *  configurados o el resultado es negativo (gastos fijos ya se comen la meta). */
export function getWeeklySavingsTarget(state: FoodOSState): number {
  const WEEKS_PER_MONTH = 4.345;
  const weeklyIncome = state.incomeSources
    .filter((s) => s.active)
    .reduce((sum, s) => sum + monthlyAmountOf(s.frequency, s.amount), 0) / WEEKS_PER_MONTH;
  if (weeklyIncome <= 0) return 0;
  const weeklyFixed = (state.recurringExpenses ?? [])
    .filter((r) => r.active)
    .reduce((sum, r) => sum + monthlyAmountOf(r.frequency, r.amount), 0) / WEEKS_PER_MONTH;
  const weeklyGoal = weeklyIncome * ((state.savingsGoalPct ?? 20) / 100);
  return Math.max(0, weeklyIncome - weeklyFixed - weeklyGoal);
}

/** Por cada una de las últimas N semanas (7 días, terminando hoy), ¿el gasto
 *  variable real (dated, category != fijo) se mantuvo dentro de lo que
 *  permite la meta de ahorro? Igual patrón que getMacroAdherenceHistory: el
 *  gasto variable sí varía semana a semana con el comportamiento real del
 *  usuario (los gastos fijos no, por eso no cuentan aquí — machacarían
 *  siempre el mismo resultado). "empty" si no hay ingresos configurados. */
export function getWeeklySavingsHistory(
  state: FoodOSState,
  weeks = 12
): Array<{ weekStart: string; weekEnd: string; spend: number; target: number; status: "hit" | "miss" | "empty" }> {
  const target = getWeeklySavingsTarget(state);
  const today = dateFromKey(getToday(state));
  return Array.from({ length: weeks }, (_, i) => {
    const offset = weeks - 1 - i;
    const end = new Date(today); end.setDate(today.getDate() - offset * 7);
    const start = new Date(end); start.setDate(end.getDate() - 6);
    const spend = state.expenses
      .filter((e) => e.type === "expense")
      .filter((e) => { const d = dateFromKey(e.date); return d >= start && d <= end; })
      .reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const weekStart = start.toISOString().slice(0, 10);
    const weekEnd = end.toISOString().slice(0, 10);
    if (target <= 0) return { weekStart, weekEnd, spend, target, status: "empty" as const };
    return { weekStart, weekEnd, spend, target, status: spend <= target ? ("hit" as const) : ("miss" as const) };
  });
}

/** Semanas consecutivas (contando desde la actual hacia atrás) dentro del
 *  presupuesto variable que exige la meta de ahorro. Se corta en el primer
 *  "miss"; una semana "empty" (sin ingresos configurados) también corta. */
export function getSavingsStreak(state: FoodOSState): number {
  const history = getWeeklySavingsHistory(state, 26);
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].status === "hit") streak++;
    else break;
  }
  return streak;
}

/** ¿Sigue habiendo algún OTRO item de inventario (o lote) que use esta misma
    URL de imagen? (completeCart/moveCheckedToInventory copian imageUrl del
    lote existente al restockear, así que la misma foto de Storage puede estar
    referenciada por varios items). Comprobarlo antes de borrar de Storage: si
    se comparte, borrarla rompería la foto del/de los otros items. */
export function isImageUrlReferencedElsewhere(state: FoodOSState, url: string, excludeItemId: string): boolean {
  return state.inventory.some((item) => item.id !== excludeItemId && item.imageUrl === url);
}

/** Items del inventario casi vacíos que no están pendientes ya en el carrito. */
export function getLowStockSuggestions(state: FoodOSState): import("@foodos/types").CartItem[] {
  const thresholds = state.settings?.lowStockThresholds ?? DEFAULT_SETTINGS.lowStockThresholds;
  // Excluir tanto los pendientes como los ya marcados: si el item está en carrito
  // (comprado o no), ya se gestionó y no debe re-aparecer como sugerencia.
  const inCart = new Set(
    state.cart.map((i) => i.name.toLowerCase())
  );

  // Sumar todos los lotes del mismo alimento antes de comparar con el umbral
  const totals = new Map<string, InventoryItem & { totalQty: number }>();
  for (const item of state.inventory) {
    const key = item.name.toLowerCase();
    const existing = totals.get(key);
    if (existing) {
      existing.totalQty += item.qty;
    } else {
      totals.set(key, { ...item, totalQty: item.qty });
    }
  }

  const dismissed = new Set((state.dismissedSuggestions ?? []).map((n) => n.toLowerCase()));

  return [...totals.values()]
    .filter((item) => {
      const threshold = (thresholds as Record<string, number>)[item.unit] ?? 100;
      return item.totalQty <= threshold && !inCart.has(item.name.toLowerCase()) && !dismissed.has(item.name.toLowerCase());
    })
    .slice(0, 14)
    .map((item) => ({
      id: uid(),
      name: item.name,
      qty: item.unit === "ud" ? 3 : item.unit === "L" ? 1 : item.unit === "kg" ? 1 : 500,
      unit: item.unit,
      price: item.price,
      store: "Mercadona",
      checked: false,
      source: "lowstock" as const,
    }));
}

/** Ingredientes del plan semanal que no están cubiertos por el inventario actual. */
export function getPlanShoppingList(state: FoodOSState): import("@foodos/types").CartItem[] {
  if (!state.profile) return [];
  const plan = generateWeeklyPlan(state);
  if (!plan.length) return [];

  const inCart = new Set(
    state.cart.filter((i) => !i.checked).map((i) => i.name.toLowerCase())
  );
  const needed = new Map<string, { qty: number; unit: string; price: number; titles: Set<string> }>();

  for (const day of plan) {
    for (const recipe of [day.breakfast, day.lunch, day.dinner]) {
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        const key = ing.name.toLowerCase();
        if (inCart.has(key)) continue;

        const inStock = state.inventory
          .filter((inv) => namesMatch(inv.name, key))
          .reduce((sum, inv) => sum + inv.qty, 0);

        const shortfall = Math.max(0, ing.quantity - inStock);
        if (shortfall <= 0) continue;

        const existing = needed.get(key);
        if (existing) {
          existing.qty += shortfall;
          existing.titles.add(recipe.title);
        } else {
          needed.set(key, {
            qty: shortfall,
            unit: ing.unit,
            price: Math.max(0.5, recipe.cost / Math.max(1, recipe.ingredients.length)),
            titles: new Set([recipe.title]),
          });
        }
      }
    }
  }

  return Array.from(needed.entries())
    .slice(0, 20)
    .map(([name, data]) => ({
      id: uid(),
      name,
      qty: Math.round(data.qty),
      unit: data.unit,
      price: Math.round(data.price * 100) / 100,
      store: "Mercadona",
      checked: false,
      source: "plan" as const,
      reason: formatCartReason(data.titles),
    }));
}

/** "Para: Receta A" · "Para: Receta A, Receta B" · "Para: Receta A +2 más". */
function formatCartReason(titles: Set<string>): string {
  const list = [...titles];
  if (list.length === 0) return "";
  if (list.length <= 2) return `Para: ${list.join(", ")}`;
  return `Para: ${list.slice(0, 2).join(", ")} +${list.length - 2} más`;
}

/** Genera lista de la compra desde el mealPlan real del usuario para los días indicados. */
export function getMealPlanShoppingList(
  state: FoodOSState,
  dateKeys: string[]
): import("@foodos/types").CartItem[] {
  const inCart = new Set(
    state.cart.filter((i) => !i.checked).map((i) => i.name.toLowerCase())
  );
  const needed = new Map<string, { qty: number; unit: string; price: number; titles: Set<string> }>();

  for (const dateKey of dateKeys) {
    const day = state.mealPlan?.[dateKey];
    if (!day) continue;
    for (const slotId of Object.values(day)) {
      if (!slotId) continue;
      const recipe = allRecipes(state).find((r) => r.id === slotId);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        const key = ing.name.toLowerCase();
        if (inCart.has(key)) continue;
        const inStock = state.inventory
          .filter((inv) => namesMatch(inv.name, key))
          .reduce((sum, inv) => sum + inv.qty, 0);
        const shortfall = Math.max(0, ing.quantity - inStock);
        if (shortfall <= 0) continue;
        const existing = needed.get(key);
        if (existing) {
          existing.qty += shortfall;
          existing.titles.add(recipe.title);
        } else {
          needed.set(key, {
            qty: shortfall,
            unit: ing.unit,
            price: Math.max(0.5, recipe.cost / Math.max(1, recipe.ingredients.length)),
            titles: new Set([recipe.title]),
          });
        }
      }
    }
  }

  return Array.from(needed.entries())
    .slice(0, 30)
    .map(([name, data]) => ({
      id: uid(),
      name,
      qty: Math.round(data.qty),
      unit: data.unit,
      price: Math.round(data.price * 100) / 100,
      store: state.settings?.defaultStore ?? "Mercadona",
      checked: false,
      source: "plan" as const,
      reason: formatCartReason(data.titles),
    }));
}

/** Ranking de recetas por gramos de proteína por euro (optimizador §9.8). */
export function getProteinRanking(
  state: FoodOSState
): Array<{ id: string; title: string; protein: number; cost: number; proteinPerEuro: number }> {
  return allRecipes(state)
    .filter((r) => r.protein > 0 && r.cost > 0)
    .map((r) => ({
      id: r.id,
      title: r.title,
      protein: r.protein,
      cost: r.cost,
      proteinPerEuro: Math.round((r.protein / r.cost) * 10) / 10,
    }))
    .sort((a, b) => b.proteinPerEuro - a.proteinPerEuro)
    .slice(0, 6);
}

/** Número de días en los últimos 3 en que la proteína consumida fue < 80% del objetivo. */
export function countLowProteinDays(state: FoodOSState): number {
  const target = state.nutrition.protein;
  if (!target) return 0;
  let count = 0;
  const base = state.debugDate ?? todayPlus(0);
  for (let i = 1; i <= 3; i++) {
    const date = dateOffset(base, -i);
    const dayTotal = state.foodLog
      .filter((e) => e.date === date)
      .reduce((sum, e) => sum + e.protein, 0);
    if (dayTotal < target * 0.8) count++;
  }
  return count;
}

/** Movimientos agrupados por mes (últimos N meses) — solo registros explícitos en expenses. */
export function getMonthlyFinanceHistory(
  state: FoodOSState,
  months = 6
): Array<{ month: string; label: string; expenses: number; income: number; savings: number }> {
  const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const now = dateFromKey(getToday(state));
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const monthExpenses = state.expenses
      .filter((e) => e.type === "expense" && e.date.startsWith(monthKey))
      .reduce((s, e) => s + Number(e.amount), 0);
    const monthIncome = state.expenses
      .filter((e) => e.type === "income" && e.date.startsWith(monthKey))
      .reduce((s, e) => s + Number(e.amount), 0);
    return {
      month: monthKey,
      label: MONTH_LABELS[d.getMonth()],
      expenses: Math.round(monthExpenses),
      income: Math.round(monthIncome),
      savings: Math.round(monthIncome - monthExpenses),
    };
  });
}

/** Totales de macros por día en los últimos N días (para gráficas). */
export function getWeeklyMacroHistory(
  state: FoodOSState,
  days = 7
): Array<{ date: string; kcal: number; protein: number; carbs: number; fat: number }> {
  const base = state.debugDate ?? todayPlus(0);
  return Array.from({ length: days }, (_, i) => {
    const date = dateOffset(base, -(days - 1 - i));
    const entries = state.foodLog.filter((e) => e.date === date);
    return {
      date,
      kcal: Math.round(entries.reduce((s, e) => s + e.kcal, 0)),
      protein: Math.round(entries.reduce((s, e) => s + e.protein, 0)),
      carbs: Math.round(entries.reduce((s, e) => s + e.carbs, 0)),
      fat: Math.round(entries.reduce((s, e) => s + e.fat, 0)),
    };
  });
}

/** Por cada uno de los últimos N días, devuelve si se cumplieron los objetivos de macros.
 *  hit: proteína ≥80% target Y kcal entre 80–115% target.
 *  partial: se cumple uno de los dos.
 *  miss: ninguno (o sin datos). */
export function getMacroAdherenceHistory(
  state: FoodOSState,
  days = 28
): Array<{ date: string; status: "hit" | "partial" | "miss" | "empty" }> {
  const targetKcal = state.nutrition.kcal;
  const targetProtein = state.nutrition.protein;
  const base = state.debugDate ?? todayPlus(0);
  return Array.from({ length: days }, (_, i) => {
    const date = dateOffset(base, -(days - 1 - i));
    const entries = state.foodLog.filter((e) => e.date === date);
    if (!entries.length) return { date, status: "empty" };
    const kcal = entries.reduce((s, e) => s + e.kcal, 0);
    const protein = entries.reduce((s, e) => s + e.protein, 0);
    const protOk = targetProtein > 0 && protein >= targetProtein * 0.8;
    const kcalOk = targetKcal > 0 && kcal >= targetKcal * 0.8 && kcal <= targetKcal * 1.15;
    if (protOk && kcalOk) return { date, status: "hit" };
    if (protOk || kcalOk) return { date, status: "partial" };
    return { date, status: "miss" };
  });
}

/** Racha actual: días consecutivos terminando hoy con status "hit". */
export function getAdherenceStreak(state: FoodOSState): number {
  const history = getMacroAdherenceHistory(state, 60);
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].status === "hit") streak++;
    else break;
  }
  return streak;
}

export function expiryBadge(expires: string): { label: string; cls: string } {
  const days = daysUntil(expires);
  if (days < 0)  return { label: "Caducado",      cls: "red pulse" };
  if (days === 0) return { label: "Caduca hoy",   cls: "red" };
  if (days === 1) return { label: "Mañana",       cls: "red" };
  if (days <= 3)  return { label: `${days} días`, cls: "amber" };
  if (days <= 7)  return { label: `${days} días`, cls: "amber-soft" };
  return { label: `${days} días`, cls: "green" };
}

// ---------- Generador local de recetas IA (simula Gemini, PDF §15) ----------
// Usa el contexto real del usuario: inventario (priorizando lo que caduca),
// macros pendientes del dia y presupuesto. En produccion esto es una API
// route que llama a Gemini con el prompt del PDF §15.6.

export function buildAiRecipeDraft(state: FoodOSState): Recipe | null {
  const pending = getPendingMacros(state);
  const usable = state.inventory
    .filter((item) => item.qty > 0)
    .filter((item) => {
      const excluded = state.profile?.excludedFoods ?? [];
      const allergies = state.profile?.allergies ?? [];
      const name = item.name.toLowerCase();
      return ![...excluded, ...allergies].some((bad) => bad && name.includes(bad.toLowerCase()));
    })
    .sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires) || b.protein - a.protein);

  if (!usable.length) return null;

  // Fuente proteica = mayor proteina/100g; acompañantes = lo que antes caduque.
  const proteinSource = [...usable].sort((a, b) => b.protein - a.protein)[0];
  const sides = usable.filter((item) => item.id !== proteinSource.id).slice(0, 2);

  const targetProtein = pending.protein > 0 ? Math.min(pending.protein, 60) : 35;
  const targetKcal = pending.kcal > 0 ? Math.min(pending.kcal, 950) : 550;

  // Gramos de la fuente proteica para cubrir la proteina objetivo (max 300 g).
  const proteinGrams =
    proteinSource.protein > 0
      ? Math.min(300, Math.round((targetProtein / proteinSource.protein) * 100))
      : 150;

  const ingredients = [
    { name: proteinSource.name.toLowerCase(), quantity: proteinGrams, unit: "g" },
    ...sides.map((item) => ({
      name: item.name.toLowerCase(),
      quantity: item.unit === "ud" ? 1 : Math.min(150, item.qty),
      unit: item.unit === "ud" ? "ud" : "g",
    })),
  ];

  // Macros estimados desde los datos reales del inventario.
  const macrosOf = (item: typeof proteinSource, grams: number) => ({
    kcal: (item.kcal * grams) / 100,
    protein: (item.protein * grams) / 100,
  });
  let kcal = macrosOf(proteinSource, proteinGrams).kcal;
  let protein = macrosOf(proteinSource, proteinGrams).protein;
  sides.forEach((item) => {
    const grams = item.unit === "ud" ? (item.unitSize ?? 60) : Math.min(150, item.qty);
    kcal += (item.kcal * grams) / 100;
    protein += (item.protein * grams) / 100;
  });
  kcal = Math.round(Math.min(kcal, targetKcal * 1.2));
  protein = Math.round(protein);
  const fat = Math.round((kcal * 0.25) / 9);
  const carbs = Math.round(Math.max(0, kcal - protein * 4 - fat * 9) / 4);

  const cost = Math.round(
    Math.min(
      getBudgetLeft(state) || 3,
      [proteinSource, ...sides].reduce((sum, item) => sum + Math.min(item.price, 2.5), 0)
    ) * 100
  ) / 100;

  return {
    id: uid(),
    title: `${proteinSource.name} con ${sides.map((s) => s.name.toLowerCase()).join(" y ") || "guarnición"}`,
    ingredients,
    kcal,
    protein,
    carbs,
    fat,
    cost: Math.max(0.8, cost),
    image: "/images/recipe-chicken-bowl.webp",
    time: 20,
    servings: 1,
    difficulty: "IA",
    tags: ["IA", "aprovechamiento", ...(pending.protein > 30 ? ["alta proteína"] : [])],
    steps: [
      `Cocina ${proteinGrams} g de ${proteinSource.name.toLowerCase()} a la plancha con especias.`,
      sides.length
        ? `Prepara ${sides.map((s) => s.name.toLowerCase()).join(" y ")} como acompañamiento.`
        : "Añade la guarnición que prefieras de tu despensa.",
      "Emplata y ajusta la ración a tus macros pendientes.",
    ],
    aiGenerated: true,
  };
}

// ---------- Acciones de dominio (operan sobre el draft de mutate) ----------

/** Núcleo compartido de returnQtyToInventory/returnIngredientsToInventory: busca
    el item por id (si se indica) o por nombre, le suma qty, o lo recrea desde
    el snapshot si ya no existe.

    `allowRecreate` distingue las dos intenciones (ver #3 del QA):
    - BORRAR una entrada del diario = "esto no pasó" → reversión total, recrea
      el lote si se había agotado/borrado (allowRecreate=true).
    - EDITAR una entrada A LA BAJA = "comí menos de lo que apunté" → solo rellena
      lotes que aún existen; NO resucita un item que borraste a mano
      (allowRecreate=false), que sería sorprendente. */
function restoreInventoryQty(
  draft: FoodOSState,
  params: { inventoryItemId?: string; name: string; qty: number; unit: string; snapshot?: InventorySnapshot; allowRecreate?: boolean }
): boolean {
  const { inventoryItemId, name, qty, unit, snapshot, allowRecreate = true } = params;
  if (qty <= 0) return false;
  const byId = inventoryItemId ? draft.inventory.find((item) => item.id === inventoryItemId) : undefined;
  const target = byId ?? draft.inventory.find((item) => namesMatch(item.name, name));
  if (target) {
    target.qty = Math.round((target.qty + qty) * 100) / 100;
    return true;
  }
  if (allowRecreate && snapshot) {
    draft.inventory.push({ id: uid(), name, qty, unit, ...snapshot });
    return true;
  }
  return false;
}

export const actions = {
  /** Descarta una sugerencia de stock bajo; desaparece hasta que se re-añade al inventario. */
  dismissSuggestion(draft: FoodOSState, name: string) {
    draft.dismissedSuggestions ??= [];
    const lower = name.toLowerCase();
    if (!draft.dismissedSuggestions.some((n) => n.toLowerCase() === lower)) {
      draft.dismissedSuggestions.push(name);
    }
  },

  /** Registra una receta cocinada; ratio = escala de la porcion (1 = racion base). */
  cookRecipe(draft: FoodOSState, recipe: Recipe, ratio = 1, opts?: { deductIngredients?: boolean; mealType?: MealType; qtyOverrides?: Record<string, number>; date?: string }) {
    const t = nowTime();
    const consumedIngredients: NonNullable<FoodLogEntry["consumedIngredients"]> = [];

    if (opts?.deductIngredients) {
      for (const ing of recipe.ingredients) {
        const needed = opts?.qtyOverrides?.[ing.name] ?? ing.quantity * ratio;
        const matches = draft.inventory
          .filter((item) => namesMatch(item.name, ing.name))
          .sort((a, b) => a.expires.localeCompare(b.expires)); // FIFO: lotes más próximos a caducar primero
        let remaining = needed;
        for (const match of matches) {
          if (remaining <= 0) break;
          const take = Math.min(match.qty, remaining);
          match.qty = Math.round((match.qty - take) * 100) / 100;
          remaining -= take;
          consumedIngredients.push({
            inventoryItemId: match.id,
            name: match.name,
            qty: take,
            unit: match.unit,
            snapshot: {
              storage: match.storage, expires: match.expires, price: match.price,
              kcal: match.kcal, protein: match.protein, carbs: match.carbs, fat: match.fat,
              salt: match.salt, fiber: match.fiber, sugars: match.sugars, unitSize: match.unitSize,
            },
          });
        }
      }
      draft.inventory = draft.inventory.filter((item) => item.qty > 0);
    }

    draft.foodLog.push({
      id: uid(),
      date: opts?.date ?? getToday(draft),
      time: t,
      name: ratio === 1 ? recipe.title : `${recipe.title} (×${Math.round(ratio * 100) / 100})`,
      qty: null,
      unit: null,
      kcal: Math.round(recipe.kcal * ratio),
      protein: Math.round(recipe.protein * ratio * 10) / 10,
      carbs: Math.round(recipe.carbs * ratio * 10) / 10,
      fat: Math.round(recipe.fat * ratio * 10) / 10,
      source: "recipe",
      mealType: opts?.mealType ?? mealTypeFromTime(t),
      ...(consumedIngredients.length > 0 && { consumedIngredients }),
    });
  },

  /** Consume una cantidad PARCIAL de un alimento: registra en el diario y
      descuenta del inventario (si queda 0, lo elimina). */
  consumeInventoryItem(draft: FoodOSState, itemId: string, qty: number, overrideMealType?: MealType) {
    const item = draft.inventory.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const consumed = Math.min(qty, item.qty);
    const macros = macrosForQuantity(item, consumed);
    const t = nowTime();
    draft.foodLog.push({
      id: uid(),
      date: getToday(draft),
      time: t,
      name: item.name,
      qty: consumed,
      unit: item.unit,
      ...macros,
      source: "inventory",
      mealType: overrideMealType ?? mealTypeFromTime(t),
      inventoryItemId: item.id,
      inventorySnapshot: {
        storage: item.storage,
        expires: item.expires,
        price: item.price,
        kcal: item.kcal,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
        salt: item.salt,
        fiber: item.fiber,
        sugars: item.sugars,
        unitSize: item.unitSize,
      },
    });
    item.qty = Math.round((item.qty - consumed) * 100) / 100;
    if (item.qty <= 0) {
      draft.inventory = draft.inventory.filter((candidate) => candidate.id !== itemId);
    }
  },

  /** Devuelve `qty` de una entrada del diario al inventario: si el item original
      sigue existiendo se le suma; si fue eliminado por completo, se recrea desde
      el snapshot guardado al consumir. Devuelve true si pudo devolver algo. */
  returnQtyToInventory(draft: FoodOSState, entry: FoodLogEntry, qty: number, allowRecreate = true): boolean {
    if (qty <= 0) return false;
    return restoreInventoryQty(draft, {
      inventoryItemId: entry.inventoryItemId,
      name: entry.name,
      qty,
      unit: entry.unit ?? "g",
      snapshot: entry.inventorySnapshot,
      allowRecreate,
    });
  },

  /** Igual que returnQtyToInventory pero para una receta cocinada o un plato
      elaborado que descontó de varios items de inventario a la vez (uno por
      ingrediente). Devuelve true si pudo devolver al menos uno. */
  returnIngredientsToInventory(draft: FoodOSState, entry: FoodLogEntry): boolean {
    if (!entry.consumedIngredients?.length) return false;
    let any = false;
    for (const ing of entry.consumedIngredients) {
      const restored = restoreInventoryQty(draft, {
        inventoryItemId: ing.inventoryItemId,
        name: ing.name,
        qty: ing.qty,
        unit: ing.unit,
        snapshot: ing.snapshot,
      });
      any = any || restored;
    }
    return any;
  },

  /** Punto único usado al borrar/limpiar una entrada del diario: devuelve al
      inventario lo que corresponda según el tipo de entrada (consumo directo
      de un item, o receta/plato que descontó de varios). Devuelve true si
      devolvió algo. */
  returnEntryToInventory(draft: FoodOSState, entry: FoodLogEntry): boolean {
    if (entry.source === "inventory" && (entry.qty ?? 0) > 0) {
      return actions.returnQtyToInventory(draft, entry, entry.qty ?? 0);
    }
    if (entry.consumedIngredients?.length) {
      return actions.returnIngredientsToInventory(draft, entry);
    }
    return false;
  },

  addWater(draft: FoodOSState, ml: number) {
    const today = getToday(draft);
    draft.waterLog[today] = Math.max(0, (draft.waterLog[today] ?? 0) + ml);
  },

  /** Registra el peso corporal de hoy (reemplaza si ya hay una entrada para hoy). */
  logWeight(draft: FoodOSState, kg: number) {
    const today = getToday(draft);
    const idx = draft.weightLog.findIndex((e) => e.date === today);
    if (idx >= 0) {
      draft.weightLog[idx].kg = kg;
    } else {
      draft.weightLog.push({ date: today, kg });
    }
  },

  /** Registra el total de pasos de hoy (reemplaza si ya había un valor para hoy). */
  logSteps(draft: FoodOSState, steps: number) {
    const today = getToday(draft);
    draft.stepsLog ??= {};
    draft.stepsLog[today] = Math.max(0, Math.round(steps));
  },

  addRecipeToCart(draft: FoodOSState, recipe: Recipe) {
    recipe.ingredients.forEach((ingredient) => {
      const existing = draft.cart.find(
        (item) => item.name.toLowerCase() === ingredient.name.toLowerCase() && !item.checked
      );
      if (existing) {
        existing.qty += ingredient.quantity;
      } else {
        draft.cart.push({
          id: uid(),
          name: ingredient.name,
          qty: ingredient.quantity,
          unit: ingredient.unit,
          price: Math.max(0.6, recipe.cost / recipe.ingredients.length),
          store: "Mercadona",
          checked: false,
          source: "recipe",
          reason: `Para: ${recipe.title}`,
        });
      }
    });
  },

  /** E10-03/05/07: propuesta inicial para revisar antes de confirmar una
      compra — mismo cálculo que antes hacía completeCart() en silencio
      (precio del carrito tal cual, caducidad adivinada de food-db), pero
      ahora como PROPUESTA editable en vez de aplicarse directo. El precio
      del carrito puede llevar ahí desde que se añadió el item (a veces
      días) y no es necesariamente lo que se pagó de verdad. */
  proposePurchaseReview(state: FoodOSState): PurchaseReviewItem[] {
    const today = getToday(state);
    return state.cart
      .filter((item) => item.checked)
      .map((item) => {
        const foodData = findExactFood(item.name);
        const existing = state.inventory.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
        return {
          cartItemId: item.id,
          name: item.name,
          qty: item.qty,
          unit: item.unit || existing?.unit || foodData?.unit || "g",
          unitSize: item.unitSize ?? existing?.unitSize,
          storage: existing?.storage ?? foodData?.storage ?? "Despensa",
          store: item.store,
          estimatedPrice: item.price,
          price: item.price,
          expires: addDaysToDateKey(today, existing ? Math.max(7, foodData?.expiryDays ?? 14) : (foodData?.expiryDays ?? 14)),
        };
      });
  },

  /** Aplica una compra ya revisada (ver proposePurchaseReview): registra el
      gasto con el precio REAL confirmado por el usuario, no el estimado del
      carrito, y da de alta cada producto con la caducidad/tienda/almacén
      que se confirmaron o editaron en el repaso. */
  completePurchase(draft: FoodOSState, reviewed: PurchaseReviewItem[]): number {
    if (!reviewed.length) return 0;
    const total = reviewed.reduce((sum, item) => sum + Number(item.price), 0);
    draft.expenses.push({
      id: uid(),
      type: "expense",
      amount: total,
      category: "Comida",
      description: "Compra completada desde carrito",
      date: getToday(draft),
    });
    for (const item of reviewed) {
      const foodData = findExactFood(item.name);
      const existing = draft.inventory.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
      draft.inventory.push({
        id: uid(),
        name: item.name,
        qty: item.qty,
        unit: item.unit,
        storage: item.storage,
        expires: item.expires,
        price: item.price,
        kcal: existing?.kcal ?? foodData?.kcal ?? 100,
        protein: existing?.protein ?? foodData?.protein ?? 5,
        carbs: existing?.carbs ?? foodData?.carbs,
        fat: existing?.fat ?? foodData?.fat,
        unitSize: item.unitSize,
        salt: existing?.salt,
        fiber: existing?.fiber,
        sugars: existing?.sugars,
        brand: existing?.brand,
        imageUrl: existing?.imageUrl,
        allergenTags: existing?.allergenTags,
      });
    }
    const reviewedIds = new Set(reviewed.map((item) => item.cartItemId));
    draft.cart = draft.cart.filter((item) => !reviewedIds.has(item.id));
    return reviewed.length;
  },

  moveCheckedToInventory(draft: FoodOSState): number {
    const checked = draft.cart.filter((item) => item.checked);
    checked.forEach((item) => {
      const foodData = findExactFood(item.name);
      const existing = draft.inventory.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
      draft.inventory.push({
        id: uid(),
        name: item.name,
        qty: item.qty,
        unit: item.unit || existing?.unit || foodData?.unit || "g",
        storage: existing?.storage ?? foodData?.storage ?? "Despensa",
        expires: addDaysToDateKey(getToday(draft), existing ? Math.max(7, foodData?.expiryDays ?? 14) : (foodData?.expiryDays ?? 14)),
        price: item.price,
        kcal: existing?.kcal ?? foodData?.kcal ?? 100,
        protein: existing?.protein ?? foodData?.protein ?? 5,
        carbs: existing?.carbs ?? foodData?.carbs,
        fat: existing?.fat ?? foodData?.fat,
        unitSize: item.unitSize ?? existing?.unitSize,
        salt: existing?.salt,
        fiber: existing?.fiber,
        sugars: existing?.sugars,
        brand: existing?.brand,
        imageUrl: existing?.imageUrl,
        allergenTags: existing?.allergenTags,
      });
    });
    draft.cart = draft.cart.filter((item) => !item.checked);
    return checked.length;
  },
};

export function assistantMessage(state: FoodOSState, kind: "ticket" | "bank" | "week" | "optimize"): string {
  const pending = getPendingMacros(state);
  const budgetLeft = getBudgetLeft(state);
  const cheapest = [...allRecipes(state)].sort((a, b) => a.cost / a.protein - b.cost / b.protein)[0];
  const messages = {
    ticket:
      "Ticket demo leído: 18,40 € en Comida. He separado supermercado, fruta y proteína. En producción esto vendría de OCR + Gemini.",
    bank: "Banco demo sincronizado: detecté 3 cargos de supermercado esta semana y actualicé el presupuesto disponible.",
    week: `Plan semanal demo: prioriza ${cheapest.title}, pasta con atún y bowl de pollo. Objetivo: cubrir ${Math.round(pending.protein)} g de proteína pendiente sin pasar de ${eur(budgetLeft)}.`,
    optimize: `Mejor proteína/€ ahora: ${cheapest.title}. Aporta ${cheapest.protein} g por ${eur(cheapest.cost)}.`,
  };
  return messages[kind];
}

export { getMascot };
export { mealTypeFromTime };
