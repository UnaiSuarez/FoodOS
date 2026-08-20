"use client";

import { type FormEvent, useState } from "react";
import type { CartItem } from "@foodos/types";
import {
  actions,
  getBudgetLeft,
  getToday,
  getLowStockSuggestions,
  getPlanShoppingList,
  useFoodOS,
} from "@/lib/state";
import { eur, uid } from "@/lib/utils";
import { EditCartItemModal } from "../EditCartItemModal";
import { Modal } from "../Modal";

type SuggestTab = "lowstock" | "plan";

const SOURCE_LABELS: Record<string, { label: string; cls: string }> = {
  lowstock: { label: "Stock bajo", cls: "amber" },
  plan:     { label: "Del plan",   cls: "blue"  },
  recipe:   { label: "De receta",  cls: "blue"  },
};

export function CartView() {
  const { state, mutate, showToast, setMascotMessage, triggerMascot } = useFoodOS();

  const [suggestOpen, setSuggestOpen] = useState(true);
  const [activeTab, setActiveTab]     = useState<SuggestTab>("lowstock");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editCartItem, setEditCartItem] = useState<CartItem | null>(null);
  // E10-02: antes el aviso de "supera presupuesto" era un toast con acción
  // (5s, UNDO_TOAST_MS) — fácil de perder de vista o que se cierre solo
  // antes de decidir. Superar el presupuesto es una decisión real, no algo
  // para un aviso efímero: ahora es un diálogo persistente (mismo patrón
  // que N10 en NutritionView, "Revisa tu déficit antes de continuar").
  const [pendingOverBudget, setPendingOverBudget] = useState<{ total: number; over: number } | null>(null);

  const checkedCount  = state.cart.filter((i) => i.checked).length;
  const checkedTotal  = state.cart.filter((i) => i.checked).reduce((sum, i) => sum + Number(i.price || 0), 0);
  const estimated     = state.cart.reduce((sum, i) => sum + Number(i.price || 0), 0);
  const budgetLeft    = getBudgetLeft(state);
  const defaultStore  = state.settings?.defaultStore ?? "Mercadona";
  const budgetWarnPct = state.settings?.budgetWarnPct ?? 80;

  const purchaseHistory = state.expenses
    .filter((e) => e.type === "expense" && e.category === "Comida")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);

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
    const qty = Number(data.get("qty"));
    const price = Number(data.get("price"));
    // E10-01: sin esto, dejar el campo vacío o poner 0 añadía un item de
    // cantidad 0 al carrito — no sirve para nada y ensucia la lista.
    if (!(qty > 0)) { showToast("La cantidad debe ser mayor que 0"); return; }
    if (Number.isNaN(price) || price < 0) { showToast("El precio no puede ser negativo"); return; }
    mutate((draft) => {
      draft.cart.push({
        id: uid(),
        name: String(data.get("name")).trim(),
        qty,
        unit: String(data.get("unit")),
        price,
        store: String(data.get("store")),
        checked: false,
        source: "manual" as const,
      });
    });
    showToast("Item añadido al carrito");
    form.reset();
  }

  function finishPurchase() {
    let completed = 0;
    mutate((draft) => { completed = actions.completeCart(draft); });
    if (completed) {
      triggerMascot("success_buy", "Compra completada. Finanzas e inventario sincronizados.");
      showToast("Compra completada");
    }
  }

  function handleCompleteCart() {
    if (!checkedCount) {
      showToast("Marca items como comprados primero");
      return;
    }
    // Aviso preventivo: si lo marcado ya se come el presupuesto semanal que
    // queda, frenamos antes de tocar Finanzas/Inventario en vez de avisar
    // después — el usuario decide con una interacción real, no se bloquea.
    if (checkedTotal > budgetLeft) {
      setPendingOverBudget({ total: checkedTotal, over: checkedTotal - budgetLeft });
      return;
    }
    finishPurchase();
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
                      <div className="suggest-row-head">
                        <span className="suggest-name">{item.name}</span>
                        {activeTab === "lowstock" && (
                          <button
                            className="suggest-dismiss"
                            title="Ocultar sugerencia"
                            onClick={() => mutate((draft) => actions.dismissSuggestion(draft, item.name))}
                          >
                            ×
                          </button>
                        )}
                      </div>
                      <div className="suggest-row-foot">
                        <span className="suggest-meta">
                          {item.qty} {item.unit} · {eur(item.price)}
                        </span>
                        <button className="small-action good suggest-add" onClick={() => addSuggestion(item)}>
                          + Añadir
                        </button>
                      </div>
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
              <input name="qty" type="number" min="0.1" step="0.1" defaultValue={1} required />
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
              <select name="store" defaultValue={defaultStore}>
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
              <button className="primary-button" onClick={handleCompleteCart}>
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
              <strong className={estimated > budgetLeft * (budgetWarnPct / 100) ? "over-budget" : ""}>
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
                    {item.reason && <small className="cart-item-reason">{item.reason}</small>}
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
                    <button className="small-action" onClick={() => setEditCartItem(item)}>
                      Editar
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

      {/* Historial de compras */}
      <article className="panel purchase-history">
        <button className="smart-suggest-toggle" onClick={() => setHistoryOpen((v) => !v)}>
          <span>🧾 Historial de compras</span>
          <span className="suggest-counts">
            <span className="badge">{purchaseHistory.length} compras</span>
          </span>
          <span className="suggest-chevron">{historyOpen ? "▲" : "▼"}</span>
        </button>

        {historyOpen && (
          purchaseHistory.length === 0 ? (
            <p className="suggest-empty">Aún no has completado ninguna compra.</p>
          ) : (
            <div className="history-list">
              {purchaseHistory.map((expense) => (
                <div key={expense.id} className="history-row">
                  <span className="history-date">{expense.date === getToday(state) ? "Hoy" : expense.date}</span>
                  <span className="history-desc">{expense.description}</span>
                  <span className="history-amount">{eur(expense.amount)}</span>
                  <button
                    className="small-action bad"
                    title="Eliminar esta compra"
                    onClick={() => {
                      mutate((draft) => {
                        draft.expenses = draft.expenses.filter((e) => e.id !== expense.id);
                      });
                      showToast("Compra eliminada del historial");
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="history-total">
                Total gastado en comida:{" "}
                <strong>{eur(purchaseHistory.reduce((s, e) => s + e.amount, 0))}</strong>
              </div>
            </div>
          )
        )}
      </article>
      {editCartItem && <EditCartItemModal item={editCartItem} onClose={() => setEditCartItem(null)} />}
      {pendingOverBudget && (
        <Modal title="Revisa el presupuesto antes de completar" onClose={() => setPendingOverBudget(null)}>
          <p className="cycle-note">
            ⚠ Esta compra ({eur(pendingOverBudget.total)}) supera tu presupuesto semanal en{" "}
            {eur(pendingOverBudget.over)}.
          </p>
          <div className="meta-row" style={{ marginTop: 12 }}>
            <button className="secondary-button" onClick={() => setPendingOverBudget(null)}>
              ← Revisar la compra
            </button>
            <button
              className="primary-button"
              onClick={() => {
                setPendingOverBudget(null);
                finishPurchase();
              }}
            >
              Completar igualmente
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
