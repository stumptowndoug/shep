# Shep 0.11.0

## New

- **See the agents your agent starts.** When Claude Code, Codex, Cursor, or Muse
  hands work to sub-agents, they appear as quiet rows in the turn that started
  them: what each is doing right now, how long it's been running, and whether it
  needs you. Click one to read its transcript in a panel beside the chat; Esc
  closes it. Approvals name the agent that's asking. (Muse workflows still show as
  a single tool row.)
- **Images in chat.** Paste a screenshot, drop image files on the message box, or
  pick them with the image button, for agents that accept images. Large images are
  scaled down before sending, and images queue with your follow-ups while the
  agent works.
- **@ for files.** Type `@` to pick a file from the project and mention it. The
  agent receives it as a link to the file, not just its name.
- **What a turn changed.** A finished turn ends with "Changed N files", folded
  like the work above it. Open it to see each file's diff from that turn, or open
  the file in your editor.
- **Copy buttons.** Code blocks in replies copy with one click, and so does a
  whole answer.
- **Change your mind about a queued message.** Hover a message waiting in the
  queue to edit it (it moves back into the message box) or remove it.

## Improvements

- **Calmer errors.** Agents fix most failed steps themselves (a search with no
  match, a command that exits with an error), so those now read like any other
  step, with a small "failed" beside them, instead of red rows that open
  themselves. Red is kept for an agent that actually stopped, and rate or usage
  limits show as a warning.
- **A shorter new-chat hint.**
