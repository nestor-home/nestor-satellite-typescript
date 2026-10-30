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
still takes an enrollment code; whichever proof the core accepts first wins. The manifest's
`pairing_methods` follow from what the driver provides: `enrollment.provisioning` always,
`device_code.display` with `pairing.display`, `device_code.speech` with `pairing.speak`, and
`enrollment.input` or `enrollment.qr` when listed in `pairing.accepts`. What the device says to people
is translated (English and French, Fluent catalogues): `locale` option, else the platform's language.

## In Node, headless

`pnpm add @nestor-home/satellite @roamhq/wrtc`. Add a satellite in Nestor with an enrollment code, and
hand its pairing URI to the device:

```bash
NESTOR_PAIRING_URI='nestor+http://nestor.local:7860/?code=K7QF2M9X' npx @nestor-home/satellite run --room salon
# or
npx @nestor-home/satellite run --room salon --pairing-uri 'nestor+http://nestor.local:7860/?code=K7QF2M9X'
```

The URI gives the core's address; with a bare code (`--pairing-code K7QF-2M9X`, or
`NESTOR_PAIRING_CODE`), give it with `--core`. Without either, the satellite logs a device code to
type in Nestor. The token is kept in `~/.config/nestor-satellite/<id>.json` (mode 600); see
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
  pairing: { enrollment: provisioning?.enrollment }, // no screen, no voice: the device code goes to the log
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
  browserSpeech,
  browserWebRtc,
  IDENTIFY,
  LocalStorageTokenStore,
  Manifest,
  Satellite,
} from "@nestor-home/satellite";

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
    speak: browserSpeech({ lang: navigator.language }), // optional: says the code aloud too
    accepts: ["enrollment.input"], // an enrollment code can be typed in the page
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
(`?pairing_uri=…` pairs it with an enrollment code, `?lang=fr` speaks French).

In Node, WebRTC is [`@roamhq/wrtc`](https://github.com/WonderInventions/node-webrtc), an optional
peer dependency: libwebrtc, as in browsers, with Opus and RTCP built in, prebuilt for Linux and
macOS (x64, arm64) and Windows x64.

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm conformance   # the server's conformance suite; needs ../nestor with its venv
```

## License

MIT
