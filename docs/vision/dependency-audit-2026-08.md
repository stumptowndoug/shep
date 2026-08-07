# Next-release dependency audit — August 2026

Status: complete · 2026-08-06

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

## Lane 2 — icon tooling

Completed on `upgrade/sharp-0.35` (`33118d6`). Sharp was only used by the
one-off `scripts/generate-icon.mjs`; removing both and using Tauri's built-in
`tauri icon assets/shep.png` command eliminated the libvips advisory and a
native build dependency without changing application runtime behavior.

The generated icon set and native packaging output were checked on the focused
branch.

## Lane 3 — Tauri and Rust lockfile refresh

Completed on `upgrade/tauri-2.11-rust-lock` (`8c900a2`) and incorporated into
the integration graph. Direct moves include Tauri 2.10 -> 2.11, tauri-build
2.5 -> 2.6, and corresponding JavaScript API/CLI/plugin releases. The combined
lockfile was freshly resolved under Rust 1.95, replacing the vulnerable
quick-xml, rkyv, and rustls-webpki versions identified in the baseline.

The declared source-build requirement is now Rust 1.95 because rusqlite 0.40's
dependency graph uses APIs stabilized in that release. README and Cargo
metadata carry the same requirement.

## Lane 4 — API/toolchain majors

Reviewed and completed in dedicated branches before integration:

- Pierre Diffs 1.3 / Shiki 4 (`26ed9aa`);
- Vite 8 / React plugin 6 / Tailwind 4.3 (`3cdab2b`);
- markdown-it 15 (`469c724`), preserving Shep's bare-domain link behavior;
- TypeScript 7 (`9ab8a58`) and lucide-react 1 (`bb7ec02`);
- notify 8 (`d2c29a4`), core-text 22 (`9749cd2`), portable-pty 0.9
  (`07f79bf`), and rusqlite 0.40 (`35d01a9`).

Each focused branch passed its relevant build/test and native smoke checks.
They remain separate rollback boundaries even though this integration branch
combines their approved results for the next release.

## Integrated result

`integration/next-release-dependencies` combines the approved lanes and
regenerates both lockfiles from the final manifests.

- `pnpm audit`: no known vulnerabilities.
- `pnpm build`: TypeScript 7 and Vite 8 production build passes. The existing
  large-chunk warning remains informational.
- `cargo +1.95.0 test --locked`: all 41 tests pass, including PTY flow control,
  fresh-database migration/seeding, and usage-provider ingest coverage.
- RustSec: no blocking vulnerabilities. The all-target lockfile retains 17
  allowed warnings for GTK3-era Linux transitive crates, proc-macro-error, and
  legacy unic crates; these are tracked as dependency-ecosystem warnings rather
  than suppressed application vulnerabilities.
- Native Tauri 2.11 development build launches cleanly with terminal color
  suppression removed from the automation environment.
- Final hands-on integrated smoke testing passed terminal output/colors,
  renderer/theme switching, scrolling/follow behavior, platform/database/font
  settings, Git diffs, Markdown rendering, and normal shell/agent use.

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
