#!/usr/bin/env node
/**
 * Bump every version in lockstep, commit, and tag.
 *
 *   bun run release patch      0.1.0 -> 0.1.1
 *   bun run release minor      0.1.0 -> 0.2.0
 *   bun run release major      0.1.0 -> 1.0.0
 *   bun run release 0.4.2      explicit
 *
 * Pushing the tag is what triggers the npm publish, so this script stops
 * short of pushing and prints the command.
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

function run(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function writeJson(rel, data) {
  writeFileSync(join(root, rel), JSON.stringify(data, null, 2) + "\n");
}

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

if (run(`git tag -l v${version}`)) {
  console.error(`Tag v${version} already exists.`);
  process.exit(1);
}

for (const rel of FILES) {
  const json = readJson(rel);
  json.version = version;
  writeJson(rel, json);
  console.log(`  ${rel} -> ${version}`);
}

// Rebuild so dist/ and the bundled extension carry the new version.
run("bun run build");
run("bun run typecheck");
run("bun run smoke");

run(`git add ${FILES.join(" ")}`);
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);

console.log(`\nReleased v${version} locally. Push to publish:\n`);
console.log(`  git push origin main --follow-tags\n`);
