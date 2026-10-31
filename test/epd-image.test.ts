import { describe, expect, test } from "bun:test";
import {
  FRAME_BYTES,
  WIDTH,
  HEIGHT,
  buildFrame,
  checksum,
  dither,
  invert,
  pack,
  packedToRgba,
  toGray,
  unpack,
} from "../web/epd-image.js";

const N = WIDTH * HEIGHT;

function solid(r: number, g: number, b: number, a = 255) {
  const px = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) px.set([r, g, b, a], i * 4);
  return px;
}

describe("pack layout (matches firmware epd.h)", () => {
  test("always 5000 bytes", () => {
    expect(pack(new Uint8Array(N)).length).toBe(FRAME_BYTES);
    expect(FRAME_BYTES).toBe(5000);
  });

  test("row-major, 25 bytes per row, MSB is leftmost, 1 = white", () => {
    const bits = new Uint8Array(N); // all black
    bits[0] = 1; // (0,0)
    bits[9] = 1; // (9,0) -> byte 1, bit 6
    bits[WIDTH * 3 + 199] = 1; // (199,3) -> byte 3*25+24, bit 0
    const p = pack(bits);
    expect(p[0]).toBe(0x80);
    expect(p[1]).toBe(0x40);
    expect(p[3 * 25 + 24]).toBe(0x01);
    expect(p.reduce((n, b) => n + (b ? 1 : 0), 0)).toBe(3);
  });

  test("unpack inverts pack", () => {
    const bits = Uint8Array.from({ length: N }, (_, i) => ((i * 7919) >> 3) & 1);
    expect(unpack(pack(bits))).toEqual(bits);
  });
});

describe("dithering", () => {
  for (const method of ["floyd-steinberg", "atkinson", "threshold"]) {
    test(`${method}: white -> all 0xFF, black -> all 0x00`, () => {
      expect(pack(dither(toGray(solid(255, 255, 255)), method)).every((b) => b === 0xff)).toBe(true);
      expect(pack(dither(toGray(solid(0, 0, 0)), method)).every((b) => b === 0x00)).toBe(true);
    });
  }

  test("floyd-steinberg: 50% grey -> 45-55% black", () => {
    const bits = dither(toGray(solid(128, 128, 128)), "floyd-steinberg");
    const black = bits.reduce((n, b) => n + (b ? 0 : 1), 0) / N;
    expect(black).toBeGreaterThan(0.45);
    expect(black).toBeLessThan(0.55);
  });

  test("transparent pixels are paper white", () => {
    expect(dither(toGray(solid(0, 0, 0, 0)), "threshold").every((b) => b === 1)).toBe(true);
  });

  test("invert flips every pixel", () => {
    const bits = dither(toGray(solid(255, 255, 255)), "threshold");
    expect(invert(bits).every((b) => b === 0)).toBe(true);
  });

  test("brightness and contrast move a mid-grey the right way", () => {
    const g = (opts: object) => toGray(solid(128, 128, 128), opts)[0];
    expect(g({ brightness: 50 })).toBeGreaterThan(g({}));
    expect(g({ brightness: -50 })).toBeLessThan(g({}));
    const light = toGray(solid(170, 170, 170));
    const lighter = toGray(solid(170, 170, 170), { contrast: 50 });
    expect(lighter[0]).toBeGreaterThan(light[0]);
  });
});

describe("frame", () => {
  test("EPD1 + 5000 bytes + uint16 LE sum", () => {
    const packed = Uint8Array.from({ length: FRAME_BYTES }, (_, i) => (i * 31 + 7) & 0xff);
    const f = buildFrame(packed);
    expect(f.length).toBe(4 + 5000 + 2);
    expect(new TextDecoder().decode(f.slice(0, 4))).toBe("EPD1");
    expect(f.slice(4, 5004)).toEqual(packed);
    const sum = checksum(packed);
    expect(f[5004] | (f[5005] << 8)).toBe(sum);
  });

  test("checksum wraps at 16 bits", () => {
    expect(checksum(new Uint8Array(FRAME_BYTES).fill(0xff))).toBe((5000 * 255) & 0xffff);
  });

  test("rejects a wrong-size buffer", () => {
    expect(() => buildFrame(new Uint8Array(10))).toThrow();
  });
});

describe("preview is drawn from the packed bytes that get sent", () => {
  test("packedToRgba pixel colour follows the packed bit", () => {
    const bits = new Uint8Array(N);
    bits[1] = 1;
    const rgba = packedToRgba(pack(bits), [0, 0, 0], [255, 255, 255]);
    expect(Array.from(rgba.slice(0, 8))).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});
