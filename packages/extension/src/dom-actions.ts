/**
 * Runs in the page (via content script or executeScript).
 * Snapshot + interaction helpers with stable refs (e1, e2, ...).
 */
import {
  clickPulse,
  cursorToElement,
  describe,
  hide as hideOverlay,
  isStopped,
  moveCursorTo,
  removeOverlay,
  resetStop,
  showOverlay,
} from "./agent-overlay";

export type RefEntry = {
  selector: string;
  role: string;
  name: string;
};

declare global {
  interface Window {
    __deeporaxRefs?: Map<string, Element>;
    __deeporaxHandle?: (method: string, params: Record<string, unknown>) => unknown;
  }
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
  maxDepth?: number;
}): { text: string; refs: Record<string, RefEntry>; url: string; title: string } {
  const interestingOnly = opts.interestingOnly !== false;
  const refs = new Map<string, Element>();
  const refMeta: Record<string, RefEntry> = {};
  let counter = 0;

  const lines: string[] = [];
  lines.push(`- page: ${document.title}`);
  lines.push(`  url: ${location.href}`);

  const roots = interestingOnly
    ? Array.from(document.querySelectorAll(INTERESTING_SELECTOR)).filter(isVisible)
    : Array.from(document.body?.querySelectorAll("*") || []).filter(isVisible).slice(0, 400);

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

  for (const el of filtered.slice(0, 250)) {
    const ref = `e${++counter}`;
    refs.set(ref, el);
    const role = roleOf(el);
    const name = nameOf(el);
    const selector = cssPath(el);
    refMeta[ref] = { selector, role, name };

    let extra = "";
    if (el instanceof HTMLAnchorElement && el.href) {
      extra += ` href="${el.href}"`;
    }
    if (el instanceof HTMLInputElement) {
      extra += ` inputType="${el.type}"`;
      if (el.value && el.type !== "password") extra += ` value="${el.value.slice(0, 40)}"`;
      if (el.checked) extra += ` checked`;
    }
    if (el instanceof HTMLSelectElement) {
      extra += ` value="${el.value}"`;
    }
    const label = name ? ` "${name.replace(/"/g, '\\"')}"` : "";
    lines.push(`  - ${role}${label} [${ref}]${extra}`);
  }

  window.__deeporaxRefs = refs;

  return {
    text: lines.join("\n"),
    refs: refMeta,
    url: location.href,
    title: document.title,
  };
}

function resolveEl(params: Record<string, unknown>): Element {
  const ref = params.ref as string | undefined;
  const selector = params.selector as string | undefined;

  if (ref) {
    const el = window.__deeporaxRefs?.get(ref);
    if (!el || !document.contains(el)) {
      throw new Error(
        `Unknown or stale ref "${ref}". Run browser_snapshot again and use a fresh ref.`
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
        maxDepth: params.maxDepth as number | undefined,
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
        for (const [ref, el] of refs) {
          if (!document.contains(el)) continue;
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
              selector: cssPath(el),
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
    if (action === "hide") {
      hideOverlay();
      return { ok: true, overlay: "hidden" };
    }
    if (action === "remove") {
      removeOverlay();
      return { ok: true, overlay: "removed" };
    }
    if (action === "resume") {
      resetStop();
      showOverlay("resumed control");
      return { ok: true, overlay: "resumed" };
    }
    if (action === "status") {
      return { stopped: isStopped() };
    }
    showOverlay(String(params.label ?? "is controlling this tab"));
    return { ok: true, overlay: "shown" };
  }

  if (method === "wait") {
    const timeoutMs = Math.min(Number(params.timeout ?? 15) * 1000, 60_000);
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
