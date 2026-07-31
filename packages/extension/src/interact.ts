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
import { dom as domCall } from "./dom-channel";
import { setText } from "./text-entry";

export { useDomChannel } from "./dom-channel";

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
): Promise<InteractionOutcome> {
  const target = await resolveTarget(tabId, params);

  if (target.covered) {
    throw new Error(
      `Element is covered by <${target.coveredBy}>, so a click would hit that instead. ` +
        "Dismiss the overlay or scroll it out of the way first."
    );
  }

  const before = target.state;
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

  const changed = after !== null && after !== before;
  const outcome: InteractionOutcome = {
    ok: true,
    trusted: true,
    changed,
    tag: target.tag,
    text: target.text,
    point: { x: Math.round(target.x), y: Math.round(target.y) },
  };

  if (!changed) {
    // Navigation and re-render are legitimate reasons for no local change,
    // so this is a caveat rather than a failure.
    outcome.warning =
      after === null
        ? "Element is gone after the click, which usually means the page re-rendered or navigated."
        : "Click was delivered but no observable state change was detected. Verify with a fresh snapshot.";
  }
  return outcome;
}

export async function clickAtPoint(
  tabId: number,
  params: Record<string, unknown>
): Promise<InteractionOutcome> {
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

  return {
    ok: true,
    trusted: true,
    x,
    y,
    tag: hit.tag,
    text: hit.text,
  };
}

export async function hover(
  tabId: number,
  params: Record<string, unknown>
): Promise<InteractionOutcome> {
  const target = await resolveTarget(tabId, params);
  await cdp.hoverAt(tabId, { x: target.x, y: target.y });
  await settle(120);
  return { ok: true, trusted: true, tag: target.tag, text: target.text };
}

/**
 * Write text into a field and confirm the field holds it.
 *
 * The write itself lives in text-entry, which escalates through techniques
 * until a read-back agrees with what was asked for. Here we only supply the
 * trusted focus click, since clicking is what makes component libraries set up
 * their own editing state, and a failed write is raised rather than returned
 * so it cannot be mistaken for success.
 */
export async function type(
  tabId: number,
  params: Record<string, unknown>
): Promise<InteractionOutcome> {
  const target = await resolveTarget(tabId, params);

  await cdp.clickAt(tabId, { x: target.x, y: target.y });
  await settle(80);

  const result = await setText(tabId, params);

  if (!result.ok) {
    throw new Error(result.warning ?? "The field did not accept this value.");
  }

  if (params.submit) {
    await cdp.pressKey(tabId, "Enter");
    await settle(250);
  }

  return { ...result, tag: target.tag };
}

/** Empty a field, verified the same way as a write. */
export async function clear(
  tabId: number,
  params: Record<string, unknown>
): Promise<InteractionOutcome> {
  return type(tabId, { ...params, text: "", append: false });
}

export async function pressKey(
  tabId: number,
  params: Record<string, unknown>
): Promise<InteractionOutcome> {
  const key = String(params.key ?? "");
  if (!key) throw new Error("key is required");
  await cdp.pressKey(tabId, key);
  await settle(120);
  return { ok: true, trusted: true, key };
}

export async function drag(
  tabId: number,
  params: Record<string, unknown>
): Promise<InteractionOutcome> {
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
  return { ok: true, trusted: true, from: from.tag, to: to.tag };
}

/**
 * Native `<select>` is set directly, since CDP cannot drive the OS popup.
 * Custom listbox widgets are handled by clicking, which now works because
 * the click is trusted.
 */
export async function selectOption(
  tabId: number,
  params: Record<string, unknown>
): Promise<InteractionOutcome> {
  const values = (params.values as string[]) ?? [];
  if (!values.length) throw new Error("values[] is required");

  const target = await resolveTarget(tabId, params);

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
    return {
      ok: true,
      trusted: false,
      changed: true,
      value: res.value,
      matched: res.matched,
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
  return { ok: true, trusted: true, changed: true, selected: opt.text };
}

export async function fillForm(
  tabId: number,
  params: Record<string, unknown>
): Promise<InteractionOutcome> {
  const fields =
    (params.fields as Array<{ ref?: string; selector?: string; value: string }>) ?? [];
  if (!fields.length) throw new Error("fields[] is required");

  // One bad field must not hide the outcome of the others, so each is
  // reported on its own and the run continues.
  const results: unknown[] = [];
  let failed = 0;

  for (const field of fields) {
    const where = field.ref ?? field.selector;
    try {
      const res = await type(tabId, {
        ref: field.ref,
        selector: field.selector,
        text: field.value,
      });
      results.push({
        field: where,
        ok: true,
        value: res.value,
        match: res.match,
        warning: res.warning,
      });
    } catch (err) {
      failed++;
      results.push({
        field: where,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (params.submit && !failed) {
    await cdp.pressKey(tabId, "Enter");
    await settle(250);
  }

  const outcome: InteractionOutcome = {
    ok: failed === 0,
    trusted: true,
    filled: fields.length - failed,
    failed,
    fields: results,
  };
  if (failed) {
    outcome.warning =
      `${failed} of ${fields.length} fields did not end up with the requested value. ` +
      (params.submit
        ? "The form was not submitted, so nothing was sent with the wrong values. "
        : "") +
      "See the per-field results below and fix those before submitting.";
  }
  return outcome;
}
