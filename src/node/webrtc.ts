/**
 * WebRTC in Node through `@roamhq/wrtc` (libwebrtc, the browsers' own stack): the standard
 * `RTCPeerConnection`, with Opus, jitter buffer and RTCP done natively, plus its non-standard
 * `RTCAudioSource`/`RTCAudioSink` to exchange PCM with an `AudioSource`/`AudioSink`.
 *
 * `@roamhq/wrtc` is an optional peer dependency, loaded only when a satellite opens.
 */

import { describe, type Logger, quietLogger } from "../log.js";
import { type AudioBridge, W3cPeer, type W3cPeerConnectionConstructor, type W3cTrack } from "../w3c.js";
import type { MediaNeeds, Peer, PeerOptions, WebRtc } from "../webrtc.js";
import { type AudioSink, type AudioSource, DiscardSink, SilenceSource } from "./audio.js";

/** 10 ms of audio, what `RTCAudioSource.onData` takes. */
export interface RTCAudioData {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  readonly bitsPerSample?: number;
  readonly channelCount?: number;
  readonly numberOfFrames?: number;
}

/** The part of `@roamhq/wrtc` this adapter uses. */
export interface WrtcModule {
  readonly RTCPeerConnection: W3cPeerConnectionConstructor;
  readonly nonstandard: {
    readonly RTCAudioSource: new () => { createTrack(): W3cTrack; onData(data: RTCAudioData): void };
    readonly RTCAudioSink: new (track: W3cTrack) => { ondata: ((data: RTCAudioData) => void) | null; stop(): void };
  };
}

export interface NodeWebRtcOptions {
  /** The microphone; required when `audio.capture` is declared (`SilenceSource` for none). */
  readonly source?: AudioSource;
  /** The speaker; the core's audio is dropped without one. */
  readonly sink?: AudioSink;
  /** The WebRTC library (default: `import("@roamhq/wrtc")`). */
  readonly wrtc?: WrtcModule | (() => Promise<WrtcModule>);
  readonly logger?: Logger;
}

const WRTC = "@roamhq/wrtc";

export function nodeWebRtc(options: NodeWebRtcOptions = {}): WebRtc {
  return new NodeWebRtc(options);
}

export async function loadWrtc(): Promise<WrtcModule> {
  try {
    const loaded = (await import(WRTC)) as { default?: WrtcModule } & Partial<WrtcModule>;
    return (loaded.default ?? loaded) as WrtcModule;
  } catch (error) {
    throw new Error(
      `a Node satellite needs the optional peer dependency ${WRTC} (\`pnpm add ${WRTC}\`): ${describe(error)}`,
    );
  }
}

class NodeWebRtc implements WebRtc, AudioBridge {
  private readonly logger: Logger;
  private wrtc: WrtcModule | null = null;
  private source: AudioSource | null = null;
  private sink: AudioSink | null = null;
  private track: W3cTrack | null = null;
  private pumping: Promise<void> | null = null;
  private open_ = false;

  constructor(private readonly options: NodeWebRtcOptions) {
    this.logger = options.logger ?? quietLogger;
  }

  async open(needs: MediaNeeds): Promise<void> {
    const { wrtc = loadWrtc } = this.options;
    this.wrtc = typeof wrtc === "function" ? await wrtc() : wrtc;
    if (needs.capture && this.options.source === undefined) {
      throw new Error("audio.capture is declared but no audio source was given (SilenceSource for none)");
    }
    const source: AudioSource = needs.capture && this.options.source ? this.options.source : new SilenceSource();
    const sink: AudioSink | null = needs.playback ? (this.options.sink ?? new DiscardSink()) : null;
    await source.start?.();
    try {
      await sink?.start?.();
    } catch (error) {
      await source.close?.();
      throw error;
    }
    this.source = source;
    this.sink = sink;
    const rtc = new this.wrtc.nonstandard.RTCAudioSource();
    this.track = rtc.createTrack();
    this.open_ = true;
    this.pumping = pump(source, rtc, () => this.open_).catch((error: unknown) => {
      if (this.open_) this.logger.warn(`the microphone stopped: ${describe(error)}`);
    });
  }

  createPeer(options: PeerOptions): Peer {
    if (this.wrtc === null) throw new Error("open the WebRTC adapter before creating a peer");
    return new W3cPeer(this.wrtc.RTCPeerConnection, this, options, this.logger);
  }

  async close(): Promise<void> {
    this.open_ = false;
    this.track?.stop();
    this.track = null;
    await this.source?.close?.();
    await this.pumping;
    await this.sink?.close?.();
    this.source = this.sink = null;
    this.pumping = null;
  }

  outgoing(): W3cTrack | null {
    return this.track;
  }

  incoming(event: { track: W3cTrack }, onAudio: () => void): () => void {
    if (this.wrtc === null) return () => {};
    const receiver = new this.wrtc.nonstandard.RTCAudioSink(event.track);
    const sink = this.sink;
    receiver.ondata = (data) => {
      onAudio();
      if (sink !== null) sink.write(toMono(data, sink.sampleRate));
    };
    return () => {
      receiver.ondata = null;
      receiver.stop();
    };
  }
}

/** Feeds the source to WebRTC in 10 ms frames, paced in real time (a source may answer at once). */
async function pump(
  source: AudioSource,
  rtc: { onData(data: RTCAudioData): void },
  open: () => boolean,
): Promise<void> {
  const rate = source.sampleRate;
  const frame = rate / 100;
  if (!Number.isInteger(frame)) throw new Error(`a sample rate of ${rate} Hz has no whole 10 ms frame`);
  const started = performance.now();
  let sent = 0;
  let pending: Int16Array = new Int16Array(0);
  while (open()) {
    const chunk = await source.read();
    if (!open()) return;
    pending = concat(pending, chunk);
    while (pending.length >= frame) {
      const ahead = started + (sent / rate) * 1000 - performance.now();
      if (ahead > 0) await new Promise((resolve) => setTimeout(resolve, ahead));
      if (!open()) return;
      rtc.onData({ samples: pending.slice(0, frame), sampleRate: rate, bitsPerSample: 16, channelCount: 1 });
      pending = pending.subarray(frame);
      sent += frame;
    }
  }
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  if (a.length === 0) return b;
  const joined = new Int16Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

/** Down-mixed to mono and resampled (linearly) to the sink's rate. */
export function toMono(data: RTCAudioData, rate: number): Int16Array {
  const channels = data.channelCount ?? 1;
  const frames = data.samples.length / channels;
  let mono: Int16Array;
  if (channels === 1) {
    mono = data.samples;
  } else {
    mono = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += data.samples[i * channels + c] ?? 0;
      mono[i] = Math.round(sum / channels);
    }
  }
  if (data.sampleRate === rate) return mono;
  const out = new Int16Array(Math.round((mono.length * rate) / data.sampleRate));
  const step = data.sampleRate / rate;
  for (let i = 0; i < out.length; i++) {
    const at = i * step;
    const left = Math.floor(at);
    const a = mono[left] ?? 0;
    const b = mono[left + 1] ?? a;
    out[i] = Math.round(a + (b - a) * (at - left));
  }
  return out;
}
