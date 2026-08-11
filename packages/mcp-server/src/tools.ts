import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridge } from "./bridge.js";
import { deleteArtifact, saveScreenshot, saveSnapshot, TMP_ROOT } from "./tmp-store.js";
import { extensionPath, loadExtensionHint } from "./paths.js";

type ContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function textResult(data: unknown) {
  const text =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

async function call(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number
) {
  return bridge.call(method, params, timeoutMs);
}

const tabId = z
  .number()
  .int()
  .optional()
  .describe(
    "Chrome tab id. Defaults to the tab this session last navigated to or acted on, " +
      "so a sequence of calls stays on one tab."
  );

const refOrSelector = {
  ref: z
    .string()
    .optional()
    .describe("Element ref from browser_snapshot, e.g. e3"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector (used if ref is not provided)"),
};

export function registerTools(server: McpServer): void {
  server.tool(
    "browser_status",
    "Check whether the Chrome extension is connected and report THIS chat's session tab (not another chat's). Each MCP process has its own sessionId, tab, and tab group.",
    {},
    async () => {
      try {
        const status = bridge.status;
        if (!status.connected) {
          return textResult({
            connected: false,
            extensionPath: extensionPath(),
            message: loadExtensionHint(),
            sessionId: bridge.sessionId,
          });
        }
        const tab = await call("active_tab");
        return textResult({
          ...status,
          connected: true,
          activeTab: tab,
          guidance:
            "This chat only owns tabs in its own group (sessionId on status). " +
            "Omit tabId to stay on this session's tab. If there is no session tab yet, " +
            "browser_navigate opens one. Never reuse another chat's tab id. " +
            "trusted:false means close DevTools before typing. " +
            "blockHeavyAssets on activeTab (extension popup) skips Image/Media/Font " +
            "so pages load faster while HTML/DOM stay available for snapshots.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_navigate",
    "Navigate the current (or specified) tab to a URL. Places the tab in the session tab group and renames that group to a short topic from the URL (or groupLabel). Returns the actual url plus navigated/loadTimedOut — if navigated is false, do not assume the page changed.",
    {
      url: z.string().url().describe("Absolute URL to open"),
      tabId,
      newTab: z
        .boolean()
        .optional()
        .describe(
          "If true, open the URL in a new tab inside the session tab group"
        ),
      groupLabel: z
        .string()
        .optional()
        .describe(
          "Optional short topic for the Chrome tab group, e.g. 'X replies' or 'Ads setup'. Defaults to a label derived from the URL."
        ),
    },
    async ({ url, tabId: id, newTab, groupLabel }) => {
      try {
        // Navigate can wait up to ~15s for load; give the bridge headroom.
        const result = await call(
          "navigate",
          { url, tabId: id, newTab, groupLabel },
          45_000
        );
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_back",
    "Go back in tab history.",
    { tabId },
    async ({ tabId: id }) => {
      try {
        return textResult(await call("back", { tabId: id }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_forward",
    "Go forward in tab history.",
    { tabId },
    async ({ tabId: id }) => {
      try {
        return textResult(await call("forward", { tabId: id }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_reload",
    "Reload the tab.",
    {
      tabId,
      hard: z.boolean().optional().describe("Bypass cache if true"),
    },
    async ({ tabId: id, hard }) => {
      try {
        return textResult(await call("reload", { tabId: id, hard }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_tabs",
    "List, create, close, or select tabs for THIS chat session. List defaults to sessionOnly (only this chat's group). New tabs join this session's group. Never reuse a tab id from another chat or after 'No tab with id'.",
    {
      action: z.enum(["list", "new", "close", "select"]),
      tabId: z.number().int().optional(),
      url: z.string().url().optional().describe("URL for action=new"),
      sessionOnly: z
        .boolean()
        .optional()
        .describe(
          "For action=list: default true (only this chat's tabs). Pass false to list every browser tab."
        ),
      groupLabel: z
        .string()
        .optional()
        .describe(
          "For action=new: optional short topic for this chat's Chrome tab group"
        ),
    },
    async ({ action, tabId: id, url, sessionOnly, groupLabel }) => {
      try {
        return textResult(
          await call("tabs", {
            action,
            tabId: id,
            url,
            sessionOnly,
            groupLabel,
          })
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_snapshot",
    "Capture an accessibility-style DOM snapshot with refs (e1, e2, …). Prefer this over screenshot for interaction. When the page has repeated controls, the snapshot lists REPEATED PATTERNS — use browser_act_matches once instead of N click+snapshot loops.",
    {
      tabId,
      maxElements: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Cap on elements listed (default 250). The snapshot says how many were left out."),
      interestingOnly: z
        .boolean()
        .optional()
        .describe("If true (default), only interactive/meaningful nodes"),
      persistOnly: z
        .boolean()
        .optional()
        .describe(
          "If true, return only the /tmp file path (not the full snapshot body). Default false."
        ),
    },
    async ({ tabId: id, interestingOnly, maxElements, persistOnly }) => {
      try {
        const result = await call("snapshot", {
          tabId: id,
          interestingOnly: interestingOnly ?? true,
          maxElements,
        });

        const text =
          typeof result === "string"
            ? result
            : typeof result === "object" &&
                result !== null &&
                "text" in result &&
                typeof (result as { text: unknown }).text === "string"
              ? (result as { text: string }).text
              : JSON.stringify(result, null, 2);

        const patterns =
          typeof result === "object" &&
          result !== null &&
          "patterns" in result &&
          Array.isArray((result as { patterns: unknown }).patterns)
            ? (result as { patterns: unknown[] }).patterns
            : [];

        let url: string | undefined;
        let title: string | undefined;
        try {
          const tab = (await call("active_tab", { tabId: id })) as {
            url?: string;
            title?: string;
          };
          url = tab.url;
          title = tab.title;
        } catch {
          /* optional metadata */
        }

        const saved = saveSnapshot(text, { url, title });

        if (persistOnly) {
          return textResult({
            path: saved.path,
            bytes: saved.bytes,
            tmpRoot: TMP_ROOT,
            patternCount: patterns.length,
            note: "Snapshot saved. Read the file, then call browser_clear_tmp or leave it (auto-pruned in 30m).",
          });
        }

        const patternHint =
          patterns.length > 0
            ? `\n\n---\npatterns: ${patterns.length} repeated control group(s). Prefer browser_act_matches for bulk click/type instead of one-by-one.`
            : "";

        return textResult(
          `${text}${patternHint}\n\n---\nsaved: ${saved.path} (${saved.bytes} bytes)\ntmp: ${TMP_ROOT} (auto-prune 30m / max 40 files)`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_screenshot",
    "Take a screenshot of the tab. PNG is saved under /tmp/deeporax-browser-mcp/screenshots (auto-pruned after 30m) and also returned as image content.",
    {
      tabId,
      format: z
        .enum(["jpeg", "png"])
        .optional()
        .describe("jpeg (default) is compressed to stay readable; png for exact pixels"),
      quality: z
        .number()
        .min(0.1)
        .max(1)
        .optional()
        .describe("JPEG quality 0.1-1, default 0.75. Lowered automatically if the image is too large."),
      fullPage: z
        .boolean()
        .optional()
        .describe("Capture the entire scrollable page rather than just the viewport."),
      persistOnly: z
        .boolean()
        .optional()
        .describe(
          "If true, return only the /tmp PNG path (no inline image). Default false."
        ),
    },
    async ({ tabId: id, persistOnly, fullPage, format, quality }) => {
      try {
        const result = (await call("screenshot", {
          tabId: id,
          fullPage,
          format,
          quality,
        })) as {
          data: string;
          mimeType?: string;
          url?: string;
          title?: string;
          note?: string;
        };
        const saved = saveScreenshot(result.data, {
          url: result.url,
          title: result.title,
          mimeType: result.mimeType,
        });

        if (persistOnly) {
          return textResult({
            path: saved.path,
            bytes: saved.bytes,
            title: result.title,
            url: result.url,
            tmpRoot: TMP_ROOT,
          });
        }

        const content: ContentItem[] = [
          {
            type: "text",
            text:
              `Screenshot of ${result.title ?? "tab"}${result.url ? ` (${result.url})` : ""}\nsaved: ${saved.path} (${saved.bytes} bytes)\ntmp: ${TMP_ROOT}` +
              (result.note ? `\n${result.note}` : ""),
          },
          {
            type: "image",
            data: result.data,
            mimeType: result.mimeType ?? "image/png",
          },
        ];
        return { content };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_clear_tmp",
    "Delete deeporax-browser-mcp artifacts under /tmp/deeporax-browser-mcp. Use after reading a snapshot/screenshot, or to wipe everything.",
    {
      path: z
        .string()
        .optional()
        .describe("Specific file to delete (must be under /tmp/deeporax-browser-mcp). Omit to wipe all."),
      all: z
        .boolean()
        .optional()
        .describe("If true (default when path omitted), delete all snapshots and screenshots."),
    },
    async ({ path, all }) => {
      try {
        if (path) {
          const ok = deleteArtifact(path);
          return textResult(
            ok
              ? { deleted: path }
              : { deleted: false, error: "Path not under /tmp/deeporax-browser-mcp or missing", path }
          );
        }

        if (all === false) {
          return textResult({ deleted: false, note: "Pass path= or all=true" });
        }

        const { readdirSync, rmSync } = await import("node:fs");
        const { join } = await import("node:path");
        const removed: string[] = [];
        for (const sub of ["snapshots", "screenshots"]) {
          const dir = join(TMP_ROOT, sub);
          let files: string[] = [];
          try {
            files = readdirSync(dir);
          } catch {
            continue;
          }
          for (const f of files) {
            const full = join(dir, f);
            try {
              rmSync(full, { force: true });
              removed.push(full);
            } catch {
              /* ignore */
            }
          }
        }
        return textResult({ deleted: removed.length, files: removed, tmpRoot: TMP_ROOT });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_click",
    "Click an element by snapshot ref or CSS selector.",
    {
      ...refOrSelector,
      tabId,
      doubleClick: z.boolean().optional(),
      tripleClick: z
        .boolean()
        .optional()
        .describe("Triple click, which selects the line or paragraph under the cursor"),
      button: z.enum(["left", "right", "middle"]).optional(),
    },
    async (args) => {
      try {
        return textResult(await call("click", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_type",
    "Set the text of an input/textarea/contenteditable by ref or selector. Replaces the existing value unless append is true. The field is read back afterwards and the call fails if it does not hold the requested value, so a success means the value is really there.",
    {
      ...refOrSelector,
      text: z.string().describe("Text to type"),
      tabId,
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after typing"),
      append: z
        .boolean()
        .optional()
        .describe("If true, do not clear the field first"),
      slowly: z
        .boolean()
        .optional()
        .describe("Type character-by-character (for sites that listen to key events)"),
    },
    async (args) => {
      try {
        return textResult(await call("type", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_clear",
    "Empty a text field by ref or selector. The field is read back afterwards, so this fails loudly rather than leaving stale text behind.",
    { ...refOrSelector, tabId },
    async (args) => {
      try {
        return textResult(await call("clear", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_press_key",
    "Press a key (Enter, Escape, Tab, ArrowDown) or chord in the focused element. Editing chords run the browser's real editing command, so Cmd+A/Control+A selects, Alt+Backspace deletes a word, and Cmd+Backspace clears to the start of the line. To set a field's text use browser_type, which verifies the result.",
    {
      key: z.string().describe("Key or chord"),
      tabId,
    },
    async ({ key, tabId: id }) => {
      try {
        return textResult(await call("press_key", { key, tabId: id }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_hover",
    "Hover over an element by ref or selector.",
    { ...refOrSelector, tabId },
    async (args) => {
      try {
        return textResult(await call("hover", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_select_option",
    "Select one or more options in a <select> by value or label.",
    {
      ...refOrSelector,
      values: z.array(z.string()).describe("Option values or labels to select"),
      tabId,
    },
    async (args) => {
      try {
        return textResult(await call("select_option", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_scroll",
    "Scroll the page or a specific element into view / by amount.",
    {
      tabId,
      ref: refOrSelector.ref,
      selector: refOrSelector.selector,
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      amount: z.number().optional().describe("Pixels to scroll (default 600)"),
    },
    async (args) => {
      try {
        return textResult(await call("scroll", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_wait",
    "Wait for time, text, selector, or for text to disappear. Keep waits short (default max 10s). Prefer browser_snapshot to check state instead of long idle waits — long waits are a common stuck-loop smell.",
    {
      tabId,
      time: z
        .number()
        .optional()
        .describe("Seconds to wait (capped; prefer ≤5)"),
      text: z.string().optional().describe("Wait until this text appears"),
      textGone: z.string().optional().describe("Wait until this text is gone"),
      selector: z.string().optional().describe("Wait until selector matches"),
      timeout: z
        .number()
        .optional()
        .describe("Max seconds to wait (default 10, hard cap 20)"),
    },
    async (args) => {
      try {
        const capSec = Math.min(Number(args.timeout ?? 10), 20);
        const timeSec =
          args.time != null ? Math.min(Number(args.time), capSec) : undefined;
        const bridgeMs = Math.min(Math.max(capSec * 1000 + 5_000, 10_000), 30_000);
        return textResult(
          await call(
            "wait",
            {
              ...args,
              time: timeSec,
              timeout: capSec,
            },
            bridgeMs
          )
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_evaluate",
    "Run JavaScript in the page context and return the result (JSON-serializable).",
    {
      script: z
        .string()
        .describe(
          "JS expression or function body, evaluated in the page's main world. " +
            "Returns the real value; a thrown page error becomes a tool error."
        ),
      tabId,
    },
    async ({ script, tabId: id }) => {
      try {
        return textResult(await call("evaluate", { script, tabId: id }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_get_text",
    "Get innerText of an element (or the whole body).",
    { ...refOrSelector, tabId },
    async (args) => {
      try {
        return textResult(await call("get_text", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_get_html",
    "Get outerHTML of an element (or documentElement). Prefer snapshot for agent workflows.",
    {
      ...refOrSelector,
      tabId,
      maxLength: z.number().int().optional().describe("Truncate HTML to this many chars"),
    },
    async (args) => {
      try {
        return textResult(await call("get_html", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_fill_form",
    "Fill multiple fields at once. Each field needs ref or selector plus value. Every field is read back after writing, and the per-field results say which ones took the value. If any field fails the form is not submitted.",
    {
      tabId,
      fields: z
        .array(
          z.object({
            ref: z.string().optional(),
            selector: z.string().optional(),
            value: z.string(),
          })
        )
        .describe("Fields to fill"),
      submit: z.boolean().optional(),
    },
    async (args) => {
      try {
        // 15s of headroom per field: each one is written and then verified.
        const budget = 20_000 + args.fields.length * 15_000;
        return textResult(await call("fill_form", args, budget));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // --- Parity with Claude-in-Chrome / Playwright MCP essentials ---------------

  server.tool(
    "browser_find",
    "Search the latest snapshot (or page) for elements matching text/regex. Returns refs. Prefer browser_act_matches when you would click/type every match.",
    {
      tabId,
      query: z.string().describe("Text or regex to search for"),
      regex: z.boolean().optional().describe("Treat query as RegExp"),
      caseSensitive: z.boolean().optional(),
      role: z
        .string()
        .optional()
        .describe('Optional role filter, e.g. "button", "link", "checkbox"'),
      exactName: z
        .boolean()
        .optional()
        .describe(
          "If true, match only elements whose accessible name equals query (case-insensitive)"
        ),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async (args) => {
      try {
        return textResult(await call("find", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_act_matches",
    "Act on every element matching a text/role pattern in one call (click, hover, or type). Use when the UI repeats the same control (Reply, Follow, checkboxes, identical buttons) instead of screenshot/click loops. Takes a fresh snapshot, finds matches, and runs trusted CDP actions.",
    {
      tabId,
      query: z
        .string()
        .describe(
          'Accessible name / text to match, e.g. "Reply", "Follow", "Like". With exactName (default true) this is the full name.'
        ),
      action: z
        .enum(["click", "hover", "type"])
        .optional()
        .describe("What to do on each match (default click)"),
      text: z
        .string()
        .optional()
        .describe('Text to type when action is "type"'),
      role: z
        .string()
        .optional()
        .describe('Optional role filter, e.g. "button" or "link"'),
      exactName: z
        .boolean()
        .optional()
        .describe(
          "Default true: only exact accessible-name matches. Set false for substring match."
        ),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max elements to act on (default 30, hard max 50)"),
      delayMs: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .optional()
        .describe("Pause between actions in ms (default 40)"),
      stopOnError: z
        .boolean()
        .optional()
        .describe("If true, stop at the first failure (default continue)"),
      doubleClick: z.boolean().optional(),
      tripleClick: z.boolean().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      submit: z.boolean().optional(),
    },
    async (args) => {
      try {
        // Bulk work can take a while on long lists.
        return textResult(await call("act_matches", args, 120_000));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_click_xy",
    "Click at viewport CSS coordinates (from screenshot / computer-use style). Prefer browser_click with refs when possible.",
    {
      tabId,
      x: z.number().describe("X in CSS pixels relative to viewport"),
      y: z.number().describe("Y in CSS pixels relative to viewport"),
      doubleClick: z.boolean().optional(),
      tripleClick: z
        .boolean()
        .optional()
        .describe("Triple click, which selects the line or paragraph under the cursor"),
      button: z.enum(["left", "right", "middle"]).optional(),
    },
    async (args) => {
      try {
        return textResult(await call("click_xy", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_drag",
    "Drag from one element to another by ref/selector.",
    {
      tabId,
      fromRef: z.string().optional(),
      fromSelector: z.string().optional(),
      toRef: z.string().optional(),
      toSelector: z.string().optional(),
    },
    async (args) => {
      try {
        return textResult(await call("drag", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_highlight",
    "Outline an element briefly so humans can see what the agent is targeting.",
    {
      ...refOrSelector,
      tabId,
      durationMs: z.number().optional().describe("How long to show outline (default 2500)"),
      style: z.string().optional().describe("CSS outline value"),
    },
    async (args) => {
      try {
        return textResult(await call("highlight", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_console",
    "Read console messages (log/warn/error) from the page. Prefer pattern filters. Like Claude-in-Chrome read_console_messages.",
    {
      tabId,
      pattern: z
        .string()
        .optional()
        .describe("Regex/text filter (recommended to avoid noise)"),
      level: z
        .enum(["log", "info", "warn", "error", "debug"])
        .optional(),
      limit: z.number().int().min(1).max(500).optional(),
      clear: z.boolean().optional().describe("Clear buffer after read"),
    },
    async (args) => {
      try {
        return textResult(await call("console", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_network",
    "List recent network requests for the tab (debugger + performance observer). Like Claude-in-Chrome read_network_requests.",
    {
      tabId,
      pattern: z.string().optional().describe("Filter URLs by text/regex"),
      limit: z.number().int().min(1).max(500).optional(),
      clear: z.boolean().optional(),
      attach: z
        .boolean()
        .optional()
        .describe("Attach chrome.debugger for richer capture (default true)"),
    },
    async (args) => {
      try {
        return textResult(await call("network", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_resize",
    "Resize the browser window that owns the tab.",
    {
      tabId,
      width: z.number().int().min(200).max(4000),
      height: z.number().int().min(200).max(3000),
    },
    async (args) => {
      try {
        return textResult(await call("resize", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_file_upload",
    "Set files on an <input type=file> via ref/selector. Pass base64 file contents (max ~10MB total recommended).",
    {
      ...refOrSelector,
      tabId,
      files: z
        .array(
          z.object({
            name: z.string(),
            mimeType: z.string().optional(),
            base64: z.string().describe("Base64 file bytes"),
          })
        )
        .min(1),
    },
    async (args) => {
      try {
        return textResult(await call("file_upload", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_handle_dialog",
    "Set how alert/confirm/prompt should behave (hooks intercept page dialogs so they do not freeze automation).",
    {
      tabId,
      accept: z
        .boolean()
        .optional()
        .describe("confirm() return value (default true)"),
      promptText: z
        .string()
        .nullable()
        .optional()
        .describe("prompt() return value; null cancels"),
    },
    async ({ tabId: id, accept, promptText }) => {
      try {
        return textResult(
          await call("dialog_policy", {
            tabId: id,
            policy: {
              confirm: accept ?? true,
              prompt: promptText === undefined ? "" : promptText,
            },
          })
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_get_bounding_box",
    "Get element bounding box in viewport CSS pixels (for coordinate clicks).",
    { ...refOrSelector, tabId },
    async (args) => {
      try {
        return textResult(await call("get_bounding_box", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_overlay",
    "Set the label on the on-page 'Deeporax agent is controlling this tab' overlay, or read whether the user has pressed Stop. The overlay appears automatically during actions and cannot be hidden from here: it is the user's only indication that a tool is driving their browser, and clearing a Stop is theirs to do, not yours.",
    {
      tabId,
      action: z
        .enum(["show", "status"])
        .default("show")
        .describe("show = display with a label, status = report whether the user stopped the agent"),
      label: z
        .string()
        .optional()
        .describe("Text shown after 'Deeporax agent', e.g. 'is filling the campaign form'"),
    },
    async (args) => {
      try {
        return textResult(await call("overlay", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "browser_batch",
    "Run multiple bridge methods sequentially in one round-trip. Prefer browser_act_matches for repeated same-action clicks; use batch for mixed sequences (type A, click B, snapshot).",
    {
      tabId,
      actions: z
        .array(
          z.object({
            method: z.string().describe("Bridge method name, e.g. click, type, snapshot, act_matches"),
            params: z.record(z.unknown()).optional(),
          })
        )
        .min(1)
        .max(25),
    },
    async (args) => {
      try {
        return textResult(await call("batch", args, 120_000));
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
