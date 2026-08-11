# deeporax-browser-mcp

Control a real Chrome browser from any MCP client: navigate, snapshot the DOM with element refs, click, type, screenshot, read the console, and run JS.

[![npm](https://img.shields.io/npm/v/deeporax-browser-mcp.svg)](https://www.npmjs.com/package/deeporax-browser-mcp)
[![license](https://img.shields.io/npm/l/deeporax-browser-mcp.svg)](LICENSE)
[![CI](https://github.com/imfaisii/deeporax-browser-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/imfaisii/deeporax-browser-mcp/actions/workflows/ci.yml)

Headless tools launch a throwaway browser. This one drives **the browser you are already using**, with your profile, your logins, and your open tabs. An on-page overlay shows what the agent is doing and lets you stop it at any moment.

Once installed, prompts like this just work:

> use deeporax browser mcp to create the google ads campaign for this project

The agent opens your Chrome, reads the page structure, and clicks through the UI while you watch.

## How it works

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

Your AI client starts the server automatically when a chat session opens, so **you never run it yourself**. The extension connects to it over localhost.

## Install

Two parts, both required:

1. **[The MCP server](#a-install-the-mcp-server)** — one line for your AI client
2. **[The Chrome extension](#b-install-the-chrome-extension)** — load unpacked, once

Takes about two minutes.

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

### Other clients

Click your tool to expand.

<details>
<summary><b>Cursor</b></summary>

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

</details>

<details>
<summary><b>Windsurf</b></summary>

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

</details>

<details>
<summary><b>VS Code (GitHub Copilot)</b></summary>

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

</details>

<details>
<summary><b>Claude Desktop</b></summary>

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

</details>

<details>
<summary><b>Zed</b></summary>

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

</details>

<details>
<summary><b>Cline / Roo Code</b></summary>

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

</details>

<details>
<summary><b>Continue</b></summary>

`~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: deeporax-browser-mcp
    command: npx
    args: ["-y", "deeporax-browser-mcp"]
```

</details>

<details>
<summary><b>Gemini CLI</b></summary>

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

</details>

<details>
<summary><b>Codex CLI</b></summary>

`~/.codex/config.toml` (TOML, not JSON):

```toml
[mcp_servers.deeporax-browser-mcp]
command = "npx"
args = ["-y", "deeporax-browser-mcp"]
```

</details>

<details>
<summary><b>opencode</b></summary>

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

</details>

<details>
<summary><b>Goose</b></summary>

Settings → Extensions → **Add custom extension**, type **StandardIO**, command:

```
npx -y deeporax-browser-mcp
```

</details>

<details>
<summary><b>JetBrains IDEs (AI Assistant / Junie)</b></summary>

Settings → Tools → AI Assistant → **Model Context Protocol (MCP)** → **Add**, then use command `npx` with args `-y deeporax-browser-mcp`, or paste the standard `mcpServers` block.

</details>

<details>
<summary><b>Warp</b></summary>

Settings → AI → **Manage MCP servers** → **Add**, then paste the standard `mcpServers` block.

</details>

<details>
<summary><b>LM Studio</b></summary>

Program → **Install** → **Edit mcp.json**, then paste the standard `mcpServers` block.

</details>

<details>
<summary><b>Anything else</b></summary>

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

</details>

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

32 tools, grouped by what you reach for.

**See the page**

| Tool | Purpose |
|------|---------|
| `browser_snapshot` | Accessibility-style DOM with refs `e1`, `e2`, … Start here |
| `browser_screenshot` | PNG of the visible viewport |
| `browser_find` | Search the page by text or regex, returns refs |
| `browser_get_text` / `browser_get_html` | Read raw content |
| `browser_get_bounding_box` | Element box in CSS pixels |

**Act on it**

| Tool | Purpose |
|------|---------|
| `browser_click` | Click by `ref` or CSS `selector` |
| `browser_click_xy` | Click at viewport coordinates (computer-use style) |
| `browser_type` | Type into an input, optionally submit |
| `browser_fill_form` | Fill many fields in one call |
| `browser_press_key` | Key or chord, e.g. `Control+a` |
| `browser_hover` | Hover an element |
| `browser_drag` | Drag one element onto another |
| `browser_select_option` | Choose `<select>` values |
| `browser_scroll` | Scroll the page or an element into view |
| `browser_file_upload` | Set files on `<input type=file>` (base64) |

**Move around**

| Tool | Purpose |
|------|---------|
| `browser_navigate` | Go to a URL, optionally in a new tab (joins the Deeporax tab group) |
| `browser_tabs` | list / new / close / select (`sessionOnly` lists only agent tabs) |
| `browser_back` / `browser_forward` / `browser_reload` | History |
| `browser_wait` | Wait for time, text, or a selector (short caps; prefer snapshot) |
| `browser_resize` | Resize the browser window |

**Debug**

| Tool | Purpose |
|------|---------|
| `browser_console` | Read console log/warn/error, filterable by regex |
| `browser_network` | List recent network requests |
| `browser_evaluate` | Run JavaScript in the page |
| `browser_handle_dialog` | Decide alert/confirm/prompt behavior up front |

**Session**

| Tool | Purpose |
|------|---------|
| `browser_status` | Extension connection, session tab, and anti-loop guidance |
| `browser_overlay` | Show/hide the overlay, or resume after a user pressed Stop |
| `browser_highlight` | Outline an element so a human can see it |
| `browser_batch` | Run several actions in one round-trip |
| `browser_clear_tmp` | Delete saved snapshots and screenshots |

### The loop that works

```
browser_navigate  →  browser_snapshot  →  browser_click / browser_type  →  browser_snapshot
```

Snapshots hand back refs like `e1`, `e2`. Use those instead of CSS selectors when
you can: they survive markup churn better and are what the click and type tools
expect. **Refs go stale after navigation**, so snapshot again after the page
changes.

## Agent control overlay

You can always see when an agent is driving a tab, and stop it.

- A pulsing orange border around the viewport
- A status pill naming the current action: **Deeporax** — *clicking link "Sign in"*
- A **Stop** button that halts agent control for that tab
- A cursor that glides to each target and pulses right before the click fires

The pill appears automatically during any action and hides after 15 seconds of
inactivity.

**Stop** is a hard stop. Every later action in that tab returns an error until you
call `browser_overlay` with `action: "resume"`. To run one action without the
visuals, pass `overlay: false` to it.

The overlay lives in a closed shadow root, so page CSS cannot restyle it and page
scripts cannot read it. Everything is `pointer-events: none` except the Stop button,
so it never blocks clicks, and animations are disabled under
`prefers-reduced-motion`.

## How the connection works

There is no daemon and nothing to start by hand.

```
MCP client (Claude, Cursor, ...)
   | spawns on demand, over stdio
   v
deeporax-browser-mcp            <- one process per MCP client
   | WebSocket server on 127.0.0.1:17373
   v
Chrome extension                 <- connects out, retries every 2s
```

**Startup.** Your MCP client launches the server the first time a browser tool
is called, or when the client starts. The server opens the bridge port. The
extension is already retrying in the background, so it attaches within about
two seconds.

**Shutdown.** The server exits when its client exits: closing stdin, SIGINT,
SIGTERM, and SIGHUP all shut it down and release the port. Nothing survives the
session, so there is no process to clean up later.

**Two clients at once.** Only one server can own the port. A second one asks the
incumbent to hand over, and the incumbent closes its listener so the newcomer
can bind. The extension reconnects to whoever owns the port. If the port is held
by something that never yields, the new server gives up after 10 attempts and
goes into standby: it stops retrying and its tools explain the conflict instead
of burning a timer for the rest of the session.

**If the extension shows a disconnected badge,** the server is simply not
running yet. Ask your agent for `browser_status`, which starts it. The popup's
Reconnect button forces a fresh attempt immediately.

**Port.** Set `DEEPORAX_MCP_PORT` on the server if 17373 is taken. The extension
currently expects 17373, so change both sides together.

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

**Agent keeps retrying the same tab id or navigate**
Omit `tabId` so tools stay on the Deeporax session tab. After `No tab with id`, call `browser_tabs` with `sessionOnly: true` or `browser_status` for a fresh id — never retry the dead one. If navigate returns `navigated: false` or the snapshot URL did not change, open `newTab: true` instead of looping. If results show `trusted: false`, close DevTools on that tab; React and other component libraries ignore synthetic input.

**Where did the agent tabs go?**
Each chat gets its own Chrome tab group (different colors). The group title is a short topic from the URL (for example `X · post`) or a `groupLabel` you pass. A second chat does not reuse the first chat's tabs. Reload the extension after updating so the `tabGroups` permission applies.

**Second chat took over the first chat's tabs**
Fixed in current builds: every MCP process stamps a `sessionId` on bridge calls. Reload the extension and restart both chats so each gets a fresh server process.

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
