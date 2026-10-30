/**
 * The browser's own WebRTC: `RTCPeerConnection`, the microphone through `getUserMedia`, the core's
 * voice through an `<audio>` element.
 *
 * Browsers only open the microphone in a secure context (`https:` or `http://localhost`), and only
 * play sound after a user gesture: start the satellite from a click.
 */

import { describe, type Logger, quietLogger } from "./log.js";
import type { Speaker } from "./voice.js";
import { type AudioBridge, W3cPeer, type W3cPeerConnectionConstructor, type W3cTrack } from "./w3c.js";
import type { MediaNeeds, Peer, PeerOptions, WebRtc } from "./webrtc.js";

/** What this adapter needs of an `<audio>` element (an `HTMLAudioElement` fits). */
export interface AudioElementLike {
  srcObject: unknown;
  play(): Promise<void>;
}

export interface BrowserWebRtcOptions {
  /** Constraints for `getUserMedia({audio})`; echo cancellation, noise suppression and gain control by default. */
  readonly microphone?: Readonly<Record<string, boolean | number | string>>;
  /** Where the core's voice plays (default: a detached `new Audio()`). */
  readonly element?: AudioElementLike;
  /** Where the SDK says the device code itself (default: `webAudioSpeaker()`, `null` for none). */
  readonly speaker?: Speaker | null;
  readonly logger?: Logger;
}

interface MediaGlobals {
  RTCPeerConnection?: W3cPeerConnectionConstructor;
  MediaStream?: new (tracks: W3cTrack[]) => unknown;
  Audio?: new () => AudioElementLike;
  navigator?: {
    mediaDevices?: { getUserMedia(constraints: { audio: unknown }): Promise<{ getAudioTracks(): W3cTrack[] }> };
  };
}

const DEFAULT_MICROPHONE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export function browserWebRtc(options: BrowserWebRtcOptions = {}): WebRtc {
  return new BrowserWebRtc(options);
}

class BrowserWebRtc implements WebRtc, AudioBridge {
  readonly speaker: Speaker | undefined;
  private readonly logger: Logger;
  private microphone: W3cTrack | null = null;
  private element: AudioElementLike | null = null;
  private playback = false;

  constructor(private readonly options: BrowserWebRtcOptions) {
    this.logger = options.logger ?? quietLogger;
    this.speaker = (options.speaker === undefined ? webAudioSpeaker() : options.speaker) ?? undefined;
  }

  async open(needs: MediaNeeds): Promise<void> {
    const media = globals();
    if (media.RTCPeerConnection === undefined) throw new Error("this browser has no WebRTC (RTCPeerConnection)");
    this.playback = needs.playback;
    if (needs.playback) this.element = this.options.element ?? (media.Audio ? new media.Audio() : null);
    if (!needs.capture) return;
    const devices = media.navigator?.mediaDevices;
    if (devices === undefined) {
      throw new Error("audio.capture is declared but this page cannot open a microphone (needs https or localhost)");
    }
    try {
      const stream = await devices.getUserMedia({ audio: this.options.microphone ?? DEFAULT_MICROPHONE });
      this.microphone = stream.getAudioTracks()[0] ?? null;
    } catch (error) {
      throw new Error(`audio.capture is declared but the microphone did not open: ${describe(error)}`);
    }
    if (this.microphone === null) throw new Error("audio.capture is declared but no microphone track came");
  }

  createPeer(options: PeerOptions): Peer {
    const Connection = globals().RTCPeerConnection;
    if (Connection === undefined) throw new Error("this browser has no WebRTC (RTCPeerConnection)");
    return new W3cPeer(Connection, this, options, this.logger);
  }

  async close(): Promise<void> {
    this.microphone?.stop();
    this.microphone = null;
    if (this.element !== null) this.element.srcObject = null;
  }

  outgoing(): W3cTrack | null {
    return this.microphone;
  }

  incoming(event: { track: W3cTrack; streams: readonly unknown[] }, onAudio: () => void): () => void {
    onAudio();
    const element = this.element;
    if (!this.playback || element === null) return () => {};
    const Stream = globals().MediaStream;
    element.srcObject = event.streams[0] ?? (Stream ? new Stream([event.track]) : null);
    element.play().catch((error: unknown) => {
      this.logger.warn(`the core's voice cannot play yet (start the satellite from a click): ${describe(error)}`);
    });
    return () => {
      if (element.srcObject !== null) element.srcObject = null;
    };
  }
}

function globals(): MediaGlobals {
  return globalThis as MediaGlobals;
}

/** What `browserSpeech` needs of the Web Speech API (`window.speechSynthesis` fits). */
export interface SpeechSynthesisLike {
  speak(utterance: unknown): void;
  cancel(): void;
}

interface SpeechGlobals {
  speechSynthesis?: SpeechSynthesisLike;
  SpeechSynthesisUtterance?: new (text: string) => { lang: string };
}

/**
 * The browser's voice (Web Speech API) as a pairing output: `pairing: { speak: browserSpeech({ lang }) }`
 * declares `device_code.speech`. `undefined` when this browser cannot speak, so nothing is declared.
 * `lang` should match the satellite's `locale`.
 */
export function browserSpeech(options: { readonly lang?: string } = {}): ((text: string) => void) | undefined {
  const { speechSynthesis, SpeechSynthesisUtterance: Utterance } = globalThis as SpeechGlobals;
  if (speechSynthesis === undefined || Utterance === undefined) return undefined;
  return (text) => {
    const utterance = new Utterance(text);
    if (options.lang !== undefined) utterance.lang = options.lang;
    speechSynthesis.cancel(); // the latest sentence replaces the one still being said
    speechSynthesis.speak(utterance);
  };
}

/** What `webAudioSpeaker` needs of Web Audio (`AudioContext` fits). */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): { copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void; readonly duration: number };
  createBufferSource(): {
    buffer: unknown;
    connect(destination: unknown): unknown;
    start(when: number): void;
    stop(): void;
    onended: (() => void) | null;
  };
}

/**
 * A file of the bundled voice, in the package next to this module. Written so bundlers find the files:
 * Vite turns each template into the list of what it matches, one folder level per placeholder.
 */
function voiceUrl(path: string): URL {
  const [folder, file] = path.split("/");
  return file === undefined
    ? new URL(`../voice/${path}`, import.meta.url)
    : new URL(`../voice/${folder}/${file}`, import.meta.url);
}

/**
 * The page's speaker through Web Audio, with the bundled voice fetched from the package: the device
 * code sounds the same as on any other satellite, offline. `undefined` when the browser has no Web
 * Audio. Browsers only play sound after a user gesture: start the satellite from a click.
 */
export function webAudioSpeaker(
  options: { readonly context?: () => AudioContextLike; readonly load?: (path: string) => Promise<Uint8Array> } = {},
): Speaker | undefined {
  const Context = (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext;
  const create = options.context ?? (Context === undefined ? undefined : () => new Context());
  if (create === undefined) return undefined;
  const load =
    options.load ??
    (async (path: string) => {
      const response = await fetch(voiceUrl(path));
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    });
  let context: AudioContextLike | null = null;
  let next = 0;
  const playing = new Set<ReturnType<AudioContextLike["createBufferSource"]>>();
  const sampleRate = 16_000; // the clips' own rate: Web Audio resamples to the device's
  return {
    sampleRate,
    load,
    write(pcm) {
      if (context === null) {
        context = create();
        void context.resume().catch(() => {});
      }
      const buffer = context.createBuffer(1, pcm.length, sampleRate);
      const floats = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) floats[i] = (pcm[i] ?? 0) / 32768;
      buffer.copyToChannel(floats, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      next = Math.max(next, context.currentTime);
      source.start(next);
      next += buffer.duration;
      playing.add(source);
      source.onended = () => playing.delete(source);
    },
    flush() {
      for (const source of playing) source.stop();
      playing.clear();
      next = 0;
    },
  };
}
