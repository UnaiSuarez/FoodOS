"use client";

import { useRef, useState } from "react";
import { remote } from "@/lib/data-layer";
import { useFoodOS } from "@/lib/state";
import { hasSupabaseConfig } from "@/lib/supabase";
import { resizeImageFile } from "@/lib/utils";
import { Modal } from "./Modal";

const PLACEHOLDER_EMOJI = "🍽️";

interface Props {
  imageUrl: string | undefined;
  brand?: string;
  onChange: (url: string | undefined) => void;
}

/** Selector de imagen de producto: URL manual, cámara o galería, con vista
    previa ampliable y un placeholder genérico cuando no hay ninguna. */
export function ImagePickerField({ imageUrl, brand, onChange }: Props) {
  const { showToast } = useFoodOS();
  const [urlMode, setUrlMode] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError("");
    setUploading(true);
    try {
      const dataUrl = await resizeImageFile(file);
      // Con sesión, la foto va a Supabase Storage y el estado solo lleva la URL
      // (el base64 pesaba 30-80KB por foto en cada localStorage/push).
      // Corrección de revisión (bloqueante P0, "el manejo de
      // uploadProductImage viola el contrato"): los cinco resultados de
      // RemoteMutationResult ("ok"/"blocked"/"unavailable"/"stale-session"/
      // "error") ya NO se colapsan en el mismo fallback — antes "blocked"
      // completaba el formulario igual que un éxito, justo lo que el gate
      // estaba tratando de impedir.
      const result = await remote.uploadProductImage(dataUrl);
      if (result.kind === "ok") {
        onChange(result.value);
      } else if (result.kind === "unavailable") {
        // Sin sesión real (modo local, o un hueco transitorio sin cuenta)
        // — comportamiento de siempre: la foto vive en base64 hasta que
        // haya sesión con la que sincronizarla.
        onChange(dataUrl);
      } else if (result.kind === "blocked") {
        // Gate cerrado (cuenta sincronizándose todavía) — NUNCA se
        // completa el formulario con una foto que ni siquiera se intentó
        // subir; nada de onChange() aquí.
        showToast("Cuenta sincronizándose todavía — vuelve a intentarlo en un momento.");
      } else if (result.kind === "stale-session") {
        // Corrección de revisión (P1): la sesión cambió mientras la subida
        // estaba en vuelo (A→B) — el caller la IGNORA POR COMPLETO, nunca
        // adjunta la URL de A al formulario que ahora pertenece a B. Sin
        // aviso: desde la perspectiva de B, esto simplemente no ocurrió.
      } else {
        // "error": el intento SÍ se hizo y falló de verdad. Degradar a
        // base64 sigue siendo mejor que perder la foto, pero con Supabase
        // configurado no puede quedar disfrazado de guardado sincronizado
        // normal — aviso explícito.
        console.warn("FoodOS: subida a Storage falló, usando imagen local", result.error);
        if (hasSupabaseConfig()) {
          showToast("No se pudo subir la foto al servidor — se guarda solo en este dispositivo.");
        }
        onChange(dataUrl);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "No se pudo procesar la imagen. Prueba con una URL.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="image-picker">
      <button
        type="button"
        className="image-picker-thumb"
        onClick={() => imageUrl && setZoom(true)}
        aria-label={uploading ? "Subiendo imagen" : imageUrl ? "Ver imagen más grande" : "Sin imagen"}
        aria-busy={uploading}
        disabled={uploading}
      >
        {uploading ? (
          <span className="image-picker-placeholder" aria-hidden="true">⏳</span>
        ) : imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" />
        ) : (
          <span className="image-picker-placeholder" aria-hidden="true">{PLACEHOLDER_EMOJI}</span>
        )}
      </button>

      <div className="image-picker-controls">
        {brand && <span className="form-product-brand">{brand}</span>}
        <div className="image-picker-buttons">
          <button type="button" className="text-button" onClick={() => setUrlMode((v) => !v)}>
            🔗 URL
          </button>
          <button type="button" className="text-button" onClick={() => cameraRef.current?.click()}>
            📷 Cámara
          </button>
          <button type="button" className="text-button" onClick={() => galleryRef.current?.click()}>
            🖼 Galería
          </button>
          {imageUrl && (
            <button type="button" className="text-button" onClick={() => onChange(undefined)}>
              🗑 Quitar
            </button>
          )}
        </div>
        {urlMode && (
          <input
            type="url"
            placeholder="https://…"
            aria-label="URL de la imagen"
            autoFocus
            value={imageUrl ?? ""}
            onChange={(e) => onChange(e.target.value || undefined)}
          />
        )}
        {error && <small className="allergen-warning">{error}</small>}
      </div>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden-file-input"
        onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        className="hidden-file-input"
        onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }}
      />

      {zoom && imageUrl && (
        <Modal title="Imagen del producto" onClose={() => setZoom(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="" className="image-lightbox-full" />
        </Modal>
      )}
    </div>
  );
}
