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
export const VIEWS = [
  { id: "dashboard",  icon: "layout-dashboard", label: "Panel",        title: "Panel diario" },
  { id: "diary",      icon: "notebook-pen",     label: "Registro",      title: "Registro diario" },
  { id: "inventory",  icon: "package",          label: "Inventario",    title: "Inventario" },
  { id: "recipes",    icon: "chef-hat",         label: "Recetas",       title: "Recetas" },
  { id: "cart",       icon: "shopping-cart",    label: "Carrito",       title: "Carrito de compra" },
  { id: "finance",    icon: "wallet",           label: "Finanzas",      title: "Finanzas" },
  { id: "stats",      icon: "trending-up",      label: "Estadísticas",  title: "Estadísticas" },
  { id: "nutrition",  icon: "apple",            label: "Nutrición",     title: "Nutrición" },
  { id: "assistant",  icon: "sparkles",         label: "Asistente",     title: "Asistente FoodOS" },
  { id: "planner",    icon: "calendar-days",    label: "Planificador",  title: "Planificador semanal" },
  { id: "ejercicios", icon: "dumbbell",         label: "Ejercicios",    title: "Ejercicios" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"] | "settings";
