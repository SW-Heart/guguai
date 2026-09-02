// Rasterises the GuGu AI menu-bar glyph into PNG template images.
//
// Electron's nativeImage only decodes PNG and JPEG, so the previous SVG data
// URL produced an empty image and macOS rendered an invisible status item.
// Run this script whenever the mark changes:
//   node scripts/generate-tray-icons.mjs
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(path.dirname(here), 'desktop', 'assets');

// The logo mark is two rounded bars rotated -38° inside a 64×64 viewBox. Each
// bar is a capsule: the set of points within `radius` of its centre segment.
const capsules = [
  { ax: 17.514, ay: 26.849, bx: 32.486, by: 15.151, radius: 4.5 },
  { ax: 31.514, ay: 48.849, bx: 46.486, by: 37.151, radius: 4.5 },
];

function bounds() {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const { ax, ay, bx, by, radius } of capsules) {
    minX = Math.min(minX, ax - radius, bx - radius);
    minY = Math.min(minY, ay - radius, by - radius);
    maxX = Math.max(maxX, ax + radius, bx + radius);
    maxY = Math.max(maxY, ay + radius, by + radius);
  }
  return { minX, minY, maxX, maxY };
}

function insideGlyph(x, y) {
  for (const { ax, ay, bx, by, radius } of capsules) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
    const px = ax + t * dx - x;
    const py = ay + t * dy - y;
    if (px * px + py * py <= radius * radius) return true;
  }
  return false;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0; // no filter
    rgba.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// macOS template images carry only coverage, so paint the mark in solid black
// and let the system tint it for the light or dark menu bar.
function renderTemplate(size, glyphHeight, samples = 4) {
  const { minX, minY, maxX, maxY } = bounds();
  const scale = glyphHeight / (maxY - minY);
  const glyphWidth = (maxX - minX) * scale;
  const offsetX = (size - glyphWidth) / 2;
  const offsetY = (size - glyphHeight) / 2;
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / samples;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = minX + (px + (sx + 0.5) * step - offsetX) / scale;
          const y = minY + (py + (sy + 0.5) * step - offsetY) / scale;
          if (insideGlyph(x, y)) hits += 1;
        }
      }
      if (!hits) continue;
      const index = (py * size + px) * 4;
      rgba[index + 3] = Math.round((hits / (samples * samples)) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const targets = [
  { file: 'trayTemplate.png', size: 18, glyphHeight: 16 },
  { file: 'trayTemplate@2x.png', size: 36, glyphHeight: 32 },
];

fs.mkdirSync(assetsDir, { recursive: true });
for (const { file, size, glyphHeight } of targets) {
  const target = path.join(assetsDir, file);
  fs.writeFileSync(target, renderTemplate(size, glyphHeight));
  console.log(`[tray-icons] ${path.relative(process.cwd(), target)} (${size}×${size})`);
}
