/** The browser adapter and the W3C peer, over a scripted `RTCPeerConnection` (real browsers: `pnpm conformance`). */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AudioElementLike,
  browserWebRtc,
  type PeerEvents,
  type W3cDataChannel,
  type W3cTrack,
  type W3cTrackEvent,
} from "../src/index.js";

class Track implements W3cTrack {
  stopped = false;
  constructor(readonly kind = "audio") {}
  stop() {
    this.stopped = true;
  }
}

class Channel implements W3cDataChannel {
  readyState = "connecting";
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  constructor(readonly label: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = "closed";
  }
}

class Connection {
  static last: Connection | null = null;
  localDescription: { sdp: string; type: string } | null = null;
  iceGatheringState = "new";
  connectionState = "new";
  onicegatheringstatechange: ((event: unknown) => void) | null = null;
  onconnectionstatechange: ((event: unknown) => void) | null = null;
  ontrack: ((event: W3cTrackEvent) => void) | null = null;
  channels: Channel[] = [];
  tracks: W3cTrack[] = [];
  transceivers: string[] = [];
  remote: { sdp: string; type: string } | null = null;
  closed = false;

  constructor(readonly configuration: { iceServers: { urls: string }[] }) {
    Connection.last = this;
  }
  createDataChannel(label: string) {
    const channel = new Channel(label);
    this.channels.push(channel);
    return channel;
  }
  addTrack(track: W3cTrack) {
    this.tracks.push(track);
  }
  addTransceiver(kind: string) {
    this.transceivers.push(kind);
  }
  async createOffer() {
    return { sdp: "v=0 no candidates yet", type: "offer" };
  }
  async setLocalDescription(description: { sdp: string; type: string }) {
    this.localDescription = description;
    this.iceGatheringState = "gathering";
    setTimeout(() => {
      this.localDescription = { sdp: `${description.sdp} + candidates`, type: "offer" };
      this.iceGatheringState = "complete";
      this.onicegatheringstatechange?.({});
    }, 5);
  }
  async setRemoteDescription(description: { sdp: string; type: string }) {
    this.remote = description;
  }
  close() {
    this.closed = true;
  }
}

function events(): PeerEvents & { log: unknown[] } {
  const log: unknown[] = [];
  return {
    log,
    onOpen: () => log.push("open"),
    onMessage: (text) => log.push(text),
    onClosed: (reason) => log.push(`closed: ${reason}`),
    onAudio: () => log.push("audio"),
  };
}

const microphone = new Track();
const element: AudioElementLike & { played: number } = {
  srcObject: null,
  played: 0,
  play: async () => {
    element.played += 1;
  },
};

function browser(mediaDevices: unknown = { getUserMedia: async () => ({ getAudioTracks: () => [microphone] }) }) {
  vi.stubGlobal("RTCPeerConnection", Connection);
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("navigator", { mediaDevices });
}

afterEach(() => {
  vi.unstubAllGlobals();
  element.srcObject = null;
});

describe("in a browser", () => {
  it("sends the microphone and offers once every ICE candidate is gathered", async () => {
    browser();
    const webrtc = browserWebRtc({ element });
    await webrtc.open?.({ capture: true, playback: true });
    const peer = await webrtc.createPeer({ iceServers: ["stun:stun.example:3478"], events: events() });
    const pc = Connection.last as Connection;
    expect(pc.configuration).toEqual({ iceServers: [{ urls: "stun:stun.example:3478" }] });
    expect(pc.tracks).toEqual([microphone]);
    expect(pc.channels.map((c) => c.label)).toEqual(["nestor"]);
    expect(await peer.offer()).toEqual({ sdp: "v=0 no candidates yet + candidates", type: "offer" });
    await peer.accept({ sdp: "answer", type: "answer" });
    expect(pc.remote).toEqual({ sdp: "answer", type: "answer" });
  });

  it("carries the data channel's messages both ways, only once it is open", async () => {
    browser();
    const webrtc = browserWebRtc();
    await webrtc.open?.({ capture: false, playback: false });
    const seen = events();
    const peer = await webrtc.createPeer({ iceServers: [], events: seen });
    const channel = (Connection.last as Connection).channels[0] as Channel;
    expect(peer.send("early")).toBe(false);
    channel.readyState = "open";
    channel.onopen?.({});
    channel.onmessage?.({ data: '{"type":"welcome"}' });
    channel.onmessage?.({ data: new TextEncoder().encode('{"type":"bytes"}') });
    expect(peer.send("hello")).toBe(true);
    expect(channel.sent).toEqual(["hello"]);
    expect(seen.log).toEqual(["open", '{"type":"welcome"}', '{"type":"bytes"}']);
  });

  it("ends the peer when the channel closes or the connection fails, and closes everything once", async () => {
    browser();
    const webrtc = browserWebRtc();
    await webrtc.open?.({ capture: false, playback: false });
    const seen = events();
    const peer = await webrtc.createPeer({ iceServers: [], events: seen });
    const pc = Connection.last as Connection;
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.({});
    (pc.channels[0] as Channel).onclose?.({});
    expect(seen.log).toEqual(["closed: the connection failed", "closed: the data channel closed"]);
    await peer.close();
    await peer.close();
    expect(pc.closed).toBe(true);
    expect(peer.send("late")).toBe(false);
  });

  it("without audio.capture, receives without asking for the microphone", async () => {
    const getUserMedia = vi.fn();
    browser({ getUserMedia });
    const webrtc = browserWebRtc();
    await webrtc.open?.({ capture: false, playback: true });
    await webrtc.createPeer({ iceServers: [], events: events() });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect((Connection.last as Connection).transceivers).toEqual(["audio"]);
  });

  it("plays the core's voice in the element, and stops the microphone when closed", async () => {
    browser();
    const webrtc = browserWebRtc({ element });
    await webrtc.open?.({ capture: true, playback: true });
    const seen = events();
    const peer = await webrtc.createPeer({ iceServers: [], events: seen });
    const stream = { id: "remote" };
    (Connection.last as Connection).ontrack?.({ track: new Track(), streams: [stream] });
    expect(element.srcObject).toBe(stream);
    expect(element.played).toBeGreaterThan(0);
    expect(seen.log).toEqual(["audio"]);
    await peer.close();
    await webrtc.close?.();
    expect(element.srcObject).toBeNull();
    expect(microphone.stopped).toBe(true);
  });

  it("fails clearly when audio.capture is declared and no microphone can open", async () => {
    browser();
    vi.stubGlobal("navigator", {}); // an insecure context: no mediaDevices
    await expect(browserWebRtc().open?.({ capture: true, playback: false })).rejects.toThrow(/https or localhost/);
    browser({
      getUserMedia: async () => {
        throw new Error("NotAllowedError");
      },
    });
    await expect(browserWebRtc().open?.({ capture: true, playback: false })).rejects.toThrow(/NotAllowedError/);
  });

  it("fails clearly where there is no WebRTC", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    await expect(browserWebRtc().open?.({ capture: false, playback: false })).rejects.toThrow(/no WebRTC/);
  });
});
