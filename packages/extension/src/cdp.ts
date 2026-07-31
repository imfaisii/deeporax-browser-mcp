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
const unavailable = new Map<number, { message: string; at: number }>();

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
const RETRY_ATTACH_AFTER_MS = 5_000;

export async function attach(tabId: number): Promise<boolean> {
  if (attached.has(tabId)) return true;

  // Remember a failure only briefly. The usual cause is DevTools being open,
  // and the user can close it at any moment; refusing until the tab navigates
  // made the extension look broken long after the problem was gone.
  const failedAt = unavailable.get(tabId);
  if (failedAt && Date.now() - failedAt.at < RETRY_ATTACH_AFTER_MS) return false;

  try {
    await withTimeout(
      chrome.debugger.attach({ tabId }, PROTOCOL_VERSION),
      ATTACH_TIMEOUT_MS,
      "debugger attach"
    );
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
    unavailable.set(tabId, { message, at: Date.now() });
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
  return unavailable.get(tabId)?.message;
}

/** Forget cached state for a tab so the next call can try attaching again. */
export function forget(tabId: number): void {
  attached.delete(tabId);
  unavailable.delete(tabId);
}

/** A frozen renderer must not hang the caller forever. */
const ATTACH_TIMEOUT_MS = 8_000;
const COMMAND_TIMEOUT_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} timed out after ${ms}ms. The page may be showing a native dialog, ` +
              "or the renderer may be busy. Dismiss any dialog and retry."
          )
        ),
      ms
    );
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export async function send<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  try {
    return (await withTimeout(
      chrome.debugger.sendCommand({ tabId }, method, params),
      COMMAND_TIMEOUT_MS,
      method
    )) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Chrome dropped the session underneath us (the user dismissed the
    // debugging banner, or the tab swapped renderers). Reattaching and
    // repeating is safe for reads; repeating an input event is not, because
    // the first one may already have landed.
    if (/not attached|detached while/i.test(message)) {
      attached.delete(tabId);
      if (/^Input\./.test(method)) {
        throw new Error(
          `The debugger session dropped during ${method}, so this input may or may not have ` +
            "been delivered. Take a fresh browser_snapshot to see the real state before retrying."
        );
      }
      if (await attach(tabId)) {
        return (await withTimeout(
          chrome.debugger.sendCommand({ tabId }, method, params),
          COMMAND_TIMEOUT_MS,
          method
        )) as T;
      }
    }
    throw err;
  }
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
 * Editing commands, keyed by the normalised chord.
 *
 * Chrome does not derive these from the keystroke when input arrives over
 * CDP: the page sees the key event, but the browser never runs the matching
 * editing command. Naming the command explicitly is what makes Cmd+A actually
 * select instead of quietly doing nothing.
 *
 * The two tables differ because the platforms genuinely differ. On macOS Ctrl
 * carries the emacs bindings and Cmd carries the familiar shortcuts, so
 * Ctrl+A moves to the start of a paragraph rather than selecting everything.
 */
const MAC_COMMANDS: Record<string, string> = {
  "alt+arrowleft": "moveWordLeft",
  "alt+arrowright": "moveWordRight",
  "alt+backspace": "deleteWordBackward",
  "alt+delete": "deleteWordForward",
  "alt+enter": "insertNewlineIgnoringFieldEditor",
  "alt+escape": "complete",
  "alt+kp_enter": "insertNewlineIgnoringFieldEditor",
  "alt+left": "moveWordLeft",
  "alt+numpadenter": "insertNewlineIgnoringFieldEditor",
  "alt+pagedown": "pageDown",
  "alt+pageup": "pageUp",
  "alt+right": "moveWordRight",
  "cmd+a": "selectAll",
  "cmd+arrowdown": "moveToEndOfDocument",
  "cmd+arrowleft": "moveToLeftEndOfLine",
  "cmd+arrowright": "moveToRightEndOfLine",
  "cmd+arrowup": "moveToBeginningOfDocument",
  "cmd+backspace": "deleteToBeginningOfLine",
  "cmd+c": "copy",
  "cmd+down": "moveToEndOfDocument",
  "cmd+home": "moveToBeginningOfDocument",
  "cmd+left": "moveToLeftEndOfLine",
  "cmd+numpadsubtract": "cancel",
  "cmd+right": "moveToRightEndOfLine",
  "cmd+up": "moveToBeginningOfDocument",
  "cmd+v": "paste",
  "cmd+x": "cut",
  "cmd+z": "undo",
  "ctrl+'": "insertSingleQuoteIgnoringSubstitution",
  "ctrl+a": "moveToBeginningOfParagraph",
  "ctrl+arrowdown": "scrollPageDown",
  "ctrl+arrowleft": "moveToLeftEndOfLine",
  "ctrl+arrowright": "moveToRightEndOfLine",
  "ctrl+arrowup": "scrollPageUp",
  "ctrl+b": "moveBackward",
  "ctrl+backspace": "deleteBackwardByDecomposingPreviousCharacter",
  "ctrl+d": "deleteForward",
  "ctrl+down": "scrollPageDown",
  "ctrl+e": "moveToEndOfParagraph",
  "ctrl+enter": "insertLineBreak",
  "ctrl+f": "moveForward",
  "ctrl+h": "deleteBackward",
  "ctrl+k": "deleteToEndOfParagraph",
  "ctrl+kp_enter": "insertLineBreak",
  "ctrl+l": "centerSelectionInVisibleArea",
  "ctrl+left": "moveToLeftEndOfLine",
  "ctrl+n": "moveDown",
  "ctrl+numpadenter": "insertLineBreak",
  "ctrl+p": "moveUp",
  "ctrl+quote": "insertSingleQuoteIgnoringSubstitution",
  "ctrl+right": "moveToRightEndOfLine",
  "ctrl+t": "transpose",
  "ctrl+tab": "selectNextKeyView",
  "ctrl+up": "scrollPageUp",
  "ctrl+v": "moveUp",
  "ctrl+y": "yank",
  "shift+arrowdown": "moveDownAndModifySelection",
  "shift+arrowleft": "moveLeftAndModifySelection",
  "shift+arrowright": "moveRightAndModifySelection",
  "shift+arrowup": "moveUpAndModifySelection",
  "shift+backspace": "deleteBackward",
  "shift+delete": "deleteForward",
  "shift+down": "moveDownAndModifySelection",
  "shift+end": "moveToEndOfDocumentAndModifySelection",
  "shift+enter": "insertNewline",
  "shift+escape": "cancelOperation",
  "shift+f5": "complete",
  "shift+home": "moveToBeginningOfDocumentAndModifySelection",
  "shift+left": "moveLeftAndModifySelection",
  "shift+numpad5": "delete",
  "shift+pagedown": "pageDownAndModifySelection",
  "shift+pageup": "pageUpAndModifySelection",
  "shift+right": "moveRightAndModifySelection",
  "shift+up": "moveUpAndModifySelection",
  "ctrl+alt+b": "moveWordBackward",
  "ctrl+alt+backspace": "deleteWordBackward",
  "ctrl+alt+f": "moveWordForward",
  "shift+alt+arrowdown": "moveParagraphForwardAndModifySelection",
  "shift+alt+arrowleft": "moveWordLeftAndModifySelection",
  "shift+alt+arrowright": "moveWordRightAndModifySelection",
  "shift+alt+arrowup": "moveParagraphBackwardAndModifySelection",
  "shift+alt+backspace": "deleteWordBackward",
  "shift+alt+delete": "deleteWordForward",
  "shift+alt+down": "moveParagraphForwardAndModifySelection",
  "shift+alt+enter": "insertNewlineIgnoringFieldEditor",
  "shift+alt+escape": "complete",
  "shift+alt+kp_enter": "insertNewlineIgnoringFieldEditor",
  "shift+alt+left": "moveWordLeftAndModifySelection",
  "shift+alt+numpadenter": "insertNewlineIgnoringFieldEditor",
  "shift+alt+pagedown": "pageDown",
  "shift+alt+pageup": "pageUp",
  "shift+alt+right": "moveWordRightAndModifySelection",
  "shift+alt+up": "moveParagraphBackwardAndModifySelection",
  "shift+cmd+arrowdown": "moveToEndOfDocumentAndModifySelection",
  "shift+cmd+arrowleft": "moveToLeftEndOfLineAndModifySelection",
  "shift+cmd+arrowright": "moveToRightEndOfLineAndModifySelection",
  "shift+cmd+arrowup": "moveToBeginningOfDocumentAndModifySelection",
  "shift+cmd+backspace": "deleteToBeginningOfLine",
  "shift+cmd+numpadsubtract": "cancel",
  "shift+cmd+z": "redo",
  "shift+control+kp_enter": "insertLineBreak",
  "shift+control+numpadenter": "insertLineBreak",
  "shift+ctrl+'": "insertDoubleQuoteIgnoringSubstitution",
  "shift+ctrl+a": "moveToBeginningOfParagraphAndModifySelection",
  "shift+ctrl+arrowdown": "scrollPageDown",
  "shift+ctrl+arrowleft": "moveToLeftEndOfLineAndModifySelection",
  "shift+ctrl+arrowright": "moveToRightEndOfLineAndModifySelection",
  "shift+ctrl+arrowup": "scrollPageUp",
  "shift+ctrl+b": "moveBackwardAndModifySelection",
  "shift+ctrl+backspace": "deleteBackwardByDecomposingPreviousCharacter",
  "shift+ctrl+down": "scrollPageDown",
  "shift+ctrl+e": "moveToEndOfParagraphAndModifySelection",
  "shift+ctrl+enter": "insertLineBreak",
  "shift+ctrl+f": "moveForwardAndModifySelection",
  "shift+ctrl+left": "moveToLeftEndOfLineAndModifySelection",
  "shift+ctrl+n": "moveDownAndModifySelection",
  "shift+ctrl+p": "moveUpAndModifySelection",
  "shift+ctrl+quote": "insertDoubleQuoteIgnoringSubstitution",
  "shift+ctrl+right": "moveToRightEndOfLineAndModifySelection",
  "shift+ctrl+tab": "selectPreviousKeyView",
  "shift+ctrl+up": "scrollPageUp",
  "shift+ctrl+v": "pageDownAndModifySelection",
  "shift+ctrl+alt+b": "moveWordBackwardAndModifySelection",
  "shift+ctrl+alt+backspace": "deleteWordBackward",
  "shift+ctrl+alt+f": "moveWordForwardAndModifySelection",
};

const WIN_COMMANDS: Record<string, string> = {
  // Windows and Linux use a different set. Chrome maps Ctrl to the common
  // editing shortcuts there, where macOS uses Cmd and gives Ctrl the emacs
  // style bindings above.
  "ctrl+a": "selectAll",
  "ctrl+c": "copy",
  "ctrl+x": "cut",
  "ctrl+v": "paste",
  "ctrl+z": "undo",
  "ctrl+y": "redo",
  "shift+ctrl+z": "redo",
  "ctrl+backspace": "deleteWordBackward",
  "ctrl+delete": "deleteWordForward",
  "ctrl+arrowleft": "moveWordLeft",
  "ctrl+arrowright": "moveWordRight",
  "ctrl+left": "moveWordLeft",
  "ctrl+right": "moveWordRight",
  "ctrl+home": "moveToBeginningOfDocument",
  "ctrl+end": "moveToEndOfDocument",
  "shift+ctrl+arrowleft": "moveWordLeftAndModifySelection",
  "shift+ctrl+arrowright": "moveWordRightAndModifySelection",
  "shift+ctrl+left": "moveWordLeftAndModifySelection",
  "shift+ctrl+right": "moveWordRightAndModifySelection",
  "shift+ctrl+home": "moveToBeginningOfDocumentAndModifySelection",
  "shift+ctrl+end": "moveToEndOfDocumentAndModifySelection",
};

/** Rewrite a chord into the table's vocabulary: shift, ctrl, alt, cmd. */
function normaliseChord(modifierParts: string[], main: string): string[] {
  const isMac = navigator.userAgent.includes("Mac");
  const has = (re: RegExp) => modifierParts.some((p) => re.test(p));

  const parts: string[] = [];
  if (has(/^shift$/i)) parts.push("shift");
  if (has(/^(control|ctrl)$/i)) parts.push("ctrl");
  if (has(/^(alt|option)$/i)) parts.push("alt");
  // On Windows and Linux the Meta key is Super, which carries no editing
  // commands, so only macOS folds it into the table.
  if (isMac && has(/^(meta|cmd|command)$/i)) parts.push("cmd");

  if (!parts.length) return [];

  const key = main.toLowerCase();
  // The table lists arrow keys under both spellings.
  const aliases = key.startsWith("arrow") ? [key, key.slice(5)] : [key];
  return aliases.map((k) => [...parts, k].join("+"));
}

function editingCommand(modifierParts: string[], main: string): string | undefined {
  const table = navigator.userAgent.includes("Mac") ? MAC_COMMANDS : WIN_COMMANDS;
  for (const chord of normaliseChord(modifierParts, main)) {
    if (table[chord]) return table[chord];
  }
  return undefined;
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
