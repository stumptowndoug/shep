# Shep 0.9.2

## Improvements

- **Set up chat with one click.** For Claude Code, Codex, and Pi, the launcher's
  **Install chat adapter** button now installs the chat adapter inside Shep, with no
  terminal and no changes to your global npm setup. Chat no longer breaks when npm
  installs global packages somewhere outside your `PATH` (common with Homebrew).
  It needs Node.js, and the button says so if it's missing. An adapter you already
  installed yourself is still used.
- **A calmer message box.** Below the message box are now just two buttons: the
  agent and model, and a gear with every other setting (reasoning, the agent's other
  options, and access), each listed by name with the current choice ticked. The gear
  shows a shield when the chat asks before acting. The box also starts a little taller.
- **Follow-ups you queue stay visible.** Messages you send while the agent works appear
  in the conversation labelled **Queued**, and all of them go together, in order, when
  the current turn finishes. Stopping marks them **Not sent** and keeps their text.

## Fixes

- **Agents installed while Shep is open are found.** Shep used to read your `PATH`
  only at launch, so a CLI or chat adapter installed afterwards stayed "not installed"
  until you restarted Shep. Shep now checks your shell's `PATH` again when something
  is missing.
