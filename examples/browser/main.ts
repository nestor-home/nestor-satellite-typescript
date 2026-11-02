/// <reference types="vite/client" />

/**
 * A browser tab as a Nestor satellite: it writes with the assistant, and talks aloud too when asked
 * (microphone and speaker). The device code is on screen (and said with the bundled voice, if
 * asked), an enrollment code can be typed in the page, scanned with the camera (if asked) or passed
 * in the address; intents are logged.
 *
 * Address parameters: `?auto&room=salon&id=tab` starts at once (tests; browsers then need autoplay
 * allowed), `voice` talks aloud, `pairing_uri=nestor+http://…/?code=…` pairs with that enrollment
 * code, `lang=fr` picks the language, `speak` says the code aloud, `qr` scans QR codes,
 * `core=http://…` talks to another core than this page's origin.
 */

import { IDENTIFY, LocalStorageTokenStore, type Logger, Manifest, Satellite } from "@nestor-home/satellite";
import { cameraQrScanner } from "@nestor-home/satellite/qr";
// Served by this page, so QR codes are read offline (by default zxing-wasm fetches it from a CDN).
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const enrollForm = $<HTMLFormElement>("enroll");
const sayForm = $<HTMLFormElement>("say");
const chat = $<HTMLUListElement>("chat");
const status = $<HTMLParagraphElement>("status");
const code = $<HTMLParagraphElement>("code");
const params = new URLSearchParams(location.search);

function log(line: string): void {
  console.log(line); // also read by the conformance driver
  $("log").prepend(`${new Date().toLocaleTimeString()}  ${line}\n`);
}

function bubble(text: string, from: "you" | "nestor", final = true): void {
  const item = document.createElement("li");
  item.className = final ? from : `${from} partial`;
  item.textContent = text;
  chat.append(item);
  item.scrollIntoView({ block: "nearest" });
}

const logger: Logger = { debug: () => {}, info: log, warn: log };

interface Start {
  room: string;
  id: string;
  enrollment: string | undefined;
  voice: boolean;
  speak: boolean;
  qr: boolean;
}

async function start({ room, id, enrollment, voice, speak, qr }: Start): Promise<void> {
  form.hidden = true;
  status.textContent = "Connecting…";
  const locale = params.get("lang") ?? navigator.languages;
  // The voice (WebRTC, the microphone) is only loaded when the tab talks aloud.
  const aloud = voice ? (await import("@nestor-home/satellite/voice")).browserVoice({ logger }) : undefined;
  const satellite = new Satellite({
    core: params.get("core") ?? location.origin,
    manifest: new Manifest({ id, model: "browser", room }, [IDENTIFY]),
    tokens: new LocalStorageTokenStore(`nestor-satellite:${id}`),
    // text.display and text.input: the assistant's words in the page, and what is typed in it.
    text: {
      input: true,
      display: (text, final) => bubble(text, "nestor", final),
    },
    // audio.capture and audio.playback, when asked for. The microphone opens once Nestor allows it.
    ...(aloud === undefined ? {} : { voice: aloud }),
    logger,
    locale,
    pairing: {
      enrollment,
      // device_code.display: the code and what to do with it, until the device is paired.
      display: (shown, text) => {
        code.hidden = shown === null;
        code.textContent = shown ?? "";
        enrollForm.hidden = shown === null;
        status.textContent = text;
      },
      // device_code.speech, when asked for: the bundled voice, through Web Audio (a tab that talks aloud).
      voice: speak && aloud !== undefined,
      accepts: ["enrollment.input"],
      // enrollment.qr, when asked for: the camera reads the pairing URI's QR code while the tab waits.
      scanner: qr ? cameraQrScanner({ wasmUrl }) : undefined,
    },
    body: {
      behavior: (behavior) => log(`behavior ${behavior}`),
      expression: (expression, intensity) => log(`expression ${expression} (${intensity})`),
      beat: () => log("beat"),
      identify: () => {
        log("identify");
        document.body.classList.remove("identify");
        void document.body.offsetWidth; // restart the animation
        document.body.classList.add("identify");
      },
      connected: (up) => {
        code.hidden = true;
        enrollForm.hidden = true;
        sayForm.hidden = !up;
        status.textContent = up ? `Connected in ${room}.` : "Reconnecting…";
        log(up ? "connected" : "disconnected");
      },
    },
  });
  enrollForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const field = enrollForm.elements.namedItem("code") as HTMLInputElement;
    satellite.enroll(field.value, "enrollment.input").then((outcome) => {
      log(`enrollment code: ${outcome.status}`);
      if (outcome.status !== "approved") field.select();
    }, log);
  });
  sayForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const field = sayForm.elements.namedItem("text") as HTMLInputElement;
    const text = field.value.trim();
    if (text === "") return;
    try {
      if (satellite.sendText(text)) {
        bubble(text, "you");
        field.value = "";
      } else {
        log("not connected: the message was not sent");
      }
    } catch (error) {
      log(error instanceof Error ? error.message : String(error)); // typed text not allowed by the household
    }
  });
  await satellite.run();
}

function stopped(error: unknown): void {
  status.textContent = `Stopped: ${error instanceof Error ? error.message : String(error)}`;
  sayForm.hidden = true;
  log(status.textContent);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const enrollment = String(data.get("enrollment") ?? "").trim();
  start({
    room: String(data.get("room")),
    id: String(data.get("id")),
    enrollment: enrollment === "" ? undefined : enrollment,
    voice: data.has("voice"),
    speak: data.has("speak"),
    qr: data.has("qr"),
  }).catch(stopped);
});

if (params.has("auto")) {
  start({
    room: params.get("room") ?? "salon",
    id: params.get("id") ?? "navigateur",
    enrollment: params.get("pairing_uri") ?? undefined,
    voice: params.has("voice"),
    speak: params.has("speak"),
    qr: params.has("qr"),
  }).catch(stopped);
}
