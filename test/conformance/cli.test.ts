import { join } from "node:path";
import { expect, it } from "vitest";
import { conformance, ROOT } from "./run.js";

it("the Node CLI, a speaker that also writes, without a body, is conformant", async () => {
  const { code, output } = await conformance([
    "node",
    join(ROOT, "dist/node/bin.js"),
    "run",
    "--core",
    "{url}",
    "--room",
    "salon",
    "--input",
    "none",
    "--output",
    "none",
    "--token-file",
    "{state}/token.json",
    "--text",
  ]);
  expect(output).not.toMatch(/^FAIL/m);
  expect(output).toContain("PASS  receives the core's audio (A1, A2)");
  expect(output).toContain("PASS  sends its microphone audio (A1, A2)");
  expect(output).toContain("PASS  acknowledges intent.text within 1 s");
  expect(output).toContain("PASS  reconnects with the same token after the core closes its link (L5)");
  expect(output).toContain("PASS  forgets a refused token and pairs again (L2, P8)");
  expect(output).toContain("PASS  offers no audio when audio is not allowed (A1)");
  expect(output).toContain("PASS  opens no media connection unless asked (M1)");
  expect(output).toContain("PASS  sends its microphone in a call (M1)");
  expect(output).toContain("PASS  ends the session by itself after 3 s (M2)");
  expect(output).toContain("PASS  pairs with the enrollment code of NESTOR_PAIRING_URI, no code typed (P3, P4)");
  expect(output).toContain("PASS  presents a refused enrollment code (used) only once (P5)");
  expect(output).toContain("PASS  waits for Retry-After when rate-limited (P6)");
  expect(output, output).toMatch(/^conformant: \d+ checks passed$/m);
  expect(code, output).toBe(0);
});
