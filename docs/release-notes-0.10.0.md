# Shep 0.10.0

## New

- **Muse Code.** Meta's coding agent joins Claude Code, Codex, Cursor,
  Antigravity, OpenCode, and Pi. Run `muse` in a terminal tab, with YOLO and model
  choice, or as a chat. Meta doesn't publish a chat adapter, so Shep installs the
  community [`muse-acp`](https://github.com/BrokkAi/muse-acp) with one click (it
  needs Node.js 22 or newer). Sign in with `muse login` first. Terminal sessions
  get titles, show when Muse is working or waiting on you, and resume from History.
- **Muse usage.** Usage and the sidebar track Muse's tokens by model and project
  from its session logs. Muse has no public way to read your plan's limits on
  demand, so its 5-hour and weekly limits appear once you chat with Muse in Shep,
  updated with each response.
- **A simpler New agent page.** The start screen is now just for agents. They sit
  on one row of tabs; pick one and its options open right beneath it: Chat or
  Terminal, Ask first or YOLO, and the model for Terminal. The page opens on the
  agent you started last. Setup lives there too: a dot marks an agent whose chat
  needs setting up, with the install button in the panel.
- **Everything else from the + menu.** The tab bar's **+** opens a menu that leads
  with New agent (still ⇧⌘T), then Terminal, Commands, Changes, To-dos, your
  editor, and Finder, with their shortcuts. The sidebar's **New agent** starts an
  agent directly, and **More** opens the same menu.

## Improvements

- **A quieter sidebar.** Sections are separated by space instead of boxes, every
  heading shares one style, and History, Usage, Ports, and Settings sit on their
  own bar at the bottom.
- **Calmer highlights.** The active tab, the active agent, and the open page are
  marked one gentle step past hover instead of a heavy block.
