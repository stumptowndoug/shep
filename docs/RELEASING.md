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
   frontend build, all unit/native/browser tests, Clippy with warnings denied, and both dependency
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

## Synthetic chat memory profile

Run `pnpm exec vite --host 127.0.0.1 --port 5176 --strictPort`, then in another
terminal run `node scripts/profile-chat-memory.mjs`. It uses the browser fixture
with mocked native calls, appends up to 2,000 turns with distinct 23 KB tool
outputs, verifies that only 50 turns render, and closes the tab through the real
UI. It also checks that only the recent 50 turns retain tool output. It repeats
three times and prints JavaScript heap samples after garbage
collection. No live agents or user history are accessed.

On 2026-10-11, before old payloads were trimmed, the development fixture used
about 29 MiB initially and 78 MiB at 2,000 turns. With old tool output, diffs,
and images trimmed, it used about 32 MiB at 500 turns, 33–34 MiB at 1,000 turns,
and 35 MiB at 2,000 turns. After the third close it returned to about 30.5 MiB,
within 1.6 MiB of its initial sample. Closed chats did not retain full payloads
in these checks. Message text and tool summaries still accumulate; this is not
a fixed memory cap, and a single recent turn can contain many tool results.

Trimming changes Shep's in-memory display only. Earlier message text remains
available, but old tool output, diffs, and image data are discarded with a visible
notice. There is no local transcript database or guaranteed reload of those
details: provider history and replay support vary.

These are Chromium JavaScript heap measurements. They do not measure native
allocations, WebKit/GPU processes, or live providers, and do not replace the
packaged long-session checks above.
