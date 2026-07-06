import type { KeybindingSettings } from "./types";
import { isMac } from "./platform";

export interface KeybindingPreset {
  id: keyof KeybindingSettings;
  keys: string[];
  action: string;
  description: string;
  /** Bytes to write to the PTY when the combo fires */
  sequence: string;
  /** Return true if this keyboard event matches the key combo (regardless of keydown/keyup) */
  match: (ev: KeyboardEvent) => boolean;
}

// Preset ids are stable across platforms so saved settings survive; only the
// key combos and labels differ. Windows avoids plain Ctrl+letter chords (they
// are control characters inside the terminal) and the Win key (reserved by
// the OS — e.g. Win+K opens the Cast flyout).
export const KEYBINDING_PRESETS: KeybindingPreset[] = [
  {
    id: "shiftEnterNewline",
    keys: ["Shift", "Enter"],
    action: "Newline",
    description: "Send a newline instead of submitting. Useful for multi-line input in Claude Code, Codex, etc.",
    sequence: "\n",
    match: (ev) =>
      ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey,
  },
  isMac
    ? {
        id: "optionDeleteWord",
        keys: ["⌥", "Delete"],
        action: "Delete word",
        description: "Delete the previous word, matching macOS text editing conventions.",
        sequence: "\x17", // Ctrl+W
        match: (ev) =>
          ev.key === "Backspace" && ev.altKey && !ev.ctrlKey && !ev.metaKey,
      }
    : {
        id: "optionDeleteWord",
        keys: ["Ctrl", "Backspace"],
        action: "Delete word",
        description: "Delete the previous word, matching Windows text editing conventions.",
        sequence: "\x17", // Ctrl+W
        match: (ev) =>
          ev.key === "Backspace" && ev.ctrlKey && !ev.altKey && !ev.metaKey,
      },
  isMac
    ? {
        id: "cmdKClear",
        keys: ["⌘", "K"],
        action: "Clear terminal",
        description: "Clear the terminal screen, matching iTerm and Terminal.app behavior.",
        sequence: "\x0c", // form feed
        match: (ev) =>
          ev.key === "k" && ev.metaKey && !ev.ctrlKey && !ev.altKey,
      }
    : {
        id: "cmdKClear",
        keys: ["Ctrl", "Shift", "K"],
        action: "Clear terminal",
        description: "Clear the terminal screen.",
        sequence: "\x0c", // form feed
        match: (ev) =>
          ev.key.toLowerCase() === "k" && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey,
      },
];
