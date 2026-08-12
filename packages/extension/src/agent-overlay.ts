/**
 * Visual "agent is controlling this tab" layer.
 *
 * - Hard acid frame around the viewport (print-block, no soft glow)
 * - Ticket-style status strip with action text + Stop
 * - Synthetic cursor that moves to each click target before the click fires
 *
 * Closed shadow root so page CSS cannot fight it. pointer-events:none
 * everywhere except Stop.
 */

const HOST_ID = "__deeporax_agent_overlay__";

/** Brand tokens mirrored from deeporax.com: acid accent on greenish ink. */
const ACCENT = "#b6e51f";
const ACCENT_HOVER = "#c9ef4a";
const INK = "#15170f";
const PAPER = "#fdfcf7";

type OverlayState = {
  host: HTMLElement;
  root: ShadowRoot;
  frame: HTMLElement;
  pill: HTMLElement;
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
  font: 500 12.5px/1.25 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.frame {
  position: absolute;
  inset: 0;
  border: 2.5px solid ${ACCENT};
  box-shadow:
    inset 0 0 0 1px rgba(21, 23, 15, 0.45),
    inset 0 0 0 4px rgba(182, 229, 31, 0.12);
  opacity: 0;
  transition: opacity 160ms ease, border-color 400ms ease;
}
.frame.on { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .frame.on {
    animation: edge 2.6s steps(2, end) infinite;
  }
}
@keyframes edge {
  0%, 100% { border-color: ${ACCENT}; }
  50% { border-color: rgba(182, 229, 31, 0.5); }
}
@media (prefers-reduced-motion: reduce) {
  .frame { animation: none; }
  .ripple.go { animation: none; opacity: 0; }
}
.pill {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%) translateY(-10px);
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0;
  border-radius: 9px;
  background: ${PAPER};
  color: ${INK};
  border: 2px solid ${INK};
  box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.72);
  opacity: 0;
  transition: opacity 160ms ease, transform 160ms ease;
  white-space: nowrap;
  max-width: min(440px, 84vw);
  overflow: hidden;
}
.pill.on { opacity: 1; transform: translateX(-50%) translateY(0); }
.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px 6px 8px;
  background: ${INK};
  color: ${PAPER};
  border-right: 2px solid ${INK};
  flex: none;
}
.brand-tag {
  font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.88;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 42vw;
  padding: 0 10px;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: ${INK};
}
.label span { opacity: 0.72; font-weight: 500; }
.stop {
  pointer-events: auto;
  cursor: pointer;
  border: 0;
  border-left: 2px solid ${INK};
  border-radius: 0;
  padding: 8px 13px;
  font: 750 11.5px/1 ui-sans-serif, system-ui, sans-serif;
  color: ${INK};
  background: ${ACCENT};
  flex: none;
  letter-spacing: -0.01em;
  transition: background 120ms ease;
}
.stop:hover { background: ${ACCENT_HOVER}; }
.stop:focus-visible { outline: 2px solid ${PAPER}; outline-offset: -3px; }
.mark { flex: none; display: block; }
.cursor {
  position: absolute;
  top: 0;
  left: 0;
  width: 20px;
  height: 20px;
  margin: -1px 0 0 -1px;
  opacity: 0;
  transition: opacity 140ms ease;
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
.ripple.go { animation: ring 420ms ease-out 1; }
@keyframes ring {
  0% { opacity: 0.95; transform: scale(0.4); }
  100% { opacity: 0; transform: scale(1.9); }
}
`;

const CURSOR_SVG = `
<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
  <path d="M5 2.5 L5 19.2 L9.1 15.2 L11.7 21.4 L14.6 20.2 L12 14.1 L18 14.1 Z"
        fill="${ACCENT}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
</svg>`;

/** The Deeporax "Stack" mark, same geometry as deeporax.com and the popup. */
const MARK_SVG = `
<svg class="mark" width="13" height="13" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="3" y="3" width="42" height="42" rx="11" fill="${ACCENT}" stroke="${INK}" stroke-width="2.5"/>
  <rect x="19" y="19" width="15" height="15" rx="4" fill="none" stroke="${INK}" stroke-width="2.4"/>
  <rect x="13" y="13" width="17" height="17" rx="4.5" fill="${PAPER}" stroke="${INK}" stroke-width="2.7"/>
  <polygon points="18.6,17 18.6,26 26,21.5" fill="${INK}"/>
</svg>`;

function ensure(): OverlayState {
  if (state && document.documentElement.contains(state.host)) return state;

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";

  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = CSS;

  const wrap = document.createElement("div");
  wrap.className = "wrap";

  const frame = document.createElement("div");
  frame.className = "frame";

  const pill = document.createElement("div");
  pill.className = "pill";

  const brand = document.createElement("div");
  brand.className = "brand";
  brand.innerHTML = `${MARK_SVG}<span class="brand-tag">Agent</span>`;

  const label = document.createElement("div");
  label.className = "label";
  label.innerHTML = "<span>controlling this tab</span>";

  const stopBtn = document.createElement("button");
  stopBtn.className = "stop";
  stopBtn.type = "button";
  stopBtn.textContent = "Stop";
  stopBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stopped = true;
    setLabel("stopped");
    window.dispatchEvent(new CustomEvent("__deeporax_agent_stop"));
    setTimeout(() => hide(), 900);
  });

  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.innerHTML = CURSOR_SVG;

  const ripple = document.createElement("div");
  ripple.className = "ripple";

  pill.append(brand, label, stopBtn);
  wrap.append(frame, pill, ripple, cursor);
  root.append(style, wrap);
  (document.body || document.documentElement).appendChild(host);

  state = { host, root, frame, pill, label, cursor, ripple, stopBtn };
  return state;
}

function setLabel(action: string): void {
  const s = ensure();
  s.label.innerHTML = `<span>${escapeHtml(action)}</span>`;
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
  s.pill.classList.add("on");
  setLabel(action);

  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => hide(), 15_000);
}

export function hide(): void {
  if (!state) return;
  state.frame.classList.remove("on");
  state.pill.classList.remove("on");
  state.cursor.classList.remove("on");
}

/**
 * Take the overlay out of the picture while a tool acts.
 *
 * It is real DOM: it lands in screenshots, it shows up in a hit test, and the
 * agent can end up clicking our own Stop button. Visibility is stashed so the
 * page looks the same afterwards.
 */
let hiddenForCapture: { frame: boolean; pill: boolean } | null = null;

export function hideForCapture(): void {
  if (!state || hiddenForCapture) return;
  hiddenForCapture = {
    frame: state.frame.classList.contains("on"),
    pill: state.pill.classList.contains("on"),
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
export function moveCursorTo(x: number, y: number, action?: string): Promise<void> {
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
  // force reflow so the animation restarts
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

/** Short description used in the pill, e.g. `clicked "Sign in"`. */
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
