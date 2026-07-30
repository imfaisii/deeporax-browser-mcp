# deeporax-browser-mcp

Control a real Chrome browser from any MCP client: navigate, snapshot the DOM with element refs, click, type, screenshot, read the console, and run JS.

[![npm](https://img.shields.io/npm/v/deeporax-browser-mcp.svg)](https://www.npmjs.com/package/deeporax-browser-mcp)
[![license](https://img.shields.io/npm/l/deeporax-browser-mcp.svg)](LICENSE)
[![CI](https://github.com/imfaisii/deeporax-browser-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/imfaisii/deeporax-browser-mcp/actions/workflows/ci.yml)

Unlike headless automation, this drives **your** browser: your profile, your logins, your session. The agent works inside the tabs you already have open, and an on-page overlay shows what it is doing with a Stop button.

## Demo

After install, try a prompt like:

> use deeporax browser mcp to create the google ads campaign for this project

The agent opens your Chrome, reads the page structure, and drives the UI while you watch.

## Architecture

```
AI client (Claude Code, Cursor, VS Code, ...)
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

Install has two parts: **the MCP server** ([step A](#a-install-the-mcp-server)) and **the Chrome extension** ([step B](#b-install-the-chrome-extension)). Both are required.

## A. Install the MCP server

### Pick a runner

Every config below uses `npx -y deeporax-browser-mcp`. Swap in whichever runner you prefer:

| Runner | `command` | `args` |
|---|---|---|
| npm (default) | `npx` | `["-y", "deeporax-browser-mcp"]` |
| Bun | `bunx` | `["deeporax-browser-mcp"]` |
| pnpm | `pnpm` | `["dlx", "deeporax-browser-mcp"]` |
| Yarn | `yarn` | `["dlx", "deeporax-browser-mcp"]` |
| Deno | `deno` | `["run", "-A", "npm:deeporax-browser-mcp"]` |
| Global install | `deeporax-browser-mcp` | `[]` |

A global install starts faster and gives a **stable extension path**, which matters for [step B](#b-install-the-chrome-extension):

```bash
npm  install -g   deeporax-browser-mcp
bun  add -g       deeporax-browser-mcp
pnpm add -g       deeporax-browser-mcp
yarn global add   deeporax-browser-mcp
```

Requires **Node.js 18+**.

### Claude Code

```bash
claude mcp add deeporax-browser-mcp -- npx -y deeporax-browser-mcp
```

Add `-s user` to enable it in every project. Verify with `claude mcp list`.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

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

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

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

### VS Code (GitHub Copilot)

`.vscode/mcp.json` in your workspace. VS Code uses `servers`, not `mcpServers`:

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

Then enable it from the tools picker in Copilot Chat (Agent mode).

### Claude Desktop

`claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

Restart Claude Desktop after editing.

### Zed

`settings.json`. Zed uses `context_servers`:

```json
{
  "context_servers": {
    "deeporax-browser-mcp": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "deeporax-browser-mcp"]
    }
  }
}
```

### Cline / Roo Code

Open the MCP Servers panel, choose **Configure MCP Servers**, and add:

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

### Continue

`~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: deeporax-browser-mcp
    command: npx
    args: ["-y", "deeporax-browser-mcp"]
```

### Gemini CLI

`~/.gemini/settings.json`:

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

### Codex CLI

`~/.codex/config.toml` (TOML, not JSON):

```toml
[mcp_servers.deeporax-browser-mcp]
command = "npx"
args = ["-y", "deeporax-browser-mcp"]
```

### opencode

`opencode.json`:

```json
{
  "mcp": {
    "deeporax-browser-mcp": {
      "type": "local",
      "command": ["npx", "-y", "deeporax-browser-mcp"],
      "enabled": true
    }
  }
}
```

### Goose

Settings → Extensions → **Add custom extension**, type **StandardIO**, command:

```
npx -y deeporax-browser-mcp
```

### JetBrains IDEs (AI Assistant / Junie)

Settings → Tools → AI Assistant → **Model Context Protocol (MCP)** → **Add**, then use command `npx` with args `-y deeporax-browser-mcp`, or paste the standard `mcpServers` block.

### Warp

Settings → AI → **Manage MCP servers** → **Add**, then paste the standard `mcpServers` block.

### LM Studio

Program → **Install** → **Edit mcp.json**, then paste the standard `mcpServers` block.

### Anything else

Any MCP client that speaks stdio works. The universal shape is:

```json
{
  "mcpServers": {
    "deeporax-browser-mcp": {
      "command": "npx",
      "args": ["-y", "deeporax-browser-mcp"],
      "env": { "DEEPORAX_MCP_PORT": "17373" }
    }
  }
}
```

Ready-made examples live in [`configs/`](configs/).

## B. Install the Chrome extension

The npm package ships the unpacked extension. Works in Chrome, Edge, Brave, Arc, and other Chromium browsers.

**Option 1: from the installed package (recommended)**

Print the folder:

```bash
node -e "const p=require('path');console.log(p.join(p.dirname(require.resolve('deeporax-browser-mcp/package.json')),'extension'))"
```

Or ask your agent to run `browser_status`, which prints the exact path.

Then:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** and select that folder
4. Pin **Deeporax Browser MCP**. The badge shows **ON** when the server is connected.

> Prefer a **global install** for this step. With `npx`, the package lives in a cache directory that can move between runs.

**Option 2: download a release zip**

Grab `extension-dist.zip` from [Releases](https://github.com/imfaisii/deeporax-browser-mcp/releases), unzip, and load it the same way.

**Option 3: build from source**

See [Install from source](#install-from-source), then load `packages/mcp-server/extension/`.

## C. Verify

Ask your agent:

> use browser_status then snapshot my current tab

You should see `connected: true` and a DOM snapshot with refs like `e1`, `e2`.

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

## Install from source

```bash
git clone https://github.com/imfaisii/deeporax-browser-mcp.git
cd deeporax-browser-mcp
bun install
bun run build
```

`npm install`, `pnpm install`, and `yarn install` work too. The extension bundle is built with Bun.

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

## Troubleshooting

**`connected: false` or "extension not connected"**
Chrome must be open with the extension loaded. Check that the toolbar badge reads **ON**, and that the folder you loaded matches the path `browser_status` reports.

**`ERR_CONNECTION_REFUSED` on `127.0.0.1:17373` in the extension console**
Nothing is serving the bridge yet. Your MCP client starts the server on demand, so open a chat session in that client. Do not run the server yourself in a terminal; two servers competing for the port is the usual cause.

**Tools fail on `chrome://` pages**
Chrome blocks extensions on `chrome://`, the Web Store, and other privileged pages. Switch to a normal `http(s)` tab.

**Snapshot returns few elements on a complex app**
Cross-origin iframes are not walked yet. Use `browser_evaluate` or a CSS selector for those regions.

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
