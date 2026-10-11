# Shep 0.9.0

A big one: agents can now run as a native chat as well as in the terminal, the
sidebar becomes a working set of the projects you're actually using, and the file
browser is replaced by a focused Changes panel.

## New

- **Chat with your coding agents.** Start Claude Code, Codex, Cursor, Antigravity,
  opencode, and Pi in a chat view with streaming replies, tool and
  diff cards, permission prompts, model/reasoning/access controls, slash command
  suggestions, and saved drafts. Chat and terminal sessions are both recorded in
  History and resume in the interface they started in. New installs default to
  chat; existing users keep the terminal and can switch in Settings.
- **Managed Antigravity runtime.** Shep can download and install Antigravity's
  chat adapter for you, verified against pinned checksums, with Google sign-in.
- **Projects page and ⌘P switcher.** The sidebar now shows groups, pinned
  projects, and projects with open tabs. Everything else lives on the new Projects
  page (search, groups, drag between groups, pinning) and in the ⌘P switcher.
  Worktrees nest under their main checkout.
- **New tab launcher.** The tab bar's + opens a launcher: pick an agent, or open
  a Terminal, Commands, Changes, To-dos, your editor, or Finder.
- **Changes panel.** See only what changed: status, folder, and +/− counts beside
  the diff, a Working/Staged switch, Markdown previews, merge-conflict markers, and
  open-in-editor. Opens from the header's branch button or ⌘G.
- **First-run welcome.** New users see detected agent CLIs and recently used repos
  from Claude Code and Codex history to add in one click.

## Improvements

- Redesigned Usage: one consistent layout for limits, agents, models, and
  projects. Project usage is matched to your Shep projects (worktrees roll into
  their checkout), and model names are readable. Cost is no longer shown.
- Refreshed workspace design: island-style sidebar, restyled Commands, Ports, and
  History pages, and fast tooltips throughout.
- Long chats stay light: only recent turns render, streamed text is batched, and
  older tool output, diffs, and images are trimmed from memory with a notice.
- Git scans are shared and bounded, large diffs are capped instead of freezing
  the window, and Shep's own reads no longer contend with agents for
  `index.lock`.
- Better keyboard support for project menus, the switcher, and selects.

## Reliability and upgrades

- Your projects and groups stay visible after upgrading, and existing terminal
  sessions resume in the terminal.
- Configuration is saved atomically, with a backup of the previous copy.
- Quitting or restarting for an update waits for agent cleanup, and Restart is
  only offered once the update has finished installing. Chat adapters are cleaned
  up if the window reloads.
- Autostart commands and newly started sessions always open in the project they
  were launched for.
- Stop gives agents time to finish their current step before closing them.

## Removed

- The Files panel (repository tree, file viewer, and search) has been replaced by
  the Changes panel.
