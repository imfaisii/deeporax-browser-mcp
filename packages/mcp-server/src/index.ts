#!/usr/bin/env node
/**
 * deeporax-browser-mcp server
 *
 * - Speaks MCP over stdio (Claude Code, Claude Desktop, other MCP hosts)
 * - Speaks a private JSON protocol over ws://127.0.0.1:17373 to the Chrome extension
 *
 * Load the bundled extension (see package "extension/" folder) in Chrome, then
 * drive the browser with tools like browser_snapshot / browser_click.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bridge } from "./bridge.js";
import { registerTools } from "./tools.js";
import { DEFAULT_PORT } from "./protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the unpacked extension shipped inside this package. */
export function extensionPath(): string {
  return path.resolve(__dirname, "..", "extension");
}

async function main() {
  const port = Number(process.env.DEEPORAX_MCP_PORT ?? DEFAULT_PORT);
  bridge.start(port);

  const extPath = extensionPath();

  const server = new McpServer(
    {
      name: "deeporax-browser-mcp",
      version: "0.1.0",
    },
    {
      instructions: [
        "You control the user's real Chrome browser via the deeporax-browser-mcp extension.",
        "Typical loop: browser_status → browser_navigate → browser_snapshot → act with refs (browser_click / browser_type) → browser_snapshot again.",
        "Prefer browser_snapshot over browser_screenshot when you need to interact. Use screenshot to verify visual state.",
        "Element refs look like e1, e2 from the latest snapshot of that tab. Snapshots invalidate after navigation or DOM changes; re-snapshot before retrying a failed click/type.",
        "Session isolation: each MCP chat process has its own sessionId, current tab, and Chrome tab group (distinct color). Another open chat cannot steal or reuse this session's tabs. navigate/tabs open work inside this session only. Prefer omitting tabId. Group title is a short topic from the URL or optional groupLabel.",
        "Anti-loop rules: (1) If a tool says 'No tab with id', never retry that id — omit tabId or call browser_tabs action=list for a fresh one. (2) If navigate returns navigated:false or the snapshot URL is unchanged, stop retrying the same navigate; open newTab:true or pick a different tab. (3) If a result has trusted:false, close DevTools on that tab and do not keep typing — React/SPAs ignore synthetic input. (4) Do not call browser_wait for more than ~5s of idle time; prefer snapshot to check state. (5) After two identical failures, change approach or report blocked — do not burn the turn replaying the same call.",
        `If tools fail with 'extension not connected', tell the user to load the unpacked extension from: ${extPath}`,
        "Chrome → chrome://extensions → Developer mode → Load unpacked → select that folder. Keep Chrome open. After updating the extension, reload it on chrome://extensions so new permissions (tabGroups) apply.",
      ].join(" "),
    }
  );

  registerTools(server);

  // Expose path as a resource-ish log once (stderr only; never stdout for stdio MCP)
  console.error(`[deeporax-browser-mcp] extension path: ${extPath}`);
  console.error(`[deeporax-browser-mcp] bridge port: ${port}`);
  console.error(`[deeporax-browser-mcp] session id: ${bridge.sessionId}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let closing = false;
  const shutdown = (why: string) => {
    if (closing) return;
    closing = true;
    console.error(`[deeporax-browser-mcp] shutting down (${why})`);
    bridge.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // An MCP host owns this process through stdio. When the host exits, stdin
  // closes; without this the server would keep the bridge port and its memory
  // for the rest of the login session.
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.stdin.on("end", () => shutdown("stdin ended"));
  process.stdin.on("error", () => shutdown("stdin error"));
}

main().catch((err) => {
  console.error("[deeporax-browser-mcp] fatal:", err);
  process.exit(1);
});
