import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const src = join(root, "src");
const pub = join(root, "public");

/**
 * The Deeporax "Stack" mark, rasterized without a headless browser so CI can
 * build icons too. Geometry matches deeporax.com's icon.svg on a 48x48 grid:
 * an acid plate, two offset frames, and a play triangle, all in ink.
 *
 * Rendered by supersampling a signed-distance test per pixel: cheap, exact,
 * and it keeps the build dependency-free.
 */
const ACID: RGB = [182, 229, 31];
const INK: RGB = [21, 23, 15];
const PAPER: RGB = [253, 252, 247];

type RGB = [number, number, number];

/** Signed distance to a rounded rect, negative inside. */
function sdRoundRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): number {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** True when the point is inside the play triangle. */
function inTriangle(px: number, py: number): boolean {
  const ax = 18.6, ay = 17, bx = 18.6, by = 26, cx = 26, cy = 21.5;
  const s = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const t = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const u = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
}

/**
 * Color at a point on the 48x48 artboard, or null for transparent.
 * Layers are resolved painter-style, front to back.
 */
function markColorAt(x: number, y: number): RGB | null {
  // Play triangle (front)
  if (inTriangle(x, y)) return INK;

  // Inner paper frame with ink stroke
  const inner = sdRoundRect(x, y, 13, 13, 17, 17, 4.5);
  if (Math.abs(inner) <= 1.35) return INK;
  if (inner < 0) return PAPER;

  // Middle outline frame (stroke only, no fill)
  const mid = sdRoundRect(x, y, 19, 19, 15, 15, 4);
  if (Math.abs(mid) <= 1.2) return INK;

  // Acid plate with ink stroke (back)
  const plate = sdRoundRect(x, y, 3, 3, 42, 42, 11);
  if (Math.abs(plate) <= 1.25) return INK;
  if (plate < 0) return ACID;

  return null;
}

/** Render the mark at `size` px, supersampled 4x4 for clean edges. */
function makeMarkPng(size: number): Uint8Array {
  const SS = 4;
  const scale = 48 / size;
  const raw = new Uint8Array((size * 4 + 1) * size);

  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    raw[row] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ax = (px + (sx + 0.5) / SS) * scale;
          const ay = (py + (sy + 0.5) / SS) * scale;
          const c = markColorAt(ax, ay);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            hits++;
          }
        }
      }

      const i = row + 1 + px * 4;
      const total = SS * SS;
      if (hits === 0) {
        raw[i] = raw[i + 1] = raw[i + 2] = raw[i + 3] = 0;
      } else {
        // Average only the covered samples so edge pixels keep their hue,
        // then let alpha carry the coverage.
        raw[i] = Math.round(r / hits);
        raw[i + 1] = Math.round(g / hits);
        raw[i + 2] = Math.round(b / hits);
        raw[i + 3] = Math.round((hits / total) * 255);
      }
    }
  }

  return encodePng(size, size, raw);
}

function encodePng(width: number, height: number, raw: Uint8Array): Uint8Array {
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

/**
 * Icons are regenerated on every build so they can never drift from the brand
 * mark. They are committed as well, so a plain `git clone` shows the real icon.
 */
async function ensureIcons() {
  const iconsDir = join(pub, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const size of [16, 48, 128] as const) {
    await Bun.write(join(iconsDir, `icon${size}.png`), makeMarkPng(size));
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
