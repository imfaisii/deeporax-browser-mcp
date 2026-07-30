import { WebSocketServer, WebSocket as WsClient, type WebSocket } from "ws";
import {
  DEFAULT_PORT,
  isHello,
  isResponse,
  isYield,
  type BridgeRequest,
} from "./protocol.js";
import { loadExtensionHint } from "./paths.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 30_000;
/** How long to wait before retrying a bridge port held by another server. */
const RETRY_BIND_MS = 2_000;
/**
 * Give up after this many attempts. A losing server must not spin forever: it
 * would wake the CPU every couple of seconds for the life of the session.
 */
const MAX_BIND_ATTEMPTS = 10;

export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private connectedAt: number | null = null;
  private seq = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private bindAttempts = 0;
  /** Set when we permanently lost the port to another live server. */
  private standby = false;

  start(port = Number(process.env.DEEPORAX_MCP_PORT ?? DEFAULT_PORT)): void {
    if (this.wss) return;

    this.wss = new WebSocketServer({ host: "127.0.0.1", port });

    this.wss.on("listening", () => {
      this.bindAttempts = 0;
      this.standby = false;
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
        try {
          this.wss?.close();
        } catch {
          /* ignore */
        }
        this.wss = null;
        this.bindAttempts += 1;

        if (this.bindAttempts > MAX_BIND_ATTEMPTS) {
          this.standby = true;
          console.error(
            `[deeporax-browser-mcp] port ${port} is owned by another live server; ` +
              "staying in standby. Tools will report the conflict instead of retrying."
          );
          return;
        }

        console.error(
          `[deeporax-browser-mcp] port ${port} busy, retry ` +
            `${this.bindAttempts}/${MAX_BIND_ATTEMPTS} in ${RETRY_BIND_MS}ms`
        );
        this.askIncumbentToYield(port);
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

  /**
   * Close our listener so a newer server can bind. Any connected extension is
   * dropped; it reconnects to whoever owns the port next.
   */
  private releaseForTakeover(): void {
    this.failAll("Bridge handed over to a newer server");
    try {
      this.client?.close(4001, "server handover");
    } catch {
      /* ignore */
    }
    this.client = null;
    this.connectedAt = null;
    try {
      this.wss?.close();
    } catch {
      /* ignore */
    }
    this.wss = null;
  }

  /**
   * Ask whoever holds the port to step aside. Harmless if the socket belongs to
   * something else entirely: it just receives a message it ignores.
   */
  private askIncumbentToYield(port: number): void {
    let sock: WsClient;
    try {
      sock = new WsClient(`ws://127.0.0.1:${port}`);
    } catch {
      return;
    }
    const done = () => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    };
    sock.on("open", () => {
      try {
        sock.send(JSON.stringify({ type: "yield", pid: process.pid }));
      } catch {
        /* ignore */
      }
      setTimeout(done, 200);
    });
    sock.on("error", done);
  }

  stop(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
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
      standby: this.standby,
    };
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.client || this.client.readyState !== 1) {
      if (this.standby) {
        throw new Error(
          "Another deeporax-browser-mcp server already owns the bridge port. " +
            "Close the other MCP client (or its stale process) and retry; this " +
            "server is idle and will not fight for the port."
        );
      }
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

    if (isYield(msg)) {
      console.error(
        `[deeporax-browser-mcp] newer server (pid ${msg.pid}) requested the port; releasing it`
      );
      this.releaseForTakeover();
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
