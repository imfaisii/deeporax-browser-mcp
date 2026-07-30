/**
 * Smoke test: register tools and list them over an in-memory MCP transport.
 * Run: bun run packages/mcp-server/scripts/list-tools.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bridge } from "../src/bridge.js";
import { registerTools } from "../src/tools.js";

const server = new McpServer(
  { name: "deeporax-browser-mcp", version: "0.1.0" },
  {
    instructions: "test",
  }
);

bridge.start(17376);
registerTools(server);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke-test", version: "0.0.1" });

await server.connect(serverTransport);
await client.connect(clientTransport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();

console.log("tools_count:", names.length);
console.log(names.join("\n"));

bridge.stop();

if (names.length < 15) {
  console.error("FAIL: expected >= 15 tools");
  process.exit(1);
}

// Ensure disconnected call surfaces a clear error
try {
  await bridge.call("snapshot");
  console.error("FAIL: expected disconnected error");
  process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/not connected/i.test(msg)) {
    console.error("FAIL: unexpected error:", msg);
    process.exit(1);
  }
}

console.log("PASS");
