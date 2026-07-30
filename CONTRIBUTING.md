# Contributing

Thanks for helping improve deeporax-browser-mcp.

## Development setup

Requirements:

- [Bun](https://bun.sh) 1.1+ (package manager and scripts)
- Node.js 18+ (runtime for the published MCP server)
- Chrome or Chromium

```bash
git clone https://github.com/imfaisii/deeporax-browser-mcp.git
cd deeporax-browser-mcp
bun install
bun run build
bun run typecheck
bun run smoke
```

## Project layout

| Path | Role |
|------|------|
| `packages/mcp-server` | Publishable npm package (`deeporax-browser-mcp`) |
| `packages/extension` | Chrome MV3 extension source |
| `configs/` | Example MCP host configs |

## Common commands

```bash
bun run build             # extension + server + copy extension into package
bun run build:extension   # packages/extension/dist
bun run build:server      # tsc + copy extension into packages/mcp-server/extension
bun run typecheck
bun run smoke             # list MCP tools over in-memory transport
bun run pack:dry          # build + npm pack --dry-run in packages/mcp-server
bun start                 # run compiled server (stdio MCP)
```

### Load the local extension

1. `bun run build:extension`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → `packages/extension/dist`
5. After further extension changes, rebuild and click **Reload**

The badge shows **ON** when the MCP server WebSocket bridge is connected
(`ws://127.0.0.1:17373` by default).

## Code style

Match the existing code. Do not introduce a new formatter/linter config unless
asked.

- TypeScript, ESM (`"type": "module"`), `strict` from `tsconfig.base.json`
- 2-space indent, double quotes, trailing commas where the file already uses them
- Prefer small focused modules over new abstractions
- Keep comments sparse and only where the why is non-obvious
- Shared protocol types live in `protocol.ts` on each side of the bridge
- Server logs go to **stderr** only (stdout is reserved for MCP stdio)
- Extension UI strings and badge colors should stay consistent with existing code

## Pull requests

1. Keep changes focused. One concern per PR.
2. Match existing naming, file layout, and comment density.
3. Before opening the PR, run:

   ```bash
   bun run typecheck && bun run smoke && bun run pack:dry
   ```

4. Describe what changed and how you verified it (commands, Chrome steps).
5. Do not commit `node_modules`, build outputs (`dist/`, packaged `extension/`),
   `*.tgz`, `.env`, or secrets.
6. Update `CHANGELOG.md` under `[Unreleased]` or the relevant version when the
   change is user-visible.

## Reporting bugs

Use the bug report template. Include OS, Chrome version, Node/Bun version, and
whether the extension badge shows **ON**.

## Security

Do not file public issues for vulnerabilities that could let someone abuse
browser control. See [SECURITY.md](SECURITY.md).

## Code of conduct

By participating, you agree to uphold the [Code of Conduct](CODE_OF_CONDUCT.md).
