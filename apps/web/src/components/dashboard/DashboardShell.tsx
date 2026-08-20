"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FoodOSProvider, useFoodOS, useFoodOSUI, getMascot } from "@/lib/state";
import { maybeNotifyExpiring } from "@/lib/notifications";
import { hasSupabaseConfig } from "@/lib/supabase";
import { HomeView } from "./views/HomeView";
import { loadAIConfig } from "@/lib/ai-config";
import { todayPlus } from "@/lib/utils";
import { MascotWidget } from "./MascotWidget";
import { ViewErrorBoundary } from "./ViewErrorBoundary";

// Vistas troceadas con next/dynamic: solo HomeView (la vista por defecto) va en
// el bundle inicial; el resto se descarga al navegar a cada sección. Sin esto,
// las 12 vistas (~7000 líneas) cargaban juntas en el primer paint del dashboard.
const viewLoading = () => <p className="loading-hint">Cargando…</p>;
const DiaryView     = dynamic(() => import("./views/DiaryView").then((m) => m.DiaryView),         { ssr: false, loading: viewLoading });
const InventoryView = dynamic(() => import("./views/InventoryView").then((m) => m.InventoryView), { ssr: false, loading: viewLoading });
const RecipesView   = dynamic(() => import("./views/RecipesView").then((m) => m.RecipesView),     { ssr: false, loading: viewLoading });
const CartView      = dynamic(() => import("./views/CartView").then((m) => m.CartView),           { ssr: false, loading: viewLoading });
const FinanceView   = dynamic(() => import("./views/FinanceView").then((m) => m.FinanceView),     { ssr: false, loading: viewLoading });
const StatsView     = dynamic(() => import("./views/StatsView").then((m) => m.StatsView),         { ssr: false, loading: viewLoading });
const NutritionView = dynamic(() => import("./views/NutritionView").then((m) => m.NutritionView), { ssr: false, loading: viewLoading });
const AssistantView = dynamic(() => import("./views/AssistantView").then((m) => m.AssistantView), { ssr: false, loading: viewLoading });
const SettingsView  = dynamic(() => import("./views/SettingsView").then((m) => m.SettingsView),   { ssr: false, loading: viewLoading });
const PlannerView   = dynamic(() => import("./views/PlannerView").then((m) => m.PlannerView),     { ssr: false, loading: viewLoading });
const ExercisesView = dynamic(() => import("./views/ExercisesView").then((m) => m.ExercisesView), { ssr: false, loading: viewLoading });
// Modales y overlays que solo se montan bajo demanda.
const RecipeDetailModal = dynamic(() => import("./RecipeDetailModal").then((m) => m.RecipeDetailModal), { ssr: false });
const AccountModal      = dynamic(() => import("./AccountModal").then((m) => m.AccountModal),           { ssr: false });
const AIConfigModal     = dynamic(() => import("./AIConfigModal").then((m) => m.AIConfigModal),         { ssr: false });
const OnboardingFlow    = dynamic(() => import("./OnboardingFlow").then((m) => m.OnboardingFlow),       { ssr: false });
const AppTour           = dynamic(() => import("./AppTour").then((m) => m.AppTour),                     { ssr: false });

const VIEWS = [
  { id: "dashboard",  icon: "⌂", label: "Panel",        title: "Panel diario" },
  { id: "diary",      icon: "≣", label: "Registro",      title: "Registro diario" },
  { id: "inventory",  icon: "□", label: "Inventario",    title: "Inventario" },
  { id: "recipes",    icon: "◌", label: "Recetas",       title: "Recetas" },
  { id: "cart",       icon: "✓", label: "Carrito",       title: "Carrito de compra" },
  { id: "finance",    icon: "€", label: "Finanzas",      title: "Finanzas" },
  { id: "stats",      icon: "↗", label: "Estadísticas",  title: "Estadísticas" },
  { id: "nutrition",  icon: "%", label: "Nutrición",     title: "Nutrición" },
  { id: "assistant",  icon: "✦", label: "Asistente",     title: "Asistente FoodOS" },
  { id: "planner",    icon: "⊞", label: "Planificador",  title: "Planificador semanal" },
  { id: "ejercicios", icon: "⊙", label: "Ejercicios",    title: "Ejercicios" },
] as const;

// E17-03/04: versión del formato de export/import y clave de la copia de
// seguridad que se guarda automáticamente antes de cada importación.
const EXPORT_FORMAT_VERSION = 1;
const IMPORT_BACKUP_KEY = "foodos-import-backup-v1";

export type ViewId = (typeof VIEWS)[number]["id"] | "settings";

export function DashboardShell() {
  return (
    <FoodOSProvider>
      <DashboardInner />
    </FoodOSProvider>
  );
}

// Consumidores aislados del contexto de UI: así un toast o un cambio de humor
// de la mascota solo re-renderiza estos nodos, no el shell con la vista activa.
function ToastHost() {
  const { toast } = useFoodOSUI();
  return (
    <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">
      {toast?.message}
      {toast?.action && (
        <button type="button" className="toast-action" onClick={toast.action.onAction}>
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

function SidebarMascotMessage() {
  const { mascotMessage } = useFoodOSUI();
  return <p>{mascotMessage}</p>;
}

function DashboardInner() {
  const { state, hydrated, remoteReady, remoteHydrated, authUser, realtimeConnected, seedDemo, resetAll, showToast, mutate } =
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
  // El onboarding NO se decide en el primer render: con Supabase, el perfil aún
  // no ha hidratado, así que un usuario que ya lo tiene lo vería igualmente
  // (bug). Se decide en un efecto, cuando ya sabemos si hay perfil.
  const [showOnboarding, setShowOnboarding] = useState(false);
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

  // Bloquea el scroll de fondo mientras el menú móvil (drawer off-canvas) está
  // abierto — el overlay es position:fixed pero eso no impide por sí solo que
  // un gesto táctil siga haciendo scroll del body debajo. overflow:hidden a
  // secas no basta en iOS Safari (rubber-band scroll) y además resetea el
  // scroll a 0 mientras está activo, así que fijamos el body en su posición
  // actual y restauramos el scroll exacto al cerrar.
  useEffect(() => {
    if (!menuOpen) return;
    const scrollY = window.scrollY;
    const body = document.body.style;
    const prev = { position: body.position, top: body.top, left: body.left, right: body.right, overflow: body.overflow };
    body.position = "fixed";
    body.top = `-${scrollY}px`;
    body.left = "0";
    body.right = "0";
    body.overflow = "hidden";
    return () => {
      body.position = prev.position;
      body.top = prev.top;
      body.left = prev.left;
      body.right = prev.right;
      body.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [menuOpen]);

  // Auth guard: si Supabase está configurado y no hay sesión, volver al landing.
  useEffect(() => {
    if (!needsAuth) return;
    if (remoteReady && !authUser) void router.replace("/");
  }, [needsAuth, remoteReady, authUser, router]);

  // Onboarding: solo se muestra cuando ya sabemos con certeza que el usuario NO
  // tiene perfil. Con Supabase hay que esperar sesión + hidratación remota; si
  // no, un usuario existente en un dispositivo nuevo vería el asistente mientras
  // su perfil llega del servidor. Una vez completado o saltado (foodos-ob-done),
  // no vuelve a salir.
  useEffect(() => {
    if (!hydrated) return;
    if (needsAuth && (!authUser || !remoteHydrated)) return;
    if (localStorage.getItem("foodos-ob-done")) return;
    if (state.profile) return;
    setShowOnboarding(true);
  }, [hydrated, needsAuth, authUser, remoteHydrated, state.profile]);

  // Aviso del sistema de caducidades (si está activado en Ajustes). Se
  // re-evalúa con cada cambio de estado (incluida la hidratación remota, que
  // llega después del primer render); el helper hace early-return barato y
  // limita a un aviso por día, así que re-ejecutarlo a menudo no cuesta nada.
  useEffect(() => {
    if (!hydrated) return;
    void maybeNotifyExpiring(state);
  }, [hydrated, state]);

  const mascot = getMascot(state.mascotId);
  const currentTitle = view === "settings"
    ? "Ajustes de la app"
    : VIEWS.find((entry) => entry.id === view)?.title ?? "Panel diario";

  function exportData() {
    // E17-03: envuelto con versión y fecha — sin esto, una futura migración
    // de esquema no tenía forma de saber si un archivo importado es viejo.
    const payload = {
      exportVersion: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      state,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
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
      const parsed = JSON.parse(await file.text());
      // Acepta el formato con envoltorio (v1+, ver exportData) y también un
      // export "plano" antiguo (el estado directamente en la raíz, sin
      // exportVersion) por compatibilidad con archivos ya exportados.
      const imported =
        parsed && typeof parsed === "object" && "state" in parsed && "exportVersion" in parsed
          ? parsed.state
          : parsed;
      if (typeof imported !== "object" || imported === null || !Array.isArray(imported.inventory)) {
        throw new Error("formato no reconocido");
      }
      // E17-04: copia de seguridad del estado actual ANTES de sobrescribir —
      // sin esto, importar el archivo equivocado (viejo, de otra cuenta...)
      // no tenía vuelta atrás salvo recargar y perder lo que hubiera sin sincronizar.
      try {
        localStorage.setItem(
          IMPORT_BACKUP_KEY,
          JSON.stringify({ backedUpAt: new Date().toISOString(), state })
        );
      } catch {
        // localStorage lleno o no disponible: no bloquea la importación,
        // solo se pierde la posibilidad de deshacer.
      }
      mutate((draft) => Object.assign(draft, imported));
      showToast('Datos importados — si algo no cuadra, usa "Restaurar copia" para deshacer.');
    } catch {
      showToast("El archivo no es un export válido de FoodOS");
    }
  }

  function restoreImportBackup() {
    try {
      const raw = localStorage.getItem(IMPORT_BACKUP_KEY);
      if (!raw) {
        showToast("No hay ninguna copia de seguridad de una importación reciente.");
        return;
      }
      const backup = JSON.parse(raw) as { state: unknown };
      mutate((draft) => Object.assign(draft, backup.state));
      localStorage.removeItem(IMPORT_BACKUP_KEY);
      showToast("Estado anterior a la última importación restaurado.");
    } catch {
      showToast("No se pudo restaurar la copia de seguridad.");
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
            <SidebarMascotMessage />
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
                  <button
                    className="icon-button"
                    onClick={restoreImportBackup}
                    title="Restaurar copia de seguridad de la última importación"
                  >
                    ⟲
                  </button>
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

      <ToastHost />
    </div>
    </>
  );
}
