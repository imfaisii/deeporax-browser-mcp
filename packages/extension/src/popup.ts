import { openRepo, openSite } from "./links";

type Status = "connected" | "connecting" | "disconnected";

const COPY: Record<
  Status,
  { kicker: string; title: string; detail: string; hint: string }
> = {
  connected: {
    kicker: "Bridge · on",
    title: "Connected",
    detail: "MCP client can drive this browser.",
    hint: 'In your agent, try: <code>snapshot my current tab</code>',
  },
  connecting: {
    kicker: "Bridge · linking",
    title: "Connecting",
    detail: "Reaching the local MCP server…",
    hint: "Keep this panel open for a moment.",
  },
  disconnected: {
    kicker: "Bridge · off",
    title: "Not connected",
    detail: "No local MCP server on this machine.",
    hint: "Run <code>npx deeporax-browser-mcp</code>, then open this panel again.",
  },
};

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function paint(status: Status, url: string, blockHeavy: boolean) {
  document.body.dataset.state = status;

  const kicker = el("status-kicker");
  if (kicker) kicker.textContent = COPY[status].kicker;

  const title = el("status-title");
  if (title) title.textContent = COPY[status].title;

  const detail = el("status-detail");
  if (detail) {
    if (status === "connected") {
      detail.innerHTML = `<span class="endpoint">${escapeHtml(url)}</span>`;
    } else {
      detail.textContent = COPY[status].detail;
    }
  }

  const hint = el("hint");
  if (hint) hint.innerHTML = COPY[status].hint;

  const reconnect = el<HTMLButtonElement>("reconnect");
  if (reconnect) {
    reconnect.disabled = status === "connecting";
    reconnect.textContent =
      status === "connecting"
        ? "Connecting…"
        : status === "connected"
          ? "Reconnect"
          : "Reconnect";
  }

  const toggle = el<HTMLInputElement>("block-heavy");
  if (toggle && toggle.checked !== blockHeavy) {
    toggle.checked = blockHeavy;
    toggle.setAttribute("aria-checked", blockHeavy ? "true" : "false");
  }
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "get-status" });
    paint(
      (res?.status as Status) ?? "disconnected",
      res?.url ?? "ws://127.0.0.1:17373",
      Boolean(res?.blockHeavyAssets)
    );
  } catch {
    paint("disconnected", "ws://127.0.0.1:17373", true);
  }
}

el("reconnect")?.addEventListener("click", async () => {
  const heavy = el<HTMLInputElement>("block-heavy")?.checked ?? false;
  paint("connecting", "", heavy);
  try {
    await chrome.runtime.sendMessage({ type: "reconnect" });
  } finally {
    setTimeout(() => void refresh(), 400);
  }
});

el("brand")?.addEventListener("click", () => openSite("/", "popup_wordmark"));
el("site")?.addEventListener("click", () => openSite("/", "popup_footer"));
el("docs")?.addEventListener("click", () => openRepo());

const blockToggle = el<HTMLInputElement>("block-heavy");
blockToggle?.addEventListener("change", async () => {
  const enabled = Boolean(blockToggle.checked);
  blockToggle.setAttribute("aria-checked", enabled ? "true" : "false");
  blockToggle.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "set-block-heavy-assets",
      enabled,
    });
    const on = Boolean(res?.blockHeavyAssets ?? enabled);
    blockToggle.checked = on;
    blockToggle.setAttribute("aria-checked", on ? "true" : "false");
  } catch {
    blockToggle.checked = !enabled;
    blockToggle.setAttribute(
      "aria-checked",
      blockToggle.checked ? "true" : "false"
    );
  } finally {
    blockToggle.disabled = false;
  }
});

const version = el("version");
if (version) version.textContent = `v${chrome.runtime.getManifest().version}`;

void refresh();
setInterval(() => void refresh(), 1500);
