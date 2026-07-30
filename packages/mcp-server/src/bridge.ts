import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_PORT,
  isHello,
  isResponse,
  type BridgeRequest,
} from "./protocol.js";
import { loadExtensionHint } from "./paths.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 30_000;
/** How long to wait before retrying a bridge port held by a stale server. */
const RETRY_BIND_MS = 2_000;

export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private connectedAt: number | null = null;
  private seq = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  start(port = Number(process.env.DEEPORAX_MCP_PORT ?? DEFAULT_PORT)): void {
    if (this.wss) return;

    this.wss = new WebSocketServer({ host: "127.0.0.1", port });

    this.wss.on("listening", () => {
      console.error(`[deeporax-browser-mcp] bridge listening on ws://127.0.0.1:${port}`);
    });

    this.wss.on("connection", (socket) => {
      // Only one extension client at a time; newest wins.
      if (this.client && this.client !== socket) {
        try {
          this.client.close(4000, "replaced by new connection");
        } catch {
          /* ignore */
        }
      }

      this.client = socket;
      this.connectedAt = Date.now();
      console.error("[deeporax-browser-mcp] extension connected");

      socket.on("message", (raw) => {
        this.onMessage(String(raw));
      });

      socket.on("close", () => {
        if (this.client === socket) {
          this.client = null;
          this.connectedAt = null;
          console.error("[deeporax-browser-mcp] extension disconnected");
          this.failAll("Extension disconnected");
        }
      });

      socket.on("error", (err) => {
        console.error("[deeporax-browser-mcp] socket error:", err.message);
      });

      // Keepalive
      const ping = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 15_000);
      socket.on("close", () => clearInterval(ping));
    });

    this.wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // A stale server from a previous session still owns the port. Keep
        // retrying so the extension can connect once that process exits.
        console.error(
          `[deeporax-browser-mcp] port ${port} busy, retrying in ${RETRY_BIND_MS}ms`
        );
        try {
          this.wss?.close();
        } catch {
          /* ignore */
        }
        this.wss = null;
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.start(port);
          }, RETRY_BIND_MS);
        }
        return;
      }
      console.error("[deeporax-browser-mcp] bridge error:", err.message);
    });
  }

  stop(): void {
    this.failAll("Bridge stopped");
    this.client?.close();
    this.client = null;
    this.wss?.close();
    this.wss = null;
  }

  get status() {
    return {
      connected: this.client?.readyState === 1,
      connectedAt: this.connectedAt,
      pendingRequests: this.pending.size,
    };
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.client || this.client.readyState !== 1) {
      throw new Error(loadExtensionHint());
    }

    const id = `req_${Date.now()}_${++this.seq}`;
    const request: BridgeRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for extension response to "${method}" (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.client!.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("[deeporax-browser-mcp] invalid JSON from extension");
      return;
    }

    if (isHello(msg)) {
      console.error(`[deeporax-browser-mcp] hello from extension v${msg.version}`);
      return;
    }

    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { type?: string }).type === "pong"
    ) {
      return;
    }

    if (!isResponse(msg)) return;

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);

    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error || "Unknown extension error"));
    }
  }

  private failAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

export const bridge = new ExtensionBridge();
