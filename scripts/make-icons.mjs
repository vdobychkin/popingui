/**
 * Generates every icon the app needs straight into build/icons — no binary
 * assets in the repo. Writes PNGs by hand (zlib + CRC32) and packs an .ico,
 * which is just a directory of PNGs as far as Windows Vista+ is concerned.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('build/icons');

// ------------------------------------------------------------------- PNG

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of size*size*4. */
function encodePng(rgba, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------- drawing

const SS = 4; // supersampling factor, gives us antialiasing for free

/**
 * `shade(x, y)` receives coordinates in a -1..1 square and returns
 * [r, g, b, a] with a in 0..1, or null for transparent.
 */
function render(size, shade) {
  const out = new Uint8Array(size * size * 4);
  const step = 1 / (size * SS);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px * SS + sx + 0.5) * step) * 2 - 1;
          const y = ((py * SS + sy + 0.5) * step) * 2 - 1;
          const c = shade(x, y);
          if (!c) continue;
          const [cr, cg, cb, ca] = c;
          // premultiplied accumulation, un-premultiplied at the end
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const TONES = {
  good: hex('#34d399'),
  warn: hex('#fbbf24'),
  bad: hex('#f87171'),
  idle: hex('#8892a4'),
};

/**
 * Tray glyph. Each tone gets its own silhouette, not just its own colour, so
 * the state survives a colour-blind user and a busy taskbar background:
 *   good — solid disc, warn — ring, bad — disc with a cut-out bar, idle — thin ring.
 */
function trayShade(tone) {
  const [r, g, b] = TONES[tone];
  const R = 0.86;
  return (x, y) => {
    const d = Math.hypot(x, y);
    if (d > R) return null;
    if (tone === 'warn' && d < R * 0.42) return null;
    if (tone === 'idle' && d < R * 0.66) return null;
    if (tone === 'bad' && Math.abs(y) < R * 0.16 && Math.abs(x) < R * 0.55) return null;
    return [r, g, b, 1];
  };
}

/** App icon: dark rounded tile with a radar sweep of concentric arcs. */
function appShade(x, y) {
  const boxR = 0.94;
  const corner = 0.34;
  // rounded-square signed distance
  const qx = Math.max(Math.abs(x) - (boxR - corner), 0);
  const qy = Math.max(Math.abs(y) - (boxR - corner), 0);
  if (Math.hypot(qx, qy) > corner) return null;

  const [gr, gg, gb] = TONES.good;
  const d = Math.hypot(x, y);
  const bg = [14, 17, 22, 1];

  if (d < 0.1) return [gr, gg, gb, 1]; // centre dot
  for (const ring of [0.32, 0.54, 0.76]) {
    if (Math.abs(d - ring) < 0.055) {
      // fade the rings out towards the lower-left, suggesting a sweep
      const angle = Math.atan2(y, x);
      const lit = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(angle + Math.PI / 4));
      return [gr, gg, gb, lit];
    }
  }
  return bg;
}

// ------------------------------------------------------------------- ICO

function encodeIco(pngs) {
  const dir = Buffer.alloc(6 + pngs.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(pngs.length, 4);
  let offset = dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0;
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(buf.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([dir, ...pngs.map((p) => p.buf)]);
}

// ------------------------------------------------------------------- main

mkdirSync(OUT, { recursive: true });

for (const tone of Object.keys(TONES)) {
  for (const size of [16, 32]) {
    const png = encodePng(render(size, trayShade(tone)), size);
    writeFileSync(path.join(OUT, `tray-${tone}${size === 32 ? '@2x' : ''}.png`), png);
  }
}

const appSizes = [16, 24, 32, 48, 64, 128, 256];
const appPngs = appSizes.map((size) => ({ size, buf: encodePng(render(size, appShade), size) }));
writeFileSync(path.join(OUT, 'app.ico'), encodeIco(appPngs));
writeFileSync(path.join(OUT, 'app.png'), appPngs.at(-1).buf);

console.log(`icons -> ${OUT}`);
