"use client";

import { useState } from "react";
import { DEFAULT_SETTINGS, useFoodOS } from "@/lib/state";
import { remote } from "@/lib/data-layer";
import { exportFoodDiaryCSV, exportFinancesCSV, exportWeightCSV } from "@/lib/export";

const STORES = ["Mercadona", "Lidl", "Carrefour", "Aldi", "Alcampo", "Frutería", "Carnicería", "Online"];

interface Props {
  isAdmin: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onOpenAI: () => void;
  aiConfigured: boolean;
  onShowOnboarding?: () => void;
  onStartTour?: () => void;
}

const DELETE_WORD = "BORRAR";
const DELETE_ACCOUNT_WORD = "ELIMINAR";

export function SettingsView({ isAdmin, theme, onToggleTheme, onOpenAI, aiConfigured, onShowOnboarding, onStartTour }: Props) {
  const { state, mutate, showToast, authUser, resetAll } = useFoodOS();
  const s = state.settings;

  const now = new Date();
  const [exportYear, setExportYear] = useState(now.getFullYear());
  const [exportMonth, setExportMonth] = useState(now.getMonth() + 1);
  const [showDeleteZone, setShowDeleteZone] = useState(false);
  const [deleteWord, setDeleteWord] = useState("");
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deleteAccountWord, setDeleteAccountWord] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);

  function set<K extends keyof typeof s>(key: K, value: (typeof s)[K]) {
    mutate((draft) => { draft.settings[key] = value; });
  }

  function setThreshold(unit: string, value: number) {
    mutate((draft) => {
      (draft.settings.lowStockThresholds as Record<string, number>)[unit] = value;
    });
  }

  function handleDeleteAll() {
    if (deleteWord !== DELETE_WORD) return;
    resetAll();
    setShowDeleteZone(false);
    setDeleteWord("");
    showToast("Todos los datos han sido eliminados.");
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
                await remote.signOut();
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
            <input name="cat" placeholder="Nueva categoría…" />
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
      <article className="panel settings-section settings-danger-zone">
        <h2>Zona de peligro</h2>
        <p className="form-intro">
          Elimina permanentemente todos tus datos de FoodOS: inventario, recetas, registro de comidas,
          finanzas, planificador y ajustes. Esta acción no se puede deshacer.
        </p>
        {!showDeleteZone ? (
          <button className="danger-button" onClick={() => setShowDeleteZone(true)}>
            Borrar todos los datos
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
            <button className="secondary-button" onClick={() => {
              mutate((draft) => { draft.settings = { ...DEFAULT_SETTINGS }; });
              showToast("Ajustes restaurados a valores por defecto");
            }}>
              Restaurar ajustes
            </button>
          </div>
          <div className="settings-grid" style={{ marginTop: 16 }}>
            <label className="settings-field">
              <span>Fecha simulada</span>
              <input
                type="date"
                value={state.debugDate ?? ""}
                onChange={(e) => {
                  const val = e.target.value || null;
                  mutate((draft) => { draft.debugDate = val; });
                }}
              />
              {state.debugDate && (
                <small style={{ color: "var(--amber)" }}>
                  ⚠ Fecha simulada activa: {state.debugDate}
                </small>
              )}
            </label>
          </div>
        </article>
      )}
    </section>
  );
}
