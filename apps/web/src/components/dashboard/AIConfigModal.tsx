"use client";

import { useEffect, useState } from "react";
import {
  type AIConfig,
  type AIProvider,
  loadAIConfig,
  saveAIConfig,
  PROVIDER_KEY_LABEL,
  PROVIDER_KEY_LINK,
  PROVIDER_KEY_LINK_LABEL,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
} from "@/lib/ai-config";
import { testAIConnection } from "@/lib/ai-provider";
import { Modal } from "./Modal";

export function AIConfigModal({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState<AIProvider>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDER_MODELS["gemini"][0].id);
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("http://localhost:11434");
  const [customModel, setCustomModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "error" | null>(null);
  const [testError, setTestError] = useState("");
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    const saved = loadAIConfig();
    if (!saved) return;
    setProvider(saved.provider);
    setApiKey(saved.apiKey);
    setModel(saved.model);
    if (saved.ollamaBaseUrl) setOllamaBaseUrl(saved.ollamaBaseUrl);
    if (saved.model === "custom") setCustomModel(saved.model);
    setConfigured(true);
  }, []);

  function handleProviderChange(p: AIProvider) {
    setProvider(p);
    setModel(PROVIDER_MODELS[p][0].id);
    setTestResult(null);
    setTestError("");
  }

  const resolvedModel = model === "custom" ? customModel : model;
  const canSave = provider === "ollama" ? !!resolvedModel : !!apiKey.trim();

  async function handleTest() {
    if (!canSave) return;
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      await testAIConnection({ provider, apiKey, model: resolvedModel, ollamaBaseUrl });
      setTestResult("ok");
    } catch (err) {
      setTestResult("error");
      setTestError(err instanceof Error ? err.message : "Error de conexión");
    } finally {
      setTesting(false);
    }
  }

  function handleSave() {
    const config: AIConfig = { provider, apiKey, model: resolvedModel, ollamaBaseUrl };
    saveAIConfig(config);
    onClose();
  }

  function handleDelete() {
    saveAIConfig(null);
    onClose();
  }

  return (
    <Modal title="Conectar tu IA personal" onClose={onClose}>
      <p className="ai-privacy-note">
        🔒 Tu clave se guarda <strong>solo en este navegador</strong>. Nunca viaja a ningún servidor —
        la petición va directamente de tu navegador a la API del proveedor.
      </p>

      <div className="provider-tabs">
        {(["gemini", "openai", "anthropic", "ollama"] as AIProvider[]).map((p) => (
          <button
            key={p}
            className={`provider-tab ${provider === p ? "active" : ""}`}
            onClick={() => handleProviderChange(p)}
          >
            {PROVIDER_LABELS[p]}
          </button>
        ))}
      </div>

      {provider !== "ollama" && (
        <label className="form-field">
          {PROVIDER_KEY_LABEL[provider]}
          <div className="key-input-row">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              placeholder="Pega aquí tu API Key"
              autoComplete="off"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? "Ocultar clave" : "Mostrar clave"}
            >
              {showKey ? "◉" : "○"}
            </button>
          </div>
          <a
            href={PROVIDER_KEY_LINK[provider]}
            className="form-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            {PROVIDER_KEY_LINK_LABEL[provider]}
          </a>
        </label>
      )}

      {provider === "ollama" && (
        <label className="form-field">
          URL del servidor Ollama
          <input
            type="text"
            value={ollamaBaseUrl}
            placeholder="http://localhost:11434"
            onChange={(e) => setOllamaBaseUrl(e.target.value)}
          />
          <a
            href={PROVIDER_KEY_LINK.ollama}
            className="form-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            {PROVIDER_KEY_LINK_LABEL.ollama}
          </a>
        </label>
      )}

      <label className="form-field">
        Modelo
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {PROVIDER_MODELS[provider].map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      {model === "custom" && (
        <label className="form-field">
          Nombre del modelo (ej: phi3, llama3.2:8b)
          <input
            type="text"
            value={customModel}
            placeholder="llama3.2"
            onChange={(e) => setCustomModel(e.target.value)}
          />
        </label>
      )}

      <div className="key-test-row">
        <button
          className="secondary-button"
          onClick={() => void handleTest()}
          disabled={testing || !canSave}
        >
          {testing ? "Comprobando…" : "Probar conexión"}
        </button>
        {testResult === "ok" && <span className="success-hint">✓ Conexión correcta</span>}
        {testResult === "error" && <span className="form-error">{testError}</span>}
      </div>

      <div className="recipe-detail-actions">
        {configured && (
          <button className="secondary-button ai-delete-btn" onClick={handleDelete}>
            Borrar config
          </button>
        )}
        <button className="secondary-button" onClick={onClose}>
          Cancelar
        </button>
        <button className="primary-button" disabled={!canSave} onClick={handleSave}>
          Guardar
        </button>
      </div>
    </Modal>
  );
}
