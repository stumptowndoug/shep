import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification as sendNativeNotification,
} from "@tauri-apps/plugin-notification";
import { useTerminalStore } from "../stores/useTerminalStore";

let focused = true;
let permissionGranted = false;
let initialized = false;

export async function initNotifications() {
  if (initialized) return;
  initialized = true;

  listen("tauri://focus", () => {
    focused = true;
  });
  listen("tauri://blur", () => {
    focused = false;
  });

  permissionGranted = await isPermissionGranted();
}

async function ensureNotificationPermission() {
  if (permissionGranted) return true;

  const permission = await requestPermission();
  permissionGranted = permission === "granted";
  return permissionGranted;
}

export async function notifyAgent(ptyId: number, message: string, { attention = true }: { attention?: boolean } = {}) {
  if (attention) useTerminalStore.getState().setTabBell(ptyId, message);

  if (focused) {
    return;
  }

  try {
    const hasPermission = await ensureNotificationPermission();
    if (!hasPermission) return;
    sendNativeNotification({ title: "Shep", body: message });
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error("[shep] notification error:", error);
    }
  }
}
