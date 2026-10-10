import { useEffect, useMemo, useRef, useState } from "react";
import { CircleHelp, Play, Plus, Save, Square, Trash2, X } from "lucide-react";
import tabKindMeta from "../../lib/tabKindMeta";
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

  return (
    <div className="commands-panel__row-shell">
      <div className="commands-panel__row-line">
        <div className={`commands-panel__row ${isNew ? "is-new" : ""}`}>
          <input
            className="commands-panel__input commands-panel__input--command"
            placeholder={
              isNew
                ? "e.g. pnpm dev, docker compose up, redis-server"
                : "Command"
            }
            value={draft.command}
            onChange={(e) => setDraft((current) => ({ ...current, command: e.target.value }))}
          />
          <label className="commands-panel__auto">
            <input
              type="checkbox"
              checked={draft.autostart}
              onChange={(e) => setDraft((current) => ({ ...current, autostart: e.target.checked }))}
            />
            <span>Auto</span>
            <button
              type="button"
              className="commands-panel__auto-help"
              title="Auto starts this command when you open the project in Shep."
            >
              <CircleHelp size={12} />
            </button>
          </label>
          <div className="commands-panel__row-actions">
            <button
              className="icon-btn commands-panel__action"
              onClick={() => void handleRun()}
              title={isRunning ? "Stop" : "Start"}
            >
              {isRunning ? (
                <Square size={14} fill="currentColor" />
              ) : (
                <Play size={14} fill="currentColor" />
              )}
            </button>
            {isNew && (
              <button
                className="icon-btn commands-panel__action"
                onClick={onCancelNew}
                title="Cancel"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        {isNew ? (
          <button
            className="icon-btn commands-panel__delete"
            onClick={() => void save(true)}
            title="Save"
          >
            <Save size={14} />
          </button>
        ) : (
          <button
            className="icon-btn commands-panel__delete"
            onClick={() => onDeleteCommand(command!.name)}
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {error && <div className="commands-panel__row-error">{error}</div>}
    </div>
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
    return (
      <div className="commands-panel commands-panel--empty">
        Select a project to manage commands
      </div>
    );
  }

  return (
    <div className="commands-panel">
      <div className="commands-panel__header">
        <div className="commands-panel__title-wrap">
          <span className="shrink-0">{tabKindMeta.commands.icon(15)}</span>
          <div className="commands-panel__title-block">
            <div className="commands-panel__title">Commands</div>
            <div className="commands-panel__subtitle">
              {runningCount} running · {commands.length} total
            </div>
          </div>
        </div>
        <div className="commands-panel__header-actions">
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus size={14} />
            <span>New command</span>
          </button>
          <button
            className="commands-panel__header-btn glass-button"
            disabled={commands.length === 0}
            onClick={() => void onStartAllCommands()}
          >
            <Play size={13} fill="currentColor" />
            <span>Play All</span>
          </button>
          <button
            className="commands-panel__header-btn glass-button"
            disabled={runningCount === 0}
            onClick={() => void onStopAllCommands()}
          >
            <Square size={13} fill="currentColor" />
            <span>Stop All</span>
          </button>
        </div>
      </div>

      <div className="commands-panel__simple-list">
        {commands.length === 0 && !creating && !savingNew && (
          <div className="commands-panel__empty-inline">
            Add the commands you always run for this project.
          </div>
        )}

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
              if (saved !== false) {
                setCreating(false);
              }
              setSavingNew(false);
              return saved;
            }}
            onUpdateCommand={onUpdateCommand}
            onDeleteCommand={onDeleteCommand}
            onCancelNew={() => setCreating(false)}
          />
        )}
      </div>
    </div>
  );
}
