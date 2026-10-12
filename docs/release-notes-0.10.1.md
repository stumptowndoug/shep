# Shep 0.10.1

## Fixes

- **Muse chat messages no longer appear twice.** Muse's chat adapter repeats the
  message it's answering, and Shep added that repeat to the message it already
  showed, so each prompt read twice. Shep now shows it once. Reopening an earlier
  chat from History still restores its messages.
