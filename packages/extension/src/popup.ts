import { openRepo, openSite } from "./links";

type Status = "connected" | "connecting" | "disconnected";

const COPY: Record<Status, { headline: string; detail: string }> = {
  connected: {
    headline: "Connected",
    detail: "MCP client can drive this browser",
  },
  connecting: {
    headline: "Connecting…",
    detail: "Reaching local MCP server",
  },
  disconnected: {
    headline: "Offline",
    detail: "Local MCP server not found",
  },
};

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function paint(status: Status, url: string, blockHeavy: boolean) {
  document.body.dataset.state = status;

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
        ? `Try: <code>snapshot my current tab</code>`
        : `Run <code>npx deeporax-browser-mcp</code>, then reopen this popup.`;
  }

  const toggle = el<HTMLInputElement>("block-heavy");
  if (toggle && toggle.checked !== blockHeavy) {
    toggle.checked = blockHeavy;
    toggle.setAttribute("aria-checked", blockHeavy ? "true" : "false");
  }
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
  paint("connecting", "", el<HTMLInputElement>("block-heavy")?.checked ?? false);
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(() => void refresh(), 400);
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
