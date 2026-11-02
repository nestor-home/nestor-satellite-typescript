/**
 * A `Peer` over any standard `RTCPeerConnection` — the browser's or `@roamhq/wrtc`'s. Only the
 * audio differs between them, behind `AudioBridge`.
 *
 * The interfaces below are the part of the W3C API this file uses, kept structural so that neither
 * the DOM typings nor a Node library's leak into the SDK's public types.
 */

import type { Peer, PeerEvents, SessionDescription } from "../audio.js";
import { describe, type Logger } from "../log.js";

export interface W3cTrack {
  readonly kind: string;
  stop(): void;
}

export interface W3cTrackEvent {
  readonly track: W3cTrack;
  readonly streams: readonly unknown[];
}

export interface W3cPeerConnection {
  readonly localDescription: { readonly sdp: string; readonly type: string } | null;
  readonly iceGatheringState: string;
  readonly connectionState: string;
  onicegatheringstatechange: ((event: unknown) => void) | null;
  onconnectionstatechange: ((event: unknown) => void) | null;
  ontrack: ((event: W3cTrackEvent) => void) | null;
  addTrack(track: W3cTrack, ...streams: unknown[]): unknown;
  addTransceiver(kind: string, init?: { direction?: string }): unknown;
  createOffer(): Promise<{ readonly sdp?: string; readonly type: string }>;
  setLocalDescription(description: { sdp: string; type: string }): Promise<void>;
  setRemoteDescription(description: { sdp: string; type: string }): Promise<void>;
  close(): void;
}

export type W3cPeerConnectionConstructor = new (configuration: { iceServers: { urls: string }[] }) => W3cPeerConnection;

/** The device's audio on one peer connection. */
export interface AudioBridge {
  /** The track to send (microphone, or silence); `null` to only receive. */
  outgoing(): W3cTrack | null;
  /** Play (or drain) a track from the core; returns how to stop. */
  incoming(event: W3cTrackEvent, onAudio: () => void): () => void;
}

export class W3cPeer implements Peer {
  private readonly pc: W3cPeerConnection;
  private readonly stops: (() => void)[] = [];
  private closed = false;

  constructor(
    Connection: W3cPeerConnectionConstructor,
    audio: AudioBridge,
    events: PeerEvents,
    /** STUN/TURN URLs, only needed beyond the local network. */
    iceServers: readonly string[],
    private readonly logger: Logger,
    private readonly gatherTimeoutMs = 3000,
  ) {
    this.pc = new Connection({ iceServers: iceServers.map((urls) => ({ urls })) });
    const track = audio.outgoing();
    if (track === null) this.pc.addTransceiver("audio", { direction: "sendrecv" });
    else this.pc.addTrack(track);
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if ((state === "failed" || state === "closed") && !this.closed) events.onClosed(`the connection ${state}`);
    };
    this.pc.ontrack = (event) => {
      if (event.track.kind !== "audio") return;
      try {
        this.stops.push(audio.incoming(event, () => events.onAudio()));
      } catch (error) {
        this.logger.warn(`could not play the core's audio: ${describe(error)}`);
      }
    };
  }

  async offer(): Promise<SessionDescription> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription({ sdp: offer.sdp ?? "", type: offer.type });
    await this.gathered();
    const local = this.pc.localDescription;
    if (local === null || local.type !== "offer") throw new Error("the peer connection made no offer");
    return { sdp: local.sdp, type: "offer" };
  }

  async accept(answer: SessionDescription): Promise<void> {
    await this.pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops.splice(0)) {
      try {
        stop();
      } catch (error) {
        this.logger.debug(`stopping the core's audio: ${describe(error)}`);
      }
    }
    this.pc.onconnectionstatechange = this.pc.ontrack = this.pc.onicegatheringstatechange = null;
    this.pc.close();
  }

  /** The offer carries every ICE candidate found: one request, no trickling. */
  private gathered(): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.logger.debug(`ICE gathering still running after ${this.gatherTimeoutMs} ms: offering what was found`);
        resolve();
      }, this.gatherTimeoutMs);
      this.pc.onicegatheringstatechange = () => {
        if (this.pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }
}
