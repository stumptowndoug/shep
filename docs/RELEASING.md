# Releasing Shep

Release builds target macOS and must come from a committed revision. The build
script runs automated checks before loading signing credentials. It does not
publish a GitHub release or install the app.

## Prerequisites

- Node.js 24 or newer, pnpm 10, Rust 1.95 or newer, and Xcode Command Line Tools.
- `rustup component add clippy`
- `cargo install cargo-audit --locked`
- `pnpm exec playwright install chromium webkit`
- `jq` and the macOS signing/notarization tools.

Put these variables in the ignored root `.env` file. Never commit the file or keys:

```dotenv
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
APPLE_ID="your-apple-id"
APPLE_PASSWORD="app-specific-password"
APPLE_TEAM_ID="TEAMID"
TAURI_SIGNING_PRIVATE_KEY_PATH="/absolute/path/to/updater.key"
# Optional for an encrypted updater key:
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="key-password"
```

The Developer ID certificate and its private key must be available in Keychain.
The updater private key must match the public key in the Tauri configuration.

## Build and verify

1. Select the release version, update `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json`, and the package's entry in `Cargo.lock`, and write
   release notes. Commit the result.
2. Run `bash scripts/release-build.sh`. It requires committed tracked files and
   no untracked build inputs, installs with the frozen pnpm lockfile, runs the
   frontend build, all unit/native/browser tests, Clippy, and both dependency
   audits, then signs and notarizes the app and DMG. Cargo builds use `--locked`.
3. Record the printed commit ID with the generated artifacts. Rebuild if source
   files change. You can run `bash scripts/check-release.sh` independently of
   signing to check a development branch.

Local ignored settings, TODO.md, and untracked design documents are not included
in the release input check. Untracked source, assets, scripts, and tests are.
Rust maintenance advisories are still reported by the audit; review those for
the release's target platforms. Two native tests use live accounts/downloads and
are intentionally excluded from the regular suite.

## Required packaged checks

Use an isolated macOS account or a disposable test machine to avoid replacing
your everyday settings and sessions. Keep a copy of the 0.8.4 configuration and
history database before testing the upgrade.

- Fresh installation: add projects, choose an interface, start terminal and chat
  agents, and verify settings persist after restart.
- Upgrade from 0.8.4: verify project/group visibility, existing pin choices where
  recorded, legacy terminal resumes, and saved preferences/history.
- Provider matrix: exercise installed agents' sign-in, permission prompts,
  model/mode selection, cancellation, history resume, and startup failure.
- Quit and updater restart: test with terminal and ACP sessions, both Cancel and
  Confirm, and verify no agent descendants remain after exit. The updater must
  finish verification/installation before enabling Restart.
- Reload and long sessions: verify old ACP adapters stop after a reload; run a
  sustained terminal/chat session while observing frontend, backend, and agent
  memory. Exercise large diffs and outputs.
- Confirm Gatekeeper accepts the signed/stapled app and final DMG on a clean Mac.

Publish only after these checks pass. Tag the tested commit, push the intended
branch and tag, and attach the DMG, updater tarball, detached signature, and
`latest.json` to that version's GitHub release. Do not reuse artifacts from a
different revision.
