import type { Terminal } from "@xterm/xterm";

export interface TerminalViewportSnapshot {
  baseY: number;
  viewportY: number;
  bottomOffset: number;
}

interface TerminalPipelineCounter {
  bytesReceived: number;
  sampleBytes: number;
  sampleStartedAt: number;
  bytesPerSecond: number;
  flushCount: number;
  lastWriteBatchChars: number;
  maxWriteBatchChars: number;
  pendingOutputChars: number;
  maxPendingOutputChars: number;
  truncatedChars: number;
  viewportBefore: TerminalViewportSnapshot | null;
  viewportAfter: TerminalViewportSnapshot | null;
}

export interface TerminalPipelineSnapshot extends Omit<TerminalPipelineCounter, "sampleBytes" | "sampleStartedAt"> {
  ptyId: number;
}

const counters = new Map<number, TerminalPipelineCounter>();
const lastConsoleLogAt = new Map<number, number>();
const logCompletion = new Set<number>();
const encoder = new TextEncoder();

function counterFor(ptyId: number): TerminalPipelineCounter {
  let counter = counters.get(ptyId);
  if (!counter) {
    counter = {
      bytesReceived: 0,
      sampleBytes: 0,
      sampleStartedAt: performance.now(),
      bytesPerSecond: 0,
      flushCount: 0,
      lastWriteBatchChars: 0,
      maxWriteBatchChars: 0,
      pendingOutputChars: 0,
      maxPendingOutputChars: 0,
      truncatedChars: 0,
      viewportBefore: null,
      viewportAfter: null,
    };
    counters.set(ptyId, counter);
  }
  return counter;
}

export function terminalViewportSnapshot(term: Terminal): TerminalViewportSnapshot {
  const buffer = term.buffer.active;
  return {
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    bottomOffset: Math.max(0, buffer.baseY - buffer.viewportY),
  };
}

export function recordTerminalData(ptyId: number, data: string): void {
  if (!import.meta.env.DEV) return;
  const counter = counterFor(ptyId);
  const bytes = encoder.encode(data).byteLength;
  counter.bytesReceived += bytes;
  counter.sampleBytes += bytes;
  const now = performance.now();
  const elapsed = now - counter.sampleStartedAt;
  if (elapsed >= 1_000) {
    counter.bytesPerSecond = Math.round((counter.sampleBytes * 1_000) / elapsed);
    counter.sampleBytes = 0;
    counter.sampleStartedAt = now;
  }
}

export function recordPendingOutput(
  ptyId: number,
  pendingChars: number,
  truncatedChars = 0,
): void {
  if (!import.meta.env.DEV) return;
  const counter = counterFor(ptyId);
  counter.pendingOutputChars = pendingChars;
  counter.maxPendingOutputChars = Math.max(counter.maxPendingOutputChars, pendingChars);
  counter.truncatedChars += truncatedChars;
}

export function recordWriteFlush(
  ptyId: number,
  batchChars: number,
  term: Terminal,
): void {
  if (!import.meta.env.DEV) return;
  const counter = counterFor(ptyId);
  counter.flushCount += 1;
  counter.lastWriteBatchChars = batchChars;
  counter.maxWriteBatchChars = Math.max(counter.maxWriteBatchChars, batchChars);
  counter.viewportBefore = terminalViewportSnapshot(term);
  const now = performance.now();
  const lastLog = lastConsoleLogAt.get(ptyId) ?? Number.NEGATIVE_INFINITY;
  if (now - lastLog >= 1_000) {
    lastConsoleLogAt.set(ptyId, now);
    logCompletion.add(ptyId);
    console.debug("[terminal-pipeline] write flush", terminalPipelineSnapshot(ptyId));
  }
}

export function recordWriteComplete(ptyId: number, term: Terminal): void {
  if (!import.meta.env.DEV) return;
  const counter = counterFor(ptyId);
  counter.viewportAfter = terminalViewportSnapshot(term);
  if (logCompletion.delete(ptyId)) {
    console.debug("[terminal-pipeline] write complete", terminalPipelineSnapshot(ptyId));
  }
}

export function terminalPipelineSnapshot(ptyId: number): TerminalPipelineSnapshot | null {
  const counter = counters.get(ptyId);
  if (!counter) return null;
  const { sampleBytes: _sampleBytes, sampleStartedAt: _sampleStartedAt, ...snapshot } = counter;
  const elapsed = performance.now() - counter.sampleStartedAt;
  const liveBytesPerSecond = counter.sampleBytes > 0 && elapsed > 0
    ? Math.round((counter.sampleBytes * 1_000) / elapsed)
    : elapsed >= 1_000
      ? 0
      : counter.bytesPerSecond;
  return { ptyId, ...snapshot, bytesPerSecond: liveBytesPerSecond };
}

export function allTerminalPipelineSnapshots(): TerminalPipelineSnapshot[] {
  return [...counters.keys()].map(terminalPipelineSnapshot).filter((value) => value !== null);
}

export function clearTerminalPipelineCounters(ptyId: number): void {
  counters.delete(ptyId);
  lastConsoleLogAt.delete(ptyId);
  logCompletion.delete(ptyId);
}

if (import.meta.env.DEV) {
  const debugGlobal = globalThis as typeof globalThis & {
    __shepTerminalPipeline?: {
      snapshot: (ptyId: number) => TerminalPipelineSnapshot | null;
      snapshots: () => TerminalPipelineSnapshot[];
    };
  };
  debugGlobal.__shepTerminalPipeline = {
    snapshot: terminalPipelineSnapshot,
    snapshots: allTerminalPipelineSnapshots,
  };
}
