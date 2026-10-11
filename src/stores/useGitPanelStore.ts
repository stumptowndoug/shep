import { create } from "zustand";

export type DiffArea = "staged" | "unstaged" | "untracked";

/**
 * Per-repo selection for the Changes panel, kept outside the component so
 * switching tabs (which unmounts it) brings you back to the same file.
 */
export interface ProjectPanelState {
  /** The changed file whose diff is showing. */
  selectedPath: string | null;
  /** Which diff to show per path when a file has both staged and unstaged changes. */
  preferredArea: Record<string, DiffArea>;
}

const DEFAULT_STATE: ProjectPanelState = { selectedPath: null, preferredArea: {} };

interface GitPanelStore {
  perRepo: Record<string, ProjectPanelState>;
  select: (repo: string, path: string | null, area?: DiffArea) => void;
}

export const useGitPanelStore = create<GitPanelStore>((set) => ({
  perRepo: {},
  select: (repo, path, area) =>
    set((state) => {
      const current = state.perRepo[repo] ?? DEFAULT_STATE;
      return {
        perRepo: {
          ...state.perRepo,
          [repo]: {
            selectedPath: path,
            preferredArea: path && area ? { ...current.preferredArea, [path]: area } : current.preferredArea,
          },
        },
      };
    }),
}));
