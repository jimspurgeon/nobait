/**
 * Generates placeholder PNG icons (48px and 96px) into public/icons/.
 * Uses zero-dep PNG encoding via a tiny solid-color generator ( zlib ).
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(size * (size * 3 + 1), 0);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const i = rowStart + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir("public/icons", { recursive: true });
await writeFile("public/icons/48.png", png(48, [22, 163, 74])); // green placeholder
await writeFile("public/icons/96.png", png(96, [22, 163, 74]));
console.log("wrote public/icons/48.png, public/icons/96.png");
