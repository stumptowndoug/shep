import { ask } from "@tauri-apps/plugin-dialog";
import { getSessionCount, shutdownAndQuit } from "./tauri";
import { getErrorMessage } from "./errors";
import { useNoticeStore } from "../stores/useNoticeStore";

let pending = false;

/** Confirm first, then let native cleanup finish before requesting process exit. */
export async function requestAppShutdown(restart = false, sessionCount?: number): Promise<void> {
  if (pending) return;
  pending = true;
  const action = restart ? "Restart" : "Quit";
  try {
    const count = sessionCount ?? await getSessionCount();
    if (count > 0 && !await ask(
      `${action} Shep and stop ${count} running session${count === 1 ? "" : "s"}?`,
      { title: `${action} Shep`, kind: "warning", okLabel: action, cancelLabel: "Cancel" },
    )) return;
    await shutdownAndQuit(restart);
  } catch (error) {
    useNoticeStore.getState().pushNotice({ tone: "error", title: `Couldn’t ${action.toLowerCase()} Shep`, message: getErrorMessage(error) });
  } finally {
    pending = false;
  }
}
