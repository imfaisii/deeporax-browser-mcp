# deeporax-browser-mcp

Control a real Chrome browser from Claude (or any MCP client): navigate, snapshot the DOM with element refs, click, type, screenshot, and run JS.

[![npm](https://img.shields.io/npm/v/deeporax-browser-mcp.svg)](https://www.npmjs.com/package/deeporax-browser-mcp)
[![license](https://img.shields.io/npm/l/deeporax-browser-mcp.svg)](LICENSE)
[![CI](https://github.com/imfaisii/deeporax-browser-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/imfaisii/deeporax-browser-mcp/actions/workflows/ci.yml)

## Demo

After install, try a prompt like:

> use deeporax browser mcp to create the google ads campaign for this project

Claude opens your Chrome, reads the page structure, and drives the UI while you watch.

## Architecture

```
Claude / MCP client
        |  stdio (MCP)
        v
  deeporax-browser-mcp   (Node.js)
        |  WebSocket ws://127.0.0.1:17373
        v
  Chrome extension (MV3)
        |
        v
  Your Chrome tabs (DOM + screenshots)
```

## Quick start

### A. Install the MCP server

**Claude Code:**

```bash
claude mcp add deeporax-browser-mcp -- npx -y deeporax-browser-mcp
```

**Claude Desktop** (merge into your config file):

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

Example configs also live in [`configs/`](configs/).

### B. Install the Chrome extension

**Option 1: download a release zip**

1. Get `extension-dist.zip` from [GitHub Releases](https://github.com/imfaisii/deeporax-browser-mcp/releases)
2. Unzip it
3. Open `chrome://extensions`
4. Enable **Developer mode**
5. **Load unpacked** and select the unzipped folder
6. Pin **Deeporax Browser MCP**. The badge shows **ON** when the MCP server is connected.

**Option 2: load from the npm package**

After the first `npx` run (or `npm install -g deeporax-browser-mcp`), the unpacked extension is inside the package:

```bash
node -e "const p=require('path');console.log(p.join(p.dirname(require.resolve('deeporax-browser-mcp/package.json')),'extension'))"
```

Load that folder the same way (Developer mode → Load unpacked).

**Option 3: build from source**

See [Install from source](#install-from-source). Load `packages/mcp-server/extension/` after `bun run build`.

### C. Verify

Ask Claude:

> use browser_status then snapshot my current tab

You should see `connected: true` and a DOM snapshot with refs like `e1`, `e2`.

## Install from source

```bash
git clone https://github.com/imfaisii/deeporax-browser-mcp.git
cd deeporax-browser-mcp
bun install
bun run build
```

Point your MCP config at the local binary:

```json
{
  "mcpServers": {
    "deeporax-browser-mcp": {
      "command": "node",
      "args": ["/ABS/PATH/deeporax-browser-mcp/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Load the extension from `packages/mcp-server/extension/`.

Development commands:

```bash
bun run typecheck
bun run smoke
bun run pack:dry
```

## Tools

| Tool | Purpose |
|------|---------|
| `browser_status` | Extension connection + active tab |
| `browser_navigate` | Go to URL (optionally new tab) |
| `browser_tabs` | list / new / close / select |
| `browser_snapshot` | Accessibility-style DOM with refs `e1`, `e2`, … (also under `/tmp/deeporax-browser-mcp/snapshots`) |
| `browser_screenshot` | PNG of visible viewport (also under `/tmp/deeporax-browser-mcp/screenshots`) |
| `browser_clear_tmp` | Delete one file or wipe `/tmp/deeporax-browser-mcp` artifacts |
| `browser_find` | Search snapshot/page by text or regex (returns refs) |
| `browser_click` | Click by `ref` or CSS `selector` |
| `browser_click_xy` | Click at viewport coordinates (computer-use style) |
| `browser_type` | Type into inputs |
| `browser_press_key` | Key / chord |
| `browser_hover` | Hover |
| `browser_drag` | Drag from one element to another |
| `browser_select_option` | `<select>` values |
| `browser_scroll` | Scroll page or into view |
| `browser_wait` | time / text / selector |
| `browser_evaluate` | Run JS in the page |
| `browser_get_text` / `browser_get_html` | Read content |
| `browser_get_bounding_box` | Element box in CSS pixels |
| `browser_fill_form` | Multi-field fill |
| `browser_file_upload` | Set files on `<input type=file>` (base64) |
| `browser_highlight` | Outline target element for humans |
| `browser_console` | Read console log/warn/error (filterable) |
| `browser_network` | List recent network requests |
| `browser_handle_dialog` | Pre-set alert/confirm/prompt behavior |
| `browser_resize` | Resize the browser window |
| `browser_batch` | Run multiple actions in one round-trip |
| `browser_overlay` | Show/hide the agent-control overlay, or resume after Stop |
| `browser_back` / `forward` / `reload` | History |

**Agent loop that works well:**

1. `browser_navigate` or `browser_tabs`
2. `browser_snapshot`
3. `browser_click` / `browser_type` using refs from the snapshot
4. Snapshot again (refs go stale after navigation)

## Agent control overlay

While the agent acts on a tab, the extension shows a visible control layer so a human
can follow along and intervene:

- A pulsing orange border around the viewport
- A status pill: **Deeporax agent** — *clicking link "Sign in"*
- A **Stop** button that halts agent control for that tab
- A synthetic cursor that glides to each target and pulses before the click fires

The overlay renders in a closed shadow root and is `pointer-events: none` except the
Stop button, so it cannot interfere with the page. It respects `prefers-reduced-motion`.

After a user presses Stop, further actions in that tab fail until you call
`browser_overlay` with `action: "resume"`. Pass `overlay: false` on an individual
action to skip the visuals.

## Temporary files

Snapshots and screenshots are written under:

```
/tmp/deeporax-browser-mcp/snapshots/*.txt
/tmp/deeporax-browser-mcp/screenshots/*.png
```

- Auto-pruned after **30 minutes**, and capped at **40 files** per kind
- Tool results include the saved path
- `persistOnly: true` returns only the path (handy when the body is huge)
- `browser_clear_tmp` deletes one path or wipes the whole tree
- `/tmp` is also cleared on reboot on many systems

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `DEEPORAX_MCP_PORT` | `17373` | Local WebSocket port (server + extension must match) |

The extension currently hardcodes port `17373`. Change both sides if you need another port.

## Security

- The bridge listens on **127.0.0.1 only**
- The extension can read and modify pages you visit and capture screenshots
- `browser_evaluate` runs arbitrary JS in the page. Treat MCP access like full browser control
- Prefer a dedicated Chrome profile for automation when you can
- See [SECURITY.md](SECURITY.md) for private vulnerability reporting

## Limitations

- Viewport screenshots only (not full-page scroll)
- `chrome://` and Chrome Web Store pages are blocked by Chrome
- MV3 service workers can sleep; an alarm + reconnect loop keeps the bridge healthy
- Cross-origin iframes are not walked by the snapshot
- One extension connection at a time (newest wins)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Faisal Ashfaq
