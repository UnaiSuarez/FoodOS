import type { Metadata } from "next";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { VIEWS } from "@/lib/dashboard-views";
import "../dashboard.css";

/**
 * E01-01/02/03: ruta "catch-all" opcional — /dashboard, /dashboard/inventory,
 * /dashboard/recipes... resuelven todas aquí, y DashboardShell decide qué
 * vista pintar leyendo la URL (ver DashboardShell.tsx). Una sola página en
 * vez de 12 carpetas de rutas es la entrega mínima que ya cumple los tres
 * criterios P0: cada sección tiene URL propia, Atrás/Adelante funcionan
 * (gratis, del historial del navegador) y recargar mantiene la vista.
 *
 * Dividir en rutas individuales por carpeta (una por vista, con sus propias
 * rutas anidadas para detalle de receta/producto — E01-04/05/06) queda para
 * una entrega posterior: es un cambio más grande, y esta base ya es
 * suficiente para probarla en producción antes de ampliarla.
 */
export async function generateMetadata({
  params,
}: {
  params: { slug?: string[] };
}): Promise<Metadata> {
  const segment = params.slug?.[0];
  const title =
    segment === "settings"
      ? "Ajustes de la app"
      : VIEWS.find((entry) => entry.id === segment)?.title ?? "Panel diario";
  return { title };
}

export default function DashboardPage() {
  return <DashboardShell />;
}
