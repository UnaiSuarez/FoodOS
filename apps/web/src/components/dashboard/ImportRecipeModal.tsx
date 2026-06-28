"use client";

import { useRef, useState } from "react";
import type { Recipe } from "@foodos/types";
import { useFoodOS } from "@/lib/state";
import { loadAIConfig } from "@/lib/ai-config";
import { importRecipeFromImage, importRecipeFromText } from "@/lib/ai-provider";
import { uid } from "@/lib/utils";
import { Modal } from "./Modal";

type Tab = "text" | "image";

interface Props {
  onClose: () => void;
}

export function ImportRecipeModal({ onClose }: Props) {
  const { mutate, showToast } = useFoodOS();
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<Recipe | null>(null);
  const [imgName, setImgName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const imgDataRef = useRef<{ base64: string; mimeType: string } | null>(null);

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

            {tab === "text" && (
              <div className="import-text-panel">
                <p className="import-hint">
                  Pega el texto de la receta (caption de TikTok, blog, WhatsApp…). La IA extraerá los ingredientes, pasos y macros.
                </p>
                <textarea
                  className="import-textarea"
                  placeholder="Tortilla de atún:\n- 3 huevos\n- 1 lata de atún\n- ½ cebolla…"
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
                  style={{ display: "none" }}
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
