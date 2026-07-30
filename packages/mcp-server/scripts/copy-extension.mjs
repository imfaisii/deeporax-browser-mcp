import { cp, access, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const srcDist = join(pkgRoot, "..", "extension", "dist");
const outDir = join(pkgRoot, "extension");

async function main() {
  try {
    await access(join(srcDist, "manifest.json"));
  } catch {
    console.error(
      "[deeporax-browser-mcp] Extension build missing.\n" +
        "Run from repo root: bun run build:extension\n" +
        `Expected: ${srcDist}/manifest.json`
    );
    process.exit(1);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(srcDist, outDir, { recursive: true });
  console.log(`[deeporax-browser-mcp] copied extension -> ${outDir}`);
}

await main();
