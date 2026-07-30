import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the unpacked Chrome extension shipped with this package.
 *
 * Published layout:  <pkg>/dist/paths.js  -> <pkg>/extension
 * Monorepo dev:      falls back to packages/extension/dist
 */
export function extensionPath(): string {
  const packaged = path.resolve(here, "..", "extension");
  if (existsSync(path.join(packaged, "manifest.json"))) return packaged;

  const monorepo = path.resolve(here, "..", "..", "extension", "dist");
  if (existsSync(path.join(monorepo, "manifest.json"))) return monorepo;

  return packaged;
}

/** One-line instruction shown whenever the extension is not connected. */
export function loadExtensionHint(): string {
  return [
    "Chrome extension not connected.",
    "Open chrome://extensions, enable Developer mode, click 'Load unpacked', and select:",
    extensionPath(),
    "Then keep a Chrome window open.",
  ].join(" ");
}
