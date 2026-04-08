import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { writePty, resizePty } from "../../lib/tauri";
import {
  flushPendingOutput,
  registerTerminal,
  unregisterTerminal,
} from "../../hooks/usePty";
import { TERMINAL_LINE_HEIGHT } from "../../lib/terminalConfig";
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

// Keep terminal instances alive across tab switches
export const terminalCache = new Map<
  number,
  { term: Terminal; fitAddon: FitAddon; rendererAddon: WebglAddon | CanvasAddon | null }
>();

export default function TerminalView({
  ptyId,
  visible,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const attachedRef = useRef(false);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const getOrCreateTerminal = useCallback(() => {
    const cached = terminalCache.get(ptyId);
    if (cached) return cached;

    const termSettings = useTerminalSettingsStore.getState().settings;
    const term = new Terminal({
      cursorBlink: termSettings.cursorBlink,
      cursorStyle: termSettings.cursorStyle,
      fontSize: termSettings.fontSize,
      fontFamily: termSettings.fontFamily,
      lineHeight: TERMINAL_LINE_HEIGHT,
      theme: createTerminalTheme(useThemeStore.getState().theme),
      scrollback: termSettings.scrollback,
      allowTransparency: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon());

    // Send input to PTY
    term.onData((data) => {
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

    const entry = { term, fitAddon, rendererAddon: null as WebglAddon | CanvasAddon | null };
    terminalCache.set(ptyId, entry);
    return entry;
  }, [ptyId]);

  const fitAndResize = useCallback(async () => {
    const cached = terminalCache.get(ptyId);
    if (!cached) return;

    cached.fitAddon.fit();
    const size = { cols: cached.term.cols, rows: cached.term.rows };
    const lastSize = lastSizeRef.current;

    if (
      lastSize &&
      lastSize.cols === size.cols &&
      lastSize.rows === size.rows
    ) {
      return;
    }

    lastSizeRef.current = size;
    await resizePty(ptyId, size.cols, size.rows).catch((error) => {
      if (import.meta.env.DEV) {
        console.error("Failed to resize PTY:", error);
      }
    });
  }, [ptyId]);

  useEffect(() => {
    if (!containerRef.current || !visible) return;

    const { term } = getOrCreateTerminal();
    let disposed = false;

    if (!mountedRef.current) {
      term.open(containerRef.current);
      mountedRef.current = true;

      // Load renderer addon after open() so it can access the DOM.
      // Canvas addon handles alpha compositing correctly for glass transparency.
      // Fall back to WebGL if Canvas fails.
      const cached = terminalCache.get(ptyId);
      if (cached && !cached.rendererAddon) {
        try {
          const canvas = new CanvasAddon();
          term.loadAddon(canvas);
          cached.rendererAddon = canvas;
        } catch (err) {
          if (import.meta.env.DEV) {
            console.warn("Canvas renderer failed, trying WebGL:", err);
          }
          try {
            const webgl = new WebglAddon();
            term.loadAddon(webgl);
            cached.rendererAddon = webgl;
          } catch (err2) {
            if (import.meta.env.DEV) {
              console.warn("No accelerated renderer available:", err2);
            }
          }
        }
      }
    }

    const attachTerminal = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (disposed) return;

      // Re-apply the current theme now that the container is visible.
      // Theme changes that occurred while hidden were deferred to avoid
      // corrupting xterm's scroll state.
      term.options.theme = createTerminalTheme(useThemeStore.getState().theme);

      // Re-apply terminal settings (font, cursor, scrollback) that may
      // have changed while this terminal was hidden.  applyTerminalSettings
      // skips hidden terminals, so we catch up here.
      const currentSettings = useTerminalSettingsStore.getState().settings;
      const fontChanged =
        term.options.fontFamily !== currentSettings.fontFamily ||
        term.options.fontSize !== currentSettings.fontSize;

      term.options.cursorStyle = currentSettings.cursorStyle;
      term.options.cursorBlink = currentSettings.cursorBlink;
      term.options.scrollback = currentSettings.scrollback;
      term.options.fontFamily = currentSettings.fontFamily;
      term.options.fontSize = currentSettings.fontSize;

      // If the font changed while hidden, force the renderer to discard
      // its cached glyph atlas so glyphs are re-drawn with the new font.
      if (fontChanged) {
        term.clearTextureAtlas();
      }

      // Refresh the viewport so rendering is restored after visibility
      // changes (e.g. closing settings overlay).
      term.refresh(0, term.rows - 1);

      await fitAndResize();
      if (disposed) return;

      if (!attachedRef.current) {
        registerTerminal(ptyId, term);
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
        });
      }
    };

    void attachTerminal();

    // ResizeObserver for auto-fitting
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (disposed) return;
        void fitAndResize();
      });
    });
    observer.observe(containerRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
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
      lastSizeRef.current = null;
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
