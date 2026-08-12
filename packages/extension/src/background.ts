import { DEFAULT_PORT, PROTOCOL_VERSION, isRequest, type BridgeRequest, type BridgeResponse } from "./protocol";
import { MAIN_WORLD_HOOKS } from "./page-hooks";
import * as cdp from "./cdp";
import * as interact from "./interact";
import {
  nextNav,
  pageDelta,
  readPage,
  refsAfterNav,
} from "./action-result";
import {
  clearLastAction,
  coachNoteForObserve,
  rememberAction,
} from "./last-action";

const PORT = DEFAULT_PORT;
const RECONNECT_MS = 2000;
const ALARM_NAME = "deeporax-browser-mcp-keepalive";

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastStatus: "connected" | "disconnected" | "connecting" = "disconnected";

/** Tabs where we have turned CDP network capture on. */
const netEnabled = new Set<number>();
/** Tabs where Fetch intercept is enabled for heavy-asset blocking. */
const fetchBlockedTabs = new Set<number>();
/**
 * When on, agent tabs skip Image / Media / Font bodies so pages paint the DOM
 * faster. HTML, scripts, XHR, and documents still load so snapshots keep working.
 * On by default; user can turn it off in the popup. Persisted in storage.
 */
let blockHeavyAssets = true;
const HEAVY_RESOURCE_TYPES = ["Image", "Media", "Font"] as const;
const INSTALL_WELCOME_URL = "https://store.deeporax.com/browser-mcp";

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
 * Per MCP-process session state. Each chat host spawns its own server with a
 * unique sessionId (pid-based). Without this, two chats share one currentTab
 * and one group and steal each other's work.
 */
type AgentSession = {
  currentTabId: number | null;
  groupId: number | null;
  title: string;
  color: "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";
  lastUsed: number;
};

const SESSION_GROUP_COLORS = [
  "green",
  "blue",
  "cyan",
  "purple",
  "orange",
  "pink",
  "yellow",
  "red",
] as const;
const GROUP_TITLE_MAX = 28;
const sessions = new Map<string, AgentSession>();
/** Request currently being handled — set once per bridge call. */
let activeSessionId = "default";

function sessionOf(sessionId?: string): AgentSession {
  const id =
    typeof sessionId === "string" && sessionId.trim()
      ? sessionId.trim()
      : activeSessionId || "default";
  activeSessionId = id;
  let s = sessions.get(id);
  if (!s) {
    // Stable color per session id so two chats stay visually distinct.
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    s = {
      currentTabId: null,
      groupId: null,
      title: "Deeporax",
      color: SESSION_GROUP_COLORS[hash % SESSION_GROUP_COLORS.length]!,
      lastUsed: Date.now(),
    };
    sessions.set(id, s);
  }
  s.lastUsed = Date.now();
  return s;
}

function rememberTab(tabId: number, sessionId?: string): number {
  const s = sessionOf(sessionId);
  s.currentTabId = tabId;
  return tabId;
}

/** Clip a group title so it fits the tab strip. */
function clipGroupTitle(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return "Deeporax";
  if (t.length <= GROUP_TITLE_MAX) return t;
  return t.slice(0, GROUP_TITLE_MAX - 1).trimEnd() + "…";
}

/**
 * Short human topic for the tab strip. Prefer an agent-supplied label; otherwise
 * derive one from the URL (host + what kind of page).
 */
function topicFromUrl(url: string, explicit?: string): string {
  if (explicit && explicit.trim()) return clipGroupTitle(explicit);

  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const segs = u.pathname.split("/").filter(Boolean);
    const first = segs[0] ?? "";
    const second = segs[1] ?? "";

    if (host === "x.com" || host === "twitter.com") {
      if (first === "i" && second === "status") return "X · post";
      if (segs.includes("status")) return "X · post";
      if (first === "compose" || first === "home" || !first)
        return first === "compose" ? "X · compose" : "X · home";
      if (first === "search") return "X · search";
      if (first === "messages" || first === "i")
        return clipGroupTitle(`X · ${second || first}`);
      return clipGroupTitle(`X · ${first}`);
    }
    if (host.endsWith("google.com") && first === "aw") {
      return "Google Ads";
    }
    if (host.includes("ads.google")) return "Google Ads";
    if (host === "github.com") {
      if (segs.length >= 2)
        return clipGroupTitle(`GitHub · ${segs[0]}/${segs[1]}`);
      return first ? clipGroupTitle(`GitHub · ${first}`) : "GitHub";
    }
    if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const port = u.port ? `:${u.port}` : "";
      return clipGroupTitle(
        first ? `local${port} · ${first}` : `local${port || host}`
      );
    }

    if (!first) return clipGroupTitle(host);
    // Skip noisy ids in the label when the next segment is a long token.
    if (second && second.length > 18) return clipGroupTitle(`${host} · ${first}`);
    if (second) return clipGroupTitle(`${host} · ${first}/${second}`);
    return clipGroupTitle(`${host} · ${first}`);
  } catch {
    return "Deeporax";
  }
}

/** Live tab id for THIS session's group only. Never another chat's group. */
async function findSessionGroupTab(
  sessionId?: string
): Promise<number | null> {
  const groupId = await resolveSessionGroupId(sessionId);
  if (groupId == null) return null;
  try {
    const tabs = await chrome.tabs.query({ groupId });
    if (!tabs.length) return null;
    const active = tabs.find((t) => t.active && t.id != null);
    if (active?.id != null) return active.id;
    const sorted = [...tabs].sort(
      (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
    );
    return sorted[0]?.id ?? null;
  } catch {
    const s = sessionOf(sessionId);
    s.groupId = null;
    return null;
  }
}

async function resolveSessionGroupId(
  sessionId?: string
): Promise<number | null> {
  const s = sessionOf(sessionId);
  if (s.groupId != null) {
    try {
      const g = await chrome.tabGroups.get(s.groupId);
      if (g.title) s.title = g.title;
      return s.groupId;
    } catch {
      s.groupId = null;
    }
  }
  return null;
}

/**
 * Put a tab in THIS chat's group. Creates a new group on first use — never
 * joins another session's group, even if titles match. Failures are ignored:
 * isolation is best-effort, never a reason to block navigation.
 */
async function placeInSessionGroup(
  tabId: number,
  topic?: string,
  sessionId?: string
): Promise<number | null> {
  try {
    const s = sessionOf(sessionId);
    if (topic) s.title = clipGroupTitle(topic);
    const title = s.title;
    const color = s.color;

    const tab = await chrome.tabs.get(tabId);

    if (s.groupId != null) {
      try {
        const g = await chrome.tabGroups.get(s.groupId);
        if (g.windowId === tab.windowId) {
          await chrome.tabs.group({ tabIds: tabId, groupId: s.groupId });
          if (g.title !== title || g.color !== color) {
            await chrome.tabGroups.update(s.groupId, {
              title,
              color,
              collapsed: false,
            });
          } else {
            await chrome.tabGroups.update(s.groupId, { collapsed: false });
          }
          return s.groupId;
        }
      } catch {
        s.groupId = null;
      }
    }

    // Always create a fresh group for a new session. Reusing by title/color
    // is what made chat B inherit chat A's tabs.
    const groupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(groupId, {
      title,
      color,
      collapsed: false,
    });
    s.groupId = groupId;
    return groupId;
  } catch {
    return null;
  }
}

async function resolveTabId(
  tabId?: number,
  sessionId?: string
): Promise<number> {
  const s = sessionOf(sessionId);

  // Explicit ids must still be live. Remembering a dead id is what made
  // agents retry the same "No tab with id" for minutes.
  if (typeof tabId === "number") {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.id != null) return rememberTab(tab.id, sessionId);
    } catch {
      if (s.currentTabId === tabId) s.currentTabId = null;
      throw new Error(
        `No tab with id ${tabId}. It was closed or never existed. ` +
          "Call browser_tabs action=list and use a fresh id, or omit tabId " +
          "and browser_navigate (newTab) to start this session's own tab. " +
          "Do not retry the same id."
      );
    }
  }

  if (s.currentTabId != null) {
    try {
      const tab = await chrome.tabs.get(s.currentTabId);
      if (tab?.id != null) return tab.id;
    } catch {
      s.currentTabId = null;
    }
  }

  // Only tabs already claimed by THIS session. Never the last-focused window
  // or another chat's group — that is how session B stole session A's work.
  const grouped = await findSessionGroupTab(sessionId);
  if (grouped != null) return rememberTab(grouped, sessionId);

  throw new Error(
    "No tab for this chat session yet. Call browser_navigate with newTab:true " +
      "(or browser_tabs action=new) to open one in this session's group. " +
      "Other chats keep their own tabs."
  );
}

/** Restricted pages cannot be scripted; say so once, in one place. */
async function assertScriptable(tabId: number): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    for (const s of sessions.values()) {
      if (s.currentTabId === tabId) s.currentTabId = null;
    }
    throw new Error(
      `No tab with id ${tabId}. It was closed or never existed. ` +
        "Call browser_tabs action=list and use a fresh id, or omit tabId."
    );
  }
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

async function getTab(
  tabId?: number,
  sessionId?: string
): Promise<chrome.tabs.Tab> {
  const id = await resolveTabId(tabId, sessionId);
  try {
    return await chrome.tabs.get(id);
  } catch {
    const s = sessionOf(sessionId);
    if (s.currentTabId === id) s.currentTabId = null;
    throw new Error(
      `No tab with id ${id}. It was closed or never existed. ` +
        "Call browser_tabs action=list and use a fresh id, or omit tabId."
    );
  }
}

/**
 * Wait until the tab reports complete, or until the budget runs out.
 * Resolves either way so navigate can return the actual URL instead of
 * burning a full bridge timeout on a hung load.
 */
function waitForTabComplete(
  tabId: number,
  timeoutMs = 15_000
): Promise<{ timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          clearInterval(timer);
          // small settle delay for client-side routers
          setTimeout(() => resolve({ timedOut: false }), 150);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve({ timedOut: true });
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
    if (
      /stale|Unknown or stale|since removed|No element matches|not a <select>|not a text field|zero size|is disabled|read-only|Provide either/i.test(
        a
      )
    ) {
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
  const sid =
    typeof params.sessionId === "string" && params.sessionId.trim()
      ? params.sessionId.trim()
      : "default";
  const sess = sessionOf(sid);

  switch (method) {
    // Lets a developer pick up a rebuilt extension without visiting
    // chrome://extensions. The socket drops and reconnects on its own.
    case "reload_extension": {
      setTimeout(() => chrome.runtime.reload(), 50);
      return { ok: true, reloading: true, version: chrome.runtime.getManifest().version };
    }

    case "active_tab": {
      // Prefer this session's tab. If the session has none yet, say so instead
      // of silently reporting another chat's (or the focused) tab.
      let tab: chrome.tabs.Tab;
      try {
        tab = await getTab(tabIdParam, sid);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/No tab for this chat session/i.test(msg)) {
          return {
            id: null,
            url: null,
            title: null,
            sessionId: sid,
            sessionGroupId: sess.groupId,
            sessionGroupTitle: sess.title,
            sessionColor: sess.color,
            message: msg,
          };
        }
        throw err;
      }
      const groupId = await resolveSessionGroupId(sid);
      return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        status: tab.status,
        windowId: tab.windowId,
        active: tab.active,
        groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
        sessionId: sid,
        sessionGroupId: groupId,
        sessionGroupTitle: sess.title,
        sessionColor: sess.color,
        blockHeavyAssets,
      };
    }

    case "navigate": {
      const url = String(params.url);
      const label =
        typeof params.groupLabel === "string"
          ? params.groupLabel
          : typeof params.topic === "string"
            ? params.topic
            : undefined;
      const topic = topicFromUrl(url, label);
      // New session with no tab yet always opens a tab; otherwise navigate
      // would throw "No tab for this chat session" and force an extra round-trip.
      const forceNew =
        Boolean(params.newTab) ||
        (tabIdParam == null &&
          sess.currentTabId == null &&
          sess.groupId == null);
      if (forceNew) {
        const opened = await openTabForSession(url, sid, topic);
        const load = await waitForTabComplete(opened.tabId);
        const fresh = await chrome.tabs.get(opened.tabId);
        // Prefer the post-load URL for the strip when the agent did not name it.
        let groupId = opened.groupId;
        if (!label && fresh.url) {
          groupId = await placeInSessionGroup(
            opened.tabId,
            topicFromUrl(fresh.url),
            sid
          );
        }
        clearLastAction(opened.tabId);
        const navResult = {
          ok: true,
          verified: true,
          trusted: true,
          action: "navigate",
          tabId: opened.tabId,
          url: fresh.url,
          title: fresh.title,
          groupId,
          groupTitle: sess.title,
          sessionId: sid,
          openedNewTab: true,
          loadTimedOut: load.timedOut,
          blockHeavyAssets,
          page: {
            url: fresh.url ?? "",
            title: fresh.title ?? "",
            urlChanged: true,
          },
          refs: refsAfterNav(),
          next: nextNav({ navigated: true, loadTimedOut: load.timedOut }),
        };
        rememberAction(opened.tabId, navResult);
        return navResult;
      }
      const id = await resolveTabId(tabIdParam, sid);
      const pageBefore = await readPage(id);
      // Arm before navigation so the first image wave is already intercepted.
      if (blockHeavyAssets) await applyAssetBlocking(id);
      // Never steal the user's focused tab; agent work runs in the session group.
      await chrome.tabs.update(id, { url });
      rememberTab(id, sid);
      let groupId = await placeInSessionGroup(id, topic, sid);
      const load = await waitForTabComplete(id);
      const tab = await chrome.tabs.get(id);
      if (!label && tab.url) {
        groupId = await placeInSessionGroup(id, topicFromUrl(tab.url), sid);
      }
      // SPAs and redirects often leave the requested URL off the final
      // location. Surface both so the agent can stop retrying a "success"
      // that never left the previous page.
      const navigated =
        Boolean(tab.url) &&
        (tab.url === url ||
          tab.url!.startsWith(url) ||
          url.startsWith(tab.url!.split("#")[0]!));
      clearLastAction(id);
      const page = pageDelta(pageBefore, {
        url: tab.url ?? "",
        title: tab.title ?? "",
      });
      const navResult = {
        ok: true,
        verified: navigated,
        trusted: true,
        action: "navigate",
        tabId: id,
        url: tab.url,
        title: tab.title,
        requestedUrl: url,
        navigated,
        groupId,
        groupTitle: sess.title,
        sessionId: sid,
        loadTimedOut: load.timedOut,
        blockHeavyAssets,
        page,
        refs: refsAfterNav(),
        next: nextNav({ navigated, loadTimedOut: load.timedOut }),
      };
      rememberAction(id, navResult);
      return navResult;
    }

    case "back":
    case "forward":
    case "reload": {
      const id = await resolveTabId(tabIdParam, sid);
      const pageBefore = await readPage(id);
      if (method === "back") await chrome.tabs.goBack(id);
      else if (method === "forward") await chrome.tabs.goForward(id);
      else await chrome.tabs.reload(id, { bypassCache: Boolean(params.hard) });
      const load = await waitForTabComplete(id);
      const page = pageDelta(pageBefore, await readPage(id));
      clearLastAction(id);
      const navResult = {
        ok: true,
        verified: true,
        trusted: true,
        action: method,
        tabId: id,
        sessionId: sid,
        loadTimedOut: load.timedOut,
        page,
        refs: refsAfterNav(),
        next: nextNav({ navigated: true, loadTimedOut: load.timedOut }),
      };
      rememberAction(id, navResult);
      return navResult;
    }

    case "tabs": {
      const action = String(params.action);
      if (action === "list") {
        // Default to this session's tabs so a second chat cannot "see" and
        // then operate on the first chat's work. Pass sessionOnly:false for all.
        const sessionOnly = params.sessionOnly !== false;
        const groupId = await resolveSessionGroupId(sid);
        const tabs =
          sessionOnly && groupId != null
            ? await chrome.tabs.query({ groupId })
            : sessionOnly
              ? []
              : await chrome.tabs.query({});
        return tabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          windowId: t.windowId,
          groupId: typeof t.groupId === "number" ? t.groupId : -1,
          inSessionGroup: groupId != null && t.groupId === groupId,
          sessionGroupId: groupId,
          sessionId: sid,
        }));
      }
      if (action === "new") {
        const openUrl = (params.url as string) || "about:blank";
        const label =
          typeof params.groupLabel === "string"
            ? params.groupLabel
            : typeof params.topic === "string"
              ? params.topic
              : undefined;
        const opened = await openTabForSession(
          openUrl,
          sid,
          topicFromUrl(openUrl, label)
        );
        const tab = await chrome.tabs.get(opened.tabId);
        return {
          id: opened.tabId,
          url: tab.url,
          groupId: opened.groupId,
          groupTitle: sess.title,
          sessionId: sid,
          blockHeavyAssets,
        };
      }
      if (action === "close") {
        const id = await resolveTabId(tabIdParam, sid);
        await chrome.tabs.remove(id);
        if (sess.currentTabId === id) sess.currentTabId = null;
        return { ok: true, closed: id, sessionId: sid };
      }
      if (action === "select") {
        // Session bookkeeping only. Do not activate the tab or focus the
        // window — that would yank the user off whatever they are doing.
        const id = await resolveTabId(tabIdParam, sid);
        const tab = await chrome.tabs.get(id);
        rememberTab(id, sid);
        await placeInSessionGroup(
          id,
          topicFromUrl(tab.url || "about:blank"),
          sid
        );
        return {
          ok: true,
          tabId: id,
          groupTitle: sess.title,
          sessionId: sid,
          activated: false,
          note: "Session current tab updated without focusing the browser. Agent work stays in the background group.",
        };
      }
      throw new Error(`Unknown tabs action: ${action}`);
    }

    case "screenshot": {
      const id = await resolveTabId(tabIdParam, sid);
      const tab = await assertScriptable(id);

      // Page.captureScreenshot works on a background tab and can shoot the
      // full page. captureVisibleTab needs an activeTab grant we do not have,
      // which is what made this fail outright.
      if (await cdp.attach(id)) {
        // Our own overlay is real DOM, so it would otherwise appear in the
        // capture and the agent would spend tokens describing its own UI.
        await safeDom(id, "overlay", { action: "hide_for_capture" }).catch(() => {});
        try {
          const shot = await cdp.captureScreenshot(id, {
            fullPage: Boolean(params.fullPage),
            format: params.format === "png" ? "png" : "jpeg",
            quality: typeof params.quality === "number" ? params.quality : undefined,
          });
          const coach = coachNoteForObserve(id, "screenshot");
          const notes = [
            shot.degraded
              ? `Compressed to quality ${shot.quality?.toFixed(2)} to stay within a readable size. Pass format:"png" if you need exact pixels.`
              : "",
            coach ?? "",
          ].filter(Boolean);
          return {
            data: shot.data,
            mimeType: shot.format === "png" ? "image/png" : "image/jpeg",
            url: tab.url,
            title: tab.title,
            ...(notes.length ? { note: notes.join(" ") } : {}),
          };
        } finally {
          await safeDom(id, "overlay", { action: "restore_after_capture" }).catch(() => {});
        }
      }

      // captureVisibleTab needs the tab to be the visible one in its window.
      // Activating it would steal focus from the user, so only use that path
      // when the agent tab is already active. Prefer CDP (works in background).
      if (tab.active) {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: "png",
          });
          const coach = coachNoteForObserve(id, "screenshot");
          return {
            data: dataUrl.replace(/^data:image\/png;base64,/, ""),
            mimeType: "image/png",
            url: tab.url,
            title: tab.title,
            ...(coach ? { note: coach } : {}),
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
      const why = cdp.unavailableReason(id);
      throw new Error(
        "Screenshot needs the debugger on a background agent tab so your focused tab is not stolen." +
          (why ? ` Debugger attach failed: ${why}.` : "") +
          " Close DevTools on the agent tab if it is open, then retry."
      );
    }

    // Pointer and keyboard actions go through the debugger so the page sees
    // isTrusted events. Component libraries drop synthetic ones.
    case "click":
    case "click_xy":
    case "type":
    case "clear":
    case "press_key":
    case "hover":
    case "drag":
    case "select_option":
    case "fill_form": {
      const id = await resolveTabId(tabIdParam, sid);
      await assertScriptable(id);
      await injectMainHooks(id);

      let outcome: unknown;
      if (!(await cdp.attach(id))) {
        // DevTools is open on the tab, or another debugger owns it. Do the
        // action from the isolated world instead of refusing outright, and say
        // in the result that the events were not trusted.
        outcome = await syntheticFallback(
          id,
          method,
          params,
          cdp.unavailableReason(id)
        );
      } else {
        switch (method) {
          case "click":
            outcome = await interact.click(id, params);
            break;
          case "click_xy":
            outcome = await interact.clickAtPoint(id, params);
            break;
          case "type":
            outcome = await interact.type(id, params);
            break;
          case "clear":
            outcome = await interact.clear(id, params);
            break;
          case "press_key":
            outcome = await interact.pressKey(id, params);
            break;
          case "hover":
            outcome = await interact.hover(id, params);
            break;
          case "drag":
            outcome = await interact.drag(id, params);
            break;
          case "select_option":
            outcome = await interact.selectOption(id, params);
            break;
          case "fill_form":
            outcome = await interact.fillForm(id, params);
            break;
          default:
            throw new Error(`Unhandled interaction: ${method}`);
        }
      }
      if (outcome && typeof outcome === "object") {
        rememberAction(id, outcome as Record<string, unknown>);
      }
      return outcome;
    }

    // Real page evaluation. MV3 forbids new Function inside the extension,
    // so this has to run out of process through the debugger.
    case "evaluate": {
      const id = await resolveTabId(tabIdParam, sid);
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
    case "list_matches":
    case "highlight":
    case "file_upload":
    case "get_bounding_box":
    case "is_visible":
    case "dialog_policy":
    case "overlay":
    case "resolve_target":
    case "element_state":
    case "field_probe":
    case "field_select_all":
    case "field_caret_end":
    case "field_force_set":
    case "select_option_native":
    case "find_option":
    case "dialogs": {
      const id = await resolveTabId(tabIdParam, sid);
      await assertScriptable(id);
      await injectMainHooks(id);
      const result = await safeDom(id, method, params);
      if (method === "snapshot") {
        const snap = result as {
          text?: string;
          url?: string;
          title?: string;
          patterns?: unknown;
          refGeneration?: number;
        };
        // Keep the readable tree as the main payload (agents parse text),
        // and attach structured patterns for bulk tools without a second pass.
        if (typeof snap === "string") {
          const coach = coachNoteForObserve(id, "snapshot");
          return coach ? `${snap}\n\n---\n${coach}` : snap;
        }
        const coach = coachNoteForObserve(id, "snapshot");
        return {
          text: snap.text,
          url: snap.url,
          title: snap.title,
          patterns: snap.patterns ?? [],
          refGeneration: snap.refGeneration,
          ...(coach ? { note: coach } : {}),
        };
      }
      return result;
    }

    /**
     * One-shot bulk action on every element matching a text/role pattern.
     * Use this instead of N separate clicks + snapshots when the UI repeats
     * (Reply, Follow, checkbox rows, identical buttons, …).
     */
    case "act_matches": {
      const id = await resolveTabId(tabIdParam, sid);
      await assertScriptable(id);
      await injectMainHooks(id);
      // Fresh refs so matches stay valid for the bulk pass.
      await safeDom(id, "snapshot", {
        interestingOnly: params.interestingOnly !== false,
        maxElements: params.maxElements ?? 400,
      });
      const found = (await safeDom(id, "find", {
        query: params.query,
        regex: params.regex,
        caseSensitive: params.caseSensitive,
        role: params.role,
        exactName: params.exactName !== false,
        limit: params.limit ?? 50,
      })) as {
        query: string;
        count: number;
        matches: Array<{ ref?: string; role: string; name: string; text: string }>;
      };
      const action = String(params.action ?? "click").toLowerCase();
      if (!["click", "hover", "type"].includes(action)) {
        throw new Error('action must be "click", "hover", or "type"');
      }
      if (action === "type" && params.text == null && params.value == null) {
        throw new Error('action "type" requires text (or value)');
      }
      const max = Math.min(
        Math.max(1, Number(params.limit ?? 30)),
        50
      );
      const matches = (found.matches || []).slice(0, max);
      const stopOnError = params.stopOnError === true;
      const results: Array<Record<string, unknown>> = [];
      let succeeded = 0;
      let failed = 0;
      const pageBefore = await readPage(id);

      const useTrusted = await cdp.attach(id);

      for (const m of matches) {
        if (!m.ref) {
          results.push({
            ok: false,
            verified: false,
            target: { name: m.name, role: m.role },
            error: "match has no ref",
          });
          failed += 1;
          if (stopOnError) break;
          continue;
        }
        try {
          let outcome: Record<string, unknown>;
          const p: Record<string, unknown> = {
            ref: m.ref,
            button: params.button,
            doubleClick: params.doubleClick,
            tripleClick: params.tripleClick,
            text: params.text ?? params.value,
            submit: params.submit,
            slowly: params.slowly,
            clear: params.clear !== false,
          };
          if (useTrusted) {
            if (action === "click") outcome = await interact.click(id, p);
            else if (action === "hover") outcome = await interact.hover(id, p);
            else outcome = await interact.type(id, p);
          } else {
            outcome = (await syntheticFallback(
              id,
              action === "type" ? "type" : action === "hover" ? "hover" : "click",
              p,
              cdp.unavailableReason(id)
            )) as Record<string, unknown>;
          }
          const stepOk = outcome.ok !== false;
          if (!stepOk) failed += 1;
          else succeeded += 1;
          results.push({
            ok: stepOk,
            verified: Boolean(outcome.verified ?? stepOk),
            action,
            target: {
              ref: m.ref,
              role: m.role,
              name: m.name,
            },
            before: outcome.before ?? null,
            after: outcome.after ?? outcome.value ?? null,
            warning: outcome.warning,
            // Keep nested result only on failure for debug; successes stay thin.
            ...(stepOk ? {} : { error: outcome.warning ?? "step failed" }),
          });
          // Small gap so React/lists can settle between identical controls.
          await new Promise((r) => setTimeout(r, Number(params.delayMs ?? 40)));
        } catch (err) {
          failed += 1;
          results.push({
            ok: false,
            verified: false,
            target: { ref: m.ref, role: m.role, name: m.name },
            error: err instanceof Error ? err.message : String(err),
          });
          if (stopOnError) break;
        }
      }

      const page = pageDelta(pageBefore, await readPage(id));
      const total = matches.length;
      const bulk = {
        ok: failed === 0,
        verified: failed === 0,
        trusted: useTrusted,
        action: "act_matches",
        query: found.query,
        matchCount: found.count,
        attempted: matches.length,
        count: { total, succeeded, failed },
        succeeded,
        failed,
        exactName: params.exactName !== false,
        results,
        page,
        refs: page.urlChanged
          ? refsAfterNav()
          : {
              valid: "unknown" as const,
              reason: "bulk actions finished; re-snapshot if next step needs fresh refs",
            },
        next:
          failed > 0
            ? {
                do: "fix" as const,
                skipScreenshot: true,
                skipFullSnapshot: true,
                reason: `${failed} of ${total} bulk actions failed. Fix from per-step rows; skip screenshot thrash.`,
                suggest: ["browser_snapshot"],
              }
            : {
                do: "continue" as const,
                skipScreenshot: true,
                skipFullSnapshot: !page.urlChanged,
                reason:
                  "Bulk actions finished. Skip screenshot; snapshot only if refs may be stale.",
              },
        tip:
          found.count > matches.length
            ? `Matched ${found.count}; acted on first ${matches.length}. Raise limit (max 50) to do more.`
            : undefined,
      };
      rememberAction(id, bulk);
      return bulk;
    }

    case "console": {
      const id = await resolveTabId(tabIdParam, sid);
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
      const id = await resolveTabId(tabIdParam, sid);
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
      return { requests: requests.slice(-limit), debuggerAttached: cdp.isAttached(id) };
    }

    case "resize": {
      const tab = await getTab(tabIdParam, sid);
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
      const tabForBatch =
        tabIdParam != null
          ? await resolveTabId(tabIdParam, sid).catch(() => null)
          : sess.currentTabId;
      const pageBefore =
        tabForBatch != null ? await readPage(tabForBatch) : { url: "", title: "" };
      const results: Array<Record<string, unknown>> = [];
      let failed = 0;
      for (const action of actions) {
        if (!action?.method) throw new Error("each action needs method");
        if (action.method === "batch") throw new Error("nested batch not allowed");
        try {
          const result = await handleMethod({
            id: req.id + "_sub",
            method: action.method,
            params: {
              ...action.params,
              tabId: action.params?.tabId ?? tabIdParam,
              sessionId: sid,
            },
          });
          const stepOk =
            typeof result === "object" &&
            result !== null &&
            "ok" in result
              ? (result as { ok: unknown }).ok !== false
              : true;
          if (!stepOk) failed += 1;
          // Thin rows: method + ok + key receipt fields when present.
          if (typeof result === "object" && result !== null) {
            const r = result as Record<string, unknown>;
            results.push({
              method: action.method,
              ok: stepOk,
              verified: r.verified,
              target: r.target,
              before: r.before ?? null,
              after: r.after ?? null,
              warning: r.warning,
              ...(stepOk ? {} : { error: r.warning ?? r.error }),
            });
          } else {
            results.push({ method: action.method, ok: true, result });
          }
        } catch (err) {
          failed += 1;
          results.push({
            method: action.method,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const endTab =
        tabIdParam != null
          ? await resolveTabId(tabIdParam, sid).catch(() => tabForBatch)
          : sess.currentTabId ?? tabForBatch;
      const page =
        endTab != null
          ? pageDelta(pageBefore, await readPage(endTab))
          : pageBefore;
      const total = actions.length;
      const bulk = {
        ok: failed === 0,
        verified: failed === 0,
        trusted: true,
        action: "batch",
        count: { total, succeeded: total - failed, failed },
        results,
        page,
        refs: page.urlChanged
          ? refsAfterNav()
          : {
              valid: "unknown" as const,
              reason: "batch finished; re-snapshot if next step needs fresh refs",
            },
        next:
          failed > 0
            ? {
                do: "fix" as const,
                skipScreenshot: true,
                skipFullSnapshot: true,
                reason: `${failed} of ${total} batch steps failed. Use per-step rows; skip screenshot thrash.`,
              }
            : {
                do: "continue" as const,
                skipScreenshot: true,
                skipFullSnapshot: !page.urlChanged,
                reason:
                  "Batch finished. Skip screenshot; snapshot only if refs may be stale.",
              },
      };
      if (endTab != null) rememberAction(endTab, bulk);
      return bulk;
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

/**
 * Run an interaction without the debugger, for tabs where it cannot attach.
 *
 * Everything here dispatches synthetic events, which carry isTrusted:false and
 * which component libraries are free to ignore. That is worth doing rather than
 * failing the call, but only if the caller is told, so every result says how
 * the input was delivered and the two cases that cannot work say so instead of
 * returning ok.
 */
async function syntheticFallback(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
  reason: string | undefined
): Promise<unknown> {
  const why = reason ?? "the debugger could not attach to this tab";
  const degraded = {
    trusted: false,
    reason: why,
    note:
      "Delivered as synthetic events because the debugger could not attach, usually " +
      "because DevTools is open on this tab. Pages built on component libraries may " +
      "ignore untrusted input. Close DevTools for real input.",
  };

  switch (method) {
    case "type":
    case "clear": {
      // Write through the native value setter, which frameworks notice, then
      // read the field back rather than assuming the value took.
      const before = (await safeDom(tabId, "field_probe", params)) as {
        value?: string;
        secret?: boolean;
      };
      const text = method === "clear" ? "" : String(params.text ?? "");
      const wanted =
        method === "type" && params.append ? String(before.value ?? "") + text : text;
      const redact = (v: string) =>
        before.secret ? `[redacted, ${v.length} chars]` : v;

      const set = (await safeDom(tabId, "field_force_set", { ...params, text: wanted })) as {
        value?: string;
      };
      const actual = String(set.value ?? "");
      const page = {
        url: (await chrome.tabs.get(tabId).catch(() => null))?.url ?? "",
        title: (await chrome.tabs.get(tabId).catch(() => null))?.title ?? "",
      };
      const target = {
        ref: typeof params.ref === "string" ? params.ref : undefined,
        selector: typeof params.selector === "string" ? params.selector : undefined,
      };
      if (actual !== wanted) {
        const warning =
          `Typing without the debugger did not take. ${degraded.note}`;
        return {
          ...degraded,
          ok: false,
          verified: false,
          action: method,
          target,
          before: redact(String(before.value ?? "")),
          after: redact(actual),
          value: redact(actual),
          changed: actual !== String(before.value ?? ""),
          page,
          refs: {
            valid: "unknown" as const,
            reason: "synthetic write path; refs not revalidated",
          },
          next: {
            do: "fix" as const,
            skipScreenshot: true,
            skipFullSnapshot: false,
            reason: warning,
            suggest: ["browser_snapshot", "browser_type"],
          },
          warning,
        };
      }
      if (params.submit) await safeDom(tabId, "press_key", { key: "Enter" });
      return {
        ...degraded,
        ok: true,
        verified: true,
        action: method,
        target,
        before: redact(String(before.value ?? "")),
        after: redact(actual),
        value: before.secret ? redact(actual) : actual,
        changed: actual !== String(before.value ?? ""),
        submitted: Boolean(params.submit),
        page,
        refs: {
          valid: true as const,
          reason: "same-document verified write; prior snapshot refs should still work",
        },
        next: {
          do: params.submit ? ("observe" as const) : ("continue" as const),
          skipScreenshot: true,
          skipFullSnapshot: !params.submit,
          reason: params.submit
            ? "Write verified (synthetic) and Enter pressed. Snapshot if DOM may have changed; skip screenshot for the value."
            : "Value verified (synthetic). Skip screenshot/full snapshot; continue.",
          ...(params.submit ? { suggest: ["browser_snapshot"] } : {}),
        },
      };
    }

    case "press_key": {
      const key = String(params.key ?? "");
      // A chord like Meta+a is a browser editing command, not something a DOM
      // event triggers. Dispatching one would do nothing while looking fine.
      if (key.length > 1 && key.includes("+")) {
        throw new Error(
          `Cannot press ${key} without the debugger: modifier chords are browser editing ` +
            `commands and a synthetic key event does not trigger them. ${degraded.note}`
        );
      }
      break;
    }
  }

  const result = (await safeDom(tabId, method, params)) as Record<string, unknown>;
  const page = {
    url: (await chrome.tabs.get(tabId).catch(() => null))?.url ?? "",
    title: (await chrome.tabs.get(tabId).catch(() => null))?.title ?? "",
  };
  const target = {
    ref: typeof params.ref === "string" ? params.ref : undefined,
    selector: typeof params.selector === "string" ? params.selector : undefined,
  };
  // Soft envelope so the outer agent still gets next/refs guidance on the
  // untrusted path (click/hover/press_key/drag/select/fill_form).
  return {
    ...result,
    ...degraded,
    ok: result.ok !== false,
    verified: false,
    action: method,
    target: result.target ?? target,
    page: result.page ?? page,
    refs: result.refs ?? {
      valid: "unknown" as const,
      reason: "synthetic path; refs not revalidated",
    },
    next: result.next ?? {
      do: "continue" as const,
      skipScreenshot: true,
      skipFullSnapshot: true,
      reason:
        `${method} ran without the debugger (untrusted events). Skip screenshot thrash; re-snapshot only if the next step needs refs.`,
    },
  };
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

// Network capture goes through the same session bookkeeping as input, so the
// two paths cannot fight over one tab's debugger.
async function attachDebugger(tabId: number): Promise<void> {
  if (netEnabled.has(tabId) && cdp.isAttached(tabId)) {
    await applyAssetBlocking(tabId);
    return;
  }
  if (!(await cdp.attach(tabId))) {
    throw new Error(cdp.unavailableReason(tabId) ?? "could not attach the debugger");
  }
  await cdp.send(tabId, "Network.enable");
  netEnabled.add(tabId);
  await applyAssetBlocking(tabId);
}

/**
 * Arm or disarm CDP Fetch blocking for Image / Media / Font on one tab.
 * No-ops when the debugger cannot attach (DevTools open, internal page, …).
 */
async function applyAssetBlocking(tabId: number): Promise<boolean> {
  if (!blockHeavyAssets) {
    if (fetchBlockedTabs.has(tabId) && cdp.isAttached(tabId)) {
      try {
        await cdp.send(tabId, "Fetch.disable");
      } catch {
        /* session already gone */
      }
    }
    fetchBlockedTabs.delete(tabId);
    return false;
  }
  if (!(await cdp.attach(tabId))) return false;
  try {
    await cdp.send(tabId, "Fetch.enable", {
      patterns: HEAVY_RESOURCE_TYPES.map((resourceType) => ({
        resourceType,
        requestStage: "Request",
      })),
      handleAuthRequests: false,
    });
    fetchBlockedTabs.add(tabId);
    return true;
  } catch {
    fetchBlockedTabs.delete(tabId);
    return false;
  }
}

/** Session tabs we currently know about (current + group members). */
async function sessionTabIds(): Promise<number[]> {
  const ids = new Set<number>();
  for (const s of sessions.values()) {
    if (s.currentTabId != null) ids.add(s.currentTabId);
    if (s.groupId != null) {
      try {
        const tabs = await chrome.tabs.query({ groupId: s.groupId });
        for (const t of tabs) if (t.id != null) ids.add(t.id);
      } catch {
        /* group gone */
      }
    }
  }
  return [...ids];
}

async function setBlockHeavyAssets(on: boolean): Promise<{
  blockHeavyAssets: boolean;
  tabsArmed: number;
}> {
  blockHeavyAssets = on;
  await chrome.storage.local.set({ blockHeavyAssets: on });
  let tabsArmed = 0;
  const ids = await sessionTabIds();
  if (on) {
    for (const id of ids) {
      if (await applyAssetBlocking(id)) tabsArmed += 1;
    }
  } else {
    for (const id of [...fetchBlockedTabs]) {
      await applyAssetBlocking(id);
    }
    tabsArmed = 0;
  }
  return { blockHeavyAssets, tabsArmed };
}

/**
 * Open a tab and, when heavy-asset blocking is on, attach Fetch before the
 * real navigation so the first image/font wave is already intercepted.
 */
async function openTabForSession(
  url: string,
  sid: string,
  topic?: string
): Promise<{ tabId: number; groupId: number | null }> {
  // Background tabs: keep the user's current tab focused while the agent works.
  if (blockHeavyAssets) {
    const blank = await chrome.tabs.create({
      url: "about:blank",
      active: false,
    });
    if (!blank.id) throw new Error("Failed to create tab");
    rememberTab(blank.id, sid);
    const groupId = await placeInSessionGroup(blank.id, topic, sid);
    await applyAssetBlocking(blank.id);
    await chrome.tabs.update(blank.id, { url });
    return { tabId: blank.id, groupId };
  }
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error("Failed to create tab");
  rememberTab(tab.id, sid);
  const groupId = await placeInSessionGroup(tab.id, topic, sid);
  return { tabId: tab.id, groupId };
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !params) return;
  if (method === "Fetch.requestPaused") {
    const p = params as { requestId: string };
    if (blockHeavyAssets && fetchBlockedTabs.has(tabId)) {
      void cdp
        .send(tabId, "Fetch.failRequest", {
          requestId: p.requestId,
          errorReason: "BlockedByClient",
        })
        .catch(() => {});
    } else {
      void cdp
        .send(tabId, "Fetch.continueRequest", { requestId: p.requestId })
        .catch(() => {});
    }
    return;
  }
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
  if (source.tabId != null) {
    netEnabled.delete(source.tabId);
    fetchBlockedTabs.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  networkByTab.delete(tabId);
  netEnabled.delete(tabId);
  fetchBlockedTabs.delete(tabId);
  for (const s of sessions.values()) {
    if (s.currentTabId === tabId) s.currentTabId = null;
  }
});

// Re-arm Fetch on agent tabs after a navigation starts (renderer swap drops it).
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!blockHeavyAssets) return;
  if (info.status !== "loading") return;
  let owned = false;
  for (const s of sessions.values()) {
    if (s.currentTabId === tabId) {
      owned = true;
      break;
    }
  }
  if (!owned) {
    // May still sit in a session group without being current.
    void (async () => {
      for (const s of sessions.values()) {
        if (s.groupId == null) continue;
        try {
          const tabs = await chrome.tabs.query({ groupId: s.groupId });
          if (tabs.some((t) => t.id === tabId)) {
            await applyAssetBlocking(tabId);
            return;
          }
        } catch {
          /* ignore */
        }
      }
    })();
    return;
  }
  void applyAssetBlocking(tabId);
});

// --- Lifecycle / keepalive --------------------------------------------------

async function loadSettings(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get({ blockHeavyAssets: true });
    blockHeavyAssets = stored.blockHeavyAssets !== false;
  } catch {
    blockHeavyAssets = true;
  }
}

function init() {
  void loadSettings();
  connect();

  // Keep the service worker alive while we want a stable WS.
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener((details) => {
  init();
  // First install only — not every reload or version bump.
  if (details.reason === "install") {
    void chrome.tabs.create({ url: INSTALL_WELCOME_URL, active: true });
  }
});
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
      blockHeavyAssets,
    });
    return true;
  }
  if (msg?.type === "set-block-heavy-assets") {
    void setBlockHeavyAssets(Boolean(msg.enabled)).then((result) =>
      sendResponse(result)
    );
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
