/** Pairing against a fake core: device codes, enrollment codes, refusals, rate limits, identify. */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpError,
  hashEnrollmentCode,
  type Logger,
  Manifest,
  MemoryTokenStore,
  Messages,
  Pairing,
  PairingError,
  type PairingOptions,
} from "../src/index.js";
import { FileTokenStore } from "../src/node/tokens.js";
import { SpokenCode } from "../src/voice/index.js";
import { FakeCore, until } from "./support/core.js";
import { RecordingSpeaker } from "./support/voice.js";

const MANIFEST = Manifest.of({ id: "enceinte-salon", model: "raspberry-pi-4", room: "salon" }, "audio.capture");
const CODE = "K7QF2M9X";
const URI = (core: FakeCore) => `nestor+${core.url}/?code=k7qf-2m9x`;

interface Seen {
  logs: string[];
  shown: [string | null, string][];
  said: string[];
  logger: Logger;
}

function seen(): Seen {
  const logs: string[] = [];
  const keep = (line: string) => void logs.push(line);
  return { logs, shown: [], said: [], logger: { debug: () => {}, info: keep, warn: keep } };
}

let core: FakeCore;
afterEach(() => core?.stop());

function pairing(options: Partial<PairingOptions> & { seen?: Seen } = {}): Pairing {
  const { seen: outputs = seen(), ...rest } = options;
  return new Pairing({
    core: core.url,
    manifest: MANIFEST,
    pollMs: 5,
    logger: outputs.logger,
    messages: new Messages("en"),
    ...rest,
  });
}

describe("with no enrollment code", () => {
  it("presents its device code on its screen, aloud and in its log, then gets the token", async () => {
    core = await FakeCore.start({ pendingPolls: 2 });
    const s = seen();
    const display = (code: string | null, text: string) => void s.shown.push([code, text]);
    const speak = (text: string) => void s.said.push(text);
    const paired = await pairing({ seen: s, outputs: { display, speak } }).run();
    expect(paired.token).toBe("nst1_token-1");
    expect(core.pairRequests).toEqual([{ manifest: MANIFEST.toJSON() }]);
    expect(s.shown).toEqual([
      ["042137", "Type this code in Nestor to add this device."],
      [null, "Paired with Nestor."],
    ]);
    expect(s.said).toEqual(["Pairing code: 0, 4, 2, 1, 3, 7. I repeat: 0, 4, 2, 1, 3, 7."]);
    expect(s.logs).toContain("Pairing code: 042137. Type it in Nestor to add this device.");
    expect(s.logs.join("\n")).not.toMatch(/NESTOR_PAIRING_URI/);
  });

  it("without a screen or a voice, logs its code and how to pair with an enrollment code instead", async () => {
    core = await FakeCore.start();
    const s = seen();
    await pairing({ seen: s }).run();
    expect(s.logs).toContain("Pairing code: 042137. Type it in Nestor to add this device.");
    expect(s.logs.join("\n")).toMatch(/enrollment code.*NESTOR_PAIRING_URI/);
  });

  it("speaks to people in their language", async () => {
    core = await FakeCore.start();
    const s = seen();
    const speak = (text: string) => void s.said.push(text);
    await pairing({ seen: s, outputs: { speak }, messages: new Messages("fr-FR") }).run();
    expect(s.said).toEqual(["Code d'appairage : 0, 4, 2, 1, 3, 7. Je répète : 0, 4, 2, 1, 3, 7."]);
    expect(s.logs).toContain("Code d'appairage : 042137. Saisissez-le dans Nestor pour ajouter cet appareil.");
  });

  it("says its code with the bundled voice, and falls silent the moment it is paired", async () => {
    core = await FakeCore.start({ pendingPolls: Number.POSITIVE_INFINITY });
    const speaker = new RecordingSpeaker();
    const voice = new SpokenCode(speaker, new Messages("en"));
    const s = seen();
    const pairs = pairing({ seen: s, outputs: { voice } });
    const running = pairs.run();
    await until(() => speaker.samples > 16_000 / 2); // half a second said, of about ten
    core.approve();
    await running;
    expect(voice.speaking).toBe(false);
    const said = speaker.samples;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(speaker.samples).toBe(said);
    expect(said).toBeLessThan(16_000 * 3);
    expect(s.logs.join("\n")).not.toMatch(/NESTOR_PAIRING_URI/);
  });

  it("stops saying its code when pairing is cancelled or fails", async () => {
    core = await FakeCore.start({ pendingPolls: Number.POSITIVE_INFINITY });
    const speaker = new RecordingSpeaker();
    const voice = new SpokenCode(speaker, new Messages("en"));
    const stopping = new AbortController();
    const running = pairing({ outputs: { voice }, pollMs: 5 }).run(stopping.signal);
    await until(() => speaker.samples > 0);
    stopping.abort(new Error("stopped"));
    await expect(running).rejects.toThrow("stopped");
    expect(voice.speaking).toBe(false);
    core.failWith = 503;
    const failing = pairing({ outputs: { voice }, pollMs: 5 }).run();
    await expect(failing).rejects.toBeInstanceOf(HttpError);
    expect(voice.speaking).toBe(false);
  });

  it("asks again with a new device code when one expires", async () => {
    core = await FakeCore.start({ expiring: 2 });
    const s = seen();
    await pairing({ seen: s }).run();
    expect(core.pairRequests).toHaveLength(3);
    expect(s.logs.filter((l) => l.startsWith("Pairing code"))).toHaveLength(3);
  });

  it("makes itself noticed when a person asks while it waits, and keeps polling", async () => {
    core = await FakeCore.start({ pendingPolls: Number.POSITIVE_INFINITY });
    const identify = vi.fn();
    const running = pairing({ identify }).run();
    await until(() => core.polls.length > 0);
    core.identify();
    await until(() => identify.mock.calls.length === 1);
    const polls = core.polls.length;
    await until(() => core.polls.length > polls);
    core.approve();
    await expect(running).resolves.toMatchObject({ token: "nst1_token-1" });
  });

  it("keeps pairing when an output fails", async () => {
    core = await FakeCore.start();
    const s = seen();
    const display = () => {
      throw new Error("screen unplugged");
    };
    await expect(pairing({ seen: s, outputs: { display } }).run()).resolves.toMatchObject({ token: "nst1_token-1" });
    expect(s.logs.join("\n")).toMatch(/screen unplugged/);
  });
});

describe("with an enrollment code", () => {
  it("configured as a pairing URI, sends it with its request and pairs with no device code", async () => {
    core = await FakeCore.start({ codes: { [CODE]: "valid" } });
    const s = seen();
    const display = (code: string | null, text: string) => void s.shown.push([code, text]);
    const paired = await pairing({ seen: s, enrollment: URI(core), outputs: { display } }).run();
    expect(paired.token).toBe("nst1_token-1");
    expect(core.pairRequests).toEqual([
      { manifest: MANIFEST.toJSON(), enrollment_code: CODE, method: "enrollment.provisioning" },
    ]);
    expect(s.shown).toEqual([]);
    expect(s.logs.join("\n")).not.toMatch(/Pairing code/);
  });

  it.each([
    ["unknown", "Nestor does not know the enrollment code K7QF-2M9X."],
    ["expired", "The enrollment code K7QF-2M9X has expired."],
    ["used", "The enrollment code K7QF-2M9X was already used."],
    ["cancelled", "The enrollment code K7QF-2M9X was cancelled."],
  ] as const)("refused (%s), says why, never sends it again and falls back to a device code", async (reason, text) => {
    core = await FakeCore.start({ codes: reason === "unknown" ? {} : { [CODE]: reason }, expiring: 1 });
    const s = seen();
    const speak = (said: string) => void s.said.push(said);
    await pairing({ seen: s, enrollment: CODE, outputs: { speak } }).run();
    expect(core.pairRequests.map((r) => r.enrollment_code)).toEqual([CODE, undefined, undefined]);
    expect(s.logs).toContain(`${text} Asking for a pairing code instead.`);
    expect(s.said[0]).toBe(text);
    expect(s.logs).toContain("Pairing code: 042137. Type it in Nestor to add this device.");
  });

  it("refuses a malformed configured code at once", () => {
    expect(() => new Pairing({ core: "http://c", manifest: MANIFEST, enrollment: "K7QF" })).toThrow(/enrollment code/);
  });

  it("waits as long as the core asks when rate-limited, then pairs", async () => {
    core = await FakeCore.start({ codes: { [CODE]: "valid" } });
    core.limited = 1;
    const s = seen();
    await pairing({ seen: s, enrollment: CODE }).run();
    const [first = 0, second = 0] = core.requestTimes;
    expect(core.pairRequests.map((r) => r.enrollment_code)).toEqual([CODE, CODE]);
    expect(second - first).toBeGreaterThanOrEqual(1000);
    expect(s.logs).toContain("Too many wrong codes were tried. Trying again in 1 s.");
  });
});

describe("a refused enrollment code, kept by the device", () => {
  it("is kept as a hash, never in clear, and the token file keeps the Python SDK's format", async () => {
    core = await FakeCore.start({ codes: { [CODE]: "used" } });
    const path = join(await mkdtemp(join(tmpdir(), "nestor-")), "state.json");
    const store = new FileTokenStore(path);
    await pairing({ enrollment: CODE, store }).run();
    await store.save(core.url, MANIFEST.device.id, "nst1_token-1");
    const text = await readFile(path, "utf8");
    expect(text).not.toMatch(/K7QF-?2M9X/i);
    expect(JSON.parse(text)).toEqual({
      core: core.url,
      device_id: MANIFEST.device.id,
      token: "nst1_token-1",
      refused: { [await hashEnrollmentCode(CODE)]: "used" },
    });
  });

  it("is never sent again after a restart: the device says so and asks for a device code", async () => {
    core = await FakeCore.start({ codes: { [CODE]: "expired" } });
    const store = new FileTokenStore(join(await mkdtemp(join(tmpdir(), "nestor-")), "state.json"));
    await pairing({ enrollment: URI(core), store }).run();
    expect(core.pairRequests.map((r) => r.enrollment_code)).toEqual([CODE, undefined]);
    const s = seen();
    const display = (code: string | null, text: string) => void s.shown.push([code, text]);
    const restarted = pairing({ seen: s, enrollment: URI(core), store, outputs: { display } });
    await restarted.run();
    expect(core.pairRequests.map((r) => r.enrollment_code)).toEqual([CODE, undefined, undefined]);
    const refusal = "The enrollment code K7QF-2M9X was already refused. Make a new one in Nestor.";
    expect(s.logs).toContain(`${refusal} Asking for a pairing code instead.`);
    expect(s.shown[0]).toEqual([null, refusal]);
    await expect(restarted.enroll("k7qf-2m9x")).resolves.toEqual({ status: "refused", reason: "expired" });
  });

  it("stays refused once the token is forgotten", async () => {
    const store = new MemoryTokenStore();
    const hash = await hashEnrollmentCode(CODE);
    store.refuse("http://c", "salon", hash, "used");
    store.save("http://c", "salon", "nst1_x");
    store.forget();
    expect(store.load("http://c", "salon")).toBeNull();
    expect(store.refused("http://c", "salon")).toEqual({ [hash]: "used" });
  });

  it("still pairs when the store cannot keep it", async () => {
    core = await FakeCore.start({ codes: { [CODE]: "used" } });
    const s = seen();
    const broken = {
      refused: () => Promise.reject(new Error("disk unreadable")),
      refuse: () => Promise.reject(new Error("disk full")),
    };
    await expect(pairing({ seen: s, enrollment: CODE, store: broken }).run()).resolves.toMatchObject({
      token: "nst1_token-1",
    });
    expect(s.logs.join("\n")).toMatch(/disk unreadable[\s\S]*disk full/);
  });
});

describe("an enrollment code handed in while it waits", () => {
  it("is sent at once with how it came, and wins", async () => {
    core = await FakeCore.start({ pendingPolls: Number.POSITIVE_INFINITY, codes: { [CODE]: "valid" } });
    const s = seen();
    const display = (code: string | null, text: string) => void s.shown.push([code, text]);
    const pairs = pairing({ seen: s, outputs: { display }, pollMs: 60_000 });
    const running = pairs.run();
    await until(() => pairs.pending);
    await expect(pairs.enroll("k7qf 2m9x", "enrollment.qr")).resolves.toEqual({ status: "approved" });
    await expect(running).resolves.toMatchObject({ token: "nst1_token-1" });
    expect(core.enrollments).toEqual([{ enrollment_code: CODE, method: "enrollment.qr" }]);
    expect(s.shown.at(-1)).toEqual([null, "Paired with Nestor."]);
  });

  it("is not pending once the device code won, and the device still gets its token", async () => {
    core = await FakeCore.start({ pendingPolls: Number.POSITIVE_INFINITY, codes: { [CODE]: "valid" } });
    const pairs = pairing({ pollMs: 60_000 });
    const running = pairs.run();
    await until(() => core.polls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50)); // the device waits for its next poll
    core.approve(); // a person typed the device code first
    await expect(pairs.enroll(CODE)).resolves.toEqual({ status: "not_pending" });
    await expect(running).resolves.toMatchObject({ token: "nst1_token-1" });
    expect(core.enrollments).toHaveLength(1);
  });

  it("refused, is never sent again, and the device code still stands", async () => {
    core = await FakeCore.start({ pendingPolls: Number.POSITIVE_INFINITY, codes: { [CODE]: "expired" } });
    const s = seen();
    const display = (code: string | null, text: string) => void s.shown.push([code, text]);
    const pairs = pairing({ seen: s, outputs: { display } });
    const running = pairs.run();
    await until(() => pairs.pending);
    await expect(pairs.enroll(CODE)).resolves.toEqual({ status: "refused", reason: "expired" });
    await expect(pairs.enroll("K7QF-2M9X")).resolves.toEqual({ status: "refused", reason: "expired" });
    expect(core.enrollments).toHaveLength(1);
    expect(s.shown.at(-1)).toEqual([
      "042137",
      "The enrollment code K7QF-2M9X has expired. Type this code in Nestor to add this device.",
    ]);
    core.approve();
    await expect(running).resolves.toMatchObject({ token: "nst1_token-1" });
  });

  it("that is no code is not sent", async () => {
    core = await FakeCore.start();
    const s = seen();
    await expect(pairing({ seen: s }).enroll("hello")).resolves.toEqual({ status: "invalid" });
    expect(s.logs).toContain("This is not an enrollment code. One has 8 letters and digits, like K7QF-2M9X.");
  });

  it("before pairing starts, goes with the first request", async () => {
    core = await FakeCore.start({ codes: { [CODE]: "valid" } });
    const pairs = pairing();
    const outcome = pairs.enroll(URI(core), "enrollment.input");
    await pairs.run();
    await expect(outcome).resolves.toEqual({ status: "approved" });
    expect(core.pairRequests[0]).toMatchObject({ enrollment_code: CODE, method: "enrollment.input" });
  });
});

describe("when pairing cannot happen", () => {
  it("fails clearly, in the device's language, when the core speaks another protocol version", async () => {
    core = await FakeCore.start();
    core.protocolUnsupported = true;
    const run = pairing({ messages: new Messages("fr") }).run();
    await expect(run).rejects.toBeInstanceOf(PairingError);
    await expect(run).rejects.toThrow("Ce Nestor parle une autre version du protocole des satellites.");
  });

  it("fails with the core's status when the core is in trouble", async () => {
    core = await FakeCore.start();
    core.failWith = 503;
    const run = pairing().run();
    await expect(run).rejects.toBeInstanceOf(HttpError);
    await expect(run).rejects.toMatchObject({ status: 503, message: expect.stringContaining("core in trouble") });
  });

  it("fails when the core cannot be reached", async () => {
    core = await FakeCore.start();
    const unreachable = new Pairing({ core: "http://127.0.0.1:9", manifest: MANIFEST, logger: seen().logger });
    await expect(unreachable.run()).rejects.toThrow();
  });

  it("stops when aborted while it waits for a person", async () => {
    core = await FakeCore.start({ pendingPolls: Number.POSITIVE_INFINITY });
    const stopping = new AbortController();
    const run = pairing({ pollMs: 60_000 }).run(stopping.signal);
    await until(() => core.polls.length > 0);
    stopping.abort(new Error("stopped"));
    await expect(run).rejects.toThrow("stopped");
  });
});
