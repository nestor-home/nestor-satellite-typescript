/** A satellite's life against a fake core: pairing, the link and its welcome, text, acks, identify, observations, audio. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  type Body,
  CapabilityNotAllowed,
  EXPRESSION,
  IDENTIFY,
  LinkReplaced,
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
  TEXT_DISPLAY,
  TEXT_INPUT,
} from "../src/index.js";
import { type AudioSession, FakeVoice } from "./support/audio.js";
import { type CoreLink, FakeCore, message, until } from "./support/core.js";
import { RecordingSpeaker } from "./support/voice.js";

const DEVICE = { id: "capteur-entree", model: "esp32", room: "entree" };
const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {} };

interface Running {
  core: FakeCore<AudioSession>;
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
  options: Partial<SatelliteOptions> = {},
  core?: FakeCore<AudioSession>,
): Promise<Running> {
  const fake = core ?? (await FakeCore.start<AudioSession>());
  const tokens = (options.tokens as MemoryTokenStore | undefined) ?? new MemoryTokenStore();
  const codes: string[] = [];
  const satellite = new Satellite({
    core: `${fake.url}/`,
    manifest: Manifest.of(DEVICE, ...capabilities),
    tokens,
    pairing: { display: (code) => void (code === null || codes.push(code)), pollMs: 5 },
    backoffMs: [5, 20],
    logger: silent,
    ...options,
  });
  const stopping = new AbortController();
  const done = satellite.run(stopping.signal);
  done.catch(() => {}); // tests that expect a rejection await it themselves
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

/** A core whose audio offers the voice answers, and that voice. */
async function voiced(options: ConstructorParameters<typeof FakeVoice>[0] = {}) {
  const voice = new FakeVoice(options);
  const core = await FakeCore.start<AudioSession>({ voice });
  return { voice, core };
}

/** The core's part of a link: answer its hello with a welcome. */
async function greet(core: FakeCore<AudioSession>, allowed: string[]): Promise<CoreLink> {
  const link = await core.links.next();
  link.welcome(allowed);
  return link;
}

describe("a satellite", () => {
  it("pairs once, opens its link with its token and says hello with its manifest", async () => {
    const { core, codes, tokens, satellite } = await start([PERSON_DETECTION]);
    const link = await greet(core, [PERSON_DETECTION]);
    const manifest = Manifest.of(DEVICE, PERSON_DETECTION).withPairingMethods([
      "device_code.display",
      "enrollment.provisioning",
    ]);
    expect(link.hello).toMatchObject({
      type: "hello",
      payload: { manifest: manifest.toJSON(), token: "nst1_token-1" },
    });
    expect(core.pairRequests).toEqual([{ manifest: manifest.toJSON() }]);
    expect(codes).toEqual(["042137"]);
    expect(tokens.load(core.url, DEVICE.id)).toBe("nst1_token-1");
    await until(() => satellite.connected);
    expect([...(satellite.welcome?.capabilities ?? [])]).toEqual([PERSON_DETECTION]);
  });

  it("carries out intents and acknowledges each by id; the body hears when the link is up", async () => {
    const calls: unknown[] = [];
    const body: Body = {
      behavior: (b) => calls.push(b),
      expression: (e, i) => calls.push([e, i]),
      connected: (up) => calls.push(up ? "up" : "down"),
    };
    const { core, satellite } = await start([EXPRESSION], { body });
    const link = await greet(core, [EXPRESSION]);
    await until(() => satellite.connected);
    link.send(message("intent.behavior", { behavior: "speaking" }, "i-1"));
    link.send(message("intent.expression", { expression: "joy", intensity: 0.8 }, "i-2"));
    const acks = [await link.nextOfType("ack"), await link.nextOfType("ack")];
    expect(acks.map((a) => (a.payload as { of: string }).of)).toEqual(["i-1", "i-2"]);
    expect(calls).toEqual(["up", "speaking", ["joy", 0.8]]);
    link.close(1001);
    await until(() => calls.includes("down"));
  });

  it("reconnects with the same token when the core stops or the link drops", async () => {
    const { core, codes, satellite } = await start([]);
    const first = await greet(core, []);
    first.close(1001);
    const second = await greet(core, []);
    second.drop();
    const third = await core.links.next();
    expect(third.hello.type).toBe("hello");
    expect(codes).toHaveLength(1);
    expect(core.pairRequests).toHaveLength(1);
    expect(satellite.connections).toBe(3);
  });

  it("forgets a refused token and pairs again", async () => {
    const tokens = new MemoryTokenStore();
    const core = await FakeCore.start<AudioSession>();
    tokens.save(core.url, DEVICE.id, "nst1_from-another-life");
    const { codes } = await start([], { tokens }, core);
    await greet(core, []);
    expect(core.refusedLinks).toEqual([4401]);
    expect(codes).toHaveLength(1);
    expect(tokens.load(core.url, DEVICE.id)).toBe("nst1_token-1");
  });

  it("pairs again when the household revokes it while it is linked", async () => {
    const { core, codes } = await start([]);
    const first = await greet(core, []);
    core.revoke(DEVICE.id);
    first.close(1001);
    const second = await greet(core, []);
    expect(codes).toHaveLength(2);
    expect((second.hello.payload as { token: string }).token).toBe("nst1_token-2");
  });

  it("stops when a newer link of the same device replaces its own", async () => {
    const body = { connected: vi.fn() };
    const { core, done, satellite } = await start([], { body });
    const link = await greet(core, []);
    await until(() => satellite.connected);
    link.close(4409);
    await expect(done).rejects.toBeInstanceOf(LinkReplaced);
    expect(body.connected).toHaveBeenLastCalledWith(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(core.links.pending).toHaveLength(0);
    expect(satellite.connections).toBe(1);
  });

  it("says why it stops when replaced, in its language", async () => {
    const { core, done } = await start([], { locale: "fr" });
    (await greet(core, [])).close(4409);
    await expect(done).rejects.toThrow(/reconnecté à Nestor ailleurs/);
  });

  it("reconnects after a link closed as off-contract", async () => {
    const { core } = await start([]);
    (await greet(core, [])).close(4400);
    expect((await core.links.next()).hello.type).toBe("hello");
  });

  it("drops a link that is never welcomed, and tries again", async () => {
    const { core } = await start([], { welcomeTimeoutMs: 30 });
    const mute = await core.links.next(); // hello, never answered
    await until(() => mute.closed);
    expect((await core.links.next()).hello.type).toBe("hello");
  });

  it("keeps trying a core that is down, backing off, until stopped", async () => {
    const core = await FakeCore.start<AudioSession>();
    core.failWith = 503;
    const warn = vi.fn();
    const run = await start([], { logger: { ...silent, warn } }, core);
    await until(() => warn.mock.calls.length >= 3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("503"));
    core.failWith = null;
    expect((await core.links.next()).hello.type).toBe("hello");
    expect(run.codes).toHaveLength(1);
  });

  it("stops cleanly while it waits for the pairing code to be confirmed", async () => {
    const core = await FakeCore.start<AudioSession>({ pendingPolls: 1_000_000 });
    const run = await start([], {}, core);
    await until(() => run.codes.length === 1);
    await run.stop();
    running = null;
    await expect(run.done).resolves.toBeUndefined();
  });

  it("stops cleanly while it is linked, closing its link", async () => {
    const run = await start([]);
    const link = await greet(run.core, []);
    await until(() => run.satellite.connected);
    await run.stop();
    running = null;
    await expect(run.done).resolves.toBeUndefined();
    expect(run.satellite.connected).toBe(false);
    await until(() => link.closed);
  });

  it("cannot run twice at once", async () => {
    const { satellite } = await start([]);
    await expect(satellite.run()).rejects.toThrow(/already running/);
  });
});

describe("in writing", () => {
  it("declares text.display for a display callback and text.input when it takes typed text", () => {
    const names = (text: SatelliteOptions["text"]) =>
      new Satellite({
        core: "http://c",
        manifest: Manifest.of(DEVICE),
        tokens: new MemoryTokenStore(),
        ...(text === undefined ? {} : { text }),
      }).manifest.names;
    expect([...names(undefined)]).toEqual([]);
    expect([...names({ display: () => {} })]).toEqual([TEXT_DISPLAY]);
    expect([...names({ display: () => {}, input: true })]).toEqual([TEXT_INPUT, TEXT_DISPLAY]);
  });

  it("refuses a text capability declared without what it needs", () => {
    const options = { core: "http://c", tokens: new MemoryTokenStore() };
    expect(() => new Satellite({ ...options, manifest: Manifest.of(DEVICE, TEXT_DISPLAY) })).toThrow(/text.display/);
    expect(() => new Satellite({ ...options, manifest: Manifest.of(DEVICE, TEXT_INPUT) })).toThrow(/text.input/);
  });

  it("sends what a person typed, and shows the assistant's words in order, acknowledged", async () => {
    const shown: [string, boolean][] = [];
    const text = { input: true, display: (words: string, final: boolean) => void shown.push([words, final]) };
    const { core, satellite } = await start([], { text });
    const link = await greet(core, [TEXT_INPUT, TEXT_DISPLAY]);
    await until(() => satellite.connected);
    expect(satellite.sendText("Quelle heure est-il ?")).toBe(true);
    expect(await link.nextOfType("input.text")).toMatchObject({ payload: { text: "Quelle heure est-il ?" } });
    link.send(message("intent.text", { text: "Je regarde.", final: false }, "t-1"));
    link.send(message("intent.text", { text: "Il est midi." }, "t-2"));
    const acks = [await link.nextOfType("ack"), await link.nextOfType("ack")];
    expect(acks.map((a) => (a.payload as { of: string }).of)).toEqual(["t-1", "t-2"]);
    expect(shown).toEqual([
      ["Je regarde.", false],
      ["Il est midi.", true],
    ]);
  });

  it("is not sent while the link is down, nor when typed text is not allowed, nor empty", async () => {
    const satellite = new Satellite({
      core: "http://127.0.0.1:9",
      manifest: Manifest.of(DEVICE),
      tokens: new MemoryTokenStore(),
      text: { input: true },
    });
    expect(satellite.sendText("bonjour")).toBe(false);
    expect(() => satellite.sendText("")).toThrow(ProtocolError);
    const { core, satellite: linked } = await start([], { text: { input: true } });
    await greet(core, []);
    await until(() => linked.connected);
    expect(() => linked.sendText("bonjour")).toThrow(CapabilityNotAllowed);
  });

  it("needs no voice at all: a text-only device pairs, links and never offers audio", async () => {
    const shown: string[] = [];
    const { core, satellite } = await start([], { text: { input: true, display: (t) => void shown.push(t) } });
    const link = await greet(core, [TEXT_INPUT, TEXT_DISPLAY, AUDIO_CAPTURE]);
    await until(() => satellite.connected);
    link.send(message("intent.text", { text: "Bonjour." }, "t-1"));
    await link.nextOfType("ack");
    expect(shown).toEqual(["Bonjour."]);
    expect(core.offers).toEqual([]);
  });
});

describe("aloud", () => {
  it("declares the audio its voice has", () => {
    const names = (voice: FakeVoice) =>
      new Satellite({ core: "http://c", manifest: Manifest.of(DEVICE), tokens: new MemoryTokenStore(), voice }).manifest
        .names;
    expect([...names(new FakeVoice())]).toEqual([AUDIO_CAPTURE, AUDIO_PLAYBACK]);
    expect([...names(new FakeVoice({ capture: false }))]).toEqual([AUDIO_PLAYBACK]);
    expect(
      () =>
        new Satellite({
          core: "http://c",
          manifest: Manifest.of(DEVICE, AUDIO_CAPTURE),
          tokens: new MemoryTokenStore(),
        }),
    ).toThrow(/audio.capture is declared: it needs a voice with a microphone/);
  });

  it("offers audio only once welcomed with audio allowed, and opens what the welcome allows", async () => {
    const { voice, core } = await voiced();
    const run = await start([], { voice }, core);
    const link = await core.links.next();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(core.offers).toEqual([]);
    expect(voice.opened).toEqual([]);
    link.welcome([AUDIO_PLAYBACK]);
    const session = await core.audio.next();
    expect(core.offers[0]?.at).toBeGreaterThanOrEqual(link.welcomedAt ?? Number.POSITIVE_INFINITY);
    expect(core.offers[0]?.authorization).toBe("Bearer nst1_token-1");
    expect(voice.opened).toEqual([{ capture: false, playback: true }]);
    await until(() => session.peer.accepted);
    expect(run.satellite.audioConnections).toBe(1);
  });

  it("offers no audio, and never opens the microphone, when audio is not allowed", async () => {
    const { voice, core } = await voiced();
    const { satellite } = await start([], { voice }, core);
    await greet(core, [IDENTIFY]);
    await until(() => satellite.connected);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(core.offers).toEqual([]);
    expect(voice.opened).toEqual([]);
  });

  it("pairs and links while the microphone waits for a person, and offers again once it opens", async () => {
    const { voice, core } = await voiced();
    voice.openFailures = 2;
    const warn = vi.fn();
    const { satellite } = await start([], { voice, logger: { ...silent, warn }, locale: "en" }, core);
    await greet(core, [AUDIO_CAPTURE, AUDIO_PLAYBACK]);
    await until(() => satellite.connected);
    await core.audio.next();
    expect(voice.opened).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("The audio connection to Nestor failed (NotAllowedError"),
    );
  });

  it("offers audio again when it fails while the link is up, and hangs it up with the link", async () => {
    const { voice, core } = await voiced();
    core.audioFailures = 1;
    const { satellite } = await start([], { voice }, core);
    const link = await greet(core, [AUDIO_CAPTURE]);
    const first = await core.audio.next();
    expect(core.offers).toHaveLength(2);
    first.drop();
    const second = await core.audio.next();
    expect(first.peer.closed).toBe(true);
    link.close(1001);
    await until(() => second.peer.closed);
    expect(satellite.audioConnections).toBe(2);
    const closes = voice.closed;
    await greet(core, [AUDIO_CAPTURE]); // reconnected: audio again
    await core.audio.next();
    expect(voice.closed).toBe(closes);
  });

  it("counts audio from the core as a heartbeat", async () => {
    const heartbeat = vi.fn();
    const { voice, core } = await voiced();
    await start([], { voice, body: { heartbeat } }, core);
    await greet(core, [AUDIO_PLAYBACK]);
    const session = await core.audio.next();
    heartbeat.mockClear();
    session.audio();
    expect(heartbeat).toHaveBeenCalled();
  });

  it("forgets its token and pairs again when an audio offer refuses it", async () => {
    const { voice, core } = await voiced();
    const { codes } = await start([], { voice }, core);
    const first = await core.links.next();
    core.revoke(DEVICE.id);
    first.welcome([AUDIO_CAPTURE]);
    const second = await core.links.next();
    expect(core.offers.map((o) => o.authorization)).toEqual(["Bearer nst1_token-1"]);
    expect((second.hello.payload as { token: string }).token).toBe("nst1_token-2");
    expect(codes).toHaveLength(2);
    expect(first.closed).toBe(true);
  });
});

describe("pairing", () => {
  it("declares the pairing methods its driver provides, configuration always", () => {
    const methods = (pairing: SatelliteOptions["pairing"]) =>
      new Satellite({
        core: "http://c",
        manifest: Manifest.of(DEVICE),
        tokens: new MemoryTokenStore(),
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
    const core = await FakeCore.start<AudioSession>({
      codes: { K7QF2M9X: "valid" },
      pendingPolls: Number.POSITIVE_INFINITY,
    });
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
    await greet(core, []);
    expect(core.enrollments).toEqual([{ enrollment_code: "K7QF2M9X", method: "enrollment.qr" }]);
    expect(closed).toBe(true);
    const scanned = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(scanned);
  });

  it("still pairs with its device code when the camera does not open, and says why", async () => {
    const warn = vi.fn();
    const core = await FakeCore.start<AudioSession>();
    const scanner: QrScanner = { scan: () => Promise.reject(new Error("NotAllowedError")) };
    await start([], { pairing: { scanner, pollMs: 5 }, logger: { ...silent, warn }, locale: "en" }, core);
    await greet(core, []);
    expect(warn).toHaveBeenCalledWith(
      "The camera did not open, so this device cannot scan a QR code (NotAllowedError).",
    );
  });

  it("never sends an enrollment code refused before it restarted, even once its token is refused", async () => {
    const tokens = new MemoryTokenStore();
    const core = await FakeCore.start<AudioSession>({ codes: { K7QF2M9X: "used" } });
    const pairing = { enrollment: `nestor+${core.url}/?code=K7QF2M9X`, pollMs: 5 };
    const options = { core: core.url, manifest: Manifest.of(DEVICE), tokens, pairing, logger: silent };
    const stopping = new AbortController();
    const first = new Satellite(options).run(stopping.signal);
    await greet(core, []);
    stopping.abort();
    await first;
    core.revoke(DEVICE.id); // at the next start, the token is refused and forgotten
    await start([], { ...options, backoffMs: [5, 20] }, core);
    const link = await greet(core, []);
    expect(core.pairRequests.map((r) => r.enrollment_code)).toEqual(["K7QF2M9X", undefined, undefined]);
    expect(core.refusedLinks).toEqual([4401]);
    expect((link.hello.payload as { token: string }).token).toBe("nst1_token-2");
  });

  it("pairs with the enrollment code it was configured with, presenting no device code", async () => {
    const core = await FakeCore.start<AudioSession>({ codes: { K7QF2M9X: "valid" } });
    const enrollment = `nestor+${core.url}/?code=K7QF-2M9X`;
    const { codes } = await start([], { pairing: { enrollment, pollMs: 5 } }, core);
    await greet(core, []);
    expect(core.pairRequests).toMatchObject([{ enrollment_code: "K7QF2M9X", method: "enrollment.provisioning" }]);
    expect(codes).toEqual([]);
  });

  it("without a screen or a voice, still pairs, its device code in the log", async () => {
    const warn = vi.fn();
    const core = await FakeCore.start<AudioSession>();
    await start([], { pairing: { pollMs: 5 }, logger: { ...silent, warn } }, core);
    await greet(core, []);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("042137"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NESTOR_PAIRING_URI"));
  });

  it("takes an enrollment code typed while it waits", async () => {
    const core = await FakeCore.start<AudioSession>({
      codes: { K7QF2M9X: "valid" },
      pendingPolls: Number.POSITIVE_INFINITY,
    });
    const { satellite } = await start([], { pairing: { accepts: ["enrollment.input"], pollMs: 5 } }, core);
    await until(() => satellite.pending);
    await expect(satellite.enroll("k7qf-2m9x")).resolves.toEqual({ status: "approved" });
    await greet(core, []);
    expect(core.enrollments).toEqual([{ enrollment_code: "K7QF2M9X", method: "enrollment.input" }]);
    await expect(satellite.enroll("K7QF2M9X")).resolves.toEqual({ status: "not_pending" });
  });

  it("refuses an enrollment code through a method it does not declare", () => {
    const satellite = new Satellite({
      core: "http://c",
      manifest: Manifest.of(DEVICE),
      tokens: new MemoryTokenStore(),
    });
    expect(() => satellite.enroll("K7QF2M9X", "enrollment.qr")).toThrow(/enrollment.qr/);
  });

  it("stops with a clear error when the core speaks another protocol version", async () => {
    const { voice, core } = await voiced();
    core.protocolUnsupported = true;
    const run = await start([], { voice, locale: "fr" }, core);
    await expect(run.done).rejects.toBeInstanceOf(PairingError);
    await expect(run.done).rejects.toThrow(/autre version du protocole/);
    expect(voice.opened).toEqual([]);
  });
});

describe("identify", () => {
  it("is declared only with a body that can carry it out", () => {
    const options = { core: "http://c", tokens: new MemoryTokenStore() };
    expect(() => new Satellite({ ...options, manifest: Manifest.of(DEVICE, IDENTIFY) })).toThrow(ProtocolError);
    expect(
      () => new Satellite({ ...options, manifest: Manifest.of(DEVICE, IDENTIFY), body: { identify: () => {} } }),
    ).not.toThrow();
  });

  it("makes the device noticed while it waits to be paired, and once paired, acknowledged", async () => {
    const identify = vi.fn();
    const core = await FakeCore.start<AudioSession>({ pendingPolls: Number.POSITIVE_INFINITY });
    const { satellite } = await start([IDENTIFY], { body: { identify } }, core);
    await until(() => satellite.pending);
    core.identify();
    await until(() => identify.mock.calls.length === 1);
    core.approve();
    const link = await greet(core, [IDENTIFY]);
    link.send(message("intent.identify", {}, "i-1"));
    expect(await link.nextOfType("ack")).toMatchObject({ payload: { of: "i-1" } });
    expect(identify).toHaveBeenCalledTimes(2);
  });
});

describe("observations", () => {
  it("are sent once welcomed, and follow what the household allowed", async () => {
    const { core, satellite } = await start([PERSON_DETECTION, SPEECH_ACTIVITY]);
    const link = await greet(core, [PERSON_DETECTION]);
    await until(() => satellite.connected);
    expect(satellite.personDetected(2, 0.9)).toBe(true);
    expect(await link.nextOfType("observation.person.detected")).toMatchObject({
      payload: { count: 2, confidence: 0.9 },
    });
    expect(() => satellite.speechActivity(true)).toThrow(CapabilityNotAllowed);
  });

  it("need their capability declared, and are not queued while disconnected", () => {
    const satellite = new Satellite({
      core: "http://127.0.0.1:9",
      manifest: Manifest.of(DEVICE, PERSON_DETECTION),
      tokens: new MemoryTokenStore(),
    });
    expect(() => satellite.speechActivity(true)).toThrow(CapabilityNotAllowed);
    expect(satellite.personDetected(1, 0.9)).toBe(false);
    expect(() => satellite.personDetected(-1, 0.9)).toThrow();
  });

  it("from a device without optional capabilities: none can be sent, and the link still works", async () => {
    const { core, satellite } = await start([]);
    const link = await greet(core, []);
    link.send(message("intent.beat", {}, "i-1"));
    expect(await link.nextOfType("ack")).toMatchObject({ payload: { of: "i-1" } });
    expect(() => satellite.personDetected(1, 1)).toThrow(CapabilityNotAllowed);
  });
});

describe("the device code said aloud", () => {
  const satellite = (options: Partial<SatelliteOptions> = {}) =>
    new Satellite({ core: "http://c", manifest: Manifest.of(DEVICE), tokens: new MemoryTokenStore(), ...options });

  it("is declared for a voice with a speaker and no screen, and said with the bundled voice", async () => {
    const speaker = new RecordingSpeaker();
    const voice = new FakeVoice({ speaker });
    const core = await FakeCore.start<AudioSession>({ voice, pendingPolls: Number.POSITIVE_INFINITY });
    const { satellite: s } = await start([], { voice, pairing: { pollMs: 5 } }, core);
    expect(s.manifest.pairingMethods).toEqual(["device_code.speech", "enrollment.provisioning"]);
    await until(() => speaker.samples > 0);
    expect(voice.opened).toEqual([]); // the speaker says the code; the microphone stays closed
    core.approve();
    await greet(core, []);
    const said = speaker.samples;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(speaker.samples).toBe(said);
  });

  it("is not declared without a speaker, nor for a voice without playback", () => {
    expect(satellite({ voice: new FakeVoice() }).manifest.pairingMethods).toEqual(["enrollment.provisioning"]);
    const speaker = new RecordingSpeaker();
    expect(satellite({ voice: new FakeVoice({ speaker, playback: false }) }).manifest.pairingMethods).toEqual([
      "enrollment.provisioning",
    ]);
    expect(() => satellite({ pairing: { voice: true } })).toThrow(/a voice with a speaker/);
  });

  it("is left to the screen when there is one, unless asked for", () => {
    const display = () => {};
    const voice = new FakeVoice({ speaker: new RecordingSpeaker() });
    expect(satellite({ voice, pairing: { display } }).manifest.pairingMethods).toEqual([
      "device_code.display",
      "enrollment.provisioning",
    ]);
    expect(satellite({ voice, pairing: { display, voice: true } }).manifest.pairingMethods).toEqual([
      "device_code.display",
      "device_code.speech",
      "enrollment.provisioning",
    ]);
  });

  it("goes through the driver's own voice when it has one", async () => {
    const speaker = new RecordingSpeaker();
    const said: string[] = [];
    const voice = new FakeVoice({ speaker });
    const core = await FakeCore.start<AudioSession>({ voice });
    await start([], { voice, pairing: { speak: (text) => said.push(text), pollMs: 5 } }, core);
    await greet(core, []);
    expect(said).toEqual(["Pairing code: 0, 4, 2, 1, 3, 7. I repeat: 0, 4, 2, 1, 3, 7."]);
    expect(speaker.samples).toBe(0);
  });
});
