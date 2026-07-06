import { create } from "zustand";
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";
import { getErrorMessage } from "../lib/errors";
import { isWindows } from "../lib/platform";
import { getPtySessionCount, prepareForUpdate } from "../lib/tauri";

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

interface UpdateStore {
  status: UpdateStatus;
  availableVersion: string | null;
  releaseNotesUrl: string | null;
  downloadProgress: number;
  error: string | null;
  hasChecked: boolean;
  _update: Update | null;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restartApp: () => Promise<void>;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: "idle",
  availableVersion: null,
  releaseNotesUrl: null,
  downloadProgress: 0,
  error: null,
  hasChecked: false,
  _update: null,

  checkForUpdate: async () => {
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (update) {
        set({
          status: "available",
          availableVersion: update.version,
          releaseNotesUrl: `https://github.com/stumptowndoug/shep/releases/tag/v${update.version}`,
          _update: update,
          hasChecked: true,
        });
      } else {
        set({
          status: "idle",
          availableVersion: null,
          releaseNotesUrl: null,
          _update: null,
          hasChecked: true,
        });
      }
    } catch (e) {
      set({
        status: "error",
        error: getErrorMessage(e),
        hasChecked: true,
      });
    }
  },

  downloadAndInstall: async () => {
    const update = get()._update;
    if (!update) return;

    set({ status: "downloading", downloadProgress: 0, error: null });
    let totalLength = 0;
    let downloaded = 0;

    const onProgress = (event: DownloadEvent) => {
      if (event.event === "Started") {
        totalLength = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (totalLength > 0) {
          set({
            downloadProgress: Math.round((downloaded / totalLength) * 100),
          });
        }
      } else if (event.event === "Finished") {
        set({ status: "ready", downloadProgress: 100 });
      }
    };

    try {
      if (isWindows) {
        // Download only. Installing on Windows launches the installer and
        // terminates the app immediately, so it happens in restartApp()
        // after sessions are confirmed and reaped.
        await update.download(onProgress);
      } else {
        await update.downloadAndInstall(onProgress);
      }
      set({ status: "ready", downloadProgress: 100 });
    } catch (e) {
      set({
        status: "available",
        error: getErrorMessage(e),
        downloadProgress: 0,
      });
    }
  },

  restartApp: async () => {
    if (isWindows) {
      const update = get()._update;
      if (!update) return;

      // The installer terminates the app directly, bypassing the
      // ExitRequested cleanup — confirm and reap child sessions first so no
      // shells/agents are orphaned holding files the installer needs.
      const count = await getPtySessionCount().catch(() => 0);
      if (count > 0) {
        const confirmed = await ask(
          `Installing the update will stop ${count} running session${count === 1 ? "" : "s"} and restart Shep. Continue?`,
          { title: "Install update", kind: "warning", okLabel: "Install", cancelLabel: "Cancel" },
        );
        if (!confirmed) return;
      }
      await prepareForUpdate();
      await update.install();
      return;
    }

    await relaunch();
  },
}));
