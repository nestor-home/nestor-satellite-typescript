# @nestor-home/satellite

TypeScript SDK to write **satellites** for [Nestor](https://nestorhome.dev), in browsers and in
Node: devices (a tab on a wall tablet, a Raspberry Pi speaker, a robot) that pair with a Nestor
server, hold one WebSocket link to it, talk with the assistant in writing, aloud or both, carry out
its intents and report what they observe, following the `nestor.satellite/1` protocol. It does not
depend on the Nestor server.

**Documentation:** [nestorhome.dev/docs/sdks/typescript](https://nestorhome.dev/docs/sdks/typescript/)
(Node, pairing options, QR codes, the command, conformance).

```bash
pnpm add @nestor-home/satellite
pnpm add @roamhq/wrtc   # in Node, to talk aloud
```

A tab that writes with the assistant needs no WebRTC: the main entry point is the link, text,
intents and observations.

```ts
import { IDENTIFY, LocalStorageTokenStore, Manifest, Satellite } from "@nestor-home/satellite";

const satellite = new Satellite({
  core: location.origin,
  manifest: Manifest.of({ id: "tablette-cuisine", model: "browser", room: "cuisine" }, IDENTIFY),
  tokens: new LocalStorageTokenStore(),
  // declares text.display and text.input
  text: { display: (text, final) => show(text, final), input: true },
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
satellite.run();
form.onsubmit = () => satellite.sendText(input.value); // a turn of the kitchen's conversation
```

To talk aloud too, give it a voice (declares `audio.capture` and `audio.playback`). The microphone
opens only once Nestor allows audio, never while pairing:

```ts
import { browserVoice } from "@nestor-home/satellite/voice";

const satellite = new Satellite({ ...options, voice: browserVoice() });
button.onclick = () => satellite.run(); // a click: browsers only play sound after a gesture
```

In Node, the machine's microphone and speaker, with nothing to write (`--text` to write in the
terminal too, `--no-voice` for the terminal alone):

```bash
NESTOR_PAIRING_URI='nestor+http://nestor.local:8471/?code=K7QF2M9X' npx nestor-satellite run --room salon
```

A device that can update its own software gives an `updater` (declares `device.update`): it finds
newer versions at the software's own source and installs them, and Nestor's admin asks it to. The
manifest names that software (`software`, this SDK by default; a driver published as its own package
names it).

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
