/**
 * `@nestor-home/satellite/qr`: a browser satellite reads the pairing URI's QR code with its camera
 * (`enrollment.qr`). Frames from `getUserMedia({video})` are decoded by ZXing-C++ compiled to
 * WebAssembly (`zxing-wasm`, an optional peer dependency: `pnpm add zxing-wasm`).
 *
 *     pairing: { scanner: cameraQrScanner({ wasmUrl }) }
 *
 * By default `zxing-wasm` fetches its WebAssembly from the jsDelivr CDN: give `wasmUrl` to serve it
 * yourself (with Vite: `import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url"`), so the page
 * works offline. Node has no camera: nothing there declares `enrollment.qr`.
 */

import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import type { QrScanner } from "../satellite.js";

/** A camera frame, as RGBA pixels (an `ImageData` fits). */
export interface Picture {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
}

/** Where the frames come from: `browserCamera()`, or a double in tests. */
export interface Camera {
  /** Open the camera; rejects when it cannot (no camera, permission refused, not a secure context). */
  open(): Promise<void>;
  /** The latest frame, or `null` when none is ready yet. */
  frame(): Picture | null;
  close(): void;
}

export interface CameraQrScannerOptions {
  /** The camera (default: `browserCamera()`). */
  readonly camera?: Camera;
  /** Time between two frames read (default 250 ms). */
  readonly intervalMs?: number;
  /** Where `zxing_reader.wasm` is served (default: the jsDelivr CDN). */
  readonly wasmUrl?: string;
}

/** The texts of the QR codes in a picture. */
export async function readQrCodes(picture: Picture): Promise<string[]> {
  // zxing-wasm reads any {data, width, height} as pixels (it checks those three fields, not the class).
  const results = await readBarcodes(picture as ImageData, {
    formats: ["QRCode"],
    tryHarder: true,
    maxNumberOfSymbols: 4,
  });
  return results.filter((result) => result.isValid).map((result) => result.text);
}

/** Reads QR codes with a camera, a few frames a second, while the satellite waits to be paired. */
export function cameraQrScanner(options: CameraQrScannerOptions = {}): QrScanner {
  const { wasmUrl, intervalMs = 250 } = options;
  if (wasmUrl !== undefined) {
    prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
    });
  }
  return {
    async scan(found, signal) {
      const camera = options.camera ?? browserCamera();
      signal.throwIfAborted();
      await camera.open();
      try {
        while (!signal.aborted) {
          const picture = camera.frame();
          if (picture !== null) for (const text of await readQrCodes(picture)) found(text);
          await pause(intervalMs, signal);
        }
      } finally {
        camera.close();
      }
    },
  };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The longest side of a frame read: enough for a QR code held up to the camera, cheap to decode. */
const MAX_SIDE = 960;

/**
 * The browser's camera (`getUserMedia`), the one facing away from the screen when there are two.
 * Browsers only open it in a secure context (`https:` or `http://localhost`), after the person allows it.
 */
export function browserCamera(video: MediaTrackConstraints = { facingMode: "environment" }): Camera {
  let stream: MediaStream | null = null;
  let element: HTMLVideoElement | null = null;
  let canvas: OffscreenCanvas | null = null;
  return {
    async open() {
      const devices = globalThis.navigator?.mediaDevices;
      if (devices === undefined) throw new Error("this page cannot open a camera (needs https or localhost)");
      stream = await devices.getUserMedia({ video, audio: false });
      element = document.createElement("video");
      element.muted = true;
      element.playsInline = true;
      element.srcObject = stream;
      await element.play();
    },
    frame() {
      if (element === null || element.readyState < element.HAVE_CURRENT_DATA || element.videoWidth === 0) return null;
      const scale = Math.min(1, MAX_SIDE / Math.max(element.videoWidth, element.videoHeight));
      const width = Math.round(element.videoWidth * scale);
      const height = Math.round(element.videoHeight * scale);
      if (canvas === null || canvas.width !== width || canvas.height !== height)
        canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return null;
      context.drawImage(element, 0, 0, width, height);
      return context.getImageData(0, 0, width, height);
    },
    close() {
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (element !== null) element.srcObject = null;
      stream = element = canvas = null;
    },
  };
}
