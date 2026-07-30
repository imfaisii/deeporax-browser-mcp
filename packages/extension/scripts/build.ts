import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const src = join(root, "src");
const pub = join(root, "public");

function makePng(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      raw[i] = rgba[0];
      raw[i + 1] = rgba[1];
      raw[i + 2] = rgba[2];
      raw[i + 3] = rgba[3];
    }
  }

  const compressed = deflateSync(raw);
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk("IHDR", ihdrData(width, height));
  const idat = chunk("IDAT", compressed);
  const iend = chunk("IEND", new Uint8Array(0));

  const out = new Uint8Array(signature.length + ihdr.length + idat.length + iend.length);
  out.set(signature, 0);
  out.set(ihdr, signature.length);
  out.set(idat, signature.length + ihdr.length);
  out.set(iend, signature.length + ihdr.length + idat.length);
  return out;
}

function ihdrData(width: number, height: number): Uint8Array {
  const d = new Uint8Array(13);
  const view = new DataView(d.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  d[8] = 8;
  d[9] = 6;
  d[10] = 0;
  d[11] = 0;
  d[12] = 0;
  return d;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const len = data.length;
  const out = new Uint8Array(4 + 4 + len + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, len);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crc = crc32(concat(typeBytes, data));
  view.setUint32(8 + len, crc >>> 0);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function ensureIcons() {
  const iconsDir = join(pub, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const size of [16, 48, 128] as const) {
    const path = join(iconsDir, `icon${size}.png`);
    if (await Bun.file(path).exists()) continue;
    await Bun.write(path, makePng(size, size, [37, 99, 235, 255]));
  }
}

async function bundle() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await ensureIcons();
  await cp(pub, dist, { recursive: true });
  await Bun.write(join(dist, "popup.html"), Bun.file(join(src, "popup.html")));

  const result = await Bun.build({
    entrypoints: [
      join(src, "background.ts"),
      join(src, "content.ts"),
      join(src, "popup.ts"),
    ],
    outdir: dist,
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
    naming: "[name].js",
  });

  if (!result.success) {
    console.error("Build failed");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const files = await readdir(dist);
  console.log("extension build ok:", files.sort().join(", "));
}

await bundle();
