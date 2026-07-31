/**
 * Writing text into a field, verified.
 *
 * The rule here is that a write is only successful if reading the field back
 * shows what was asked for. That matters more than which technique got it
 * there, because there is no way to enumerate the component libraries a page
 * might use. So instead of special-casing sites, this tries the most faithful
 * technique first, checks the result, and escalates only when the check fails.
 *
 * Two things make the check trustworthy:
 *
 * - The field is read twice, a moment apart. Frameworks that re-assert their
 *   own model overwrite the field shortly after the write, and a single read
 *   would report success just before the value snapped back.
 * - The comparison allows for fields that legitimately reshape input, such as
 *   a maxlength truncation or a phone number mask, but never for a value that
 *   merely contains what was asked for. Appending when replacement was wanted
 *   is the failure this module exists to catch.
 */
import * as cdp from "./cdp";
import { dom, targetOf } from "./dom-channel";

export type FieldProbe = {
  kind: "input" | "textarea" | "contenteditable";
  value: string;
  maxLength: number;
  readOnly: boolean;
  disabled: boolean;
  inputType: string;
  ariaInvalid: string;
  /** True when the field holds a credential, so its contents must not be echoed. */
  secret: boolean;
  valid: boolean;
  focused: boolean;
  tag: string;
};

/** How closely the field's final value matches what was requested. */
export type Match = "exact" | "truncated" | "reformatted" | "mismatch";

export type TextOutcome = {
  ok: boolean;
  trusted: boolean;
  changed: boolean;
  /** What the field holds now. */
  value: string;
  /** What it was asked to hold. */
  expected: string;
  match: Match;
  /** Which technique produced this result. */
  strategy: string;
  attempts: string[];
  warning?: string;
};

/** Time for the page to process a write before reading it back. */
const SETTLE_MS = 140;
/** Time for a framework to re-assert its own value over ours. */
const REASSERT_MS = 260;
/** Upper bound on character-by-character deletion. */
const MAX_BACKSPACE = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(
  tabId: number,
  params: Record<string, unknown>
): Promise<FieldProbe> {
  return (await dom(tabId, "field_probe", targetOf(params))) as FieldProbe;
}

/**
 * Strip everything a formatter might have added, so a masked phone field that
 * turned "5551234567" into "(555) 123-4567" still counts as written.
 */
function normalize(value: string): string {
  return value.replace(/[^0-9a-z]+/gi, "").toLowerCase();
}

function classify(expected: string, actual: string, maxLength: number): Match {
  if (actual === expected) return "exact";
  if (actual.trim() === expected.trim()) return "exact";

  // The field enforced its own limit, which is the page's decision, not a
  // failure of the write.
  if (maxLength > 0 && expected.length > maxLength) {
    if (actual === expected.slice(0, maxLength)) return "truncated";
  }

  if (expected && normalize(actual) === normalize(expected)) return "reformatted";

  return "mismatch";
}

// --- Strategies -------------------------------------------------------------
//
// Each one leaves the field holding `expected`, or fails the check and hands
// over to the next. All of them start by positioning the selection, so running
// one after another is safe no matter what the previous attempt left behind.

async function position(
  tabId: number,
  params: Record<string, unknown>,
  append: boolean
): Promise<void> {
  await dom(tabId, append ? "field_caret_end" : "field_select_all", targetOf(params));
}

/** Replace the selection with a single trusted text commit. */
async function selectInsert(
  tabId: number,
  params: Record<string, unknown>,
  text: string,
  append: boolean
): Promise<void> {
  await position(tabId, params, append);
  if (!text) {
    await cdp.pressKey(tabId, "Backspace");
    return;
  }
  await cdp.insertText(tabId, text);
}

/**
 * Same, but one keystroke at a time. Autocompletes, character counters and
 * input masks often key off individual keydowns and ignore a bulk commit.
 */
async function selectType(
  tabId: number,
  params: Record<string, unknown>,
  text: string,
  append: boolean
): Promise<void> {
  await position(tabId, params, append);
  if (!text) {
    await cdp.pressKey(tabId, "Backspace");
    return;
  }
  await cdp.typeSlowly(tabId, text);
}

/**
 * Empty the field first, confirm it is empty, then write.
 *
 * Some editors intercept a replacement insert but honour deletion, so proving
 * the field is empty before writing removes the chance of appending.
 */
async function clearThenInsert(
  tabId: number,
  params: Record<string, unknown>,
  text: string
): Promise<void> {
  await position(tabId, params, false);
  await cdp.pressKey(tabId, "Backspace");
  await sleep(60);

  let current = (await probe(tabId, params)).value;
  if (current.length) {
    await dom(tabId, "field_caret_end", targetOf(params));
    const budget = Math.min(current.length + 4, MAX_BACKSPACE);
    for (let i = 0; i < budget; i++) {
      await cdp.pressKey(tabId, "Backspace");
    }
    current = (await probe(tabId, params)).value;
  }
  if (current.length) {
    throw new Error("field would not empty");
  }

  if (text) await cdp.insertText(tabId, text);
}

/** Write the value directly. Not a trusted event, so it is the last option. */
async function forceSet(
  tabId: number,
  params: Record<string, unknown>,
  text: string
): Promise<void> {
  await dom(tabId, "field_force_set", { ...targetOf(params), text });
}

type Strategy = {
  name: string;
  trusted: boolean;
  /** Replacement-only techniques are skipped when appending. */
  replaceOnly?: boolean;
  run: (
    tabId: number,
    params: Record<string, unknown>,
    text: string,
    append: boolean
  ) => Promise<void>;
};

const STRATEGIES: Strategy[] = [
  { name: "select+insert", trusted: true, run: selectInsert },
  { name: "select+type", trusted: true, run: selectType },
  {
    name: "clear+insert",
    trusted: true,
    replaceOnly: true,
    run: (tabId, params, text) => clearThenInsert(tabId, params, text),
  },
  {
    name: "native-set",
    trusted: false,
    run: (tabId, params, text) => forceSet(tabId, params, text),
  },
];

// --- Entry point ------------------------------------------------------------

/**
 * Make the field hold `text` (or `existing + text` when appending).
 *
 * Assumes the field is already focused, which the caller does with a trusted
 * click so component libraries run their own focus handling first.
 */
export async function setText(
  tabId: number,
  params: Record<string, unknown>
): Promise<TextOutcome> {
  const text = String(params.text ?? "");
  const append = Boolean(params.append);
  const before = await probe(tabId, params);

  if (before.disabled) {
    throw new Error(
      `This ${before.kind} is disabled, so it cannot be edited. Enable it first, or check whether the page expects a different control.`
    );
  }
  if (before.readOnly) {
    throw new Error(
      `This ${before.kind} is read-only, so its value cannot be changed here.`
    );
  }

  const expected = append ? before.value + text : text;

  // An explicit request for keystrokes means the page needs them, so lead with
  // that technique rather than treating it as a fallback.
  const ladder = params.slowly
    ? [STRATEGIES[1]!, STRATEGIES[0]!, STRATEGIES[2]!, STRATEGIES[3]!]
    : STRATEGIES;

  const attempts: string[] = [];
  let last: { strategy: string; value: string; match: Match } | null = null;

  for (const strategy of ladder) {
    if (append && strategy.replaceOnly) continue;
    attempts.push(strategy.name);

    try {
      await strategy.run(tabId, params, text, append);
    } catch {
      // A technique that cannot run at all is just a failed attempt.
      continue;
    }

    await sleep(SETTLE_MS);
    let after = await probe(tabId, params);
    let match = classify(expected, after.value, after.maxLength);

    if (match !== "mismatch") {
      // Confirm the page did not overwrite us a moment later.
      await sleep(REASSERT_MS);
      const settled = await probe(tabId, params);
      const settledMatch = classify(expected, settled.value, settled.maxLength);
      if (settledMatch !== "mismatch") {
        return succeed(strategy, attempts, before, settled, expected, settledMatch);
      }
      after = settled;
      match = settledMatch;
    }

    last = { strategy: strategy.name, value: after.value, match };
  }

  const actual = last?.value ?? before.value;
  // Report shape, never contents, when the field holds a credential.
  const show = (v: string) => (before.secret ? `[redacted, ${v.length} chars]` : JSON.stringify(v));
  return {
    ok: false,
    trusted: true,
    changed: actual !== before.value,
    value: before.secret ? `[redacted, ${actual.length} chars]` : actual,
    expected: before.secret ? `[redacted, ${expected.length} chars]` : expected,
    match: "mismatch",
    strategy: "none",
    attempts,
    warning:
      `Could not set this field to ${show(expected)}. ` +
      `After trying ${attempts.join(", ")} it holds ${show(actual)} ` +
      `(${actual.length} characters, expected ${expected.length}). ` +
      "The page may be rewriting the value, or this may not be the field you meant. " +
      "Take a fresh snapshot and confirm the target before retrying.",
  };
}

function succeed(
  strategy: Strategy,
  attempts: string[],
  before: FieldProbe,
  after: FieldProbe,
  expected: string,
  match: Match
): TextOutcome {
  const outcome: TextOutcome = {
    ok: true,
    trusted: strategy.trusted,
    changed: after.value !== before.value,
    value: after.secret ? `[redacted, ${after.value.length} chars]` : after.value,
    expected: after.secret ? `[redacted, ${expected.length} chars]` : expected,
    match,
    strategy: strategy.name,
    attempts,
  };

  const notes: string[] = [];
  if (match === "truncated") {
    notes.push(
      `The field capped the value at its ${after.maxLength} character limit, so ${expected.length - after.maxLength} characters were dropped.`
    );
  }
  if (match === "reformatted") {
    notes.push(
      "The field reformatted the value as it was entered, so it reads differently but carries the same content."
    );
  }
  if (!strategy.trusted) {
    notes.push(
      "This needed a direct write rather than real keystrokes, so a strict page may not treat it as user input. Verify before submitting."
    );
  }
  if (after.ariaInvalid === "true" || !after.valid) {
    notes.push(
      "The field is reporting itself as invalid, so the page may reject this value on submit."
    );
  }
  if (notes.length) outcome.warning = notes.join(" ");

  return outcome;
}
