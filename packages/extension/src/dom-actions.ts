/**
 * Runs in the page (via content script or executeScript).
 * Snapshot + interaction helpers with stable refs (e1, e2, ...).
 */
import {
  clickPulse,
  cursorToElement,
  describe,
  hideForCapture,
  isStopped,
  restoreAfterCapture,
  moveCursorTo,
  showOverlay,
} from "./agent-overlay";

export type RefEntry = {
  selector: string;
  role: string;
  name: string;
};

declare global {
  interface Window {
    __deeporaxRefs?: Map<string, WeakRef<Element>>;
    __deeporaxRefsBack?: WeakMap<Element, string>;
    __deeporaxRefSeq?: number;
    __deeporaxHandle?: (method: string, params: Record<string, unknown>) => unknown;
  }
}

/**
 * Refs are bound to an element for as long as that element lives.
 *
 * Numbering them per snapshot in document order looks tidy and is quietly
 * dangerous: a page that inserts a cookie banner shifts every ref by one, so a
 * ref taken from an earlier snapshot silently addresses a different element and
 * the write lands in the wrong field with no error. Keeping an identity index
 * means a ref either still means what it meant, or fails loudly.
 *
 * These live on `window` rather than in module scope because the injection
 * fallback evaluates a fresh copy of this module, and both copies have to agree
 * on what "e7" points at. Weak references let the page garbage collect nodes it
 * has thrown away instead of us pinning every element we ever saw.
 */
function refStore(): Map<string, WeakRef<Element>> {
  if (!window.__deeporaxRefs) window.__deeporaxRefs = new Map();
  return window.__deeporaxRefs;
}

function refIndex(): WeakMap<Element, string> {
  if (!window.__deeporaxRefsBack) window.__deeporaxRefsBack = new WeakMap();
  return window.__deeporaxRefsBack;
}

/** Reuse this element's existing ref, or mint one that is never reused. */
function refFor(el: Element): string {
  const store = refStore();
  const index = refIndex();

  const existing = index.get(el);
  if (existing && store.get(existing)?.deref() === el) return existing;

  const ref = `e${(window.__deeporaxRefSeq = (window.__deeporaxRefSeq ?? 0) + 1)}`;
  store.set(ref, new WeakRef(el));
  index.set(el, ref);
  return ref;
}

/** Drop entries whose element has been collected. */
function sweepRefs(): void {
  const store = refStore();
  for (const [ref, weak] of store) {
    if (!weak.deref()) store.delete(ref);
  }
}

function refElement(ref: string): Element | undefined {
  return refStore().get(ref)?.deref();
}

const INTERESTING_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='option']",
  "[role='switch']",
  "[contenteditable='true']",
  "h1",
  "h2",
  "h3",
  "label",
  "img[alt]",
].join(",");

/**
 * Open this element's shadow root, including a closed one.
 *
 * A plain `querySelectorAll` stops dead at a shadow boundary, so a page built
 * from web components looks empty: the agent is told there are no controls
 * while the user is looking straight at them. `chrome.dom` is available to
 * extensions only and opens closed roots too, which page script cannot do.
 */
function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  // Closed roots live on custom elements, and the dash in the tag name is the
  // only cheap way to spot one without probing every node on the page.
  if (!el.tagName.includes("-")) return null;
  try {
    return chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

/** Run a selector across the document and every shadow root beneath it. */
function queryDeep(selector: string): Element[] {
  const found: Element[] = [];
  const stack: Array<Document | ShadowRoot> = [document];
  const seen = new Set<Document | ShadowRoot>();

  while (stack.length) {
    const root = stack.pop()!;
    if (seen.has(root)) continue;
    seen.add(root);

    found.push(...Array.from(root.querySelectorAll(selector)));

    for (const el of Array.from(root.querySelectorAll("*"))) {
      const shadow = shadowRootOf(el);
      if (shadow) stack.push(shadow);
    }
  }
  return found;
}

/** True when the element lives inside a shadow root rather than the document. */
function inShadow(el: Element): boolean {
  return el.getRootNode() !== document;
}

function cssPath(el: Element): string {
  if (el.id) {
    const id = CSS.escape(el.id);
    if (document.querySelectorAll(`#${id}`).length === 1) return `#${id}`;
  }

  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part += `#${CSS.escape(node.id)}`;
      parts.unshift(part);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === node!.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") {
    const t = (el as HTMLInputElement).type || "text";
    if (t === "submit" || t === "button") return "button";
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    return "textbox";
  }
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "img") return "img";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "label") return "label";
  if ((el as HTMLElement).isContentEditable) return "textbox";
  return tag;
}

function nameOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim().slice(0, 120);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder.trim().slice(0, 120);
    if (el.name) return el.name;
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.textContent) return label.textContent.trim().slice(0, 120);
    }
  }

  if (el instanceof HTMLImageElement && el.alt) return el.alt.slice(0, 120);

  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 120);
}

function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  if (!html.getBoundingClientRect) return true;
  const style = window.getComputedStyle(html);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const r = html.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function buildSnapshot(opts: {
  interestingOnly?: boolean;
  maxElements?: number;
}): { text: string; refs: Record<string, RefEntry>; url: string; title: string } {
  const interestingOnly = opts.interestingOnly !== false;
  const refMeta: Record<string, RefEntry> = {};

  const lines: string[] = [];
  lines.push(`- page: ${document.title}`);
  lines.push(`  url: ${location.href}`);

  const roots = interestingOnly
    ? queryDeep(INTERESTING_SELECTOR).filter(isVisible)
    : queryDeep("*").filter(isVisible).slice(0, 400);

  // Deduplicate nested interesting nodes: keep outermost when parent also interesting
  const set = new Set(roots);
  const filtered = roots.filter((el) => {
    let p = el.parentElement;
    while (p) {
      if (set.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });

  // Silently dropping elements makes a snapshot look complete when it is not,
  // and an agent cannot act on what it was never shown. Cap explicitly and say so.
  const maxElements = Number(opts.maxElements ?? 250);
  const shown = filtered.slice(0, maxElements);

  for (const el of shown) {
    const ref = refFor(el);
    const role = roleOf(el);
    const name = nameOf(el);
    const shadowed = inShadow(el);
    const selector = shadowed ? "" : cssPath(el);
    refMeta[ref] = { selector, role, name };

    let extra = "";
    if (el instanceof HTMLAnchorElement && el.href) {
      extra += ` href="${el.href}"`;
    }
    if (el instanceof HTMLInputElement) {
      extra += ` inputType="${el.type}"`;
      // Checking only for type=password missed hidden inputs, which carry CSRF
      // and session tokens, and every field a site marks as a one-time code or
      // card number. The snapshot goes straight to the model, so use the same
      // test the write path uses.
      if (el.value) {
        extra += isSecretField(el)
          ? ` value="[redacted, ${el.value.length} chars]"`
          : ` value="${el.value.slice(0, 40)}"`;
      }
      if (el.checked) extra += ` checked`;
    }
    if (el instanceof HTMLSelectElement) {
      extra += ` value="${el.value}"`;
    }
    // Say so explicitly: a selector will not reach this one, only the ref will.
    if (shadowed) extra += " inShadowDom";
    const label = name ? ` "${name.replace(/"/g, '\\"')}"` : "";
    lines.push(`  - ${role}${label} [${ref}]${extra}`);
  }

  if (filtered.length > shown.length) {
    lines.push(
      `  - NOTE: showing ${shown.length} of ${filtered.length} elements. ` +
        `${filtered.length - shown.length} were left out. ` +
        "Raise maxElements, or use browser_find to locate a specific element."
    );
  }

  sweepRefs();

  return {
    text: lines.join("\n"),
    refs: refMeta,
    url: location.href,
    title: document.title,
  };
}

/** Values a click or keystroke is expected to move. */
function elementState(el: Element): string {
  const anyEl = el as HTMLElement & { checked?: boolean; value?: string };
  return [
    `checked=${el.getAttribute("aria-checked") ?? (anyEl.checked != null ? String(anyEl.checked) : "")}`,
    `selected=${el.getAttribute("aria-selected") ?? ""}`,
    `expanded=${el.getAttribute("aria-expanded") ?? ""}`,
    `pressed=${el.getAttribute("aria-pressed") ?? ""}`,
    `value=${anyEl.value != null ? String(anyEl.value).slice(0, 80) : ""}`,
    `class=${typeof el.className === "string" ? el.className : ""}`,
    `focused=${document.activeElement === el}`,
  ].join("|");
}

function resolveEl(params: Record<string, unknown>): Element {
  const ref = params.ref as string | undefined;
  const selector = params.selector as string | undefined;

  if (ref) {
    const el = refElement(ref);
    if (!el) {
      throw new Error(
        `Unknown or stale ref "${ref}". Run browser_snapshot again and use a fresh ref.`
      );
    }
    if (!el.isConnected) {
      throw new Error(
        `Ref "${ref}" points at an element the page has since removed. Run browser_snapshot again and use a fresh ref.`
      );
    }
    return el;
  }

  if (selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`No element matches selector: ${selector}`);
    return el;
  }

  throw new Error("Provide either ref (from snapshot) or selector");
}

/** Input types that hold no editable text, so writing to them is a mistake. */
const NON_TEXT_INPUT = new Set([
  "checkbox",
  "radio",
  "file",
  "button",
  "submit",
  "reset",
  "image",
  "range",
  "color",
]);

function isEditable(node: Element | null): node is HTMLElement {
  if (!node) return false;
  if (node instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT.has((node.type || "text").toLowerCase());
  }
  if (node instanceof HTMLTextAreaElement) return true;
  return (node as HTMLElement).isContentEditable === true;
}

/**
 * Find the element that actually holds the text.
 *
 * A snapshot ref often points at a wrapper: component libraries render a
 * decorated container around a plain <input>, and clicking the container is
 * what moves focus to the real field. Writing to the wrapper would silently do
 * nothing, so follow focus or the first editable descendant instead.
 */
function editableTarget(el: Element): HTMLElement {
  if (isEditable(el)) return el;

  const active = document.activeElement;
  if (isEditable(active) && el.contains(active)) return active;

  const inner = el.querySelector<HTMLElement>(
    'input, textarea, [contenteditable=""], [contenteditable="true"]'
  );
  if (isEditable(inner)) return inner;

  // Focus may have moved into a portal rendered outside this subtree.
  if (isEditable(active)) return active;

  throw new Error(
    `<${el.tagName.toLowerCase()}> is not a text field and contains no editable input.`
  );
}

/**
 * Fields whose contents must never reach the model.
 *
 * A failed write reports what the field actually holds so the caller can see
 * why it disagreed, which is exactly the wrong thing to do for a password or a
 * one-time code. The autocomplete tokens are the portable signal: sites set
 * them so password managers behave, which makes them reliable here too.
 */
const SECRET_AUTOCOMPLETE =
  /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i;

function isSecretField(el: Element): boolean {
  const type = ((el as HTMLInputElement).type || "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  return SECRET_AUTOCOMPLETE.test(el.getAttribute("autocomplete") ?? "");
}

function fieldValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  return (el as HTMLElement).innerText ?? el.textContent ?? "";
}

function selectWholeField(el: HTMLElement): number {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      el.select();
    } catch {
      // Some input types refuse programmatic selection; the caller verifies.
    }
    return el.value.length;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return (el.innerText ?? "").length;
}

function dispatchKey(el: Element, key: string) {
  const parts = key.split("+");
  const main = parts[parts.length - 1]!;
  const mods = {
    ctrlKey: parts.some((p) => /^(control|ctrl)$/i.test(p)),
    altKey: parts.some((p) => /^alt$/i.test(p)),
    shiftKey: parts.some((p) => /^shift$/i.test(p)),
    metaKey: parts.some((p) => /^(meta|cmd|command)$/i.test(p)),
  };

  for (const type of ["keydown", "keypress", "keyup"] as const) {
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: main,
        bubbles: true,
        cancelable: true,
        ...mods,
      })
    );
  }
}

export function handleDomMethod(
  method: string,
  params: Record<string, unknown>
): unknown {
  switch (method) {
    case "snapshot":
      return buildSnapshot({
        interestingOnly: params.interestingOnly as boolean | undefined,
        maxElements: params.maxElements as number | undefined,
      });

    case "click": {
      const el = resolveEl(params) as HTMLElement;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus?.();
      const dbl = Boolean(params.doubleClick);
      el.dispatchEvent(
        new MouseEvent(dbl ? "dblclick" : "click", {
          bubbles: true,
          cancelable: true,
          view: window,
          button: params.button === "right" ? 2 : params.button === "middle" ? 1 : 0,
        })
      );
      if (typeof el.click === "function" && !dbl) el.click();
      return { ok: true, ref: params.ref, selector: params.selector };
    }

    case "type": {
      const el = resolveEl(params) as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
      el.scrollIntoView({ block: "center" });
      el.focus?.();
      const text = String(params.text ?? "");
      const append = Boolean(params.append);

      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement
      ) {
        if (!append) {
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (params.slowly) {
          for (const ch of text) {
            el.value += ch;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(
              new KeyboardEvent("keydown", { key: ch, bubbles: true })
            );
            el.dispatchEvent(
              new KeyboardEvent("keyup", { key: ch, bubbles: true })
            );
          }
        } else {
          el.value = append ? el.value + text : text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (el.isContentEditable) {
        if (!append) el.textContent = "";
        el.textContent = (append ? el.textContent || "" : "") + text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        throw new Error("Element is not typeable");
      }

      if (params.submit) {
        dispatchKey(el, "Enter");
        const form = (el as HTMLInputElement).form;
        form?.requestSubmit?.();
      }
      return { ok: true };
    }

    case "press_key": {
      const key = String(params.key ?? "");
      const target =
        (document.activeElement as Element) || document.body || document.documentElement;
      dispatchKey(target, key);
      return { ok: true, key };
    }

    case "hover": {
      const el = resolveEl(params) as HTMLElement;
      el.scrollIntoView({ block: "center" });
      el.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window })
      );
      el.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window })
      );
      return { ok: true };
    }

    case "select_option": {
      const el = resolveEl(params);
      if (!(el instanceof HTMLSelectElement)) {
        throw new Error("Element is not a <select>");
      }
      const values = (params.values as string[]) || [];
      for (const opt of Array.from(el.options)) {
        opt.selected = values.includes(opt.value) || values.includes(opt.textContent || "");
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: el.value };
    }

    case "scroll": {
      if (params.ref || params.selector) {
        const el = resolveEl(params) as HTMLElement;
        el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        return { ok: true, mode: "intoView" };
      }
      const amount = Number(params.amount ?? 600);
      const dir = String(params.direction ?? "down");
      const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
      const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
      window.scrollBy(dx, dy);
      return { ok: true, dx, dy, scrollY: window.scrollY };
    }

    case "get_text": {
      if (params.ref || params.selector) {
        const el = resolveEl(params);
        return { text: (el as HTMLElement).innerText ?? el.textContent ?? "" };
      }
      return { text: document.body?.innerText ?? "" };
    }

    case "get_html": {
      const max = Number(params.maxLength ?? 100_000);
      let html: string;
      if (params.ref || params.selector) {
        html = resolveEl(params).outerHTML;
      } else {
        html = document.documentElement?.outerHTML ?? "";
      }
      if (html.length > max) html = html.slice(0, max) + `\n<!-- truncated ${html.length - max} chars -->`;
      return { html };
    }

    case "evaluate": {
      const script = String(params.script ?? "");
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${script})`);
      let result: unknown;
      try {
        result = fn();
      } catch {
        // try as statement body
        // eslint-disable-next-line no-new-func
        result = new Function(script)();
      }
      try {
        return { result: JSON.parse(JSON.stringify(result)) };
      } catch {
        return { result: String(result) };
      }
    }

    case "wait": {
      // Synchronous wait is not possible; content script path uses async wrapper.
      throw new Error("wait must be handled asynchronously");
    }

    case "fill_form": {
      const fields = (params.fields as Array<{ ref?: string; selector?: string; value: string }>) || [];
      const results = [];
      for (const field of fields) {
        handleDomMethod("type", { ...field, text: field.value });
        results.push({ ref: field.ref, selector: field.selector, ok: true });
      }
      if (params.submit) {
        const form = document.querySelector("form");
        form?.requestSubmit?.();
      }
      return { ok: true, fields: results };
    }

    case "find": {
      const query = String(params.query ?? "");
      if (!query) throw new Error("query is required");
      let re: RegExp | null = null;
      if (params.regex) {
        re = new RegExp(query, params.caseSensitive ? "" : "i");
      }
      const matches: Array<{
        ref?: string;
        role: string;
        name: string;
        selector: string;
        text: string;
      }> = [];

      // Prefer live refs from last snapshot
      const refs = window.__deeporaxRefs;
      if (refs && refs.size) {
        for (const [ref, weak] of refs) {
          const el = weak.deref();
          if (!el || !el.isConnected) continue;
          const role = roleOf(el);
          const name = nameOf(el);
          const text = ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          const hay = `${role} ${name} ${text}`;
          const ok = re ? re.test(hay) : hay.toLowerCase().includes(query.toLowerCase());
          if (ok) {
            matches.push({
              ref,
              role,
              name,
              selector: inShadow(el) ? "" : cssPath(el),
              text: text.slice(0, 160),
            });
          }
        }
      } else {
        // Fallback: scan interesting nodes and assign ephemeral refs
        const snap = buildSnapshot({ interestingOnly: true });
        for (const [ref, meta] of Object.entries(snap.refs)) {
          const hay = `${meta.role} ${meta.name}`;
          const ok = re ? re.test(hay) : hay.toLowerCase().includes(query.toLowerCase());
          if (ok) {
            matches.push({
              ref,
              role: meta.role,
              name: meta.name,
              selector: meta.selector,
              text: meta.name,
            });
          }
        }
      }
      return { query, count: matches.length, matches: matches.slice(0, Number(params.limit ?? 30)) };
    }

    case "click_xy": {
      const x = Number(params.x);
      const y = Number(params.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("x and y are required numbers (viewport CSS pixels)");
      }
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const target = el || document.body;
      const common = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: params.button === "right" ? 2 : params.button === "middle" ? 1 : 0,
      };
      target?.dispatchEvent(new MouseEvent("mousemove", common));
      target?.dispatchEvent(new MouseEvent("mousedown", common));
      target?.dispatchEvent(new MouseEvent("mouseup", common));
      const dbl = Boolean(params.doubleClick);
      target?.dispatchEvent(new MouseEvent(dbl ? "dblclick" : "click", common));
      if (target && typeof target.click === "function" && !dbl && common.button === 0) {
        // native click for links/buttons when possible
        try {
          target.click();
        } catch {
          /* ignore */
        }
      }
      return {
        ok: true,
        x,
        y,
        tag: target?.tagName?.toLowerCase(),
        text: (target?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
      };
    }

    case "drag": {
      const from = resolveEl({
        ref: params.fromRef ?? params.ref,
        selector: params.fromSelector ?? params.selector,
      }) as HTMLElement;
      const to = resolveEl({
        ref: params.toRef,
        selector: params.toSelector,
      }) as HTMLElement;
      from.scrollIntoView({ block: "center" });
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const x1 = a.left + a.width / 2;
      const y1 = a.top + a.height / 2;
      const x2 = b.left + b.width / 2;
      const y2 = b.top + b.height / 2;
      const dt = new DataTransfer();
      from.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: x1,
          clientY: y1,
        })
      );
      to.dispatchEvent(
        new DragEvent("dragenter", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: x2,
          clientY: y2,
        })
      );
      to.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: x2,
          clientY: y2,
        })
      );
      to.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: x2,
          clientY: y2,
        })
      );
      from.dispatchEvent(
        new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: x2,
          clientY: y2,
        })
      );
      return { ok: true, from: cssPath(from), to: cssPath(to) };
    }

    case "highlight": {
      const el = resolveEl(params) as HTMLElement;
      el.scrollIntoView({ block: "center", inline: "center" });
      const prev = el.getAttribute("data-deeporax-outline");
      if (!prev) {
        el.setAttribute("data-deeporax-outline", el.style.outline || "");
        el.setAttribute("data-deeporax-outline-offset", el.style.outlineOffset || "");
      }
      el.style.outline = String(params.style ?? "3px solid #b6e51f");
      el.style.outlineOffset = "2px";
      const ms = Number(params.durationMs ?? 2500);
      if (ms > 0) {
        window.setTimeout(() => {
          const o = el.getAttribute("data-deeporax-outline");
          const oo = el.getAttribute("data-deeporax-outline-offset");
          if (o !== null) el.style.outline = o;
          if (oo !== null) el.style.outlineOffset = oo;
          el.removeAttribute("data-deeporax-outline");
          el.removeAttribute("data-deeporax-outline-offset");
        }, ms);
      }
      const r = el.getBoundingClientRect();
      return {
        ok: true,
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    }

    case "file_upload": {
      const el = resolveEl(params) as HTMLInputElement;
      if (!(el instanceof HTMLInputElement) || el.type !== "file") {
        throw new Error("Target must be an <input type=file>");
      }
      const files = (params.files as Array<{ name: string; mimeType?: string; base64: string }>) || [];
      if (!files.length) throw new Error("files[] required");
      const dt = new DataTransfer();
      for (const f of files) {
        const bin = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        const file = new File([bin], f.name, {
          type: f.mimeType || "application/octet-stream",
        });
        dt.items.add(file);
      }
      el.files = dt.files;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        count: files.length,
        names: files.map((f) => f.name),
      };
    }

    case "get_bounding_box": {
      const el = resolveEl(params) as HTMLElement;
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        top: r.top,
        left: r.left,
        bottom: r.bottom,
        right: r.right,
      };
    }

    case "is_visible": {
      const el = resolveEl(params);
      return { visible: isVisible(el) };
    }

    case "dialog_policy": {
      const w = window as unknown as {
        __deeporaxDialogPolicy?: Record<string, unknown>;
        __deeporaxDialogs?: unknown[];
      };
      w.__deeporaxDialogPolicy = {
        ...(w.__deeporaxDialogPolicy || {}),
        ...(params.policy as object),
      };
      return {
        ok: true,
        policy: w.__deeporaxDialogPolicy,
        recent: (w.__deeporaxDialogs || []).slice(-10),
      };
    }

    /**
     * Resolve a target's viewport geometry and observable state.
     *
     * This has to run in the isolated world because that is where the
     * snapshot stores its ref map. The background then feeds these
     * coordinates to CDP, which delivers a trusted click.
     */
    case "resolve_target": {
      const el = resolveEl(params) as HTMLElement;
      el.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant" as ScrollBehavior,
      });
      // Force the scroll to settle before measuring, otherwise the rect can
      // still describe the pre-scroll position.
      void el.offsetHeight;

      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        throw new Error(
          `Element ${params.ref ?? params.selector} has zero size, so it cannot be clicked. It may be hidden.`
        );
      }

      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      // Anything painted on top would swallow the click.
      const top = document.elementFromPoint(cx, cy);
      let covered = false;
      let coveredBy = "";
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        covered = true;
        const cls =
          typeof top.className === "string" && top.className
            ? "." + top.className.split(" ")[0]
            : "";
        coveredBy = top.tagName.toLowerCase() + cls;
      }

      return {
        x: cx,
        y: cy,
        width: r.width,
        height: r.height,
        tag: el.tagName.toLowerCase(),
        text: ((el as HTMLElement).innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80),
        state: elementState(el),
        covered,
        coveredBy,
      };
    }

    /** Native <select>: CDP cannot drive an OS-drawn popup, so set it here. */
    case "select_option_native": {
      const el = resolveEl(params);
      if (!(el instanceof HTMLSelectElement)) {
        return { ok: false, reason: "Element is not a <select>" };
      }
      const values = (params.values as string[]) ?? [];
      const matched: string[] = [];
      for (const opt of Array.from(el.options)) {
        const hit =
          values.includes(opt.value) ||
          values.includes((opt.textContent ?? "").trim());
        opt.selected = hit;
        if (hit) matched.push(opt.value);
      }
      if (!matched.length) {
        return {
          ok: false,
          reason: `None of ${JSON.stringify(values)} matched an option`,
        };
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, matched, value: el.value };
    }

    /** Locate an open dropdown's option so the caller can click it for real. */
    case "find_option": {
      const wanted = String(params.text ?? "");
      const nodes = document.querySelectorAll(
        '[role="option"], [role="menuitem"], li, material-select-item, option'
      );
      for (const n of Array.from(nodes)) {
        const t = ((n as HTMLElement).innerText || n.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (t === wanted || t.includes(wanted)) {
          let r = n.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            n.scrollIntoView({ block: "center" });
            r = n.getBoundingClientRect();
            return {
              found: true,
              x: r.left + r.width / 2,
              y: r.top + r.height / 2,
              text: t,
            };
          }
        }
      }
      return { found: false };
    }

    /**
     * Read everything needed to decide whether a text write succeeded.
     *
     * The caller compares `value` against what it asked for, so this is the
     * single source of truth for the verification loop.
     */
    case "field_probe": {
      const el = editableTarget(resolveEl(params));
      const anyEl = el as HTMLInputElement | HTMLTextAreaElement;
      const contentEditable = (el as HTMLElement).isContentEditable;
      const max = Number(anyEl.maxLength ?? -1);
      return {
        kind: contentEditable
          ? "contenteditable"
          : el.tagName.toLowerCase() === "textarea"
            ? "textarea"
            : "input",
        value: fieldValue(el),
        // maxLength is -1 when unset; normalise so callers can test > 0.
        maxLength: Number.isFinite(max) && max > 0 ? max : 0,
        readOnly: Boolean(anyEl.readOnly),
        disabled: Boolean(anyEl.disabled) || el.getAttribute("aria-disabled") === "true",
        inputType: (anyEl.type || "").toLowerCase(),
        secret: isSecretField(el),
        ariaInvalid: el.getAttribute("aria-invalid") ?? "",
        valid: anyEl.validity ? anyEl.validity.valid : true,
        focused: document.activeElement === el,
        tag: el.tagName.toLowerCase(),
      };
    }

    /**
     * Select the whole field so the next trusted keystroke replaces it.
     *
     * This is a DOM selection rather than a Ctrl+A keystroke on purpose. A
     * modified key event reaches the page but Chrome does not turn it into
     * the built-in selectAll editing command, so the selection never happened
     * and typed text landed at the caret. A real Selection is honoured by the
     * editing pipeline regardless of platform or key bindings.
     */
    case "field_select_all": {
      const el = editableTarget(resolveEl(params));
      (el as HTMLElement).focus();
      const length = selectWholeField(el);
      return { ok: true, length, tag: el.tagName.toLowerCase() };
    }

    /** Put the caret after the existing content, for append. */
    case "field_caret_end": {
      const el = editableTarget(resolveEl(params));
      (el as HTMLElement).focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const end = el.value.length;
        try {
          el.setSelectionRange(end, end);
        } catch {
          // Selection is not supported on number/email/date inputs.
        }
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      return { ok: true };
    }

    /**
     * Last resort: write the value directly and announce it.
     *
     * Goes through the prototype's own setter so a framework that wraps the
     * property (React installs a value tracker) still sees a change. This is
     * not a trusted event, so the caller reports it as such.
     */
    case "field_force_set": {
      const el = editableTarget(resolveEl(params));
      const text = String(params.text ?? "");
      (el as HTMLElement).focus();

      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, text);
        else el.value = text;
      } else {
        el.textContent = text;
      }

      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: fieldValue(el) };
    }

    /** Just the state string, for the before/after diff. */
    case "element_state": {
      try {
        return { state: elementState(resolveEl(params)) };
      } catch {
        return { state: null };
      }
    }

    case "dialogs": {
      const w = window as unknown as { __deeporaxDialogs?: unknown[] };
      const list = w.__deeporaxDialogs || [];
      if (params.clear) w.__deeporaxDialogs = [];
      return { dialogs: list };
    }

    default:
      throw new Error(`Unknown DOM method: ${method}`);
  }
}

/** Actions that should animate the cursor before they run. */
const POINTER_METHODS = new Set(["click", "hover", "type", "select_option", "fill_form"]);

const ACTION_LABEL: Record<string, string> = {
  click: "clicking",
  hover: "hovering over",
  type: "typing into",
  select_option: "selecting in",
  fill_form: "filling",
  scroll: "scrolling the page",
  navigate: "navigating",
  snapshot: "reading the page",
  screenshot: "taking a screenshot",
  press_key: "pressing a key",
  drag: "dragging",
  file_upload: "uploading a file",
};

export async function handleDomMethodAsync(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const overlayOff = params.overlay === false;

  if (!overlayOff && isStopped()) {
    throw new Error("Agent control was stopped by the user in this tab. Ask them to resume.");
  }

  // Animate the synthetic cursor onto the target so the human can follow along.
  if (!overlayOff && POINTER_METHODS.has(method)) {
    try {
      if (method === "fill_form") {
        showOverlay("filling a form");
      } else {
        const el = resolveEl(params);
        await cursorToElement(el, `${ACTION_LABEL[method] ?? method} ${describe(el)}`);
      }
    } catch {
      // Target may not resolve (stale ref); let the real handler raise the error.
    }
  } else if (!overlayOff && method === "click_xy") {
    const x = Number(params.x);
    const y = Number(params.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      await moveCursorTo(x, y, `clicking at ${x}, ${y}`);
      clickPulse(x, y);
    }
  } else if (!overlayOff && ACTION_LABEL[method]) {
    showOverlay(ACTION_LABEL[method]);
  }

  if (method === "overlay") {
    const action = String(params.action ?? "show");
    if (action === "resume" || action === "hide" || action === "remove") {
      return {
        ok: false,
        reason:
          "The overlay is the user's indication that a tool is driving their browser, so it cannot be hidden or reset from a tool call. Only the person at the keyboard can clear a Stop.",
      };
    }
    if (action === "status") {
      return { stopped: isStopped() };
    }
    if (action === "hide_for_capture") {
      hideForCapture();
      return { ok: true, overlay: "hidden_for_capture" };
    }
    if (action === "restore_after_capture") {
      restoreAfterCapture();
      return { ok: true, overlay: "restored" };
    }
    showOverlay(String(params.label ?? "is controlling this tab"));
    return { ok: true, overlay: "shown" };
  }

  if (method === "wait") {
    // Cap hard so an agent cannot park a content-script wait for a full
    // minute while the bridge looks hung.
    const timeoutMs = Math.min(Number(params.timeout ?? 10) * 1000, 20_000);
    const start = Date.now();

    if (params.time != null) {
      const ms = Number(params.time) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(ms, timeoutMs)));
      return { ok: true, waited: params.time };
    }

    const deadline = start + timeoutMs;
    while (Date.now() < deadline) {
      if (params.text && document.body?.innerText.includes(String(params.text))) {
        return { ok: true, found: params.text };
      }
      if (params.textGone && !document.body?.innerText.includes(String(params.textGone))) {
        return { ok: true, gone: params.textGone };
      }
      if (params.selector && document.querySelector(String(params.selector))) {
        return { ok: true, selector: params.selector };
      }
      if (!params.text && !params.textGone && !params.selector) {
        throw new Error("wait requires time, text, textGone, or selector");
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`wait timed out after ${timeoutMs}ms`);
  }

  return handleDomMethod(method, params);
}

// Install page-side handler for content script messaging
export function installPageHandler(): void {
  window.__deeporaxHandle = (method, params) => handleDomMethod(method, params);
}
