import { checkCommandExists, getManagedAcpAdapter } from "../tauri";
import type { AcpAdapter } from "../types";

export async function chatAdapterAvailable(adapter: AcpAdapter): Promise<boolean> {
  try {
    return adapter.managed ? Boolean(await getManagedAcpAdapter(adapter.managed)) : await checkCommandExists(adapter.command);
  } catch { return false; }
}

export async function chatAdapterCommand(adapter: AcpAdapter) {
  if (!adapter.managed) return { command: adapter.command, args: adapter.args };
  const runtime = await getManagedAcpAdapter(adapter.managed);
  if (!runtime) throw new Error("Install the Antigravity chat runtime from a new tab first.");
  return runtime;
}
