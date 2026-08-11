import { WebSocketServer, WebSocket as WsClient, type WebSocket } from "ws";
import {
  DEFAULT_PORT,
  isHello,
  isResponse,
  isPeerHello,
  isRequest,
  isPeerStatus,
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

/**
 * Pick a stable id that is unique per chat/conversation when the host provides
 * one. Fall back to process id only when nothing better is available.
 */
function resolveSessionId(): string {
  const candidates = [
    process.env.DEEPORAX_SESSION_ID,
    process.env.CLAUDE_CODE_SESSION_ID,
    process.env.CLAUDE_SESSION_ID,
    process.env.CURSOR_SESSION_ID,
    process.env.VSCODE_SESSION_ID,
  ];
  for (const raw of candidates) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v) return `c_${v}`;
  }
  return `p_${process.pid}`;
}

export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private connectedAt: number | null = null;
  private seq = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private bindAttempts = 0;
  /**
   * Identity for browser isolation. Prefer the host's conversation id
   * (Claude Code sets CLAUDE_CODE_SESSION_ID per chat). Pid alone is wrong when
   * two chats share one long-lived MCP process, or when only one process ever
   * binds the bridge and the rest peer through it without unique ids.
   */
  readonly sessionId = resolveSessionId();
  /** True while another live server holds the port and we are waiting for it. */
  private waiting = false;
  /** Process id of whoever holds the port, so errors can name it. */
  private ownerPid: number | null = null;
  /**
   * Set when another server holds the port and we work through it.
   *
   * Only one process can own the port, but every editor session starts its own
   * server, and a session whose server cannot bind used to be dead. Rather than
   * fight over the port, the servers that lose it become clients of the one
   * that won and forward their calls through it, so every session can drive the
   * browser at once.
   */
  private peerSocket: WsClient | null = null;
  /** Host's view of whether the browser is reachable, as told to its peers. */
  private remoteConnected = false;
  /** Peer servers working through this one. */
  private peers = new Set<WebSocket>();
  /** Which peer is waiting on which request id. */
  private peerRoutes = new Map<string, WebSocket>();

  start(port = Number(process.env.DEEPORAX_MCP_PORT ?? DEFAULT_PORT)): void {
    if (this.wss || this.peerSocket) return;

    this.wss = new WebSocketServer({ host: "127.0.0.1", port });

    this.wss.on("listening", () => {
      this.bindAttempts = 0;
      this.waiting = false;
      this.ownerPid = null;
      console.error(
        `[deeporax-browser-mcp] bridge listening on ws://127.0.0.1:${port} session=${this.sessionId}`
      );
    });

    this.wss.on("connection", (socket, req) => {
      // A new socket is on probation until it identifies itself. Another
      // server probing this port is also a connection, and adopting it as the
      // extension would drop the real one: that alone produced a disconnect
      // every few seconds while a second session was retrying.
      // Only the extension may hold this socket.
      //
      // The port is on loopback, which is not an access control: a WebSocket is
      // exempt from CORS, so any page the user visits can open this port. Saying
      // hello is no barrier either, since the handshake carries no secret. What a
      // page cannot do is forge its Origin, and the extension's is always
      // chrome-extension://. Without this check a hostile page could take the
      // socket, receive the agent's tool requests, and answer them with invented
      // page content that the agent would then act on.
      // A browser always sends Origin and cannot fake it; a local process (a
      // peer server probing this port) sends none. So an Origin that is present
      // and is not the extension's means a web page is calling, and only that
      // case is refused.
      const origin = String(req.headers.origin ?? "");
      if (origin && !origin.startsWith("chrome-extension://")) {
        console.error(
          `[deeporax-browser-mcp] refused a bridge connection from ${origin || "an unidentified origin"}`
        );
        try {
          socket.close(4003, "only the browser extension may connect");
        } catch {
          /* ignore */
        }
        return;
      }

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
        this.tellAllPeers();
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

        // Another server working through this one. It is a local process, so
        // it carries no Origin and was not filtered above; that is the same
        // trust level any local process has always had. Web pages are still
        // refused, which is the boundary that matters.
        if (isPeerHello(parsed)) {
          clearTimeout(probation);
          if (!this.peers.has(socket)) {
            this.peers.add(socket);
            console.error(
              `[deeporax-browser-mcp] server ${parsed.pid} joined as a peer`
            );
          }
          this.tellPeer(socket);
          return;
        }

        // A peer's tool call: hand it to the extension and remember who asked.
        if (this.peers.has(socket) && isRequest(parsed)) {
          this.forwardFromPeer(socket, parsed);
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
        if (this.peers.delete(socket)) {
          for (const [id, peer] of this.peerRoutes) {
            if (peer === socket) this.peerRoutes.delete(id);
          }
        }
        if (this.client === socket) {
          this.client = null;
          this.connectedAt = null;
          console.error("[deeporax-browser-mcp] extension disconnected");
          this.failAll("Extension disconnected");
          this.tellAllPeers();
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
              "joining it as a peer so this session can use the browser too."
          );
        }
        this.joinHost(port);
        return;
      }
      console.error("[deeporax-browser-mcp] bridge error:", err.message);
    });
  }

  /**
   * Work through the server that owns the port.
   *
   * If that server goes away this socket closes, and we try to bind again;
   * whichever peer gets there first becomes the new host and the rest rejoin
   * it. No session is left without the browser.
   */
  private joinHost(port: number): void {
    if (this.peerSocket) return;

    let sock: WsClient;
    try {
      sock = new WsClient(`ws://127.0.0.1:${port}`);
    } catch {
      this.scheduleRebind(port);
      return;
    }
    this.peerSocket = sock;

    sock.on("open", () => {
      try {
        sock.send(JSON.stringify({ type: "peer", pid: process.pid }));
      } catch {
        /* the close handler retries */
      }
    });

    sock.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (isPeerStatus(msg)) {
        this.remoteConnected = msg.connected;
        this.ownerPid = msg.ownerPid;
        if (!msg.connected) this.failAll("Extension disconnected");
        return;
      }
      this.settle(msg);
    });

    const dropped = () => {
      if (this.peerSocket !== sock) return;
      this.peerSocket = null;
      this.remoteConnected = false;
      this.ownerPid = null;
      this.failAll("The server holding the browser connection went away");
      this.scheduleRebind(port);
    };
    sock.on("close", dropped);
    sock.on("error", dropped);
  }

  /** Try to own the port again once the current holder is gone. */
  private scheduleRebind(port: number): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start(port);
    }, WATCH_BIND_MS);
  }

  /** Tell one peer whether the browser is currently reachable. */
  private tellPeer(peer: WebSocket): void {
    try {
      peer.send(
        JSON.stringify({
          type: "peerStatus",
          connected:
        this.client?.readyState === 1 ||
        (this.peerSocket?.readyState === 1 && this.remoteConnected),
          ownerPid: process.pid,
        })
      );
    } catch {
      /* ignore */
    }
  }

  private tellAllPeers(): void {
    for (const peer of this.peers) this.tellPeer(peer);
  }

  /** Pass a peer's call to the extension and remember where the answer goes. */
  private forwardFromPeer(peer: WebSocket, request: BridgeRequest): void {
    if (!this.client || this.client.readyState !== 1) {
      try {
        peer.send(
          JSON.stringify({ id: request.id, ok: false, error: loadExtensionHint() })
        );
      } catch {
        /* ignore */
      }
      return;
    }
    this.peerRoutes.set(request.id, peer);
    try {
      this.client.send(JSON.stringify(request));
    } catch (err) {
      this.peerRoutes.delete(request.id);
      try {
        peer.send(
          JSON.stringify({
            id: request.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      } catch {
        /* ignore */
      }
    }
  }

  stop(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.failAll("Bridge stopped");
    try {
      this.peerSocket?.close();
    } catch {
      /* ignore */
    }
    this.peerSocket = null;
    this.client?.close();
    this.client = null;
    this.wss?.close();
    this.wss = null;
  }

  get status() {
    return {
      // A peer session reaches the browser through the host, so it is just as
      // connected as the host is. Reporting otherwise made working sessions
      // look broken.
      connected:
        this.client?.readyState === 1 ||
        (this.peerSocket?.readyState === 1 && this.remoteConnected),
      connectedAt: this.connectedAt,
      pendingRequests: this.pending.size,
      connectedVia: this.peerSocket?.readyState === 1 ? "peer" : "direct",
      ownerPid: this.ownerPid,
      peers: this.peers.size,
      sessionId: this.sessionId,
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
    // Either we hold the extension socket, or we work through the server that
    // does. Both are first class: a peer session is not a degraded one.
    const viaPeer = this.peerSocket?.readyState === 1;
    const direct = this.client?.readyState === 1;

    if (!direct && !viaPeer) {
      throw new Error(loadExtensionHint());
    }
    if (viaPeer && !this.remoteConnected) {
      throw new Error(loadExtensionHint());
    }

    const id = `req_${process.pid}_${Date.now()}_${++this.seq}`;
    // Stamp every call so the extension keeps this chat's tabs/group separate
    // from every other MCP process sharing the same browser bridge.
    const request: BridgeRequest = {
      id,
      method,
      params: { ...params, sessionId: this.sessionId },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for extension response to "${method}" (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        const socket = direct ? this.client! : this.peerSocket!;
        socket.send(JSON.stringify(request));
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

    if (isResponse(msg)) {
      const peer = this.peerRoutes.get(msg.id);
      if (peer) {
        this.peerRoutes.delete(msg.id);
        try {
          peer.send(raw);
        } catch {
          /* peer went away mid-call */
        }
        return;
      }
    }

    this.settle(msg);
  }

  /** Resolve whatever call this response belongs to. */
  private settle(msg: unknown): void {
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
