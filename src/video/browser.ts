/**
 * The browser's camera, and a test pattern drawn on a canvas, as the satellite's `Camera`: video on
 * the browser's own `RTCPeerConnection`, still pictures as JPEG through a canvas.
 *
 * The SDK opens the camera only for a session a person opened, or a still picture, and closes it
 * after: browsers show their own recording light meanwhile. They only open a camera in a secure
 * context (`https:` or `http://localhost`).
 */

import type { Peer, PeerEvents, Voice } from "../audio.js";
import { describe, type Logger, quietLogger } from "../log.js";
import type { Camera } from "../media.js";
import { audioBridge, W3cPeer, type W3cPeerConnectionConstructor, type W3cTrack } from "../voice/w3c.js";

/** What this module needs of a `<canvas>` (an `HTMLCanvasElement` fits). */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: "2d"): CanvasContextLike | null;
  toBlob(done: (blob: { arrayBuffer(): Promise<ArrayBuffer> } | null) => void, type: string, quality: number): void;
  captureStream?(fps: number): { getVideoTracks(): W3cTrack[] };
}

/** The part of `CanvasRenderingContext2D` this module draws with. */
export interface CanvasContextLike {
  fillStyle: unknown;
  font: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(image: unknown, x: number, y: number, width: number, height: number): void;
}

interface VideoElementLike {
  srcObject: unknown;
  muted: boolean;
  playsInline: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  play(): Promise<void>;
}

interface VideoGlobals {
  RTCPeerConnection?: W3cPeerConnectionConstructor;
  MediaStream?: new (tracks: W3cTrack[]) => unknown;
  document?: { createElement(tag: "canvas" | "video"): unknown };
  navigator?: {
    mediaDevices?: { getUserMedia(constraints: { video: unknown }): Promise<{ getVideoTracks(): W3cTrack[] }> };
  };
}

interface CommonOptions {
  /** JPEG quality of still pictures, from 0 to 1 (default 0.85). */
  readonly quality?: number;
  /** STUN/TURN URLs, only needed beyond the local network. */
  readonly iceServers?: readonly string[];
  readonly logger?: Logger;
}

export interface BrowserCameraOptions extends CommonOptions {
  /** Constraints for `getUserMedia({video})` (default: 1280×720). */
  readonly video?: Readonly<Record<string, unknown>>;
}

export interface PatternCameraOptions extends CommonOptions {
  readonly width?: number;
  readonly height?: number;
  /** Images per second (default 15). */
  readonly fps?: number;
}

/** Where a camera's images come from: a track while it is open, and a still picture of it. */
interface VideoSource {
  open(): Promise<W3cTrack>;
  /** The latest image, drawn on `canvas` at its size. */
  draw(canvas: CanvasLike): Promise<void>;
  close(): void;
}

const DEFAULT_VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 } };

/** The page's camera: `new Satellite({ camera: browserCamera(), … })` declares `video.capture`. */
export function browserCamera(options: BrowserCameraOptions = {}): Camera {
  return new W3cCamera(new UserMedia(options.video ?? DEFAULT_VIDEO), options);
}

/**
 * Colour bars and a moving stripe drawn on a canvas, as a camera: to try a satellite that films, or
 * test one, without a camera.
 */
export function patternCamera(options: PatternCameraOptions = {}): Camera {
  return new W3cCamera(new Pattern(options.width ?? 640, options.height ?? 360, options.fps ?? 15), options);
}

class W3cCamera implements Camera {
  private track: W3cTrack | null = null;
  private readonly logger: Logger;

  constructor(
    private readonly source: VideoSource,
    private readonly options: CommonOptions,
  ) {
    this.logger = options.logger ?? quietLogger;
  }

  async open(): Promise<void> {
    this.track = await this.source.open();
  }

  async close(): Promise<void> {
    this.track?.stop();
    this.track = null;
    this.source.close();
  }

  async still(): Promise<Uint8Array> {
    const canvas = element<CanvasLike>("canvas");
    await this.source.draw(canvas);
    const blob = await new Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", this.options.quality ?? 0.85);
    });
    if (blob === null) throw new Error("the browser made no JPEG of the camera's image");
    return new Uint8Array(await blob.arrayBuffer());
  }

  createPeer(events: PeerEvents, call: Voice | null): Peer {
    const Connection = globals().RTCPeerConnection;
    if (Connection === undefined) throw new Error("this browser has no WebRTC (RTCPeerConnection)");
    if (this.track === null) throw new Error("open the camera before creating a peer");
    const audio = call === null ? null : audioBridge(call);
    if (call !== null && audio === null) throw new Error("a call through the camera needs a voice of this SDK");
    return new W3cPeer(Connection, { audio, video: this.track }, events, this.options.iceServers ?? [], this.logger);
  }
}

/** The camera through `getUserMedia`. */
class UserMedia implements VideoSource {
  private track: W3cTrack | null = null;
  private video: VideoElementLike | null = null;

  constructor(private readonly constraints: Readonly<Record<string, unknown>>) {}

  async open(): Promise<W3cTrack> {
    const devices = globals().navigator?.mediaDevices;
    if (devices === undefined) throw new Error("this page cannot open a camera (it needs https or localhost)");
    let stream: { getVideoTracks(): W3cTrack[] };
    try {
      stream = await devices.getUserMedia({ video: this.constraints });
    } catch (error) {
      throw new Error(`the camera did not open: ${describe(error)}`);
    }
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error("the camera gave no video track");
    this.track = track;
    return track;
  }

  async draw(canvas: CanvasLike): Promise<void> {
    if (this.track === null) throw new Error("the camera is not open");
    if (this.video === null) {
      const Stream = globals().MediaStream;
      if (Stream === undefined) throw new Error("this browser has no MediaStream");
      const video = element<VideoElementLike>("video");
      video.muted = video.playsInline = true;
      video.srcObject = new Stream([this.track]);
      await video.play();
      this.video = video;
    }
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    context(canvas).drawImage(this.video, 0, 0, canvas.width, canvas.height);
  }

  close(): void {
    if (this.video !== null) this.video.srcObject = null;
    this.video = null;
    this.track = null;
  }
}

/** A test pattern on a canvas, redrawn `fps` times a second while open. */
class Pattern implements VideoSource {
  private readonly canvas: CanvasLike;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  constructor(
    width: number,
    height: number,
    private readonly fps: number,
  ) {
    this.canvas = element<CanvasLike>("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
  }

  async open(): Promise<W3cTrack> {
    if (this.canvas.captureStream === undefined) throw new Error("this browser cannot film a canvas");
    this.paint();
    this.timer ??= setInterval(() => this.paint(), 1000 / this.fps);
    const track = this.canvas.captureStream(this.fps).getVideoTracks()[0];
    if (track === undefined) throw new Error("the canvas gave no video track");
    return track;
  }

  async draw(canvas: CanvasLike): Promise<void> {
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    context(canvas).drawImage(this.canvas, 0, 0, canvas.width, canvas.height);
  }

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private paint(): void {
    const { width, height } = this.canvas;
    const draw = context(this.canvas);
    const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
    bars.forEach((colour, i) => {
      draw.fillStyle = colour;
      draw.fillRect((i * width) / bars.length, 0, width / bars.length + 1, height);
    });
    draw.fillStyle = "#101010";
    draw.fillRect(((this.frame * 4) % (width + 40)) - 40, 0, 40, height); // it moves: the video is live
    draw.font = `${Math.round(height / 12)}px monospace`;
    draw.fillStyle = "#ffffff";
    draw.fillText(new Date().toISOString().slice(11, 19), width / 20, height - height / 20);
    this.frame += 1;
  }
}

function globals(): VideoGlobals {
  return globalThis as VideoGlobals;
}

function element<T>(tag: "canvas" | "video"): T {
  const document = globals().document;
  if (document === undefined) throw new Error("a browser camera needs a page (document)");
  return document.createElement(tag) as T;
}

function context(canvas: CanvasLike): CanvasContextLike {
  const draw = canvas.getContext("2d");
  if (draw === null) throw new Error("the canvas cannot be drawn on");
  return draw;
}
