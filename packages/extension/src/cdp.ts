/**
 * Chrome DevTools Protocol transport.
 *
 * Synthetic `dispatchEvent` calls carry `isTrusted: false`. Component
 * libraries such as Angular Material, and anything built on the same
 * pattern, ignore those, which is why plain buttons worked and Google Ads
 * checkboxes silently did nothing. CDP `Input.*` commands go through the
 * browser's real input pipeline, so the page cannot tell the difference
 * between us and a person.
 *
 * `Runtime.evaluate` is used for the same reason on the scripting side: the
 * extension CSP forbids `new Function` in MV3, so evaluation has to happen
 * out of process.
 */

const PROTOCOL_VERSION = "1.3";

/** Tabs we currently hold a debugger session on. */
const attached = new Set<number>();
/** Tabs where attaching failed, so we stop retrying every call. */
const unavailable = new Map<number, string>();

export type MouseButton = "left" | "right" | "middle";

export type Point = { x: number; y: number };

function modifierMask(parts: string[]): number {
  // CDP: Alt=1, Ctrl=2, Meta=4, Shift=8
  let mask = 0;
  if (parts.some((p) => /^alt$/i.test(p))) mask |= 1;
  if (parts.some((p) => /^(control|ctrl)$/i.test(p))) mask |= 2;
  if (parts.some((p) => /^(meta|cmd|command)$/i.test(p))) mask |= 4;
  if (parts.some((p) => /^shift$/i.test(p))) mask |= 8;
  return mask;
}

/** Keys that need an explicit virtual key code to reach the page correctly. */
const KEY_TABLE: Record<
  string,
  { key: string; code: string; keyCode: number; text?: string }
> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

function describeKey(raw: string) {
  const lower = raw.toLowerCase();
  if (KEY_TABLE[lower]) return KEY_TABLE[lower];

  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    const code = /[a-z]/i.test(raw)
      ? `Key${upper}`
      : /[0-9]/.test(raw)
        ? `Digit${raw}`
        : "";
    return {
      key: raw,
      code,
      keyCode: upper.charCodeAt(0),
      text: raw,
    };
  }

  // Unknown named key: pass it through and let Chrome resolve what it can.
  return { key: raw, code: raw, keyCode: 0 };
}

/**
 * Open a debugger session for this tab, reusing one if present.
 * Returns false when Chrome refuses, most often because DevTools is already
 * open on that tab. Callers fall back to synthetic events and say so.
 */
export async function attach(tabId: number): Promise<boolean> {
  if (attached.has(tabId)) return true;
  if (unavailable.has(tabId)) return false;

  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    attached.add(tabId);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Another client already owns the session; treat it as usable if the
    // message says so, otherwise remember the failure.
    if (/already attached/i.test(message)) {
      attached.add(tabId);
      return true;
    }
    unavailable.set(tabId, message);
    console.debug("[deeporax] debugger attach failed:", message);
    return false;
  }
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* tab already gone */
  }
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

export function unavailableReason(tabId: number): string | undefined {
  return unavailable.get(tabId);
}

/** Forget cached state for a tab so the next call can try attaching again. */
export function forget(tabId: number): void {
  attached.delete(tabId);
  unavailable.delete(tabId);
}

export async function send<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

// --- Input ------------------------------------------------------------------

/**
 * A full trusted click: move, press, release. Component libraries listen for
 * pointerdown and mousedown, so the whole sequence has to be delivered.
 */
export async function clickAt(
  tabId: number,
  point: Point,
  opts: {
    button?: MouseButton;
    clickCount?: number;
    modifiers?: number;
  } = {}
): Promise<void> {
  const button = opts.button ?? "left";
  const clickCount = opts.clickCount ?? 1;
  const modifiers = opts.modifiers ?? 0;
  const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
  const base = {
    x: Math.round(point.x),
    y: Math.round(point.y),
    modifiers,
    pointerType: "mouse",
  };

  await send(tabId, "Input.dispatchMouseEvent", {
    ...base,
    type: "mouseMoved",
    button: "none",
    buttons: 0,
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    ...base,
    type: "mousePressed",
    button,
    buttons,
    clickCount,
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    ...base,
    type: "mouseReleased",
    button,
    buttons: 0,
    clickCount,
  });
}

export async function hoverAt(tabId: number, point: Point): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(point.x),
    y: Math.round(point.y),
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
}

export async function dragTo(
  tabId: number,
  from: Point,
  to: Point
): Promise<void> {
  const p = (pt: Point) => ({ x: Math.round(pt.x), y: Math.round(pt.y) });
  await send(tabId, "Input.dispatchMouseEvent", {
    ...p(from),
    type: "mouseMoved",
    button: "none",
    buttons: 0,
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    ...p(from),
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  // Intermediate moves: some drag implementations need more than one.
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await send(tabId, "Input.dispatchMouseEvent", {
      x: Math.round(from.x + ((to.x - from.x) * i) / steps),
      y: Math.round(from.y + ((to.y - from.y) * i) / steps),
      type: "mouseMoved",
      button: "left",
      buttons: 1,
    });
  }
  await send(tabId, "Input.dispatchMouseEvent", {
    ...p(to),
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

/**
 * Editing shortcuts, keyed by the letter pressed with the platform's primary
 * modifier.
 *
 * Chrome does not derive these from the keystroke when input arrives over CDP:
 * the page sees the key event, but the browser never runs the corresponding
 * editing command. Naming the command explicitly is what makes Ctrl+A actually
 * select instead of quietly doing nothing.
 */
const EDIT_COMMANDS: Record<string, string> = {
  a: "selectAll",
  z: "undo",
  "shift+z": "redo",
  y: "redo",
  x: "cut",
  c: "copy",
  v: "paste",
};

function editingCommand(modifierParts: string[], main: string): string | undefined {
  const isMac = navigator.userAgent.includes("Mac");
  const primary = isMac ? /^(meta|cmd|command)$/i : /^(control|ctrl)$/i;
  const hasPrimary = modifierParts.some((p) => primary.test(p));
  if (!hasPrimary) return undefined;

  // Any other modifier beyond shift means this is a different shortcut.
  const extra = modifierParts.filter(
    (p) => !primary.test(p) && !/^shift$/i.test(p)
  );
  if (extra.length) return undefined;

  const shift = modifierParts.some((p) => /^shift$/i.test(p));
  const key = main.toLowerCase();
  return EDIT_COMMANDS[shift ? `shift+${key}` : key];
}

export async function pressKey(tabId: number, chord: string): Promise<void> {
  const parts = chord.split("+");
  const main = parts[parts.length - 1] ?? "";
  const modifierParts = parts.slice(0, -1);
  const modifiers = modifierMask(modifierParts);
  const info = describeKey(main);
  const command = editingCommand(modifierParts, main);

  // A modified key must not deliver text, otherwise Ctrl+A types "a".
  const text = modifiers === 0 || modifiers === 8 ? info.text : undefined;

  await send(tabId, "Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
    modifiers,
    text,
    unmodifiedText: text,
    ...(command ? { commands: [command] } : {}),
  });
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
    modifiers,
  });
}

/** Fast path for entering text into an already focused field. */
export async function insertText(tabId: number, text: string): Promise<void> {
  await send(tabId, "Input.insertText", { text });
}

/** Character by character, for fields that listen to individual key events. */
export async function typeSlowly(tabId: number, text: string): Promise<void> {
  for (const ch of text) {
    await pressKey(tabId, ch);
  }
}

// --- Scripting --------------------------------------------------------------

type EvaluateResponse = {
  result?: { value?: unknown; type?: string; description?: string };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
  };
};

/**
 * Evaluate in the page's main world and return the real value.
 *
 * A thrown page error becomes a thrown error here. Returning null for a
 * failure is what made the previous implementation impossible to debug.
 */
export async function evaluate(
  tabId: number,
  expression: string,
  opts: { awaitPromise?: boolean } = {}
): Promise<unknown> {
  const run = async (expr: string) =>
    send<EvaluateResponse>(tabId, "Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: opts.awaitPromise ?? true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    });

  // Try as an expression first, then as a statement body, matching what a
  // person would expect from a console.
  let res = await run(`(${expression})`);
  if (res.exceptionDetails) {
    const asBody = await run(
      `(function(){ ${expression} })()`
    );
    if (!asBody.exceptionDetails) {
      res = asBody;
    } else {
      const detail =
        asBody.exceptionDetails.exception?.description ??
        asBody.exceptionDetails.text ??
        "evaluation failed";
      throw new Error(detail);
    }
  }
  return res.result?.value;
}

// --- Capture ----------------------------------------------------------------

export async function captureScreenshot(
  tabId: number,
  opts: { fullPage?: boolean } = {}
): Promise<string> {
  const res = await send<{ data: string }>(tabId, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: Boolean(opts.fullPage),
  });
  return res.data;
}

// --- Lifecycle --------------------------------------------------------------

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attached.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forget(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A fresh document may be attachable even if a previous attempt failed.
  if (info.status === "loading") unavailable.delete(tabId);
});
