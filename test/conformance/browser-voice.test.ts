import { join } from "node:path";
import { expect, it } from "vitest";
import { conformance, noChromium, ROOT } from "./run.js";

it.skipIf(noChromium)("a headless Chromium tab that talks aloud is conformant", async () => {
  const { code, output } = await conformance(["node", join(ROOT, "scripts/browser-satellite.mjs"), "--core", "{url}"]);
  expect(output).not.toMatch(/^FAIL/m);
  expect(output).toContain("PASS  keeps polling after a pending identify (I1)");
  expect(output).toContain("PASS  acknowledges intent.identify within 1 s");
  expect(output).toContain("PASS  receives the core's audio (A1, A2)");
  expect(output).toContain("PASS  sends its microphone audio (A1, A2)");
  expect(output).toContain("PASS  offers no audio when audio is not allowed (A1)");
  expect(output).toContain("PASS  sends its microphone in a call (M1)");
  expect(output).toContain("PASS  ends the session when told (M2)");
  expect(output).toContain("PASS  pairs with the enrollment code of NESTOR_PAIRING_URI, no code typed (P3, P4)");
  expect(output, output).toMatch(/^conformant: \d+ checks passed$/m);
  expect(code, output).toBe(0);
});
