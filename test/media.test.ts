/**
 * Watching and calling through a satellite, rules M1 to M7 of `nestor.satellite/1`, against a fake
 * core that can also ask what a real one never would. The real browser path is in `pnpm conformance`.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  type Logger,
  Manifest,
  MEDIA_INDICATOR,
  MemoryTokenStore,
  ProtocolError,
  Satellite,
  type SatelliteOptions,
  VIDEO_CAPTURE,
} from "../src/index.js";
import { type AudioSession, type FakePeer, FakeVoice } from "./support/audio.js";
import { FakeCamera, PICTURE } from "./support/camera.js";
import { type CoreLink, FakeCore, message, until } from "./support/core.js";

const DEVICE = { id: "camera-entree", model: "raspberry-pi-zero", room: "entree" };
const CALL = [AUDIO_CAPTURE, AUDIO_PLAYBACK];
const EVERYTHING = [VIDEO_CAPTURE, ...CALL, MEDIA_INDICATOR];

interface Running {
  core: FakeCore<AudioSession>;
  camera: FakeCamera;
  voice: FakeVoice;
  shown: boolean[];
  warnings: string[];
  satellite: Satellite;
}

let stop: (() => Promise<void>) | null = null;

afterEach(async () => {
  await stop?.();
  stop = null;
});

type Given = { [K in keyof SatelliteOptions]?: SatelliteOptions[K] | undefined };

async function start(options: Given = {}): Promise<Running> {
  const voice = new FakeVoice();
  const core = await FakeCore.start<AudioSession>({ voice });
  const camera = new FakeCamera();
  const shown: boolean[] = [];
  const warnings: string[] = [];
  const logger: Logger = { debug: () => {}, info: () => {}, warn: (line) => warnings.push(line) };
  const satellite = new Satellite({
    core: core.url,
    manifest: Manifest.of(DEVICE),
    tokens: new MemoryTokenStore(),
    pairing: { pollMs: 5 },
    backoffMs: [5, 20],
    logger,
    locale: "en",
    camera,
    voice,
    onMedia: (active) => shown.push(active),
    ...options,
  } as SatelliteOptions);
  const stopping = new AbortController();
  const done = satellite.run(stopping.signal);
  stop = async () => {
    stopping.abort();
    await done.catch(() => {});
    await core.stop();
  };
  return { core, camera, voice, shown, warnings, satellite };
}

async function welcomed(running: Running, allowed: string[], voice = true): Promise<CoreLink> {
  const link = await running.core.links.next();
  link.welcome(allowed, "entree", voice);
  await until(() => running.satellite.connected);
  return link;
}

function open(link: CoreLink, session: string, asked: { video: boolean; audio: boolean; maxS?: number }, id?: string) {
  const { video, audio, maxS = 60 } = asked;
  link.send(message("intent.media.open", { session, video, audio, max_s: maxS }, id));
}

function peerOf(running: Running, sdp: string): FakePeer {
  const peer = [...running.voice.peers, ...running.camera.peers.map((made) => made.peer)].find((p) => p.id === sdp);
  if (peer === undefined) throw new Error(`no peer offered ${sdp}`);
  return peer;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("media sessions", () => {
  it("are declared by a camera and an indicator, and refused when declared without them", () => {
    const tokens = new MemoryTokenStore();
    const given = new Satellite({ core: "http://n", manifest: Manifest.of(DEVICE), tokens, camera: new FakeCamera() });
    expect([...given.manifest.names]).toEqual([VIDEO_CAPTURE]);
    const shown = new Satellite({ core: "http://n", manifest: Manifest.of(DEVICE), tokens, onMedia: () => {} });
    expect([...shown.manifest.names]).toEqual([MEDIA_INDICATOR]);
    for (const claimed of [VIDEO_CAPTURE, MEDIA_INDICATOR]) {
      expect(() => new Satellite({ core: "http://n", manifest: Manifest.of(DEVICE, claimed), tokens })).toThrow(
        ProtocolError,
      );
    }
  });

  it("connect only for a session the link asks for, with what it asks (M1)", async () => {
    const running = await start();
    const link = await welcomed(running, EVERYTHING);
    await pause(200);
    expect(running.core.mediaOffers).toEqual([]);
    expect(running.camera.opened).toBe(0);
    running.core.opened.add("watch");
    open(link, "watch", { video: true, audio: false });
    const offer = await running.core.media.next();
    expect(offer).toMatchObject({ deviceId: DEVICE.id, session: "watch" });
    expect(running.camera.peers).toEqual([{ peer: peerOf(running, offer.sdp), call: null }]);
    expect(running.camera.on).toBe(true);
    await until(() => peerOf(running, offer.sdp).accepted);
  });

  it.each([
    ["filming not allowed", [...CALL, MEDIA_INDICATOR], {}, { video: true, audio: false }],
    [
      "a call without a microphone",
      EVERYTHING,
      { voice: new FakeVoice({ capture: false }) },
      { video: false, audio: true },
    ],
    [
      "a call without playback allowed",
      [VIDEO_CAPTURE, AUDIO_CAPTURE, MEDIA_INDICATOR],
      {},
      { video: true, audio: true },
    ],
    ["a call without a voice", EVERYTHING, { voice: undefined }, { video: true, audio: true }],
    ["nothing", EVERYTHING, {}, { video: false, audio: false }],
  ] as const)(
    "refuse a session asking for more than the device has or was allowed: %s",
    async (_case, allowed, options, asked) => {
      const running = await start(options);
      const link = await welcomed(running, [...allowed]);
      running.core.opened.add("asked");
      open(link, "asked", asked, "open-1");
      expect((await link.nextOfType("ack")).payload).toEqual({ of: "open-1" }); // received, and refused
      await pause(200);
      expect(running.core.mediaOffers).toEqual([]);
      expect(running.shown).toEqual([]);
      expect(running.camera.opened).toBe(0);
      expect(running.warnings.join("\n")).toContain("was not allowed or cannot give: refused");
    },
  );

  it("end when told, at their time limit and when the link closes, releasing the camera (M2)", async () => {
    const running = await start();
    const { core, camera } = running;
    const link = await welcomed(running, EVERYTHING);
    core.opened.add("told").add("timed").add("linked");

    open(link, "told", { video: true, audio: false });
    const told = peerOf(running, (await core.media.next()).sdp);
    link.send(message("intent.media.close", { session: "told" }));
    await until(() => told.closed && !camera.on);

    const asked = Date.now();
    open(link, "timed", { video: true, audio: false, maxS: 1 });
    const timed = peerOf(running, (await core.media.next()).sdp);
    await until(() => timed.closed && !camera.on, 3000);
    expect(Date.now() - asked).toBeGreaterThanOrEqual(950);

    open(link, "linked", { video: true, audio: false });
    const linked = peerOf(running, (await core.media.next()).sdp);
    link.close(1001);
    await until(() => linked.closed && !camera.on);
    expect([camera.opened, camera.closed]).toEqual([3, 3]);
    await welcomed(running, EVERYTHING); // and the device carries on
  });

  it("end when the peer connection does, and release the camera when the core no longer waits", async () => {
    const running = await start();
    const { core, camera } = running;
    const link = await welcomed(running, EVERYTHING);
    core.opened.add("dropped");
    open(link, "dropped", { video: true, audio: false });
    peerOf(running, (await core.media.next()).sdp).events.onClosed("the connection failed");
    await until(() => !camera.on);
    open(link, "nobody", { video: true, audio: false }); // the core gave up on it meanwhile: 403
    await until(() => running.warnings.some((line) => line.includes("A session with Nestor failed")));
    await until(() => !camera.on && running.shown.length === 4);
    expect(running.shown).toEqual([true, false, true, false]);
  });

  it("are shown before anything is offered and until nothing is filmed, a picture included (M3)", async () => {
    const changes: [boolean, number][] = []; // each change, with the offers made by then
    let offers = () => 0;
    const running = await start({ onMedia: (active) => changes.push([active, offers()]) });
    const { core } = running;
    offers = () => core.mediaOffers.length;
    const link = await welcomed(running, EVERYTHING);
    core.opened.add("watch");
    open(link, "watch", { video: true, audio: false });
    await core.media.next();
    link.send(message("intent.media.close", { session: "watch" }));
    await until(() => changes.length === 2);
    link.send(message("intent.media.snapshot", {}));
    await link.nextOfType("media.snapshot");
    await until(() => changes.length === 4);
    expect(changes).toEqual([
      [true, 0],
      [false, 1],
      [true, 1],
      [false, 1],
    ]);
  });

  it("hang up the voice with the assistant for a call, and offer it again after (M5)", async () => {
    const running = await start({ camera: undefined });
    const { core, voice } = running;
    const link = await welcomed(running, CALL);
    const talking = await core.audio.next();
    core.opened.add("call");
    open(link, "call", { video: false, audio: true });
    const call = peerOf(running, (await core.media.next()).sdp);
    expect(talking.peer.closed).toBe(true);
    expect(voice.opened.at(-1)).toEqual({ capture: true, playback: true });
    const during = core.offers.length;
    await pause(200);
    expect(core.offers.length).toBe(during);
    link.send(message("intent.media.close", { session: "call" }));
    await until(() => call.closed);
    const again = await core.audio.next();
    expect(again.peer).not.toBe(talking.peer);
  });

  it("carry the voice's microphone and speaker with the camera's video in a call that films", async () => {
    const running = await start();
    const link = await welcomed(running, EVERYTHING);
    running.core.opened.add("call");
    open(link, "call", { video: true, audio: true });
    await running.core.media.next();
    expect(running.camera.peers.map((made) => made.call)).toEqual([running.voice]);
  });

  it("serve calls only on a core that does not talk with the device (A1)", async () => {
    const running = await start({ camera: undefined });
    const link = await welcomed(running, CALL, false);
    await pause(200);
    expect(running.core.offers).toEqual([]);
    running.core.opened.add("call");
    open(link, "call", { video: false, audio: true });
    await running.core.media.next();
    link.send(message("intent.media.close", { session: "call" }));
    await pause(200);
    expect(running.core.offers).toEqual([]);
  });

  it("send a still picture when asked, the camera on for it only (M6)", async () => {
    const running = await start();
    const link = await welcomed(running, EVERYTHING);
    link.send(message("intent.media.snapshot", {}, "picture-1"));
    const sent = await link.nextOfType("media.snapshot");
    expect(sent.payload).toEqual({ of: "picture-1", jpeg: Buffer.from(PICTURE).toString("base64") });
    await until(() => running.camera.closed === 1);
    expect(running.camera.opened).toBe(1);
  });

  it("take no picture when filming is not allowed", async () => {
    const running = await start();
    const link = await welcomed(running, [...CALL, MEDIA_INDICATOR]);
    link.send(message("intent.media.snapshot", {}, "picture-1"));
    expect((await link.nextOfType("ack")).payload).toEqual({ of: "picture-1" });
    await pause(200);
    expect([...link.received.pending].filter((m) => m.type === "media.snapshot")).toEqual([]);
    expect(running.camera.opened).toBe(0);
  });

  it("say that filming needs a secure link when the core refuses an insecure one, and try again (M7)", async () => {
    const running = await start();
    (await running.core.links.next()).close(4403);
    await until(() => running.warnings.some((line) => line.includes("over a secure connection")));
    await welcomed(running, EVERYTHING);
  });
});
