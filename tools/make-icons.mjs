// Renders the calm-cat icon to icons/icon.svg and PNGs with no dependencies.
// The geometry below is the single source of truth for both outputs.
// Usage: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = '#1d2131';
const FUR = '#a9b8ff';
const EAR = '#8796e6';
const PINK = '#f3a5bf';

// Layers in a 512-unit box, painted in order.
//  ellipse: [cx, cy, rx, ry]
//  poly:    points, rounded by a stroke of width `round`
//  curve:   quadratic BÃ©ziers [x0,y0, cx,cy, x1,y1], stroked with round caps
const LAYERS = [
  // whiskers (start inside the head, so only the outer part shows)
  { type: 'curve', color: FUR, alpha: 0.55, width: 7, paths: [
    [150, 334, 100, 326, 52, 316], [150, 350, 100, 354, 56, 366],
    [362, 334, 412, 326, 460, 316], [362, 350, 412, 354, 456, 366],
  ] },
  { type: 'poly', color: FUR, round: 28, points: [[136, 222], [150, 104], [240, 188]] },
  { type: 'poly', color: FUR, round: 28, points: [[376, 222], [362, 104], [272, 188]] },
  { type: 'poly', color: EAR, round: 14, points: [[158, 212], [166, 146], [212, 188]] },
  { type: 'poly', color: EAR, round: 14, points: [[354, 212], [346, 146], [300, 188]] },
  { type: 'ellipse', color: FUR, shapes: [[256, 300, 152, 124]] },
  // blush
  { type: 'ellipse', color: PINK, alpha: 0.35, shapes: [[176, 340, 24, 13], [336, 340, 24, 13]] },
  // closed, relaxed eyes
  { type: 'curve', color: BG, width: 13, paths: [[174, 294, 205, 324, 236, 294], [276, 294, 307, 324, 338, 294]] },
  { type: 'poly', color: PINK, round: 10, points: [[242, 330], [270, 330], [256, 345]] },
  // mouth
  { type: 'curve', color: BG, width: 7, paths: [[256, 349, 251, 367, 234, 363], [256, 349, 261, 367, 278, 363]] },
];

// ---------- SVG ----------
function svg() {
  const a = (l) => (l.alpha ? ` opacity="${l.alpha}"` : '');
  const pts = (p) => p.map((q) => q.join(',')).join(' ');
  const body = LAYERS.map((l) => {
    if (l.type === 'ellipse') return l.shapes.map(([cx, cy, rx, ry]) =>
      `  <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${l.color}"${a(l)}/>`).join('\n');
    if (l.type === 'poly') return `  <polygon points="${pts(l.points)}" fill="${l.color}" stroke="${l.color}" stroke-width="${l.round}" stroke-linejoin="round"${a(l)}/>`;
    const d = l.paths.map(([x0, y0, cx, cy, x1, y1]) => `M${x0} ${y0}Q${cx} ${cy} ${x1} ${y1}`).join('');
    return `  <path d="${d}" fill="none" stroke="${l.color}" stroke-width="${l.width}" stroke-linecap="round"${a(l)}/>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n  <rect width="512" height="512" rx="112" fill="${BG}"/>\n${body}\n</svg>\n`;
}

// ---------- raster ----------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}

function nearPolyline(x, y, pts, r) {
  for (let k = 1; k < pts.length; k++) {
    if (segDist2(x, y, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]) <= r * r) return true;
  }
  return false;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bezier([x0, y0, cx, cy, x1, y1], n = 32) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1];
  });
}

const HITS = LAYERS.map((l) => {
  const color = rgb(l.color), alpha = l.alpha ?? 1;
  if (l.type === 'ellipse') return { color, alpha, hit: (x, y) =>
    l.shapes.some(([cx, cy, rx, ry]) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) };
  if (l.type === 'poly') {
    const ring = [...l.points, l.points[0]];
    return { color, alpha, hit: (x, y) => inPolygon(x, y, l.points) || nearPolyline(x, y, ring, l.round / 2) };
  }
  const lines = l.paths.map((p) => bezier(p));
  return { color, alpha, hit: (x, y) => lines.some((pts) => nearPolyline(x, y, pts, l.width / 2)) };
});

function render(size, { maskable }) {
  const SS = 4; // supersampling per axis
  const radius = maskable ? 0 : 112;
  const scale = maskable ? 0.72 : 1; // keep the cat inside the maskable safe zone
  const bg = rgb(BG);
  const px = Buffer.alloc(size * size * 4);
  const inRoundRect = (x, y) => {
    if (radius === 0) return true;
    const cx = Math.min(Math.max(x, radius), 512 - radius);
    const cy = Math.min(Math.max(y, radius), 512 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((i + (sx + 0.5) / SS) / size) * 512;
          const y = ((j + (sy + 0.5) / SS) / size) * 512;
          if (!inRoundRect(x, y)) continue;
          const ux = 256 + (x - 256) / scale, uy = 256 + (y - 256) / scale;
          const c = [...bg];
          for (const { color, alpha, hit } of HITS) {
            if (hit(ux, uy)) for (let k = 0; k < 3; k++) c[k] += (color[k] - c[k]) * alpha;
          }
          for (let k = 0; k < 3; k++) sum[k] += c[k];
          covered++;
        }
      }
      const o = (j * size + i) * 4;
      for (let k = 0; k < 3; k++) px[o + k] = covered ? Math.round(sum[k] / covered) : 0;
      px[o + 3] = Math.round((covered / (SS * SS)) * 255);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  let c = 0xffffffff;
  for (const b of td) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, crc]);
}

const out = new URL('../icons/', import.meta.url);
writeFileSync(new URL('icon.svg', out), svg());
writeFileSync(new URL('icon-192.png', out), render(192, { maskable: false }));
writeFileSync(new URL('icon-512.png', out), render(512, { maskable: false }));
writeFileSync(new URL('maskable-512.png', out), render(512, { maskable: true }));
console.log('Wrote icons/icon.svg, icon-192.png, icon-512.png, maskable-512.png');
