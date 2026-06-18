"use client";

import { useState, type FormEvent } from "react";
import type { InventoryItem, StorageName } from "@foodos/types";
import { expiryBadge, useFoodOS } from "@/lib/state";
import { daysUntil, eur, todayPlus, uid } from "@/lib/utils";
import { ConsumeModal } from "../ConsumeModal";
import { BarcodeScannerModal, type ProductData } from "../BarcodeScannerModal";

const STORAGES: Array<StorageName | "Todos"> = ["Todos", "Nevera", "Congelador", "Despensa"];
const QTY_OPTIONS = [50, 100, 150, 200, 250, 300, 500, 1000];

export function InventoryView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [search, setSearch] = useState(state.inventorySearch);
  const [consumeItem, setConsumeItem] = useState<InventoryItem | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [prefill, setPrefill] = useState<ProductData | null>(null);
  const [formKey, setFormKey] = useState(0);

  function handleScanFill(data: ProductData) {
    setPrefill(data);
    setFormKey((k) => k + 1);
    setScannerOpen(false);
    showToast(`Producto encontrado: ${data.name}`);
    setMascotMessage(`${data.name} listo para añadir al inventario.`);
  }

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
    setPrefill(null);
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
        <form key={formKey} className="panel form-panel" onSubmit={addItem}>
          <h2>Añadir alimento</h2>
          <div className="quick-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setScannerOpen(true)}
            >
              📷 Escanear código de barras
            </button>
          </div>
          {prefill && (
            <p className="form-hint scan-prefill-hint">
              ✓ Datos de Open Food Facts: <strong>{prefill.name}</strong> — edita si es necesario.
            </p>
          )}
          <div className="form-grid">
            <label>
              Nombre <input name="name" required placeholder="Pechuga de pollo" defaultValue={prefill?.name ?? ""} />
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
              kcal/100g <input name="kcal" type="number" min="0" defaultValue={prefill?.kcal ?? 120} />
            </label>
            <label>
              Proteína/100g <input name="protein" type="number" min="0" defaultValue={prefill?.protein ?? 23} />
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
                      <button className="small-action good" onClick={() => setConsumeItem(item)}>
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

      {consumeItem && <ConsumeModal item={consumeItem} onClose={() => setConsumeItem(null)} />}
      {scannerOpen && <BarcodeScannerModal onFill={handleScanFill} onClose={() => setScannerOpen(false)} />}
    </section>
  );
}
