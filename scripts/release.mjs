#!/usr/bin/env node
/**
 * Bump every version in lockstep and commit.
 *
 *   bun run release patch      0.1.1 -> 0.1.2
 *   bun run release minor      0.1.1 -> 0.2.0
 *   bun run release major      0.1.1 -> 1.0.0
 *   bun run release 0.4.2      explicit
 *
 * Then `git push`. CI sees a version that is not on npm yet and publishes it,
 * tags the commit, and creates the GitHub Release. No tagging happens here, so
 * a tag can never point at a commit that was later amended.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  "package.json",
  "packages/mcp-server/package.json",
  "packages/extension/package.json",
  "packages/extension/public/manifest.json",
];

const run = (cmd) => execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const writeJson = (rel, data) =>
  writeFileSync(join(root, rel), JSON.stringify(data, null, 2) + "\n");

function nextVersion(current, arg) {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const [major, minor, patch] = current.split(".").map(Number);
  if (arg === "major") return `${major + 1}.0.0`;
  if (arg === "minor") return `${major}.${minor + 1}.0`;
  if (arg === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Expected major | minor | patch | x.y.z, got "${arg}"`);
}

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: bun run release <major|minor|patch|x.y.z>");
  process.exit(1);
}

const status = run("git status --porcelain");
if (status) {
  console.error("Working tree is dirty. Commit or stash first:\n" + status);
  process.exit(1);
}

const current = readJson("packages/mcp-server/package.json").version;
const version = nextVersion(current, arg);

// npm versions are immutable, so catch a duplicate before building anything.
try {
  execSync(`npm view deeporax-browser-mcp@${version} version`, {
    stdio: "ignore",
  });
  console.error(`deeporax-browser-mcp@${version} is already published.`);
  process.exit(1);
} catch {
  /* not published, good */
}

for (const rel of FILES) {
  const json = readJson(rel);
  json.version = version;
  writeJson(rel, json);
  console.log(`  ${rel} -> ${version}`);
}

console.log("\nbuilding...");
run("bun run build");
run("bun run typecheck");
run("bun run smoke");

run(`git add ${FILES.join(" ")}`);
run(`git commit -m "Release v${version}"`);

console.log(`\nCommitted v${version}. Publish with:\n`);
console.log(`  git push\n`);
