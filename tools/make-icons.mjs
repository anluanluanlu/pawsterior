// Rasterises the paw icon (same geometry as icons/icon.svg) to PNG with no dependencies.
// Usage: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [0x1d, 0x21, 0x31];
const FG = [0xa9, 0xb8, 0xff];
// Shapes in a 512-unit box: [cx, cy, rx, ry]
const PAW = [[256, 322, 104, 84], [148, 214, 38, 38], [214, 150, 41, 41], [298, 150, 41, 41], [364, 214, 38, 38]];

function render(size, { maskable }) {
  const SS = 4; // supersampling per axis
  const radius = maskable ? 0 : 112;
  const scale = maskable ? 0.72 : 1; // keep the paw inside the maskable safe zone
  const px = Buffer.alloc(size * size * 4);
  const inRoundRect = (x, y) => {
    if (radius === 0) return true;
    const cx = Math.min(Math.max(x, radius), 512 - radius);
    const cy = Math.min(Math.max(y, radius), 512 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  };
  const inPaw = (x, y) => {
    const ux = 256 + (x - 256) / scale, uy = 256 + (y - 256) / scale;
    return PAW.some(([cx, cy, rx, ry]) => ((ux - cx) / rx) ** 2 + ((uy - cy) / ry) ** 2 <= 1);
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((i + (sx + 0.5) / SS) / size) * 512;
          const y = ((j + (sy + 0.5) / SS) / size) * 512;
          if (!inRoundRect(x, y)) continue;
          if (inPaw(x, y)) fg++; else bg++;
        }
      }
      const cover = (bg + fg) / (SS * SS), o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = cover ? Math.round((BG[c] * bg + FG[c] * fg) / (bg + fg)) : 0;
      px[o + 3] = Math.round(cover * 255);
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
writeFileSync(new URL('icon-192.png', out), render(192, { maskable: false }));
writeFileSync(new URL('icon-512.png', out), render(512, { maskable: false }));
writeFileSync(new URL('maskable-512.png', out), render(512, { maskable: true }));
console.log('Wrote icons/icon-192.png, icon-512.png, maskable-512.png');
