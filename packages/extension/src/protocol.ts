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
