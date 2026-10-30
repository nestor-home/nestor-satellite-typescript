// A headless Chromium tab running the browser example as a satellite of `--core <url>`, until
// SIGTERM. Lets the server's conformance suite check a real browser:
//
//     python scripts/conformance.py node scripts/browser-satellite.mjs --core {url}
//
// Chromium's fake microphone (a beep) and fake permission prompt stand in for a person.

import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const { values } = parseArgs({ options: { core: { type: "string" }, room: { type: "string", default: "salon" } } });
if (!values.core) {
  console.error("usage: browser-satellite.mjs --core <url> [--room salon]");
  process.exit(2);
}

process.env.NESTOR_CORE = values.core;
const server = await createServer({
  configFile: new URL("../examples/browser/vite.config.ts", import.meta.url).pathname,
  server: { port: 0, host: "localhost" },
  logLevel: "warn",
});
await server.listen();
const page_url = new URL(server.resolvedUrls?.local[0] ?? "");
page_url.search = new URLSearchParams({ auto: "", room: values.room, id: "navigateur-test" }).toString();

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
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
