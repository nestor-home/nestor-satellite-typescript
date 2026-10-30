/** A browser tab as a Nestor satellite: microphone and speaker, the pairing code on screen, intents logged. */

import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  browserWebRtc,
  LocalStorageTokenStore,
  type Logger,
  Manifest,
  Satellite,
} from "@nestor-home/satellite";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const status = $<HTMLParagraphElement>("status");
const code = $<HTMLParagraphElement>("code");

function log(line: string): void {
  console.log(line); // also read by the conformance driver
  $("log").prepend(`${new Date().toLocaleTimeString()}  ${line}\n`);
}

const logger: Logger = { debug: () => {}, info: log, warn: (m) => log(`warning: ${m}`) };

function start(room: string, id: string): void {
  form.hidden = true;
  status.textContent = "Connecting…";
  const satellite = new Satellite({
    core: new URLSearchParams(location.search).get("core") ?? location.origin,
    manifest: new Manifest({ id, model: "browser", room }, [AUDIO_CAPTURE, AUDIO_PLAYBACK]),
    tokens: new LocalStorageTokenStore(`nestor-satellite:${id}`),
    webrtc: browserWebRtc({ logger }),
    logger,
    onCode: (shown) => {
      code.hidden = false;
      code.textContent = shown;
      status.textContent = "Confirm this code in Nestor:";
    },
    body: {
      behavior: (behavior) => log(`behavior ${behavior}`),
      expression: (expression, intensity) => log(`expression ${expression} (${intensity})`),
      beat: () => log("beat"),
      connected: (up) => {
        code.hidden = true;
        status.textContent = up ? `Connected in ${room}.` : "Reconnecting…";
        log(up ? "connected" : "disconnected");
      },
    },
  });
  satellite.run().catch((error: unknown) => {
    status.textContent = `Stopped: ${error instanceof Error ? error.message : String(error)}`;
    log(status.textContent);
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  start(String(data.get("room")), String(data.get("id")));
});

// `?auto&room=salon&id=tab` starts at once (tests; browsers then need autoplay allowed).
const params = new URLSearchParams(location.search);
if (params.has("auto")) start(params.get("room") ?? "salon", params.get("id") ?? "navigateur");
