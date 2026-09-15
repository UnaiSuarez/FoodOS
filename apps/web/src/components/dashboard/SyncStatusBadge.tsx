"use client";

import { CloudAlert, CloudCheck, HardDrive, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import type { SyncStatus } from "@/lib/state";

const CONFIG: Record<SyncStatus, { icon: typeof CloudCheck; label: string; className: string }> = {
  local: { icon: HardDrive, label: "Guardado en este dispositivo", className: "local" },
  saved: { icon: CloudCheck, label: "Guardado", className: "saved" },
  syncing: { icon: RefreshCw, label: "Sincronizando…", className: "syncing" },
  offline: { icon: WifiOff, label: "Sin conexión", className: "offline" },
  error: { icon: CloudAlert, label: "Error al sincronizar", className: "error" },
  // Corrección de revisión: ni siquiera se pudo guardar de forma segura en
  // este dispositivo (cuota/serialización) — distinto y más grave que
  // "error" (que sí tiene una copia local durable esperando reintentar).
  unsynced: { icon: TriangleAlert, label: "No se pudo guardar de forma segura", className: "error" },
  // Corrección de revisión (bloqueante P0, "el badge todavía puede decir
  // 'Guardado'"): la hidratación inicial (pullState/ensureBaseRows/
  // confirmación de un pendiente) falló — independientemente de que el
  // ÚLTIMO push del snapshot local haya confirmado "saved". Sin esto, un
  // fallo real de sincronización inicial quedaba oculto detrás de "Guardado"
  // en la cabecera. Ver computeSyncStatus() en state.tsx para la precedencia
  // completa (unsynced > error de push > hydration-error > syncing/saved).
  "hydration-error": { icon: CloudAlert, label: "No se pudo verificar tu cuenta", className: "error" },
};

/** E04-07: indicador de estado de guardado en la cabecera — antes un
    guardado que no llegaba a Supabase solo se notaba por un toast puntual
    (que desaparece a los pocos segundos) o no se notaba en absoluto si el
    usuario estaba offline. Icono + texto en cada estado (no solo color, ver
    E18-13) para que también sea legible sin depender de distinguir tonos. */
export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const { icon: Icon, label, className } = CONFIG[status];
  return (
    <span className={`sync-status-badge ${className}`} role="status">
      <Icon size={14} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
