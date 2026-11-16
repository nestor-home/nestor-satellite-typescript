/** A camera whose sessions the fake core answers: it counts when it is switched on and off. */

import type { Camera, PeerEvents, Voice } from "../../src/index.js";
import { FakePeer } from "./audio.js";

/** The start of a JPEG, which is all the core checks of a still picture here. */
export const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

export class FakeCamera implements Camera {
  opened = 0;
  closed = 0;
  /** Each connection made, and the voice whose audio it carries in a call. */
  readonly peers: { peer: FakePeer; call: Voice | null }[] = [];

  get on(): boolean {
    return this.opened > this.closed;
  }

  async open(): Promise<void> {
    this.opened += 1;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  async still(): Promise<Uint8Array> {
    if (!this.on) throw new Error("the camera is off");
    return PICTURE;
  }

  createPeer(events: PeerEvents, call: Voice | null): FakePeer {
    if (!this.on) throw new Error("the camera is off");
    const peer = new FakePeer(events);
    this.peers.push({ peer, call });
    return peer;
  }
}
