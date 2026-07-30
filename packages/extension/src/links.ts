/**
 * Outbound links to deeporax.com.
 *
 * Every link carries UTM parameters so traffic from the extension is
 * attributable in analytics. Only user-initiated clicks open these URLs:
 * the extension never beacons, pings, or reports in the background, and
 * no identifier is attached to the URL.
 */

const SITE = "https://deeporax.com";

export const SOURCE = "chrome_extension";
export const CAMPAIGN = "browser_mcp";

/**
 * Build a deeporax.com URL tagged with the placement that produced the click.
 *
 * @param path      Site-relative path, e.g. "/" or "/docs".
 * @param placement Where in the UI the click came from, e.g. "popup_wordmark".
 */
export function siteUrl(path: string, placement: string): string {
  const url = new URL(path, SITE);
  url.searchParams.set("utm_source", SOURCE);
  url.searchParams.set("utm_medium", "extension");
  url.searchParams.set("utm_campaign", CAMPAIGN);
  url.searchParams.set("utm_content", placement);
  return url.toString();
}

/** Open a tagged deeporax.com link in a new tab. */
export function openSite(path: string, placement: string): void {
  void chrome.tabs.create({ url: siteUrl(path, placement) });
}

/** Public source repository. Setup and troubleshooting docs live in its README. */
export const REPO_URL = "https://github.com/imfaisii/deeporax-browser-mcp";

/** Open the repository in a new tab. */
export function openRepo(): void {
  void chrome.tabs.create({ url: REPO_URL });
}
