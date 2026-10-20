# Shep 0.12.0

## New

- **See and stop commands your agent leaves running.** When Claude Code or Codex
  starts a command in the background (a dev server, a watcher, a long build), it
  now gets its own row in the turn that started it: what's running, for how
  long, and a Stop button. Click the row to see the command and its output
  beside the chat, updating as it runs. The tool call that started it says "in
  background" instead of looking finished.
- **Jump back to background work.** When a running command or agent has
  scrolled out of view, a bar above the message box takes you back to it.
- **Chat agents stay up to date.** Chat runs each agent through its own adapter,
  separate from the CLI you use in terminal tabs, so CLI updates never reached
  it. Now, once a day at launch, Shep updates the chat adapter for every agent
  you've set up, in the background:
  - Claude, Codex, Pi and Muse get the newest release that has been out for at
    least three days.
  - Antigravity gets Google's newest release, accepted only with Google's code
    signature.
  - A new version is used only if it starts and answers correctly; otherwise
    chat keeps the version it has.
  - Agents you haven't set up chat for download nothing.
- **See which adapter a chat runs.** The chat settings menu (the gear) shows the
  adapter's name and version.

## Improvements

- **Command output streams live.** Codex command output used to appear only when
  a command finished; now it fills in as the command runs, for Claude too.
- **Closing a chat asks first** when it still has background commands or agents
  running, since closing stops them.
- **Shep's own adapter copies come first.** If you also installed a chat adapter
  yourself (for example with `npm i -g`), chat now uses Shep's up-to-date copy.
