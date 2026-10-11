import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Plus, Square, Trash2, X } from "lucide-react";
import { useTerminalStore } from "../../stores/useTerminalStore";
import type { CommandConfig, CommandState } from "../../lib/types";

interface CommandsPanelProps {
  commands: CommandState[];
  onStartCommand: (name: string) => void;
  onStopCommand: (name: string) => void;
  onCreateCommand: (command: CommandConfig) => Promise<boolean> | boolean;
  onUpdateCommand: (previousName: string, command: CommandConfig) => Promise<boolean> | boolean;
  onDeleteCommand: (name: string) => void;
  onStartAllCommands: () => Promise<void> | void;
  onStopAllCommands: () => Promise<void> | void;
}

interface CommandDraft {
  command: string;
  autostart: boolean;
}

function createDraft(command?: CommandState): CommandDraft {
  return {
    command: command?.command ?? "",
    autostart: command?.autostart ?? false,
  };
}

function generateCommandName(commandText: string, commands: CommandState[]) {
  const base = commandText
    .trim()
    .toLowerCase()
    .slice(0, 32)
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const root = base || "command";
  const names = new Set(commands.map((command) => command.name));

  if (!names.has(root)) {
    return root;
  }

  let index = 2;
  while (names.has(`${root}_${index}`)) {
    index += 1;
  }
  return `${root}_${index}`;
}

interface CommandRowProps {
  command?: CommandState;
  isNew?: boolean;
  commands: CommandState[];
  onStartCommand: (name: string) => void;
  onStopCommand: (name: string) => void;
  onCreateCommand: (command: CommandConfig) => Promise<boolean> | boolean;
  onUpdateCommand: (previousName: string, command: CommandConfig) => Promise<boolean> | boolean;
  onDeleteCommand: (name: string) => void;
  onCancelNew?: () => void;
}

function CommandRow({
  command,
  isNew = false,
  commands,
  onStartCommand,
  onStopCommand,
  onCreateCommand,
  onUpdateCommand,
  onDeleteCommand,
  onCancelNew,
}: CommandRowProps) {
  const [draft, setDraft] = useState<CommandDraft>(createDraft(command));
  const [error, setError] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const isRunning = command?.status === "running";

  const isDirty = isNew
    ? draft.command.trim().length > 0 || draft.autostart
    : draft.command !== command?.command
      || draft.autostart !== command?.autostart;

  useEffect(() => {
    if (!isNew && command) {
      setDraft(createDraft(command));
      setError(null);
    }
  }, [command, isNew]);

  const buildConfig = (showErrors: boolean): CommandConfig | null => {
    const shellCommand = draft.command.trim();

    if (!shellCommand) {
      if (showErrors) {
        setError("Command is required.");
      }
      return null;
    }

    setError(null);
    return {
      name: command?.name ?? generateCommandName(shellCommand, commands),
      command: shellCommand,
      autostart: draft.autostart,
      env: command?.env ?? {},
      cwd: command?.cwd ?? null,
    };
  };

  const save = async (showErrors: boolean) => {
    const nextConfig = buildConfig(showErrors);
    if (!nextConfig) return false;

    if (isNew) {
      return onCreateCommand(nextConfig);
    }

    return onUpdateCommand(command!.name, nextConfig);
  };

  useEffect(() => {
    if (isNew) {
      return;
    }

    if (!isDirty) {
      return;
    }

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      void save(false);
    }, 500);

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [draft, isDirty, isNew]);

  const handleRun = async () => {
    if (isRunning && command) {
      onStopCommand(command.name);
      return;
    }

    if (isNew || isDirty) {
      const saved = await save(true);
      if (saved === false) return;
      onStartCommand(command?.name ?? generateCommandName(draft.command.trim(), commands));
      return;
    }

    if (command) {
      onStartCommand(command.name);
    }
  };

  const status = isNew ? "new" : command?.status ?? "stopped";
  const statusLabel = status === "running" ? "Running" : status === "crashed" ? "Stopped with an error" : status === "new" ? "New command" : "Stopped";

  return (
    <li className={`command-row command-row--${status}`}>
      <span className="command-row__dot" title={statusLabel} aria-label={statusLabel} />
      <div className="command-row__body">
        <label className="command-row__code">
          <span className="command-row__prompt" aria-hidden="true">$</span>
          <input
          className="command-row__input"
          autoFocus={isNew}
          placeholder="e.g. pnpm dev, docker compose up, redis-server"
          aria-label={isNew ? "New command" : `Command ${command?.name}`}
          value={draft.command}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft((current) => ({ ...current, command: e.target.value }))}
          onKeyDown={(e) => {
            if (!isNew) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void save(true);
            } else if (e.key === "Escape") {
              onCancelNew?.();
            }
          }}
          />
        </label>
        {error && <div className="command-row__error">{error}</div>}
      </div>
      <button
        type="button"
        className={`command-row__auto ${draft.autostart ? "command-row__auto--on" : ""}`}
        aria-pressed={draft.autostart}
        title="Start this command automatically when you open the project"
        onClick={() => setDraft((current) => ({ ...current, autostart: !current.autostart }))}
      >
        Auto-start
      </button>
      <div className="command-row__actions">
        <button
          type="button"
          className="icon-btn command-row__run"
          onClick={() => void handleRun()}
          title={isRunning ? "Stop" : isNew ? "Save and start" : "Start"}
          aria-label={isRunning ? "Stop command" : "Start command"}
        >
          {isRunning ? <Square size={12} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
        </button>
        {isNew ? (
          <button type="button" className="icon-btn command-row__remove" onClick={onCancelNew} title="Cancel (Esc)" aria-label="Cancel new command">
            <X size={14} />
          </button>
        ) : (
          <button type="button" className="icon-btn command-row__remove" data-danger="true" onClick={() => onDeleteCommand(command!.name)} title="Delete" aria-label={`Delete ${command?.name}`}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

export default function CommandsPanel({
  commands,
  onStartCommand,
  onStopCommand,
  onCreateCommand,
  onUpdateCommand,
  onDeleteCommand,
  onStartAllCommands,
  onStopAllCommands,
}: CommandsPanelProps) {
  const activeProjectPath = useTerminalStore((s) => s.activeProjectPath);
  const [creating, setCreating] = useState(false);
  const [savingNew, setSavingNew] = useState(false);

  const runningCount = useMemo(
    () => commands.filter((command) => command.status === "running").length,
    [commands],
  );

  if (!activeProjectPath) {
    return <div className="commands-empty-state">Select a project to manage its commands.</div>;
  }

  const empty = commands.length === 0 && !creating && !savingNew;

  return (
    <div className="page commands-page">
      <div className="page__heading page__heading--actions">
        <div>
          <h1 className="page__title">Commands.</h1>
          <p className="page__lede">Servers and scripts for this project.</p>
        </div>
        <div className="commands-page__actions">
          {commands.length > 0 && (
            runningCount > 0 ? (
              <button type="button" className="btn-secondary" onClick={() => void onStopAllCommands()}>
                <Square size={12} fill="currentColor" aria-hidden="true" />
                Stop all
              </button>
            ) : (
              <button type="button" className="btn-secondary" onClick={() => void onStartAllCommands()}>
                <Play size={12} fill="currentColor" aria-hidden="true" />
                Start all
              </button>
            )
          )}
          <button type="button" className="btn-primary" onClick={() => setCreating(true)} disabled={creating}>
            <Plus size={14} aria-hidden="true" />
            New command
          </button>
        </div>
      </div>

      {!empty && (
        <div className="commands-page__meta" role="status">
          <span>{commands.length} {commands.length === 1 ? "command" : "commands"}</span>
          <span className={`commands-page__running ${runningCount > 0 ? "commands-page__running--on" : ""}`}>
            {runningCount > 0 ? `${runningCount} running` : "None running"}
          </span>
        </div>
      )}

      {empty ? (
        <div className="ports-empty">
          <span className="ports-empty__icon" aria-hidden="true"><Play size={20} /></span>
          <h2>No commands yet.</h2>
          <p>Add the servers and scripts you always run here, like pnpm dev or docker compose up.</p>
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>New command</button>
        </div>
      ) : (
        <ul className="command-list">
          {commands.map((command) => (
            <CommandRow
              key={command.name}
              command={command}
              commands={commands}
              onStartCommand={onStartCommand}
              onStopCommand={onStopCommand}
              onCreateCommand={onCreateCommand}
              onUpdateCommand={onUpdateCommand}
              onDeleteCommand={onDeleteCommand}
            />
          ))}
          {creating && (
            <CommandRow
              isNew
              commands={commands}
              onStartCommand={onStartCommand}
              onStopCommand={onStopCommand}
              onCreateCommand={async (command) => {
                setSavingNew(true);
                const saved = await onCreateCommand(command);
                if (saved !== false) setCreating(false);
                setSavingNew(false);
                return saved;
              }}
              onUpdateCommand={onUpdateCommand}
              onDeleteCommand={onDeleteCommand}
              onCancelNew={() => setCreating(false)}
            />
          )}
        </ul>
      )}
    </div>
  );
}
