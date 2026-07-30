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
        "Element refs look like e1, e2 from the latest snapshot of that tab. Snapshots invalidate after navigation.",
        `If tools fail with 'extension not connected', tell the user to load the unpacked extension from: ${extPath}`,
        "Chrome → chrome://extensions → Developer mode → Load unpacked → select that folder. Keep Chrome open.",
      ].join(" "),
    }
  );

  registerTools(server);

  // Expose path as a resource-ish log once (stderr only; never stdout for stdio MCP)
  console.error(`[deeporax-browser-mcp] extension path: ${extPath}`);
  console.error(`[deeporax-browser-mcp] bridge port: ${port}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[deeporax-browser-mcp] fatal:", err);
  process.exit(1);
});
