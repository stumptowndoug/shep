import { create } from "zustand";
import { CODING_ASSISTANTS } from "../components/sidebar/constants";
import { getErrorMessage } from "../lib/errors";
import { checkCommandExists, getManagedAcpAdapter } from "../lib/tauri";
import type { AcpAdapter } from "../lib/types";

export interface AvailabilityCheck {
  available?: boolean;
  checking: boolean;
  error: string | null;
  checkedAt: number;
}

interface AgentAvailabilityStore {
  checks: Record<string, AvailabilityCheck>;
  refresh: (force?: boolean) => Promise<void>;
  markChatInstalled: (adapter: AcpAdapter) => void;
}

const FRESH_FOR_MS = 30_000;
export const commandAvailabilityKey = (command: string) => `command:${command}`;
export const chatAvailabilityKey = (adapter: AcpAdapter) => adapter.managed
  ? `managed:${adapter.managed}` : commandAvailabilityKey(adapter.command);

// This is an in-memory UI cache. Starting a managed adapter still verifies its
// actual files; changing chat activity never changes installation availability.
export const useAgentAvailabilityStore = create<AgentAvailabilityStore>((set, get) => {
  const pending = new Map<string, Promise<void>>();
  const revisions = new Map<string, number>();
  const check = (key: string, probe: () => Promise<boolean>, force: boolean): Promise<void> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const previous = get().checks[key];
    // Recheck missing adapters immediately when returning from a setup terminal.
    if (!force && previous?.available && !previous.error && Date.now() - previous.checkedAt < FRESH_FOR_MS) return Promise.resolve();
    const revision = (revisions.get(key) ?? 0) + 1;
    revisions.set(key, revision);
    set(state => ({ checks: { ...state.checks, [key]: { ...previous, checking: true, error: null, checkedAt: previous?.checkedAt ?? 0 } } }));
    const request = probe().then(available => {
      if (revisions.get(key) !== revision) return;
      set(state => ({ checks: { ...state.checks, [key]: { available, checking: false, error: null, checkedAt: Date.now() } } }));
    }).catch(error => {
      if (revisions.get(key) !== revision) return;
      // An IPC/check failure is not evidence that an installed adapter vanished.
      set(state => ({ checks: { ...state.checks, [key]: { ...state.checks[key], checking: false, error: getErrorMessage(error) } } }));
    }).finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
    return request;
  };

  return {
    checks: {},
    refresh: async (force = false) => {
      const probes = new Map<string, () => Promise<boolean>>();
      for (const assistant of CODING_ASSISTANTS) {
        probes.set(commandAvailabilityKey(assistant.command), () => checkCommandExists(assistant.command));
        const adapter = assistant.acp;
        if (adapter) probes.set(chatAvailabilityKey(adapter), () => adapter.managed
          ? getManagedAcpAdapter(adapter.managed).then(Boolean) : checkCommandExists(adapter.command));
      }
      await Promise.all([...probes].map(([key, probe]) => check(key, probe, force)));
    },
    markChatInstalled: (adapter) => {
      const key = chatAvailabilityKey(adapter);
      // A check that started before the installation cannot undo its success.
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      pending.delete(key);
      set(state => ({ checks: { ...state.checks, [key]: { available: true, checking: false, error: null, checkedAt: Date.now() } } }));
    },
  };
});
