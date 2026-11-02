/** The Node adapter: over a scripted `@roamhq/wrtc`, then over the real one, loopback to a core peer. */

import { describe, expect, it } from "vitest";
import type { PeerEvents } from "../src/index.js";
import {
  type AudioSource,
  loadWrtc,
  nodeVoice,
  RecordingSink,
  type RTCAudioData,
  SilenceSource,
  toMono,
  type WrtcModule,
} from "../src/node/index.js";
import type { W3cPeerConnection, W3cTrack } from "../src/voice/index.js";
import { until } from "./support/core.js";

function scripted() {
  const frames: RTCAudioData[] = [];
  const sinks: { ondata: ((data: RTCAudioData) => void) | null; stopped: boolean }[] = [];
  const wrtc = {
    RTCPeerConnection: class {} as unknown as WrtcModule["RTCPeerConnection"],
    nonstandard: {
      RTCAudioSource: class {
        createTrack(): W3cTrack {
          return { kind: "audio", stop: () => {} };
        }
        onData(data: RTCAudioData) {
          frames.push(data);
        }
      },
      RTCAudioSink: class {
        ondata: ((data: RTCAudioData) => void) | null = null;
        stopped = false;
        constructor() {
          sinks.push(this);
        }
        stop() {
          this.stopped = true;
        }
      },
    },
  } satisfies WrtcModule;
  return { wrtc, frames, sinks };
}

describe("in Node", () => {
  it("feeds the microphone to WebRTC in 10 ms frames, in real time", async () => {
    const { wrtc, frames } = scripted();
    const webrtc = nodeVoice({ wrtc, source: new SilenceSource() });
    const started = performance.now();
    await webrtc.open({ capture: true, playback: false });
    await until(() => frames.length >= 20);
    const elapsed = performance.now() - started;
    await webrtc.close();
    expect(frames.every((f) => f.samples.length === 480 && f.sampleRate === 48_000)).toBe(true);
    expect(elapsed).toBeGreaterThan(150); // 20 frames are 200 ms of audio: paced, not sent at once
  });

  it("plays the core's audio in the sink, down-mixed and resampled to its rate", async () => {
    const { wrtc, sinks } = scripted();
    const sink = new RecordingSink(16_000);
    const webrtc = nodeVoice({ wrtc, source: new SilenceSource(), sink });
    await webrtc.open({ capture: true, playback: true });
    const bridge = webrtc as unknown as { incoming(e: { track: W3cTrack }, onAudio: () => void): () => void };
    let heard = 0;
    const stop = bridge.incoming({ track: { kind: "audio", stop: () => {} } }, () => heard++);
    sinks[0]?.ondata?.({ samples: new Int16Array(960).fill(100), sampleRate: 48_000, channelCount: 2 });
    stop();
    await webrtc.close();
    expect(heard).toBe(1);
    expect(sink.samples).toBe(160);
    expect(sinks[0]?.stopped).toBe(true);
  });

  it("declares the audio it was given: a source for capture, a sink for playback", () => {
    expect([nodeVoice({ source: new SilenceSource() }).capture, nodeVoice({}).capture]).toEqual([true, false]);
    expect([nodeVoice({ sink: new RecordingSink() }).playback, nodeVoice({}).playback]).toEqual([true, false]);
  });

  it("opens the microphone only for a connection that captures, and releases it after", async () => {
    let started = 0;
    let closed = 0;
    const source: AudioSource = {
      sampleRate: 48_000,
      read: async () => new Int16Array(960),
      start: async () => void started++,
      close: async () => void closed++,
    };
    const voice = nodeVoice({ wrtc: scripted().wrtc, source });
    await voice.open({ capture: false, playback: false });
    await voice.close();
    expect(started).toBe(0);
    await voice.open({ capture: true, playback: false });
    await voice.close();
    expect([started, closed]).toEqual([1, 1]);
  });

  it("releases the microphone when the speaker cannot open", async () => {
    let closed = false;
    const source: AudioSource = {
      sampleRate: 48_000,
      read: async () => new Int16Array(960),
      close: async () => {
        closed = true;
      },
    };
    const sink = {
      sampleRate: 48_000,
      write() {},
      start: async () => {
        throw new Error("no speaker");
      },
    };
    const webrtc = nodeVoice({ wrtc: scripted().wrtc, source, sink });
    await expect(webrtc.open({ capture: true, playback: true })).rejects.toThrow("no speaker");
    expect(closed).toBe(true);
  });

  it("says which package to install when the WebRTC library is missing", async () => {
    const missing = async (): Promise<WrtcModule> => {
      throw new Error("Cannot find package");
    };
    await expect(nodeVoice({ wrtc: missing }).open({ capture: false, playback: false })).rejects.toThrow(
      "Cannot find package",
    );
    await expect(loadWrtc()).resolves.toHaveProperty("RTCPeerConnection");
  });

  it("averages channels and resamples linearly", () => {
    expect([
      ...toMono({ samples: Int16Array.from([10, 20, 30, 50]), sampleRate: 8000, channelCount: 2 }, 8000),
    ]).toEqual([15, 40]);
    expect([...toMono({ samples: Int16Array.from([0, 100]), sampleRate: 8000 }, 16_000)]).toEqual([0, 50, 100, 100]);
  });
});

describe("over the real @roamhq/wrtc", () => {
  it("carries audio both ways with a core peer, and nothing else", async () => {
    const wrtc = await loadWrtc();
    const sink = new RecordingSink();
    const webrtc = nodeVoice({ source: new SilenceSource(), sink });
    await webrtc.open({ capture: true, playback: true });
    const log: string[] = [];
    const events: PeerEvents = { onClosed: (reason) => log.push(`closed: ${reason}`), onAudio: () => {} };
    const peer = await webrtc.createPeer({ events });

    // The core: answers the offer, sends a tone, listens.
    const core = new wrtc.RTCPeerConnection({ iceServers: [] }) as W3cPeerConnection & {
      ondatachannel: ((e: unknown) => void) | null;
      getTransceivers(): { sender: { replaceTrack(t: W3cTrack): Promise<void> }; direction: string }[];
      createAnswer(): Promise<{ sdp?: string; type: string }>;
    };
    const tone = new wrtc.nonstandard.RTCAudioSource();
    let channels = 0;
    let heard = 0;
    core.ondatachannel = () => channels++;
    core.ontrack = ({ track }) => {
      const receiver = new wrtc.nonstandard.RTCAudioSink(track);
      receiver.ondata = () => heard++;
    };
    const offer = await peer.offer();
    expect(offer.sdp).toMatch(/a=candidate/);
    expect(offer.sdp).not.toMatch(/m=application/); // audio only: no data channel
    await core.setRemoteDescription(offer);
    const transceiver = core.getTransceivers()[0];
    if (transceiver === undefined) throw new Error("no audio transceiver in the offer");
    transceiver.direction = "sendrecv";
    await transceiver.sender.replaceTrack(tone.createTrack());
    const answer = await core.createAnswer();
    await core.setLocalDescription({ sdp: answer.sdp ?? "", type: "answer" });
    await until(() => core.iceGatheringState === "complete", 5000);
    await peer.accept({ sdp: core.localDescription?.sdp ?? "", type: "answer" });

    const samples = new Int16Array(480).map((_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48_000)));
    const sending = setInterval(() => tone.onData({ samples, sampleRate: 48_000 }), 10);
    try {
      await until(() => heard > 5 && sink.samples > 4800, 8000).catch((error: unknown) => {
        throw new Error(`${String(error)}: ${JSON.stringify({ log, heard, played: sink.samples })}`);
      });
    } finally {
      clearInterval(sending);
      await peer.close();
      core.close();
      await webrtc.close();
    }
    expect(channels).toBe(0);
  }, 20_000);
});
