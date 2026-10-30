import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError, Manifest, pair } from "../src/index.js";
import { FakeCore } from "./support/core.js";

const MANIFEST = Manifest.of({ id: "enceinte-salon", model: "raspberry-pi-4", room: "salon" }, "audio.capture");

describe("pairing", () => {
  let core: FakeCore;
  afterEach(() => core.stop());

  describe("with a core that approves", () => {
    beforeEach(async () => {
      core = await FakeCore.start({ pendingPolls: 2 });
    });

    it("shows the code, waits for the approval and returns the token", async () => {
      const codes: string[] = [];
      const token = await pair({ core: core.url, manifest: MANIFEST, onCode: (c) => codes.push(c), pollMs: 5 });
      expect(token).toBe("nst1_token-1");
      expect(codes).toEqual(["042137"]);
      expect(core.pairRequests).toEqual([MANIFEST.toJSON()]);
    });

    it("stops when aborted while waiting for the approval", async () => {
      const stopping = new AbortController();
      const pairing = pair({
        core: core.url,
        manifest: MANIFEST,
        onCode: () => setTimeout(() => stopping.abort(new Error("stopped")), 10),
        pollMs: 1000,
        signal: stopping.signal,
      });
      await expect(pairing).rejects.toThrow("stopped");
    });
  });

  it("asks again with a new code when one expires", async () => {
    core = await FakeCore.start({ expiring: 2 });
    const codes: string[] = [];
    await pair({ core: core.url, manifest: MANIFEST, onCode: (c) => codes.push(c), pollMs: 5 });
    expect(codes).toHaveLength(3);
    expect(core.pairRequests).toHaveLength(3);
  });

  it("fails with the core's status and reason when it refuses to pair", async () => {
    core = await FakeCore.start();
    core.failWith = 429;
    const pairing = pair({ core: core.url, manifest: MANIFEST, onCode: () => {} });
    await expect(pairing).rejects.toBeInstanceOf(HttpError);
    await expect(pairing).rejects.toMatchObject({ status: 429, message: expect.stringContaining("core in trouble") });
  });

  it("fails when the core cannot be reached", async () => {
    core = await FakeCore.start();
    await expect(pair({ core: "http://127.0.0.1:9", manifest: MANIFEST, onCode: () => {} })).rejects.toThrow();
  });
});
