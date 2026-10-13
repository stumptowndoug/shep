# Shep 0.11.1

## Improvements

- **Chat stays with the reply.** While an agent writes, the chat follows the
  newest line and keeps it just above the message box. Scroll up to read and it
  holds still; scroll back to the end, press **Latest**, or send a message and it
  follows again. It no longer drops out on its own partway through a reply, after
  a trackpad bounce, or when a turn finishes.
- **One row for the agent's work.** While a turn runs, its thinking, tool calls,
  and in-between notes fold into a single "Working" row that shows what the agent
  is doing right now, with an icon and the file or command. Open it to see every
  step. When the turn ends it simply becomes "Worked", with the answer below it.
- **Replies arrive smoothly.** Some agents send most of an answer at once. Replies
  now appear at a steady pace instead of landing in one block, and finish right
  after the agent does.
- **Long replies stay readable.** Replies are rendered as markdown up to 100,000
  characters (up from 24,000), and nothing changes form while it's being written.
  A finished reply past that length shows in full as plain text, with no extra
  click.

## Fixes

- **No more flickering doubled chat** while a long reply streams in on macOS.
