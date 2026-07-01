"use client";

import { useRef, useState } from "react";
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
  const [urlMode, setUrlMode] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [error, setError] = useState("");
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError("");
    try {
      const dataUrl = await resizeImageFile(file);
      onChange(dataUrl);
    } catch {
      setError("No se pudo procesar la imagen. Prueba con una URL.");
    }
  }

  return (
    <div className="image-picker">
      <button
        type="button"
        className="image-picker-thumb"
        onClick={() => imageUrl && setZoom(true)}
        aria-label={imageUrl ? "Ver imagen más grande" : "Sin imagen"}
      >
        {imageUrl ? (
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
        style={{ display: "none" }}
        onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
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
