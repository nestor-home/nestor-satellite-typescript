# @nestor-home/satellite

TypeScript SDK to write **satellites** for [Nestor](https://github.com/nestor-home/nestor), in
browsers and in Node: devices — a tab on a wall tablet, a Raspberry Pi speaker, a robot — that pair
with a Nestor core, stream audio over WebRTC, carry out the core's intents and report what they
observe, following the `nestor.satellite/1` protocol. The SDK does not depend on the Nestor server.

In a browser (served over `https:` or `localhost`, from the core's origin or through a proxy):

```ts
import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  browserWebRtc,
  LocalStorageTokenStore,
  Manifest,
  Satellite,
} from "@nestor-home/satellite";

const satellite = new Satellite({
  core: location.origin,
  manifest: Manifest.of({ id: "tablette-cuisine", model: "browser", room: "cuisine" }, AUDIO_CAPTURE, AUDIO_PLAYBACK),
  tokens: new LocalStorageTokenStore(),
  webrtc: browserWebRtc(),
  onCode: (code) => (document.querySelector("#code")!.textContent = code), // confirm it in Nestor
  body: {
    behavior: (behavior) => (document.body.dataset.behavior = behavior),
    expression: (expression, intensity) => console.log(expression, intensity),
  },
});
button.onclick = () => satellite.run(); // a click: browsers only play sound after a gesture
```

In Node (`pnpm add @nestor-home/satellite @roamhq/wrtc`):

```ts
import { AUDIO_CAPTURE, AUDIO_PLAYBACK, EXPRESSION, Manifest, Satellite } from "@nestor-home/satellite";
import { CommandSink, CommandSource, FileTokenStore, nodeWebRtc } from "@nestor-home/satellite/node";

const satellite = new Satellite({
  core: "http://nestor.local:7860",
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
  body: { expression: (expression) => console.log("expression:", expression) },
});
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
await satellite.run(stop.signal); // shows a pairing code the first time, then reconnects forever
```

Or, with nothing to write: `npx @nestor-home/satellite run --core http://nestor.local:7860 --room salon`
(`nestor-satellite --help`). A tab as a satellite: `NESTOR_CORE=http://nestor.local:7860 pnpm example`.

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
