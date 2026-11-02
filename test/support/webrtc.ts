/** An in-process WebRTC whose peers the fake core answers: each answer is a `CoreSession`. */

import type {
  MediaNeeds,
  Peer,
  PeerEvents,
  PeerOptions,
  SessionDescription,
  Speaker,
  WebRtc,
} from "../../src/index.js";
import { type Answerer, type Json, Queue } from "./core.js";

/** The core's side of one connection. */
export class CoreSession {
  readonly received = new Queue<Json>();

  constructor(
    readonly deviceId: string,
    private readonly events: PeerEvents,
  ) {}

  send(message: Json): void {
    this.events.onMessage(JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.events.onMessage(text);
  }

  audio(): void {
    this.events.onAudio();
  }

  /** What Pipecat says when the core leaves. */
  hangUp(): void {
    this.send({ type: "signalling", message: { type: "peerLeft" } });
  }

  /** The link breaks without a word. */
  drop(): void {
    this.events.onClosed("dropped");
  }

  async nextOfType(type: string): Promise<Json> {
    for (;;) {
      const message = await this.received.next();
      if (message.type === type) return message;
    }
  }
}

class FakePeer implements Peer {
  readonly id = `peer-${Math.random().toString(16).slice(2)}`;
  open = false;
  closed = false;

  constructor(
    private readonly network: FakeWebRtc,
    readonly events: PeerEvents,
  ) {}

  async offer(): Promise<SessionDescription> {
    return { sdp: this.id, type: "offer" };
  }

  async accept(answer: SessionDescription): Promise<void> {
    if (answer.sdp !== `answer:${this.id}`) throw new Error("not my answer");
    setTimeout(() => {
      if (this.closed) return;
      this.open = true;
      this.events.onOpen();
    }, 1);
  }

  send(text: string): boolean {
    if (!this.open || this.closed) return false;
    this.network.sessionOf(this)?.received.push(JSON.parse(text) as Json);
    return true;
  }

  close(): void {
    this.closed = true;
    this.open = false;
  }
}

export class FakeWebRtc implements WebRtc, Answerer<CoreSession> {
  readonly peers: FakePeer[] = [];
  opened: MediaNeeds | null = null;
  closed = 0;
  private readonly sessions = new Map<FakePeer, CoreSession>();

  /** `speaker`: the device's speaker, if it has one. */
  constructor(readonly speaker?: Speaker) {}

  async open(needs: MediaNeeds): Promise<void> {
    await this.held;
    this.opened = needs;
  }

  /** `open` waits until the test resolves (a person allows the microphone) or rejects it. */
  holdOpen(): { resolve: () => void; reject: (error: Error) => void } {
    let release = { resolve: () => {}, reject: (_: Error) => {} };
    this.held = new Promise<void>((resolve, reject) => {
      release = { resolve, reject };
    });
    this.held.catch(() => {}); // rejected before `open` awaits it
    return release;
  }

  private held: Promise<void> = Promise.resolve();

  async close(): Promise<void> {
    this.closed += 1;
  }

  createPeer(options: PeerOptions): Peer {
    const peer = new FakePeer(this, options.events);
    this.peers.push(peer);
    return peer;
  }

  /** The core answers an offer: a session starts on that peer. */
  answer(sdp: string, deviceId: string): CoreSession | null {
    const peer = this.peers.find((p) => p.id === sdp);
    if (peer === undefined) return null;
    const session = new CoreSession(deviceId, peer.events);
    this.sessions.set(peer, session);
    return session;
  }

  sessionOf(peer: FakePeer): CoreSession | undefined {
    return this.sessions.get(peer);
  }
}
