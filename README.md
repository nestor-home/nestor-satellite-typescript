# @nestor-home/satellite

TypeScript SDK to write **satellites** for [Nestor](https://nestorhome.dev), in browsers and in
Node: devices (a tab on a wall tablet, a Raspberry Pi speaker, a robot) that pair with a Nestor
server, stream audio over WebRTC, carry out its intents and report what they observe, following the
`nestor.satellite/2` protocol. It does not depend on the Nestor server.

**Documentation:** [nestorhome.dev/docs/sdks/typescript](https://nestorhome.dev/docs/sdks/typescript/)
(Node, pairing options, QR codes, the command, conformance).

```bash
pnpm add @nestor-home/satellite
pnpm add @roamhq/wrtc   # in Node only
```

A tab as a satellite:

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
    // the device code to type in Nestor; `code` is null once it is no longer needed
    display: (code, text) => {
      document.querySelector("#code")!.textContent = code ?? "";
      document.querySelector("#status")!.textContent = text;
    },
  },
  body: {
    behavior: (behavior) => (document.body.dataset.behavior = behavior),
    identify: () => document.body.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 500, iterations: 6 }),
  },
});
button.onclick = () => satellite.run(); // a click: browsers only play sound after a gesture
```

In Node, the machine's microphone and speaker, with nothing to write:

```bash
NESTOR_PAIRING_URI='nestor+http://nestor.local:7860/?code=K7QF2M9X' npx nestor-satellite run --room salon
```

The recorded voice that says device codes is shared under CC BY 4.0: see
[`voice/LICENSE`](voice/LICENSE).

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm conformance   # the published server's conformance suite (uvx; version in .nestor-version)
```

## License

MIT
