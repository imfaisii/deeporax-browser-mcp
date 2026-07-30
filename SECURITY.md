# Security Policy

## What this software can do

deeporax-browser-mcp gives an MCP client (for example Claude) control over a real
Chrome profile through a local extension bridge:

- Read page DOM and take screenshots
- Click, type, navigate, and run JavaScript in pages you have open
- Access any site where you are already logged in

Treat MCP access to this server like handing someone your open browser. Only
enable it for clients and configs you trust.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Outbound links

The extension UI links to deeporax.com from the popup and the on-page status
pill. Those links carry UTM parameters so the visit is attributable in web
analytics.

- Links open **only** when you click them. Nothing is sent in the background.
- No identifier, page URL, or browsing data is attached.
- The extension makes no network requests other than the local WebSocket bridge.

## Network exposure

The WebSocket bridge binds to **127.0.0.1 only** by default. Do not reconfigure
it to listen on a public interface.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email **cfaysal099@gmail.com** with:

- A description of the issue
- Steps to reproduce
- Impact assessment if you have one
- Any suggested fix

You should receive an acknowledgement within 72 hours. Please give us reasonable
time to publish a fix before public disclosure.

## Hardening tips for users

- Use a dedicated Chrome profile for automation when possible
- Only enable the MCP server in trusted client configurations
- Unload the extension when you are not using it
- Do not run untrusted MCP clients against this server
- Be careful with `browser_evaluate`: it runs arbitrary JS in the page context
