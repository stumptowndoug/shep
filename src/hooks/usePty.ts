import { useCallback } from "react";
import {
  acknowledgePtyOutput,
  spawnPty,
  killPty,
  getDefaultShell,
  getAgentRuntimeStatus,
  resolveSessionTitle,
  upsertSessionHistory,
  recordSessionHistoryActivity,
} from "../lib/tauri";
import { useThemeStore } from "../stores/useThemeStore";
import { isSessionTab, type TerminalTabData, type AgentSemanticState, type AgentStatusObservation, type PtyOutput, type CommandConfig, type SessionHistoryEntry, type SessionMode } from "../lib/types";
import {
  detectAgentScreenStatus,
  readTerminalBottomScreen,
  resolveAgentStatusAuthority,
  type AgentScreenDetection,
  type ProviderAgentObservation,
} from "../lib/agentScreenStatus";
import { toPtyColorTheme } from "../lib/ptyColorTheme";
import { terminalColorEnvironment } from "../lib/terminalColorMode";
import { useCommandStore } from "../stores/useCommandStore";
import { useTerminalStore, nextTabId } from "../stores/useTerminalStore";
import { useRepoStore } from "../stores/useRepoStore";
import { useNoticeStore } from "../stores/useNoticeStore";
import { useProjectSettingsStore } from "../stores/useProjectSettingsStore";
import { CODING_ASSISTANTS } from "../components/sidebar/constants";
import type { Terminal } from "@xterm/xterm";
import { getErrorMessage } from "../lib/errors";
import { sessionResumeArgs } from "../lib/sessionResume";
import { closeChat } from "../lib/acp/chatSessions";
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
  title: string;
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
const terminalTitles = new Map<number, string>();
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

interface SessionTitleResolverState {
  cancelled: boolean;
  sessionId: string | null;
  persistedKey: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const sessionTitleResolvers = new Map<number, SessionTitleResolverState>();

interface AgentStatusObserverState {
  cancelled: boolean;
  misses: number;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  lastProviderPollAt: number;
  provider: ProviderAgentObservation | null;
  screen: AgentScreenDetection | null;
  screenKey: string | null;
  screenChangedAt: number;
  effectiveKey: string | null;
  effectiveChangedAt: number;
}

export interface AgentStatusExplain {
  assistantId: string;
  provider: ProviderAgentObservation | null;
  screen: AgentScreenDetection | null;
  effective: AgentStatusObservation | null;
}

const agentStatusObservers = new Map<number, AgentStatusObserverState>();
const agentStatusExplanations = new Map<number, AgentStatusExplain>();
const AGENT_SCREEN_POLL_MS = 750;
const PROVIDER_STATUS_POLL_MS = 2_500;
const AGENT_STATUS_MISSES_BEFORE_CLEAR = 3;
const AGENT_STARTUP_GRACE_MS = 3_000;
const AGENT_STUCK_AFTER_MS = 120_000;

export function explainAgentStatus(ptyId: number): AgentStatusExplain | null {
  return agentStatusExplanations.get(ptyId) ?? null;
}

if (import.meta.env.DEV) {
  const debugGlobal = globalThis as typeof globalThis & {
    __shepAgentDetection?: { explain: typeof explainAgentStatus };
  };
  debugGlobal.__shepAgentDetection = { explain: explainAgentStatus };
}

function stopAgentStatusObserver(ptyId: number) {
  const observer = agentStatusObservers.get(ptyId);
  if (!observer) return;
  observer.cancelled = true;
  if (observer.timer) clearTimeout(observer.timer);
  agentStatusObservers.delete(ptyId);
  agentStatusExplanations.delete(ptyId);
}

function reportedAgentState(status: string): AgentSemanticState | null {
  switch (status.trim().toLocaleLowerCase()) {
    case "working":
    case "active":
    case "running":
    case "busy":
    case "processing":
      return "working";
    case "idle":
      return "idle";
    case "blocked":
    case "waiting":
    case "needs_input":
    case "needs-input":
    case "requires_action":
      return "blocked";
    default:
      return null;
  }
}

function screenDetectionKey(detection: AgentScreenDetection): string {
  return `${detection.confidence}:${detection.state ?? "preserve"}:${detection.ruleId}`;
}

function updateScreenObservation(
  observer: AgentStatusObserverState,
  detection: AgentScreenDetection,
  now: number,
) {
  const key = screenDetectionKey(detection);
  if (key !== observer.screenKey) {
    observer.screenKey = key;
    observer.screenChangedAt = now;
  }
  observer.screen = detection;
}

function effectiveAgentObservation(
  observer: AgentStatusObserverState,
  activity: ReturnType<typeof useTerminalStore.getState>["tabActivity"][number] | undefined,
  now: number,
): AgentStatusObservation | null {
  const screen = observer.screen;
  const observation = resolveAgentStatusAuthority(
    screen,
    observer.screenChangedAt,
    observer.provider,
    now - observer.startedAt >= AGENT_STARTUP_GRACE_MS,
  );

  if (!observation) return null;

  const effectiveKey = `${observation.source}:${observation.state}:${observation.ruleId ?? ""}`;
  if (effectiveKey !== observer.effectiveKey) {
    observer.effectiveKey = effectiveKey;
    observer.effectiveChangedAt = now;
  }

  if (observation.state === "working" && !activity?.active) {
    const lastSignalAt = Math.max(
      activity?.lastOutputAt ?? 0,
      observer.provider?.state === "working" ? observer.provider.updatedAt : 0,
      observer.effectiveChangedAt,
    );
    if (now - lastSignalAt >= AGENT_STUCK_AFTER_MS) {
      return {
        state: "possibly_stuck",
        updatedAt: lastSignalAt,
        source: "heuristic",
        reason: "Working state has not changed and no terminal output has arrived for two minutes",
        ruleId: "stale-working-state",
      };
    }
  }

  return observation;
}

function startAgentStatusObserver(
  ptyId: number,
  assistantId: string,
  repoPath: string,
) {
  stopAgentStatusObserver(ptyId);

  const now = Date.now();
  const observer: AgentStatusObserverState = {
    cancelled: false,
    misses: 0,
    timer: null,
    startedAt: now,
    lastProviderPollAt: 0,
    provider: null,
    screen: null,
    screenKey: null,
    screenChangedAt: now,
    effectiveKey: null,
    effectiveChangedAt: now,
  };
  agentStatusObservers.set(ptyId, observer);

  const poll = async () => {
    if (observer.cancelled || agentStatusObservers.get(ptyId) !== observer) return;
    const store = useTerminalStore.getState();
    const tab = store.findTabByPtyId(ptyId);
    const activity = store.tabActivity[ptyId];
    if (!tab || activity?.alive === false) {
      stopAgentStatusObserver(ptyId);
      return;
    }

    const polledAt = Date.now();
    const registration = terminalInstances.get(ptyId);
    if (registration) {
      const screen = readTerminalBottomScreen(registration.term);
      const detection = detectAgentScreenStatus(
        assistantId,
        screen,
        registration.title,
      );
      updateScreenObservation(observer, detection, polledAt);
    }

    if (
      assistantId === "claude" &&
      polledAt - observer.lastProviderPollAt >= PROVIDER_STATUS_POLL_MS
    ) {
      observer.lastProviderPollAt = polledAt;
      try {
        const runtime = await getAgentRuntimeStatus(
          ptyId,
          assistantId,
          repoPath,
          tab.providerSessionId,
        );
        if (observer.cancelled || agentStatusObservers.get(ptyId) !== observer) return;
        const state = runtime ? reportedAgentState(runtime.status) : null;
        if (runtime && state) {
          observer.misses = 0;
          observer.provider = { state, updatedAt: runtime.statusUpdatedAt };
        } else {
          observer.misses += 1;
          if (observer.misses >= AGENT_STATUS_MISSES_BEFORE_CLEAR) {
            observer.provider = null;
          }
        }
      } catch (error) {
        observer.misses += 1;
        if (observer.misses >= AGENT_STATUS_MISSES_BEFORE_CLEAR) {
          observer.provider = null;
        }
        if (import.meta.env.DEV) {
          console.warn("Failed to read Claude runtime status:", error);
        }
      }
    }

    const latestActivity = useTerminalStore.getState().tabActivity[ptyId];
    const effective = effectiveAgentObservation(observer, latestActivity, Date.now());
    if (effective) {
      useTerminalStore.getState().setTabAgentState(ptyId, effective);
    }
    agentStatusExplanations.set(ptyId, {
      assistantId,
      provider: observer.provider,
      screen: observer.screen,
      effective,
    });

    if (observer.cancelled || agentStatusObservers.get(ptyId) !== observer) return;
    observer.timer = setTimeout(poll, AGENT_SCREEN_POLL_MS);
  };

  void poll();
}

function stopSessionTitleResolver(ptyId: number) {
  const resolver = sessionTitleResolvers.get(ptyId);
  if (!resolver) return;
  resolver.cancelled = true;
  if (resolver.timer) clearTimeout(resolver.timer);
  sessionTitleResolvers.delete(ptyId);
}

function startSessionTitleResolver(
  ptyId: number,
  assistantId: string,
  repoPath: string,
  startedAfterMs: number,
  model?: string,
  knownSessionId: string | null = null,
) {
  stopSessionTitleResolver(ptyId);
  const resolver: SessionTitleResolverState = {
    cancelled: false,
    sessionId: knownSessionId,
    persistedKey: null,
    timer: null,
  };
  sessionTitleResolvers.set(ptyId, resolver);

  const poll = async () => {
    if (resolver.cancelled || sessionTitleResolvers.get(ptyId) !== resolver) return;
    const store = useTerminalStore.getState();
    const tab = store.findTabByPtyId(ptyId);
    const activity = store.tabActivity[ptyId];
    if (!tab || activity?.alive === false) {
      stopSessionTitleResolver(ptyId);
      return;
    }

    try {
      const match = await resolveSessionTitle(
        ptyId,
        assistantId,
        repoPath,
        startedAfterMs,
        resolver.sessionId,
      );
      if (match) {
        resolver.sessionId = match.sessionId;
        useTerminalStore
          .getState()
          .setTabSessionInfo(ptyId, match.sessionId, match.title);
        const persistedKey = `${match.sessionId}\u0000${match.title ?? ""}`;
        if (resolver.persistedKey !== persistedKey) {
          const lastActivityAt = Date.now();
          await upsertSessionHistory({
            provider: assistantId,
            agentInterface: "terminal",
            sessionId: match.sessionId,
            projectPath: repoPath,
            title: match.title,
            model: model ?? null,
            startedAt: startedAfterMs,
            lastActivityAt,
          });
          resolver.persistedKey = persistedKey;
          historyActivityWrites.set(ptyId, lastActivityAt);
        }
        if (
          match.title &&
          assistantId !== "codex" &&
          assistantId !== "cursor" &&
          assistantId !== "antigravity" &&
          assistantId !== "opencode" &&
          assistantId !== "muse"
        ) {
          stopSessionTitleResolver(ptyId);
          return;
        }
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn(`Failed to resolve ${assistantId} session title:`, error);
      }
    }

    if (resolver.cancelled || sessionTitleResolvers.get(ptyId) !== resolver) return;
    resolver.timer = setTimeout(poll, resolver.sessionId ? 5_000 : 1_000);
  };

  void poll();
}

const HISTORY_ACTIVITY_WRITE_INTERVAL_MS = 30_000;
const historyActivityWrites = new Map<number, number>();

async function persistSessionActivity(ptyId: number, ended: boolean): Promise<void> {
  const tab = useTerminalStore.getState().findTabByPtyId(ptyId);
  if (
    !tab ||
    tab.kind !== "assistant" ||
    !tab.assistantId ||
    !tab.providerSessionId
  ) {
    return;
  }

  const timestamp = Date.now();
  const lastWrite = historyActivityWrites.get(ptyId) ?? 0;
  if (!ended && timestamp - lastWrite < HISTORY_ACTIVITY_WRITE_INTERVAL_MS) return;
  historyActivityWrites.set(ptyId, timestamp);

  try {
    await recordSessionHistoryActivity(
      tab.assistantId,
      tab.providerSessionId,
      timestamp,
      ended,
    );
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn(`Failed to update ${tab.assistantId} session history:`, error);
    }
  } finally {
    if (ended) historyActivityWrites.delete(ptyId);
  }
}

function cleanupActivityState(ptyId: number) {
  const timer = activityTimers.get(ptyId);
  if (timer) { clearTimeout(timer); activityTimers.delete(ptyId); }
  activityActive.delete(ptyId);
  historyActivityWrites.delete(ptyId);
  stopAgentStatusObserver(ptyId);
}

export function registerTerminal(
  ptyId: number,
  term: Terminal,
  afterWrite: (() => void) | null = null,
) {
  terminalInstances.set(ptyId, {
    term,
    afterWrite,
    title: terminalTitles.get(ptyId) ?? "",
  });
}

export function recordTerminalTitle(ptyId: number, title: string) {
  terminalTitles.set(ptyId, title);
  const registration = terminalInstances.get(ptyId);
  if (registration) registration.title = title;
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
  terminalTitles.delete(ptyId);
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
          void persistSessionActivity(ptyId, false);
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
        void persistSessionActivity(ptyId, true);
        cleanupActivityState(ptyId);
        stopSessionTitleResolver(ptyId);
        setTabExited(ptyId, msg.data.code);
        const stoppedByUser = stoppingPtys.delete(ptyId);
        if (commandName) {
          const command = useCommandStore.getState().projectCommands[repoPath]
            ?.find((entry) => entry.name === commandName);
          if (command?.ptyId && command.ptyId !== ptyId) return;
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
      cwd = repoPath,
    ) => {
      if (!useTerminalStore.getState().projectState[repoPath]) return null;
      let resolvedPtyId: number | null = null;
      let abandoned = false;
      const bufferedMessages: PtyOutput[] = [];

      // Give CLIs an immediate background hint while their terminal-query
      // subscriptions are starting. Caller-provided values remain authoritative.
      const theme = useThemeStore.getState().theme;
      const fullEnv = { ...terminalColorEnvironment(theme), ...env };

      const ptyId = await spawnPty(
        command,
        commandArgs,
        cwd,
        fullEnv,
        cols,
        rows,
        toPtyColorTheme(theme),
        (msg) => {
          if (abandoned) return;
          if (resolvedPtyId === null) {
            bufferedMessages.push(msg);
            return;
          }

          handlePtyMessage(resolvedPtyId, commandName, repoPath, msg);
        },
      );

      if (!useTerminalStore.getState().projectState[repoPath]) {
        abandoned = true;
        await killPty(ptyId);
        return null;
      }
      resolvedPtyId = ptyId;
      initActivity(ptyId);

      for (const msg of bufferedMessages) {
        handlePtyMessage(ptyId, commandName, repoPath, msg);
      }

      return ptyId;
    },
    [handlePtyMessage, initActivity],
  );

  const attachSessionTab = useCallback(async (tab: TerminalTabData) => {
    if (addTab(tab)) return true;
    cleanupActivityState(tab.ptyId);
    removeActivity(tab.ptyId);
    await killPty(tab.ptyId);
    return false;
  }, [addTab, removeActivity]);

  const startCommand = useCallback(
    async (command: CommandConfig, cols: number, rows: number, requestedRepoPath?: string) => {
      const repoPath = requestedRepoPath ?? useRepoStore.getState().activeRepoPath;
      if (!repoPath) return;
      const commandName = command.name;
      const running = findTabByCommand(commandName, repoPath);
      if (running && useTerminalStore.getState().tabActivity[running.ptyId]?.alive) {
        setActiveTab(running.id, repoPath);
        return running.ptyId;
      }

      try {
        const ptyId = await spawnSession(
          command.command,
          null,
          command.env,
          cols,
          rows,
          commandName,
          repoPath,
          resolveCommandCwd(repoPath, command.cwd ?? null),
        );
        if (!ptyId) return;

        const existing = findTabByCommand(commandName, repoPath);
        if (existing && useTerminalStore.getState().tabActivity[existing.ptyId]?.alive) {
          await killPty(ptyId);
          cleanupActivityState(ptyId);
          removeActivity(ptyId);
          setActiveTab(existing.id, repoPath);
          return existing.ptyId;
        }
        if (existing) {
          // Replace an exited command tab so it points at the new process.
          removeTab(existing.id, repoPath);
          cleanupActivityState(existing.ptyId);
          removeActivity(existing.ptyId);
        }
        // Short-lived commands can exit before the spawn response reaches the UI.
        const activity = useTerminalStore.getState().tabActivity[ptyId];
        setCommandStatusForProject(repoPath, commandName, activity?.alive ? "running" : activity?.exitCode === 0 ? "stopped" : "crashed");
        setCommandPtyIdForProject(repoPath, commandName, activity?.alive ? ptyId : null);
        const id = nextTabId();
        if (!await attachSessionTab({
          id,
          kind: "terminal",
          label: commandName,
          ptyId,
          repoPath,
          commandName,
          assistantId: null,
          providerSessionId: null,
          sessionMode: null,
          labelSource: "default",
          agentInterface: "terminal",
        })) return null;

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
      spawnSession,
      setCommandStatusForProject,
      setCommandPtyIdForProject,
      findTabByCommand,
      setActiveTab,
      removeActivity,
      removeTab,
      attachSessionTab,
      pushNotice,
    ],
  );

  const stopCommand = useCallback(
    async (commandName: string, requestedRepoPath?: string) => {
      const path = requestedRepoPath ?? useCommandStore.getState().activeProjectPath;
      if (!path) return;
      const state = useTerminalStore.getState();
      const commands = useCommandStore.getState().projectCommands[path] ?? [];
      const command = commands.find((c) => c.name === commandName);
      const tab = state.getAllProjectTabs(path).find((t) => isSessionTab(t) && t.commandName === commandName);
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
        removeTab(tab.id, path);
      }
      setCommandStatusForProject(path, commandName, "stopped");
      setCommandPtyIdForProject(path, commandName, null);
    },
    [setCommandStatusForProject, setCommandPtyIdForProject, removeTab, removeActivity],
  );

  const restartCommand = useCallback(
    async (command: CommandConfig, cols: number, rows: number) => {
      const path = useRepoStore.getState().activeRepoPath;
      if (!path) return;
      await stopCommand(command.name, path);
      return startCommand(command, cols, rows, path);
    },
    [stopCommand, startCommand],
  );

  /** Open a terminal tab running a shell command string. */
  const runInTerminal = useCallback(
    async (script: string, label: string, cols: number, rows: number, requestedRepoPath?: string) => {
      const repoPath = requestedRepoPath ?? activeRepoPath;
      if (!repoPath) return null;

      try {
        const ptyId = await spawnSession(script, null, {}, cols, rows, null, repoPath);
        if (!ptyId) return null;
        if (!await attachSessionTab({
          id: nextTabId(),
          kind: "terminal",
          label,
          ptyId,
          repoPath,
          commandName: null,
          assistantId: null,
          providerSessionId: null,
          sessionMode: null,
          labelSource: "default",
          agentInterface: "terminal",
        })) return null;
        return ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(`Failed to open ${label}:`, e);
        }
        pushNotice({
          tone: "error",
          title: `Couldn’t open ${label}`,
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [activeRepoPath, spawnSession, attachSessionTab, pushNotice],
  );

  const spawnBlankShell = useCallback(
    async (cols: number, rows: number, requestedRepoPath?: string) => {
      const shell = await getDefaultShell();
      return runInTerminal(`${shell} -l`, "Terminal", cols, rows, requestedRepoPath);
    },
    [runInTerminal],
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
        const startedAfterMs = Date.now();
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
        if (!await attachSessionTab({
          id,
          kind: "assistant",
          label: assistant.name,
          ptyId,
          repoPath: activeRepoPath,
          commandName: null,
          assistantId,
          providerSessionId: null,
          sessionMode: mode,
          labelSource: "default",
          agentInterface: "terminal",
        })) return null;
        startSessionTitleResolver(ptyId, assistantId, activeRepoPath, startedAfterMs, model);
        startAgentStatusObserver(ptyId, assistantId, activeRepoPath);

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
    [activeRepoPath, spawnSession, attachSessionTab, pushNotice],
  );

  const resumeAssistant = useCallback(
    async (session: SessionHistoryEntry, cols: number, rows: number) => {
      const assistant = CODING_ASSISTANTS.find((entry) => entry.id === session.provider);
      const resumeArgs = sessionResumeArgs(session.provider, session.sessionId);
      const mode = useProjectSettingsStore.getState().settings.defaultAgentMode;
      const commandArgs = resumeArgs && mode === "yolo" && assistant?.yoloFlag
        ? [assistant.yoloFlag, ...resumeArgs]
        : resumeArgs;
      if (!assistant || !commandArgs) {
        pushNotice({
          tone: "error",
          title: "Resume isn’t supported",
          message: `Shep doesn’t know how to resume ${session.provider} sessions yet.`,
        });
        return null;
      }

      try {
        const resumedAt = Date.now();
        const ptyId = await spawnSession(
          assistant.command,
          commandArgs,
          {},
          cols,
          rows,
          null,
          session.projectPath,
        );
        if (!ptyId) return null;

        if (!await attachSessionTab({
          id: nextTabId(),
          kind: "assistant",
          label: session.title ?? assistant.name,
          ptyId,
          repoPath: session.projectPath,
          commandName: null,
          assistantId: session.provider,
          providerSessionId: session.sessionId,
          sessionMode: mode,
          labelSource: session.title ? "session" : "default",
          agentInterface: "terminal",
        })) return null;

        historyActivityWrites.set(ptyId, resumedAt);
        void upsertSessionHistory({
          provider: session.provider,
          agentInterface: "terminal",
          sessionId: session.sessionId,
          projectPath: session.projectPath,
          title: session.title,
          model: session.model,
          startedAt: session.startedAt,
          lastActivityAt: resumedAt,
        }).catch((error) => {
          if (import.meta.env.DEV) {
            console.warn(`Failed to mark ${session.provider} session as resumed:`, error);
          }
        });
        startSessionTitleResolver(
          ptyId,
          session.provider,
          session.projectPath,
          resumedAt,
          session.model ?? undefined,
          session.sessionId,
        );
        startAgentStatusObserver(ptyId, session.provider, session.projectPath);

        return ptyId;
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error(`Failed to resume ${assistant.name}:`, error);
        }
        pushNotice({
          tone: "error",
          title: `Couldn’t resume ${assistant.name}`,
          message: getErrorMessage(error),
        });
        return null;
      }
    },
    [attachSessionTab, pushNotice, spawnSession],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      const state = useTerminalStore.getState();
      const path = state.activeProjectPath;
      if (!path) return;
      const tabs = state.projectState[path]?.tabs ?? [];
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab || !isSessionTab(tab)) return;
      if (tab.agentInterface === "chat") {
        // Select the next tab before native cleanup or history I/O can stall.
        removeTab(tabId);
        await closeChat(tab.ptyId);
        return;
      }

      cleanupActivityState(tab.ptyId);
      stopSessionTitleResolver(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);
      await persistSessionActivity(tab.ptyId, true);

      if (tab.commandName) {
        setCommandStatusForProject(path, tab.commandName, "stopped");
        setCommandPtyIdForProject(path, tab.commandName, null);
      }

      removeTab(tabId, path);
    },
    [setCommandStatusForProject, setCommandPtyIdForProject, removeTab, removeActivity],
  );

  const killProjectPtys = useCallback(async (repoPath: string) => {
    const state = useTerminalStore.getState();
    const tabs = state.getAllProjectTabs(repoPath);

    for (const tab of tabs) {
      if (!isSessionTab(tab)) continue;
      if (tab.agentInterface === "chat") {
        await closeChat(tab.ptyId);
        continue;
      }
      cleanupActivityState(tab.ptyId);
      stopSessionTitleResolver(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);
      await persistSessionActivity(tab.ptyId, true);
    }
  }, [removeActivity]);

  return {
    startCommand,
    stopCommand,
    restartCommand,
    spawnBlankShell,
    runInTerminal,
    launchAssistant,
    resumeAssistant,
    closeTab,
    killProjectPtys,
  };
}
