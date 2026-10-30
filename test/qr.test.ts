/**
 * Enrollment by QR code: real decoding (ZXing-C++ in WebAssembly) of generated pictures of a pairing
 * URI, as a camera would see them; and Node, which has no camera, never declares it.
 */

import { describe, expect, it, vi } from "vitest";
import { writeBarcode } from "zxing-wasm/writer";
import { readEnrollment } from "../src/index.js";
import { build, parse } from "../src/node/cli.js";
import { type Camera, cameraQrScanner, type Picture, readQrCodes } from "../src/qr/index.js";

const URI = "nestor+http://192.168.1.20:7860/?code=K7QF2M9X";

/**
 * A camera frame showing `text` as a QR code: `scale` pixels a module, on a grey, noisy background,
 * off-centre, as a phone screen held up to a camera looks.
 */
async function photo(text: string, scale = 4, size = 320): Promise<Picture> {
  const { symbol, error } = await writeBarcode(text, { format: "QRCode" });
  if (error !== "") throw new Error(error);
  const data = new Uint8ClampedArray(size * size * 4);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return (seed % 41) - 20;
  };
  const [left, top] = [37, 51];
  const quiet = 4 * scale;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor((x - left - quiet) / scale);
      const my = Math.floor((y - top - quiet) / scale);
      const inside =
        x >= left &&
        y >= top &&
        x < left + symbol.width * scale + 2 * quiet &&
        y < top + symbol.height * scale + 2 * quiet;
      const module =
        mx >= 0 && my >= 0 && mx < symbol.width && my < symbol.height
          ? (symbol.data[my * symbol.width + mx] ?? 255)
          : 255;
      const value = (inside ? (module === 0 ? 30 : 225) : 128) + noise();
      data.set([value, value, value, 255], (y * size + x) * 4);
    }
  }
  return { data, width: size, height: size };
}

function blank(size = 64): Picture {
  return { data: new Uint8ClampedArray(size * size * 4).fill(200), width: size, height: size };
}

describe("reading a QR code", () => {
  it("finds the pairing URI in a camera frame, and the enrollment code in it", async () => {
    const texts = await readQrCodes(await photo(URI));
    expect(texts).toEqual([URI]);
    expect(readEnrollment(texts[0] ?? "")).toEqual({ core: "http://192.168.1.20:7860", code: "K7QF2M9X" });
  });

  it("finds nothing in a frame without a QR code", async () => {
    expect(await readQrCodes(blank())).toEqual([]);
  });
});

describe("the camera scanner", () => {
  class FakeCamera implements Camera {
    opened = false;
    closed = false;
    constructor(private readonly frames: (Picture | null)[]) {}
    async open() {
      this.opened = true;
    }
    frame() {
      return this.frames.length > 1 ? (this.frames.shift() ?? null) : (this.frames[0] ?? null);
    }
    close() {
      this.closed = true;
    }
  }

  it("hands over what it reads, frame after frame, until stopped; then closes the camera", async () => {
    const camera = new FakeCamera([null, blank(), await photo(URI)]);
    const found = vi.fn();
    const stop = new AbortController();
    const scanning = cameraQrScanner({ camera, intervalMs: 1 }).scan(found, stop.signal);
    await vi.waitUntil(() => found.mock.calls.length >= 2);
    stop.abort();
    await scanning;
    expect(found).toHaveBeenCalledWith(URI);
    expect(camera.closed).toBe(true);
  });

  it("rejects when the camera does not open", async () => {
    const camera: Camera = {
      open: () => Promise.reject(new Error("NotAllowedError: Permission denied")),
      frame: () => null,
      close: () => {},
    };
    await expect(cameraQrScanner({ camera }).scan(() => {}, new AbortController().signal)).rejects.toThrow(
      /Permission denied/,
    );
  });

  it("in Node, has no camera to open", async () => {
    await expect(cameraQrScanner().scan(() => {}, new AbortController().signal)).rejects.toThrow(/camera/);
  });
});

it("a Node satellite never declares enrollment.qr: it has no camera", () => {
  for (const output of ["none", "aplay -q -"]) {
    const args = parse(["run", "--core", "http://c", "--room", "salon", "--input", "none", "--output", output], {});
    const satellite = build(args as never, { debug() {}, info() {}, warn() {} });
    expect(satellite.manifest.pairingMethods).not.toContain("enrollment.qr");
  }
});
