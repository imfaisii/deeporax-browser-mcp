/**
 * Ephemeral artifact store under /tmp/deeporax-browser-mcp.
 * Snapshots and screenshots land here so they are easy to wipe and
 * are pruned automatically (age + count caps).
 */
import { mkdirSync, readdirSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Always under /tmp so paths are stable and easy to wipe. */
export const TMP_ROOT = "/tmp/deeporax-browser-mcp";
const SNAP_DIR = join(TMP_ROOT, "snapshots");
const SHOT_DIR = join(TMP_ROOT, "screenshots");

/** Delete files older than this. */
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
/** Keep at most this many files per kind after prune. */
const MAX_FILES_PER_KIND = 40;

function ensureDirs(): void {
  mkdirSync(SNAP_DIR, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}`
  );
}

function safeSlug(input: string | undefined, max = 40): string {
  if (!input) return "page";
  return (
    input
      .toLowerCase()
      .replace(/https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "page"
  );
}

function pruneDir(dir: string, ext: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(ext));
  } catch {
    return;
  }

  const now = Date.now();
  const kept: { name: string; mtime: number }[] = [];

  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs > MAX_AGE_MS) {
        unlinkSync(full);
      } else {
        kept.push({ name, mtime: st.mtimeMs });
      }
    } catch {
      /* ignore */
    }
  }

  kept.sort((a, b) => b.mtime - a.mtime);
  for (const old of kept.slice(MAX_FILES_PER_KIND)) {
    try {
      unlinkSync(join(dir, old.name));
    } catch {
      /* ignore */
    }
  }
}

export function pruneAll(): void {
  pruneDir(SNAP_DIR, ".txt");
  pruneDir(SHOT_DIR, ".png");
}

export function saveSnapshot(text: string, meta?: { url?: string; title?: string }): {
  path: string;
  bytes: number;
} {
  ensureDirs();
  pruneAll();
  const slug = safeSlug(meta?.title || meta?.url);
  const path = join(SNAP_DIR, `snap-${stamp()}-${slug}.txt`);
  const header = [
    meta?.title ? `title: ${meta.title}` : null,
    meta?.url ? `url: ${meta.url}` : null,
    `saved: ${new Date().toISOString()}`,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const body = header + text;
  writeFileSync(path, body, "utf8");
  return { path, bytes: Buffer.byteLength(body, "utf8") };
}

export function saveScreenshot(
  base64Png: string,
  meta?: { url?: string; title?: string }
): { path: string; bytes: number } {
  ensureDirs();
  pruneAll();
  const slug = safeSlug(meta?.title || meta?.url);
  const path = join(SHOT_DIR, `shot-${stamp()}-${slug}.png`);
  const buf = Buffer.from(base64Png, "base64");
  writeFileSync(path, buf);
  return { path, bytes: buf.length };
}

/** Delete a single artifact after the caller is done with it (best-effort). */
export function deleteArtifact(path: string): boolean {
  if (!path.startsWith(TMP_ROOT)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
