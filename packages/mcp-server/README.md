# deeporax-browser-mcp

[![npm](https://img.shields.io/npm/v/deeporax-browser-mcp.svg)](https://www.npmjs.com/package/deeporax-browser-mcp)
[![license](https://img.shields.io/npm/l/deeporax-browser-mcp.svg)](LICENSE)

MCP server that controls a real Chrome browser through a companion MV3 extension: DOM snapshots with element refs, clicks, typing, screenshots, console and network reads, and navigation.

It drives **your** browser, with your profile and your logins, and shows an on-page overlay with a Stop button while the agent works.

```bash
npx -y deeporax-browser-mcp
```

Requires **Node.js 18+**.

## Pick a runner

Configs below use `npx`. Any of these work:

| Runner | `command` | `args` |
|---|---|---|
| npm | `npx` | `["-y", "deeporax-browser-mcp"]` |
| Bun | `bunx` | `["deeporax-browser-mcp"]` |
| pnpm | `pnpm` | `["dlx", "deeporax-browser-mcp"]` |
| Yarn | `yarn` | `["dlx", "deeporax-browser-mcp"]` |
| Deno | `deno` | `["run", "-A", "npm:deeporax-browser-mcp"]` |
| Global | `deeporax-browser-mcp` | `[]` |

A global install starts faster and keeps the extension folder at a stable path:

```bash
npm  install -g   deeporax-browser-mcp
bun  add -g       deeporax-browser-mcp
pnpm add -g       deeporax-browser-mcp
yarn global add   deeporax-browser-mcp
```

## Set up your client

**Claude Code**

```bash
claude mcp add deeporax-browser-mcp -- npx -y deeporax-browser-mcp
```

**Cursor** (`~/.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`), **Claude Desktop**, **Cline**, **Roo Code**, **Gemini CLI**, **JetBrains AI Assistant**, **Warp**, **LM Studio**:

```json
{
  "mcpServers": {
    "deeporax-browser-mcp": {
      "command": "npx",
      "args": ["-y", "deeporax-browser-mcp"]
    }
  }
}
```

**VS Code / GitHub Copilot** (`.vscode/mcp.json`, note `servers`):

```json
{
  "servers": {
    "deeporax-browser-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "deeporax-browser-mcp"]
    }
  }
}
```

**Zed** (`context_servers`), **Codex CLI** (`~/.codex/config.toml`), **opencode**, **Continue**, and **Goose** are covered in the [full docs](https://github.com/imfaisii/deeporax-browser-mcp#a-install-the-mcp-server).

## Extension

This package ships an unpacked Chrome extension in `extension/`.

1. Print the folder path:

   ```bash
   node -e "const p=require('path');console.log(p.join(p.dirname(require.resolve('deeporax-browser-mcp/package.json')),'extension'))"
   ```

   Or run the `browser_status` tool, which prints it.

2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select that folder
3. Keep Chrome open. The toolbar badge shows **ON** when the MCP server is connected.

Works in Chrome, Edge, Brave, Arc, and other Chromium browsers. You can also grab `extension-dist.zip` from [GitHub Releases](https://github.com/imfaisii/deeporax-browser-mcp/releases).

## Verify

Ask your MCP client:

> use browser_status then snapshot my current tab

## Docs

Full tool list, overlay behavior, troubleshooting, security notes, and source install:

https://github.com/imfaisii/deeporax-browser-mcp

## License

MIT
