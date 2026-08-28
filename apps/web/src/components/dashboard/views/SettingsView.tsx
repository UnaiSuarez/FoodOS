"use client";

import { useState } from "react";
import { actions, DEFAULT_SETTINGS, getToday, useFoodOS } from "@/lib/state";
import { remote } from "@/lib/data-layer";
import { notificationsSupported } from "@/lib/notifications";
import { exportFoodDiaryCSV, exportFinancesCSV, exportWeightCSV } from "@/lib/export";
import { addDaysToDateKey, uid } from "@/lib/utils";
import { Modal } from "../Modal";
import { StyleGuideModal } from "../StyleGuideModal";

const STORES = ["Mercadona", "Lidl", "Carrefour", "Aldi", "Alcampo", "Frutería", "Carnicería", "Online"];

interface Props {
  isAdmin: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onOpenAI: () => void;
  aiConfigured: boolean;
  onShowOnboarding?: () => void;
  onStartTour?: () => void;
  // E04-06: exportar/importar/restaurar backup viven en DashboardShell.tsx
  // (necesitan leer/escribir el estado completo antes de que useFoodOS()
  // hidrate esta vista) — se pasan como props en vez de duplicar la lógica.
  onExportData?: () => void;
  onImportData?: (file: File | undefined) => void;
  onRestoreImportBackup?: () => void;
}

const DELETE_WORD = "BORRAR";
const DELETE_ACCOUNT_WORD = "ELIMINAR";

export function SettingsView({
  isAdmin,
  theme,
  onToggleTheme,
  onOpenAI,
  aiConfigured,
  onShowOnboarding,
  onStartTour,
  onExportData,
  onImportData,
  onRestoreImportBackup,
}: Props) {
  const { state, mutate, showToast, authUser, resetAll, seedDemo, requestSignOut, setWaterAbsolute } = useFoodOS();
  const s = state.settings;

  const now = new Date();
  const [exportYear, setExportYear] = useState(now.getFullYear());
  const [exportMonth, setExportMonth] = useState(now.getMonth() + 1);
  const [showDeleteZone, setShowDeleteZone] = useState(false);
  const [deleteWord, setDeleteWord] = useState("");
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deleteAccountWord, setDeleteAccountWord] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [showStateJson, setShowStateJson] = useState(false);
  const [showStyleGuide, setShowStyleGuide] = useState(false);

  function set<K extends keyof typeof s>(key: K, value: (typeof s)[K]) {
    mutate((draft) => { draft.settings[key] = value; });
  }

  function setThreshold(unit: string, value: number) {
    mutate((draft) => {
      (draft.settings.lowStockThresholds as Record<string, number>)[unit] = value;
    });
  }

  /** Activar pide el permiso del navegador primero: el toggle solo queda en
      "on" si el usuario lo concede, para que el estado refleje la realidad. */
  async function toggleExpiryNotifications(enabled: boolean) {
    if (!enabled) {
      set("expiryNotifications", false);
      return;
    }
    if (!notificationsSupported()) {
      showToast("Este navegador no soporta notificaciones");
      return;
    }
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("Permiso de notificaciones no concedido");
      return;
    }
    set("expiryNotifications", true);
    showToast("Notificaciones de caducidad activadas");
  }

  function handleDeleteAll() {
    if (deleteWord !== DELETE_WORD) return;
    resetAll();
    setShowDeleteZone(false);
    setDeleteWord("");
    showToast(authUser ? "Datos de este dispositivo eliminados." : "Todos los datos han sido eliminados.");
  }

  function shiftDebugDate(deltaDays: number) {
    mutate((draft) => { draft.debugDate = addDaysToDateKey(getToday(state), deltaDays); });
  }

  function clearDebugDate() {
    mutate((draft) => { draft.debugDate = null; });
  }

  // E06-14/15: sin confirmación ni deshacer, un click aquí borra comidas,
  // agua y entrenamiento del día sin aviso — aunque sea una herramienta de
  // admin, sigue siendo destructivo por accidente mientras se prueba otra
  // cosa. Mismo patrón que el borrado de una entrada individual del diario.
  const [confirmingClearToday, setConfirmingClearToday] = useState(false);

  /** Borra comidas, agua y entrenamiento del día actual (o simulado); devuelve al inventario
      lo que se consumió de ahí, igual que al borrar una entrada individual.
      Corrección de revisión (P0): el agua se fija con setWaterAbsolute(),
      NUNCA escribiendo waterLog dentro de mutate() — pushState() excluye
      water_log a propósito (RPC atómica independiente), así que un cambio
      hecho solo dentro del draft de mutate() nunca llegaría a Supabase
      aunque la outbox genérica se confirmara y el badge dijera "Guardado". */
  function clearToday() {
    const today = getToday(state);
    const prevFoodLog = state.foodLog;
    const prevInventory = state.inventory;
    const prevWater = state.waterLog[today] ?? 0;
    const prevWorkoutLog = state.workoutLog;
    mutate((draft) => {
      for (const entry of draft.foodLog) {
        if (entry.date === today) actions.returnEntryToInventory(draft, entry);
      }
      draft.foodLog = draft.foodLog.filter((entry) => entry.date !== today);
      draft.workoutLog = (draft.workoutLog ?? []).filter((session) => session.date !== today);
    });
    setWaterAbsolute(today, 0);
    showToast(`Registro de ${today} borrado`, {
      label: "Deshacer",
      onAction: () => {
        mutate((draft) => {
          draft.foodLog = structuredClone(prevFoodLog);
          draft.inventory = structuredClone(prevInventory);
          draft.workoutLog = structuredClone(prevWorkoutLog);
        });
        setWaterAbsolute(today, prevWater);
      },
    });
  }

  /** Rellena los últimos 7 días con comidas, agua, peso y entrenamiento de ejemplo para probar Estadísticas.
      El agua se fija por fecha con setWaterAbsolute() (mismo motivo que
      clearToday(): pushState() excluye water_log a propósito). */
  function seedHistorico() {
    const meals = [
      { name: "Avena con proteína", kcal: 380, protein: 28, carbs: 52, fat: 8, mealType: "breakfast" as const },
      { name: "Pechuga de pollo con arroz", kcal: 520, protein: 42, carbs: 65, fat: 9, mealType: "lunch" as const },
      { name: "Salmón con verduras", kcal: 440, protein: 38, carbs: 18, fat: 22, mealType: "dinner" as const },
    ];
    const todayBase = getToday(state);
    const waterByDate: Record<string, number> = {};
    mutate((draft) => {
      for (let i = 1; i <= 7; i++) {
        const date = addDaysToDateKey(todayBase, -i);

        meals.forEach((meal, idx) => {
          if (draft.foodLog.some((entry) => entry.date === date && entry.name === meal.name)) return;
          draft.foodLog.push({
            id: uid(),
            date,
            time: ["08:30", "13:30", "20:30"][idx],
            qty: null,
            unit: null,
            source: "manual",
            ...meal,
          });
        });

        waterByDate[date] = 1600 + ((i * 137) % 1400);

        if (!draft.weightLog.some((w) => w.date === date)) {
          const base = state.profile?.weightKg ?? 75;
          draft.weightLog.push({ date, kg: Math.round((base + (i % 3 === 0 ? -0.2 : 0.1) * i) * 10) / 10 });
        }

        if (i % 2 === 0) {
          draft.workoutLog = draft.workoutLog ?? [];
          draft.workoutLog.push({
            id: uid(),
            date,
            routineName: "Sesión de ejemplo",
            kcalBurned: 280 + (i * 17),
            durationMin: 45,
          });
        }
      }
      draft.weightLog.sort((a, b) => a.date.localeCompare(b.date));
    });
    Object.entries(waterByDate).forEach(([date, ml]) => setWaterAbsolute(date, ml));
    showToast("7 días de historial de ejemplo añadidos");
  }

  async function handleDeleteAccount() {
    if (deleteAccountWord !== DELETE_ACCOUNT_WORD) return;
    setDeletingAccount(true);
    const { error } = await remote.deleteAccount();
    setDeletingAccount(false);
    if (error) {
      showToast(`Error al eliminar la cuenta: ${error}`);
      return;
    }
    resetAll();
    showToast("Cuenta eliminada permanentemente.");
  }

  return (
    <section className="view">

      {/* Cuenta */}
      <article className="panel settings-section">
        <h2>Cuenta</h2>
        {authUser ? (
          <>
            <p className="form-intro">Conectado como <strong>{authUser.email}</strong>. Tus datos se sincronizan automáticamente.</p>
            <button
              className="secondary-button"
              onClick={async () => {
                const result = await requestSignOut();
                // Corrección de revisión (P1, sexta ronda): "cancelled" y
                // "failed" no deben mostrar el toast de éxito —
                // requestSignOut() ya avisa de un fallo real por su cuenta.
                if (result !== "signed_out") return;
                showToast("Sesión cerrada.");
              }}
            >
              Cerrar sesión
            </button>

            <div className="settings-cuenta-danger">
              <p className="settings-cuenta-danger-label">Zona de eliminación permanente</p>
              {!showDeleteAccount ? (
                <button className="danger-button danger-button--small" onClick={() => setShowDeleteAccount(true)}>
                  Eliminar cuenta permanentemente
                </button>
              ) : (
                <div className="delete-confirm-zone">
                  <p className="delete-confirm-label">
                    Esto borrará tu cuenta y todos tus datos de forma irreversible.<br />
                    Escribe <strong>{DELETE_ACCOUNT_WORD}</strong> para confirmar:
                  </p>
                  <input
                    type="text"
                    className="delete-confirm-input"
                    value={deleteAccountWord}
                    onChange={(e) => setDeleteAccountWord(e.target.value.toUpperCase())}
                    placeholder={DELETE_ACCOUNT_WORD}
                    aria-label={`Escribe ${DELETE_ACCOUNT_WORD} para confirmar`}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <div className="delete-confirm-actions">
                    <button
                      className="secondary-button"
                      onClick={() => { setShowDeleteAccount(false); setDeleteAccountWord(""); }}
                    >
                      Cancelar
                    </button>
                    <button
                      className="danger-button"
                      disabled={deleteAccountWord !== DELETE_ACCOUNT_WORD || deletingAccount}
                      onClick={handleDeleteAccount}
                    >
                      {deletingAccount ? "Eliminando…" : "Confirmar eliminación"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="form-intro">No hay sesión activa. Los datos se guardan solo en este navegador.</p>
        )}
      </article>

      {/* Apariencia */}
      <article className="panel settings-section">
        <h2>Apariencia</h2>
        <div className="settings-grid">
          <div className="settings-field">
            <span>Tema</span>
            <div className="settings-toggle-row">
              <button
                className={`settings-theme-btn ${theme === "dark" ? "active" : ""}`}
                onClick={() => theme !== "dark" && onToggleTheme()}
              >
                ☽ Oscuro
              </button>
              <button
                className={`settings-theme-btn ${theme === "light" ? "active" : ""}`}
                onClick={() => theme !== "light" && onToggleTheme()}
              >
                ☀ Claro
              </button>
            </div>
          </div>
        </div>
      </article>

      {/* IA personal */}
      <article className="panel settings-section">
        <h2>Asistente IA</h2>
        <p className="form-intro">
          Conecta tu propia clave de API para recetas personalizadas con tus macros, inventario y presupuesto.
        </p>
        <button className={`secondary-button ${aiConfigured ? "good" : ""}`} onClick={onOpenAI}>
          {aiConfigured ? "✓ IA configurada — cambiar clave" : "Conectar IA personal"}
        </button>
      </article>

      {/* Avisos y caducidades */}
      <article className="panel settings-section">
        <h2>Avisos y caducidades</h2>
        <p className="form-intro">Controla cuándo y con qué agresividad FoodOS te avisa.</p>
        <div className="settings-grid">
          <label className="settings-field">
            <span>Días de antelación para avisar de caducidad</span>
            <div className="settings-range-row">
              <input type="range" min={1} max={7} step={1}
                value={s.expiryWarnDays}
                onChange={(e) => set("expiryWarnDays", Number(e.target.value))}
              />
              <b>{s.expiryWarnDays} {s.expiryWarnDays === 1 ? "día" : "días"}</b>
            </div>
            <small>Los items que caduquen en los próximos {s.expiryWarnDays} días aparecerán en el Panel.</small>
          </label>
          <label className="settings-field">
            <span>% de presupuesto para activar aviso</span>
            <div className="settings-range-row">
              <input type="range" min={50} max={95} step={5}
                value={s.budgetWarnPct}
                onChange={(e) => set("budgetWarnPct", Number(e.target.value))}
              />
              <b>{s.budgetWarnPct}%</b>
            </div>
            <small>La barra cambia a ámbar cuando superas el {s.budgetWarnPct}% del presupuesto.</small>
          </label>
          <label className="settings-field">
            <span>Hora de inicio de sugerencia de cena</span>
            <div className="settings-range-row">
              <input type="range" min={15} max={21} step={1}
                value={s.dinnerSuggestionHour}
                onChange={(e) => set("dinnerSuggestionHour", Number(e.target.value))}
              />
              <b>{s.dinnerSuggestionHour}:30 h</b>
            </div>
          </label>
          <label className="settings-field">
            <span>Notificaciones del sistema de caducidad</span>
            <div className="settings-range-row">
              <input
                type="checkbox"
                checked={!!s.expiryNotifications}
                onChange={(e) => void toggleExpiryNotifications(e.target.checked)}
              />
              <b>{s.expiryNotifications ? "Activadas" : "Desactivadas"}</b>
            </div>
            <small>
              Un aviso del sistema (máx. 1 al día) al abrir la app si algo caduca hoy o mañana —
              aunque no estés mirando el Panel.
              {notificationsSupported() && Notification.permission === "denied" &&
                " Tienes las notificaciones bloqueadas en el navegador: desbloquéalas en los ajustes del sitio."}
            </small>
          </label>
        </div>
      </article>

      {/* Nutrición e hidratación */}
      <article className="panel settings-section">
        <h2>Nutrición e hidratación</h2>
        <div className="settings-grid">
          <label className="settings-field">
            <span>Meta diaria de agua (ml)</span>
            <div className="settings-range-row">
              <input type="range" min={1000} max={5000} step={250}
                value={s.waterGoalMl}
                onChange={(e) => set("waterGoalMl", Number(e.target.value))}
              />
              <b>{(s.waterGoalMl / 1000).toFixed(2).replace(".", ",")} L</b>
            </div>
          </label>
        </div>
      </article>

      {/* Umbrales de stock bajo */}
      <article className="panel settings-section">
        <h2>Umbrales de stock bajo</h2>
        <p className="form-intro">Cuando un alimento cae por debajo de este nivel, aparece en las sugerencias del carrito.</p>
        <div className="settings-grid">
          {([
            { unit: "g",  label: "Gramos (g)",      min: 50,   max: 1000, step: 50 },
            { unit: "ml", label: "Mililitros (ml)",  min: 50,   max: 1000, step: 50 },
            { unit: "L",  label: "Litros (L)",       min: 0.25, max: 3,    step: 0.25 },
            { unit: "kg", label: "Kilogramos (kg)",  min: 0.1,  max: 2,    step: 0.1 },
            { unit: "ud", label: "Unidades (ud)",    min: 1,    max: 10,   step: 1 },
          ] as const).map(({ unit, label, min, max, step }) => (
            <label key={unit} className="settings-field">
              <span>{label}</span>
              <div className="settings-range-row">
                <input type="range" min={min} max={max} step={step}
                  value={(s.lowStockThresholds as Record<string, number>)[unit] ?? min}
                  onChange={(e) => setThreshold(unit, Number(e.target.value))}
                />
                <b>{(s.lowStockThresholds as Record<string, number>)[unit]} {unit}</b>
              </div>
            </label>
          ))}
        </div>
      </article>

      {/* Compras */}
      <article className="panel settings-section">
        <h2>Compras</h2>
        <div className="settings-grid">
          <label className="settings-field">
            <span>Tienda por defecto en el carrito</span>
            <select value={s.defaultStore} onChange={(e) => set("defaultStore", e.target.value)}>
              {STORES.map((store) => <option key={store} value={store}>{store}</option>)}
            </select>
          </label>
        </div>
      </article>

      {/* Categorías de gasto */}
      <article className="panel settings-section">
        <h2>Categorías de gasto adicionales</h2>
        <div className="extra-cats">
          {s.extraExpenseCategories.map((cat, i) => (
            <span key={i} className="cat-chip">
              {cat}
              <button className="cat-chip-remove"
                onClick={() => mutate((draft) => {
                  draft.settings.extraExpenseCategories = draft.settings.extraExpenseCategories.filter((_, j) => j !== i);
                })}
                aria-label={`Eliminar ${cat}`}
              >×</button>
            </span>
          ))}
          <form className="cat-add-form" onSubmit={(e) => {
            e.preventDefault();
            const input = (e.currentTarget.elements.namedItem("cat") as HTMLInputElement);
            const val = input.value.trim();
            if (!val || s.extraExpenseCategories.includes(val)) return;
            mutate((draft) => { draft.settings.extraExpenseCategories.push(val); });
            input.value = "";
          }}>
            <input name="cat" placeholder="Nueva categoría…" aria-label="Nueva categoría de gasto" />
            <button className="secondary-button" type="submit">Añadir</button>
          </form>
        </div>
      </article>

      {/* Exportar datos */}
      <article className="panel settings-section">
        <h2>Exportar datos</h2>
        <p className="form-intro">Descarga tus datos en CSV para Excel o Google Sheets.</p>
        <div className="export-month-row">
          <label>
            Mes:
            <select value={exportMonth} onChange={(e) => setExportMonth(Number(e.target.value))}>
              {["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"]
                .map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <label>
            Año:
            <select value={exportYear} onChange={(e) => setExportYear(Number(e.target.value))}>
              {[now.getFullYear() - 1, now.getFullYear()].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        </div>
        <div className="export-grid">
          <button className="export-btn" onClick={() => { exportFoodDiaryCSV(state, exportYear, exportMonth); showToast("Diario exportado"); }}>
            <span className="export-btn-icon">🥗</span>
            <span className="export-btn-label">Diario de comidas</span>
            <span className="export-btn-desc">Entradas del mes seleccionado</span>
          </button>
          <button className="export-btn" onClick={() => { exportFinancesCSV(state, exportYear, exportMonth); showToast("Finanzas exportadas"); }}>
            <span className="export-btn-icon">💶</span>
            <span className="export-btn-label">Gastos del mes</span>
            <span className="export-btn-desc">Gastos del mes seleccionado</span>
          </button>
          <button className="export-btn" onClick={() => { exportWeightCSV(state); showToast("Peso exportado"); }}>
            <span className="export-btn-icon">⚖️</span>
            <span className="export-btn-label">Registro de peso</span>
            <span className="export-btn-desc">Historial completo</span>
          </button>
        </div>
      </article>

      {/* Instalar */}
      <article className="panel settings-section">
        <h2>Instalar FoodOS</h2>
        <p className="form-intro">FoodOS es una PWA. Instálala en tu móvil o escritorio para usarla sin conexión.</p>
        <p className="pwa-hint">
          En Chrome/Edge: menú ⋮ → <strong>Instalar aplicación</strong>.
          En Safari iOS: compartir → <strong>Añadir a pantalla de inicio</strong>.
        </p>
      </article>

      {/* Zona de peligro */}
      {/* E17-01: el texto anterior decía "elimina permanentemente todos tus
          datos... esta acción no se puede deshacer" sin distinguir local de
          nube. resetAll() SOLO borra localStorage — con sesión activa, tus
          datos siguen en Supabase y volverían a sincronizarse en el próximo
          inicio, justo lo contrario de "no se puede deshacer". El texto
          ahora refleja el alcance real según haya sesión o no. */}
      <article className="panel settings-section settings-danger-zone">
        <h2>Zona de peligro</h2>
        <p className="form-intro">
          {authUser ? (
            <>
              Borra inventario, recetas, registro de comidas, finanzas, planificador y ajustes guardados
              <strong> en este dispositivo</strong>. Como tu cuenta sincroniza con la nube, estos datos
              volverán a descargarse la próxima vez que abras FoodOS aquí o en otro dispositivo — esto
              no borra nada de tu cuenta. Para eliminar tus datos de forma permanente, usa
              «Eliminar cuenta permanentemente» en Cuenta.
            </>
          ) : (
            <>
              Elimina permanentemente todos tus datos de FoodOS: inventario, recetas, registro de comidas,
              finanzas, planificador y ajustes. Esta acción no se puede deshacer.
            </>
          )}
        </p>
        {!showDeleteZone ? (
          <button className="danger-button" onClick={() => setShowDeleteZone(true)}>
            {authUser ? "Borrar datos de este dispositivo" : "Borrar todos los datos"}
          </button>
        ) : (
          <div className="delete-confirm-zone">
            <p className="delete-confirm-label">
              Escribe <strong>{DELETE_WORD}</strong> para confirmar el borrado:
            </p>
            <input
              type="text"
              className="delete-confirm-input"
              value={deleteWord}
              onChange={(e) => setDeleteWord(e.target.value.toUpperCase())}
              placeholder={DELETE_WORD}
              aria-label={`Escribe ${DELETE_WORD} para confirmar`}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="delete-confirm-actions">
              <button
                className="secondary-button"
                onClick={() => { setShowDeleteZone(false); setDeleteWord(""); }}
              >
                Cancelar
              </button>
              <button
                className="danger-button"
                disabled={deleteWord !== DELETE_WORD}
                onClick={handleDeleteAll}
              >
                Confirmar borrado
              </button>
            </div>
          </div>
        )}
      </article>

      {/* Solo admin */}
      {isAdmin && (
        <article className="panel settings-section settings-admin">
          <p className="eyebrow">Admin</p>
          <h2>Herramientas de desarrollo</h2>
          <p className="form-intro">Visibles solo para usuarios administradores.</p>
          <div className="settings-footer">
            {onShowOnboarding && (
              <button className="secondary-button" onClick={() => {
                localStorage.removeItem("foodos-ob-done");
                onShowOnboarding();
              }}>
                ▶ Ver onboarding
              </button>
            )}
            {onStartTour && (
              <button className="secondary-button" onClick={() => {
                localStorage.removeItem("foodos-tour-done");
                onStartTour();
              }}>
                ◎ Tour por la app
              </button>
            )}
            {/* E04-06: antes vivían en la cabecera del dashboard, visibles
                (aunque solo para admin) en el uso habitual de la app. */}
            {onExportData && (
              <button className="secondary-button" onClick={onExportData}>
                Exportar datos (JSON)
              </button>
            )}
            {onImportData && (
              <label className="secondary-button file-button">
                Importar datos (JSON)
                <input
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(event) => {
                    onImportData(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
            )}
            {onRestoreImportBackup && (
              <button
                className="secondary-button"
                onClick={onRestoreImportBackup}
                title="Restaurar copia de seguridad de la última importación"
              >
                Restaurar backup de importación
              </button>
            )}
            <button className="secondary-button" onClick={seedDemo}>
              Cargar datos demo
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                if (confirm("¿Borrar todos los datos locales de FoodOS?")) resetAll();
              }}
            >
              Borrar datos locales
            </button>
            <button className="secondary-button" onClick={() => {
              mutate((draft) => { draft.settings = { ...DEFAULT_SETTINGS }; });
              showToast("Ajustes restaurados a valores por defecto");
            }}>
              Restaurar ajustes
            </button>
          </div>
          <div className="settings-grid mt-16">
            <label className="settings-field">
              <span>Fecha simulada</span>
              <div className="settings-toggle-row">
                <button className="secondary-button" onClick={() => shiftDebugDate(-1)} title="Día anterior" type="button">
                  ←
                </button>
                <input
                  type="date"
                  value={state.debugDate ?? ""}
                  onChange={(e) => {
                    const val = e.target.value || null;
                    mutate((draft) => { draft.debugDate = val; });
                  }}
                />
                <button className="secondary-button" onClick={() => shiftDebugDate(1)} title="Día siguiente" type="button">
                  →
                </button>
                {state.debugDate && (
                  <button className="secondary-button" onClick={clearDebugDate} type="button">
                    Volver a hoy real
                  </button>
                )}
              </div>
              {state.debugDate && (
                <small style={{ color: "var(--amber)" }}>
                  ⚠ Fecha simulada activa: {state.debugDate} — afecta a diario, agua y ejercicios.
                </small>
              )}
            </label>
          </div>

          <div className="settings-footer mt-16">
            <button className="secondary-button" onClick={seedHistorico}>
              📊 Sembrar 7 días de historial
            </button>
            <button className="secondary-button" onClick={() => setConfirmingClearToday(true)}>
              🧹 Limpiar registro del día actual
            </button>
            <button className="secondary-button" onClick={() => setShowStateJson((v) => !v)}>
              {showStateJson ? "Ocultar estado JSON" : "🔍 Ver estado JSON"}
            </button>
            <button className="secondary-button" onClick={() => setShowStyleGuide(true)}>
              🎨 Documentación de componentes
            </button>
          </div>
          {showStateJson && (
            <pre
              style={{
                marginTop: 12,
                maxHeight: 320,
                overflow: "auto",
                fontSize: 12,
                background: "var(--bg-soft, #111)",
                padding: 12,
                borderRadius: 8,
              }}
            >
              {JSON.stringify(state, null, 2)}
            </pre>
          )}
        </article>
      )}

      {showStyleGuide && <StyleGuideModal onClose={() => setShowStyleGuide(false)} />}

      {confirmingClearToday && (
        <Modal title="¿Limpiar el registro de hoy?" onClose={() => setConfirmingClearToday(false)}>
          <p className="cycle-note">
            Se borrarán las comidas, el agua y el entrenamiento de {getToday(state)}. Lo que se
            descontó del inventario al registrar comidas se devuelve. Podrás deshacerlo justo
            después, desde el aviso.
          </p>
          <div className="meta-row mt-12">
            <button className="secondary-button" onClick={() => setConfirmingClearToday(false)}>
              Cancelar
            </button>
            <button
              className="danger-button"
              onClick={() => { setConfirmingClearToday(false); clearToday(); }}
            >
              Limpiar registro
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
