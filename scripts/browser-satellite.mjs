// A headless Chromium tab running the browser example as a satellite of `--core <url>`, until
// SIGTERM: it writes, and talks aloud unless `--no-voice`. Lets the server's conformance suite check
// a real browser:
//
//     uvx --from "nestor-home[voice]==$(cat .nestor-version)" nestor satellites conformance -- \
//         node scripts/browser-satellite.mjs --core {url} [--no-voice]
//
// Chromium's fake microphone (a beep) and fake permission prompt stand in for a person. The
// enrollment code a scenario configures (`NESTOR_PAIRING_URI`) reaches the page in its address,
// as a person would paste it; each launch is a fresh browser, so a fresh token store.

import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const { values } = parseArgs({
  allowNegative: true,
  options: {
    core: { type: "string" },
    room: { type: "string", default: "salon" },
    voice: { type: "boolean", default: true },
  },
});
if (!values.core) {
  console.error("usage: browser-satellite.mjs --core <url> [--room salon] [--no-voice]");
  process.exit(2);
}

process.env.NESTOR_CORE = values.core;
// Chromium starts while Vite does: the suite times how soon a driver asks to pair (its rate limit
// scenario lasts 1.5 s from launch).
const launching = chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const server = await createServer({
  configFile: new URL("../examples/browser/vite.config.ts", import.meta.url).pathname,
  server: { port: 0, host: "localhost" },
  logLevel: "warn",
});
await server.listen();
const page_url = new URL(server.resolvedUrls?.local[0] ?? "");
const query = new URLSearchParams({ auto: "", room: values.room, id: "navigateur-test" });
if (values.voice) query.set("voice", "");
if (process.env.NESTOR_PAIRING_URI) query.set("pairing_uri", process.env.NESTOR_PAIRING_URI);
page_url.search = query.toString();

const browser = await launching;
const page = await browser.newPage();
page.on("console", (message) => console.error(`[browser] ${message.text()}`));
page.on("pageerror", (error) => console.error(`[browser] ${error.message}`));
await page.goto(page_url.href);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await browser.close();
  await server.close();
  process.exit(0);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
