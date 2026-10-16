import { deflateSync } from 'node:zlib';

// Channels that only accept image-to-video receive this image on text-to-video
// requests. It is opaque black: an alpha channel is dropped or rejected
// unpredictably upstream, and when a channel uses the image as the first frame
// black reads as a fade-in instead of a white flash. Sizes follow the request
// ratio so the image never changes the output framing, and stay within the
// common 300–6000 px and 0.4–2.5 ratio limits of image-to-video inputs.
const PLACEHOLDER_SIZES = Object.freeze({
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '1:1': [960, 960],
  '4:3': [960, 720],
  '3:4': [720, 960],
  '21:9': [1680, 720],
});

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function solidBlackPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB, no alpha
  // Every scanline is a zero filter byte followed by black RGB pixels.
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const cache = new Map();

/** Returns the placeholder PNG and its size for a video aspect ratio. */
export function placeholderReferenceImage(aspectRatio) {
  const ratio = Object.hasOwn(PLACEHOLDER_SIZES, aspectRatio) ? aspectRatio : '16:9';
  if (!cache.has(ratio)) {
    const [width, height] = PLACEHOLDER_SIZES[ratio];
    cache.set(ratio, { buffer: solidBlackPng(width, height), width, height, mimeType: 'image/png' });
  }
  return cache.get(ratio);
}
