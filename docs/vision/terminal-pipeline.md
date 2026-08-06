# Terminal Pipeline Plan — xterm.js + PTY + (eventually) a Rust VT core

Status: proposed · 2026-08-05

Fixes the long-standing scroll bug ("long agent output invisible until finished,
then viewport jumps to top") and sets up the terminal architecture we need for
durable agent sessions. Based on three research passes: an audit of Shep's own
pipeline, a study of VS Code's xterm.js integration, and a survey of Rust
terminal-state libraries.

## Diagnosis (what's actually wrong today)

Confirmed in our code, in rough order of blame:

1. **Unbounded buffering, then one giant write.** If a `TerminalView` isn't
   visible when output arrives, everything accumulates in an uncapped
   `pendingOutput` array (`src/hooks/usePty.ts:19,89-97`) and is flushed as a
   single `term.write()` with no callback (`usePty.ts:47-57`). The rAF write
   batch (`usePty.ts:78-88`) also grows unbounded while the webview is occluded
   (rAF doesn't fire). This is the literal "nothing shows until finished" case.
2. **Stale scroll restore + self-inflicted jump-to-top.** Tab-show captures
   `bottomOffset` once (`TerminalView.tsx:201`), then reuses it 100 ms later
   (`TerminalView.tsx:251`) after the giant flush moved `baseY` by thousands of
   lines. Worse, `resyncTerminalViewport` (`src/lib/terminalViewport.ts:36`)
   deliberately scrolls to line 0 first; that negative scroll sets xterm's
   internal `isUserScrolling = true`, and if the follow-up lands below `ybase`
   the terminal **permanently stops following output**.
3. **No flow control anywhere.** Rust reads 4 KB chunks (`pty/session.rs:401`)
   and fire-and-forgets over a Tauri channel (`session.rs:419`); frontend never
   uses `term.write(data, cb)`. Producer fully decoupled from consumer.
4. **Mode 2026 irony.** We set `TERM_PROGRAM=iTerm.app` (`session.rs:367`), so
   agent CLIs believe synchronized output is supported and emit `CSI ?2026h/l`
   — but xterm 5.5.0 has zero 2026 support (landed in 6.0, PR #5453). Claude
   Code's Ink repaints emit `CSI 2J`/`3J` which reset `viewportY` even inside
   sync blocks (xterm.js issue #5801, still open; full viewport fix is
   PR #5770, targeting 7.0).
5. **Rust escape scanner hold-back.** An OSC/CSI split across a read boundary
   pushes *all* subsequent bytes into `pending_control`
   (`session.rs:207-210,243-246`) until a terminator arrives — a lump release
   and O(n²) rescans on pathological input.
6. **Renderer inversion.** We load CanvasAddon first and WebGL only in the
   catch (`TerminalView.tsx:170-190`); loadAddon rarely throws, so WebGL is
   effectively dead code. VS Code does the opposite (WebGL → DOM fallback with
   `onContextLoss` handling).
7. **Undebounced resize.** ResizeObserver → fit on every tick with no debounce
   (`TerminalView.tsx:284-290`); column resize triggers full reflow. VS Code
   resizes rows immediately but debounces columns 100 ms once the buffer
   exceeds 200 lines (`terminalResizeDebouncer.ts`).

## What VS Code does that we should copy

- **Ack-based flow control** (`FlowControlConstants`): pause the pty above
  **100 000** unacked chars, resume below **5 000**; the renderer acks from
  xterm's `write()` completion callback in ~5 000-char increments. This is the
  load-bearing mechanism that keeps the parser painting intermediate frames.
- **~5 ms coalescing** of pty data before IPC (`TerminalDataBufferer`) —
  fewer messages, negligible latency.
- **No custom pin-to-bottom logic during output** — trust xterm's viewport;
  explicit `scrollToBottom()` only on user input.
- **Resize**: rows immediately, columns debounced 100 ms past 200 buffer lines.
- **Renderer**: WebGL first, `onContextLoss` → dispose + DOM fallback,
  remember failures.

## Plan

### Phase 0 — Repro harness + instrumentation (half a day)

- Script that replays a captured long Claude Code session (or generates
  2026-wrapped full repaints + heavy scrollback) into a Shep terminal.
- Dev-mode counters: per-pty bytes/sec, write-batch size at flush,
  `pendingOutput` length, viewport position before/after flush.
- Exit criterion: the bug reproduces on demand; every later phase re-runs this.

### Phase 1 — Frontend pipeline fixes (no dependency changes)

1. Kill the giant flush: always write via `term.write(chunk, cb)` in bounded
   chunks (~64 KB); cap `pendingOutput` (drop oldest with a `[output truncated]`
   marker) — an invisible terminal must not buffer a whole session.
2. Fix `resyncTerminalViewport`: recompute `bottomOffset` at flush time, drop
   the second 100 ms resync with stale state, and never leave
   `isUserScrolling` latched (end pinned restores with `scrollToBottom()`).
3. Explicit `pinnedToBottom` flag (Tabby pattern): capture-phase wheel/keydown
   sets it; while pinned, `scrollToBottom()` after each write completion.
4. Resize: adopt VS Code's rows-now / columns-debounced-100ms pattern.
5. Renderer: WebGL first with `onContextLoss` → dispose → canvas/DOM fallback;
   remember failure per session.
- Verify with Phase 0 harness: no blank-until-finished, no jump-to-top, no
  permanent unpin.

### Phase 2 — Flow control + Rust scanner hardening

1. VS Code-style flow control across the Tauri boundary: Rust counts unacked
   bytes per session and simply stops `read()`ing above ~100 k (kernel pty
   buffer backpressures the child); frontend sends `ack(n)` every ~5 000 chars
   from write callbacks; resume below ~5 k.
2. Coalesce reads ~5 ms in Rust before `channel.send`; never split emitted
   chunks immediately before an ESC byte.
3. Bound `pending_control` (`session.rs`): cap held bytes (e.g. 4 KB), flush
   raw on overflow; stop holding back *subsequent* output behind an
   unterminated sequence.
4. Interim 2026 mitigation (works on xterm 5.5): while inside
   `?2026h…?2026l`, strip `CSI 2J`/`CSI 3J` at the Rust layer (proven ~80%
   effective workaround for xterm #5801 used by Pane/Termdock).

Native validation note (2026-08-06): reject item 4 for Shep. A real Claude
session does not repaint every prior cell, so stripping `2J`/`3J` produced
severe stale and overprinted rows. Preserve those clears verbatim until the
xterm 6 upgrade provides real synchronized-output support.

### Phase 3 — xterm.js 6.x upgrade

- Upgrade 5.5 → 6.x for real mode-2026 support (BSU/ESU atomic flush, DECRQM
  feature-detection so Claude Code uses it properly). Re-test addon compat
  (canvas addon is deprecated in 6.x — WebGL/DOM only).
- Watch 7.0 / PR #5770 for the viewport-sync-during-2026 fix; keep the Phase 1
  viewport/follow defenses until it ships, then re-test whether they can be
  simplified. The rejected Phase 2 clear-sequence filter remains removed.

Implementation status (2026-08-06): upgraded the stable package family together
to xterm 6.0.0, Fit 0.11.0, Unicode11 0.9.0, Web Links 0.12.0, and WebGL 0.19.0.
The removed Canvas addon is no longer imported or installed. Shep prefers WebGL
for opaque palettes and, on initialization failure or context loss, disposes it
so xterm restores its built-in DOM renderer. Native testing showed that xterm's
WebGL atlas deliberately forces ANSI foreground glyphs opaque, which changes
Shep's translucent dark-theme black/bright-black colors; those palettes now use
DOM directly to preserve their compositing. The xterm 6 custom scrollbar is
themed via the new `ITheme.scrollbarSlider*` fields, and the installed core was
verified to handle mode 2026 plus its DECRQM response. TypeScript, the production
bundle, and all 41 Rust tests pass; native palette/replay/interactive validation
remains the final gate.

### Phase 4 — Rust VT state core (durable-sessions foundation)

Not a renderer change — xterm.js stays the view. A persistent PTY host needs
server-side screen state to replay on reattach (tmux/herdr model). Decisions
and details live in docs/vision/durable-agent-sessions.md ("Research findings
and decisions"); summary:

- v1 reattach: bounded ring buffer of raw ANSI output, seeded to the client
  on attach (herdr's shipped approach) — no VT serialization needed.
- v2: emulator behind a trait; start with **avt** (asciinema's VT,
  `dump()` re-emits full state as escape sequences + streamed scrollback —
  the exact late-joiner replay model) or **alacritty_terminal** (max fidelity,
  mode 2026, Zed-proven, but DIY grid→escape serializer).
- **libghostty-vt**: watch, don't build on. Rust bindings are third-party
  (0.2.x), require a Zig toolchain at build time, track an unstable pre-1.0
  API. Adopt when upstream tags a stable C API release.
- Avoid wezterm crates as dependencies (git-only, maintenance risk); use its
  mux architecture as reference only.

Phases 0–2 are independent of the durable-sessions decision and fix the daily
pain. Phase 4 is where this plan meets docs/vision/durable-agent-sessions.md.

## Key references

- VS Code: `src/vs/platform/terminal/common/terminal.ts` (FlowControlConstants),
  `node/terminalProcess.ts`, `common/terminalDataBuffering.ts`,
  `browser/terminalInstance.ts`, `browser/terminalResizeDebouncer.ts`,
  `browser/xterm/xtermTerminal.ts`
- xterm.js: PR #5453 (2026 support, 6.0), PR #5770 (viewport sync fix, 7.0),
  issue #5801 (ED2 inside sync block resets viewport)
- Tabby PR #11102 (pinnedToBottom pattern)
- Rust VT: avt (asciinema), alacritty_terminal 0.26, vt100,
  libghostty-vt 0.2.1 (Uzaaft/libghostty-rs)
