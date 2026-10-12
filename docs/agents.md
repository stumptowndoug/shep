# Agents in Shep

Details on how Shep runs and tracks each coding agent. For the overview, see the
[README](../README.md#supported-agents).

## Chat and Terminal

Every supported agent can run two ways:

- **Chat** talks to the agent through the [Agent Client Protocol](https://agentclientprotocol.com)
  (ACP). Shep renders replies, tool calls, diffs, and permission prompts natively.
- **Terminal** runs the agent's own CLI in a terminal tab, exactly as you would in
  any shell.

Choose per session on the New agent page, and set the default in Settings. New
installations default to Chat. History records which interface each session used
and resumes it the same way.

Chat for Claude Code, Codex, Pi, and Muse Code needs a separate ACP adapter (see the
[README table](../README.md#supported-agents)). If it isn't installed, the launcher's
**Install chat adapter** button installs a pinned version with your `npm` into
Shep's application data folder, so it works wherever npm puts global packages and
whatever is on your `PATH`. It needs Node.js. An adapter already on your `PATH`
takes precedence. Shep rereads your shell's `PATH` when a command is missing, so
CLIs and adapters installed while Shep is open are found without a restart.
Meta doesn't publish an ACP adapter for Muse Code, so Shep uses the community
[`@brokkai/muse-acp`](https://github.com/BrokkAi/muse-acp), which needs Node.js 22 or
newer. Sign in with `muse` (or set `META_API_KEY`) before starting a Muse chat.
Cursor and OpenCode include ACP support in their CLIs. For Antigravity, Shep downloads Google's chat runtime for
you and verifies it against pinned checksums. It is kept separate from `agy` and
never changes your CLI installation or `PATH`.

## Queued chat messages

Send a follow-up while the agent is working to queue it. Its text appears in the
conversation with a **Queued** label. All waiting messages are sent together, in
order, when the current turn finishes. Messages entered during startup wait until
the agent is ready.

Stop, Esc, or Ctrl+C stops the current response and marks waiting messages
**Not sent**, keeping their text in place. Messages submitted while Stop is still
taking effect are also marked **Not sent**; send a new message once the agent is
idle to start again. Startup failures and agent exits preserve waiting text the
same way. Queued and not-sent messages are kept only in the open chat tab; they
are not restored from History after closing the tab or restarting Shep.

## Standard and YOLO

| Mode | Behavior |
| --- | --- |
| Standard | The agent asks before editing files or running commands. |
| YOLO | Starts the agent with its auto-accept flag, so it edits and runs commands without asking. |

YOLO uses each CLI's own flag (for example `--dangerously-skip-permissions` for
Claude Code, `--yolo` for Codex, Cursor, and Muse Code). Pi has no auto-accept mode. In Chat,
the access control in the composer plays the same role.

## Antigravity usage

With `agy` 1.1.11 or newer, Shep reads subscription limits using the CLI's
authenticated `agy -p /usage --output-format json` report. Sign in through `agy`
once; Shep uses that existing login to show Gemini and Claude/GPT weekly and
five-hour limits. This read-only command does not start an agent turn or spend
model tokens, and works without an interactive Antigravity session open.

Older CLIs and desktop-only installations use the existing running-service
probe. If usage is unavailable, check that `/usage` works in `agy`. Refreshes
retain the last successful values in memory; they refresh at most every five
minutes after success and retry with backoff after failures.

## Muse Code usage

Shep reads Muse's token history from its session logs
(`~/.local/share/muse/sessions`), counting each model call once, by model and by
project. Subagent calls count toward the session that started them.

Muse has no public way to ask for subscription limits on demand: a fresh
`muse serve` only learns them from the responses to real requests. So Shep shows
Muse's 5-hour and weekly limits from the readings its chat adapter reports
during Muse chats, keeping the latest one. A 5-hour window whose reset time has
passed shows as started over, and a weekly reading past its reset is dropped
rather than shown stale. Until you've chatted with Muse in Shep, only token
history is shown.

## Gemini CLI

Gemini CLI was removed from the launcher after Google deprecated it in favor of
Antigravity CLI (consumer requests stop June 18, 2026). If you still use it (for
example on an enterprise license), run `gemini` from any Shep terminal.
Historical Gemini usage stays visible in the Usage page.
