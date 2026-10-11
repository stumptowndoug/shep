import { killAcpAgent, spawnAcpAgent, writeAcpAgent, type AcpOutput } from "../tauri";

/** JSON-RPC error raised by the agent in response to one of our requests. */
export class AcpError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface AcpHandlers {
  /** Agent → client request. Return the result, or throw to send an error. */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onNotification: (method: string, params: unknown) => void;
  onExit: (code: number, stderr: string) => void;
  onStderr?: (line: string) => void;
}

/**
 * Newline-delimited JSON-RPC 2.0 over an agent's stdio (via the Rust bridge).
 * Only the transport lives here; session semantics belong to the caller.
 */
export class AcpConnection {
  private nextRequestId = 0;
  private readonly pending = new Map<number, Pending>();
  private exited = false;
  private writes: Promise<void> = Promise.resolve();

  private constructor(readonly id: number, private readonly handlers: AcpHandlers) {}

  static async spawn(command: string, args: string[], cwd: string, handlers: AcpHandlers) {
    let connection: AcpConnection | null = null;
    // Output can arrive before spawn resolves with the id; replay it after.
    const early: AcpOutput[] = [];
    const id = await spawnAcpAgent(command, args, cwd, (msg) => {
      if (connection) connection.receive(msg);
      else early.push(msg);
    });
    connection = new AcpConnection(id, handlers);
    for (const msg of early) connection.receive(msg);
    return connection;
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error("Agent is not running"));
    const id = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.exited) return;
    void this.send({ jsonrpc: "2.0", method, params }).catch(() => {});
  }

  kill(): Promise<void> {
    this.disconnect("Agent closed");
    return killAcpAgent(this.id);
  }

  private send(message: object): Promise<void> {
    // Native writes run off the UI thread. Keep their wire order and let kill
    // bypass the queue when an adapter stops reading stdin.
    const line = JSON.stringify(message);
    const write = this.writes.then(() => {
      if (this.exited) throw new Error("Agent is not running");
      return writeAcpAgent(this.id, line);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private disconnect(reason: string) {
    this.exited = true;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
  }

  private receive(msg: AcpOutput) {
    if (this.exited) return;
    if (msg.event === "stderr") {
      this.handlers.onStderr?.(msg.data);
      return;
    }
    if (msg.event === "exit") {
      this.disconnect("Agent exited");
      this.handlers.onExit(msg.data.code, msg.data.stderr);
      return;
    }

    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(msg.data);
    } catch {
      return; // Adapters occasionally log to stdout; ignore non-JSON lines.
    }

    if (message.method && message.id !== undefined) {
      const requestId = message.id;
      this.handlers
        .onRequest(message.method, message.params)
        .then((result) => this.send({ jsonrpc: "2.0", id: requestId, result: result ?? null }))
        .catch((error: unknown) => {
          const code = error instanceof AcpError ? error.code : -32603;
          const text = error instanceof Error ? error.message : String(error);
          return this.send({ jsonrpc: "2.0", id: requestId, error: { code, message: text } });
        })
        .catch(() => {});
    } else if (message.method) {
      this.handlers.onNotification(message.method, message.params);
    } else if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new AcpError(message.error.message, message.error.code));
      else pending.resolve(message.result);
    }
  }
}
