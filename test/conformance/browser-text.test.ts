import { join } from "node:path";
import { expect, it } from "vitest";
import { conformance, noChromium, ROOT } from "./run.js";

it.skipIf(noChromium)("a headless Chromium tab that only writes is conformant, with no WebRTC", async () => {
  const { code, output } = await conformance([
    "node",
    join(ROOT, "scripts/browser-satellite.mjs"),
    "--core",
    "{url}",
    "--no-voice",
  ]);
  expect(output).not.toMatch(/^FAIL/m);
  expect(output).toContain("PASS  acknowledges intent.text within 1 s");
  expect(output).not.toMatch(/^PASS .*audio/m); // nothing to check: it declares no audio
  expect(output, output).toMatch(/^conformant: \d+ checks passed$/m);
  expect(code, output).toBe(0);
});
