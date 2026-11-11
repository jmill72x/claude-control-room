// Draws the home-screen icons: the navy square with the orange ring and the
// white dot, at any size. The 180 px apple-touch-icon.png came first; these
// measurements were read off it (on its 180 px grid: ring 50 to 62 from the
// centre, dot 14), so the 192 and 512 px icons the manifest lists keep the same
// look. The original sits half a pixel up and left of centre: render(180,
// 89.5 / 180) matches it to within 30 levels at the anti-aliased edges (a mean
// of 0.08), and the new sizes are drawn on the true centre.
//
//   node web/scripts/make-icons.mjs            writes icon-192.png and icon-512.png
//   node web/scripts/make-icons.mjs 180 out.png  one size to one file
//
// No dependencies: node:zlib and a CRC table make the PNG.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const NAVY = [13, 32, 69];
const ORANGE = [255, 122, 69];
const WHITE = [248, 247, 243];
const GRID = 180;
const RING_IN = 50 / GRID;
const RING_OUT = 62 / GRID;
const DOT = 14 / GRID;
const SAMPLES = 8; // per side, per pixel

function colourAt(u, v, c) {
  const d = Math.hypot(u - c, v - c);
  if (d <= DOT) return WHITE;
  if (d >= RING_IN && d <= RING_OUT) return ORANGE;
  return NAVY;
}

export function render(size, centre = 0.5) {
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = colourAt((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size, centre);
          sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        }
      }
      const n = SAMPLES * SAMPLES, o = (y * size + x) * 3;
      px[o] = Math.round(sum[0] / n); px[o + 1] = Math.round(sum[1] / n); px[o + 2] = Math.round(sum[2] / n);
    }
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function png(size) {
  const px = render(size);
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB, no alpha: iOS fills a transparent icon with black
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [size, out] = process.argv.slice(2);
  if (size) {
    writeFileSync(out, png(Number(size)));
  } else {
    for (const s of [192, 512]) writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), png(s));
  }
}
