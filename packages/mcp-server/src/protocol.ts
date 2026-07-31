/** Wire protocol between MCP server and Chrome extension over WebSocket. */

export const DEFAULT_PORT = 17373;
export const PROTOCOL_VERSION = "1.0.0";

export type BridgeRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type BridgeSuccess = {
  id: string;
  ok: true;
  result: unknown;
};

export type BridgeFailure = {
  id: string;
  ok: false;
  error: string;
};

export type BridgeResponse = BridgeSuccess | BridgeFailure;

export type HelloMessage = {
  type: "hello";
  version: string;
  extensionId?: string;
};

export type PingMessage = { type: "ping" };
export type PongMessage = { type: "pong" };

/**
 * Sent by a newly started server to whoever currently owns the bridge port.
 * The old server shuts its listener down so the new one can take over. This
 * keeps a single MCP host in control when an earlier process was orphaned.
 */
/** Sent by a server that could not bind, to work through the one that did. */
export type PeerHelloMessage = { type: "peer"; pid: number };
/** Host tells its peers whether the browser is actually reachable. */
export type PeerStatusMessage = {
  type: "peerStatus";
  connected: boolean;
  ownerPid: number;
};

export type BridgeMessage =
  | BridgeRequest
  | BridgeResponse
  | HelloMessage
  | PingMessage
  | PongMessage
  | PeerHelloMessage
  | PeerStatusMessage;

export function isRequest(msg: unknown): msg is BridgeRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "id" in msg &&
    "method" in msg &&
    !("ok" in msg) &&
    !("type" in msg)
  );
}

export function isResponse(msg: unknown): msg is BridgeResponse {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "id" in msg &&
    "ok" in msg &&
    typeof (msg as BridgeResponse).ok === "boolean"
  );
}

export function isHello(msg: unknown): msg is HelloMessage {
  return (
    typeof msg === "object" && msg !== null && (msg as HelloMessage).type === "hello"
  );
}

export function isPeerHello(msg: unknown): msg is PeerHelloMessage {
  return (
    typeof msg === "object" && msg !== null && (msg as PeerHelloMessage).type === "peer"
  );
}

export function isPeerStatus(msg: unknown): msg is PeerStatusMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as PeerStatusMessage).type === "peerStatus"
  );
}
