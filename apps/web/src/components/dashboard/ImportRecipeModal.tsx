"use client";

import { useRef, useState } from "react";
import type { Recipe } from "@foodos/types";
import { useFoodOS } from "@/lib/state";
import { loadAIConfig } from "@/lib/ai-config";
import { importRecipeFromImage, importRecipeFromText } from "@/lib/ai-provider";
import { uid } from "@/lib/utils";
import { Modal } from "./Modal";

type Tab = "url" | "text" | "image";

interface Props {
  onClose: () => void;
}

export function ImportRecipeModal({ onClose }: Props) {
  const { mutate, showToast } = useFoodOS();
  const [tab, setTab] = useState<Tab>("url");
  const [url, setUrl] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<Recipe | null>(null);
  const [imgName, setImgName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const imgDataRef = useRef<{ base64: string; mimeType: string } | null>(null);

  async function handleUrlImport() {
    const trimmed = url.trim();
    if (!trimmed) return;
    const config = loadAIConfig();
    if (!config) { showToast("Configura la IA en Ajustes para importar recetas"); return; }
    setUrlLoading(true);
    try {
      const res = await fetch(`/api/recipe-fetch?url=${encodeURIComponent(trimmed)}`);
      const data = (await res.json()) as { text?: string; jsonLd?: string | null; title?: string | null; error?: string };
      if (!res.ok || data.error) {
        showToast(data.error ?? "No se pudo descargar esa página");
        return;
      }
      // El JSON-LD (schema.org Recipe), si existe, es una señal mucho más limpia
      // que el texto visible de la página — se pone primero para que la IA lo
      // priorice, pero se manda también el texto por si la página no lo tiene.
      const combined = [
        data.title ? `Título de la página: ${data.title}` : null,
        data.jsonLd ? `Datos estructurados (schema.org Recipe):\n${data.jsonLd}` : null,
        data.text ? `Texto de la página:\n${data.text}` : null,
      ].filter(Boolean).join("\n\n");

      const recipe = await importRecipeFromText(config, combined);
      setPreview({ ...recipe, id: uid() });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Error al importar desde la URL");
    } finally {
      setUrlLoading(false);
    }
  }

  async function handleTextImport() {
    if (!text.trim()) return;
    const config = loadAIConfig();
    if (!config) { showToast("Configura la IA en Ajustes para importar recetas"); return; }
    setLoading(true);
    try {
      const recipe = await importRecipeFromText(config, text.trim());
      setPreview({ ...recipe, id: uid() });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Error al analizar el texto");
    } finally {
      setLoading(false);
    }
  }

  async function handleImageImport() {
    if (!imgDataRef.current) return;
    const config = loadAIConfig();
    if (!config) { showToast("Configura la IA en Ajustes para importar recetas"); return; }
    setLoading(true);
    try {
      const { base64, mimeType } = imgDataRef.current;
      const recipe = await importRecipeFromImage(config, base64, mimeType);
      setPreview({ ...recipe, id: uid() });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Error al analizar la imagen");
    } finally {
      setLoading(false);
    }
  }

  function handleFile(file: File) {
    if (!file.type.startsWith("image/")) { showToast("Selecciona una imagen (JPG, PNG, WebP)"); return; }
    setImgName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      imgDataRef.current = { base64, mimeType: file.type };
    };
    reader.readAsDataURL(file);
  }

  function saveRecipe() {
    if (!preview) return;
    mutate((draft) => {
      draft.customRecipes.push(preview);
    });
    showToast(`"${preview.title}" guardada en tus recetas`);
    onClose();
  }

  return (
    <Modal title="Importar receta" onClose={onClose}>
      <div className="import-recipe-body">
        {!preview ? (
          <>
            <div className="import-tabs">
              <button
                className={`import-tab ${tab === "url" ? "active" : ""}`}
                onClick={() => setTab("url")}
              >
                Desde URL
              </button>
              <button
                className={`import-tab ${tab === "text" ? "active" : ""}`}
                onClick={() => setTab("text")}
              >
                Pegar texto
              </button>
              <button
                className={`import-tab ${tab === "image" ? "active" : ""}`}
                onClick={() => setTab("image")}
              >
                Subir imagen
              </button>
            </div>

            {tab === "url" && (
              <div className="import-text-panel">
                <p className="import-hint">
                  Pega el enlace de una receta de cualquier blog o web. FoodOS descarga la página y
                  la IA extrae ingredientes, pasos y macros — igual que el importador de MyFitnessPal,
                  pero sin depender de que tú copies el texto a mano.
                </p>
                <input
                  className="lm-search"
                  type="url"
                  placeholder="https://ejemplo.com/mi-receta-favorita"
                  aria-label="URL de la receta"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <button
                  className="primary-button"
                  disabled={!url.trim() || urlLoading}
                  onClick={handleUrlImport}
                >
                  {urlLoading ? "Descargando y analizando…" : "✦ Importar desde la URL"}
                </button>
              </div>
            )}

            {tab === "text" && (
              <div className="import-text-panel">
                <p className="import-hint">
                  Pega el texto de la receta (caption de TikTok, blog, WhatsApp…). La IA extraerá los ingredientes, pasos y macros.
                </p>
                <textarea
                  className="import-textarea"
                  placeholder="Tortilla de atún:\n- 3 huevos\n- 1 lata de atún\n- ½ cebolla…"
                  aria-label="Texto de la receta"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                />
                <button
                  className="primary-button"
                  disabled={!text.trim() || loading}
                  onClick={handleTextImport}
                >
                  {loading ? "Analizando…" : "✦ Extraer receta con IA"}
                </button>
              </div>
            )}

            {tab === "image" && (
              <div className="import-image-panel">
                <p className="import-hint">
                  Sube una captura de pantalla de TikTok, Instagram, un blog o cualquier imagen con una receta. La IA extraerá los datos automáticamente.
                </p>
                <div
                  className="import-drop-zone"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    if (f) handleFile(f);
                  }}
                >
                  {imgName ? (
                    <span className="import-file-name">📷 {imgName}</span>
                  ) : (
                    <span className="import-drop-hint">
                      Arrastra una imagen aquí o haz clic para seleccionar
                    </span>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden-file-input"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                />
                <button
                  className="primary-button"
                  disabled={!imgDataRef.current || loading}
                  onClick={handleImageImport}
                >
                  {loading ? "Analizando imagen…" : "✦ Extraer receta con IA"}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="import-preview">
            <h3 className="import-preview-title">{preview.title}</h3>
            <div className="import-preview-macros">
              <span><b>{preview.kcal}</b> kcal</span>
              <span><b>{preview.protein}g</b> prot</span>
              <span><b>{preview.carbs}g</b> carb</span>
              <span><b>{preview.fat}g</b> grasa</span>
              <span><b>{preview.time}min</b></span>
            </div>
            <div className="import-preview-section">
              <p className="import-preview-label">Ingredientes</p>
              <ul className="import-preview-list">
                {preview.ingredients.map((ing, i) => (
                  <li key={i}>{ing.quantity} {ing.unit} — {ing.name}</li>
                ))}
              </ul>
            </div>
            {preview.steps.length > 0 && (
              <div className="import-preview-section">
                <p className="import-preview-label">Pasos</p>
                <ol className="import-preview-list">
                  {preview.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              </div>
            )}
            <div className="import-preview-actions">
              <button className="secondary-button" onClick={() => setPreview(null)}>
                ← Volver
              </button>
              <button className="primary-button" onClick={saveRecipe}>
                Guardar receta
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
