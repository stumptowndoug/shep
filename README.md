# Shep

**A macOS workspace for running AI coding agents across all your projects, as a chat or in their own terminal.**

Shep keeps your agents, terminals, commands, and git changes together, organized by
project. Start Claude Code, Codex, Cursor, Antigravity, OpenCode, Pi, or Muse Code in a click,
see which sessions are working or waiting on you, review what they changed, and keep
an eye on your usage limits, all from one window instead of a pile of terminal tabs.

<p align="center">
  <img src="assets/shep.png" alt="Shep" width="160" />
</p>

<!-- TODO: hero screenshot (sidebar + a chat tab + Changes panel), e.g.
<p align="center"><img src="docs/images/shep-0.9.png" alt="Shep with a chat session and the Changes panel" width="900" /></p>
-->

## Why Shep

- **Every agent in one place.** Run several agents across several repos and see at
  a glance which are working, done, or waiting for you.
- **Chat or terminal, your choice.** Use a native chat view with tool cards, diffs, and
  permission prompts, or the agent's own CLI in a terminal tab.
- **A sidebar that stays focused.** It shows the projects you're working in: groups,
  pinned projects, and anything with open tabs. Everything else is one ⌘P away.
- **See what changed.** The Changes panel shows only the files your agents touched,
  with their diffs.
- **Know your limits.** Usage tracks tokens by agent, model, and project, plus each
  provider's rate limits.

## Features

- **Agents.** Chat and terminal sessions for six coding agents, with Standard or
  YOLO (auto-accept) modes, model selection, and saved drafts.
- **Projects.** Groups, pinning, a Projects page, and a ⌘P switcher. Git worktrees are
  picked up automatically and nest under their main checkout.
- **New tab launcher.** Pick an agent, or open a terminal, Commands, Changes,
  To-dos, your editor, or Finder.
- **Changes.** Changed files with +/− counts, Working/Staged views, Markdown
  previews, merge-conflict markers, and open-in-editor.
- **Commands and Ports.** Saved per-project commands (dev servers, watchers, tests)
  with optional autostart, and a view of what's listening on which port.
- **History.** Browse past agent sessions and resume them where they left off.
- **Usage.** Token activity by agent, model, and project, with provider limits in
  the sidebar.
- **To-dos and skills.** A `TODO.md` kanban board your agents can keep up to date,
  and installable agent skills such as `/orchestrate`.

## Supported agents

| Agent | Terminal (CLI) | Chat (ACP adapter) | YOLO |
| --- | --- | --- | --- |
| Claude Code | `claude` | Installed by Shep from the launcher (needs Node.js) | ✓ |
| Codex | `codex` | Installed by Shep from the launcher (needs Node.js) | ✓ |
| Cursor | `cursor-agent` | Included with the Cursor CLI | ✓ |
| Antigravity | `agy` | Installed by Shep from the launcher | ✓ |
| OpenCode | `opencode` | Included with OpenCode | ✓ |
| Pi | `pi` | Installed by Shep from the launcher (needs Node.js) | — |
| Muse Code | `muse` | Community adapter, installed by Shep from the launcher (needs Node.js 22+) | ✓ |

Install the CLI for any agent you want to run in a terminal. Chat needs the adapter
in the third column; when one is missing, the launcher offers to install it. An
adapter you already installed yourself (for example with `npm i -g`) is used instead. See
[docs/agents.md](docs/agents.md) for how the two interfaces and modes differ.

## Download

Download the latest `.dmg` from [GitHub Releases](https://github.com/stumptowndoug/shep/releases),
open it, and drag **Shep.app** into **Applications**. Release builds are signed and
notarized, and Shep updates itself in place.

Requires macOS.

## Getting started

1. **Add a project.** On first launch, Shep shows which agent CLIs it found and
   suggests git repos you've recently used with Claude Code or Codex. Add one with a
   click, or choose any folder.
2. **Open a New tab** with the **+** in the tab bar (⌘⇧T) and pick an agent. Choose
   Chat or Terminal, and Standard or YOLO.
3. **Work across projects.** Switch with the sidebar or ⌘P. Sessions keep running
   in the background, and the sidebar shows which need your attention.
4. **Review changes** with the branch button in the header (⌘G).

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘P | Switch project |
| ⌘⇧P | All projects |
| ⌘⇧T | New tab |
| ⌘T | New terminal |
| ⌘G | Show Changes |
| ⌘⇧C | Commands |
| ⌘E | Open project in editor |
| ⌘B | Toggle sidebar |
| ⌘, | Settings |

## Project configuration

Commands you save in Shep are stored in `<repo>/.shep/workspace.yml`, so you can
commit them and share them with your team:

```yaml
name: my-app
commands:
  - name: dev server
    command: npm run dev
    autostart: true
  - name: tests
    command: npm test -- --watch
    env:
      CI: "1"
    cwd: packages/web
```

`autostart` commands start the first time you open the project in a session. `env`
and `cwd` are optional; `cwd` is relative to the repo.

## Build from source

Requires Node.js 24+, pnpm 10, Rust 1.95+ (via `rustup`), and Xcode Command Line Tools.

```bash
pnpm install --frozen-lockfile
pnpm tauri dev      # run the app in development
pnpm test           # unit, Rust, and browser tests
pnpm tauri build    # production build → src-tauri/target/release/bundle/
```

`bash scripts/check-release.sh` runs the full set of release checks without signing.

### Project structure

```text
src/                 React frontend (components, hooks, Zustand stores, lib)
src/lib/acp/         Chat sessions and the ACP client
src-tauri/src/       Rust backend: PTYs, ACP processes, git, workspace config, usage
tests/               Unit tests and Playwright browser tests
docs/                Agent details, release process, and release notes
```

Built with Tauri 2, Rust, React 19, TypeScript, Zustand, Vite, and xterm.js.

## More docs

- [Agents: chat vs. terminal, modes, Antigravity usage](docs/agents.md)
- [Release notes](https://github.com/stumptowndoug/shep/releases)
- [Releasing Shep](docs/RELEASING.md)

## Reporting issues

[Open an issue](https://github.com/stumptowndoug/shep/issues) and include your Shep
version, macOS version, the agent and interface (Chat or Terminal) you were using,
and any notice Shep showed.

## License

[MIT](LICENSE)
