import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { writePty, resizePty, openUrl } from "../../lib/tauri";
import {
  flushPendingOutput,
  registerTerminal,
  unregisterTerminal,
} from "../../hooks/usePty";
import { TERMINAL_LINE_HEIGHT, buildCSSFontFamily } from "../../lib/terminalConfig";
import {
  preserveTerminalViewport,
  resyncTerminalViewport,
  terminalBottomOffset,
} from "../../lib/terminalViewport";
import { createTerminalTheme } from "./terminalTheme";
import { useThemeStore } from "../../stores/useThemeStore";
import { notifyAgent } from "../../lib/notifications";
import { KEYBINDING_PRESETS } from "../../lib/keybindingPresets";
import { useKeybindingStore } from "../../stores/useKeybindingStore";
import { useTerminalSettingsStore } from "../../stores/useTerminalSettingsStore";

interface TerminalViewProps {
  ptyId: number;
  visible: boolean;
}

function needsCanvasForTransparentPalette(term: Terminal): boolean {
  const theme = term.options.theme;
  const transparentColors = [theme?.background, theme?.black, theme?.brightBlack];
  return term.options.allowTransparency === true && transparentColors.some((color) =>
    color === "transparent" || color?.startsWith("rgba("),
  );
}

// Keep terminal instances alive across tab switches
export const terminalCache = new Map<
  number,
  {
    term: Terminal;
    fitAddon: FitAddon;
    rendererAddon: WebglAddon | CanvasAddon | null;
    webglFailed: boolean;
  }
>();

export default function TerminalView({
  ptyId,
  visible,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const attachedRef = useRef(false);
  const pinnedToBottomRef = useRef(true);
  const columnResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getOrCreateTerminal = useCallback(() => {
    const cached = terminalCache.get(ptyId);
    if (cached) return cached;

    const termSettings = useTerminalSettingsStore.getState().settings;
    const term = new Terminal({
      cursorBlink: termSettings.cursorBlink,
      cursorStyle: termSettings.cursorStyle,
      fontSize: termSettings.fontSize,
      fontFamily: buildCSSFontFamily(termSettings.fontFamily),
      lineHeight: TERMINAL_LINE_HEIGHT,
      theme: createTerminalTheme(useThemeStore.getState().theme),
      scrollback: termSettings.scrollback,
      allowTransparency: true,
      allowProposedApi: true,
      linkHandler: {
        activate: (_ev, url) => {
          void openUrl(url);
        },
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_ev, url) => {
      void openUrl(url);
    }));

    // Send input to PTY
    term.onData((data) => {
      pinnedToBottomRef.current = true;
      term.scrollToBottom();
      writePty(ptyId, data).catch((error) => {
        if (import.meta.env.DEV) {
          console.error("Failed to write PTY input:", error);
        }
      });
    });

    // Track terminal bell (attention request)
    term.onBell(() => {
      void notifyAgent(ptyId, "Terminal bell");
    });

    // Intercept OSC 9 notifications from coding agents (Claude Code, Codex, Gemini)
    term.parser.registerOscHandler(9, (data) => {
      const message = data.startsWith("2;") ? data.slice(2) : data;
      if (message) {
        void notifyAgent(ptyId, message);
      }
      return true;
    });

    // Intercept key combos for custom keybindings
    term.attachCustomKeyEventHandler((ev) => {
      const settings = useKeybindingStore.getState().settings;
      for (const preset of KEYBINDING_PRESETS) {
        if (settings[preset.id] && preset.match(ev)) {
          if (ev.type === "keydown") {
            writePty(ptyId, preset.sequence).catch((error) => {
              if (import.meta.env.DEV) {
                console.error("Failed to write PTY keybinding:", error);
              }
            });
          }
          return false; // prevent xterm default handling
        }
      }
      return true; // let xterm handle normally
    });

    const entry = {
      term,
      fitAddon,
      rendererAddon: null as WebglAddon | CanvasAddon | null,
      webglFailed: false,
    };
    terminalCache.set(ptyId, entry);
    return entry;
  }, [ptyId]);

  const applyTerminalSize = useCallback(async (cols: number, rows: number) => {
    const cached = terminalCache.get(ptyId);
    if (!cached) return;

    const size = { cols: Math.max(2, cols), rows: Math.max(2, rows) };
    if (cached.term.cols === size.cols && cached.term.rows === size.rows) return;

    preserveTerminalViewport(cached.term, () => {
      cached.term.resize(size.cols, size.rows);
    });

    await resizePty(ptyId, size.cols, size.rows).catch((error) => {
      if (import.meta.env.DEV) {
        console.error("Failed to resize PTY:", error);
      }
    });
  }, [ptyId]);

  const fitAndResize = useCallback(async () => {
    const cached = terminalCache.get(ptyId);
    if (!cached) return;

    const proposedSize = cached.fitAddon.proposeDimensions();
    if (!proposedSize) return;

    const nextSize = { cols: proposedSize.cols, rows: proposedSize.rows };
    const columnsChanged = cached.term.cols !== nextSize.cols;
    const rowsChanged = cached.term.rows !== nextSize.rows;
    if (!columnsChanged && !rowsChanged) return;

    const shouldDebounceColumns =
      columnsChanged && cached.term.buffer.active.length > 200;

    if (!shouldDebounceColumns) {
      if (columnResizeTimerRef.current) {
        clearTimeout(columnResizeTimerRef.current);
        columnResizeTimerRef.current = null;
      }
      await applyTerminalSize(nextSize.cols, nextSize.rows);
      return;
    }

    // Reflowing a long scrollback buffer on every width observation is costly.
    // Apply row changes immediately at the current width and settle columns
    // after the resize gesture has been quiet for 100 ms.
    if (rowsChanged) {
      await applyTerminalSize(cached.term.cols, nextSize.rows);
    }
    if (columnResizeTimerRef.current) clearTimeout(columnResizeTimerRef.current);
    columnResizeTimerRef.current = setTimeout(() => {
      columnResizeTimerRef.current = null;
      void applyTerminalSize(nextSize.cols, nextSize.rows);
    }, 100);
  }, [applyTerminalSize, ptyId]);

  useEffect(() => {
    if (!containerRef.current || !visible) return;

    const { term } = getOrCreateTerminal();
    let disposed = false;

    if (!mountedRef.current) {
      term.open(containerRef.current);
      mountedRef.current = true;

      // Load renderer addon after open() so it can access the DOM. Prefer
      // WebGL, remember failures for this cached session, then fall back to
      // Canvas. If both fail, xterm's built-in DOM renderer remains active.
      const cached = terminalCache.get(ptyId);
      if (cached && !cached.rendererAddon) {
        const loadCanvasFallback = () => {
          if (cached.rendererAddon) return;
          try {
            const canvas = new CanvasAddon();
            term.loadAddon(canvas);
            cached.rendererAddon = canvas;
          } catch (error) {
            if (import.meta.env.DEV) {
              console.warn("Canvas renderer unavailable; using DOM renderer:", error);
            }
          }
        };

        if (needsCanvasForTransparentPalette(term)) {
          // WKWebView can retain WebGL's altered palette state even after the
          // addon is disposed. Choose Canvas before WebGL touches a terminal
          // whose transparent background/palette is known to render poorly.
          cached.webglFailed = true;
          if (import.meta.env.DEV) {
            console.debug("Transparent terminal palette requires Canvas renderer");
          }
        } else if (!cached.webglFailed) {
          let webgl: WebglAddon | null = null;
          try {
            webgl = new WebglAddon();
            const loadedWebgl = webgl;
            loadedWebgl.onContextLoss(() => {
              if (cached.rendererAddon !== loadedWebgl) return;
              cached.rendererAddon = null;
              cached.webglFailed = true;
              loadedWebgl.dispose();
              loadCanvasFallback();
            });
            term.loadAddon(loadedWebgl);
            cached.rendererAddon = loadedWebgl;
          } catch (error) {
            webgl?.dispose();
            cached.webglFailed = true;
            if (import.meta.env.DEV) {
              console.warn("WebGL renderer unavailable; trying Canvas:", error);
            }
          }
        }
        if (!cached.rendererAddon) {
          loadCanvasFallback();
        }
      }
    }

    const surface = containerRef.current;
    const syncPinnedAfterEvent = () => {
      queueMicrotask(() => {
        if (disposed) return;
        pinnedToBottomRef.current = terminalBottomOffset(term) === 0;
      });
    };
    const handleWheelCapture = (event: WheelEvent) => {
      if (event.deltaY < 0) pinnedToBottomRef.current = false;
      else syncPinnedAfterEvent();
    };
    const handleKeyDownCapture = (event: KeyboardEvent) => {
      const viewportKey = event.shiftKey && [
        "PageUp",
        "PageDown",
        "Home",
        "End",
        "ArrowUp",
        "ArrowDown",
      ].includes(event.key);
      if (viewportKey) {
        if (["PageUp", "Home", "ArrowUp"].includes(event.key)) {
          pinnedToBottomRef.current = false;
        }
        syncPinnedAfterEvent();
        return;
      }

      // Normal terminal input resumes follow mode before xterm emits onData.
      pinnedToBottomRef.current = true;
      term.scrollToBottom();
    };
    surface.addEventListener("wheel", handleWheelCapture, { capture: true });
    surface.addEventListener("keydown", handleKeyDownCapture, { capture: true });

    const attachTerminal = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (disposed) return;

      // Re-apply the current theme now that the container is visible.
      // Theme changes that occurred while hidden were deferred to avoid
      // corrupting xterm's scroll state.
      term.options.theme = createTerminalTheme(useThemeStore.getState().theme);

      // Re-apply terminal settings (font, cursor, scrollback) that may have
      // changed while this terminal was hidden. `applyTerminalSettings` skips
      // hidden terminals to avoid corrupting xterm state, so we catch up here
      // once the container is visible again. If the font changed, the
      // renderer's texture atlas is cleared so glyphs are re-measured.
      const currentTermSettings = useTerminalSettingsStore.getState().settings;
      const nextCssFont = buildCSSFontFamily(currentTermSettings.fontFamily);
      const fontMetricsChanged =
        term.options.fontFamily !== nextCssFont ||
        term.options.fontSize !== currentTermSettings.fontSize;

      term.options.cursorStyle = currentTermSettings.cursorStyle;
      term.options.cursorBlink = currentTermSettings.cursorBlink;
      term.options.scrollback = currentTermSettings.scrollback;
      term.options.fontFamily = nextCssFont;
      term.options.fontSize = currentTermSettings.fontSize;

      const cachedEntry = terminalCache.get(ptyId);
      if (fontMetricsChanged) {
        cachedEntry?.rendererAddon?.clearTextureAtlas?.();
      }

      // Refresh the viewport so rendering is restored after visibility
      // changes (e.g. closing settings overlay).
      term.refresh(0, term.rows - 1);

      await fitAndResize();
      if (disposed) return;

      // fitAndResize skips the fit (and its viewport preservation) when the
      // dimensions didn't change — the common case when returning to a tab —
      // so the zeroed DOM scrollTop must be re-asserted unconditionally.
      // Recompute immediately before the pending-output flush. The buffer may
      // have changed while theme/settings/fit work ran, so an earlier offset
      // is not safe to reuse here.
      resyncTerminalViewport(term, terminalBottomOffset(term));

      if (!attachedRef.current) {
        registerTerminal(ptyId, term, () => {
          if (pinnedToBottomRef.current) term.scrollToBottom();
        });
        flushPendingOutput(ptyId);
        attachedRef.current = true;
      }

      window.setTimeout(() => {
        if (disposed) return;
        void fitAndResize();
        term.focus();
      }, 100);

      if ("fonts" in document) {
        void document.fonts.ready.then(() => {
          if (disposed) return;
          void fitAndResize();
          if (import.meta.env.DEV) {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (ctx) {
              const cssFont = term.options.fontFamily ?? "";
              const fonts = cssFont.split(",").map(f => f.trim().replace(/^["']|["']$/g, ""));
              ctx.font = `${term.options.fontSize}px serif`;
              const serifW = ctx.measureText("mmmm").width;
              for (const font of fonts) {
                ctx.font = `${term.options.fontSize}px "${font}", serif`;
                const w = ctx.measureText("mmmm").width;
                if (w !== serifW) {
                  console.log(`Terminal font: "${font}" (active)`);
                  break;
                }
              }
            }
          }
        });
      }
    };

    void attachTerminal();

    // ResizeObserver for auto-fitting. fitAndResize applies rows immediately
    // and owns the long-buffer column debounce.
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      void fitAndResize();
    });
    observer.observe(containerRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      surface.removeEventListener("wheel", handleWheelCapture, { capture: true });
      surface.removeEventListener("keydown", handleKeyDownCapture, { capture: true });
      if (columnResizeTimerRef.current) {
        clearTimeout(columnResizeTimerRef.current);
        columnResizeTimerRef.current = null;
      }
    };
  }, [ptyId, visible, getOrCreateTerminal, fitAndResize]);


  useEffect(() => {
    return () => {
      const cached = terminalCache.get(ptyId);
      if (cached) {
        cached.term.dispose();
        terminalCache.delete(ptyId);
        unregisterTerminal(ptyId);
      }
      mountedRef.current = false;
      attachedRef.current = false;
      pinnedToBottomRef.current = true;
      if (columnResizeTimerRef.current) {
        clearTimeout(columnResizeTimerRef.current);
        columnResizeTimerRef.current = null;
      }
    };
  }, [ptyId]);

  return (
    <div
      className="terminal-view"
      style={{
        display: visible ? "block" : "none",
      }}
    >
      <div className="terminal-underlay" />
      <div ref={containerRef} className="terminal-surface" />
    </div>
  );
}
