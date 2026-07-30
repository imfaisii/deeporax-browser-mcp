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
export type YieldMessage = { type: "yield"; pid: number };

export type BridgeMessage =
  | BridgeRequest
  | BridgeResponse
  | HelloMessage
  | PingMessage
  | PongMessage
  | YieldMessage;

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

export function isYield(msg: unknown): msg is YieldMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as YieldMessage).type === "yield"
  );
}

export function isHello(msg: unknown): msg is HelloMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as HelloMessage).type === "hello"
  );
}
