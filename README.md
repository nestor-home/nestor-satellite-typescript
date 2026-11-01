# @nestor-home/satellite

TypeScript SDK to write **satellites** for [Nestor](https://github.com/nestor-home/nestor), in
browsers and in Node: devices (a tab on a wall tablet, a Raspberry Pi speaker, a robot) that pair
with a Nestor core, stream audio over WebRTC, carry out the core's intents and report what they
observe, following the `nestor.satellite/2` protocol. The SDK does not depend on the Nestor server.

## Pairing

A person pairs a satellite from Nestor's admin, with one of two proofs:

- an **enrollment code** (`K7QF-2M9X`, or the pairing URI `nestor+http://nestor.local:7860/?code=K7QF2M9X`)
  made in the admin and handed to the device: set in its configuration, typed on it, or scanned;
- a **device code** (6 digits) the device presents, on its screen, aloud or in its log, and the
  person types in the admin.

The SDK uses the enrollment code it is given; otherwise it asks for a device code and presents it
through every output the driver provides, and always in the log. While it waits, `satellite.enroll()`
still takes an enrollment code; whichever proof the core accepts first wins. A refused enrollment code
is never sent again, even after a restart: its SHA-256 hash is kept in the token store, never the code.

The manifest's `pairing_methods` follow from what the device can do, never declared by hand:

| Method                    | When                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enrollment.provisioning` | always                                                                                                                                                                                                         |
| `device_code.display`     | `pairing.display` is given                                                                                                                                                                                     |
| `device_code.speech`      | `pairing.speak` is given, or the device has a speaker (`audio.playback`) and no `display`: the SDK then says the code itself, offline, with recorded clips (`pairing.voice: true` to also do it with a screen) |
| `enrollment.input`        | `pairing.accepts: ["enrollment.input"]`                                                                                                                                                                        |
| `enrollment.qr`           | `pairing.scanner` reads QR codes with a camera (`@nestor-home/satellite/qr`, browsers)                                                                                                                         |

What the device says to people is translated (English and French, Fluent catalogues): `locale`
option, else the platform's language. The bundled voice has English and French clips; another
language is said in English.

## In Node, headless

`pnpm add @nestor-home/satellite @roamhq/wrtc`. Add a satellite in Nestor with an enrollment code, and
hand its pairing URI to the device:

```bash
NESTOR_PAIRING_URI='nestor+http://nestor.local:7860/?code=K7QF2M9X' npx @nestor-home/satellite run --room salon
# or
npx @nestor-home/satellite run --room salon --pairing-uri 'nestor+http://nestor.local:7860/?code=K7QF2M9X'
```

The URI gives the core's address; with a bare code (`--pairing-code K7QF-2M9X`, or
`NESTOR_PAIRING_CODE`), give it with `--core`. Without either, the satellite says a device code to
type in Nestor on its speaker, and logs it (`--output none`: only logs it). The token is kept in `~/.config/nestor-satellite/<id>.json` (mode 600); see
`nestor-satellite --help`.

The same in code:

```ts
import { AUDIO_CAPTURE, AUDIO_PLAYBACK, EXPRESSION, Manifest, Satellite } from "@nestor-home/satellite";
import {
  CommandSink,
  CommandSource,
  FileTokenStore,
  languagesFromEnv,
  nodeWebRtc,
  provisioningFromEnv,
} from "@nestor-home/satellite/node";

const provisioning = provisioningFromEnv(); // NESTOR_PAIRING_URI or NESTOR_PAIRING_CODE, if set
const satellite = new Satellite({
  core: provisioning?.core ?? "http://nestor.local:7860",
  manifest: Manifest.of(
    { id: "enceinte-salon", model: "raspberry-pi-4", room: "salon" },
    AUDIO_CAPTURE,
    AUDIO_PLAYBACK,
    EXPRESSION,
  ),
  tokens: new FileTokenStore("~/.config/salon.json"), // mode 600
  webrtc: nodeWebRtc({
    source: new CommandSource("arecord -q -t raw -f S16_LE -c 1 -r 48000"),
    sink: new CommandSink("aplay -q -t raw -f S16_LE -c 1 -r 48000"),
  }),
  pairing: { enrollment: provisioning?.enrollment }, // no screen: the device code is said on the sink, and logged
  locale: languagesFromEnv(), // LC_ALL, LC_MESSAGES, LANG
  body: { expression: (expression) => console.log("expression:", expression) },
});
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
await satellite.run(stop.signal); // pairs the first time, then reconnects forever
```

## In a browser, with a screen

Served over `https:` or `localhost`, from the core's origin or through a proxy:

```ts
import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  browserWebRtc,
  IDENTIFY,
  LocalStorageTokenStore,
  Manifest,
  Satellite,
} from "@nestor-home/satellite";
import { cameraQrScanner } from "@nestor-home/satellite/qr"; // needs `pnpm add zxing-wasm`
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url"; // Vite: served by the page, not a CDN

const satellite = new Satellite({
  core: location.origin,
  manifest: Manifest.of(
    { id: "tablette-cuisine", model: "browser", room: "cuisine" },
    AUDIO_CAPTURE,
    AUDIO_PLAYBACK,
    IDENTIFY,
  ),
  tokens: new LocalStorageTokenStore(),
  webrtc: browserWebRtc(),
  pairing: {
    // The device code and what to do with it; `code` is null once it is no longer needed.
    display: (code, text) => {
      document.querySelector("#code")!.textContent = code ?? "";
      document.querySelector("#status")!.textContent = text;
    },
    voice: true, // optional: says the code aloud too, with the bundled voice (Web Audio)
    accepts: ["enrollment.input"], // an enrollment code can be typed in the page
    scanner: cameraQrScanner({ wasmUrl }), // optional: reads the pairing URI's QR code with the camera
  },
  body: {
    behavior: (behavior) => (document.body.dataset.behavior = behavior),
    identify: () => document.body.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 500, iterations: 6 }),
  },
});
form.onsubmit = async () => console.log(await satellite.enroll(input.value)); // approved, refused…
button.onclick = () => satellite.run(); // a click: browsers only play sound after a gesture
```

A tab as a satellite: `NESTOR_CORE=http://nestor.local:7860 pnpm example`, then open the page
(`?pairing_uri=…` pairs it with an enrollment code, `?lang=fr` speaks French, `?speak` says the code,
`?qr` scans QR codes).

QR codes are decoded by [`zxing-wasm`](https://github.com/Sec-ant/zxing-wasm) (ZXing-C++ in
WebAssembly, MIT, an optional peer dependency; its reader is about 1 MB of WebAssembly, fetched from
jsDelivr unless `wasmUrl` says where the page serves it). Node has no camera, so a Node satellite never
declares `enrollment.qr`.

## The bundled voice

`voice/` holds the clips the SDK says a device code with (16 kHz mono WAV, about 500 KB), identical in
the Python SDK, which records them with Kokoro-82M. They are shared under CC BY 4.0: see
[`voice/LICENSE`](voice/LICENSE) for the attribution. A driver with a voice of its own passes
`pairing.speak`, which gets the whole sentence.

In Node, WebRTC is [`@roamhq/wrtc`](https://github.com/WonderInventions/node-webrtc), an optional
peer dependency: libwebrtc, as in browsers, with Opus and RTCP built in, prebuilt for Linux and
macOS (x64, arm64) and Windows x64.

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm conformance   # the published server's conformance suite (uvx; version in .nestor-version)
```

## License

MIT
