# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-30

Initial public release.

### Added

- MCP server (`deeporax-browser-mcp`) with stdio transport for Claude Code / Claude Desktop
- Chrome MV3 extension with WebSocket bridge on `127.0.0.1:17373`
- Browser tools: navigate, tabs, snapshot, screenshot, click, type, press_key, hover, select_option, scroll, wait, evaluate, get_text, get_html, fill_form, back, forward, reload, status
- Accessibility-style DOM snapshots with stable element refs (`e1`, `e2`, ...)
- Viewport PNG screenshots via `captureVisibleTab`
- npm-publishable package that bundles the unpacked extension
- Example MCP host configs under `configs/`
- CI workflow (typecheck, smoke, pack dry-run)
- Release workflow (npm publish + extension zip asset)

[Unreleased]: https://github.com/imfaisii/deeporax-browser-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/imfaisii/deeporax-browser-mcp/releases/tag/v0.1.0
