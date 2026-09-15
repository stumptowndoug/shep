# Terminal input replay

## Evidence

The xterm.js 6.0.0 bundled with Shep retains a subset of typed text in its
hidden textarea. A later non-composition `keyCode=229` edit can resend that
whole value, as described in [xterm.js #6078](https://github.com/xtermjs/xterm.js/issues/6078).

Our isolated browser test physically types `Please FIX this input Issue`.
The unguarded terminal sends that sentence correctly but retains `P FIX   I`
(WebKit uses a nonbreaking space for one of those spaces). Replaying the
reported browser input event then emits `P FIX   x` instead of just `x`.
Both WebKit and Chromium reproduce this. No Shift+Enter, agent, PTY, usage
refresh, or real user input is involved.

This confirms the faulty mechanism, not the exact native event that triggered
the user's intermittent incidents. The final triggering edit is synthetic;
ordinary typing and redraw stress alone did not produce an unsolicited burst.
Everyday use of a rebuilt Shep is still needed to confirm the symptom is gone.

## Fix

`TerminalInputGuard` attaches after `Terminal.open()`. It clears stale textarea
contents before a fresh keyboard transaction, ahead of xterm's input handler.
It never filters the PTY stream or terminal replies. Active composition,
deferred input/commit callbacks, modifier-only events, and screen reader mode
retain ownership of the textarea. Timer release is queued after xterm's own
deferred processing, so the following keystroke cannot erase an unsent commit.
The addon disposes its listeners and timers with the terminal.

This is a workaround using public addon/DOM APIs, not a patch to xterm internals.
Revisit it when updating xterm; keep the unguarded reproduction as a control.
Screen reader behavior is intentionally unchanged.

## Verification

```sh
pnpm exec playwright install webkit chromium
pnpm test:terminal-input
pnpm build
```

The browser suite runs a memory-only terminal on a dedicated local test server.
It checks the unguarded control and guarded replay, ordinary typing under redraw
load, composed/decomposed accents, simulated IME input and cancellation, a key
arriving before a deferred commit, bracketed multiline paste, Enter, arrows,
backspace, Shep shortcuts, screen reader preservation, and addon disposal.
The harness and captured test text are not included in the production app.
No diagnostic recording of the user's typing is enabled.
