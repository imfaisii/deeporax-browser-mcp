import {
  handleDomMethodAsync,
  installPageHandler,
} from "./dom-actions";
import {
  clearConsole,
  clearNetwork,
  listConsole,
  listNetwork,
  MAIN_WORLD_HOOKS,
  pushConsole,
  pushNetwork,
  type ConsoleEntry,
} from "./page-hooks";

installPageHandler();

// Capture MAIN-world console events
window.addEventListener("__deeporax_console", ((ev: Event) => {
  const detail = (ev as CustomEvent).detail as ConsoleEntry;
  if (detail) pushConsole(detail);
}) as EventListener);

// Observe fetch/XHR in the isolated world for same-origin requests we initiate;
// for page traffic we also attach a performance observer for resource timing.
try {
  const po = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType !== "resource") continue;
      const re = entry as PerformanceResourceTiming;
      pushNetwork({
        id: `perf_${Math.round(re.startTime)}_${re.name.slice(-24)}`,
        method: "GET",
        url: re.name,
        status: undefined,
        type: re.initiatorType,
        ts: Date.now(),
      });
    }
  });
  po.observe({ type: "resource", buffered: true });
} catch {
  /* PerformanceObserver may be unavailable */
}

// Patch isolated-world fetch as a best-effort for content-script traffic
const origFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const id = `fetch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const res = await origFetch(input, init);
    pushNetwork({
      id,
      method,
      url,
      status: res.status,
      type: "fetch",
      ts: Date.now(),
    });
    return res;
  } catch (err) {
    pushNetwork({
      id,
      method,
      url,
      status: 0,
      type: "fetch",
      ts: Date.now(),
    });
    throw err;
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "deeporax-browser-mcp-ping") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "deeporax-browser-mcp-console") {
    if (message.clear) clearConsole();
    // Merge MAIN-world buffer if present
    try {
      const mainBuf = (
        window as unknown as { __deeporaxConsole?: ConsoleEntry[] }
      ).__deeporaxConsole;
      if (Array.isArray(mainBuf)) {
        for (const e of mainBuf) pushConsole(e);
        if (message.clear) {
          (window as unknown as { __deeporaxConsole?: ConsoleEntry[] }).__deeporaxConsole = [];
        }
      }
    } catch {
      /* ignore */
    }
    sendResponse({
      ok: true,
      result: {
        messages: listConsole({
          pattern: message.pattern,
          level: message.level,
          limit: message.limit,
        }),
      },
    });
    return false;
  }

  if (message.type === "deeporax-browser-mcp-network") {
    if (message.clear) clearNetwork();
    sendResponse({
      ok: true,
      result: {
        requests: listNetwork({
          pattern: message.pattern,
          type: message.typeFilter,
          limit: message.limit,
        }),
      },
    });
    return false;
  }

  if (message.type !== "deeporax-browser-mcp-dom") return false;

  const { method, params } = message as {
    method: string;
    params?: Record<string, unknown>;
  };

  handleDomMethodAsync(method, params ?? {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err: unknown) =>
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    );

  return true; // async response
});

// Ask background to inject MAIN-world hooks (content scripts can't easily do MAIN)
void chrome.runtime.sendMessage({ type: "inject-main-hooks" }).catch(() => {
  /* background may not be ready yet */
});

console.debug("[deeporax] content script ready", location.href);

// silence unused import warning if bundler is picky
void pushNetwork;
void MAIN_WORLD_HOOKS;
