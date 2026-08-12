/**
 * Tab-scoped memory of the last mutating ActionResult, used only to coach
 * snapshot/screenshot when the model re-observes after a verified write.
 */

import type { ActionResult, BulkResult } from "./action-result";

export type LastActionSummary = {
  at: number;
  action: string;
  verified: boolean;
  skipScreenshot: boolean;
  skipFullSnapshot: boolean;
  refsValid: true | false | "unknown";
  targetRef?: string;
  url: string;
  nextDo: string;
  reason: string;
};

const TTL_MS = 60_000;
const byTab = new Map<number, LastActionSummary>();

export function rememberAction(
  tabId: number,
  result: ActionResult | BulkResult | Record<string, unknown>
): void {
  if (typeof result !== "object" || result === null) return;
  const r = result as Partial<ActionResult> & Record<string, unknown>;
  if (typeof r.action !== "string") return;
  if (typeof r.ok !== "boolean") return;

  const next = r.next as ActionResult["next"] | undefined;
  const refs = r.refs as ActionResult["refs"] | undefined;
  const page = r.page as ActionResult["page"] | undefined;
  const target = r.target as ActionResult["target"] | undefined;

  byTab.set(tabId, {
    at: Date.now(),
    action: r.action,
    verified: Boolean(r.verified),
    skipScreenshot: Boolean(next?.skipScreenshot),
    skipFullSnapshot: Boolean(next?.skipFullSnapshot),
    refsValid: refs?.valid ?? "unknown",
    targetRef: target?.ref,
    url: page?.url ?? "",
    nextDo: next?.do ?? "continue",
    reason: next?.reason ?? "",
  });

  if (refs?.valid === false || page?.urlChanged) {
    // Hard invalidation still stores the fact so coach can say "must re-snapshot".
  }
}

export function clearLastAction(tabId: number): void {
  byTab.delete(tabId);
}

export function getLastAction(tabId: number): LastActionSummary | null {
  const s = byTab.get(tabId);
  if (!s) return null;
  if (Date.now() - s.at > TTL_MS) {
    byTab.delete(tabId);
    return null;
  }
  return s;
}

/** Advisory line for snapshot/screenshot responses. */
export function coachNoteForObserve(
  tabId: number,
  kind: "screenshot" | "snapshot"
): string | undefined {
  const s = getLastAction(tabId);
  if (!s) return undefined;

  if (kind === "screenshot" && s.skipScreenshot && s.verified) {
    return (
      `note: last ${s.action}` +
      (s.targetRef ? ` on ${s.targetRef}` : "") +
      ` verified; next.skipScreenshot was true (${s.reason || "value already in DOM"}). ` +
      "Prefer continuing unless you need visual/layout proof."
    );
  }

  if (
    kind === "snapshot" &&
    s.skipFullSnapshot &&
    s.verified &&
    s.refsValid === true
  ) {
    return (
      `note: last ${s.action}` +
      (s.targetRef ? ` on ${s.targetRef}` : "") +
      ` verified with refs.valid=true; full snapshot may be redundant. ` +
      "Re-snapshot when refs.valid is false, after navigation, or for new labels."
    );
  }

  return undefined;
}
