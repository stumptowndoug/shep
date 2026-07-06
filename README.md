# Shep

**A native terminal workspace for developers running projects, agents, and background tasks side by side.**

Shep gives each repo a dedicated workspace for terminals, AI coding agents, commands, and git-aware workflows. Instead of managing a pile of Terminal tabs, iTerm windows, and half-remembered shell commands, you open one app and work from a single place.

<p align="center">
  <img src="assets/shep.png" alt="Shep" width="200" />
</p>

## Why Shep

- Keep project terminals grouped by repo instead of spread across shell windows.
- Launch AI coding agents from the app with standard and auto-accept modes.
- Start common tasks quickly with saved commands and autostart behavior.
- See which sessions are running, stopped, or need attention without hunting for them.
- Automatically import existing git worktrees when you add a repo, and work in them from the same UI.

## What It Does

- **Project workspaces** for repos, tasks, agents, and terminal tabs
- **Assistant launcher** for Codex CLI, Claude Code, and Antigravity CLI
- **Git-aware project views** including discovered worktrees
- **Autostart tasks** for dev servers, watchers, and recurring commands
- **Status indicators** so crashed or noisy sessions are easy to spot
- **Usage tracking** for AI coding assistant costs across providers
- **In-app notices** for common failures instead of silent errors or browser alerts
- **Native macOS and Windows packaging** via Tauri

## Download

Download the latest release from [GitHub Releases](https://github.com/stumptowndoug/shep/releases).

**macOS** — download the `.dmg`:

1. Open the `.dmg`
2. Drag `Shep.app` into `Applications`
3. Launch Shep

**Windows** — download and run `shep_X.Y.Z_x64-setup.exe`.

Note: the current release flow is aimed at small-group testing. If the app is unsigned or not notarized, macOS may show an extra security prompt on first launch, and Windows SmartScreen may warn before running the installer.

## Requirements

For using Shep:

- macOS or Windows 10/11 (WebView2 Runtime is preinstalled on Windows 10/11; the installer fetches it if missing)
- git on PATH (on Windows: [Git for Windows](https://gitforwindows.org/))
- A local git repo to work from
- Any CLI agents you want to launch already installed on your machine

For building from source:

- Node.js 20+
- `pnpm`
- Rust via `rustup`
- macOS: Xcode Command Line Tools
- Windows: Visual Studio Build Tools 2022 with the "Desktop development with C++" workload (MSVC toolchain)

## Getting Started

### 1. Add a repo

Open Shep and add a local repository from the sidebar.

### 2. Configure tasks

Shep stores project configuration under `<repo>/.shep/workspace.yml`.

Example:

```yaml
name: my-app
commands:
  - name: dev server
    command: npm run dev
    autostart: true
    env: {}
    cwd: null
  - name: tests
    command: npm test -- --watch
    autostart: false
    env: {}
    cwd: null
assistants: []
```

### 3. Open workspaces and sessions

Use the sidebar and tab bar to:

- open project terminals
- launch assistants
- create blank shells
- jump into git or commands views
- switch projects without manually rebuilding your terminal layout

## Assistant Modes

Shep supports two session modes for supported coding agents:

| Mode | Purpose |
| --- | --- |
| `Standard` | Runs the agent in the current repo directory |
| `YOLO` | Runs the agent in the current repo directory with auto-accept when supported |

Worktrees are managed outside Shep. If you create one with git, adding the main repo or a worktree in Shep will automatically import the related entries Git already knows about, and you can use the same terminals, assistants, commands, and git UI there.

Supported today:

- Codex CLI
- Claude Code
- Antigravity CLI (`agy`)

Gemini CLI was removed from the launcher after Google deprecated it in favor of Antigravity CLI (consumer requests stop June 18, 2026). If you still use it (e.g. on an enterprise license), run `gemini` from any Shep terminal — historical Gemini usage stays visible in the usage panel.

## Build From Source

### Install dependencies

```bash
pnpm install
```

### Run in development

```bash
pnpm tauri dev
```

This starts the Vite frontend and the Tauri shell together.

### Create a production build

```bash
pnpm tauri build
```

### Create a debug-packaged build

```bash
pnpm tauri build --debug
```

Useful validation commands:

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

Build artifacts land here (release builds; debug builds land under `target/debug/bundle/`):

macOS:

- App bundle: `src-tauri/target/release/bundle/macos/shep.app`
- DMG: `src-tauri/target/release/bundle/dmg/`

Windows:

- Executable: `src-tauri/target/release/shep.exe`
- NSIS installer: `src-tauri/target/release/bundle/nsis/shep_X.Y.Z_x64-setup.exe`
- MSI: `src-tauri/target/release/bundle/msi/`

## Project Structure

```text
src/                    React frontend
src/components/         App UI
src/hooks/              UI and PTY lifecycle hooks
src/lib/                Shared helpers and Tauri bindings
src/stores/             Zustand stores

src-tauri/              Rust backend and Tauri config
src-tauri/src/commands.rs
src-tauri/src/pty/      PTY process management
src-tauri/src/workspace/
```

## Tech Stack

- React 19
- TypeScript
- Zustand
- Vite
- xterm.js
- Rust
- Tauri 2

## Reporting Issues

For tester reports, include:

- Shep version
- OS and version (macOS or Windows)
- whether the issue happened in dev mode or the packaged app
- the repo/workflow you were using
- anything visible in the terminal or notice UI

## Keyboard Shortcuts

On macOS, shortcuts use the native menu accelerators (⌘T, ⇧⌘T, ⌘G, …). On Windows, app shortcuts use Ctrl+Shift chords so plain Ctrl+letter keystrokes still reach the terminal:

| Action | macOS | Windows |
| --- | --- | --- |
| New Terminal | ⌘T | Ctrl+Shift+T |
| New Agent Session | ⇧⌘T | Ctrl+Shift+A |
| New Commands Panel | ⇧⌘C | Ctrl+Shift+M |
| New Git Panel | ⌘G | Ctrl+Shift+G |
| Open in Editor | ⌘E | Ctrl+Shift+E |
| Toggle Sidebar | ⌘B | Ctrl+Shift+B |
| Settings | ⌘, | Ctrl+, |
| Copy / Paste in terminal | ⌘C / ⌘V | Ctrl+Shift+C / Ctrl+Shift+V |

## Releases

Releases are built locally and published via GitHub Releases. See [docs/RELEASING.md](docs/RELEASING.md) for the full two-platform flow:

1. `./scripts/bump-version.sh X.Y.Z` — updates `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`, then commits the bump
2. macOS lane: `./scripts/release-build.sh` — builds, signs, notarizes, and generates `latest.json`
3. Windows lane: `pwsh scripts/release-build.ps1` — builds the NSIS installer and merges its entry into `latest.json`
4. Smoke test the artifacts, then `git tag vX.Y.Z && git push origin main vX.Y.Z`
5. `gh release create` with the artifacts from both lanes and the merged `latest.json`

## License

MIT
