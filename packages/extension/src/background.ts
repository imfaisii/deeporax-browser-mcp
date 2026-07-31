import { DEFAULT_PORT, PROTOCOL_VERSION, isRequest, type BridgeRequest, type BridgeResponse } from "./protocol";
import { MAIN_WORLD_HOOKS } from "./page-hooks";
import * as cdp from "./cdp";
import * as interact from "./interact";

const PORT = DEFAULT_PORT;
const RECONNECT_MS = 2000;
const ALARM_NAME = "deeporax-browser-mcp-keepalive";

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastStatus: "connected" | "disconnected" | "connecting" = "disconnected";

/** tabId -> whether chrome.debugger is attached for network capture */
const debuggerAttached = new Set<number>();
type NetReq = {
  id: string;
  method: string;
  url: string;
  status?: number;
  type?: string;
  ts: number;
};
const networkByTab = new Map<number, NetReq[]>();
const MAX_NET = 500;

function pushNet(tabId: number, entry: NetReq) {
  let list = networkByTab.get(tabId);
  if (!list) {
    list = [];
    networkByTab.set(tabId, list);
  }
  list.push(entry);
  if (list.length > MAX_NET) list.splice(0, list.length - MAX_NET);
}

// --- WebSocket bridge -------------------------------------------------------

function bridgeUrl(): string {
  return `ws://127.0.0.1:${PORT}`;
}

function setStatus(s: typeof lastStatus) {
  lastStatus = s;
  chrome.action.setBadgeText({ text: s === "connected" ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({
    color: s === "connected" ? "#16a34a" : "#6b7280",
  });
}

function connect() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  setStatus("connecting");
  try {
    socket = new WebSocket(bridgeUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    setStatus("connected");
    socket?.send(
      JSON.stringify({
        type: "hello",
        version: PROTOCOL_VERSION,
        extensionId: chrome.runtime.id,
      })
    );
  });

  socket.addEventListener("message", (ev) => {
    void onServerMessage(String(ev.data));
  });

  socket.addEventListener("close", () => {
    setStatus("disconnected");
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    // close handler will reconnect
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function respond(res: BridgeResponse) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(res));
  }
}

async function onServerMessage(raw: string) {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: string }).type === "ping"
  ) {
    socket?.send(JSON.stringify({ type: "pong" }));
    return;
  }

  if (!isRequest(msg)) return;

  try {
    const result = await handleMethod(msg);
    respond({ id: msg.id, ok: true, result });
  } catch (err) {
    respond({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Tab helpers ------------------------------------------------------------

/**
 * The tab the agent is working on. navigate/tabs set it, everything else
 * inherits it, so a tool without an explicit tabId cannot drift onto an
 * unrelated tab between calls.
 */
let currentTabId: number | null = null;

function rememberTab(tabId: number): number {
  currentTabId = tabId;
  return tabId;
}

async function resolveTabId(tabId?: number): Promise<number> {
  if (typeof tabId === "number") return rememberTab(tabId);

  if (currentTabId != null) {
    try {
      const tab = await chrome.tabs.get(currentTabId);
      if (tab?.id != null) return tab.id;
    } catch {
      currentTabId = null; // closed since we last used it
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return rememberTab(tab.id);
}

/** Restricted pages cannot be scripted; say so once, in one place. */
async function assertScriptable(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? "";
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.includes("chrome.google.com/webstore")
  ) {
    throw new Error(
      `Cannot act on ${url || "this tab"}. Chrome blocks extensions on internal pages. ` +
        "Navigate to an http(s) page first."
    );
  }
  return tab;
}

async function getTab(tabId?: number): Promise<chrome.tabs.Tab> {
  const id = await resolveTabId(tabId);
  const tab = await chrome.tabs.get(id);
  return tab;
}

function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          clearInterval(timer);
          // small settle delay for client-side routers
          setTimeout(() => resolve(), 150);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error("Navigation timed out"));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, 100);
  });
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "deeporax-browser-mcp-ping" });
    return;
  } catch {
    // not injected yet
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

async function domCall(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  await ensureContentScript(tabId);

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "deeporax-browser-mcp-dom",
    method,
    params,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "DOM call failed");
  }
  return response.result;
}

// Fallback: run in isolated world via executeScript if messaging fails
async function domCallFallback(
  tabId: number,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (m: string, p: Record<string, unknown>) => {
      const w = window as unknown as {
        __deeporaxHandle?: (method: string, params: Record<string, unknown>) => unknown;
      };
      if (typeof w.__deeporaxHandle === "function") {
        return w.__deeporaxHandle(m, p);
      }
      throw new Error(
        "deeporax-browser-mcp page handler not installed; reload the tab and try again"
      );
    },
    args: [method, params],
  });
  const first = injected[0];
  if (!first) {
    throw new Error(
      "Could not run in the page: executeScript returned no frame result. " +
        "The tab may still be loading, or the page may block extension scripts."
    );
  }
  return first.result;
}

async function safeDom(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  try {
    return await domCall(tabId, method, params);
  } catch (primary) {
    const a = primary instanceof Error ? primary.message : String(primary);

    // A page-level rejection ("stale ref", "no element matches selector") is
    // the answer, not a transport problem. Retrying via injection would only
    // reproduce it and bury the useful text.
    if (/stale|Unknown or stale|No element matches|not a <select>|zero size|Provide either/i.test(a)) {
      throw primary instanceof Error ? primary : new Error(a);
    }

    try {
      return await domCallFallback(tabId, method, params);
    } catch (fallback) {
      const b = fallback instanceof Error ? fallback.message : String(fallback);
      throw new Error(`${method} failed. Content script: ${a}. Injection: ${b}`);
    }
  }
}

// --- Method router ----------------------------------------------------------

async function handleMethod(req: BridgeRequest): Promise<unknown> {
  const method = req.method;
  const params = (req.params ?? {}) as Record<string, unknown>;
  const tabIdParam = params.tabId as number | undefined;

  switch (method) {
    // Lets a developer pick up a rebuilt extension without visiting
    // chrome://extensions. The socket drops and reconnects on its own.
    case "reload_extension": {
      setTimeout(() => chrome.runtime.reload(), 50);
      return { ok: true, reloading: true, version: chrome.runtime.getManifest().version };
    }

    case "active_tab": {
      const tab = await getTab(tabIdParam);
      return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        status: tab.status,
        windowId: tab.windowId,
        active: tab.active,
      };
    }

    case "navigate": {
      const url = String(params.url);
      if (params.newTab) {
        const tab = await chrome.tabs.create({ url, active: true });
        if (tab.id) {
          rememberTab(tab.id);
          await waitForTabComplete(tab.id);
          const fresh = await chrome.tabs.get(tab.id);
          return { tabId: tab.id, url: fresh.url, title: fresh.title };
        }
        return { tabId: tab.id, url: tab.url, title: tab.title };
      }
      const id = await resolveTabId(tabIdParam);
      await chrome.tabs.update(id, { url });
      await waitForTabComplete(id);
      const tab = await chrome.tabs.get(id);
      return { tabId: id, url: tab.url, title: tab.title };
    }

    case "back": {
      const id = await resolveTabId(tabIdParam);
      await chrome.tabs.goBack(id);
      await waitForTabComplete(id);
      return { ok: true, tabId: id };
    }

    case "forward": {
      const id = await resolveTabId(tabIdParam);
      await chrome.tabs.goForward(id);
      await waitForTabComplete(id);
      return { ok: true, tabId: id };
    }

    case "reload": {
      const id = await resolveTabId(tabIdParam);
      await chrome.tabs.reload(id, { bypassCache: Boolean(params.hard) });
      await waitForTabComplete(id);
      return { ok: true, tabId: id };
    }

    case "tabs": {
      const action = String(params.action);
      if (action === "list") {
        const tabs = await chrome.tabs.query({});
        return tabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          windowId: t.windowId,
        }));
      }
      if (action === "new") {
        const tab = await chrome.tabs.create({
          url: (params.url as string) || "about:blank",
          active: true,
        });
        if (tab.id) rememberTab(tab.id);
        return { id: tab.id, url: tab.url };
      }
      if (action === "close") {
        const id = await resolveTabId(tabIdParam);
        await chrome.tabs.remove(id);
        return { ok: true, closed: id };
      }
      if (action === "select") {
        const id = await resolveTabId(tabIdParam);
        const tab = await chrome.tabs.get(id);
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.tabs.update(id, { active: true });
        return { ok: true, tabId: id };
      }
      throw new Error(`Unknown tabs action: ${action}`);
    }

    case "screenshot": {
      const id = await resolveTabId(tabIdParam);
      const tab = await assertScriptable(id);

      // Page.captureScreenshot works on a background tab and can shoot the
      // full page. captureVisibleTab needs an activeTab grant we do not have,
      // which is what made this fail outright.
      if (await cdp.attach(id)) {
        const data = await cdp.captureScreenshot(id, {
          fullPage: Boolean(params.fullPage),
        });
        return { data, mimeType: "image/png", url: tab.url, title: tab.title };
      }

      // Fall back to the tabs API, which requires the tab to be visible.
      if (!tab.active) {
        await chrome.tabs.update(id, { active: true });
        await new Promise((r) => setTimeout(r, 120));
      }
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "png",
        });
        return {
          data: dataUrl.replace(/^data:image\/png;base64,/, ""),
          mimeType: "image/png",
          url: tab.url,
          title: tab.title,
        };
      } catch (err) {
        const why = cdp.unavailableReason(id);
        throw new Error(
          `Screenshot failed: ${err instanceof Error ? err.message : String(err)}.` +
            (why ? ` The debugger could not attach either: ${why}` : "") +
            " Close DevTools on this tab if it is open, then retry."
        );
      }
    }

    // Pointer and keyboard actions go through the debugger so the page sees
    // isTrusted events. Component libraries drop synthetic ones.
    case "click":
    case "click_xy":
    case "type":
    case "press_key":
    case "hover":
    case "drag":
    case "select_option":
    case "fill_form": {
      const id = await resolveTabId(tabIdParam);
      await assertScriptable(id);
      await injectMainHooks(id);

      if (!(await cdp.attach(id))) {
        const why = cdp.unavailableReason(id) ?? "unknown reason";
        throw new Error(
          `Cannot send trusted input to this tab: ${why}. ` +
            "This usually means DevTools is open on it, or another debugger is attached. " +
            "Close DevTools and retry."
        );
      }

      switch (method) {
        case "click":
          return await interact.click(id, params);
        case "click_xy":
          return await interact.clickAtPoint(id, params);
        case "type":
          return await interact.type(id, params);
        case "press_key":
          return await interact.pressKey(id, params);
        case "hover":
          return await interact.hover(id, params);
        case "drag":
          return await interact.drag(id, params);
        case "select_option":
          return await interact.selectOption(id, params);
        case "fill_form":
          return await interact.fillForm(id, params);
      }
      throw new Error(`Unhandled interaction: ${method}`);
    }

    // Real page evaluation. MV3 forbids new Function inside the extension,
    // so this has to run out of process through the debugger.
    case "evaluate": {
      const id = await resolveTabId(tabIdParam);
      await assertScriptable(id);
      const script = String(params.script ?? "");
      if (!script.trim()) throw new Error("script is required");

      if (!(await cdp.attach(id))) {
        const why = cdp.unavailableReason(id) ?? "unknown reason";
        throw new Error(
          `Cannot evaluate on this tab: ${why}. Close DevTools on it and retry.`
        );
      }
      const value = await cdp.evaluate(id, script);
      return { result: value };
    }

    case "snapshot":
    case "scroll":
    case "wait":
    case "get_text":
    case "get_html":
    case "find":
    case "highlight":
    case "file_upload":
    case "get_bounding_box":
    case "is_visible":
    case "dialog_policy":
    case "overlay":
    case "resolve_target":
    case "element_state":
    case "select_option_native":
    case "find_option":
    case "dialogs": {
      const id = await resolveTabId(tabIdParam);
      await assertScriptable(id);
      await injectMainHooks(id);
      const result = await safeDom(id, method, params);
      if (method === "snapshot") {
        const snap = result as { text: string; url: string; title: string };
        return typeof snap === "string" ? snap : snap.text;
      }
      return result;
    }

    case "console": {
      const id = await resolveTabId(tabIdParam);
      await injectMainHooks(id);
      await ensureContentScript(id);
      const response = await chrome.tabs.sendMessage(id, {
        type: "deeporax-browser-mcp-console",
        pattern: params.pattern,
        level: params.level,
        limit: params.limit,
        clear: params.clear,
      });
      if (!response?.ok) throw new Error(response?.error || "console failed");
      return response.result;
    }

    case "network": {
      const id = await resolveTabId(tabIdParam);
      // Prefer debugger-captured requests; fall back to content-script buffer
      let requests: NetReq[] = networkByTab.get(id)?.slice() ?? [];
      if (params.attach !== false) {
        try {
          await attachDebugger(id);
        } catch {
          /* optional */
        }
      }
      if (params.clear) {
        networkByTab.set(id, []);
        requests = [];
      }
      if (params.pattern) {
        try {
          const re = new RegExp(String(params.pattern), "i");
          requests = requests.filter((r) => re.test(r.url));
        } catch {
          const p = String(params.pattern).toLowerCase();
          requests = requests.filter((r) => r.url.toLowerCase().includes(p));
        }
      }
      const limit = Math.min(Number(params.limit ?? 100), 500);
      // Also merge content-script observations
      try {
        await ensureContentScript(id);
        const response = await chrome.tabs.sendMessage(id, {
          type: "deeporax-browser-mcp-network",
          pattern: params.pattern,
          typeFilter: params.resourceType,
          limit,
          clear: params.clear,
        });
        if (response?.ok && response.result?.requests) {
          const extra = response.result.requests as NetReq[];
          const seen = new Set(requests.map((r) => r.id));
          for (const e of extra) {
            if (!seen.has(e.id)) requests.push(e);
          }
        }
      } catch {
        /* content script optional */
      }
      requests.sort((a, b) => a.ts - b.ts);
      return { requests: requests.slice(-limit), debuggerAttached: debuggerAttached.has(id) };
    }

    case "resize": {
      const tab = await getTab(tabIdParam);
      const width = Number(params.width);
      const height = Number(params.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        throw new Error("width and height are required");
      }
      await chrome.windows.update(tab.windowId, {
        width: Math.round(width),
        height: Math.round(height),
      });
      return { ok: true, width, height, windowId: tab.windowId };
    }

    case "batch": {
      const actions = (params.actions as Array<{ method: string; params?: Record<string, unknown> }>) || [];
      if (!actions.length) throw new Error("actions[] required");
      if (actions.length > 25) throw new Error("batch limited to 25 actions");
      const results: unknown[] = [];
      for (const action of actions) {
        if (!action?.method) throw new Error("each action needs method");
        if (action.method === "batch") throw new Error("nested batch not allowed");
        const result = await handleMethod({
          id: req.id + "_sub",
          method: action.method,
          params: { ...action.params, tabId: action.params?.tabId ?? tabIdParam },
        });
        results.push({ method: action.method, result });
      }
      return { results };
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function injectMainHooks(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (src: string) => {
        // eslint-disable-next-line no-new-func
        new Function(src)();
      },
      args: [MAIN_WORLD_HOOKS],
    });
  } catch {
    /* chrome:// pages etc. */
  }
}

async function attachDebugger(tabId: number): Promise<void> {
  if (debuggerAttached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  debuggerAttached.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  // detach cleanup on tab close handled below
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !params) return;
  if (method === "Network.requestWillBeSent") {
    const p = params as {
      requestId: string;
      request: { url: string; method: string };
      type?: string;
    };
    pushNet(tabId, {
      id: p.requestId,
      method: p.request.method,
      url: p.request.url,
      type: p.type,
      ts: Date.now(),
    });
  } else if (method === "Network.responseReceived") {
    const p = params as {
      requestId: string;
      response: { status: number; url: string };
      type?: string;
    };
    const list = networkByTab.get(tabId);
    const hit = list?.find((r) => r.id === p.requestId);
    if (hit) {
      hit.status = p.response.status;
      hit.type = p.type || hit.type;
    } else {
      pushNet(tabId, {
        id: p.requestId,
        method: "GET",
        url: p.response.url,
        status: p.response.status,
        type: p.type,
        ts: Date.now(),
      });
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) debuggerAttached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  networkByTab.delete(tabId);
  if (debuggerAttached.has(tabId)) {
    debuggerAttached.delete(tabId);
    try {
      void chrome.debugger.detach({ tabId });
    } catch {
      /* ignore */
    }
  }
});

// --- Lifecycle / keepalive --------------------------------------------------

function init() {
  connect();

  // Keep the service worker alive while we want a stable WS.
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      connect();
    }
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "get-status") {
    sendResponse({
      status: lastStatus,
      port: PORT,
      url: bridgeUrl(),
    });
    return true;
  }
  if (msg?.type === "reconnect") {
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
    connect();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "inject-main-hooks") {
    const tabId = _sender.tab?.id;
    if (tabId != null) {
      void injectMainHooks(tabId).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }
  return false;
});

// The interaction layer resolves elements through the content script, since
// that is the world holding the snapshot ref map.
interact.useDomChannel((tabId, method, params) => safeDom(tabId, method, params));

// Start immediately when SW loads
init();
