import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ShepTheme } from "../../lib/themes";

export interface TerminalRendererState {
  rendererAddon: WebglAddon | null;
  webglFailed: boolean;
}

export function suspendTerminalRenderer(state: TerminalRendererState): void {
  const loadedWebgl = state.rendererAddon;
  state.rendererAddon = null;
  loadedWebgl?.dispose();
}

export function reconcileTerminalRenderer(
  term: Terminal,
  state: TerminalRendererState,
  theme: ShepTheme,
): void {
  // Glass themes need xterm's built-in DOM renderer because the WebGL addon
  // paints terminal background rectangles opaque. Disposing the addon keeps
  // the terminal, buffer, selection, and PTY intact while restoring DOM.
  if (theme.isTransparent) {
    suspendTerminalRenderer(state);
    return;
  }

  if (!term.element || state.rendererAddon || state.webglFailed) return;

  let webgl: WebglAddon | null = null;
  try {
    webgl = new WebglAddon();
    const loadedWebgl = webgl;
    loadedWebgl.onContextLoss(() => {
      if (state.rendererAddon !== loadedWebgl) return;
      state.rendererAddon = null;
      state.webglFailed = true;
      loadedWebgl.dispose();
      if (import.meta.env.DEV) {
        console.warn("WebGL context lost; using xterm's DOM renderer");
      }
    });
    term.loadAddon(loadedWebgl);
    state.rendererAddon = loadedWebgl;
  } catch (error) {
    webgl?.dispose();
    state.webglFailed = true;
    if (import.meta.env.DEV) {
      console.warn("WebGL renderer unavailable; using xterm's DOM renderer:", error);
    }
  }
}
