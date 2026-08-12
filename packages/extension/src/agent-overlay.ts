/**
 * Visual "agent is controlling this tab" layer.
 *
 * - Hard acid frame (print edge, no glow stack)
 * - Compact status bar: mark + action + Stop
 * - Synthetic cursor that moves to each click target before the click fires
 *
 * Closed shadow root so page CSS cannot fight it. pointer-events:none
 * everywhere except Stop.
 */

const HOST_ID = "__deeporax_agent_overlay__";

/** Brand tokens mirrored from deeporax.com. */
const ACCENT = "#b6e51f";
const ACCENT_HOVER = "#c9ef4a";
const INK = "#15170f";
const PAPER = "#fdfcf7";

type OverlayState = {
  host: HTMLElement;
  root: ShadowRoot;
  frame: HTMLElement;
  bar: HTMLElement;
  label: HTMLElement;
  cursor: HTMLElement;
  ripple: HTMLElement;
  stopBtn: HTMLElement;
};

let state: OverlayState | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let cursorX = -9999;
let cursorY = -9999;

const CSS = `
:host { all: initial; }
.wrap {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
  font: 600 13px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: ${INK};
}
.frame {
  position: absolute;
  inset: 0;
  border: 2px solid ${ACCENT};
  box-shadow: inset 0 0 0 1px rgba(21, 23, 15, 0.4);
  opacity: 0;
  transition: opacity 140ms ease;
}
.frame.on { opacity: 1; }
.bar {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%) translateY(-8px);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(420px, 86vw);
  padding: 5px 5px 5px 8px;
  background: ${PAPER};
  border: 1.5px solid ${INK};
  border-radius: 999px;
  box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.55);
  opacity: 0;
  transition: opacity 140ms ease, transform 140ms ease;
}
.bar.on {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.mark { flex: none; display: block; }
.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 46vw;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: ${INK};
}
.label em {
  font-style: normal;
  font-weight: 500;
  color: #3a3e2c;
}
.stop {
  pointer-events: auto;
  flex: none;
  height: 28px;
  padding: 0 12px;
  border: 1.5px solid ${INK};
  border-radius: 999px;
  background: ${ACCENT};
  color: #2b3505;
  font: 700 12px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.01em;
  cursor: pointer;
}
.stop:hover { background: ${ACCENT_HOVER}; }
.stop:focus-visible {
  outline: 2px solid ${PAPER};
  outline-offset: 2px;
  box-shadow: 0 0 0 4px ${INK};
}
.cursor {
  position: absolute;
  top: 0;
  left: 0;
  width: 20px;
  height: 20px;
  margin: -1px 0 0 -1px;
  opacity: 0;
  transition: opacity 120ms ease;
  will-change: transform;
  filter: drop-shadow(1px 1px 0 rgba(0,0,0,0.55));
}
.cursor.on { opacity: 1; }
.ripple {
  position: absolute;
  top: 0;
  left: 0;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  border-radius: 50%;
  border: 2px solid ${ACCENT};
  opacity: 0;
  will-change: transform, opacity;
  box-sizing: border-box;
}
.ripple.go { animation: ring 400ms ease-out 1; }
@keyframes ring {
  0% { opacity: 0.95; transform: scale(0.4); }
  100% { opacity: 0; transform: scale(1.85); }
}
@media (prefers-reduced-motion: reduce) {
  .bar, .frame, .cursor { transition: none; }
  .ripple.go { animation: none; opacity: 0; }
}
`;

const CURSOR_SVG = `
<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M5 2.5 L5 19.2 L9.1 15.2 L11.7 21.4 L14.6 20.2 L12 14.1 L18 14.1 Z"
        fill="${ACCENT}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
</svg>`;

const MARK_SVG = `
<svg class="mark" width="14" height="14" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="3" y="3" width="42" height="42" rx="11" fill="${ACCENT}" stroke="${INK}" stroke-width="2.5"/>
  <rect x="19" y="19" width="15" height="15" rx="4" fill="none" stroke="${INK}" stroke-width="2.4"/>
  <rect x="13" y="13" width="17" height="17" rx="4.5" fill="${PAPER}" stroke="${INK}" stroke-width="2.7"/>
  <polygon points="18.6,17 18.6,26 26,21.5" fill="${INK}"/>
</svg>`;

function ensure(): OverlayState {
  if (state && document.documentElement.contains(state.host)) return state;

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Do not aria-hide the host: Stop must stay in the accessibility tree.
  host.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";

  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = CSS;

  const wrap = document.createElement("div");
  wrap.className = "wrap";

  const frame = document.createElement("div");
  frame.className = "frame";
  frame.setAttribute("aria-hidden", "true");

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "status");

  const mark = document.createElement("span");
  mark.innerHTML = MARK_SVG;
  mark.setAttribute("aria-hidden", "true");
  mark.style.cssText = "flex:none;display:flex;";

  const label = document.createElement("div");
  label.className = "label";
  label.id = "__deeporax_agent_label";
  label.innerHTML = "<em>controlling this tab</em>";

  const stopBtn = document.createElement("button");
  stopBtn.className = "stop";
  stopBtn.type = "button";
  stopBtn.textContent = "Stop";
  stopBtn.setAttribute("aria-label", "Stop browser agent");
  stopBtn.setAttribute("aria-describedby", "__deeporax_agent_label");
  stopBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stopped = true;
    setLabel("stopped");
    window.dispatchEvent(new CustomEvent("__deeporax_agent_stop"));
    setTimeout(() => hide(), 900);
  });

  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursor.innerHTML = CURSOR_SVG;

  const ripple = document.createElement("div");
  ripple.className = "ripple";
  ripple.setAttribute("aria-hidden", "true");

  bar.append(mark, label, stopBtn);
  wrap.append(frame, bar, ripple, cursor);
  root.append(style, wrap);
  (document.body || document.documentElement).appendChild(host);

  state = { host, root, frame, bar, label, cursor, ripple, stopBtn };
  return state;
}

function setLabel(action: string): void {
  const s = ensure();
  s.label.innerHTML = `<em>${escapeHtml(action)}</em>`;
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Show the overlay and describe what the agent is doing right now. */
export function showOverlay(action = "controlling this tab"): void {
  if (stopped) return;
  const s = ensure();
  s.frame.classList.add("on");
  s.bar.classList.add("on");
  setLabel(action);

  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => hide(), 15_000);
}

export function hide(): void {
  if (!state) return;
  state.frame.classList.remove("on");
  state.bar.classList.remove("on");
  state.cursor.classList.remove("on");
}

/**
 * Take the overlay out of the picture while a tool acts.
 *
 * It is real DOM: it lands in screenshots, it shows up in a hit test, and the
 * agent can end up clicking our own Stop button. Visibility is stashed so the
 * page looks the same afterwards.
 */
let hiddenForCapture: { frame: boolean; bar: boolean } | null = null;

export function hideForCapture(): void {
  if (!state || hiddenForCapture) return;
  hiddenForCapture = {
    frame: state.frame.classList.contains("on"),
    bar: state.bar.classList.contains("on"),
  };
  state.host.style.display = "none";
}

export function restoreAfterCapture(): void {
  if (!state || !hiddenForCapture) return;
  state.host.style.display = "";
  hiddenForCapture = null;
}

export function isStopped(): boolean {
  return stopped;
}

export function resetStop(): void {
  stopped = false;
}

export function removeOverlay(): void {
  if (state?.host?.parentNode) state.host.parentNode.removeChild(state.host);
  state = null;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Glide the synthetic cursor to (x, y) in viewport CSS pixels.
 * Resolves when the cursor has arrived so the caller can click right after.
 */
export function moveCursorTo(
  x: number,
  y: number,
  action?: string
): Promise<void> {
  const s = ensure();
  if (action) showOverlay(action);
  else showOverlay();

  s.cursor.classList.add("on");

  const fromX = cursorX < -1000 ? x : cursorX;
  const fromY = cursorY < -1000 ? y : cursorY;
  cursorX = x;
  cursorY = y;

  if (prefersReducedMotion()) {
    s.cursor.style.transform = `translate(${x}px, ${y}px)`;
    return Promise.resolve();
  }

  const dist = Math.hypot(x - fromX, y - fromY);
  const duration = Math.min(620, Math.max(180, dist * 1.15));

  return new Promise((resolve) => {
    const start = performance.now();
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = easeOutCubic(t);
      const cx = fromX + (x - fromX) * e;
      const cy = fromY + (y - fromY) * e;
      s.cursor.style.transform = `translate(${cx}px, ${cy}px)`;
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

/** Fire the click ripple at the current cursor position. */
export function clickPulse(x = cursorX, y = cursorY): void {
  const s = ensure();
  s.ripple.style.transform = `translate(${x}px, ${y}px)`;
  s.ripple.classList.remove("go");
  void s.ripple.offsetWidth;
  s.ripple.classList.add("go");
}

/**
 * Move the cursor to an element's center, pulse, and return the point.
 * Used right before dispatching a real click so the human sees the target.
 */
export async function cursorToElement(
  el: Element,
  action: string
): Promise<{ x: number; y: number }> {
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  await moveCursorTo(x, y, action);
  clickPulse(x, y);
  return { x, y };
}

/** Short description used in the bar, e.g. `clicked "Sign in"`. */
export function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const text =
    (el.getAttribute("aria-label") ||
      (el as HTMLInputElement).placeholder ||
      (el as HTMLElement).innerText ||
      el.textContent ||
      "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48);
  return text ? `${tag} "${text}"` : tag;
}
