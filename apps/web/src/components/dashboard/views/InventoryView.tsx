"use client";

import { useState, type FormEvent } from "react";
import type { StorageName } from "@foodos/types";
import { expiryBadge, useFoodOS } from "@/lib/state";
import { daysUntil, eur, todayPlus, uid } from "@/lib/utils";

const STORAGES: Array<StorageName | "Todos"> = ["Todos", "Nevera", "Congelador", "Despensa"];
const QTY_OPTIONS = [50, 100, 150, 200, 250, 300, 500, 1000];

export function InventoryView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [search, setSearch] = useState(state.inventorySearch);

  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    mutate((draft) => {
      draft.inventory.push({
        id: uid(),
        name: String(data.get("name")).trim(),
        qty: Number(data.get("qty")),
        unit: String(data.get("unit")),
        storage: String(data.get("storage")) as StorageName,
        expires: String(data.get("expires")),
        price: Number(data.get("price")),
        kcal: Number(data.get("kcal")),
        protein: Number(data.get("protein")),
      });
    });
    setMascotMessage("Alimento guardado. Estoy vigilando caducidades.");
    showToast("Alimento añadido al inventario");
    form.reset();
  }

  const query = search.toLowerCase().trim();
  let items = state.activeStorage === "Todos"
    ? state.inventory
    : state.inventory.filter((item) => item.storage === state.activeStorage);
  if (query) {
    items = items.filter(
      (item) => item.name.toLowerCase().includes(query) || item.storage.toLowerCase().includes(query)
    );
  }
  items = [...items].sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires));

  return (
    <section className="view">
      <div className="work-grid">
        <form className="panel form-panel" onSubmit={addItem}>
          <h2>Añadir alimento</h2>
          <div className="quick-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                mutate((draft) => {
                  draft.inventory.push({
                    id: uid(), name: "Atún al natural", qty: 3, unit: "ud", storage: "Despensa",
                    expires: todayPlus(120), price: 2.4, kcal: 110, protein: 24,
                  });
                });
                setMascotMessage("Barcode demo leído: atún al natural.");
                showToast("Producto barcode añadido");
              }}
            >
              Escanear barcode demo
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                mutate((draft) => {
                  draft.inventory.push({
                    id: uid(), name: "Zanahoria fresca", qty: 300, unit: "g", storage: "Nevera",
                    expires: todayPlus(5), price: 0.8, kcal: 41, protein: 1,
                  });
                });
                setMascotMessage("Foto IA demo analizada: zanahoria fresca (confianza 0,91).");
                showToast("Foto IA convertida en alimento");
              }}
            >
              Analizar foto IA demo
            </button>
          </div>
          <div className="form-grid">
            <label>
              Nombre <input name="name" required placeholder="Pechuga de pollo" />
            </label>
            <label>
              Cantidad
              <select name="qty" required defaultValue={250}>
                {QTY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Unidad
              <select name="unit" defaultValue="g">
                <option>g</option>
                <option>ml</option>
                <option>ud</option>
                <option>kg</option>
              </select>
            </label>
            <label>
              Almacén
              <select name="storage" defaultValue="Nevera">
                <option>Nevera</option>
                <option>Congelador</option>
                <option>Despensa</option>
              </select>
            </label>
            <label>
              Caduca <input name="expires" type="date" required defaultValue={todayPlus(4)} />
            </label>
            <label>
              Precio € <input name="price" type="number" step="0.01" min="0" defaultValue="2.8" />
            </label>
            <label>
              kcal/100g <input name="kcal" type="number" min="0" defaultValue="120" />
            </label>
            <label>
              Proteína/100g <input name="protein" type="number" min="0" defaultValue="23" />
            </label>
          </div>
          <button className="primary-button" type="submit">
            Guardar alimento
          </button>
        </form>

        <article className="panel">
          <div className="panel-head">
            <h2>Inventario</h2>
            <div className="segmented" role="tablist" aria-label="Filtro de almacén">
              {STORAGES.map((storage) => (
                <button
                  key={storage}
                  className={`filter ${state.activeStorage === storage ? "active" : ""}`}
                  onClick={() => mutate((draft) => void (draft.activeStorage = storage))}
                >
                  {storage}
                </button>
              ))}
            </div>
          </div>
          <div className="inline-tools">
            <input
              type="search"
              placeholder="Buscar producto"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="card-list">
            {items.length ? (
              items.map((item) => {
                const badge = expiryBadge(item.expires);
                return (
                  <article key={item.id} className="card">
                    <div>
                      <h3>{item.name}</h3>
                      <small>
                        {item.qty}
                        {item.unit} · {item.storage} · {item.kcal} kcal/100g · {item.protein} g proteína
                      </small>
                      <div className="meta-row">
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                        <span className="badge blue">{eur(item.price)}</span>
                      </div>
                    </div>
                    <div className="card-actions">
                      <button
                        className="small-action good"
                        onClick={() => {
                          mutate((draft) => {
                            const entry = draft.inventory.find((candidate) => candidate.id === item.id);
                            if (!entry) return;
                            const grams = entry.unit === "kg" ? entry.qty * 1000 : entry.qty;
                            draft.consumed.kcal += (entry.kcal * grams) / 100;
                            draft.consumed.protein += (entry.protein * grams) / 100;
                            draft.consumed.carbs += Math.max(8, entry.kcal / 10);
                            draft.consumed.fat += Math.max(2, entry.kcal / 40);
                            draft.inventory = draft.inventory.filter((candidate) => candidate.id !== item.id);
                          });
                          setMascotMessage("Consumo registrado. Macros actualizados.");
                          showToast(`${item.name} consumido`);
                        }}
                      >
                        Consumir
                      </button>
                      <button
                        className="small-action"
                        onClick={() => {
                          mutate((draft) => {
                            draft.cart.push({
                              id: uid(), name: item.name, qty: item.qty, unit: item.unit,
                              price: item.price, store: "Mercadona", checked: false,
                            });
                          });
                          showToast("Producto enviado al carrito");
                        }}
                      >
                        Al carrito
                      </button>
                      <button
                        className="small-action bad"
                        onClick={() =>
                          mutate((draft) => {
                            draft.inventory = draft.inventory.filter((candidate) => candidate.id !== item.id);
                          })
                        }
                      >
                        Borrar
                      </button>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="empty">No hay alimentos que coincidan con el filtro.</div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
