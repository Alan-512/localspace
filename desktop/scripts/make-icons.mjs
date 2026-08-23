// Generates LocalSpace Desktop icons as real PNG files using only Node built-ins,
// plus a TypeScript module embedding the tray icon as base64 so the Electron
// main process never depends on resource paths for it.
//
// Usage: node scripts/make-icons.mjs   (from desktop/)
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const PURPLE = [124, 58, 237]; // #7c3aed, matches the LocalSpace brand badge
const WHITE = [255, 255, 255];

function crc32(bytes) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const [r, g, b, a] = pixels[y]?.[x] ?? [0, 0, 0, 0];
      raw[offset] = r ?? 0;
      raw[offset + 1] = g ?? 0;
      raw[offset + 2] = b ?? 0;
      raw[offset + 3] = a ?? 0;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSquared = abx * abx + aby * aby;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lengthSquared));
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return Math.hypot(dx, dy);
}

function insideRoundedRect(x, y, size, radius) {
  const minX = radius;
  const maxX = size - radius;
  const minY = radius;
  const maxY = size - radius;
  const cx = Math.max(minX, Math.min(x, maxX));
  const cy = Math.max(minY, Math.min(y, maxY));
  return Math.hypot(x - cx, y - cy) <= radius || (x >= minX && x <= maxX && y >= minY && y <= maxY);
}

function renderIcon(size) {
  const pixels = [];
  const radius = size * 0.22;
  const thickness = Math.max(size * 0.085, 1.4);
  const chevronA = { x: size * 0.34, y: size * 0.26 };
  const chevronTip = { x: size * 0.64, y: size * 0.5 };
  const chevronB = { x: size * 0.34, y: size * 0.74 };
  const samples = [-0.25, 0.25];

  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) {
      // 2x2 supersampling for smooth small-size edges
      let coverage = 0;
      let glyphCoverage = 0;
      for (const sy of samples) {
        for (const sx of samples) {
          const px = x + 0.5 + sx;
          const py = y + 0.5 + sy;
          if (!insideRoundedRect(px, py, size, radius)) continue;
          coverage += 1;
          const distance = Math.min(
            segmentDistance(px, py, chevronA.x, chevronA.y, chevronTip.x, chevronTip.y),
            segmentDistance(px, py, chevronB.x, chevronB.y, chevronTip.x, chevronTip.y),
          );
          if (distance <= thickness / 2) glyphCoverage += 1;
        }
      }
      coverage /= samples.length * samples.length;
      glyphCoverage /= samples.length * samples.length;

      if (glyphCoverage > 0) {
        const blend = (channel) => Math.round(PURPLE[channel] * (1 - glyphCoverage) + WHITE[channel] * glyphCoverage);
        row.push([blend(0), blend(1), blend(2), Math.round(255 * Math.max(coverage, glyphCoverage))]);
      } else {
        row.push([PURPLE[0], PURPLE[1], PURPLE[2], Math.round(255 * coverage)]);
      }
    }
    pixels.push(row);
  }
  return encodePng(size, pixels);
}

mkdirSync(join(desktopRoot, "build"), { recursive: true });
mkdirSync(join(desktopRoot, "resources", "icons"), { recursive: true });

const appIcon = renderIcon(512);
writeFileSync(join(desktopRoot, "build", "icon.png"), appIcon);

const traySizes = [16, 32];
const trayEntries = traySizes.map((size) => ({
  size,
  base64: renderIcon(size).toString("base64"),
}));

writeFileSync(
  join(desktopRoot, "resources", "icons", "tray.png"),
  Buffer.from(trayEntries[trayEntries.length - 1]?.base64 ?? "", "base64"),
);

const moduleSource = [
  "// Generated by scripts/make-icons.mjs — do not edit by hand.",
  "export interface TrayIconEntry {",
  "  readonly size: number;",
  "  readonly base64: string;",
  "}",
  "",
  `export const trayIcons: readonly TrayIconEntry[] = ${JSON.stringify(trayEntries)};`,
  "",
].join("\n");
writeFileSync(join(desktopRoot, "src", "main", "tray-icon.ts"), moduleSource);

console.log(`icons written: build/icon.png (512), resources/icons/tray.png (${traySizes.join("/")})`);
