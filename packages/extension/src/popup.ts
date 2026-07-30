import { openSite } from "./links";

type Status = "connected" | "connecting" | "disconnected";

const ICONS: Record<Status, string> = {
  // plug: bridge is live
  connected: `<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z"/><path d="M12 17v5"/>`,
  // power: still negotiating
  connecting: `<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>`,
  // unplugged: nothing listening
  disconnected: `<path d="m2 2 20 20"/><path d="M9 2v6M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-9.2 5.1"/>`,
};

const COPY: Record<Status, { headline: string; detail: string }> = {
  connected: {
    headline: "Bridge connected",
    detail: "Your MCP client can drive this browser",
  },
  connecting: {
    headline: "Connecting…",
    detail: "Reaching the local MCP server",
  },
  disconnected: {
    headline: "Server not running",
    detail: "Start the MCP server to connect",
  },
};

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function paint(status: Status, url: string) {
  document.body.dataset.state = status;

  const icon = el("beacon-icon");
  if (icon) icon.innerHTML = ICONS[status];

  const headline = el("headline");
  if (headline) headline.textContent = COPY[status].headline;

  const detail = el("detail");
  if (detail) {
    if (status === "connected") {
      detail.innerHTML = `<span class="endpoint">${url}</span>`;
    } else {
      detail.textContent = COPY[status].detail;
    }
  }

  const helpText = el("help-text");
  if (helpText) {
    helpText.innerHTML =
      status === "connected"
        ? `Try asking your agent: <code>snapshot my current tab</code>`
        : `Start the server with <code>npx deeporax-browser-mcp</code>, then keep this window open.`;
  }
}

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "get-status" });
    paint(
      (res?.status as Status) ?? "disconnected",
      res?.url ?? "ws://127.0.0.1:17373"
    );
  } catch {
    paint("disconnected", "ws://127.0.0.1:17373");
  }
}

el("reconnect")?.addEventListener("click", async () => {
  paint("connecting", "");
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(() => void refresh(), 400);
});

el("brand")?.addEventListener("click", () => openSite("/", "popup_wordmark"));
el("site")?.addEventListener("click", () => openSite("/", "popup_footer"));
el("docs")?.addEventListener("click", () =>
  openSite("/browser-mcp", "popup_setup_guide")
);

const version = el("version");
if (version) version.textContent = `v${chrome.runtime.getManifest().version}`;

void refresh();
setInterval(() => void refresh(), 1500);
