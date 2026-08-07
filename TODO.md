# To-dos

## 📋 Backlog

- [ ] Durable agent sessions — survive app quit/restart
  - [x] research + architecture decisions recorded in docs/vision/durable-agent-sessions.md (2026-08-05)
  - [x] decided: build shep-ptyhost in Rust; tmux/herdr rejected as core (herdr spike optional)
  - [ ] Phase 1 remainder: specify IPC surface, session-record schema, host lifecycle
  - [ ] Phase 2 milestone: one Claude session survives GUI quit, reattaches via raw-history replay
  - [ ] later: VT state machine behind a trait (avt first), vendor resume adapters
- [ ] Better stuck-agent detection (working / blocked / idle)
  - [ ] today only bell + OSC 9 drive the attention state — opt-in by the agent
  - [ ] watch ~/.claude/sessions/<pid>.json status field for Claude Code (match by PTY child pid, cwd fallback)
  - [ ] heuristic: stale statusUpdatedAt + no PTY output = possibly stuck
  - [ ] per-CLI prompt-pattern detection for agents with no status signal
- [ ] Tune light terminal theme palettes
  - [ ] review ANSI black/bright-black contrast, selection, cursor, and scrollbar colors
  - [ ] compare solid light themes under WebGL without changing renderer policy
- [ ] Session-name-derived tab and sidebar titles
  - [ ] capture OSC title changes via xterm.js onTitleChange as the universal baseline
  - [ ] read name from ~/.claude/sessions/<pid>.json for Claude Code
  - [ ] fallback: derive title from session's first user prompt via existing usage ingest
  - [ ] show in agent tab labels and Agent Sessions sidebar section
  - [ ] treat all file formats as undocumented — graceful fallback if schema changes

## 🚧 In Progress

- [ ] Release the next Shep version
  - [x] open dependency/terminal integration PR #57 into `main`
  - [x] merge PR #57 after review and required checks
  - [x] update local `main` to merge commit `14efb5d`
  - [x] choose release version `0.6.0`
  - [ ] bump versions with `scripts/bump-version.sh`
  - [ ] build, sign, notarize, and generate updater metadata
  - [ ] smoke-test the packaged DMG
  - [ ] tag, push, and publish the GitHub release

## ✅ Done

- [x] Audit and upgrade dependencies for the next release
  - [x] inventory frontend and Rust updates with compatibility/security notes — see `docs/vision/dependency-audit-2026-08.md`
  - [x] split xterm.js 6.x upgrade to dedicated `upgrade/xterm-6-phase-3` branch
  - [x] land same-major frontend security batch (markdown-it 14.3, Vite 7.3.6, React plugin 5.2, patched transitive toolchain)
  - [x] verify first batch with pnpm audit, TypeScript, production build, and all 41 Rust tests
  - [x] replace obsolete Sharp icon tooling with the Tauri CLI
  - [x] refresh Tauri 2.11 and the Rust lockfile in a platform-regression batch
  - [x] evaluate frontend and Rust API/toolchain majors in focused branches
  - [x] integrate approved dependency lanes on `integration/next-release-dependencies`
    - [x] regenerate combined pnpm and Cargo lockfiles
    - [x] run frontend audit/build and exact-Rust-1.95 full Rust tests
    - [x] run native terminal/platform/database/font/Git/diff smoke matrix
  - [x] run terminal repro, interactive shell, build, and full Rust regression checks
  - [x] preserve focused upgrade branches as separate rollback and PR boundaries

- [x] Upgrade xterm.js 5.5 → 6.x
  - [x] inventory core/addon API and CSS changes against the installed versions
  - [x] upgrade xterm packages together and remove the deprecated Canvas addon
  - [x] prefer WebGL for solid themes; use built-in DOM for glass themes, initialization failure, or context loss
  - [x] verify ANSI palette, Phase 0 replay, manual scroll/follow, and interactive Claude/OpenCode sessions
  - [x] run TypeScript, production build, and full Rust tests
  - [x] finalize opaque ANSI colors with an explicit glass/DOM renderer policy on `experiment/xterm-opaque-ansi-webgl`
    - [x] compare muted palette appearance against the hybrid DOM baseline
    - [x] reject opaque terminal surfaces for glass themes after native testing
    - [x] route `isTransparent` themes to DOM and solid themes to WebGL
    - [x] verify live solid ↔ glass switching preserves the terminal and viewport
    - [x] compare Phase 0 replay responsiveness and normal interactive use

- [x] Fix xterm scroll misbehavior during long agent output
  - [x] root-cause investigation — see docs/vision/terminal-pipeline.md for full diagnosis and plan
  - [x] Phase 0: repro harness + pipeline instrumentation
  - [x] Phase 1: frontend fixes (bounded writes w/ callback, stale-offset resync fix, pinnedToBottom, resize debounce, WebGL-first renderer)
    - [x] implementation complete on fix/terminal-scroll-phase-0-1
    - [x] pnpm build + TypeScript + cargo test (37 tests) pass
    - [x] native visual check: continuous paint/no top jump; wheel-up holds; End/input resumes follow
    - [x] renderer regression recheck: Canvas selected before WebGL preserves ANSI palette
  - [x] Phase 2: VS Code-style flow control across Tauri boundary + Rust scanner hardening
    - [x] count unacked UTF-8 bytes in Rust; acknowledge completed xterm writes in ~5 KB increments
    - [x] coalesce PTY reads for ~5 ms before Tauri channel delivery without splitting a trailing ESC
    - [x] cap pending control sequences at 4 KB and flush raw on overflow
    - [x] test CSI 2J/3J mitigation; reject it after real Claude repaint corruption and preserve clears
    - [x] native replay + interactive shell verification
  - [x] Phase 3 follow-up moved to next-release dependency audit for a dedicated xterm.js 6.x branch
  - [x] Phase 4 follow-up retained under durable agent sessions for the Rust VT state core
