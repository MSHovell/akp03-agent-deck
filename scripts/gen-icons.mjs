#!/usr/bin/env node
/**
 * Generates the static PNG icons the plugin manifest points at.
 *
 * These are branding only — the live key art is SVG pushed via setImage at
 * runtime (see lib/icons.js). But a manifest whose icons 404 can fail to load,
 * so they need to be real files.
 *
 * Rather than pull in a rasterizer, shapes are defined as distance functions
 * and sampled with 4x supersampling. zlib is built in, so a PNG is ~40 lines.
 *
 *   node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'com.hovell.agentdeck.sdPlugin', 'icons');

// ── PNG ─────────────────────────────────────────────────────────────────────

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

/** @param {Uint8Array} rgba length w*h*4 */
function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── distance fields (all in a -50..50 space, origin centre) ─────────────────

const sdRoundRect = (hw, hh, r) => (x, y) => {
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const sdCircle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

const sdSegment = (ax, ay, bx, by, w) => (x, y) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  return Math.hypot(pax - bax * t, pay - bay * t) - w / 2;
};

const union = (...fns) => (x, y) => Math.min(...fns.map((f) => f(x, y)));
const polyline = (pts, w) =>
  union(...pts.slice(1).map((p, i) => sdSegment(pts[i][0], pts[i][1], p[0], p[1], w)));

// ── render ──────────────────────────────────────────────────────────────────

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

/** Paint layers of {sd, color} back-to-front with 4x supersampled coverage. */
function render(layers, size) {
  const px = new Uint8Array(size * size * 4);
  const SS = 4;
  const scale = 100 / size; // map pixel grid onto the -50..50 design space

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const layer of layers) {
        let cov = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const dx = (x + (sx + 0.5) / SS) * scale - 50;
            const dy = (y + (sy + 0.5) / SS) * scale - 50;
            if (layer.sd(dx, dy) <= 0) cov++;
          }
        }
        cov /= SS * SS;
        if (!cov) continue;
        const [lr, lg, lb] = hex(layer.color);
        const la = cov * (layer.alpha ?? 1);
        // source-over
        const na = la + a * (1 - la);
        r = (lr * la + r * a * (1 - la)) / (na || 1);
        g = (lg * la + g * a * (1 - la)) / (na || 1);
        b = (lb * la + b * a * (1 - la)) / (na || 1);
        a = na;
      }
      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

const face = (color) => ({ sd: sdRoundRect(46, 46, 11), color });

const ICONS = {
  category: [face('#1b1b1e'), { sd: polyline([[-16, 0], [-5, 11], [17, -13]], 8), color: '#7aa2f7' }],
  approve: [face('#14301c'), { sd: polyline([[-16, 1], [-5, 12], [16, -11]], 8), color: '#7ad07a' }],
  deny: [face('#331616'), { sd: union(polyline([[-12, -12], [12, 12]], 8), polyline([[12, -12], [-12, 12]], 8)), color: '#f07a7a' }],
  interrupt: [face('#1b1b1e'), { sd: sdRoundRect(11, 11, 3), color: '#f07a7a' }],
  status: [
    face('#1b1b1e'),
    { sd: sdCircle(-14, 0, 4.5), color: '#7aa2f7' },
    { sd: sdCircle(0, 0, 4.5), color: '#7aa2f7' },
    { sd: sdCircle(14, 0, 4.5), color: '#7aa2f7' },
  ],
  voice: [
    face('#1b1b1e'),
    { sd: sdRoundRect(6.5, 15, 6.5), color: '#e9e9ee' },
    { sd: polyline([[0, 20], [0, 26]], 5), color: '#e9e9ee' },
    { sd: polyline([[-13, 22], [13, 22]], 5), color: '#e9e9ee' },
  ],
  dispatch: [face('#1b1b1e'), { sd: polyline([[6, -20], [-10, 2], [0, 2], [-4, 20], [12, -2], [2, -2], [6, -20]], 6), color: '#e0af68' }],
  act: [
    face('#1b1b1e'),
    { sd: polyline([[0, -24], [5, -6], [23, 0], [5, 6], [0, 24], [-5, 6], [-23, 0], [-5, -6], [0, -24]], 5), color: '#e0af68' },
  ],
  keycap: [
    face('#1b1b1e'),
    { sd: sdRoundRect(24, 24, 6), color: '#4a4a52' },
    { sd: sdRoundRect(18, 18, 4), color: '#1b1b1e' },
    { sd: union(polyline([[-9, 0], [9, 0]], 5), polyline([[0, -9], [0, 9]], 5)), color: '#7aa2f7' },
  ],
  usage: [
    face('#1b1b1e'),
    { sd: sdCircle(0, 0, 30), color: '#7aa2f7' },
    { sd: sdCircle(0, 0, 24), color: '#1b1b1e' },
    { sd: sdCircle(0, 0, 17), color: '#e0af68' },
    { sd: sdCircle(0, 0, 11), color: '#1b1b1e' },
  ],
  send: [
    face('#1b1b1e'),
    // paper plane
    { sd: polyline([[-22, 4], [20, -16], [4, 20], [-4, 6], [-22, 4]], 6), color: '#7ad07a' },
  ],
  session: [
    face('#1b1b1e'),
    { sd: polyline([[-12, 16], [-12, -6], [10, -6]], 6), color: '#7aa2f7' },
    { sd: polyline([[3, -13], [11, -6], [3, 1]], 6), color: '#7aa2f7' },
    { sd: sdCircle(-12, 18, 5), color: '#7aa2f7' },
  ],
  dial: [
    face('#1b1b1e'),
    { sd: sdCircle(0, 0, 22), color: '#3a3a40' },
    { sd: sdCircle(0, 0, 15), color: '#1b1b1e' },
    { sd: polyline([[0, -22], [0, -13]], 6), color: '#e0af68' },
  ],
};

mkdirSync(OUT, { recursive: true });
for (const [name, layers] of Object.entries(ICONS)) {
  for (const [suffix, size] of [['', 20], ['@2x', 40]]) {
    const file = join(OUT, `${name}${suffix}.png`);
    writeFileSync(file, encodePng(render(layers, size), size, size));
  }
  // 72px key art doubles as the action's default state image.
  writeFileSync(join(OUT, `${name}-key.png`), encodePng(render(layers, 72), 72, 72));
}

// The marketplace catalogue wants a high-resolution icon named for the bundle
// id, and lives outside the plugin dir — it is submitted to another repo, not
// shipped in the zip.
const CATALOGUE = join(OUT, '..', '..', '..', 'docs', 'art');
mkdirSync(CATALOGUE, { recursive: true });
writeFileSync(
  join(CATALOGUE, 'com.hovell.agentdeck.png'),
  encodePng(render(ICONS.category, 256), 256, 256),
);

console.log(`wrote ${Object.keys(ICONS).length * 3} icons to ${OUT}`);
console.log(`wrote docs/art/com.hovell.agentdeck.png (256px, for the catalogue)`);
