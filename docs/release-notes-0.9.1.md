# Shep 0.9.1

## Improvements

- **Stop a chat the way you would in a terminal.** Esc or Ctrl+C stops the agent from
  anywhere in the chat, not only while typing. While the agent works, the message box
  shows "Esc to stop".
- **Recall earlier prompts.** Press ↑ in an empty message box to bring back your last
  prompt, and keep pressing to go further back. ↓ moves forward again.
- **Discover Chat.** If you use agents in the terminal, the New tab launcher shows a
  short tip about Chat until you try it or dismiss it. Your default doesn't change.

## Fixes

- **Links in chat open in your browser.** Links in agent replies (like a pull request
  an agent just opened) did nothing when clicked. Web links now open in your browser,
  and `file://` links open on your Mac.
- **Images in agent replies show up.** Screenshots and other local images an agent
  references now display inline (click one to open it in Preview), instead of a broken
  image. Remote images are shown as a link rather than loaded automatically, and images
  that can't be shown say why.
