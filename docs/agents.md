# Agents in Shep

Details on how Shep runs and tracks each coding agent. For the overview, see the
[README](../README.md#supported-agents).

## Chat and Terminal

Every supported agent can run two ways:

- **Chat** talks to the agent through the [Agent Client Protocol](https://agentclientprotocol.com)
  (ACP). Shep renders replies, tool calls, diffs, and permission prompts natively.
- **Terminal** runs the agent's own CLI in a terminal tab, exactly as you would in
  any shell.

Choose per session in the New tab launcher, and set the default in Settings. New
installations default to Chat. History records which interface each session used
and resumes it the same way.

Chat for Claude Code, Codex, and Pi needs a separate ACP adapter (see the
[README table](../README.md#supported-agents)). Cursor and OpenCode include ACP
support in their CLIs. For Antigravity, Shep downloads Google's chat runtime for
you and verifies it against pinned checksums. It is kept separate from `agy` and
never changes your CLI installation or `PATH`.

## Standard and YOLO

| Mode | Behavior |
| --- | --- |
| Standard | The agent asks before editing files or running commands. |
| YOLO | Starts the agent with its auto-accept flag, so it edits and runs commands without asking. |

YOLO uses each CLI's own flag (for example `--dangerously-skip-permissions` for
Claude Code, `--yolo` for Codex and Cursor). Pi has no auto-accept mode. In Chat,
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

## Gemini CLI

Gemini CLI was removed from the launcher after Google deprecated it in favor of
Antigravity CLI (consumer requests stop June 18, 2026). If you still use it (for
example on an enterprise license), run `gemini` from any Shep terminal.
Historical Gemini usage stays visible in the Usage page.
