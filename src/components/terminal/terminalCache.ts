import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalRendererState } from "./terminalRenderer";

export interface TerminalCacheEntry extends TerminalRendererState {
  term: Terminal;
  fitAddon: FitAddon;
}

// Keep terminal instances alive across tab switches.
export const terminalCache = new Map<number, TerminalCacheEntry>();
