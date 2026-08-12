/**
 * Structured receipts for mutating browser actions.
 *
 * The outer LLM already drives the loop. These receipts prove what changed so
 * the model does not need a screenshot after every keystroke. No model runs
 * here — only deterministic fields and next-step guidance.
 */

export type ActionNextDo = "continue" | "fix" | "observe" | "wait";

export type ActionNext = {
  do: ActionNextDo;
  skipScreenshot: boolean;
  skipFullSnapshot: boolean;
  reason: string;
  suggest?: string[];
};

export type ActionRefs = {
  valid: true | false | "unknown";
  reason: string;
};

export type ActionPage = {
  url: string;
  title: string;
  urlChanged?: boolean;
  titleChanged?: boolean;
};

export type ActionTarget = {
  ref?: string;
  selector?: string;
  role?: string;
  name?: string;
  tag?: string;
};

export type ActionError = {
  kind: string;
  text: string;
  ref?: string;
};

/**
 * Shared envelope for mutating tools. Additive over legacy ok/trusted/warning.
 */
export type ActionResult = {
  ok: boolean;
  verified: boolean;
  trusted: boolean;
  action: string;
  target?: ActionTarget;
  changed?: boolean;
  before?: string | null;
  after?: string | null;
  page: ActionPage;
  errors?: ActionError[];
  warning?: string;
  peek?: string;
  refs: ActionRefs;
  next: ActionNext;
  /** Legacy and tool-specific extras (value, match, strategy, …). */
  [key: string]: unknown;
};

export type BulkStepResult = {
  ok: boolean;
  verified?: boolean;
  action?: string;
  target?: ActionTarget;
  before?: string | null;
  after?: string | null;
  warning?: string;
  errors?: ActionError[];
  peek?: string;
  /** Legacy field id (ref or selector string). */
  field?: string;
  error?: string;
  [key: string]: unknown;
};

export type BulkResult = {
  ok: boolean;
  verified: boolean;
  trusted: boolean;
  action: string;
  count: { total: number; succeeded: number; failed: number };
  results: BulkStepResult[];
  page: ActionPage;
  refs: ActionRefs;
  next: ActionNext;
  warning?: string;
  peek?: string;
  [key: string]: unknown;
};

export async function readPage(tabId: number): Promise<ActionPage> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url ?? "", title: tab.title ?? "" };
  } catch {
    return { url: "", title: "" };
  }
}

export function pageDelta(before: ActionPage, after: ActionPage): ActionPage {
  return {
    url: after.url,
    title: after.title,
    urlChanged: before.url !== after.url,
    titleChanged: before.title !== after.title,
  };
}

/** Deterministic next-step for a single verified field write. */
export function nextVerifiedWrite(opts: {
  submitted?: boolean;
  navigated?: boolean;
  invalidHint?: boolean;
}): ActionNext {
  if (opts.navigated) {
    return {
      do: "observe",
      skipScreenshot: true,
      skipFullSnapshot: false,
      reason:
        "Write verified but the page navigated. Take browser_snapshot for new refs; skip screenshot unless you need visual QA.",
      suggest: ["browser_snapshot"],
    };
  }
  if (opts.submitted) {
    return {
      do: "observe",
      skipScreenshot: true,
      skipFullSnapshot: false,
      reason:
        "Write verified and Enter was pressed. Snapshot if the DOM may have changed; do not screenshot to re-check the field value.",
      suggest: ["browser_snapshot"],
    };
  }
  if (opts.invalidHint) {
    return {
      do: "fix",
      skipScreenshot: true,
      skipFullSnapshot: true,
      reason:
        "Value is in the field but the control reports invalid. Fix the value or read nearby errors; no screenshot needed.",
      suggest: ["browser_type", "browser_snapshot"],
    };
  }
  return {
    do: "continue",
    skipScreenshot: true,
    skipFullSnapshot: true,
    reason:
      "Value verified in the DOM. Do not screenshot or full-snapshot to confirm this write; continue the task.",
  };
}

export function nextFailedWrite(reason: string): ActionNext {
  return {
    do: "fix",
    skipScreenshot: true,
    skipFullSnapshot: false,
    reason,
    suggest: ["browser_snapshot", "browser_type"],
  };
}

export function nextBulk(opts: {
  failed: number;
  total: number;
  submitted?: boolean;
  navigated?: boolean;
}): ActionNext {
  if (opts.failed > 0) {
    return {
      do: "fix",
      skipScreenshot: true,
      skipFullSnapshot: true,
      reason: `${opts.failed} of ${opts.total} fields failed verification. Fix those rows; do not screenshot the whole form first.`,
      suggest: ["browser_type", "browser_snapshot"],
    };
  }
  if (opts.navigated || opts.submitted) {
    return {
      do: "observe",
      skipScreenshot: true,
      skipFullSnapshot: false,
      reason:
        "All fields verified. Page may have changed after submit/navigation — snapshot for new refs, not a screenshot loop.",
      suggest: ["browser_snapshot"],
    };
  }
  return {
    do: "continue",
    skipScreenshot: true,
    skipFullSnapshot: true,
    reason:
      "All fields verified. Skip screenshot/full snapshot; continue with the next task step.",
  };
}

export function refsAfterWrite(opts: {
  navigated?: boolean;
  targetGone?: boolean;
}): ActionRefs {
  if (opts.navigated) {
    return { valid: false, reason: "document navigated" };
  }
  if (opts.targetGone) {
    return { valid: false, reason: "target detached" };
  }
  return {
    valid: true,
    reason: "same-document verified write; prior snapshot refs should still work",
  };
}

export function targetFromParams(
  params: Record<string, unknown>,
  tag?: string,
  name?: string
): ActionTarget {
  const target: ActionTarget = {};
  if (typeof params.ref === "string" && params.ref) target.ref = params.ref;
  if (typeof params.selector === "string" && params.selector) {
    target.selector = params.selector;
  }
  if (tag) target.tag = tag;
  if (name) target.name = name;
  return target;
}

export function refsAfterNav(): ActionRefs {
  return { valid: false, reason: "document navigated" };
}

export function refsAfterClick(opts: {
  navigated?: boolean;
  targetGone?: boolean;
  dialogOpened?: boolean;
}): ActionRefs {
  if (opts.navigated) return refsAfterNav();
  if (opts.targetGone) return { valid: false, reason: "target detached" };
  if (opts.dialogOpened) {
    return {
      valid: false,
      reason: "dialog opened; prior refs may be covered or stale",
    };
  }
  return {
    valid: "unknown",
    reason: "same document click; refs often still work but were not revalidated",
  };
}

export function nextClick(opts: {
  changed?: boolean;
  navigated?: boolean;
  targetGone?: boolean;
  dialogOpened?: boolean;
  hasErrors?: boolean;
}): ActionNext {
  if (opts.navigated) {
    return {
      do: "observe",
      skipScreenshot: true,
      skipFullSnapshot: false,
      reason:
        "Click caused navigation. Take browser_snapshot for new refs; skip screenshot unless visual QA.",
      suggest: ["browser_snapshot"],
    };
  }
  if (opts.dialogOpened) {
    return {
      do: "observe",
      skipScreenshot: true,
      skipFullSnapshot: false,
      reason: "A dialog appeared. Snapshot for dialog refs; skip screenshot loop.",
      suggest: ["browser_snapshot"],
    };
  }
  if (opts.targetGone) {
    return {
      do: "observe",
      skipScreenshot: true,
      skipFullSnapshot: false,
      reason:
        "Target gone after click (re-render or nav). Snapshot before the next ref action.",
      suggest: ["browser_snapshot"],
    };
  }
  if (opts.hasErrors) {
    return {
      do: "fix",
      skipScreenshot: true,
      skipFullSnapshot: true,
      reason: "Click delivered but page shows errors/alerts. Fix from peek/errors.",
      suggest: ["browser_snapshot"],
    };
  }
  return {
    do: "continue",
    skipScreenshot: true,
    skipFullSnapshot: true,
    reason:
      opts.changed === false
        ? "Click delivered with no local state change (may still have worked). Prefer continuing; snapshot only if the next step needs new refs."
        : "Click delivered. Skip screenshot; snapshot only if you need new refs.",
  };
}

export function nextNav(opts: { navigated?: boolean; loadTimedOut?: boolean }): ActionNext {
  if (opts.loadTimedOut) {
    return {
      do: "wait",
      skipScreenshot: true,
      skipFullSnapshot: false,
      reason: "Navigation load timed out. Snapshot or wait, then continue.",
      suggest: ["browser_snapshot", "browser_wait"],
    };
  }
  if (opts.navigated === false) {
    return {
      do: "fix",
      skipScreenshot: true,
      skipFullSnapshot: false,
      reason:
        "Navigation did not change the URL as requested. Do not retry the same navigate blindly.",
      suggest: ["browser_snapshot", "browser_tabs"],
    };
  }
  return {
    do: "observe",
    skipScreenshot: true,
    skipFullSnapshot: false,
    reason: "Document navigated. Take browser_snapshot for fresh refs before acting.",
    suggest: ["browser_snapshot"],
  };
}

export function nextSoftAction(action: string): ActionNext {
  return {
    do: "continue",
    skipScreenshot: true,
    skipFullSnapshot: true,
    reason: `${action} completed. Skip screenshot; snapshot only if the next step needs updated structure.`,
  };
}

/** Whether a mini DOM peek is worth the extra page round-trip. */
export function shouldPeek(opts: {
  action: string;
  ok: boolean;
  verified?: boolean;
  changed?: boolean;
  navigated?: boolean;
  submitted?: boolean;
  invalidHint?: boolean;
  warning?: boolean;
  targetGone?: boolean;
}): boolean {
  if (opts.navigated || opts.submitted || opts.targetGone) return true;
  if (!opts.ok || opts.warning || opts.invalidHint) return true;
  if (opts.action === "fill_form") return true;
  if (opts.action === "click" || opts.action === "click_xy" || opts.action === "press_key") {
    return opts.changed === false || opts.changed === undefined;
  }
  return false;
}
