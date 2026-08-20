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
export const VIEWS = [
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

export type ViewId = (typeof VIEWS)[number]["id"] | "settings";
