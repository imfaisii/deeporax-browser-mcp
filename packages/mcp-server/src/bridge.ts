import { WebSocketServer, WebSocket as WsClient, type WebSocket } from "ws";
import {
  DEFAULT_PORT,
  isHello,
  isResponse,
  isWhois,
  isOwner,
  type BridgeRequest,
} from "./protocol.js";
import { loadExtensionHint } from "./paths.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 30_000;
/**
 * How often a server without the port checks whether it has been freed.
 *
 * There is no attempt limit. A server that stops watching can never recover
 * when the holder exits, and the only way back is for the user to restart the
 * whole session, which is exactly the failure this replaced.
 */
const WATCH_BIND_MS = 3_000;
/** Re-check who owns the port every this many watch ticks. */
const REPROBE_EVERY = 10;

export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private connectedAt: number | null = null;
  private seq = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private bindAttempts = 0;
  /** True while another live server holds the port and we are waiting for it. */
  private waiting = false;
  /** Process id of whoever holds the port, so errors can name it. */
  private ownerPid: number | null = null;

  start(port = Number(process.env.DEEPORAX_MCP_PORT ?? DEFAULT_PORT)): void {
    if (this.wss) return;

    this.wss = new WebSocketServer({ host: "127.0.0.1", port });

    this.wss.on("listening", () => {
      this.bindAttempts = 0;
      this.waiting = false;
      this.ownerPid = null;
      console.error(`[deeporax-browser-mcp] bridge listening on ws://127.0.0.1:${port}`);
    });

    this.wss.on("connection", (socket) => {
      // A new socket is on probation until it identifies itself. Another
      // server probing this port is also a connection, and adopting it as the
      // extension would drop the real one: that alone produced a disconnect
      // every few seconds while a second session was retrying.
      let adopted = false;

      const adopt = () => {
        if (adopted) return;
        adopted = true;
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
      };

      // Anything that never says hello is not the extension; hang up on it.
      const probation = setTimeout(() => {
        if (!adopted) {
          try {
            socket.close(4002, "did not identify as the extension");
          } catch {
            /* ignore */
          }
        }
      }, 2_000);

      socket.on("message", (raw) => {
        const text = String(raw);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }

        // Answer a peer server's probe without disturbing the extension.
        if (isWhois(parsed)) {
          try {
            socket.send(
              JSON.stringify({
                type: "owner",
                pid: process.pid,
                hasExtension: this.client?.readyState === 1,
              })
            );
          } catch {
            /* ignore */
          }
          return;
        }

        if (isHello(parsed)) {
          clearTimeout(probation);
          adopt();
        }
        if (!adopted) return;
        this.onMessage(text);
      });

      socket.on("close", () => {
        clearTimeout(probation);
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

        // Whoever bound first keeps serving. Taking the port away from a live
        // server drops its extension connection mid-call, and with more than
        // two sessions open they take turns evicting each other forever.
        if (!this.waiting) {
          this.waiting = true;
          console.error(
            `[deeporax-browser-mcp] port ${port} is held by another server; ` +
              "waiting for it to exit rather than taking it."
          );
        }
        if (this.bindAttempts === 1 || this.bindAttempts % REPROBE_EVERY === 0) {
          this.probeOwner(port);
        }
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.start(port);
          }, WATCH_BIND_MS);
        }
        return;
      }
      console.error("[deeporax-browser-mcp] bridge error:", err.message);
    });
  }

  /**
   * Ask the port holder who it is, so a failure can name the process to close.
   * Read-only: the holder answers and keeps its extension connection.
   */
  private probeOwner(port: number): void {
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
    const giveUp = setTimeout(done, 1_000);
    sock.on("open", () => {
      try {
        sock.send(JSON.stringify({ type: "whois" }));
      } catch {
        done();
      }
    });
    sock.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (isOwner(msg)) this.ownerPid = msg.pid;
      clearTimeout(giveUp);
      done();
    });
    sock.on("error", () => {
      clearTimeout(giveUp);
      done();
    });
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
      waiting: this.waiting,
      ownerPid: this.ownerPid,
    };
  }

  /**
   * `timeoutMs` exists because batch calls do real work per field. A single
   * fixed budget either cuts long batches off partway or hides a hung tab.
   */
  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    if (!this.client || this.client.readyState !== 1) {
      if (this.waiting) {
        const who = this.ownerPid ? ` (process ${this.ownerPid})` : "";
        throw new Error(
          `Another deeporax-browser-mcp server${who} is already connected to Chrome. ` +
            "Only one can drive the browser at a time. Use that session, or close it " +
            "and this server will pick the browser up within a few seconds."
        );
      }
      throw new Error(loadExtensionHint());
    }

    const id = `req_${Date.now()}_${++this.seq}`;
    const request: BridgeRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for extension response to "${method}" (${timeoutMs}ms)`));
      }, timeoutMs);

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
