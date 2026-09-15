import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { TerminalInputGuard } from "../../src/components/terminal/TerminalInputGuard";
import { KEYBINDING_PRESETS } from "../../src/lib/keybindingPresets";

const term = new Terminal({ cols: 80, rows: 24 });
term.open(document.querySelector("#terminal")!);
const guard = new TerminalInputGuard();
if (!new URLSearchParams(location.search).has("unguarded")) term.loadAddon(guard);
const chunks: string[] = [];
term.onData((data) => chunks.push(data));
// Same default shortcut behavior as TerminalView, with a memory sink instead
// of a PTY. No test input is sent to a shell or an agent.
term.attachCustomKeyEventHandler((event) => {
  for (const preset of KEYBINDING_PRESETS) {
    if (preset.match(event)) {
      if (event.type === "keydown") chunks.push(preset.sequence);
      return false;
    }
  }
  return true;
});
term.focus();
Object.assign(window, { terminalTest: { term, chunks, guard } });
