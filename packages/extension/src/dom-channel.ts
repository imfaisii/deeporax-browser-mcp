/**
 * Shared route into the page's isolated world.
 *
 * Snapshot refs live in the isolated world, so anything that needs to resolve
 * a ref has to go through the content script rather than CDP's main-world
 * `Runtime.evaluate`. The background wires the real implementation in at
 * startup; this module exists so both the interaction layer and the text
 * entry layer can use it without depending on each other.
 */
export type DomCaller = (
  tabId: number,
  method: string,
  params: Record<string, unknown>
) => Promise<unknown>;

let domCall: DomCaller = async () => {
  throw new Error("interaction layer not initialised");
};

export function useDomChannel(fn: DomCaller): void {
  domCall = fn;
}

export function dom(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return domCall(tabId, method, params);
}

/** Only the two keys that identify a target, so callers can spread params. */
export function targetOf(params: Record<string, unknown>) {
  return { ref: params.ref, selector: params.selector };
}
