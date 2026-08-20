"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  LayoutDashboard,
  NotebookPen,
  Package,
  ChefHat,
  ShoppingCart,
  Wallet,
  TrendingUp,
  Apple,
  Sparkles,
  CalendarDays,
  Dumbbell,
  Menu,
  X,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  type LucideIcon,
} from "lucide-react";
import { FoodOSProvider, useFoodOS, useFoodOSUI, getMascot } from "@/lib/state";
import { VIEWS, NAV_GROUPS, type ViewId } from "@/lib/dashboard-views";

// E03-12: traduce la clave plana de VIEWS (lib/dashboard-views.ts no puede
// importar componentes de React, ver el comentario de ese archivo) al icono
// de lucide-react real.
const NAV_ICONS: Record<string, LucideIcon> = {
  "layout-dashboard": LayoutDashboard,
  "notebook-pen": NotebookPen,
  package: Package,
  "chef-hat": ChefHat,
  "shopping-cart": ShoppingCart,
  wallet: Wallet,
  "trending-up": TrendingUp,
  apple: Apple,
  sparkles: Sparkles,
  "calendar-days": CalendarDays,
  dumbbell: Dumbbell,
};
// Re-exportado por compatibilidad: HomeView.tsx y AppTour.tsx ya importaban
// ViewId desde aquí antes de que se moviera VIEWS a lib/dashboard-views.ts.
export type { ViewId };
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

// E17-03/04: versión del formato de export/import y clave de la copia de
// seguridad que se guarda automáticamente antes de cada importación.
const EXPORT_FORMAT_VERSION = 1;
const IMPORT_BACKUP_KEY = "foodos-import-backup-v1";

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

function NavButton({
  entry,
  active,
  onNavigate,
  setMenuOpen,
}: {
  entry: (typeof VIEWS)[number];
  active: boolean;
  onNavigate: (id: ViewId) => void;
  setMenuOpen: (open: boolean) => void;
}) {
  const Icon = NAV_ICONS[entry.icon];
  return (
    <button
      className={`nav-item ${active ? "active" : ""}`}
      onClick={() => { onNavigate(entry.id); setMenuOpen(false); }}
      // E04-02: la sección activa se comunicaba solo por color (clase
      // "active") — invisible para lectores de pantalla y para quien
      // navega por teclado sin ver el resaltado visual.
      aria-current={active ? "page" : undefined}
      // E04-08/E18-04: con el sidebar colapsado la etiqueta se oculta por
      // CSS, así que el nombre accesible del botón dependía solo de texto
      // que deja de estar en el árbol de accesibilidad. aria-label no hace
      // daño expandido (coincide con el texto visible) y es necesario
      // colapsado. title da además una tooltip nativa con el ratón.
      aria-label={entry.label}
      title={entry.label}
    >
      <span><Icon size={16} aria-hidden="true" /></span>
      <span className="nav-item-label">{entry.label}</span>
    </button>
  );
}

function BottomTabButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = NAV_ICONS[icon];
  return (
    <button
      className={`bottom-tab-item ${active ? "active" : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={label}
    >
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function DashboardInner() {
  const { state, hydrated, remoteReady, remoteHydrated, authUser, realtimeConnected, showToast, mutate } =
    useFoodOS();
  const router = useRouter();
  const pathname = usePathname();
  const needsAuth = hasSupabaseConfig();
  const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const isAdmin = authUser ? adminEmails.includes(authUser.email ?? "") : !needsAuth;
  // E01-01/02/03: la vista activa sale de la URL (/dashboard, /dashboard/inventory...),
  // no de un useState — así cada sección tiene una dirección real que puede
  // abrirse directamente, Atrás/Adelante del navegador funcionan solos (los
  // da gratis el historial del navegador) y recargar la página mantiene la
  // misma vista en vez de volver siempre a "Panel". navigateToView()
  // sustituye a la llamada directa a un setView() de estado que había antes.
  const segment = pathname.split("/")[2];
  const view: ViewId =
    segment === "settings" || VIEWS.some((entry) => entry.id === segment) ? (segment as ViewId) : "dashboard";
  function navigateToView(id: ViewId) {
    router.push(id === "dashboard" ? "/dashboard" : `/dashboard/${id}`);
  }
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
  // E04-08: colapsar el sidebar a solo iconos en escritorio. Arranca en
  // false (coincide con lo que renderiza el servidor, que no tiene acceso a
  // localStorage) y se corrige en un efecto tras montar — un initializer
  // perezoso que lee localStorage directamente produce un mismatch de
  // hidratación entre servidor y cliente para esta página (se sirve con
  // SSR). El coste es un parpadeo breve si el usuario lo tenía colapsado;
  // aceptable frente a pelear la hidratación por una preferencia de UI.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    setSidebarCollapsed(localStorage.getItem("foodos-sidebar-collapsed") === "1");
  }, []);
  // Escribe junto al propio toggle (no en un efecto aparte con
  // [sidebarCollapsed] como dependencia): ese efecto se dispara también en
  // el montaje, en la misma pasada que el de arriba, y con batching de
  // estado podía "ganar la carrera" y sobrescribir la lectura inicial con
  // el valor por defecto (false) antes de que se aplicara la corrección.
  function toggleSidebarCollapsed() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("foodos-sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  }
  const [isOnline, setIsOnline] = useState(true);
  // E02-03/04/08: sin esto, una comprobación de sesión colgada (proyecto de
  // Supabase pausado, sin red al cargar...) dejaba al usuario mirando
  // "Comprobando sesión…" para siempre, sin ninguna salida.
  const AUTH_CHECK_TIMEOUT_MS = 10_000;
  const [authCheckTimedOut, setAuthCheckTimedOut] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("foodos-theme") as "dark" | "light" | null;
    if (stored === "light") setTheme("light");
  }, []);

  useEffect(() => {
    if (!needsAuth || remoteReady) {
      setAuthCheckTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setAuthCheckTimedOut(true), AUTH_CHECK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [needsAuth, remoteReady]);

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

  // Pantalla de carga mientras Supabase comprueba la sesión — E02-01: una
  // silueta del shell real en vez de un "Comprobando sesión…" en texto
  // plano, para que el salto al terminar sea menor.
  if (needsAuth && !remoteReady) {
    if (authCheckTimedOut) {
      return (
        <div className="auth-checking" role="alert">
          <p className="eyebrow">FoodOS</p>
          <p>La comprobación de tu sesión está tardando más de lo normal.</p>
          <p className="form-intro">
            Puede ser un problema de conexión o que el servicio no responda ahora mismo.
          </p>
          <div className="auth-checking-actions">
            <button className="primary-button" onClick={() => window.location.reload()}>
              Reintentar
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="auth-skeleton" aria-busy="true" aria-live="polite">
        <span className="sr-only">Comprobando tu sesión…</span>
        <div className="auth-skeleton-sidebar">
          <div className="auth-skeleton-block" style={{ height: 32, width: "60%", marginBottom: 28 }} />
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="auth-skeleton-block" style={{ height: 20, marginBottom: 14 }} />
          ))}
        </div>
        <div className="auth-skeleton-main">
          <div className="auth-skeleton-topbar">
            <div className="auth-skeleton-block" style={{ height: 22, width: 160 }} />
          </div>
          <div className="auth-skeleton-body">
            <div className="auth-skeleton-block" style={{ height: 120 }} />
            <div className="auth-skeleton-block" style={{ height: 200 }} />
            <div className="auth-skeleton-block" style={{ height: 160 }} />
          </div>
        </div>
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
    <div className={`app-shell ${menuOpen ? "menu-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {/* Overlay para cerrar el menú en móvil */}
      <div className="menu-overlay" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <button
            className="brand"
            onClick={() => { navigateToView("dashboard"); setMenuOpen(false); }}
            aria-label="Ir al panel principal"
          >
            <span className="brand-food">Food</span>
            <span className="brand-suffix">OS</span>
          </button>
          {/* E04-08: colapsar a solo iconos en escritorio — en móvil el
              sidebar ya es un drawer off-canvas, así que este botón se
              oculta por CSS bajo el breakpoint de 1080px. */}
          <button
            className="sidebar-collapse-btn"
            onClick={toggleSidebarCollapsed}
            aria-label={sidebarCollapsed ? "Expandir menú lateral" : "Colapsar menú lateral"}
            title={sidebarCollapsed ? "Expandir menú" : "Colapsar menú"}
          >
            {sidebarCollapsed ? <ChevronsRight size={16} aria-hidden="true" /> : <ChevronsLeft size={16} aria-hidden="true" />}
          </button>
        </div>
        <nav className="app-nav" aria-label="Navegación de la app">
          {/* E04-01: "dashboard" es el punto de entrada, fuera de cualquier
              grupo. El resto se agrupa por dominio (NAV_GROUPS) en vez de
              aparecer como once opciones equivalentes. */}
          {VIEWS.filter((entry) => entry.group === null).map((entry) => (
            <NavButton key={entry.id} entry={entry} active={view === entry.id} onNavigate={navigateToView} setMenuOpen={setMenuOpen} />
          ))}
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.id}>
              <span className="nav-group-label">{group.label}</span>
              {VIEWS.filter((entry) => entry.group === group.id).map((entry) => (
                <NavButton key={entry.id} entry={entry} active={view === entry.id} onNavigate={navigateToView} setMenuOpen={setMenuOpen} />
              ))}
            </div>
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
          onClick={() => { navigateToView("settings"); setMenuOpen(false); }}
          title="Ir a Ajustes"
          aria-label="Ir a Ajustes"
          aria-current={view === "settings" ? "page" : undefined}
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
          <span className="sidebar-user-caret" aria-hidden="true"><ChevronRight size={16} /></span>
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
              {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
            </button>
          </div>
          <h1>{currentTitle}</h1>
        </header>

        {hydrated ? (
          <ViewErrorBoundary key={view}>
            {view === "dashboard" && <HomeView goTo={navigateToView} openRecipe={setOpenRecipeId} />}
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
                onExportData={exportData}
                onImportData={importData}
                onRestoreImportBackup={restoreImportBackup}
              />
            )}
          </ViewErrorBoundary>
        ) : (
          <p className="loading-hint">Cargando tus datos…</p>
        )}
      </main>

      {/* E04-03/09: barra inferior para uso con una mano en móvil (oculta
          por CSS en pantallas más anchas). 5 accesos directos con el pulgar
          en vez de depender siempre del drawer; "Más" abre el propio drawer
          off-canvas ya existente, que ya cubre el resto de secciones y
          Ajustes — no duplica esa navegación en un componente aparte. */}
      <nav className="bottom-tab-bar" aria-label="Navegación rápida">
        <BottomTabButton icon="layout-dashboard" label="Hoy" active={view === "dashboard"} onClick={() => navigateToView("dashboard")} />
        <BottomTabButton icon="notebook-pen" label="Diario" active={view === "diary"} onClick={() => navigateToView("diary")} />
        <BottomTabButton icon="package" label="Inventario" active={view === "inventory"} onClick={() => navigateToView("inventory")} />
        <BottomTabButton icon="calendar-days" label="Plan" active={view === "planner"} onClick={() => navigateToView("planner")} />
        <button
          className="bottom-tab-item"
          onClick={() => setMenuOpen(true)}
          aria-label="Más opciones"
          aria-expanded={menuOpen}
        >
          <Menu size={20} aria-hidden="true" />
          <span>Más</span>
        </button>
      </nav>

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
        <AppTour setView={navigateToView} onDone={() => setTourActive(false)} />
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
