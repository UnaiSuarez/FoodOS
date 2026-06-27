"use client";

import { DEFAULT_SETTINGS, useFoodOS } from "@/lib/state";

const STORES = ["Mercadona", "Lidl", "Carrefour", "Aldi", "Alcampo", "Frutería", "Carnicería", "Online"];

interface Props {
  onShowOnboarding?: () => void;
}

export function SettingsView({ onShowOnboarding }: Props) {
  const { state, mutate, showToast } = useFoodOS();
  const s = state.settings;

  function set<K extends keyof typeof s>(key: K, value: (typeof s)[K]) {
    mutate((draft) => { draft.settings[key] = value; });
  }

  function setThreshold(unit: string, value: number) {
    mutate((draft) => {
      (draft.settings.lowStockThresholds as Record<string, number>)[unit] = value;
    });
  }

  function resetDefaults() {
    mutate((draft) => { draft.settings = { ...DEFAULT_SETTINGS }; });
    showToast("Ajustes restaurados a valores por defecto");
  }

  return (
    <section className="view">
      {/* Avisos y caducidades */}
      <article className="panel settings-section">
        <h2>Avisos y caducidades</h2>
        <p className="form-intro">Controla cuándo y con qué agresividad FoodOS te avisa.</p>

        <div className="settings-grid">
          <label className="settings-field">
            <span>Días de antelación para avisar de caducidad</span>
            <div className="settings-range-row">
              <input
                type="range" min={1} max={7} step={1}
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
              <input
                type="range" min={50} max={95} step={5}
                value={s.budgetWarnPct}
                onChange={(e) => set("budgetWarnPct", Number(e.target.value))}
              />
              <b>{s.budgetWarnPct}%</b>
            </div>
            <small>La barra de presupuesto cambia a ámbar cuando superas el {s.budgetWarnPct}% gastado.</small>
          </label>

          <label className="settings-field">
            <span>Hora de inicio de sugerencia de cena</span>
            <div className="settings-range-row">
              <input
                type="range" min={15} max={21} step={1}
                value={s.dinnerSuggestionHour}
                onChange={(e) => set("dinnerSuggestionHour", Number(e.target.value))}
              />
              <b>{s.dinnerSuggestionHour}:30 h</b>
            </div>
            <small>La sugerencia de cena para cerrar macros se activa a partir de las {s.dinnerSuggestionHour}:30 h.</small>
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
              <input
                type="range" min={1000} max={5000} step={250}
                value={s.waterGoalMl}
                onChange={(e) => set("waterGoalMl", Number(e.target.value))}
              />
              <b>{(s.waterGoalMl / 1000).toFixed(2).replace(".", ",")} L</b>
            </div>
            <small>La barra de hidratación del Registro se ajustará a esta meta.</small>
          </label>
        </div>
      </article>

      {/* Umbrales de stock bajo */}
      <article className="panel settings-section">
        <h2>Umbrales de stock bajo</h2>
        <p className="form-intro">
          Cuando un alimento del inventario cae por debajo de estos valores, aparece en las sugerencias del carrito.
        </p>

        <div className="settings-grid">
          {([
            { unit: "g",  label: "Gramos (g)",       min: 50,  max: 1000, step: 50 },
            { unit: "ml", label: "Mililitros (ml)",   min: 50,  max: 1000, step: 50 },
            { unit: "L",  label: "Litros (L)",        min: 0.25, max: 3,  step: 0.25 },
            { unit: "kg", label: "Kilogramos (kg)",   min: 0.1, max: 2,   step: 0.1 },
            { unit: "ud", label: "Unidades (ud)",     min: 1,   max: 10,  step: 1 },
          ] as const).map(({ unit, label, min, max, step }) => (
            <label key={unit} className="settings-field">
              <span>{label}</span>
              <div className="settings-range-row">
                <input
                  type="range"
                  min={min} max={max} step={step}
                  value={(s.lowStockThresholds as Record<string, number>)[unit] ?? min}
                  onChange={(e) => setThreshold(unit, Number(e.target.value))}
                />
                <b>
                  {(s.lowStockThresholds as Record<string, number>)[unit]} {unit}
                </b>
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
            <select
              value={s.defaultStore}
              onChange={(e) => set("defaultStore", e.target.value)}
            >
              {STORES.map((store) => (
                <option key={store} value={store}>{store}</option>
              ))}
            </select>
          </label>
        </div>
      </article>

      {/* Categorías de gasto */}
      <article className="panel settings-section">
        <h2>Categorías de gasto adicionales</h2>
        <p className="form-intro">
          Además de las categorías por defecto (Comida, Ocio, Transporte…), puedes añadir las tuyas.
        </p>

        <div className="extra-cats">
          {s.extraExpenseCategories.map((cat, i) => (
            <span key={i} className="cat-chip">
              {cat}
              <button
                className="cat-chip-remove"
                onClick={() =>
                  mutate((draft) => {
                    draft.settings.extraExpenseCategories = draft.settings.extraExpenseCategories.filter((_, j) => j !== i);
                  })
                }
                aria-label={`Eliminar ${cat}`}
              >
                ×
              </button>
            </span>
          ))}
          <form
            className="cat-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem("cat") as HTMLInputElement);
              const val = input.value.trim();
              if (!val || s.extraExpenseCategories.includes(val)) return;
              mutate((draft) => { draft.settings.extraExpenseCategories.push(val); });
              input.value = "";
            }}
          >
            <input name="cat" placeholder="Nueva categoría…" />
            <button className="secondary-button" type="submit">Añadir</button>
          </form>
        </div>
      </article>

      {/* PWA info */}
      <article className="panel settings-section">
        <h2>Instalar FoodOS</h2>
        <p className="form-intro">
          FoodOS es una Progressive Web App (PWA). Puedes instalarla en tu móvil o escritorio
          para usarla sin conexión y tener un icono propio.
        </p>
        <p className="pwa-hint">
          En Chrome/Edge: menú ⋮ → <strong>Instalar aplicación</strong>.
          En Safari iOS: compartir → <strong>Añadir a pantalla de inicio</strong>.
        </p>
      </article>

      <div className="settings-footer">
        {onShowOnboarding && (
          <button
            className="secondary-button"
            onClick={() => {
              localStorage.removeItem("foodos-ob-done");
              onShowOnboarding();
            }}
          >
            ▶ Ver onboarding de nuevo
          </button>
        )}
        <button className="secondary-button" onClick={resetDefaults}>
          Restaurar valores por defecto
        </button>
      </div>
    </section>
  );
}
