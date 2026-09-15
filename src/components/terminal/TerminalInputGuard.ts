import type { ITerminalAddon, Terminal } from "@xterm/xterm";

/**
 * xterm 6.0 retains capitals/spaces in its hidden textarea after sending them.
 * A later keyCode=229 edit can replay that whole history (xtermjs/xterm.js#6078).
 * Start each fresh keyboard transaction with an empty textarea, but leave it
 * alone while composition or xterm's deferred input processing still owns it.
 * Uses public DOM/addon APIs so it can be removed after an upstream fix.
 */
export class TerminalInputGuard implements ITerminalAddon {
  private cleanup: (() => void) | null = null;

  activate(term: Terminal): void {
    const textarea = term.textarea;
    if (!textarea) throw new Error("TerminalInputGuard must be loaded after terminal.open()");

    let composing = false;
    let pending = 0;
    let disposed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const settleAfterXterm = () => {
      pending++;
      // Capture keydown precedes xterm's handler. Register our timer after it
      // has queued its own 0ms callback; never clear text awaiting that send.
      queueMicrotask(() => {
        if (disposed) return;
        const timer = setTimeout(() => {
          timers.delete(timer);
          pending--;
        }, 0);
        timers.add(timer);
      });
    };

    const keydown = (event: KeyboardEvent) => {
      if (term.options.screenReaderMode || composing || event.isComposing) return;
      // Modifier-only events are not a new input transaction.
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
      if (pending === 0) textarea.value = "";
      if (event.keyCode === 229 || event.key === "Dead" || event.key === "AltGraph") {
        settleAfterXterm();
      }
    };
    const compositionstart = () => { composing = true; };
    const compositionend = () => {
      composing = false;
      settleAfterXterm();
    };

    textarea.addEventListener("keydown", keydown, true);
    textarea.addEventListener("compositionstart", compositionstart);
    textarea.addEventListener("compositionend", compositionend);
    this.cleanup = () => {
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      textarea.removeEventListener("keydown", keydown, true);
      textarea.removeEventListener("compositionstart", compositionstart);
      textarea.removeEventListener("compositionend", compositionend);
    };
  }

  dispose(): void {
    this.cleanup?.();
    this.cleanup = null;
  }
}
