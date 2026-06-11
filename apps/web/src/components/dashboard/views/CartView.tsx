"use client";

import { type FormEvent } from "react";
import { actions, useFoodOS } from "@/lib/state";
import { eur, uid } from "@/lib/utils";

export function CartView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();

  const checkedCount = state.cart.filter((item) => item.checked).length;
  const estimated = state.cart.reduce((sum, item) => sum + Number(item.price || 0), 0);

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
      });
    });
    showToast("Item añadido al carrito");
    form.reset();
  }

  return (
    <section className="view">
      <div className="work-grid">
        <form className="panel form-panel" onSubmit={addItem}>
          <h2>Añadir al carrito</h2>
          <div className="form-grid compact">
            <label>
              Producto <input name="name" required placeholder="Arroz integral" />
            </label>
            <label>
              Cantidad
              <select name="qty" required defaultValue={1}>
                {[1, 2, 3, 4, 6, 8, 12].map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Unidad <input name="unit" defaultValue="ud" />
            </label>
            <label>
              Precio estimado <input name="price" type="number" min="0" step="0.01" defaultValue="1.5" />
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

        <article className="panel">
          <div className="panel-head">
            <h2>Carrito</h2>
            <div className="panel-actions">
              <button
                className="secondary-button"
                onClick={() => {
                  let moved = 0;
                  mutate((draft) => {
                    moved = actions.moveCheckedToInventory(draft);
                  });
                  showToast(`${moved} productos movidos a despensa`);
                }}
              >
                Mover a despensa
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  mutate((draft) => {
                    draft.cart = draft.cart.filter((item) => !item.checked);
                  });
                  showToast("Marcados eliminados");
                }}
              >
                Limpiar marcados
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  let completed = 0;
                  mutate((draft) => {
                    completed = actions.completeCart(draft);
                  });
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
          </div>

          <div className="card-list">
            {state.cart.length ? (
              state.cart.map((item) => (
                <article key={item.id} className="card">
                  <div>
                    <h3>{item.name}</h3>
                    <small>
                      {item.qty}
                      {item.unit} · {item.store} · {eur(item.price)}
                    </small>
                    <div className="meta-row">
                      <span className={`badge ${item.checked ? "green" : "amber"}`}>
                        {item.checked ? "Comprado" : "Pendiente"}
                      </span>
                    </div>
                  </div>
                  <div className="card-actions">
                    <button
                      className="small-action good"
                      onClick={() =>
                        mutate((draft) => {
                          const entry = draft.cart.find((candidate) => candidate.id === item.id);
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
                          draft.cart = draft.cart.filter((candidate) => candidate.id !== item.id);
                        })
                      }
                    >
                      Borrar
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <div className="empty">El carrito está vacío.</div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
