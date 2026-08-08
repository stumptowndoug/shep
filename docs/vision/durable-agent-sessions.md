# Durable agent sessions

Status: deferred · architecture decisions recorded 2026-08-05 (see "Research
findings and decisions") · companion doc: `docs/vision/terminal-pipeline.md`

Product direction changed 2026-08-06: prioritize a cross-provider history of
locally saved agent sessions with explicit, provider-native resume actions.
Shep should retain its current quit behavior and stop its child processes.
Persistent background PTYs remain a researched option if user demand later
justifies agents continuing after Shep exits; they are not current scope.
Everything below describes that deferred design and is retained as technical
reference rather than an active delivery plan.

## Vision

Shep should be a reliable home for long-running coding-agent work. If an agent
appears in Shep, closing or restarting the Shep interface should not destroy
that work. When the underlying process cannot survive, Shep should either
resume the same provider conversation or explain clearly why it cannot.

This is broader than restoring Claude Code and Codex tabs. Durable sessions
must be a platform capability shared by every coding agent Shep supports,
including Claude Code, Codex, Antigravity, OpenCode, Pi, and future agents.

The product promise is:

> Shep keeps an agent alive when it can, resumes the same conversation when it
> must, and never silently replaces or discards a session it cannot recover.

## Why this matters

A coding-agent session is not an ordinary shell. It can represent hours of
conversation, a partially completed plan, accumulated knowledge of a codebase,
running tools or subagents, and a question waiting for the user. The valuable
state spans several owners:

- the operating-system process and PTY;
- the vendor's durable conversation or session;
- the original working directory;
- the tab's placement, label, and launch options in Shep;
- the user's intent to keep or close the work.

If the Shep window owns the lifetime of all of those things, a UI crash, app
update, or accidental quit can destroy work. Users will respond by running
important agents in tmux or separate terminals, leaving Shep as a launcher
rather than the system they trust to manage ongoing work.

## Distinguish the recovery cases

Different interruptions need different mechanisms:

| Interruption | Desired behavior | Primary mechanism |
| --- | --- | --- |
| Shep window closes | Agent continues uninterrupted | Detach the GUI from a persistent PTY host |
| Shep GUI crashes | Agent continues uninterrupted | Reconnect to the persistent PTY host |
| Agent process crashes | Preserve a retryable conversation reference | Vendor adapter and explicit recovery state |
| PTY host restarts | Recreate tabs and resume supported conversations | Durable snapshot plus vendor adapter |
| Machine reboots | Recreate tabs and resume supported conversations | Durable snapshot plus vendor adapter |
| User closes a session | Stop it and do not restore it | Persist user intent before terminating |

The common case should not require a provider-specific resume command. Keeping
the original process alive is both more reliable and more universal than
reconstructing it.

## Architecture

Durable sessions have two layers:

```text
Shep GUI
   |
   | attach, input, resize, observe
   v
Persistent PTY host
   |
   | owns live process and terminal state
   v
Coding agent process

If the PTY host or machine stops:

Durable session record -> Agent adapter -> Vendor resume command
```

### Terminal stack and Herdr comparison

"Ghostty or tmux" is not a single implementation choice. They sit at
different layers of the terminal stack:

| Layer | Current Shep | Herdr | Role in durability |
| --- | --- | --- | --- |
| Outer terminal application | Shep's desktop window | Any compatible terminal, including Ghostty, iTerm2, Kitty, or Alacritty | Presents the user interface; it should be replaceable without killing sessions |
| Terminal emulation and screen state | xterm.js in the WebView | A single vendored `libghostty-vt` engine | Interprets terminal byte streams and maintains the visible screen |
| PTY/process owner | `portable-pty` inside the Tauri application | Herdr's background server | Determines whether processes survive UI detach or failure |
| Multiplexing and reconnection | Tied to the current Shep application process | Implemented by Herdr itself | Provides stable sessions that clients can leave and reattach |

Herdr is therefore not selecting among Ghostty, tmux, and other terminal
backends. It is its own multiplexer and PTY server, runs inside the user's
chosen outer terminal, and uses `libghostty-vt` as its terminal-state engine.
It does not use the Ghostty application or UI. tmux can be an outer or nested
environment, but it is an alternative multiplexer rather than a rendering
engine that Herdr swaps in.

Verified against Herdr's source (2026-08-05): the `libghostty-vt` integration
is hand-rolled in-tree FFI (`src/ghostty/bindings.rs` + a vendored build), not
a crates.io dependency; the PTY layer is a vendored, patched `portable-pty`.
Their reattach strategy is instructive: for primary-screen panes the old
server exports **recent raw ANSI history** and the new server seeds it before
streaming live bytes; for alternate-screen apps (vim, btop) they deliberately
do best-effort and let the app redraw. Full VT-state serialization is not
required for a useful v1.

Shep does not need to replace xterm.js to gain persistence. The first
architecture decision is who owns the PTYs after the GUI exits: a dedicated
tmux server or a Shep-owned daemon. xterm.js versus `libghostty-vt` is a
separate rendering and terminal-state decision that can be evaluated later on
its own compatibility and performance merits. Keeping these boundaries clean
also makes a future CLI client or a different desktop renderer possible
without changing session identity or recovery.

### Research findings and decisions (2026-08-05)

From the terminal-pipeline research pass (VS Code internals, Herdr source,
Rust VT-library survey — details and sources in
`docs/vision/terminal-pipeline.md`):

1. **PTY host**: build `shep-ptyhost` in Rust; do not adopt tmux or Herdr as
   the core (see decision under "Persistent PTY host").
2. **Screen continuity, v1 — raw-history replay.** Keep a bounded ring buffer
   of raw PTY output per session (tail of recent ANSI bytes). On attach, seed
   the client with that history, then stream live. This is Herdr's shipped
   approach for primary-screen panes; alternate-screen apps get best-effort
   and redraw themselves. No VT serialization needed for the first milestone.
3. **Screen continuity, v2 — VT state machine behind a trait.** For accurate
   reattach (cursor, modes, precise screen) and for host-side stuck-agent
   detection, add a server-side emulator behind a trait:
   - **avt** (asciinema's VT, Apache-2.0, active): `dump()` re-emits full
     state — both buffers, modes, saved contexts — as escape sequences, plus
     incremental scrollback streaming; purpose-built for late-joiner replay.
     Preferred starting point.
   - **alacritty_terminal** (Zed's core): maximum fidelity incl. mode 2026,
     but requires writing a grid→escape-stream serializer (~few hundred
     lines).
   - **libghostty-vt**: best emulation core long-term (it is Ghostty's and
     Herdr's engine), but adopt only when upstream tags a stable release with
     a stable C API and prebuilt libs. Today the Rust bindings are
     third-party (0.2.x, pinned to a Ghostty commit) and require a Zig 0.16
     toolchain in the build — unacceptable friction for our notarized release
     build. Herdr absorbs that cost with hand-rolled vendored FFI; that is a
     reasonable choice for a dedicated terminal-infra project, not for us
     today. The trait boundary exists so this swap is cheap later.
   - Avoid wezterm's unpublished crates as dependencies (git-only,
     maintenance risk); treat its mux architecture as reference.
4. **xterm.js stays the renderer.** Persistence and rendering are separate
   layers; nothing here replaces the WebView terminal.
4b. **Build-vs-adopt for the host itself (researched 2026-08-05): roll our
   own; the pieces are the reuse.** No existing project shortens the
   "daemon + unix socket + ring buffer + attach protocol" build without
   dragging in a product:
   - **shpool** (Google, Apache-2.0, 0.11.0) is the closest analog and the
     best *reference implementation* (session registry, output spool,
     reattach/SIGWINCH, stale-socket cleanup) but a poor dependency: macOS is
     second-class with failing tests, lifecycle assumes systemd, its attach
     protocol is explicitly non-public, `libshpool` only embeds the whole
     CLI, and it re-renders reattach from its own vt100 fork instead of raw
     history. Read it; don't depend on it.
   - **zellij-server** is an internal crate of zellij (huge footprint,
     resurrection model recreates processes rather than preserving them) —
     reference only. **rmux** has a real embeddable SDK but is a full
     tmux-class multiplexer with pre-1.0 protocol churn — same "too much
     machine" objection that rejected tmux. **diss/tab-rs/dtach/abduco** are
     stale or don't preserve state. **oly** (2026) independently converged on
     our exact stack (portable-pty + unix socket + persisted scrollback
     replay) but is a product binary, not a library — useful validation.
   - **Chosen stack**: a small daemon binary in the Shep workspace —
     `portable-pty` 0.9 (already a dependency) + `tokio` UnixListener +
     length-delimited frames (`tokio-util`) with a tiny tagged protocol
     (serde/postcard for control messages, raw bytes for the ANSI stream) +
     byte-capped raw-output ring buffer (~1–4 MB/session) + spawn-on-demand
     with pidfile and stale-socket cleanup; optionally graduate to an
     `SMAppService` LaunchAgent (socket activation, auto-restart) later.
   - The genuinely novel parts — ack-based flow control and the
     history-seed→live-stream handoff (sequence marker so the client knows
     where replay ends) — exist in none of these projects and must be
     written either way. Estimated core: ~1–2k LOC we fully own.
5. **First milestone (proves the architecture):** one Claude Code session
   survives quitting Shep and reattaches with a correct primary screen via
   raw-history replay. Everything else layers on that.

### 1. Persistent PTY host

The Tauri window should not directly own long-lived PTYs. A separate runtime
should own them and expose a local IPC surface for attaching, detaching,
streaming output, sending input, resizing, and terminating sessions.

**Decision (2026-08-05): build the Rust host (`shep-ptyhost`), extracted from
`src-tauri/src/pty/`.** tmux is rejected as the core (external runtime
dependency, tmux owns scrollback/replay semantics, no Windows path). Driving
Herdr via its socket API was considered; a one-day spike remains optional, but
owning the host keeps session naming, usage tracking, and stuck-agent
detection native to Shep, and Herdr's protocol serves its own TUI client.

Host shape:

- Small headless daemon, spawned by Shep on demand, surviving GUI exit.
- IPC over a user-private Unix socket.
- The attach protocol reuses the flow-control design from
  `docs/vision/terminal-pipeline.md` Phase 2 (VS Code watermarks: pause pty
  reads above ~100k unacked bytes, client acks from xterm write callbacks) —
  the scroll-fix work and this host are one architecture, built once.

Closing the GUI should detach from the host. A separate, explicit action should
stop the host and its sessions.

### 2. Generic durable session record

Persistence must describe Shep's session, not a Claude- or Codex-specific
record. A durable record should contain at least:

```text
id
agent_adapter_id
agent_adapter_version
launch_working_directory
placement_project_path
label
launch_options
desired_state
runtime_state
session_reference_kind
session_reference_value
recovery_state
last_exit_reason
created_at
updated_at
```

Important distinctions include:

- `desired_state`: whether the user wants the session kept or closed;
- `runtime_state`: live, detached, exited, or unknown;
- `recovery_state`: unavailable, pending, captured, restoring, or retryable
  failure;
- `last_exit_reason`: user close, GUI detach, host shutdown, process crash,
  machine recovery, or unknown.

An exit event is an observation, not sufficient evidence that the user wanted
the session deleted.

### 3. Agent adapter contract

Every entry in Shep's coding-agent registry must declare an adapter. The core
session manager should not contain provider `match` branches.

An adapter should declare capabilities and implement behavior equivalent to:

```text
id()
capabilities()
build_new_argv(launch_options)
build_resume_argv(session_reference, launch_options)
validate_session_reference(session_reference)
capture_strategy()
minimum_integration_version()
```

Capabilities should be independent. An integration may provide session
identity without being authoritative for working, idle, or blocked state.

Supported capture strategies are:

- `caller_assigned`: Shep provides an ID before launch;
- `integration_report`: a vendor hook, plugin, or extension reports the native
  session reference to Shep;
- `transcript_discovery`: a bounded compatibility fallback when no supported
  integration exists;
- `unavailable`: the agent can run but cannot be reconstructed after process
  loss.

No adapter may persist arbitrary executable strings supplied by a session
record. Executables and argument shapes come from installed, versioned adapter
code; session references remain data.

### 4. Integration reporting

For vendors that expose hooks, plugins, or extensions, Shep should provide an
opt-in installer and a local reporting endpoint. A Shep-launched agent receives
environment variables containing a stable Shep session ID and the local socket
location. Its integration reports the native session ID or path against that
stable identity.

Installers must be explicit, versioned, idempotent, and reversible. They may
modify only namespaced Shep-owned files or configuration entries. Shep must
show what will change before installation and provide a matching uninstall
operation.

Transcript discovery should be a fallback rather than the primary strategy.
Working-directory and timestamp correlation cannot safely identify concurrent
same-directory sessions in all cases.

### 5. Persistence

The persistence mechanism is secondary to the lifecycle model, but it must
provide transactional state transitions. If the PTY host becomes a separate
process, use a dedicated SQLite database such as
`~/.shep/session-state.db`, owned by that process. Keep it separate from usage
analytics.

SQLite should provide:

- atomic transitions between desired, runtime, and recovery states;
- unique constraints for Shep session IDs and active native references;
- schema migrations;
- retry history and actionable failure details;
- safe coordination between a reconnecting GUI and the PTY host.

If the runtime remains a single-writer snapshot service, an atomically replaced
versioned JSON file can also be correct. In either design, in-memory state must
not advance when durable persistence fails.

## Initial adapter matrix

All agents currently shown in Shep must be covered before the feature is called
complete:

| Agent | Native reference | Preferred capture | Resume command |
| --- | --- | --- | --- |
| Claude Code | Session ID | Caller-assigned ID, confirmed by hook | `claude --resume <id>` |
| Codex | Session ID | Opt-in session hook | `codex resume <id>` |
| Antigravity | Conversation ID | Opt-in invocation hook | `agy --conversation <id>` |
| OpenCode | Session ID | Opt-in plugin reporting the root session | `opencode --session <id>` |
| Pi | Session ID or session-file path | Caller-assigned ID or opt-in extension | `pi --session <id-or-path>` |

Adapter tests must verify current CLI argument ordering, identity validation,
integration version compatibility, concurrent launches, and failure behavior.

## User experience

The UI should communicate stable, provider-neutral states:

- **Running**: the original process is live.
- **Detached**: the process is live but no GUI is attached.
- **Recovery ready**: a native reference is available if process recovery is
  needed.
- **Live only**: the process can survive GUI restarts but cannot be resumed
  after host or machine loss.
- **Recovery failed**: the saved session remains available with Retry and
  Discard actions.
- **Closed**: the user explicitly ended the session; it will not return.

The application should never start a fresh conversation as an implicit
fallback for a failed resume. A failed restoration should leave a normal shell
or a recoverable placeholder without deleting the saved reference.

Application actions should make lifecycle consequences explicit:

- **Close window** detaches and keeps sessions running.
- **Close session** stops one session and records that it should not return.
- **Stop all sessions and quit** terminates the PTY host after confirmation.
- **Restart interface** replaces only the GUI when possible.

## Reliability and security requirements

- Persist user intent before terminating a process.
- Deduplicate native session references before resuming.
- Never infer identity when multiple candidates are possible.
- Keep failed recovery records until the user discards them.
- Treat integration input as untrusted and validate source, adapter, version,
  session identity, and size.
- Use a user-private local socket and state directory.
- Do not persist terminal output, prompts, credentials, or transcript contents
  by default.
- Do not allow a persisted record to become an arbitrary command-execution
  format.
- Bound shutdown and recovery concurrency.
- Make integration install and uninstall behavior testable and reversible.

## Delivery strategy

### Phase 1: lifecycle model and architecture decision

Architecture decision made 2026-08-05: `shep-ptyhost` (see "Research findings
and decisions"). Remaining Phase 1 work: specify the IPC surface (attach,
detach, input, resize, ack, terminate), the session-record schema below, and
host lifecycle (spawn, upgrade, orphan cleanup) before writing host code.

### Phase 2: process continuity

Move PTY ownership outside the GUI lifecycle. Support detach, reconnect,
explicit session close, and explicit host shutdown for arbitrary terminal
commands. This phase provides universal continuity without vendor adapters.

Milestone gate: one Claude Code session survives quitting Shep and reattaches
with a correct primary screen (raw-history replay). Build the host's
flow-control protocol here as the shared implementation for
`docs/vision/terminal-pipeline.md` Phase 2.

### Phase 3: integration framework

Implement the adapter registry, local integration-report protocol, versioned
installer framework, and transactional recovery state.

### Phase 4: current-agent coverage

Ship and validate adapters and integrations for Claude Code, Codex,
Antigravity, OpenCode, and Pi. Do not describe the feature as complete while a
first-class Shep agent is excluded.

### Phase 5: machine and host restart recovery

Reconstruct saved tab placement and resume eligible native sessions. Add
deduplication, retry, discard, missing-directory handling, compatibility
errors, and manual restart testing.

### Phase 6: hardening

Exercise GUI crashes, daemon crashes, upgrades, machine restarts, stale
references, concurrent same-project agents, disk-write failures, integration
version skew, and interrupted restores.

## Success criteria

- Closing or crashing the Shep GUI does not stop any session.
- Reopening Shep reconnects to the original PTYs with stable tab identity.
- All current coding agents have an explicit adapter and recovery capability
  declaration.
- After a host or machine restart, supported conversations resume with their
  original working directory, label, options, and project placement.
- Explicitly closed sessions do not return.
- A failed resume remains retryable and is never silently replaced by a new
  conversation.
- Concurrent sessions in the same project are never cross-associated.
- State remains consistent under simulated persistence failures.

## Non-goals

- Persisting arbitrary terminal screen contents by default.
- Reconstructing a provider conversation from rendered terminal output.
- Promising native recovery for a vendor that exposes no stable session
  mechanism.
- Building Herdr's remote clients, pane splitting, automation system, or agent
  status detection as part of this effort.

## Relationship to pull request #55

Pull request #55 is a useful proof of concept for provider-owned session
identity, safe resume argument construction, placement-versus-working-directory
semantics, and bounded shutdown. Its Claude/Codex-specific registry should not
become the final platform boundary.

Before merging the recovery portion, preserve the reusable lessons and replace
the provider-specific lifecycle with the generic model described here. The
project-move-menu and local-build changes can be reviewed independently.

## Prior art

- [Herdr concepts and terminal model](https://herdr.dev/docs/concepts/)
- [Herdr session state and restore](https://herdr.dev/docs/session-state/)
- [Herdr integrations](https://herdr.dev/docs/integrations/)
- [Herdr's `libghostty-vt` terminal engine](https://herdr.dev/blog/live-updates-without-killing-your-terminal-processes/)
- [Herdr generic agent resume planner](https://github.com/herdrdev/herdr/blob/master/src/agent_resume.rs)
- [shpool — daemon/attach reference implementation](https://github.com/shell-pool/shpool)
- [oly — independent convergence on the same stack](https://lib.rs/crates/oly)
- [rmux — embeddable multiplexer SDK (rejected: too much machine)](https://github.com/helvesec/rmux)
- [Codeman](https://github.com/Ark0N/Codeman)
- [Agent Deck](https://github.com/asheshgoplani/agent-deck)
- [Claude Squad](https://github.com/smtg-ai/claude-squad)
