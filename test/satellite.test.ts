/** A satellite's life against a fake core: pairing, hello/welcome, acks, identify, observations, reconnection. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  type Body,
  CapabilityNotAllowed,
  EXPRESSION,
  IDENTIFY,
  type Logger,
  Manifest,
  MemoryTokenStore,
  PairingError,
  PERSON_DETECTION,
  ProtocolError,
  pairingMethods,
  type QrScanner,
  Satellite,
  type SatelliteOptions,
  SPEECH_ACTIVITY,
  type WebRtc,
} from "../src/index.js";
import { FakeCore, message, until, welcome } from "./support/core.js";
import { RecordingSpeaker } from "./support/voice.js";
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
    pairing: { display: (code) => void (code === null || codes.push(code)), pollMs: 5 },
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
    const manifest = Manifest.of(DEVICE, AUDIO_CAPTURE).withPairingMethods([
      "device_code.display",
      "enrollment.provisioning",
    ]);
    expect(hello).toMatchObject({ type: "hello", payload: { manifest: manifest.toJSON() } });
    expect(core.pairRequests).toEqual([{ manifest: manifest.toJSON() }]);
    expect(codes).toEqual(["042137"]);
    expect(tokens.load(core.url, DEVICE.id)).toBe("nst2_token-1");
    expect(core.offers[0]?.authorization).toBe("Bearer nst2_token-1");
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
    expect(new Set(core.offers.map((o) => o.authorization))).toEqual(new Set(["Bearer nst2_token-1"]));
    expect(satellite.connections).toBe(3);
  });

  it("forgets a refused token and pairs again", async () => {
    const tokens = new MemoryTokenStore();
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc });
    tokens.save(core.url, DEVICE.id, "nst2_from-another-life");
    const { codes } = await start([AUDIO_CAPTURE], { tokens }, core);
    const session = await core.sessions.next();
    await greet(session, []);
    expect(core.offers.map((o) => o.authorization)).toEqual(["Bearer nst2_from-another-life", "Bearer nst2_token-1"]);
    expect(codes).toHaveLength(1);
    expect(tokens.load(core.url, DEVICE.id)).toBe("nst2_token-1");
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
    expect(core.offers.at(-1)?.authorization).toBe("Bearer nst2_token-2");
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

describe("pairing", () => {
  it("declares the pairing methods its driver provides, configuration always", () => {
    const methods = (pairing: SatelliteOptions["pairing"]) =>
      new Satellite({
        core: "http://c",
        manifest: Manifest.of(DEVICE),
        tokens: new MemoryTokenStore(),
        webrtc: new FakeWebRtc(),
        ...(pairing === undefined ? {} : { pairing }),
      }).manifest.pairingMethods;
    expect(methods(undefined)).toEqual(["enrollment.provisioning"]);
    const scanner: QrScanner = { scan: async () => {} };
    expect(methods({ speak: () => {}, accepts: ["enrollment.input"], scanner })).toEqual([
      "device_code.speech",
      "enrollment.input",
      "enrollment.provisioning",
      "enrollment.qr",
    ]);
  });

  it("declares enrollment.qr only with a scanner, never from accepts alone", () => {
    const accepts = ["enrollment.qr"] as unknown as "enrollment.input"[];
    expect(() => pairingMethods({ accepts })).toThrow(/pairing.scanner/);
    expect(pairingMethods({ accepts: ["enrollment.input"] })).not.toContain("enrollment.qr");
  });

  it("pairs with an enrollment code read from a QR code while it waits, then closes the camera", async () => {
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc, codes: { K7QF2M9X: "valid" }, pendingPolls: Number.POSITIVE_INFINITY });
    let closed = false;
    const seen: string[] = [];
    const scanner: QrScanner = {
      scan: (found, signal) =>
        new Promise((resolve) => {
          const frames = ["https://example.com/menu", `nestor+${core.url}/?code=K7QF2M9X`];
          const timer = setInterval(() => {
            const text = frames.shift() ?? `nestor+${core.url}/?code=K7QF2M9X`; // seen in every frame
            seen.push(text);
            found(text);
          }, 5);
          signal.addEventListener("abort", () => {
            clearInterval(timer);
            closed = true;
            resolve();
          });
        }),
    };
    const { satellite } = await start([], { pairing: { scanner, pollMs: 5 } }, core);
    expect(satellite.manifest.pairingMethods).toContain("enrollment.qr");
    await greet(await core.sessions.next(), []);
    expect(core.enrollments).toEqual([{ enrollment_code: "K7QF2M9X", method: "enrollment.qr" }]);
    expect(closed).toBe(true);
    const scanned = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(scanned);
  });

  it("still pairs with its device code when the camera does not open, and says why", async () => {
    const warn = vi.fn();
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc });
    const scanner: QrScanner = { scan: () => Promise.reject(new Error("NotAllowedError")) };
    await start([], { pairing: { scanner, pollMs: 5 }, logger: { ...silent, warn }, locale: "en" }, core);
    await greet(await core.sessions.next(), []);
    expect(warn).toHaveBeenCalledWith(
      "The camera did not open, so this device cannot scan a QR code (NotAllowedError).",
    );
  });

  it("never sends an enrollment code refused before it restarted, even once its token is refused", async () => {
    const tokens = new MemoryTokenStore();
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc, codes: { K7QF2M9X: "used" } });
    const pairing = { enrollment: `nestor+${core.url}/?code=K7QF2M9X`, pollMs: 5 };
    const options = { core: core.url, manifest: Manifest.of(DEVICE), tokens, webrtc, pairing, logger: silent };
    const stopping = new AbortController();
    const first = new Satellite(options).run(stopping.signal);
    await greet(await core.sessions.next(), []);
    stopping.abort();
    await first;
    core.revoke(DEVICE.id); // at the next start, the token is refused and forgotten
    await start([], { ...options, backoffMs: [5, 20] }, core);
    await greet(await core.sessions.next(), []);
    expect(core.pairRequests.map((r) => r.enrollment_code)).toEqual(["K7QF2M9X", undefined, undefined]);
    expect(core.offers.map((o) => o.authorization)).toEqual([
      "Bearer nst2_token-1",
      "Bearer nst2_token-1",
      "Bearer nst2_token-2",
    ]);
  });

  it("pairs with the enrollment code it was configured with, presenting no device code", async () => {
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc, codes: { K7QF2M9X: "valid" } });
    const enrollment = `nestor+${core.url}/?code=K7QF-2M9X`;
    const { codes } = await start([AUDIO_CAPTURE], { pairing: { enrollment, pollMs: 5 } }, core);
    await greet(await core.sessions.next(), []);
    expect(core.pairRequests).toMatchObject([{ enrollment_code: "K7QF2M9X", method: "enrollment.provisioning" }]);
    expect(codes).toEqual([]);
  });

  it("without a screen or a voice, still pairs, its device code in the log", async () => {
    const warn = vi.fn();
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc });
    await start([AUDIO_CAPTURE], { pairing: { pollMs: 5 }, logger: { ...silent, warn } }, core);
    await greet(await core.sessions.next(), []);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("042137"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NESTOR_PAIRING_URI"));
  });

  it("takes an enrollment code typed while it waits", async () => {
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc, codes: { K7QF2M9X: "valid" }, pendingPolls: Number.POSITIVE_INFINITY });
    const { satellite } = await start([], { pairing: { accepts: ["enrollment.input"], pollMs: 5 } }, core);
    await until(() => satellite.pending);
    await expect(satellite.enroll("k7qf-2m9x")).resolves.toEqual({ status: "approved" });
    await greet(await core.sessions.next(), []);
    expect(core.enrollments).toEqual([{ enrollment_code: "K7QF2M9X", method: "enrollment.input" }]);
    await expect(satellite.enroll("K7QF2M9X")).resolves.toEqual({ status: "not_pending" });
  });

  it("refuses an enrollment code through a method it does not declare", () => {
    const satellite = new Satellite({
      core: "http://c",
      manifest: Manifest.of(DEVICE),
      tokens: new MemoryTokenStore(),
      webrtc: new FakeWebRtc(),
    });
    expect(() => satellite.enroll("K7QF2M9X", "enrollment.qr")).toThrow(/enrollment.qr/);
  });

  it("stops with a clear error when the core speaks another protocol version", async () => {
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc });
    core.protocolUnsupported = true;
    const run = await start([AUDIO_CAPTURE], { locale: "fr" }, core);
    await expect(run.done).rejects.toBeInstanceOf(PairingError);
    await expect(run.done).rejects.toThrow(/autre version du protocole/);
    expect(webrtc.closed).toBe(1);
  });
});

describe("identify", () => {
  it("is declared only with a body that can carry it out", () => {
    const options = { core: "http://c", tokens: new MemoryTokenStore(), webrtc: new FakeWebRtc() };
    expect(() => new Satellite({ ...options, manifest: Manifest.of(DEVICE, IDENTIFY) })).toThrow(ProtocolError);
    expect(
      () => new Satellite({ ...options, manifest: Manifest.of(DEVICE, IDENTIFY), body: { identify: () => {} } }),
    ).not.toThrow();
  });

  it("makes the device noticed while it waits to be paired, and once paired, acknowledged", async () => {
    const identify = vi.fn();
    const webrtc = new FakeWebRtc();
    const core = await FakeCore.start({ webrtc, pendingPolls: Number.POSITIVE_INFINITY });
    const { satellite } = await start([IDENTIFY], { body: { identify } }, core);
    await until(() => satellite.pending);
    core.identify();
    await until(() => identify.mock.calls.length === 1);
    core.approve();
    const session = await core.sessions.next();
    await greet(session, [IDENTIFY]);
    session.send(message("intent.identify", {}, "i-1"));
    expect(await session.nextOfType("ack")).toMatchObject({ payload: { of: "i-1" } });
    expect(identify).toHaveBeenCalledTimes(2);
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

describe("the device code said aloud", () => {
  const satellite = (capabilities: string[], options: Partial<SatelliteOptions> = {}, speaker?: RecordingSpeaker) =>
    new Satellite({
      core: "http://c",
      manifest: Manifest.of(DEVICE, ...capabilities),
      tokens: new MemoryTokenStore(),
      webrtc: new FakeWebRtc(speaker),
      ...options,
    });

  it("is declared for a device with a speaker and no screen, and said with the bundled voice", async () => {
    const speaker = new RecordingSpeaker();
    const webrtc = new FakeWebRtc(speaker);
    const core = await FakeCore.start({ webrtc, pendingPolls: Number.POSITIVE_INFINITY });
    const { satellite: s } = await start([AUDIO_PLAYBACK], { webrtc, pairing: { pollMs: 5 } }, core);
    expect(s.manifest.pairingMethods).toEqual(["device_code.speech", "enrollment.provisioning"]);
    await until(() => speaker.samples > 0);
    core.approve();
    await greet(await core.sessions.next(), []);
    const said = speaker.samples;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(speaker.samples).toBe(said);
  });

  it("is not declared without a speaker, nor without audio.playback", () => {
    expect(satellite([AUDIO_PLAYBACK]).manifest.pairingMethods).toEqual(["enrollment.provisioning"]);
    expect(satellite([], {}, new RecordingSpeaker()).manifest.pairingMethods).toEqual(["enrollment.provisioning"]);
    expect(() => satellite([], { pairing: { voice: true } }, new RecordingSpeaker())).toThrow(/audio.playback/);
  });

  it("is left to the screen when there is one, unless asked for", () => {
    const display = () => {};
    const speaker = new RecordingSpeaker();
    expect(satellite([AUDIO_PLAYBACK], { pairing: { display } }, speaker).manifest.pairingMethods).toEqual([
      "device_code.display",
      "enrollment.provisioning",
    ]);
    expect(satellite([AUDIO_PLAYBACK], { pairing: { display, voice: true } }, speaker).manifest.pairingMethods).toEqual(
      ["device_code.display", "device_code.speech", "enrollment.provisioning"],
    );
  });

  it("goes through the driver's own voice when it has one", async () => {
    const speaker = new RecordingSpeaker();
    const said: string[] = [];
    const webrtc = new FakeWebRtc(speaker);
    const core = await FakeCore.start({ webrtc });
    await start([AUDIO_PLAYBACK], { webrtc, pairing: { speak: (text) => said.push(text), pollMs: 5 } }, core);
    await greet(await core.sessions.next(), []);
    expect(said).toEqual(["Pairing code: 0, 4, 2, 1, 3, 7. I repeat: 0, 4, 2, 1, 3, 7."]);
    expect(speaker.samples).toBe(0);
  });
});
