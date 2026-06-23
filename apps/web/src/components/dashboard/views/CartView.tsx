"use client";

import { type FormEvent, useState } from "react";
import type { CartItem } from "@foodos/types";
import {
  actions,
  getBudgetLeft,
  getLowStockSuggestions,
  getPlanShoppingList,
  useFoodOS,
} from "@/lib/state";
import { eur, uid } from "@/lib/utils";

type SuggestTab = "lowstock" | "plan";

const SOURCE_LABELS: Record<string, { label: string; cls: string }> = {
  lowstock: { label: "Stock bajo", cls: "amber" },
  plan:     { label: "Del plan",   cls: "blue"  },
};

export function CartView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();

  const [suggestOpen, setSuggestOpen] = useState(true);
  const [activeTab, setActiveTab]     = useState<SuggestTab>("lowstock");

  const checkedCount = state.cart.filter((i) => i.checked).length;
  const estimated    = state.cart.reduce((sum, i) => sum + Number(i.price || 0), 0);
  const budgetLeft   = getBudgetLeft(state);

  const lowStock = getLowStockSuggestions(state);
  const planList = getPlanShoppingList(state);
  const suggestions = activeTab === "lowstock" ? lowStock : planList;

  function addSuggestion(item: CartItem) {
    mutate((draft) => {
      const existing = draft.cart.find(
        (c) => c.name.toLowerCase() === item.name.toLowerCase() && !c.checked
      );
      if (existing) {
        existing.qty += item.qty;
      } else {
        draft.cart.push({ ...item, id: uid() });
      }
    });
    showToast(`${item.name} añadido al carrito`);
  }

  function addAllSuggestions() {
    let added = 0;
    mutate((draft) => {
      for (const item of suggestions) {
        const existing = draft.cart.find(
          (c) => c.name.toLowerCase() === item.name.toLowerCase() && !c.checked
        );
        if (existing) {
          existing.qty += item.qty;
        } else {
          draft.cart.push({ ...item, id: uid() });
          added++;
        }
      }
    });
    showToast(`${added} productos añadidos al carrito`);
  }

  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    mutate((draft) => {
      draft.cart.push({
        id: uid(),
        name: String(data.get("name")).trim(),
        qty: Number(data.get("qty")),
        unit: String(data.get("unit")),
        price: Number(data.get("price")),
        store: String(data.get("store")),
        checked: false,
        source: "manual",
      });
    });
    showToast("Item añadido al carrito");
    form.reset();
  }

  return (
    <section className="view">
      {/* Panel de sugerencias inteligentes */}
      <article className="panel smart-suggest-panel">
        <button
          className="smart-suggest-toggle"
          onClick={() => setSuggestOpen((v) => !v)}
        >
          <span>✦ Sugerencias inteligentes</span>
          <span className="suggest-counts">
            <span className="badge amber">{lowStock.length} stock bajo</span>
            <span className="badge blue">{planList.length} del plan</span>
          </span>
          <span className="suggest-chevron">{suggestOpen ? "▲" : "▼"}</span>
        </button>

        {suggestOpen && (
          <>
            <div className="suggest-tabs">
              <button
                className={`suggest-tab ${activeTab === "lowstock" ? "active" : ""}`}
                onClick={() => setActiveTab("lowstock")}
              >
                📦 Stock bajo
                {lowStock.length > 0 && <b className="tab-count">{lowStock.length}</b>}
              </button>
              <button
                className={`suggest-tab ${activeTab === "plan" ? "active" : ""}`}
                onClick={() => setActiveTab("plan")}
              >
                📅 Del plan semanal
                {planList.length > 0 && <b className="tab-count">{planList.length}</b>}
              </button>
            </div>

            {suggestions.length === 0 ? (
              <p className="suggest-empty">
                {activeTab === "lowstock"
                  ? "Todo el inventario tiene stock suficiente ✓"
                  : state.profile
                    ? "Todos los ingredientes del plan están en tu despensa ✓"
                    : "Configura tu perfil físico para generar el plan semanal."}
              </p>
            ) : (
              <>
                <div className="suggest-list">
                  {suggestions.map((item) => (
                    <div key={item.name} className="suggest-row">
                      <span className="suggest-name">{item.name}</span>
                      <span className="suggest-qty">
                        {item.qty} {item.unit}
                      </span>
                      <span className="suggest-price">{eur(item.price)}</span>
                      <button
                        className="small-action good"
                        onClick={() => addSuggestion(item)}
                      >
                        + Añadir
                      </button>
                    </div>
                  ))}
                </div>
                <div className="suggest-footer">
                  <span className="suggest-total-hint">
                    {suggestions.length} productos · ~{eur(suggestions.reduce((s, i) => s + i.price, 0))} estimado
                  </span>
                  <button className="secondary-button" onClick={addAllSuggestions}>
                    Añadir todo al carrito →
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </article>

      <div className="work-grid">
        {/* Formulario de adición manual */}
        <form className="panel form-panel" onSubmit={addItem}>
          <h2>Añadir manualmente</h2>
          <div className="form-grid compact">
            <label>
              Producto <input name="name" required placeholder="Arroz integral" />
            </label>
            <label>
              Cantidad
              <select name="qty" required defaultValue={1}>
                {[1, 2, 3, 4, 6, 8, 12].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>
              Unidad <input name="unit" defaultValue="ud" />
            </label>
            <label>
              Precio estimado{" "}
              <input name="price" type="number" min="0" step="0.01" defaultValue="1.5" />
            </label>
            <label>
              Tienda
              <select name="store" defaultValue="Mercadona">
                <option>Mercadona</option>
                <option>Lidl</option>
                <option>Frutería</option>
                <option>Carnicería</option>
              </select>
            </label>
          </div>
          <button className="primary-button" type="submit">
            Añadir item
          </button>
        </form>

        {/* Lista del carrito */}
        <article className="panel">
          <div className="panel-head">
            <h2>Carrito</h2>
            <div className="panel-actions">
              <button
                className="secondary-button"
                onClick={() => {
                  let moved = 0;
                  mutate((draft) => { moved = actions.moveCheckedToInventory(draft); });
                  showToast(`${moved} productos movidos a despensa`);
                }}
              >
                Mover a despensa
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  mutate((draft) => { draft.cart = draft.cart.filter((i) => !i.checked); });
                  showToast("Marcados eliminados");
                }}
              >
                Limpiar marcados
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  let completed = 0;
                  mutate((draft) => { completed = actions.completeCart(draft); });
                  if (!completed) {
                    showToast("Marca items como comprados primero");
                  } else {
                    setMascotMessage("Compra completada. Finanzas e inventario sincronizados.");
                    showToast("Compra completada");
                  }
                }}
              >
                Completar compra
              </button>
            </div>
          </div>

          {/* Resumen */}
          <div className="cart-summary">
            <div>
              <span>Total</span>
              <strong>{state.cart.length}</strong>
            </div>
            <div>
              <span>Marcados</span>
              <strong>{checkedCount}</strong>
            </div>
            <div>
              <span>Estimado</span>
              <strong>{eur(estimated)}</strong>
            </div>
            <div>
              <span>Presupuesto</span>
              <strong className={estimated > budgetLeft ? "over-budget" : ""}>
                {eur(budgetLeft)} disp.
              </strong>
            </div>
          </div>

          {estimated > budgetLeft && budgetLeft > 0 && (
            <p className="cart-budget-warn">
              ⚠ La compra estimada ({eur(estimated)}) supera el presupuesto disponible ({eur(budgetLeft)}).
            </p>
          )}

          <div className="card-list">
            {state.cart.length ? (
              state.cart.map((item) => (
                <article key={item.id} className="card">
                  <div>
                    <h3>{item.name}</h3>
                    <small>
                      {item.qty} {item.unit} · {item.store} · {eur(item.price)}
                    </small>
                    <div className="meta-row">
                      <span className={`badge ${item.checked ? "green" : "amber"}`}>
                        {item.checked ? "Comprado" : "Pendiente"}
                      </span>
                      {item.source && item.source !== "manual" && (
                        <span className={`badge ${SOURCE_LABELS[item.source]?.cls ?? ""}`}>
                          {SOURCE_LABELS[item.source]?.label}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="card-actions">
                    <button
                      className="small-action good"
                      onClick={() =>
                        mutate((draft) => {
                          const entry = draft.cart.find((c) => c.id === item.id);
                          if (entry) entry.checked = !entry.checked;
                        })
                      }
                    >
                      {item.checked ? "Desmarcar" : "Marcar"}
                    </button>
                    <button
                      className="small-action bad"
                      onClick={() =>
                        mutate((draft) => {
                          draft.cart = draft.cart.filter((c) => c.id !== item.id);
                        })
                      }
                    >
                      Borrar
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <div className="empty">
                El carrito está vacío. Usa las sugerencias de arriba o añade manualmente.
              </div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
