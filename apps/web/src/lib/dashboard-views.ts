/**
 * Lista de secciones del dashboard — deliberadamente en un módulo SIN "use
 * client": generateMetadata() de app/dashboard/[[...slug]]/page.tsx corre en
 * el servidor y necesita leer esta lista para poner el título de cada
 * pestaña (E01-08). Importar un array desde un módulo "use client" (como
 * DashboardShell.tsx) no funciona para eso — Next.js convierte cada export
 * de un módulo "use client" en una referencia de cliente opaca en cuanto lo
 * importa código de servidor, así que VIEWS.find(...) fallaba con "Attempted
 * to call find() from the server but find is on the client". Vivir en un
 * módulo plano lo resuelve: tanto el server component (metadata) como
 * DashboardShell.tsx (cliente) pueden importarlo sin problema.
 */
/**
 * "icon" es una CLAVE, no el icono en sí (E03-12): este módulo no puede
 * depender de React/lucide-react porque generateMetadata() lo importa en el
 * servidor solo para leer título/label, y antes usaba directamente un
 * carácter Unicode (⌂ ≣ □ ◌...) como icono — inconsistente entre fuentes del
 * sistema, sin variantes de tamaño/trazo reales. DashboardShell.tsx (donde sí
 * se renderiza) traduce esta clave al componente de lucide-react real.
 */
/**
 * E04-01: las once secciones se mostraban como una lista plana de opciones
 * equivalentes, sin ninguna jerarquía — "group" las agrupa por dominio
 * (criterio de aceptación: dejan de parecer opciones intercambiables).
 * "dashboard" queda fuera de cualquier grupo a propósito: es el punto de
 * entrada, no un miembro más de un dominio. Los grupos y su orden reflejan
 * los tres pilares del producto (inventario+nutrición, finanzas, actividad
 * física — ver docs/DECISIONES_PRODUCTO.md) más el asistente de IA, que al
 * poder actuar sobre inventario y recetas a la vez no encaja dentro de
 * ningún dominio concreto.
 */
export const NAV_GROUPS = [
  { id: "food",      label: "Comida" },
  { id: "finance",   label: "Finanzas" },
  { id: "progress",  label: "Progreso" },
  { id: "assistant", label: "Asistente" },
] as const;

export const VIEWS = [
  { id: "dashboard",  icon: "layout-dashboard", label: "Panel",        title: "Panel diario",         group: null },
  { id: "diary",      icon: "notebook-pen",     label: "Registro",      title: "Registro diario",      group: "food" },
  { id: "inventory",  icon: "package",          label: "Inventario",    title: "Inventario",           group: "food" },
  { id: "recipes",    icon: "chef-hat",         label: "Recetas",       title: "Recetas",              group: "food" },
  { id: "cart",       icon: "shopping-cart",    label: "Carrito",       title: "Carrito de compra",    group: "food" },
  { id: "nutrition",  icon: "apple",            label: "Nutrición",     title: "Nutrición",            group: "food" },
  { id: "finance",    icon: "wallet",           label: "Finanzas",      title: "Finanzas",             group: "finance" },
  { id: "stats",      icon: "trending-up",      label: "Estadísticas",  title: "Estadísticas",         group: "progress" },
  { id: "planner",    icon: "calendar-days",    label: "Planificador",  title: "Planificador semanal", group: "progress" },
  { id: "ejercicios", icon: "dumbbell",         label: "Ejercicios",    title: "Ejercicios",           group: "progress" },
  { id: "assistant",  icon: "sparkles",         label: "Asistente",     title: "Asistente FoodOS",     group: "assistant" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"] | "settings";
