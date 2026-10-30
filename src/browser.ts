/**
 * The browser's own WebRTC: `RTCPeerConnection`, the microphone through `getUserMedia`, the core's
 * voice through an `<audio>` element.
 *
 * Browsers only open the microphone in a secure context (`https:` or `http://localhost`), and only
 * play sound after a user gesture: start the satellite from a click.
 */

import { describe, type Logger, quietLogger } from "./log.js";
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
  private readonly logger: Logger;
  private microphone: W3cTrack | null = null;
  private element: AudioElementLike | null = null;
  private playback = false;

  constructor(private readonly options: BrowserWebRtcOptions) {
    this.logger = options.logger ?? quietLogger;
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
