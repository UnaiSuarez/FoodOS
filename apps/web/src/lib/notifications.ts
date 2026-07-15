import type { FoodOSState, InventoryItem } from "@foodos/types";
import { daysUntil, todayPlus } from "./utils";

// Notificaciones del sistema para caducidades inminentes (opt-in en Ajustes).
// v1 puramente local: se comprueba al abrir el dashboard, máximo una vez por
// día natural. No hay push desde servidor — si la app no se abre, no hay
// aviso. El push real (VAPID + edge function + cron) queda para una fase
// posterior; esta versión ya convierte la alerta del Panel en un aviso a
// nivel de sistema operativo.

const NOTIFIED_KEY = "foodos-expiry-notified";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Items que justifican un aviso: con stock y que caducan hoy, mañana o ya
    caducaron. Umbral fijo de 1 día (no el expiryWarnDays del Panel): la
    notificación del sistema es más intrusiva que un banner, se reserva para
    lo urgente. */
export function getExpiringForNotification(inventory: InventoryItem[]): InventoryItem[] {
  return inventory
    .filter((item) => item.qty > 0 && daysUntil(item.expires) <= 1)
    .sort((a, b) => daysUntil(a.expires) - daysUntil(b.expires));
}

/** Título y cuerpo del aviso a partir de los items urgentes. */
export function buildExpiryNotification(items: InventoryItem[]): { title: string; body: string } {
  const names = items.slice(0, 3).map((item) => item.name);
  const extra = items.length - names.length;
  const list = extra > 0 ? `${names.join(", ")} y ${extra} más` : names.join(", ");
  return {
    title: items.length === 1 ? "1 alimento caduca ya" : `${items.length} alimentos caducan ya`,
    body: `${list}. Úsalos hoy — en Recetas tienes ideas que los aprovechan.`,
  };
}

/** Muestra el aviso de caducidades si procede: toggle activado, permiso
    concedido, hay items urgentes y aún no se avisó hoy. Best-effort: nunca
    lanza (un fallo aquí no debe romper la carga del dashboard). */
export async function maybeNotifyExpiring(state: FoodOSState): Promise<void> {
  try {
    if (!state.settings?.expiryNotifications) return;
    if (!notificationsSupported() || Notification.permission !== "granted") return;

    // Máximo un aviso por día natural (fecha real, no debugDate: la
    // notificación es del mundo real aunque se esté simulando otro día).
    const today = todayPlus(0);
    if (localStorage.getItem(NOTIFIED_KEY) === today) return;

    const items = getExpiringForNotification(state.inventory);
    if (items.length === 0) return;

    localStorage.setItem(NOTIFIED_KEY, today);
    const { title, body } = buildExpiryNotification(items);

    // En Android/PWA instalada las notificaciones deben ir vía el service
    // worker; new Notification() solo funciona en escritorio. Se intenta el
    // SW primero y se cae al constructor si no hay registro (ej. en dev).
    const registration = "serviceWorker" in navigator
      ? await navigator.serviceWorker.getRegistration()
      : undefined;
    if (registration) {
      await registration.showNotification(title, { body, icon: "/icon.svg", tag: "foodos-expiry" });
    } else {
      new Notification(title, { body, icon: "/icon.svg", tag: "foodos-expiry" });
    }
  } catch {
    // Silencioso: best-effort.
  }
}
