/** The browser's voice and the W3C peer, over a scripted `RTCPeerConnection` (real browsers: `pnpm conformance`). */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Messages, type PeerEvents, quietLogger } from "../src/index.js";
import {
  type AudioElementLike,
  browserSpeech,
  browserVoice,
  type W3cTrack,
  type W3cTrackEvent,
  webAudioSpeaker,
} from "../src/voice/index.js";

class Track implements W3cTrack {
  stopped = false;
  constructor(readonly kind = "audio") {}
  stop() {
    this.stopped = true;
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
  tracks: W3cTrack[] = [];
  transceivers: string[] = [];
  remote: { sdp: string; type: string } | null = null;
  closed = false;

  constructor(readonly configuration: { iceServers: { urls: string }[] }) {
    Connection.last = this;
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
  it("sends the microphone, audio only, and offers once every ICE candidate is gathered", async () => {
    browser();
    const voice = browserVoice({ element, iceServers: ["stun:stun.example:3478"] });
    expect([voice.capture, voice.playback]).toEqual([true, true]);
    await voice.open({ capture: true, playback: true });
    const peer = await voice.createPeer(events());
    const pc = Connection.last as Connection;
    expect(pc.configuration).toEqual({ iceServers: [{ urls: "stun:stun.example:3478" }] });
    expect(pc.tracks).toEqual([microphone]);
    expect(await peer.offer()).toEqual({ sdp: "v=0 no candidates yet + candidates", type: "offer" });
    await peer.accept({ sdp: "answer", type: "answer" });
    expect(pc.remote).toEqual({ sdp: "answer", type: "answer" });
  });

  it("declares only the audio it has", () => {
    expect([browserVoice({ microphone: false }).capture, browserVoice({ microphone: false }).playback]).toEqual([
      false,
      true,
    ]);
    expect(browserVoice({ element: null }).playback).toBe(false);
  });

  it("ends the peer when the connection fails, and closes everything once", async () => {
    browser();
    const voice = browserVoice();
    await voice.open({ capture: false, playback: false });
    const seen = events();
    const peer = await voice.createPeer(seen);
    const pc = Connection.last as Connection;
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.({});
    expect(seen.log).toEqual(["closed: the connection failed"]);
    await peer.close();
    await peer.close();
    expect(pc.closed).toBe(true);
  });

  it("without audio.capture allowed, receives without asking for the microphone", async () => {
    const getUserMedia = vi.fn();
    browser({ getUserMedia });
    const voice = browserVoice();
    await voice.open({ capture: false, playback: true });
    await voice.createPeer(events());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect((Connection.last as Connection).transceivers).toEqual(["audio"]);
  });

  it("plays the core's voice in the element, and stops the microphone when closed", async () => {
    browser();
    const voice = browserVoice({ element });
    await voice.open({ capture: true, playback: true });
    const seen = events();
    const peer = await voice.createPeer(seen);
    const stream = { id: "remote" };
    (Connection.last as Connection).ontrack?.({ track: new Track(), streams: [stream] });
    expect(element.srcObject).toBe(stream);
    expect(element.played).toBeGreaterThan(0);
    expect(seen.log).toEqual(["audio"]);
    await peer.close();
    await voice.close();
    expect(element.srcObject).toBeNull();
    expect(microphone.stopped).toBe(true);
  });

  it("fails clearly when the microphone cannot open", async () => {
    browser();
    vi.stubGlobal("navigator", {}); // an insecure context: no mediaDevices
    await expect(browserVoice().open({ capture: true, playback: false })).rejects.toThrow(/https or localhost/);
    browser({
      getUserMedia: async () => {
        throw new Error("NotAllowedError");
      },
    });
    await expect(browserVoice().open({ capture: true, playback: false })).rejects.toThrow(/NotAllowedError/);
  });

  it("fails clearly where there is no WebRTC", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    await expect(browserVoice().open({ capture: false, playback: false })).rejects.toThrow(/no WebRTC/);
  });
});

describe("the browser's voice", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says each sentence in the language given, the latest replacing the one still being said", () => {
    const said: { text: string; lang: string }[] = [];
    vi.stubGlobal("speechSynthesis", { speak: (u: { text: string; lang: string }) => said.push(u), cancel: vi.fn() });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        lang = "";
        constructor(readonly text: string) {}
      },
    );
    const speak = browserSpeech({ lang: "fr-FR" });
    speak?.("Mon code d'appairage est 0, 4, 2.");
    expect(said).toMatchObject([{ text: "Mon code d'appairage est 0, 4, 2.", lang: "fr-FR" }]);
  });

  it("is absent where the browser cannot speak, so the satellite does not declare it", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    expect(browserSpeech()).toBeUndefined();
  });
});

describe("the bundled voice in a browser", () => {
  class Context {
    currentTime = 0;
    readonly destination = "speakers";
    readonly started: { at: number; samples: Float32Array; stopped: boolean }[] = [];
    resumed = 0;
    async resume() {
      this.resumed += 1;
    }
    createBuffer(_channels: number, length: number, rate: number) {
      const samples = new Float32Array(length);
      return { duration: length / rate, samples, copyToChannel: (from: Float32Array) => samples.set(from) };
    }
    createBufferSource() {
      const context = this;
      const node = {
        buffer: null as { samples: Float32Array } | null,
        onended: null as (() => void) | null,
        connect: (to: unknown) => expect(to).toBe("speakers"),
        start(at: number) {
          context.started.push({ at, samples: node.buffer?.samples ?? new Float32Array(), stopped: false });
        },
        stop() {
          const started = context.started.find((s) => s.samples === node.buffer?.samples);
          if (started) started.stopped = true;
        },
      };
      return node;
    }
  }

  it("plays what it is given back to back with Web Audio, and silences it at once when flushed", () => {
    const context = new Context();
    const speaker = webAudioSpeaker({ context: () => context, load: async () => new Uint8Array() });
    if (speaker === undefined) throw new Error("no speaker");
    speaker.write(new Int16Array(1600).fill(16384)); // 100 ms at 16 kHz
    speaker.write(new Int16Array(800));
    expect(context.started.map((s) => s.at)).toEqual([0, 0.1]);
    expect(context.started[0]?.samples[0]).toBe(0.5);
    expect(context.resumed).toBe(1);
    speaker.flush?.();
    expect(context.started.every((s) => s.stopped)).toBe(true);
    context.currentTime = 2;
    speaker.write(new Int16Array(160));
    expect(context.started.at(-1)?.at).toBe(2);
  });

  it("is not there in a browser without Web Audio, nor when the page says it has no speaker", () => {
    const codeVoice = (voice: ReturnType<typeof browserVoice>) => voice.codeVoice?.(new Messages("en"), quietLogger);
    expect(webAudioSpeaker()).toBeUndefined(); // Node has no AudioContext
    expect(codeVoice(browserVoice())).toBeUndefined();
    const speaker = webAudioSpeaker({ context: () => new Context() }) ?? null;
    expect(codeVoice(browserVoice({ speaker }))).toBeDefined();
    expect(codeVoice(browserVoice({ speaker, element: null }))).toBeUndefined();
    expect(codeVoice(browserVoice({ speaker: null }))).toBeUndefined();
  });
});
