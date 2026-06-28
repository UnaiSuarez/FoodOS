"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { FoodOSProvider, useFoodOS, getMascot } from "@/lib/state";
import { HomeView } from "./views/HomeView";
import { DiaryView } from "./views/DiaryView";
import { InventoryView } from "./views/InventoryView";
import { RecipesView } from "./views/RecipesView";
import { FeedView } from "./views/FeedView";
import { CartView } from "./views/CartView";
import { FinanceView } from "./views/FinanceView";
import { NutritionView } from "./views/NutritionView";
import { AssistantView } from "./views/AssistantView";
import { SettingsView } from "./views/SettingsView";
import { PlannerView } from "./views/PlannerView";
import { RecipeDetailModal } from "./RecipeDetailModal";
import { AccountModal } from "./AccountModal";
import { AIConfigModal } from "./AIConfigModal";
import { loadAIConfig } from "@/lib/ai-config";
import { OnboardingFlow } from "./OnboardingFlow";
import { MascotWidget } from "./MascotWidget";

const VIEWS = [
  { id: "dashboard", icon: "⌂", label: "Panel", title: "Panel diario" },
  { id: "diary", icon: "≣", label: "Registro", title: "Registro diario" },
  { id: "inventory", icon: "□", label: "Inventario", title: "Inventario" },
  { id: "recipes", icon: "◌", label: "Recetas", title: "Recetas" },
  { id: "feed", icon: "▶", label: "Feed", title: "Feed social" },
  { id: "cart", icon: "✓", label: "Carrito", title: "Carrito de compra" },
  { id: "finance", icon: "€", label: "Finanzas", title: "Finanzas" },
  { id: "nutrition", icon: "%", label: "Nutrición", title: "Nutrición" },
  { id: "assistant", icon: "✦", label: "Asistente", title: "Asistente FoodOS" },
  { id: "planner",   icon: "⊞", label: "Planificador", title: "Planificador semanal" },
  { id: "settings",  icon: "⚙", label: "Ajustes",   title: "Ajustes de la app" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];

export function DashboardShell() {
  return (
    <FoodOSProvider>
      <DashboardInner />
    </FoodOSProvider>
  );
}

function DashboardInner() {
  const { state, hydrated, toast, mascotMessage, remoteReady, authUser, seedDemo, resetAll, showToast, mutate } =
    useFoodOS();
  const [view, setView] = useState<ViewId>("dashboard");
  const [openRecipeId, setOpenRecipeId] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(() => loadAIConfig() !== null);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    if (typeof window === "undefined") return false;
    return !localStorage.getItem("foodos-ob-done") && !state.profile;
  });

  const mascot = getMascot(state.mascotId);
  const currentTitle = VIEWS.find((entry) => entry.id === view)?.title ?? "Panel diario";

  const dataModeText = authUser
    ? `Conectado a Supabase · ${authUser.email ?? "sesión activa"}`
    : remoteReady
      ? "Supabase configurado · inicia sesión para sincronizar"
      : "Datos locales · Supabase sin conectar";

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `foodos-datos-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast("Datos exportados a JSON");
  }

  async function importData(file: File | undefined) {
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (typeof imported !== "object" || imported === null || !Array.isArray(imported.inventory)) {
        throw new Error("formato no reconocido");
      }
      mutate((draft) => Object.assign(draft, imported));
      showToast("Datos importados");
    } catch {
      showToast("El archivo no es un export válido de FoodOS");
    }
  }

  function handleOnboardingDone() {
    localStorage.setItem("foodos-ob-done", "1");
    setShowOnboarding(false);
  }

  return (
    <>
    {hydrated && showOnboarding && (
      <OnboardingFlow onDone={handleOnboardingDone} />
    )}
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Volver a la portada">
          <span>Food</span>OS
        </Link>
        <nav className="app-nav" aria-label="Navegación de la app">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              className={`nav-item ${view === entry.id ? "active" : ""}`}
              onClick={() => setView(entry.id)}
            >
              <span>{entry.icon}</span>
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="mascot-panel">
          <div className="mascot-avatar">
            <Image src={mascot.image} alt={`${mascot.name}, tu compañero`} width={54} height={60} />
          </div>
          <div>
            <strong>{mascot.name}</strong>
            <p>{mascotMessage}</p>
          </div>
        </div>
        <Link className="back-link" href="/">
          &larr; Volver a la portada
        </Link>
      </aside>

      <main className="app-main">
        <header className="topbar">
          <div>
            <p className="eyebrow">{dataModeText}</p>
            <h1>{currentTitle}</h1>
          </div>
          <div className="top-actions">
            <button
              className={`secondary-button ai-btn ${aiConfigured ? "configured" : ""}`}
              onClick={() => setAiConfigOpen(true)}
              title={aiConfigured ? "IA personal configurada" : "Conectar IA personal (gratis para ti)"}
            >
              ✦ IA
              {aiConfigured && <span className="ai-dot" aria-hidden="true" />}
            </button>
            <button className="secondary-button" onClick={() => setAccountOpen(true)} title="Cuenta FoodOS">
              Cuenta
            </button>
            <button className="icon-button" onClick={exportData} title="Exportar datos a JSON">
              ⇩
            </button>
            <label className="icon-button file-button" title="Importar datos desde JSON">
              ⇧
              <input
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => {
                  void importData(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
            <button className="icon-button" onClick={seedDemo} title="Cargar datos demo">
              ↻
            </button>
            <button
              className="icon-button danger"
              title="Borrar datos locales"
              onClick={() => {
                if (confirm("¿Borrar todos los datos locales de FoodOS?")) resetAll();
              }}
            >
              ×
            </button>
          </div>
        </header>

        {hydrated ? (
          <>
            {view === "dashboard" && <HomeView goTo={setView} openRecipe={setOpenRecipeId} />}
            {view === "diary" && <DiaryView />}
            {view === "inventory" && <InventoryView />}
            {view === "recipes" && <RecipesView openRecipe={setOpenRecipeId} />}
            {view === "feed" && <FeedView openRecipe={setOpenRecipeId} />}
            {view === "cart" && <CartView />}
            {view === "finance" && <FinanceView />}
            {view === "nutrition" && <NutritionView />}
            {view === "assistant" && <AssistantView />}
            {view === "planner"   && <PlannerView />}
            {view === "settings"  && <SettingsView onShowOnboarding={() => setShowOnboarding(true)} />}
          </>
        ) : (
          <p className="loading-hint">Cargando tus datos…</p>
        )}
      </main>

      {openRecipeId && <RecipeDetailModal recipeId={openRecipeId} onClose={() => setOpenRecipeId(null)} />}
      {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} />}
      {aiConfigOpen && (
        <AIConfigModal
          onClose={() => {
            setAiConfigOpen(false);
            setAiConfigured(loadAIConfig() !== null);
          }}
        />
      )}

      <MascotWidget />

      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </div>
    </>
  );
}
