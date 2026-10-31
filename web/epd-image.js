// Image -> 1-bit panel buffer for the Waveshare 1.54" 200x200 e-paper.
// Pure functions, no DOM, so they run under `bun test` as well as the browser.
//
// Buffer layout (matches firmware/eink_webserial/epd.h): 5000 bytes,
// row-major, 25 bytes per row, MSB = leftmost pixel, bit 1 = white.

export const WIDTH = 200;
export const HEIGHT = 200;
export const FRAME_BYTES = (WIDTH * HEIGHT) / 8;
export const MAGIC = new Uint8Array([0x45, 0x50, 0x44, 0x31]); // "EPD1"
export const HELLO_PREFIX = "EPD-WEBSERIAL v1";

// RGBA pixels -> luminance 0..255 with brightness (-100..100) and contrast (-100..100).
// Transparent pixels count as white paper.
export function toGray(rgba, { brightness = 0, contrast = 0 } = {}) {
  const n = rgba.length / 4;
  const gray = new Float32Array(n);
  const k = (100 + contrast) / 100;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const lum = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    const onWhite = lum * a + 255 * (1 - a);
    gray[i] = clamp((onWhite - 128) * k + 128 + brightness * 1.28);
  }
  return gray;
}

const KERNELS = {
  // [dx, dy, weight]
  "floyd-steinberg": { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  atkinson: { div: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
};

// Luminance -> one value per pixel, 1 = white, 0 = black.
export function dither(gray, method = "floyd-steinberg", width = WIDTH, height = HEIGHT) {
  const bits = new Uint8Array(width * height);
  const kernel = KERNELS[method];
  if (!kernel) {
    for (let i = 0; i < bits.length; i++) bits[i] = gray[i] >= 128 ? 1 : 0;
    return bits;
  }
  const err = Float32Array.from(gray);
  // Serpentine scan (alternate row direction) avoids the streaks a one-way scan leaves.
  for (let y = 0; y < height; y++) {
    const dir = y % 2 === 0 ? 1 : -1;
    for (let k = 0; k < width; k++) {
      const x = dir === 1 ? k : width - 1 - k;
      const i = y * width + x;
      const white = err[i] >= 128;
      bits[i] = white ? 1 : 0;
      const e = (err[i] - (white ? 255 : 0)) / kernel.div;
      for (const [dx, dy, w] of kernel.taps) {
        const nx = x + dx * dir;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny < height) err[ny * width + nx] += e * w;
      }
    }
  }
  return bits;
}

export function invert(bits) {
  return bits.map((b) => b ^ 1);
}

export function pack(bits) {
  const out = new Uint8Array(FRAME_BYTES);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

export function unpack(packed) {
  const bits = new Uint8Array(packed.length * 8);
  for (let i = 0; i < bits.length; i++) bits[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1;
  return bits;
}

export function checksum(packed) {
  let sum = 0;
  for (const b of packed) sum = (sum + b) & 0xffff;
  return sum;
}

// "EPD1" + 5000 image bytes + uint16 LE sum, as parsed by firmware/frame_parser.h.
export function buildFrame(packed) {
  if (packed.length !== FRAME_BYTES) throw new Error(`expected ${FRAME_BYTES} bytes, got ${packed.length}`);
  const sum = checksum(packed);
  const out = new Uint8Array(MAGIC.length + FRAME_BYTES + 2);
  out.set(MAGIC, 0);
  out.set(packed, MAGIC.length);
  out[out.length - 2] = sum & 0xff;
  out[out.length - 1] = sum >> 8;
  return out;
}

// Packed buffer -> RGBA for drawing the preview, so the preview shows the exact bytes sent.
export function packedToRgba(packed, ink = [0x1a, 0x1a, 0x1a], paper = [0xe8, 0xe6, 0xdf]) {
  const bits = unpack(packed);
  const rgba = new Uint8ClampedArray(bits.length * 4);
  for (let i = 0; i < bits.length; i++) {
    const c = bits[i] ? paper : ink;
    rgba.set(c, i * 4);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
