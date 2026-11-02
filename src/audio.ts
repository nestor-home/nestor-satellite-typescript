/**
 * A satellite's voice, as a port: WebRTC audio with the core, once the link is welcomed with
 * `audio.capture` or `audio.playback`. The SDK's core never touches a browser or Node API, nor a
 * WebRTC library: a device without a voice needs none.
 *
 * - `browserVoice()` (`@nestor-home/satellite/voice`): the browser's own WebRTC, microphone and speaker;
 * - `nodeVoice()` (`@nestor-home/satellite/node`): `@roamhq/wrtc`, with PCM audio sources and sinks;
 * - tests plug a fake that plays the core.
 *
 * One `Peer` is one audio connection to the core: an audio track each way, nothing else (messages
 * travel on the link).
 */

import type { Messages } from "./i18n.js";
import type { Logger } from "./log.js";
import type { CodeVoice } from "./pairing.js";

export interface SessionDescription {
  readonly sdp: string;
  readonly type: "offer" | "answer";
}

/** What the household allowed this device to do with its audio, for one connection. */
export interface MediaNeeds {
  /** `audio.capture` is allowed: the microphone opens. */
  readonly capture: boolean;
  /** `audio.playback` is allowed: the core's voice is played. */
  readonly playback: boolean;
}

export interface PeerEvents {
  /** The connection failed or closed: this peer is over. */
  onClosed(reason: string): void;
  /** Audio from the core arrived (a heartbeat). */
  onAudio(): void;
}

export interface PeerOptions {
  readonly events: PeerEvents;
}

export interface Peer {
  /** Create the offer, with its ICE candidates gathered (no trickle). */
  offer(): Promise<SessionDescription>;
  accept(answer: SessionDescription): Promise<void>;
  close(): void | Promise<void>;
}

export interface Voice {
  /** The device has a microphone: declares `audio.capture`. */
  readonly capture: boolean;
  /** The device has a speaker: declares `audio.playback`. */
  readonly playback: boolean;
  /**
   * Says the device code aloud with the bundled voice while the device waits to be paired, on the
   * speaker the core's voice plays on; `undefined` when the device has none.
   */
  codeVoice?(messages: Messages, logger: Logger): CodeVoice | undefined;
  /** Open the audio devices for one connection (the microphone only when `capture` is allowed). */
  open(needs: MediaNeeds): Promise<void>;
  createPeer(options: PeerOptions): Peer | Promise<Peer>;
  /** Release the audio devices; called after each connection, and when the satellite stops. */
  close(): Promise<void>;
}
