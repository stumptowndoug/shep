import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { requestAppShutdown } from "../lib/appLifecycle";
import { getErrorMessage } from "../lib/errors";

type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
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
    if (["checking", "downloading", "installing", "ready"].includes(get().status)) return;
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
    if (!update || get().status !== "available") return;

    set({ status: "downloading", downloadProgress: 0, error: null });
    let totalLength = 0;
    let downloaded = 0;

    try {
      await update.downloadAndInstall((event) => {
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
          set({ status: "installing", downloadProgress: 100 });
        }
      });
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
    if (get().status !== "ready") return;
    await requestAppShutdown(true);
  },
}));
