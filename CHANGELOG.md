# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-31

Initial public release.

### Added

- MCP server (`deeporax-browser-mcp`) with stdio transport for Claude Code / Claude Desktop
- Chrome MV3 extension with WebSocket bridge on `127.0.0.1:17373`
- 32 browser tools: navigate, tabs, snapshot, screenshot, click, click_xy, type,
  press_key, hover, drag, select_option, scroll, wait, evaluate, find, get_text,
  get_html, get_bounding_box, fill_form, file_upload, highlight, console, network,
  handle_dialog, resize, batch, overlay, clear_tmp, back, forward, reload, status
- Accessibility-style DOM snapshots with stable element refs (`e1`, `e2`, ...)
- Viewport PNG screenshots via `captureVisibleTab`
- Agent control overlay: pulsing orange border, status pill with a Stop button, and a
  synthetic cursor that animates to each target before the click fires
- Console and network capture per tab, with regex filtering
- Snapshots and screenshots written to `/tmp/deeporax-browser-mcp`, auto-pruned after
  30 minutes and capped at 40 files per kind
- npm-publishable package that bundles the unpacked extension
- Example MCP host configs under `configs/`
- CI workflow (typecheck, smoke, pack dry-run)
- Release workflow (npm publish + extension zip asset)

[Unreleased]: https://github.com/imfaisii/deeporax-browser-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/imfaisii/deeporax-browser-mcp/releases/tag/v0.1.0
