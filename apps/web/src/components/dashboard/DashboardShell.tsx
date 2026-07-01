"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FoodOSProvider, useFoodOS, getMascot } from "@/lib/state";
import { hasSupabaseConfig } from "@/lib/supabase";
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
import { ExercisesView } from "./views/ExercisesView";
import { RecipeDetailModal } from "./RecipeDetailModal";
import { AccountModal } from "./AccountModal";
import { AIConfigModal } from "./AIConfigModal";
import { loadAIConfig } from "@/lib/ai-config";
import { todayPlus } from "@/lib/utils";
import { OnboardingFlow } from "./OnboardingFlow";
import { AppTour } from "./AppTour";
import { MascotWidget } from "./MascotWidget";
import { StatsView } from "./views/StatsView";
import { ViewErrorBoundary } from "./ViewErrorBoundary";

const VIEWS = [
  { id: "dashboard",  icon: "⌂", label: "Panel",        title: "Panel diario" },
  { id: "diary",      icon: "≣", label: "Registro",      title: "Registro diario" },
  { id: "inventory",  icon: "□", label: "Inventario",    title: "Inventario" },
  { id: "recipes",    icon: "◌", label: "Recetas",       title: "Recetas" },
  { id: "feed",       icon: "▶", label: "Feed",          title: "Feed social" },
  { id: "cart",       icon: "✓", label: "Carrito",       title: "Carrito de compra" },
  { id: "finance",    icon: "€", label: "Finanzas",      title: "Finanzas" },
  { id: "stats",      icon: "↗", label: "Estadísticas",  title: "Estadísticas" },
  { id: "nutrition",  icon: "%", label: "Nutrición",     title: "Nutrición" },
  { id: "assistant",  icon: "✦", label: "Asistente",     title: "Asistente FoodOS" },
  { id: "planner",    icon: "⊞", label: "Planificador",  title: "Planificador semanal" },
  { id: "ejercicios", icon: "⊙", label: "Ejercicios",    title: "Ejercicios" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"] | "settings";

export function DashboardShell() {
  return (
    <FoodOSProvider>
      <DashboardInner />
    </FoodOSProvider>
  );
}

function DashboardInner() {
  const { state, hydrated, toast, mascotMessage, remoteReady, authUser, realtimeConnected, seedDemo, resetAll, showToast, mutate } =
    useFoodOS();
  const router = useRouter();
  const needsAuth = hasSupabaseConfig();
  const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const isAdmin = authUser ? adminEmails.includes(authUser.email ?? "") : !needsAuth;
  const [view, setView] = useState<ViewId>("dashboard");
  const [openRecipeId, setOpenRecipeId] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(() => loadAIConfig() !== null);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    if (typeof window === "undefined") return false;
    return !localStorage.getItem("foodos-ob-done") && !state.profile;
  });
  const [tourActive, setTourActive] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [menuOpen, setMenuOpen] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("foodos-theme") as "dark" | "light" | null;
    if (stored === "light") setTheme("light");
  }, []);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const up   = () => setIsOnline(true);
    const down = () => setIsOnline(false);
    window.addEventListener("online",  up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("foodos-theme", theme);
  }, [theme]);

  // Auth guard: si Supabase está configurado y no hay sesión, volver al landing.
  useEffect(() => {
    if (!needsAuth) return;
    if (remoteReady && !authUser) void router.replace("/");
  }, [needsAuth, remoteReady, authUser, router]);

  const mascot = getMascot(state.mascotId);
  const currentTitle = view === "settings"
    ? "Ajustes de la app"
    : VIEWS.find((entry) => entry.id === view)?.title ?? "Panel diario";

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `foodos-datos-${todayPlus(0)}.json`;
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
    if (!localStorage.getItem("foodos-tour-done")) {
      setTourActive(true);
    }
  }

  function startTour() {
    setTourActive(true);
  }

  // Pantalla de carga mientras Supabase comprueba la sesión
  if (needsAuth && !remoteReady) {
    return (
      <div className="auth-checking">
        <p className="eyebrow">FoodOS</p>
        <p>Comprobando sesión…</p>
      </div>
    );
  }

  // Supabase listo pero sin sesión — la redirección está en vuelo
  if (needsAuth && remoteReady && !authUser) return null;

  return (
    <>
    {hydrated && showOnboarding && (
      <OnboardingFlow onDone={handleOnboardingDone} />
    )}
    <div className={`app-shell ${menuOpen ? "menu-open" : ""}`}>
      {/* Overlay para cerrar el menú en móvil */}
      <div className="menu-overlay" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => { setView("dashboard"); setMenuOpen(false); }}
          aria-label="Ir al panel principal"
        >
          <span>Food</span>OS
        </button>
        <nav className="app-nav" aria-label="Navegación de la app">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              className={`nav-item ${view === entry.id ? "active" : ""}`}
              onClick={() => { setView(entry.id); setMenuOpen(false); }}
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
        <button
          className="sidebar-user"
          onClick={() => { setView("settings"); setMenuOpen(false); }}
          title="Ir a Ajustes"
        >
          <div className="sidebar-avatar">
            {authUser?.email?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div className="sidebar-user-info">
            <span className="sidebar-user-email">
              {authUser?.email ?? "Sin sesión"}
            </span>
            <span className="sidebar-user-action">Ajustes</span>
          </div>
          <span className="sidebar-user-caret" aria-hidden="true">→</span>
        </button>
      </aside>

      <main className="app-main">
        <header className="topbar">
          <div className="topbar-controls">
            <button
              className="hamburger-btn"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={menuOpen ? "Cerrar menú" : "Abrir menú"}
              aria-expanded={menuOpen}
            >
              {menuOpen ? "✕" : "☰"}
            </button>
            <div className="top-actions">
              {isAdmin && (
                <>
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
                </>
              )}
            </div>
          </div>
          <h1>{currentTitle}</h1>
        </header>

        {hydrated ? (
          <ViewErrorBoundary key={view}>
            {view === "dashboard" && <HomeView goTo={setView} openRecipe={setOpenRecipeId} />}
            {view === "diary" && <DiaryView />}
            {view === "inventory" && <InventoryView />}
            {view === "recipes" && <RecipesView openRecipe={setOpenRecipeId} />}
            {view === "feed" && <FeedView openRecipe={setOpenRecipeId} />}
            {view === "cart" && <CartView />}
            {view === "finance" && <FinanceView />}
            {view === "stats" && <StatsView />}
            {view === "nutrition" && <NutritionView />}
            {view === "assistant" && <AssistantView />}
            {view === "planner"    && <PlannerView />}
            {view === "ejercicios" && <ExercisesView />}
            {view === "settings"  && (
              <SettingsView
                isAdmin={isAdmin}
                theme={theme}
                onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                onOpenAI={() => setAiConfigOpen(true)}
                aiConfigured={aiConfigured}
                onShowOnboarding={() => setShowOnboarding(true)}
                onStartTour={startTour}
              />
            )}
          </ViewErrorBoundary>
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

      {tourActive && !showOnboarding && (
        <AppTour setView={setView} onDone={() => setTourActive(false)} />
      )}

      <MascotWidget />

      {!isOnline && (
        <div className="offline-banner" role="status" aria-live="polite">
          Sin conexión — mostrando datos guardados
        </div>
      )}

      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </div>
    </>
  );
}
