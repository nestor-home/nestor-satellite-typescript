/**
 * The voice of a Node satellite: WebRTC through `@roamhq/wrtc` (libwebrtc, the browsers' own stack),
 * the standard `RTCPeerConnection` with Opus, jitter buffer and RTCP done natively, plus its
 * non-standard `RTCAudioSource`/`RTCAudioSink` to exchange PCM with an `AudioSource`/`AudioSink`.
 *
 * `@roamhq/wrtc` is an optional peer dependency, loaded only for an audio connection. The microphone
 * (the source) opens only for one; the speaker (the sink) also says the device code while pairing.
 */

import type { MediaNeeds, Peer, PeerEvents, Voice } from "../audio.js";
import type { Messages } from "../i18n.js";
import { describe, type Logger, quietLogger } from "../log.js";
import type { CodeVoice } from "../pairing.js";
import { resample, SpokenCode } from "../voice/spoken.js";
import { type AudioBridge, W3cPeer, type W3cPeerConnectionConstructor, type W3cTrack } from "../voice/w3c.js";
import { type AudioSink, type AudioSource, DiscardSink, SilenceSource } from "./audio.js";
import { sinkSpeaker } from "./voice.js";

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

export interface NodeVoiceOptions {
  /** The microphone: declares `audio.capture` (`SilenceSource` for a silent one). */
  readonly source?: AudioSource;
  /**
   * The speaker: declares `audio.playback`. It also says the device code with the bundled voice
   * (unless it is a `DiscardSink`).
   */
  readonly sink?: AudioSink;
  /** The WebRTC library (default: `import("@roamhq/wrtc")`). */
  readonly wrtc?: WrtcModule | (() => Promise<WrtcModule>);
  /** STUN/TURN URLs, only needed beyond the local network. */
  readonly iceServers?: readonly string[];
  readonly logger?: Logger;
}

const WRTC = "@roamhq/wrtc";

/** This machine's audio as the satellite's voice: `new Satellite({ voice: nodeVoice({ source, sink }), … })`. */
export function nodeVoice(options: NodeVoiceOptions = {}): Voice {
  return new NodeVoice(options);
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

class NodeVoice implements Voice, AudioBridge {
  readonly capture: boolean;
  readonly playback: boolean;
  private readonly logger: Logger;
  private wrtc: WrtcModule | null = null;
  private source: AudioSource | null = null;
  private sinkStarted: Promise<void> | null = null;
  private playing = false;
  private track: W3cTrack | null = null;
  private pumping: Promise<void> | null = null;
  private open_ = false;

  constructor(private readonly options: NodeVoiceOptions) {
    this.logger = options.logger ?? quietLogger;
    this.capture = options.source !== undefined;
    this.playback = options.sink !== undefined;
  }

  codeVoice(messages: Messages, logger: Logger): CodeVoice | undefined {
    const { sink } = this.options;
    if (sink === undefined || sink instanceof DiscardSink) return undefined;
    // The clips load before anything is written: the player starts while they do.
    const speaker = sinkSpeaker(sink);
    const load = async (path: string) => {
      await this.startSink();
      return speaker.load(path);
    };
    return new SpokenCode({ ...speaker, load }, messages, { logger });
  }

  async open(needs: MediaNeeds): Promise<void> {
    const { wrtc = loadWrtc } = this.options;
    this.wrtc = typeof wrtc === "function" ? await wrtc() : wrtc;
    const source: AudioSource =
      needs.capture && this.options.source !== undefined ? this.options.source : new SilenceSource();
    await source.start?.();
    this.playing = needs.playback && this.playback;
    try {
      if (this.playing) await this.startSink();
    } catch (error) {
      await source.close?.();
      throw error;
    }
    this.source = source;
    const rtc = new this.wrtc.nonstandard.RTCAudioSource();
    this.track = rtc.createTrack();
    this.open_ = true;
    this.pumping = pump(source, rtc, () => this.open_).catch((error: unknown) => {
      if (this.open_) this.logger.warn(`the microphone stopped: ${describe(error)}`);
    });
  }

  createPeer(events: PeerEvents): Peer {
    if (this.wrtc === null) throw new Error("open the voice before creating a peer");
    return new W3cPeer(this.wrtc.RTCPeerConnection, this, events, this.options.iceServers ?? [], this.logger);
  }

  async close(): Promise<void> {
    this.open_ = false;
    this.track?.stop();
    this.track = null;
    await this.source?.close?.();
    await this.pumping;
    this.source = null;
    this.pumping = null;
    if (this.sinkStarted !== null) {
      this.sinkStarted = null;
      await this.options.sink?.close?.();
    }
  }

  private startSink(): Promise<void> {
    const sink = this.options.sink;
    if (sink === undefined) return Promise.resolve();
    this.sinkStarted ??= Promise.resolve(sink.start?.()).catch((error: unknown) => {
      this.sinkStarted = null;
      throw error;
    });
    return this.sinkStarted;
  }

  outgoing(): W3cTrack | null {
    return this.track;
  }

  incoming(event: { track: W3cTrack }, onAudio: () => void): () => void {
    if (this.wrtc === null) return () => {};
    const receiver = new this.wrtc.nonstandard.RTCAudioSink(event.track);
    const sink = this.playing ? (this.options.sink ?? null) : null;
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
  return resample(mono, data.sampleRate, rate);
}
