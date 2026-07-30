# deeporax-browser-mcp

[![npm](https://img.shields.io/npm/v/deeporax-browser-mcp.svg)](https://www.npmjs.com/package/deeporax-browser-mcp)
[![license](https://img.shields.io/npm/l/deeporax-browser-mcp.svg)](LICENSE)

MCP server that controls a real Chrome browser through a companion MV3 extension: DOM snapshots with element refs, clicks, typing, screenshots, and navigation.

```bash
npx -y deeporax-browser-mcp
```

## Claude Code

```bash
claude mcp add deeporax-browser-mcp -- npx -y deeporax-browser-mcp
```

## Claude Desktop

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

## Extension

This package ships an unpacked Chrome extension in `extension/`.

1. Print the folder path:

   ```bash
   node -e "const p=require('path');console.log(p.join(p.dirname(require.resolve('deeporax-browser-mcp/package.json')),'extension'))"
   ```

2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select that folder
3. Keep Chrome open. The toolbar badge shows **ON** when the MCP server is connected.

You can also grab `extension-dist.zip` from [GitHub Releases](https://github.com/imfaisii/deeporax-browser-mcp/releases).

## Verify

Ask your MCP client:

> use browser_status then snapshot my current tab

## Docs

Full documentation, tools list, security notes, and source install:

https://github.com/imfaisii/deeporax-browser-mcp

## License

MIT
