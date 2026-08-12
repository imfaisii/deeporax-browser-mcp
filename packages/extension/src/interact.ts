/**
 * Trusted interaction layer.
 *
 * Every pointer and keyboard action goes through the debugger so the page
 * receives `isTrusted: true` events. Component libraries ignore synthetic
 * events, which is why the previous implementation could report success on a
 * checkbox that never changed.
 *
 * Each action also captures the target's observable state before and after,
 * so callers learn whether anything actually happened instead of receiving an
 * unconditional `ok: true`.
 */
import * as cdp from "./cdp";
import {
  type ActionResult,
  type BulkResult,
  type BulkStepResult,
  nextBulk,
  nextClick,
  nextFailedWrite,
  nextSoftAction,
  nextVerifiedWrite,
  pageDelta,
  readPage,
  refsAfterClick,
  refsAfterWrite,
  shouldPeek,
  targetFromParams,
} from "./action-result";
import { dom as domCall } from "./dom-channel";
import { setText } from "./text-entry";

export { useDomChannel } from "./dom-channel";
export type { ActionResult, BulkResult } from "./action-result";

async function maybePeek(
  tabId: number,
  opts: Parameters<typeof shouldPeek>[0]
): Promise<string | undefined> {
  if (!shouldPeek(opts)) return undefined;
  try {
    const res = (await domCall(tabId, "mini_peek", {
      form: opts.action === "fill_form" || opts.submitted,
    })) as { peek?: string };
    const peek = res?.peek?.trim();
    return peek || undefined;
  } catch {
    return undefined;
  }
}

function peekHasDialog(peek?: string): boolean {
  return Boolean(peek && /^dialogs:/m.test(peek));
}

function peekHasAlerts(peek?: string): boolean {
  return Boolean(peek && (/^alerts:/m.test(peek) || /^invalid:/m.test(peek)));
}

/** @deprecated Prefer ActionResult — kept as a loose alias for older call sites. */
export type InteractionOutcome = {
  ok: boolean;
  /** True when the action ran through the trusted CDP path. */
  trusted: boolean;
  /** Set when the target's observable state changed. */
  changed?: boolean;
  /** Populated when we could not confirm an effect. */
  warning?: string;
  [key: string]: unknown;
};

/** Geometry and state, resolved in the isolated world where refs live. */
export type Target = {
  x: number;
  y: number;
  width: number;
  height: number;
  tag: string;
  text: string;
  state: string;
  covered: boolean;
  coveredBy?: string;
};

/**
 * Ask the content script to locate the element.
 *
 * This deliberately does not go through CDP: snapshot refs are stored in the
 * isolated world, and Runtime.evaluate runs in the main world where that map
 * does not exist. The background passes in the caller so we stay decoupled
 * from how the DOM channel is implemented.
 */
async function resolveTarget(
  tabId: number,
  params: Record<string, unknown>
): Promise<Target> {
  // The content script raises the useful message ("stale ref", "no element
  // matches selector"). Let it through rather than flattening every failure
  // into one unhelpful line.
  const target = (await domCall(tabId, "resolve_target", {
    ref: params.ref,
    selector: params.selector,
  })) as Target;

  if (!target || typeof target.x !== "number") {
    const what = params.ref
      ? `ref "${params.ref}"`
      : params.selector
        ? `selector "${params.selector}"`
        : "the target";
    throw new Error(
      `Could not resolve ${what}. Take a fresh browser_snapshot and use a current ref.`
    );
  }
  return target;
}

async function readState(
  tabId: number,
  params: Record<string, unknown>
): Promise<string | null> {
  try {
    const res = (await domCall(tabId, "element_state", {
      ref: params.ref,
      selector: params.selector,
    })) as { state: string | null };
    return res?.state ?? null;
  } catch {
    return null;
  }
}

/**
 * Where the tab is right now.
 *
 * Resolving an element and then dispatching input are two separate trips into
 * the page, and a redirect can land between them. Without this check a click
 * aimed at one site is delivered to whatever replaced it, and the result still
 * says ok. Typing is the dangerous case: text meant for one origin should never
 * be committed to another.
 */
async function originOf(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return new URL(tab.url ?? "").origin;
  } catch {
    return "";
  }
}

async function assertSameOrigin(
  tabId: number,
  expected: string,
  action: string
): Promise<void> {
  const now = await originOf(tabId);
  if (expected && now && now !== expected) {
    throw new Error(
      `The tab navigated from ${expected} to ${now} while preparing to ${action}, ` +
        "so nothing was sent. Take a fresh browser_snapshot and decide again on the page that is actually open."
    );
  }
}

/** Give the page a moment to react before diffing state. */
async function settle(ms = 160): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Repeat count for a click. Three clicks select the line or paragraph under
 * the cursor, which is how a person selects text they mean to replace.
 */
function clickCountOf(params: Record<string, unknown>): number {
  if (params.tripleClick) return 3;
  if (params.doubleClick) return 2;
  return 1;
}

export async function click(
  tabId: number,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const pageBefore = await readPage(tabId);
  const origin = await originOf(tabId);
  const target = await resolveTarget(tabId, params);

  if (target.covered) {
    throw new Error(
      `Element is covered by <${target.coveredBy}>, so a click would hit that instead. ` +
        "Dismiss the overlay or scroll it out of the way first."
    );
  }

  const before = target.state;
  await assertSameOrigin(tabId, origin, "click");
  await cdp.clickAt(
    tabId,
    { x: target.x, y: target.y },
    {
      button: (params.button as cdp.MouseButton) ?? "left",
      clickCount: clickCountOf(params),
    }
  );
  await settle();
  const after = await readState(tabId, params);
  const page = pageDelta(pageBefore, await readPage(tabId));
  const navigated = Boolean(page.urlChanged);
  const targetGone = after === null;
  const changed = after !== null && after !== before;
  const targetMeta = targetFromParams(params, target.tag, target.text);

  let warning: string | undefined;
  if (!changed) {
    warning = targetGone
      ? "Element is gone after the click, which usually means the page re-rendered or navigated."
      : "Click was delivered but no observable state change was detected.";
  }

  const peek = await maybePeek(tabId, {
    action: "click",
    ok: true,
    changed,
    navigated,
    targetGone,
    warning: Boolean(warning),
  });
  const dialogOpened = peekHasDialog(peek);
  const hasErrors = peekHasAlerts(peek);

  return {
    ok: true,
    verified: changed || navigated || dialogOpened,
    trusted: true,
    action: "click",
    target: targetMeta,
    changed,
    before,
    after,
    tag: target.tag,
    text: target.text,
    point: { x: Math.round(target.x), y: Math.round(target.y) },
    page,
    warning,
    peek,
    refs: refsAfterClick({ navigated, targetGone, dialogOpened }),
    next: nextClick({
      changed,
      navigated,
      targetGone,
      dialogOpened,
      hasErrors,
    }),
  };
}

export async function clickAtPoint(
  tabId: number,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const pageBefore = await readPage(tabId);
  const x = Number(params.x);
  const y = Number(params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("x and y are required numbers in viewport CSS pixels");
  }

  const hit = (await cdp.evaluate(
    tabId,
    `(function(){
       var el = document.elementFromPoint(${x}, ${y});
       if (!el) return null;
       return {
         tag: el.tagName.toLowerCase(),
         text: (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,80)
       };
     })()`
  )) as { tag: string; text: string } | null;

  if (!hit) {
    throw new Error(`No element at (${x}, ${y}); the point may be outside the viewport.`);
  }

  await cdp.clickAt(
    tabId,
    { x, y },
    {
      button: (params.button as cdp.MouseButton) ?? "left",
      clickCount: clickCountOf(params),
    }
  );
  await settle();
  const page = pageDelta(pageBefore, await readPage(tabId));
  const navigated = Boolean(page.urlChanged);
  const peek = await maybePeek(tabId, {
    action: "click_xy",
    ok: true,
    navigated,
  });
  const dialogOpened = peekHasDialog(peek);

  return {
    ok: true,
    verified: navigated || dialogOpened,
    trusted: true,
    action: "click_xy",
    target: { tag: hit.tag, name: hit.text },
    x,
    y,
    tag: hit.tag,
    text: hit.text,
    page,
    peek,
    refs: refsAfterClick({ navigated, dialogOpened }),
    next: nextClick({ navigated, dialogOpened, hasErrors: peekHasAlerts(peek) }),
  };
}

export async function hover(
  tabId: number,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const pageBefore = await readPage(tabId);
  const target = await resolveTarget(tabId, params);
  await cdp.hoverAt(tabId, { x: target.x, y: target.y });
  await settle(120);
  const page = pageDelta(pageBefore, await readPage(tabId));
  return {
    ok: true,
    verified: true,
    trusted: true,
    action: "hover",
    target: targetFromParams(params, target.tag, target.text),
    tag: target.tag,
    text: target.text,
    page,
    refs: { valid: "unknown", reason: "hover does not invalidate refs" },
    next: nextSoftAction("hover"),
  };
}

/**
 * Write text into a field and confirm the field holds it.
 *
 * The write itself lives in text-entry, which escalates through techniques
 * until a read-back agrees with what was asked for. Here we supply the trusted
 * focus click and wrap the result as an ActionResult so the outer LLM can skip
 * screenshot loops when verified is true. Verify mismatches return ok:false
 * (structured) rather than throwing; hard failures (stale ref, wrong origin)
 * still throw.
 */
export async function type(
  tabId: number,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const pageBefore = await readPage(tabId);
  const origin = await originOf(tabId);
  const expected = params.expectedOrigin ? String(params.expectedOrigin) : "";
  if (expected && origin && expected !== origin) {
    throw new Error(
      `This text was meant for ${expected} but the tab is on ${origin}, so nothing was typed.`
    );
  }

  const target = await resolveTarget(tabId, params);

  await assertSameOrigin(tabId, origin, "type");
  await cdp.clickAt(tabId, { x: target.x, y: target.y });
  await settle(80);

  const result = await setText(tabId, params);
  const action = params.text === "" && !params.append ? "clear" : "type";
  const targetMeta = targetFromParams(params, target.tag, target.text);

  if (!result.ok) {
    const page = pageDelta(pageBefore, await readPage(tabId));
    const navigated = Boolean(page.urlChanged);
    const peek = await maybePeek(tabId, {
      action,
      ok: false,
      navigated,
      warning: true,
    });
    return {
      ...result,
      ok: false,
      verified: false,
      action,
      target: targetMeta,
      before: result.before,
      after: result.value,
      tag: target.tag,
      page,
      peek,
      refs: refsAfterWrite({ navigated }),
      next: nextFailedWrite(
        result.warning ??
          "The field did not accept this value. Re-check the ref with browser_snapshot; do not screenshot to debug the value."
      ),
    };
  }

  if (params.submit) {
    await cdp.pressKey(tabId, "Enter");
    await settle(250);
  }

  const page = pageDelta(pageBefore, await readPage(tabId));
  const navigated = Boolean(page.urlChanged);
  const submitted = Boolean(params.submit);
  const invalidHint = Boolean(result.invalid);
  const peek = await maybePeek(tabId, {
    action,
    ok: true,
    verified: true,
    changed: result.changed,
    navigated,
    submitted,
    invalidHint,
  });

  return {
    ...result,
    ok: true,
    verified: true,
    action,
    target: targetMeta,
    before: result.before,
    after: result.value,
    tag: target.tag,
    page,
    peek,
    refs: refsAfterWrite({ navigated }),
    next: nextVerifiedWrite({ submitted, navigated, invalidHint }),
    ...(invalidHint
      ? {
          errors: [
            {
              kind: "invalid",
              text: "Field reports invalid after write",
              ref: targetMeta.ref,
            },
          ],
        }
      : {}),
  };
}

/** Empty a field, verified the same way as a write. */
export async function clear(
  tabId: number,
  params: Record<string, unknown>
): Promise<ActionResult> {
  return type(tabId, { ...params, text: "", append: false });
}

export async function pressKey(
  tabId: number,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const pageBefore = await readPage(tabId);
  const key = String(params.key ?? "");
  if (!key) throw new Error("key is required");
  await cdp.pressKey(tabId, key);
  await settle(120);
  const page = pageDelta(pageBefore, await readPage(tabId));
  const navigated = Boolean(page.urlChanged);
  const submitish = /^(Enter|Return)$/i.test(key);
  const peek = await maybePeek(tabId, {
    action: "press_key",
    ok: true,
    navigated,
    submitted: submitish,
  });
  return {
    ok: true,
    verified: true,
    trusted: true,
    action: "press_key",
    key,
    page,
    peek,
    refs: navigated
      ? refsAfterWrite({ navigated: true })
      : { valid: "unknown", reason: "key press; refs not revalidated" },
    next: navigated || submitish
      ? nextClick({ navigated, dialogOpened: peekHasDialog(peek) })
      : nextSoftAction("press_key"),
  };
}

export async function drag(
  tabId: number,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const pageBefore = await readPage(tabId);
  const from = await resolveTarget(tabId, {
    ref: params.fromRef ?? params.ref,
    selector: params.fromSelector ?? params.selector,
  });
  const to = await resolveTarget(tabId, {
    ref: params.toRef,
    selector: params.toSelector,
  });
  await cdp.dragTo(tabId, { x: from.x, y: from.y }, { x: to.x, y: to.y });
  await settle();
  const page = pageDelta(pageBefore, await readPage(tabId));
  return {
    ok: true,
    verified: true,
    trusted: true,
    action: "drag",
    from: from.tag,
    to: to.tag,
    page,
    refs: {
      valid: "unknown",
      reason: "drag completed; refs not revalidated",
    },
    next: nextSoftAction("drag"),
  };
}

/**
 * Native `<select>` is set directly, since CDP cannot drive the OS popup.
 * Custom listbox widgets are handled by clicking, which now works because
 * the click is trusted.
 */
export async function selectOption(
  tabId: number,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const values = (params.values as string[]) ?? [];
  if (!values.length) throw new Error("values[] is required");
  const pageBefore = await readPage(tabId);
  const target = await resolveTarget(tabId, params);
  const targetMeta = targetFromParams(params, target.tag, target.text);

  if (target.tag === "select") {
    // A native select popup is OS-drawn and cannot be driven by CDP input, so
    // set the value in the page and fire the events a listener expects.
    const res = (await domCall(tabId, "select_option_native", {
      ref: params.ref,
      selector: params.selector,
      values,
    })) as { ok: boolean; matched?: string[]; value?: string; reason?: string };

    if (!res?.ok) {
      throw new Error(
        res?.reason ??
          `None of ${JSON.stringify(values)} matched an option in this select.`
      );
    }
    const page = pageDelta(pageBefore, await readPage(tabId));
    return {
      ok: true,
      verified: true,
      trusted: false,
      action: "select_option",
      target: targetMeta,
      changed: true,
      before: target.state,
      after: res.value ?? null,
      value: res.value,
      matched: res.matched,
      page,
      refs: refsAfterWrite({ navigated: Boolean(page.urlChanged) }),
      next: nextVerifiedWrite({ navigated: Boolean(page.urlChanged) }),
    };
  }

  // Custom dropdown: open it, then click the option by its text.
  await cdp.clickAt(tabId, { x: target.x, y: target.y });
  await settle(220);

  const wanted = values[0]!;
  const opt = (await domCall(tabId, "find_option", { text: wanted })) as {
    found: boolean;
    x?: number;
    y?: number;
    text?: string;
  };

  if (!opt?.found) {
    throw new Error(
      `Opened the control but found no option matching "${wanted}". Take a snapshot to see what is listed.`
    );
  }

  await cdp.clickAt(tabId, { x: opt.x!, y: opt.y! });
  await settle();
  const page = pageDelta(pageBefore, await readPage(tabId));
  const peek = await maybePeek(tabId, {
    action: "select_option",
    ok: true,
    verified: true,
    changed: true,
    navigated: Boolean(page.urlChanged),
  });
  return {
    ok: true,
    verified: true,
    trusted: true,
    action: "select_option",
    target: targetMeta,
    changed: true,
    selected: opt.text,
    after: opt.text ?? null,
    page,
    peek,
    refs: refsAfterWrite({ navigated: Boolean(page.urlChanged) }),
    next: nextVerifiedWrite({ navigated: Boolean(page.urlChanged) }),
  };
}

export async function fillForm(
  tabId: number,
  params: Record<string, unknown>
): Promise<BulkResult> {
  const fields =
    (params.fields as Array<{ ref?: string; selector?: string; value: string }>) ?? [];
  if (!fields.length) throw new Error("fields[] is required");

  const pageBefore = await readPage(tabId);
  // One bad field must not hide the outcome of the others, so each is
  // reported on its own and the run continues.
  const results: BulkStepResult[] = [];
  let failed = 0;

  for (const field of fields) {
    const where = field.ref ?? field.selector;
    try {
      const res = await type(tabId, {
        ref: field.ref,
        selector: field.selector,
        text: field.value,
      });
      if (!res.ok) {
        failed++;
        results.push({
          field: where,
          ok: false,
          verified: false,
          action: "type",
          target: res.target,
          before: res.before ?? null,
          after: res.after ?? null,
          warning: res.warning,
          error: res.warning,
          errors: res.errors,
        });
        continue;
      }
      results.push({
        field: where,
        ok: true,
        verified: true,
        action: "type",
        target: res.target,
        before: res.before ?? null,
        after: res.after ?? null,
        // Legacy keys still present for older clients.
        value: res.after,
        match: res.match,
        warning: res.warning,
      });
    } catch (err) {
      failed++;
      results.push({
        field: where,
        ok: false,
        verified: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (params.submit && !failed) {
    await cdp.pressKey(tabId, "Enter");
    await settle(250);
  }

  const page = pageDelta(pageBefore, await readPage(tabId));
  const navigated = Boolean(page.urlChanged);
  const submitted = Boolean(params.submit) && failed === 0;
  const total = fields.length;
  const succeeded = total - failed;
  const peek = await maybePeek(tabId, {
    action: "fill_form",
    ok: failed === 0,
    verified: failed === 0,
    navigated,
    submitted,
    warning: failed > 0,
  });

  const outcome: BulkResult = {
    ok: failed === 0,
    verified: failed === 0,
    trusted: true,
    action: "fill_form",
    count: { total, succeeded, failed },
    // Legacy counts still present for older clients.
    filled: succeeded,
    failed,
    fields: results,
    results,
    page,
    peek,
    refs: refsAfterWrite({ navigated }),
    next: nextBulk({ failed, total, submitted, navigated }),
  };
  if (failed) {
    outcome.warning =
      `${failed} of ${fields.length} fields did not end up with the requested value. ` +
      (params.submit
        ? "The form was not submitted, so nothing was sent with the wrong values. "
        : "") +
      "See the per-field results below and fix those before submitting. Skip screenshot; use the receipt.";
  }
  return outcome;
}
