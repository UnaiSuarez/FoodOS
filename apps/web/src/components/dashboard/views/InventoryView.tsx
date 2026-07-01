"use client";

import { useState, useRef, useMemo, useEffect, type FormEvent } from "react";
import type { InventoryItem, StorageName } from "@foodos/types";
import { expiryBadge, findRememberedUnitSize, matchAllergens, useFoodOS } from "@/lib/state";
import { daysUntil, eur, todayPlus, uid } from "@/lib/utils";
import { searchFoodDB, type FoodEntry } from "@/lib/food-db";
import { fillFoodData, scanTicketImage, identifyFoodFromPhoto } from "@/lib/ai-inventory";
import { loadAIConfig } from "@/lib/ai-config";
import { searchOFFSuggestions, type ExternalFoodSuggestion } from "@/lib/food-lookup";
import { ConsumeModal } from "../ConsumeModal";
import { ImagePickerField } from "../ImagePickerField";
import { BarcodeScannerModal, type ProductData } from "../BarcodeScannerModal";
import { BulkImportModal } from "../BulkImportModal";
import { EditInventoryModal } from "../EditInventoryModal";
import { InventoryDetailModal } from "../InventoryDetailModal";

const STORAGES: Array<StorageName | "Todos"> = ["Todos", "Nevera", "Congelador", "Despensa"];

type FormState = {
  name: string;
  qty: number;
  unit: string;
  storage: StorageName;
  expires: string;
  price: number;
  kcal: number;
  protein: number;
  /** Gramos/ml que representa 1 unidad, solo aplica cuando unit==="ud" (ej. lata de 250 ml). */
  unitSize: number;
};

const DEFAULT_FORM: FormState = {
  name: "",
  qty: 250,
  unit: "g",
  storage: "Nevera",
  expires: todayPlus(4),
  price: 2.8,
  kcal: 120,
  protein: 23,
  unitSize: 60,
};

export function InventoryView() {
  const { state, mutate, showToast, setMascotMessage } = useFoodOS();
  const [search, setSearch] = useState(state.inventorySearch);
  const [consumeItem, setConsumeItem] = useState<InventoryItem | null>(null);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [detailItem, setDetailItem] = useState<InventoryItem | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [suggestions, setSuggestions] = useState<FoodEntry[]>([]);
  const [offSuggestions, setOffSuggestions] = useState<ExternalFoodSuggestion[]>([]);
  const [offLoading, setOffLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filling, setFilling] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  const [bulkItems, setBulkItems] = useState<import("@/lib/ai-inventory").ScannedItem[] | null>(null);
  // Datos extra de escaneo/OFF (nutrientes, marca, foto, alérgenos) — se guardan con el item
  const [itemExtras, setItemExtras] = useState<
    Pick<InventoryItem, "carbs" | "fat" | "salt" | "fiber" | "sugars" | "brand" | "imageUrl" | "allergenTags">
  >({});
  const allergenWarnings = useMemo(
    () => matchAllergens(state, itemExtras.allergenTags),
    [state, itemExtras.allergenTags]
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  // Para la regla de 3: cantidad de referencia cuando se cambia la qty
  const prevQtyRef = useRef<number>(DEFAULT_FORM.qty);
  const offTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(offTimerRef.current), []);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleNameChange(value: string) {
    setField("name", value);
    setItemExtras({});
    const hits = searchFoodDB(value, 5);
    setSuggestions(hits);
    setOffSuggestions([]);

    const remembered = findRememberedUnitSize(state, value);
    if (remembered != null) setField("unitSize", remembered);

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
      setOffLoading(false);
      return;
    }

    // Búsqueda async en OFF con debounce 600 ms
    clearTimeout(offTimerRef.current);
    if (trimmed.length >= 2) {
      setOffLoading(true);
      offTimerRef.current = setTimeout(() => {
        void searchOFFSuggestions(trimmed, 5).then((results) => {
          setOffSuggestions(results);
          setOffLoading(false);
        });
      }, 600);
    } else {
      setOffLoading(false);
    }
  }

  function applySuggestion(entry: FoodEntry) {
    prevQtyRef.current = entry.defaultQty;
    const remembered = entry.unit === "ud" ? findRememberedUnitSize(state, entry.name) : undefined;
    setForm((prev) => ({
      ...prev,
      name: entry.name,
      unit: entry.unit,
      qty: entry.defaultQty,
      storage: entry.storage,
      expires: todayPlus(entry.expiryDays),
      kcal: entry.kcal,
      protein: entry.protein,
      unitSize: remembered ?? prev.unitSize,
    }));
    setItemExtras({ carbs: entry.carbs, fat: entry.fat });
    setSuggestions([]);
    setOffSuggestions([]);
    setShowSuggestions(false);
    setOffLoading(false);
  }

  function applyOFFSuggestion(s: ExternalFoodSuggestion) {
    const remembered = findRememberedUnitSize(state, s.name);
    const unitSize = remembered ?? s.packageSize;
    // Si conocemos el tamaño del envase, lo tratamos como "1 ud" (ej. 1 lata) en vez de 100 g/ml sueltos.
    const useUnits = unitSize != null;
    prevQtyRef.current = useUnits ? 1 : 100;
    setForm((prev) => ({
      ...prev,
      name: s.name,
      unit: useUnits ? "ud" : "g",
      qty: useUnits ? 1 : 100,
      kcal: s.kcal,
      protein: s.protein,
      unitSize: unitSize ?? prev.unitSize,
    }));
    setItemExtras({
      carbs: s.carbs, fat: s.fat, salt: s.salt, fiber: s.fiber, sugars: s.sugars,
      brand: s.brand, imageUrl: s.imageUrl, allergenTags: s.allergenTags,
    });
    setSuggestions([]);
    setOffSuggestions([]);
    setShowSuggestions(false);
    setOffLoading(false);
  }

  function handleQtyChange(newQty: number) {
    const prev = prevQtyRef.current;
    setForm((f) => ({
      ...f,
      qty: newQty,
      price: (prev > 0 && newQty > 0 && f.price > 0)
        ? Math.round(f.price / prev * newQty * 100) / 100
        : f.price,
    }));
    prevQtyRef.current = newQty;
  }

  async function handleFill() {
    if (!form.name.trim()) { showToast("Escribe un nombre primero"); return; }
    setFilling(true);
    try {
      const config = loadAIConfig();
      const data = await fillFoodData(config, form.name.trim());
      if (data) {
        setForm((prev) => ({
          ...prev,
          kcal: data.kcal,
          protein: data.protein,
          unit: data.unit,
          // Mantener la cantidad que el usuario haya introducido
          storage: data.storage,
          expires: todayPlus(data.expiryDays),
        }));
        showToast("Datos completados");
      } else {
        showToast("No se encontraron datos. Configura la IA para más resultados.");
      }
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : "desconocido"}`);
    } finally {
      setFilling(false);
    }
  }

  async function handleTicketFile(file: File) {
    const config = loadAIConfig();
    if (!config) {
      showToast("Configura la IA en Ajustes para escanear tickets");
      return;
    }
    setScanLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const items = await scanTicketImage(config, base64, file.type || "image/jpeg");
      setBulkItems(items);
      if (items.length === 0) showToast("No se detectaron alimentos en la imagen");
    } catch (e) {
      showToast(`Error al escanear: ${e instanceof Error ? e.message : "desconocido"}`);
    } finally {
      setScanLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleScanFill(data: ProductData) {
    const remembered = findRememberedUnitSize(state, data.name);
    const unitSize = remembered ?? data.packageSize;
    const useUnits = unitSize != null;
    if (useUnits) prevQtyRef.current = 1;
    setForm((prev) => ({
      ...prev,
      name: data.name,
      kcal: data.kcal ?? prev.kcal,
      protein: data.protein ?? prev.protein,
      ...(useUnits && { unit: "ud", qty: 1 }),
      unitSize: unitSize ?? prev.unitSize,
    }));
    setItemExtras({
      carbs: data.carbs,
      fat: data.fat,
      salt: data.salt,
      fiber: data.fiber,
      sugars: data.sugars,
      brand: data.brand,
      imageUrl: data.imageUrl,
      allergenTags: data.allergenTags,
    });
    setScannerOpen(false);
    showToast(`Producto encontrado: ${data.name}`);
    setMascotMessage(`${data.name} listo para añadir al inventario.`);
  }

  async function handleFoodPhoto(file: File) {
    const config = loadAIConfig();
    if (!config) { showToast("Configura la IA en Ajustes para usar esta función"); return; }
    setScanLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const result = await identifyFoodFromPhoto(config, base64, file.type || "image/jpeg");
      if (result) {
        prevQtyRef.current = result.defaultQty;
        setForm((prev) => ({
          ...prev,
          name: result.name || prev.name,
          kcal: result.kcal,
          protein: result.protein,
          unit: result.unit,
          qty: result.defaultQty,
          storage: result.storage,
          expires: todayPlus(result.expiryDays),
        }));
        setItemExtras({});
        showToast(`Identificado: ${result.name}`);
        setMascotMessage(`${result.name} detectado. Revisa los datos y guarda.`);
      } else {
        showToast("No se pudo identificar el alimento. Completa los datos manualmente.");
      }
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : "desconocido"}`);
    } finally {
      setScanLoading(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutate((draft) => {
      draft.inventory.push({
        id: uid(),
        name: form.name.trim(),
        qty: form.qty,
        unit: form.unit,
        storage: form.storage,
        expires: form.expires,
        price: form.price,
        kcal: form.kcal,
        protein: form.protein,
        unitSize: form.unit === "ud" ? form.unitSize : undefined,
        ...itemExtras,
      });
    });
    setForm({ ...DEFAULT_FORM, expires: todayPlus(4) });
    setItemExtras({});
    setMascotMessage("Alimento guardado. Estoy vigilando caducidades.");
    showToast("Alimento añadido al inventario");
  }

  const totalKcal = useMemo(() => {
    if (form.unit === "g" || form.unit === "ml") return Math.round(form.kcal * form.qty / 100);
    if (form.unit === "ud") return Math.round(form.kcal * form.qty * form.unitSize / 100);
    return null;
  }, [form.kcal, form.qty, form.unit, form.unitSize]);

  const query = search.toLowerCase().trim();
  let items = state.activeStorage === "Todos"
    ? state.inventory
    : state.inventory.filter((item) => item.storage === state.activeStorage);
  if (query) {
    items = items.filter(
      (item) => item.name.toLowerCase().includes(query) || item.storage.toLowerCase().includes(query)
    );
  }

  // Agrupa por nombre, ordena cada grupo por caducidad (FIFO), ordena grupos por su lote más próximo
  {
    const groups = new Map<string, InventoryItem[]>();
    for (const item of items) {
      const key = item.name.toLowerCase();
      const g = groups.get(key) ?? [];
      g.push(item);
      groups.set(key, g);
    }
    items = [...groups.values()]
      .map((g) => [...g].sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires)))
      .sort((a, b) => daysUntil(a[0].expires) - daysUntil(b[0].expires))
      .flat();
  }

  const hasAI = typeof window !== "undefined" && !!loadAIConfig();

  return (
    <section className="view">
      <div className="work-grid">
        <form className="panel form-panel" onSubmit={addItem}>
          <h2>Añadir alimento</h2>

          <div className="quick-actions" data-tour="inventory-add">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setScannerOpen(true)}
            >
              📷 Código de barras
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={scanLoading}
              title={hasAI ? "Foto del alimento o su etiqueta — la IA lo identifica" : "Configura la IA para usar esta función"}
              onClick={() => photoInputRef.current?.click()}
            >
              {scanLoading ? "Identificando…" : "🍎 Foto alimento"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={scanLoading}
              title={hasAI ? "Escanea un ticket o foto de alimentos" : "Configura la IA para usar esta función"}
              onClick={() => fileInputRef.current?.click()}
            >
              {scanLoading ? "Analizando…" : "🧾 Ticket"}
            </button>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFoodPhoto(file);
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleTicketFile(file);
              }}
            />
          </div>

          <div className="form-grid">
            <label className="name-label">
              Nombre
              <div className="autocomplete-wrapper">
                <input
                  name="name"
                  required
                  placeholder="Pechuga de pollo"
                  value={form.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  onFocus={() => { if (form.name.trim()) setShowSuggestions(true); }}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  autoComplete="off"
                />
                {showSuggestions && (suggestions.length > 0 || offLoading || offSuggestions.length > 0) && (
                  <ul className="autocomplete-dropdown">
                    {suggestions.map((entry) => (
                      <li
                        key={entry.name}
                        onMouseDown={() => applySuggestion(entry)}
                        className="autocomplete-item"
                      >
                        <span className="ac-name">{entry.name}</span>
                        <span className="ac-meta">{entry.kcal} kcal · {entry.protein}g prot</span>
                      </li>
                    ))}
                    {offLoading && (
                      <li className="autocomplete-item ac-loading">
                        <span className="ac-name ac-muted">Buscando en Open Food Facts…</span>
                      </li>
                    )}
                    {!offLoading && offSuggestions.length > 0 && (
                      <>
                        {suggestions.length > 0 && <li className="ac-divider">Open Food Facts</li>}
                        {offSuggestions.map((s) => (
                          <li
                            key={s.name}
                            onMouseDown={() => applyOFFSuggestion(s)}
                            className="autocomplete-item"
                          >
                            <span className="ac-name">{s.name}</span>
                            <span className="ac-meta">{s.kcal} kcal · {s.protein}g prot</span>
                            <span className="ac-badge-off">OFF</span>
                          </li>
                        ))}
                      </>
                    )}
                  </ul>
                )}
              </div>
            </label>

            <label>
              Cantidad
              <input
                name="qty"
                type="number"
                min="0"
                step="0.1"
                required
                value={form.qty}
                onChange={(e) => handleQtyChange(Number(e.target.value))}
              />
            </label>

            <label>
              Unidad
              <select
                name="unit"
                value={form.unit}
                onChange={(e) => setField("unit", e.target.value)}
              >
                <option>g</option>
                <option>ml</option>
                <option>ud</option>
                <option>kg</option>
                <option>L</option>
              </select>
            </label>

            {form.unit === "ud" && (
              <label>
                Tamaño por unidad (g/ml)
                <input
                  name="unitSize"
                  type="number"
                  min="1"
                  step="1"
                  value={form.unitSize}
                  onChange={(e) => setField("unitSize", Number(e.target.value))}
                />
              </label>
            )}

            <label>
              Almacén
              <select
                name="storage"
                value={form.storage}
                onChange={(e) => setField("storage", e.target.value as StorageName)}
              >
                <option>Nevera</option>
                <option>Congelador</option>
                <option>Despensa</option>
              </select>
            </label>

            <label>
              Caduca
              <input
                name="expires"
                type="date"
                required
                value={form.expires}
                onChange={(e) => setField("expires", e.target.value)}
              />
            </label>

            <label>
              Precio €
              <input
                name="price"
                type="number"
                step="0.01"
                min="0"
                value={form.price}
                onChange={(e) => setField("price", Number(e.target.value))}
              />
            </label>

            <label>
              kcal/100g
              <input
                name="kcal"
                type="number"
                min="0"
                step="0.1"
                value={form.kcal}
                onChange={(e) => setField("kcal", Number(e.target.value))}
              />
            </label>

            <label>
              Proteína/100g
              <input
                name="protein"
                type="number"
                min="0"
                step="0.1"
                value={form.protein}
                onChange={(e) => setField("protein", Number(e.target.value))}
              />
            </label>
          </div>

          <ImagePickerField
            imageUrl={itemExtras.imageUrl}
            brand={itemExtras.brand}
            onChange={(url) => setItemExtras((prev) => ({ ...prev, imageUrl: url }))}
          />

          {allergenWarnings.length > 0 && (
            <p className="allergen-warning" role="alert">
              ⚠ Contiene {allergenWarnings.join(", ")} — lo tienes marcado como alergia en tu perfil.
            </p>
          )}

          {totalKcal !== null && (
            <p className="form-total-hint">
              Total lote: <strong>{totalKcal} kcal</strong> ·{" "}
              <strong>
                {Math.round(form.protein * (form.unit === "ud" ? form.qty * form.unitSize : form.qty) / 100)}g prot
              </strong>{" "}
              · <strong>{eur(form.price)}</strong>
            </p>
          )}

          <div className="form-actions-row">
            <button
              className="secondary-button fill-btn"
              type="button"
              disabled={filling || !form.name.trim()}
              onClick={handleFill}
              title="Completa kcal/proteína desde la base de datos local o IA"
            >
              {filling ? "Buscando…" : "✦ Completar datos"}
            </button>
            <button className="primary-button" type="submit">
              Guardar alimento
            </button>
          </div>
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
              items.map((item, idx) => {
                const badge = expiryBadge(item.expires);
                const isGrouped = idx > 0 && items[idx - 1].name.toLowerCase() === item.name.toLowerCase();
                return (
                  <article key={item.id} className={`card ${isGrouped ? "card-grouped" : ""}`}>
                    <div
                      className="card-info"
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailItem(item)}
                      onKeyDown={(e) => e.key === "Enter" && setDetailItem(item)}
                      aria-label={`Ver detalles de ${item.name}`}
                    >
                      <div className="card-info-row">
                        {item.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={item.imageUrl} alt="" className="card-thumb" />
                        ) : (
                          <span className="card-thumb card-thumb-placeholder" aria-hidden="true">🍽️</span>
                        )}
                        <div className="card-info-text">
                          <h3>{item.name}{item.brand && <span className="card-brand"> · {item.brand}</span>}</h3>
                          <small>
                            {item.qty}{item.unit} · {item.storage} · {item.kcal} kcal/100g · {item.protein}g prot
                          </small>
                          <div className="meta-row">
                            <span className={`badge ${badge.cls}`}>{badge.label}</span>
                            <span className="badge blue">{eur(item.price)}</span>
                            {(item.carbs != null || item.fat != null) && (
                              <span className="badge green-soft" title="Datos nutricionales completos">+info</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="card-actions">
                      <button className="small-action good" onClick={() => setConsumeItem(item)}>
                        Consumir
                      </button>
                      <button className="small-action" onClick={() => setEditItem(item)}>
                        Editar
                      </button>
                      <button
                        className="small-action"
                        onClick={() => {
                          mutate((draft) => {
                            draft.cart.push({
                              id: uid(), name: item.name, qty: item.qty, unit: item.unit,
                              price: item.price, store: "Mercadona", checked: false,
                              unitSize: item.unitSize,
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
                            draft.inventory = draft.inventory.filter((c) => c.id !== item.id);
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
      {editItem && <EditInventoryModal item={editItem} onClose={() => setEditItem(null)} />}
      {detailItem && (
        <InventoryDetailModal
          item={detailItem}
          onClose={() => setDetailItem(null)}
          onEdit={() => { setEditItem(detailItem); setDetailItem(null); }}
          onConsume={() => { setConsumeItem(detailItem); setDetailItem(null); }}
        />
      )}
      {scannerOpen && <BarcodeScannerModal onFill={handleScanFill} onClose={() => setScannerOpen(false)} />}
      {bulkItems !== null && (
        <BulkImportModal items={bulkItems} onClose={() => setBulkItems(null)} />
      )}
    </section>
  );
}
