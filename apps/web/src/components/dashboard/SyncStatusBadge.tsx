"use client";

import { CloudAlert, CloudCheck, HardDrive, RefreshCw, WifiOff } from "lucide-react";
import type { SyncStatus } from "@/lib/state";

const CONFIG: Record<SyncStatus, { icon: typeof CloudCheck; label: string; className: string }> = {
  local: { icon: HardDrive, label: "Guardado en este dispositivo", className: "local" },
  saved: { icon: CloudCheck, label: "Guardado", className: "saved" },
  syncing: { icon: RefreshCw, label: "Sincronizando…", className: "syncing" },
  offline: { icon: WifiOff, label: "Sin conexión", className: "offline" },
  error: { icon: CloudAlert, label: "Error al sincronizar", className: "error" },
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
