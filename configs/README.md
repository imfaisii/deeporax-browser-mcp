# Example MCP client configs

Copy the block for your client into its config file. Every file here targets the
published npm package, so nothing needs building first.

| Client | File | Config location |
|---|---|---|
| Claude Code | `claude-code-mcp.example.json` | `claude mcp add` writes this for you |
| Claude Desktop | `claude_desktop_config.example.json` | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `cursor-mcp.example.json` | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| Windsurf | `windsurf-mcp_config.example.json` | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot) | `vscode-mcp.example.json` | `.vscode/mcp.json` (uses `servers`) |
| Zed | `zed-settings.example.json` | `settings.json` (uses `context_servers`) |
| Cline / Roo Code | `cline-mcp.example.json` | MCP Servers panel → Configure MCP Servers |
| Gemini CLI | `gemini-cli-settings.example.json` | `~/.gemini/settings.json` |
| Codex CLI | `codex-config.example.toml` | `~/.codex/config.toml` |
| opencode | `opencode.example.json` | `opencode.json` |
| Continue | `continue-config.example.yaml` | `~/.continue/config.yaml` |

`bun-runner.example.json` shows the same server started with `bunx` instead of
`npx`. Swap `command` and `args` the same way for pnpm (`pnpm dlx`), Yarn
(`yarn dlx`), Deno (`deno run -A npm:...`), or a global install.

After the server is configured, load the Chrome extension. See the
[main README](../README.md#b-install-the-chrome-extension).
