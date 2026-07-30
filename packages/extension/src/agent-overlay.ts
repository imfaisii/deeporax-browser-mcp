/**
 * Visual "agent is controlling this tab" layer.
 *
 * - Pulsing orange border around the viewport
 * - Status pill with a Stop button
 * - A synthetic cursor that animates to each click target before the click fires
 *
 * Everything lives in a closed shadow root so page CSS cannot fight it, and
 * every node is pointer-events:none except the Stop button.
 */

const HOST_ID = "__deeporax_agent_overlay__";
const ACCENT = "#f97316";

/**
 * Brand link in the status pill. Tagged so visits originating from the
 * on-page overlay are attributable, matching the popup's UTM scheme.
 */
const SITE_URL =
  "https://deeporax.com/?utm_source=chrome_extension&utm_medium=extension" +
  "&utm_campaign=browser_mcp&utm_content=overlay_pill";

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
  font: 500 13px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.frame {
  position: absolute;
  inset: 0;
  border: 2px solid ${ACCENT};
  border-radius: 4px;
  box-shadow:
    inset 0 0 0 1px rgba(249, 115, 22, 0.22),
    inset 0 0 18px rgba(249, 115, 22, 0.14);
  animation: pulse 2.4s ease-in-out infinite;
  opacity: 0;
  transition: opacity 180ms ease;
}
.frame.on { opacity: 1; }
@keyframes pulse {
  0%, 100% {
    border-color: rgba(249, 115, 22, 0.85);
    box-shadow:
      inset 0 0 0 1px rgba(249, 115, 22, 0.22),
      inset 0 0 18px rgba(249, 115, 22, 0.12);
  }
  50% {
    border-color: rgba(249, 115, 22, 0.42);
    box-shadow:
      inset 0 0 0 1px rgba(249, 115, 22, 0.12),
      inset 0 0 26px rgba(249, 115, 22, 0.22);
  }
}
@media (prefers-reduced-motion: reduce) {
  .frame { animation: none; }
  .dot { animation: none; }
  .ripple.go { animation: none; opacity: 0; }
}
.pill {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%) translateY(-14px);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 6px 6px 12px;
  border-radius: 999px;
  background: rgba(14, 15, 17, 0.94);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.07),
    0 8px 28px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(10px) saturate(140%);
  opacity: 0;
  transition: opacity 180ms ease, transform 180ms ease;
  white-space: nowrap;
  max-width: 78vw;
}
.brandlink {
  pointer-events: auto;
  cursor: pointer;
  border: 0;
  background: none;
  padding: 0 2px 0 0;
  margin: 0;
  font: 650 12.5px/1 ui-sans-serif, system-ui, sans-serif;
  color: ${ACCENT};
  letter-spacing: -0.005em;
  flex: none;
  text-decoration: none;
}
.brandlink:hover { color: #fdba74; text-decoration: underline; }
.divider {
  width: 1px;
  height: 13px;
  background: rgba(255, 255, 255, 0.16);
  flex: none;
}
.pill.on { opacity: 1; transform: translateX(-50%) translateY(0); }
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${ACCENT};
  box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.7);
  animation: blip 1.4s ease-out infinite;
  flex: none;
}
@keyframes blip {
  0% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.65); }
  70% { box-shadow: 0 0 0 9px rgba(249, 115, 22, 0); }
  100% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0); }
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 56vw;
}
.label b { font-weight: 650; }
.label span { opacity: 0.72; font-weight: 400; }
.stop {
  pointer-events: auto;
  cursor: pointer;
  border: 0;
  border-radius: 999px;
  padding: 5px 13px;
  font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
  color: #fff;
  background: #dc2626;
  flex: none;
  transition: background 140ms ease;
}
.stop:hover { background: #ef4444; }
.stop:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.cursor {
  position: absolute;
  top: 0;
  left: 0;
  width: 22px;
  height: 22px;
  margin: -2px 0 0 -2px;
  opacity: 0;
  transition: opacity 150ms ease;
  will-change: transform;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.45));
}
.cursor.on { opacity: 1; }
.ripple {
  position: absolute;
  top: 0;
  left: 0;
  width: 26px;
  height: 26px;
  margin: -13px 0 0 -13px;
  border-radius: 50%;
  border: 2px solid ${ACCENT};
  opacity: 0;
  will-change: transform, opacity;
}
.ripple.go { animation: ring 520ms ease-out 1; }
@keyframes ring {
  0% { opacity: 0.9; transform: scale(0.35); }
  100% { opacity: 0; transform: scale(2.2); }
}
`;

const CURSOR_SVG = `
<svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
  <path d="M5 2.5 L5 19.2 L9.1 15.2 L11.7 21.4 L14.6 20.2 L12 14.1 L18 14.1 Z"
        fill="#ffffff" stroke="${ACCENT}" stroke-width="1.6" stroke-linejoin="round"/>
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

  const dot = document.createElement("div");
  dot.className = "dot";

  const brand = document.createElement("a");
  brand.className = "brandlink";
  brand.textContent = "Deeporax";
  brand.href = SITE_URL;
  brand.target = "_blank";
  brand.rel = "noopener noreferrer";

  const divider = document.createElement("div");
  divider.className = "divider";

  const label = document.createElement("div");
  label.className = "label";
  label.innerHTML = "<span>is controlling this tab</span>";

  const stopBtn = document.createElement("button");
  stopBtn.className = "stop";
  stopBtn.textContent = "Stop";
  stopBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stopped = true;
    setLabel("stopped by user");
    window.dispatchEvent(new CustomEvent("__deeporax_agent_stop"));
    setTimeout(() => hide(), 900);
  });

  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.innerHTML = CURSOR_SVG;

  const ripple = document.createElement("div");
  ripple.className = "ripple";

  pill.append(dot, brand, divider, label, stopBtn);
  wrap.append(frame, pill, ripple, cursor);
  root.append(style, wrap);
  (document.body || document.documentElement).appendChild(host);

  state = { host, root, frame, pill, label, cursor, ripple, stopBtn };
  return state;
}

function setLabel(action: string): void {
  const s = ensure();
  // Only the action text changes; the brand link is a sibling node so it survives.
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
export function showOverlay(action = "is controlling this tab"): void {
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
