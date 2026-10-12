# Shep 0.10.2

## Fixes

- **No more blank window after a reply with SQL.** When a chat reply finished with
  a code block in a language Shep's highlighter didn't know (SQL, diff, and many
  others), the whole window went blank and couldn't be closed. Those blocks now
  show as plain code. If Shep ever hits an error drawing the window again, it shows
  what went wrong with a **Reload Shep** button instead, and closing still works.
- **Codex YOLO uses the current flag.** Codex no longer documents `--yolo`, so YOLO
  sessions now start with `--dangerously-bypass-approvals-and-sandbox`, which does
  the same thing.

## Improvements

- **Much more code is highlighted.** SQL is highlighted right away, including
  blocks labelled with a dialect such as `postgres`, `mysql`, or `snowflake`. About
  30 more languages (Java, Kotlin, Swift, C, C++, C#, Ruby, PHP, Terraform,
  GraphQL, Vue, Svelte, and others) load the first time a reply uses them, so
  Shep starts as fast as before.
- **Muse edits show in color.** Muse reports its edits as text diffs; added and
  removed lines are now green and red, with a count on the tool row.
- **Edit rows name the file.** Every agent's file edits and reads now show just the
  file name, instead of a full path or "Editing files".
