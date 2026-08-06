import { useCallback } from "react";
import {
  acknowledgePtyOutput,
  spawnPty,
  killPty,
  getDefaultShell,
} from "../lib/tauri";
import { useThemeStore } from "../stores/useThemeStore";
import { hexLuminance } from "../lib/themes";
import type { PtyOutput, CommandConfig, SessionMode } from "../lib/types";
import { toPtyColorTheme } from "../lib/ptyColorTheme";
import { useCommandStore } from "../stores/useCommandStore";
import { useTerminalStore, nextTabId } from "../stores/useTerminalStore";
import { useRepoStore } from "../stores/useRepoStore";
import { useNoticeStore } from "../stores/useNoticeStore";
import { CODING_ASSISTANTS } from "../components/sidebar/constants";
import type { Terminal } from "@xterm/xterm";
import { getErrorMessage } from "../lib/errors";
import {
  clearTerminalPipelineCounters,
  recordPendingOutput,
  recordTerminalData,
  recordWriteComplete,
  recordWriteFlush,
} from "../lib/terminalPipelineDebug";

interface TerminalRegistration {
  term: Terminal;
  afterWrite: (() => void) | null;
}

interface BufferedOutput {
  chunks: string[];
  length: number;
  truncatedChars: number;
}

interface WriteQueue {
  chunks: string[];
  length: number;
  writing: boolean;
}

interface OutputAckState {
  pendingBytes: number;
  sending: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

// xterm's parser is asynchronous. Only submit the next bounded chunk after
// the previous write callback, so the browser can render intermediate frames.
const MAX_WRITE_CHUNK_CHARS = 64 * 1024;
const MAX_PENDING_OUTPUT_CHARS = 1024 * 1024;
const OUTPUT_ACK_INTERVAL_BYTES = 5_000;
const OUTPUT_ACK_RETRY_MS = 250;
const OUTPUT_TRUNCATED_MARKER = "\r\n[output truncated while terminal was unavailable]\r\n";
const outputEncoder = new TextEncoder();

const terminalInstances = new Map<number, TerminalRegistration>();
const pendingOutput = new Map<number, BufferedOutput>();
const writeQueues = new Map<number, WriteQueue>();
const outputAckStates = new Map<number, OutputAckState>();

// Debounce timers for activity detection — clears "active" after 3s of silence.
// Activity state is tracked here (not in the store) on every data event to avoid
// high-frequency store updates during AI streaming. The store is only updated
// on transitions: idle→active and active→idle.
const activityTimers = new Map<number, ReturnType<typeof setTimeout>>();
const activityActive = new Set<number>();
const ACTIVITY_TIMEOUT = 3000;
const stoppingPtys = new Set<number>();

function cleanupActivityState(ptyId: number) {
  const timer = activityTimers.get(ptyId);
  if (timer) { clearTimeout(timer); activityTimers.delete(ptyId); }
  activityActive.delete(ptyId);
}

export function registerTerminal(
  ptyId: number,
  term: Terminal,
  afterWrite: (() => void) | null = null,
) {
  terminalInstances.set(ptyId, { term, afterWrite });
}

export function flushPendingOutput(ptyId: number) {
  if (!terminalInstances.has(ptyId)) return;

  const buffered = pendingOutput.get(ptyId);
  if (!buffered) return;

  pendingOutput.delete(ptyId);
  recordPendingOutput(ptyId, 0);
  if (buffered.truncatedChars > 0) {
    enqueueTerminalOutput(ptyId, OUTPUT_TRUNCATED_MARKER);
  }
  for (const chunk of buffered.chunks) enqueueTerminalOutput(ptyId, chunk);
}

export function unregisterTerminal(ptyId: number) {
  terminalInstances.delete(ptyId);
  pendingOutput.delete(ptyId);
  writeQueues.delete(ptyId);
  const ackState = outputAckStates.get(ptyId);
  if (ackState?.retryTimer) clearTimeout(ackState.retryTimer);
  outputAckStates.delete(ptyId);
  clearTerminalPipelineCounters(ptyId);
}

function acknowledgeCompletedWrite(ptyId: number, chunk: string): void {
  let state = outputAckStates.get(ptyId);
  if (!state) {
    state = { pendingBytes: 0, sending: false, retryTimer: null };
    outputAckStates.set(ptyId, state);
  }
  state.pendingBytes += outputEncoder.encode(chunk).byteLength;
  flushOutputAcknowledgement(ptyId, state);
}

function flushOutputAcknowledgement(ptyId: number, state: OutputAckState): void {
  if (
    state.sending ||
    state.retryTimer ||
    state.pendingBytes < OUTPUT_ACK_INTERVAL_BYTES
  ) return;

  const bytes = state.pendingBytes;
  state.pendingBytes = 0;
  state.sending = true;
  void acknowledgePtyOutput(ptyId, bytes)
    .then(() => {
      if (outputAckStates.get(ptyId) === state) {
        state.sending = false;
        flushOutputAcknowledgement(ptyId, state);
      }
    })
    .catch((error) => {
      if (outputAckStates.get(ptyId) !== state) return;
      state.pendingBytes += bytes;
      state.sending = false;
      state.retryTimer = setTimeout(() => {
        if (outputAckStates.get(ptyId) !== state) return;
        state.retryTimer = null;
        flushOutputAcknowledgement(ptyId, state);
      }, OUTPUT_ACK_RETRY_MS);
      if (import.meta.env.DEV) {
        console.warn("Failed to acknowledge terminal output:", error);
      }
    });
}

function takeWriteChunk(queue: WriteQueue): string {
  const parts: string[] = [];
  let remaining = MAX_WRITE_CHUNK_CHARS;

  while (remaining > 0 && queue.chunks.length > 0) {
    const first = queue.chunks[0];
    let take = Math.min(remaining, first.length);
    // Avoid separating a UTF-16 surrogate pair at the chunk boundary.
    if (take < first.length && take > 0) {
      const lastCodeUnit = first.charCodeAt(take - 1);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) take -= 1;
    }

    if (take === 0) break;
    parts.push(first.slice(0, take));
    queue.length -= take;
    remaining -= take;
    if (take === first.length) queue.chunks.shift();
    else queue.chunks[0] = first.slice(take);
  }

  return parts.join("");
}

function drainWriteQueue(ptyId: number): void {
  const registration = terminalInstances.get(ptyId);
  const queue = writeQueues.get(ptyId);
  if (!registration || !queue || queue.writing || queue.length === 0) return;

  const chunk = takeWriteChunk(queue);
  if (chunk.length === 0) return;
  queue.writing = true;
  recordWriteFlush(ptyId, chunk.length, registration.term);

  try {
    registration.term.write(chunk, () => {
      const currentQueue = writeQueues.get(ptyId);
      const currentRegistration = terminalInstances.get(ptyId);
      if (!currentQueue || currentRegistration !== registration) return;

      currentQueue.writing = false;
      acknowledgeCompletedWrite(ptyId, chunk);
      registration.afterWrite?.();
      recordWriteComplete(ptyId, registration.term);
      drainWriteQueue(ptyId);
    });
  } catch (error) {
    queue.writing = false;
    if (import.meta.env.DEV) {
      console.error("Failed to write terminal output:", error);
    }
  }
}

function enqueueTerminalOutput(ptyId: number, data: string): void {
  if (data.length === 0) return;
  let queue = writeQueues.get(ptyId);
  if (!queue) {
    queue = { chunks: [], length: 0, writing: false };
    writeQueues.set(ptyId, queue);
  }
  queue.chunks.push(data);
  queue.length += data.length;
  drainWriteQueue(ptyId);
}

function appendPendingOutput(ptyId: number, data: string): void {
  let buffer = pendingOutput.get(ptyId);
  if (!buffer) {
    buffer = { chunks: [], length: 0, truncatedChars: 0 };
    pendingOutput.set(ptyId, buffer);
  }

  buffer.chunks.push(data);
  buffer.length += data.length;
  let truncatedNow = 0;
  while (buffer.length > MAX_PENDING_OUTPUT_CHARS && buffer.chunks.length > 0) {
    const excess = buffer.length - MAX_PENDING_OUTPUT_CHARS;
    const first = buffer.chunks[0];
    let drop = Math.min(excess, first.length);
    if (drop < first.length) {
      const nextCodeUnit = first.charCodeAt(drop);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) drop += 1;
    }
    truncatedNow += drop;
    buffer.length -= drop;
    if (drop === first.length) buffer.chunks.shift();
    else buffer.chunks[0] = first.slice(drop);
  }
  buffer.truncatedChars += truncatedNow;
  recordPendingOutput(ptyId, buffer.length, truncatedNow);
}

function writeToPty(ptyId: number, data: string) {
  recordTerminalData(ptyId, data);
  if (terminalInstances.has(ptyId)) enqueueTerminalOutput(ptyId, data);
  else appendPendingOutput(ptyId, data);
}

function resolveCommandCwd(repoPath: string, commandCwd: string | null) {
  const trimmed = commandCwd?.trim();
  if (!trimmed) return repoPath;
  const relativePath = trimmed.replace(/^\.?\//, "").replace(/^\/+/, "");
  return `${repoPath}/${relativePath}`;
}

export function usePty() {
  const activeRepoPath = useRepoStore((s) => s.activeRepoPath);
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const {
    setCommandStatus,
    setCommandPtyId,
    setCommandStatusForProject,
    setCommandPtyIdForProject,
  } = useCommandStore.getState();
  const { addTab, removeTab, findTabByCommand, setActiveTab, initActivity, setTabActive, setTabExited, removeActivity } =
    useTerminalStore.getState();

  const handlePtyMessage = useCallback(
    (
      ptyId: number,
      commandName: string | null,
      repoPath: string,
      msg: PtyOutput,
    ) => {
      if (msg.event === "data") {
        writeToPty(ptyId, msg.data);

        // Only update the store on the idle→active transition, not on every chunk.
        if (!activityActive.has(ptyId)) {
          activityActive.add(ptyId);
          setTabActive(ptyId, true);
        }

        // Reset the idle timer — after 3s of no output, mark as inactive
        const existing = activityTimers.get(ptyId);
        if (existing) clearTimeout(existing);
        activityTimers.set(ptyId, setTimeout(() => {
          activityActive.delete(ptyId);
          setTabActive(ptyId, false);
          activityTimers.delete(ptyId);
        }, ACTIVITY_TIMEOUT));
      } else if (msg.event === "exit") {
        cleanupActivityState(ptyId);
        setTabExited(ptyId, msg.data.code);
        const stoppedByUser = stoppingPtys.delete(ptyId);
        if (commandName) {
          const command = useCommandStore.getState().projectCommands[repoPath]
            ?.find((entry) => entry.name === commandName);
          const nextStatus = stoppedByUser || msg.data.code === 0 ? "stopped" : "crashed";
          if (command?.status !== "stopped" || nextStatus === "crashed") {
            setCommandStatusForProject(repoPath, commandName, nextStatus);
          }
          setCommandPtyIdForProject(repoPath, commandName, null);
        }
      }
    },
    [setCommandStatusForProject, setCommandPtyIdForProject, setTabActive, setTabExited],
  );

  const spawnSession = useCallback(
    async (
      command: string,
      commandArgs: string[] | null,
      env: Record<string, string>,
      cols: number,
      rows: number,
      commandName: string | null,
      repoPath: string,
    ) => {
      let resolvedPtyId: number | null = null;
      const bufferedMessages: PtyOutput[] = [];

      // Signal terminal background brightness to CLI tools via COLORFGBG.
      // Claude Code uses this to resolve "auto" theme when OSC 11 is unavailable.
      const theme = useThemeStore.getState().theme;
      const lum = hexLuminance(theme.appBg);
      const colorfgbg = lum > 0.3 ? "0;15" : "15;0";
      const fullEnv = { COLORFGBG: colorfgbg, ...env };

      const ptyId = await spawnPty(
        command,
        commandArgs,
        repoPath,
        fullEnv,
        cols,
        rows,
        toPtyColorTheme(theme),
        (msg) => {
          if (resolvedPtyId === null) {
            bufferedMessages.push(msg);
            return;
          }

          handlePtyMessage(resolvedPtyId, commandName, repoPath, msg);
        },
      );

      resolvedPtyId = ptyId;
      initActivity(ptyId);

      for (const msg of bufferedMessages) {
        handlePtyMessage(ptyId, commandName, repoPath, msg);
      }

      return ptyId;
    },
    [handlePtyMessage, initActivity],
  );

  const startCommand = useCallback(
    async (command: CommandConfig, cols: number, rows: number) => {
      if (!activeRepoPath) return;
      const commandName = command.name;

      const basePath = activeRepoPath;

      try {
        const ptyId = await spawnSession(
          command.command,
          null,
          command.env,
          cols,
          rows,
          commandName,
          resolveCommandCwd(basePath, command.cwd ?? null),
        );
        if (!ptyId) return;

        setCommandStatus(commandName, "running");
        setCommandPtyId(commandName, ptyId);

        const existing = findTabByCommand(commandName);
        if (existing) {
          setActiveTab(existing.id);
        } else {
          const id = nextTabId();
          addTab({
            id,
            kind: "terminal",
            label: commandName,
            ptyId,
            repoPath: activeRepoPath,
            commandName,
            assistantId: null,
            sessionMode: null,
          });
        }

        return ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(`Failed to start command "${commandName}":`, e);
        }
        pushNotice({
          tone: "error",
          title: `Couldn’t start ${commandName}`,
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [
      activeRepoPath,
      spawnSession,
      setCommandStatus,
      setCommandPtyId,
      findTabByCommand,
      setActiveTab,
      addTab,
      pushNotice,
    ],
  );

  const stopCommand = useCallback(
    async (commandName: string) => {
      const path = useCommandStore.getState().activeProjectPath;
      if (!path) return;
      const state = useTerminalStore.getState();
      const commands = useCommandStore.getState().projectCommands[path] ?? [];
      const command = commands.find((c) => c.name === commandName);
      const tab = state.getAllProjectTabs(path).find((t) => (t.kind === "terminal" || t.kind === "assistant") && t.commandName === commandName);
      if (command?.ptyId) {
        cleanupActivityState(command.ptyId);
        stoppingPtys.add(command.ptyId);
        await killPty(command.ptyId).catch(() => {
          stoppingPtys.delete(command.ptyId!);
        });
        unregisterTerminal(command.ptyId);
        removeActivity(command.ptyId);
      }
      if (tab) {
        removeTab(tab.id);
      }
      setCommandStatus(commandName, "stopped");
      setCommandPtyId(commandName, null);
    },
    [setCommandStatus, setCommandPtyId, removeTab, removeActivity],
  );

  const restartCommand = useCallback(
    async (command: CommandConfig, cols: number, rows: number) => {
      await stopCommand(command.name);
      return startCommand(command, cols, rows);
    },
    [stopCommand, startCommand],
  );

  const spawnBlankShell = useCallback(
    async (cols: number, rows: number) => {
      if (!activeRepoPath) return;

      try {
        const shell = await getDefaultShell();
        const ptyId = await spawnSession(
          `${shell} -l`,
          null,
          {},
          cols,
          rows,
          null,
          activeRepoPath,
        );
        if (!ptyId) return;

        const id = nextTabId();
        addTab({
          id,
          kind: "terminal",
          label: "Terminal",
          ptyId,
          repoPath: activeRepoPath,
          commandName: null,
          assistantId: null,
          sessionMode: null,
        });

        return ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error("Failed to spawn shell:", e);
        }
        pushNotice({
          tone: "error",
          title: "Couldn’t open shell",
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [activeRepoPath, spawnSession, addTab, pushNotice],
  );

  const launchAssistant = useCallback(
    async (
      assistantId: string,
      cols: number,
      rows: number,
      mode: SessionMode = "standard",
      model?: string,
    ) => {
      if (!activeRepoPath) return;
      const assistant = CODING_ASSISTANTS.find((a) => a.id === assistantId);
      if (!assistant) return;

      const commandArgs: string[] = [];
      if (model) {
        commandArgs.push(assistant.modelFlag, model);
      }
      if (mode === "yolo" && assistant.yoloFlag) {
        commandArgs.push(assistant.yoloFlag);
      }

      try {
        const ptyId = await spawnSession(
          assistant.command,
          commandArgs,
          {},
          cols,
          rows,
          null,
          activeRepoPath,
        );
        if (!ptyId) return;

        const id = nextTabId();
        addTab({
          id,
          kind: "assistant",
          label: assistant.name,
          ptyId,
          repoPath: activeRepoPath,
          commandName: null,
          assistantId,
          sessionMode: mode,
        });

        return ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(`Failed to launch ${assistant.name}:`, e);
        }
        pushNotice({
          tone: "error",
          title: `Couldn’t launch ${assistant.name}`,
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [activeRepoPath, spawnSession, addTab, pushNotice],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      const state = useTerminalStore.getState();
      const path = state.activeProjectPath;
      if (!path) return;
      const tabs = state.projectState[path]?.tabs ?? [];
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab || (tab.kind !== "terminal" && tab.kind !== "assistant")) return;

      cleanupActivityState(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);

      if (tab.commandName) {
        setCommandStatus(tab.commandName, "stopped");
        setCommandPtyId(tab.commandName, null);
      }

      removeTab(tabId);
    },
    [setCommandStatus, setCommandPtyId, removeTab, removeActivity],
  );

  const killProjectPtys = useCallback(async (repoPath: string) => {
    const state = useTerminalStore.getState();
    const tabs = state.getAllProjectTabs(repoPath);

    for (const tab of tabs) {
      if (tab.kind !== "terminal" && tab.kind !== "assistant") continue;
      cleanupActivityState(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);
    }
  }, [removeActivity]);

  return {
    startCommand,
    stopCommand,
    restartCommand,
    spawnBlankShell,
    launchAssistant,
    closeTab,
    killProjectPtys,
  };
}
