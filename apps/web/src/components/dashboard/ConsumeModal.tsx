"use client";

import { useMemo, useState } from "react";
import type { InventoryItem } from "@foodos/types";
import { actions, macrosForQuantity, useFoodOS, type ConsumeInventoryResult } from "@/lib/state";
import { intentGuard, runGuardedIntentResult } from "@/lib/intent-guard";
import { uid } from "@/lib/utils";
import { Modal } from "./Modal";

const WEIGHABLE_UNITS = new Set(["g", "kg"]);

/** §20.5 — mismo saneado estricto que `sanitizeFoodLogProvenance`: finito y
 *  estrictamente positivo, o un mensaje de error comprensible. Nunca
 *  convierte una entrada vacía o inválida en 0 en silencio. */
function parseDeclaredGrams(raw: string): { value: number } | { error: string } {
  if (raw.trim() === "") return { error: "Indica cuántos gramos has pesado." };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: "No es un número válido." };
  if (value <= 0) return { error: "Debe ser mayor que 0." };
  return { value };
}

// Consumo parcial de un alimento: eliges cuanto y ves sus macros en vivo.
export function ConsumeModal({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const { mutate, showToast, setMascotMessage } = useFoodOS();
  // Una intención por montaje del modal — ver CookModal.tsx para el mismo
  // patrón y su justificación completa.
  const [intentId] = useState(() => uid());
  const [qty, setQty] = useState(item.unit === "ud" ? 1 : Math.min(item.qty, 100));

  // §20.1 — modo «He pesado»: un control SEPARADO del campo de cantidad
  // normal, nunca recordado entre aperturas del modal (useState vuelve a
  // `false` cada vez que este componente se monta de nuevo — no hay
  // ninguna fuente que lo precargue a `true`). Solo se ofrece cuando la
  // unidad del item YA es masa exacta — nunca para "ud"/"ml"/etc (§20.3).
  const canWeigh = WEIGHABLE_UNITS.has(item.unit);
  const [weighed, setWeighed] = useState(false);
  const [declaredGramsInput, setDeclaredGramsInput] = useState("");
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  const safeQty = Math.max(0, Math.min(qty, item.qty));
  const macros = useMemo(() => macrosForQuantity(item, weighed ? 0 : safeQty), [item, safeQty, weighed]);
  const remaining = Math.round((item.qty - safeQty) * 100) / 100;
  const pct = Math.round((safeQty / item.qty) * 100);

  // Recorta al escribir para que el campo nunca muestre más de lo disponible
  // (antes el input dejaba ver "999" mientras el consumo real se limitaba al stock).
  // §20.2 — este recorte visual es EXCLUSIVO del modo estimado: el campo de
  // gramos pesados (más abajo) nunca pasa por aquí.
  const setQtyClamped = (val: number) => setQty(Math.max(0, Math.min(item.qty, val)));

  const presets =
    item.unit === "ud"
      ? [1, Math.max(1, Math.round(item.qty / 2)), item.qty].filter((v, i, a) => a.indexOf(v) === i)
      : [Math.round(item.qty * 0.25), Math.round(item.qty * 0.5), item.qty].filter((v) => v > 0);

  const declaredGrams = parseDeclaredGrams(declaredGramsInput);
  // Vista previa de macros SOLO cuando hay un número válido — un campo vacío
  // o inválido no debe mostrar una cifra inventada.
  const weighedMacros = useMemo(
    () => ("value" in declaredGrams ? macrosForQuantity(item, item.unit === "kg" ? declaredGrams.value / 1000 : declaredGrams.value) : null),
    [item, declaredGrams],
  );

  function handleWeighedToggle(next: boolean) {
    setWeighed(next);
    setDeclaredGramsInput("");
    setBlockedReason(null);
  }

  function submit() {
    setBlockedReason(null);
    const input = weighed
      ? ("value" in declaredGrams ? { declaredGrams: declaredGrams.value } : null)
      : { qty: safeQty };
    if (!input) return; // botón ya debería estar deshabilitado en este caso

    let result: ConsumeInventoryResult | undefined;
    const outcome = runGuardedIntentResult(
      intentGuard,
      intentId,
      () => {
        const mutateApplied = mutate((draft) => { result = actions.consumeInventoryItem(draft, item.id, input); });
        // §20.6 — mutate() puede no haber ejecutado el updater en absoluto
        // (gate de hidratación cerrado): sin resultado real, se trata como
        // "no aceptado" para que el guard libere la reclamación y permita
        // reintentar, en vez de fingir un resultado que nunca ocurrió.
        return mutateApplied && result ? result : ({ kind: "mutation_blocked" } as const);
      },
      (r) => r.kind === "written" || r.kind === "written_reduced",
    );
    if ("claimed" in outcome) return; // doble clic/doble intento — ya se procesó la primera vez

    switch (outcome.kind) {
      case "written":
        setMascotMessage("Consumo registrado en tu diario.");
        showToast(weighed ? `${item.name}: ${declaredGramsInput} g registrados` : `${item.name}: ${safeQty} ${item.unit} registrados (${macros.kcal} kcal)`);
        onClose();
        return;
      case "written_reduced":
        setMascotMessage("Consumo registrado en tu diario.");
        showToast(`${item.name}: solo había stock para una parte de lo pedido — se registró lo disponible.`);
        onClose();
        return;
      case "item_missing":
        showToast(`${item.name} ya no está en el inventario — puede que se consumiera en otra pestaña.`);
        onClose();
        return;
      case "unit_incompatible":
        // §20.3b — bloqueado, SIN escribir nada: se conserva declaredGramsInput
        // tal cual para que la persona pueda revisar y reintentar, en vez de
        // perder lo que había tecleado.
        setBlockedReason(`La unidad de "${item.name}" ha cambiado desde que abriste este diálogo — revisa la cantidad antes de registrar.`);
        return;
      case "mutation_blocked":
        setBlockedReason("No se pudo registrar ahora mismo — inténtalo de nuevo en unos segundos.");
        return;
      case "invalid_declared_grams":
        // Defensivo — el botón ya está deshabilitado mientras declaredGrams
        // no sea válido, así que esto no debería alcanzarse desde la UI.
        setBlockedReason("La cantidad pesada no es válida — revísala antes de registrar.");
        return;
    }
  }

  return (
    <Modal title={`Consumir ${item.name}`} onClose={onClose}>
      <p className="consume-available">
        Tienes <strong>
          {item.qty} {item.unit}
        </strong>{" "}
        en {item.storage.toLowerCase()} · {item.kcal} kcal y {item.protein} g de proteína por 100 g.
      </p>

      {canWeigh && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <input
            type="checkbox"
            checked={weighed}
            onChange={(event) => handleWeighedToggle(event.target.checked)}
          />
          He pesado esta cantidad (g)
        </label>
      )}

      {weighed ? (
        <div className="consume-controls">
          <label>
            Gramos pesados
            <input
              type="number"
              min="0"
              step="1"
              value={declaredGramsInput}
              onChange={(event) => { setDeclaredGramsInput(event.target.value); setBlockedReason(null); }}
              autoFocus
              placeholder="p. ej. 233"
            />
          </label>
          {"error" in declaredGrams && declaredGramsInput !== "" && (
            <small style={{ color: "var(--red, #c33)" }}>{declaredGrams.error}</small>
          )}
          {blockedReason && <small style={{ color: "var(--amber, #c90)" }}>{blockedReason}</small>}
        </div>
      ) : (
        <div className="consume-controls">
          <label>
            Cantidad ({item.unit})
            <input
              type="number"
              min="0"
              max={item.qty}
              step={item.unit === "ud" ? 1 : 5}
              value={qty}
              onChange={(event) => setQtyClamped(Number(event.target.value))}
              autoFocus
            />
          </label>
          <input
            className="consume-slider"
            type="range"
            min="0"
            max={item.qty}
            step={item.unit === "ud" ? 1 : 5}
            value={safeQty}
            onChange={(event) => setQtyClamped(Number(event.target.value))}
            aria-label="Cantidad a consumir"
          />
          <div className="consume-presets">
            {presets.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`filter ${safeQty === preset ? "active" : ""}`}
                onClick={() => setQty(preset)}
              >
                {preset === item.qty ? "Todo" : `${preset} ${item.unit}`}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="recipe-macros-row">
        <div className="macro-item">
          <span className="macro-val">{weighed ? (weighedMacros?.kcal ?? "—") : macros.kcal}</span>
          <span className="macro-lbl">kcal</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">{weighed ? (weighedMacros?.protein ?? "—") : macros.protein}g</span>
          <span className="macro-lbl">proteína</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">~{weighed ? (weighedMacros?.carbs ?? "—") : macros.carbs}g</span>
          <span className="macro-lbl">carbos est.</span>
        </div>
        <div className="macro-item">
          <span className="macro-val">~{weighed ? (weighedMacros?.fat ?? "—") : macros.fat}g</span>
          <span className="macro-lbl">grasas est.</span>
        </div>
      </div>

      {!weighed && (
        <p className="consume-remaining">
          {remaining > 0 ? (
            <>
              Consumes el {pct}% — quedarán{" "}
              <strong>
                {remaining} {item.unit}
              </strong>{" "}
              en tu inventario.
            </>
          ) : (
            <>Consumes todo: el alimento se eliminará del inventario.</>
          )}
        </p>
      )}

      <div className="recipe-detail-actions">
        <button className="secondary-button" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="primary-button"
          disabled={weighed ? "error" in declaredGrams : safeQty <= 0}
          onClick={submit}
        >
          Registrar consumo
        </button>
      </div>
    </Modal>
  );
}
