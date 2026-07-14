"use client";

import { useEffect, useRef, useState } from "react";
import { parseQuantityString } from "@/lib/food-lookup";

export interface ProductData {
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  salt?: number;
  fiber?: number;
  sugars?: number;
  /** Tamaño del envase en g/ml (campo product_quantity de OFF), si está disponible. */
  packageSize?: number;
  /** Marca del producto (campo brands de OFF), si está disponible. */
  brand?: string;
  /** URL de la foto del producto — solo se enlaza, no se descarga ni se aloja. */
  imageUrl?: string;
  /** Tags de alérgenos sin traducir (ej. "en:gluten"), de OFF. */
  allergenTags?: string[];
}

interface Props {
  onFill: (data: ProductData) => void;
  onClose: () => void;
}

// BarcodeDetector es una API del navegador (Chrome/Edge 83+) que no está en los tipos de TS.
declare class BarcodeDetector {
  constructor(options: { formats: string[] });
  detect(source: HTMLVideoElement | HTMLCanvasElement): Promise<Array<{ rawValue: string }>>;
  static getSupportedFormats(): Promise<string[]>;
}

export function BarcodeScannerModal({ onFill, onClose }: Props) {
  const [barcode, setBarcode] = useState("");
  const [loading, setLoading] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanningRef = useRef(false);

  // No arranca sola al montar: getUserMedia() en móvil (sobre todo iOS Safari)
  // exige gesto de usuario directo y síncrono. Llamarla desde un efecto tras
  // el render pierde a veces ese contexto y falla en silencio — de ahí el
  // patrón "a veces no se abre / se abre a la segunda vez" (el segundo intento
  // funciona porque el tap en "Activar cámara" SÍ es un gesto directo). Por
  // eso el usuario siempre arranca la cámara con un tap explícito.
  useEffect(() => {
    return () => stopCamera();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCamera() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
      if (typeof BarcodeDetector !== "undefined") {
        scanningRef.current = true;
        startDetecting();
      } else {
        setInfo("BarcodeDetector no disponible en este navegador. Introduce el código manualmente.");
      }
    } catch {
      setError("No se pudo acceder a la cámara. Introduce el código manualmente.");
    }
  }

  function stopCamera() {
    scanningRef.current = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraActive(false);
  }

  async function startDetecting() {
    const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
    const scan = async () => {
      if (!scanningRef.current || !videoRef.current) return;
      try {
        const results = await detector.detect(videoRef.current);
        if (results.length > 0) {
          const code = results[0].rawValue;
          setBarcode(code);
          stopCamera();
          await fetchProduct(code);
          return;
        }
      } catch {
        // frame no procesable, continuamos
      }
      requestAnimationFrame(scan);
    };
    requestAnimationFrame(scan);
  }

  async function fetchProduct(code: string) {
    if (!code.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code.trim())}.json`
      );
      if (!res.ok) throw new Error("red");
      const json = await res.json();
      if (json.status !== 1 || !json.product) {
        setError("Producto no encontrado en Open Food Facts. Completa los datos manualmente.");
        setLoading(false);
        return;
      }
      const p = json.product;
      const n = p.nutriments ?? {};
      const numericQty = Number(p.product_quantity);
      const packageSize = Number.isFinite(numericQty) && numericQty > 0
        ? Math.round(numericQty)
        : parseQuantityString(p.quantity);
      const rawBrand = Array.isArray(p.brands) ? p.brands[0] : typeof p.brands === "string" ? p.brands.split(",")[0] : "";
      const brand = rawBrand?.trim() ?? "";
      const imageUrl = p.image_front_url || p.image_small_url || "";
      onFill({
        name: (p.product_name_es || p.product_name || code).slice(0, 80),
        kcal: Math.round(n["energy-kcal_100g"] ?? (n["energy_100g"] != null ? n["energy_100g"] / 4.184 : 0)),
        protein: Math.round((n.proteins_100g ?? 0) * 10) / 10,
        carbs: Math.round((n.carbohydrates_100g ?? 0) * 10) / 10,
        fat: Math.round((n.fat_100g ?? 0) * 10) / 10,
        ...(n.salt_100g != null && { salt: Math.round(n.salt_100g * 100) / 100 }),
        ...(n.fiber_100g != null && { fiber: Math.round(n.fiber_100g * 10) / 10 }),
        ...(n.sugars_100g != null && { sugars: Math.round(n.sugars_100g * 10) / 10 }),
        ...(packageSize != null && { packageSize }),
        ...(brand && { brand }),
        ...(imageUrl && { imageUrl }),
        ...(Array.isArray(p.allergens_tags) && p.allergens_tags.length > 0 && { allergenTags: p.allergens_tags }),
      });
    } catch {
      setError("Error de red. Comprueba tu conexión o introduce el código manualmente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card barcode-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Escanear código de barras</h2>
          <button className="icon-button" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </div>

        {cameraActive ? (
          <div className="barcode-viewfinder">
            <video ref={videoRef} className="barcode-video" muted playsInline />
            <div className="barcode-crosshair" aria-hidden="true" />
            <button className="secondary-button" onClick={stopCamera}>
              Detener cámara
            </button>
          </div>
        ) : (
          <button className="primary-button" onClick={startCamera}>
            📷 Activar cámara
          </button>
        )}

        <div className="barcode-manual">
          <p className="eyebrow">O introduce el código manualmente</p>
          <div className="barcode-input-row">
            <input
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Ej: 8410188052028"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void fetchProduct(barcode)}
            />
            <button
              className="secondary-button"
              onClick={() => void fetchProduct(barcode)}
              disabled={!barcode.trim() || loading}
            >
              {loading ? "Buscando…" : "Buscar"}
            </button>
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}
        {info && <p className="form-hint">{info}</p>}
        <p className="form-hint">
          Datos de <strong>Open Food Facts</strong> (EAN-13/8, UPC-A). Cámara: Chrome/Edge/Android.
        </p>
      </div>
    </div>
  );
}
