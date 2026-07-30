# Chrome Web Store listing

Copy-paste source for the developer dashboard. Assets live beside this file.

## Store listing tab

**Name** (45 char max)

```
Deeporax Browser MCP
```

**Short description** (132 char max, currently 118)

```
Let your AI agent see and control this browser: page snapshots, clicks, typing, screenshots. Runs locally, nothing uploaded.
```

**Detailed description**

```
Deeporax Browser MCP connects your own AI coding agent to the browser you
already use, with the sessions you are already signed into.

Install the companion MCP server, point your agent at it, and ask for what you
want in plain language. The agent reads the page structure, clicks the right
button, fills the form, and takes a screenshot so you can check the result.

WHAT YOUR AGENT CAN DO

- Read a page as a structured outline of its links, buttons, headings and
  inputs, so it acts on the right element instead of guessing
- Click, type, hover, drag, select dropdown options, and press keys
- Fill multi-field forms in one step
- Take screenshots of the visible tab
- Open, close, list and switch tabs, and navigate back and forward
- Read console messages and network requests when debugging a page
- Run JavaScript in the page and read the result
- Wait for text or an element before continuing

YOU CAN SEE AND STOP IT

While the agent is working, the tab shows an orange border, a status pill
naming the current action, and a cursor that moves to each target before it
clicks. A Stop button halts control immediately.

WHERE YOUR DATA GOES

Nowhere. The extension talks to a server on your own machine over
127.0.0.1 and nothing else. No accounts, no telemetry, no analytics, no
remote code. Page content never leaves your computer.

SETUP

1. Install the server:  npm i -g deeporax-browser-mcp
2. Register it with your MCP client, for example:
   claude mcp add deeporax-browser-mcp -- deeporax-browser-mcp
3. Keep Chrome open. The toolbar badge reads ON when connected.

Works with Claude Code, Claude Desktop, and any client that speaks the Model
Context Protocol. Requires Node.js 18 or newer.

Source code and documentation:
https://github.com/imfaisii/deeporax-browser-mcp
```

**Category**: `Developer Tools`
**Language**: English

## Privacy tab

**Single purpose**

```
Lets a user's local AI agent read and interact with web pages in their own
browser: page structure snapshots, screenshots, clicks, typing, and navigation.
```

**Permission justifications**

| Permission | Justification |
|---|---|
| `tabs` | Lists, opens, selects and closes tabs on behalf of the user's local AI agent, and reads tab URL and title to report which page is being acted on. |
| `scripting` | Injects the content script into the tab the user is working on, to read DOM structure and dispatch the clicks and typing the agent requests. |
| `activeTab` | Captures a screenshot of the visible viewport when the user asks their agent to look at the page. |
| `alarms` | Wakes the MV3 service worker periodically so the WebSocket connection to the user's own local server stays alive. |
| `debugger` | Attached to a tab only when the user explicitly asks for network request data, so the agent can debug page traffic. Never attached by default and detached when the tab closes. |
| Host permissions | The user decides at runtime which page their agent works on, so the sites cannot be known in advance. |

**Are you using remote code?** No. All logic ships inside the package.

**Data usage**: nothing collected, nothing sold, nothing transferred. Tick all
three compliance certifications.

## Assets in this folder

| File | Where it goes |
|---|---|
| `store-icon-128.png` | Store icon |
| `screenshot-1-1280x800.png` | Screenshot 1 |
| `screenshot-2-1280x800.png` | Screenshot 2 |
| `promo-tile-440x280.png` | Small promo tile |
| `marquee-1400x560.png` | Marquee promo tile (optional) |

Upload the extension zip from the latest release:
https://github.com/imfaisii/deeporax-browser-mcp/releases/latest/download/extension-dist.zip
