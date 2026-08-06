# Next-release dependency audit — August 2026

Status: in progress · 2026-08-06

This audit starts from the completed xterm.js 6 / terminal-pipeline work. The
terminal upgrade remains isolated on `upgrade/xterm-6-phase-3`; this branch
handles the broader next-release dependency review.

## Baseline

- Frontend: Node 26, pnpm 10.32.1, React 19, Vite 7, TypeScript 5.9.
- Desktop: Rust 1.94 locally; `src-tauri/Cargo.toml` still declares MSRV
  1.77.2.
- Initial `pnpm audit`: 17 findings (9 high, 6 moderate, 2 low).
- Initial RustSec scan: 8 vulnerability entries, plus 19 unmaintained and 6
  unsound-package warnings in the current multi-platform lockfile.

The dependency work is intentionally divided into compatibility lanes. A
single all-at-once update would combine frontend majors, native binaries, the
Tauri stack, and more than 200 Rust lockfile changes, making regressions hard to
attribute.

## Lane 1 — same-major frontend security updates

Implemented on this branch:

- `markdown-it` 14.1.1 -> 14.3.0. Shep enables linkification in
  `src/lib/markdownRenderer.ts`, so the markdown/link parser advisories are
  runtime-relevant rather than build-only.
- Vite 7.3.1 -> 7.3.6 and `@vitejs/plugin-react` 5.1.4 -> 5.2.0.
- Narrow pnpm overrides select patched versions that are within Vite 7.3.6's
  own published ranges: esbuild 0.28.1, picomatch 4.0.4, and PostCSS 8.5.23.
  The React plugin now resolves patched Babel 7.29.7 without an override.

After this lane, `pnpm audit` reports one remaining finding: Sharp/libvips.
TypeScript, the Vite production build, and all 41 Rust tests pass. The build
still emits its existing large-chunk warning and a Node 26 `module.register()`
deprecation from the toolchain; neither is introduced as an application error
by this batch.

## Lane 2 — Sharp 0.35 native-binary update

Upgrade Sharp 0.34.5 to 0.35.x separately. The current high-severity audit
finding is inherited from bundled libvips. Shep currently uses Sharp only from
`scripts/generate-icon.mjs`, so the app does not process user-provided images,
but release tooling should still move to the patched native package.

Verification should regenerate every application icon on each supported build
host and compare dimensions, alpha, color profile, and packaging output. This
is kept separate because Sharp and libvips are native, platform-specific
artifacts despite Sharp's 0.x version change looking small.

## Lane 3 — Tauri and Rust lockfile refresh

`cargo update --dry-run -v` identifies roughly 213 compatible lockfile changes.
Notable direct-compatible moves include Tauri 2.10 -> 2.11 and tauri-build
2.5 -> 2.6. A current RustSec scan finds:

- four entries across quick-xml 0.37.5 and 0.38.4;
- one entry for rkyv 0.7.46;
- three entries for rustls-webpki 0.103.10.

The dry run advances the Tauri/plist XML chain and updates rustls-webpki to a
patched compatible release, but it also changes a broad platform dependency
surface. Land this as its own branch/PR, inspect why both quick-xml versions and
rkyv remain in the all-target graph, then run the full Rust suite plus native
updater, PTY, notification, shell, persistence, and packaging checks. Re-run
RustSec after the refresh; do not silence advisories merely because a vulnerable
crate is platform-specific without documenting the reachable target.

The same pass should reconcile the declared Rust MSRV with the actual Tauri and
dependency requirements. Raising MSRV is a release policy decision, not an
incidental lockfile edit.

## Lane 4 — API/toolchain majors

Defer these until release notes and Shep call sites are reviewed in dedicated
branches:

- Vite 8 and `@vitejs/plugin-react` 6;
- Shiki 4 and `@shikijs/markdown-it` 4;
- markdown-it 15;
- TypeScript 7;
- lucide-react 1.x;
- Rust direct majors such as notify 8, rusqlite 0.40, portable-pty 0.9, and
  core-text 22.

These upgrades are not needed to close the immediately reachable frontend
advisories. Keeping them separate preserves a clear rollback boundary and lets
each branch carry its own migration notes and focused regression coverage.

## Release validation matrix

For every landed lane:

- run TypeScript and the production frontend build;
- run the full Rust test suite;
- run `pnpm audit` and RustSec, recording any accepted residual finding;
- exercise a normal interactive shell and Claude/OpenCode terminal sessions;
- replay the Phase 0 heavy-scrollback/mode-2026 harness and verify continuous
  paint, manual-scroll hold, and resumed bottom follow.

Native or toolchain lanes add their own checks: icon regeneration for Sharp;
updater, OS integration, PTY, persistence, and packaging for Tauri/Rust.
