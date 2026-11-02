/** An in-process voice whose audio connections the fake core answers: each answer is an `AudioSession`. */

import type { Logger, MediaNeeds, Messages, Peer, PeerEvents, SessionDescription, Voice } from "../../src/index.js";
import { type Speaker, SpokenCode } from "../../src/voice/index.js";
import type { Answerer } from "./core.js";

/** The core's side of one audio connection. */
export class AudioSession {
  constructor(
    readonly deviceId: string,
    readonly peer: FakePeer,
  ) {}

  /** Audio from the core arrives. */
  audio(): void {
    this.peer.events.onAudio();
  }

  /** The connection fails. */
  drop(): void {
    this.peer.events.onClosed("dropped");
  }
}

export class FakePeer implements Peer {
  readonly id = `peer-${Math.random().toString(16).slice(2)}`;
  accepted = false;
  closed = false;

  constructor(readonly events: PeerEvents) {}

  async offer(): Promise<SessionDescription> {
    return { sdp: this.id, type: "offer" };
  }

  async accept(answer: SessionDescription): Promise<void> {
    if (answer.sdp !== `answer:${this.id}`) throw new Error("not my answer");
    this.accepted = true;
  }

  close(): void {
    this.closed = true;
  }
}

export interface FakeVoiceOptions {
  readonly capture?: boolean;
  readonly playback?: boolean;
  /** The device's speaker, which says the device code. */
  readonly speaker?: Speaker;
}

export class FakeVoice implements Voice, Answerer<AudioSession> {
  readonly capture: boolean;
  readonly playback: boolean;
  readonly peers: FakePeer[] = [];
  /** What each `open` was asked for. */
  readonly opened: MediaNeeds[] = [];
  closed = 0;
  /** The next opens fail (the microphone refused). */
  openFailures = 0;
  private readonly speaker: Speaker | undefined;

  constructor(options: FakeVoiceOptions = {}) {
    this.capture = options.capture ?? true;
    this.playback = options.playback ?? true;
    this.speaker = options.speaker;
  }

  codeVoice(messages: Messages, logger: Logger): SpokenCode | undefined {
    return this.speaker === undefined ? undefined : new SpokenCode(this.speaker, messages, { logger });
  }

  async open(needs: MediaNeeds): Promise<void> {
    if (this.openFailures > 0) {
      this.openFailures -= 1;
      this.opened.push(needs);
      throw new Error("NotAllowedError: the microphone was refused");
    }
    this.opened.push(needs);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  createPeer(events: PeerEvents): Peer {
    const peer = new FakePeer(events);
    this.peers.push(peer);
    return peer;
  }

  /** The core answers an offer: an audio session starts on that peer. */
  answer(sdp: string, deviceId: string): AudioSession | null {
    const peer = this.peers.find((p) => p.id === sdp);
    return peer === undefined ? null : new AudioSession(deviceId, peer);
  }
}
