/** A satellite's life against a fake core: pairing, hello/welcome, acks, observations, reconnection. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  type Body,
  CapabilityNotAllowed,
  EXPRESSION,
  type Logger,
  Manifest,
  MemoryTokenStore,
  PERSON_DETECTION,
  Satellite,
  type SatelliteOptions,
  SPEECH_ACTIVITY,
  type WebRtc,
} from "../src/index.js";
import { FakeCore, message, until, welcome } from "./support/core.js";
import { type CoreSession, FakeWebRtc } from "./support/webrtc.js";

const DEVICE = { id: "capteur-entree", model: "esp32", room: "entree" };
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {} };

interface Running {
  core: FakeCore<CoreSession>;
  satellite: Satellite;
  tokens: MemoryTokenStore;
  codes: string[];
  stop: () => Promise<void>;
  done: Promise<void>;
}

let running: Running | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
});

async function start(
  capabilities: string[],
  options: Partial<SatelliteOptions> & { webrtc?: WebRtc } = {},
  core?: FakeCore<CoreSession>,
): Promise<Running> {
  const webrtc = new FakeWebRtc();
  const fake = core ?? (await FakeCore.start({ webrtc }));
  const tokens = (options.tokens as MemoryTokenStore | undefined) ?? new MemoryTokenStore();
  const codes: string[] = [];
  const satellite = new Satellite({
    core: `${fake.url}/`,
    manifest: Manifest.of(DEVICE, ...capabilities),
    tokens,
    webrtc: fake.webrtc instanceof FakeWebRtc ? fake.webrtc : webrtc,
    onCode: (code) => codes.push(code),
    pollMs: 5,
    backoffMs: [5, 20],
    logger: silent,
    ...options,
  });
  const stopping = new AbortController();
  const done = satellite.run(stopping.signal);
  running = {
    core: fake,
    satellite,
    tokens,
    codes,
    done,
    stop: async () => {
      stopping.abort();
      await done.catch(() => {});
      await fake.stop();
    },
  };
  return running;
}

/** The core's part of a connection: wait for hello, answer welcome. */
async function greet(session: CoreSession, allowed: string[]): Promise<Record<string, unknown>> {
  const hello = await session.received.next();
  session.send(welcome(session.deviceId, "entree", allowed));
  return hello;
}

describe("a satellite", () => {
  it("pairs once, connects with its token and says hello with its manifest", async () => {
    const { core, codes, tokens } = await start([AUDIO_CAPTURE]);
    const session = await core.sessions.next();
    const hello = await greet(session, [AUDIO_CAPTURE]);
    expect(hello).toMatchObject({ type: "hello", payload: { manifest: Manifest.of(DEVICE, AUDIO_CAPTURE).toJSON() } });
    expect(codes).toEqual(["042137"]);
    expect(tokens.load(core.url, DEVICE.id)).toBe("nst1_token-1");
    expect(core.offers[0]?.authorization).toBe("Bearer nst1_token-1");
  });

  it("opens the audio the manifest declares, and releases it when stopped", async () => {
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc });
    const run = await start([AUDIO_PLAYBACK], {}, core);
    await core.sessions.next();
    expect(webrtc.opened).toEqual({ capture: false, playback: true });
    await run.stop();
    running = null;
    expect(webrtc.closed).toBe(1);
    expect(webrtc.peers.every((p) => p.closed)).toBe(true);
  });

  it("carries out intents and acknowledges each by id; the body hears when the link is up", async () => {
    const calls: unknown[] = [];
    const body: Body = {
      behavior: (b) => calls.push(b),
      expression: (e, i) => calls.push([e, i]),
      connected: (up) => calls.push(up ? "up" : "down"),
    };
    const { core, satellite } = await start([EXPRESSION], { body });
    const session = await core.sessions.next();
    await greet(session, [EXPRESSION]);
    await until(() => satellite.connected);
    session.send(message("intent.behavior", { behavior: "speaking" }, "i-1"));
    session.send(message("intent.expression", { expression: "joy", intensity: 0.8 }, "i-2"));
    const acks = [await session.nextOfType("ack"), await session.nextOfType("ack")];
    expect(acks.map((a) => (a.payload as { of: string }).of)).toEqual(["i-1", "i-2"]);
    expect(calls).toEqual(["up", "speaking", ["joy", 0.8]]);
    session.hangUp();
    await until(() => calls.includes("down"));
  });

  it("reconnects with the same token after the core hangs up or the link drops", async () => {
    const { core, codes, satellite } = await start([AUDIO_CAPTURE]);
    const first = await core.sessions.next();
    await greet(first, []);
    first.hangUp();
    const second = await core.sessions.next();
    await greet(second, []);
    second.drop();
    const third = await core.sessions.next();
    expect((await third.received.next()).type).toBe("hello");
    expect(codes).toHaveLength(1);
    expect(new Set(core.offers.map((o) => o.authorization))).toEqual(new Set(["Bearer nst1_token-1"]));
    expect(satellite.connections).toBe(3);
  });

  it("forgets a refused token and pairs again", async () => {
    const tokens = new MemoryTokenStore();
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc });
    tokens.save(core.url, DEVICE.id, "nst1_from-another-life");
    const { codes } = await start([AUDIO_CAPTURE], { tokens }, core);
    const session = await core.sessions.next();
    await greet(session, []);
    expect(core.offers.map((o) => o.authorization)).toEqual(["Bearer nst1_from-another-life", "Bearer nst1_token-1"]);
    expect(codes).toHaveLength(1);
    expect(tokens.load(core.url, DEVICE.id)).toBe("nst1_token-1");
  });

  it("pairs again when the household revokes it while it is connected", async () => {
    const { core, codes } = await start([AUDIO_CAPTURE]);
    const first = await core.sessions.next();
    await greet(first, []);
    core.revoke(DEVICE.id);
    first.hangUp();
    const second = await core.sessions.next();
    await greet(second, []);
    expect(codes).toHaveLength(2);
    expect(core.offers.at(-1)?.authorization).toBe("Bearer nst1_token-2");
  });

  it("drops a connection that is never welcomed, and tries again", async () => {
    const { core } = await start([AUDIO_CAPTURE], { welcomeTimeoutMs: 30 });
    const mute = await core.sessions.next();
    await mute.received.next(); // hello, never answered
    const again = await core.sessions.next();
    expect((await again.received.next()).type).toBe("hello");
  });

  it("keeps trying a core that is down, backing off, until stopped", async () => {
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc });
    core.failWith = 503;
    const warn = vi.fn();
    const run = await start([AUDIO_CAPTURE], { logger: { ...silent, warn } }, core);
    await until(() => warn.mock.calls.length >= 3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("503"));
    core.failWith = null;
    const session = await core.sessions.next();
    expect((await session.received.next()).type).toBe("hello");
    expect(run.codes).toHaveLength(1);
  });

  it("stops cleanly while it waits for the pairing code to be confirmed", async () => {
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc, pendingPolls: 1_000_000 });
    const run = await start([AUDIO_CAPTURE], {}, core);
    await until(() => run.codes.length === 1);
    await run.stop();
    running = null;
    await expect(run.done).resolves.toBeUndefined();
    expect(webrtc.closed).toBe(1);
  });

  it("fails clearly when the audio a declared capability needs cannot open", async () => {
    const webrtc: WebRtc = {
      open: async () => {
        throw new Error("audio.capture is declared but the microphone did not open");
      },
      createPeer: () => {
        throw new Error("never");
      },
    };
    const satellite = new Satellite({
      core: "http://127.0.0.1:9",
      manifest: Manifest.of(DEVICE, AUDIO_CAPTURE),
      tokens: new MemoryTokenStore(),
      webrtc,
      logger: silent,
    });
    await expect(satellite.run()).rejects.toThrow(/microphone/);
  });

  it("cannot run twice at once", async () => {
    const { satellite } = await start([AUDIO_CAPTURE]);
    await expect(satellite.run()).rejects.toThrow(/already running/);
  });
});

describe("observations", () => {
  it("are sent once welcomed, and follow what the household allowed", async () => {
    const { core, satellite } = await start([PERSON_DETECTION, SPEECH_ACTIVITY]);
    const session = await core.sessions.next();
    await greet(session, [PERSON_DETECTION]);
    await until(() => satellite.connected);
    expect(satellite.personDetected(2, 0.9)).toBe(true);
    expect(await session.nextOfType("observation.person.detected")).toMatchObject({
      payload: { count: 2, confidence: 0.9 },
    });
    expect(() => satellite.speechActivity(true)).toThrow(CapabilityNotAllowed);
  });

  it("need their capability declared, and are not queued while disconnected", async () => {
    const satellite = new Satellite({
      core: "http://127.0.0.1:9",
      manifest: Manifest.of(DEVICE, PERSON_DETECTION),
      tokens: new MemoryTokenStore(),
      webrtc: new FakeWebRtc(),
    });
    expect(() => satellite.speechActivity(true)).toThrow(CapabilityNotAllowed);
    expect(satellite.personDetected(1, 0.9)).toBe(false);
    expect(() => satellite.personDetected(-1, 0.9)).toThrow();
  });

  it("from a device without optional capabilities: none can be sent, and the link still works", async () => {
    const { core, satellite } = await start([]);
    const session = await core.sessions.next();
    await greet(session, []);
    session.send(message("intent.beat", {}, "i-1"));
    expect(await session.nextOfType("ack")).toMatchObject({ payload: { of: "i-1" } });
    expect(() => satellite.personDetected(1, 1)).toThrow(CapabilityNotAllowed);
  });
});

it("counts audio from the core as a heartbeat", async () => {
  const heartbeat = vi.fn();
  const { core } = await start([AUDIO_PLAYBACK], { body: { heartbeat } });
  const session = await core.sessions.next();
  session.audio();
  expect(heartbeat).toHaveBeenCalled();
});
