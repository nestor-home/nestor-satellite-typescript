# AGENTS.md

`@nestor-home/satellite` is the TypeScript SDK for Nestor satellite drivers, in browsers and in
Node. This file is for coding agents: read it before changing anything.

## Commands

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # all three must pass; CI runs them on Node 22 and 24
pnpm package:check                          # build, publint, attw
pnpm conformance                            # build, then the published server's suite (needs uvx)
NESTOR_CONFORMANCE_FROM='../nestor[voice,media]' pnpm conformance   # the same against a local server
pnpm format                                 # Biome writes the fixes
```

Dependencies are pinned to exact versions (`pnpm add -E`); commit `pnpm-lock.yaml`.

## Layout

```text
src/              the core: runs anywhere, imports no platform API and no WebRTC
├── protocol.ts   values of nestor.satellite/1: Device, Capability, Manifest, pairing methods, Behavior…
├── codes.ts      enrollment codes (Crockford base32) and pairing URIs (nestor+http://…/?code=…)
├── wire.ts       the JSON envelope and the pairing bodies: what the satellite sends, strict parsing of the core's
├── dispatch.ts   intents to the Body and the text display, acks, welcome
├── body.ts       Body: what a driver implements to carry out intents
├── pairing.ts    Pairing: enrollment code or device code, enroll while pending, refusals (kept hashed), 429 (fetch)
├── i18n.ts       Messages: every sentence for people, through Fluent; locales.ts holds en and fr
├── tokens.ts     TokenStore (token and refused codes' hashes), MemoryTokenStore, LocalStorageTokenStore
├── link.ts       the link's WebSocket (the platform's), its URL and close codes
├── update.ts     Updater: what a device that updates its own software provides; reports and installs (U1-U3)
├── audio.ts      the Voice / Peer port: WebRTC audio, offered once welcomed with audio allowed and
│                 `welcome.voice`; VoiceHold, the voice that steps aside during a call
├── media.ts      Camera port, MediaSessions: rules M1 to M6 of watching and calling (loaded once welcomed,
│                 only by a device with a camera or a voice)
├── satellite.ts  Satellite: pairing, the link (hello/welcome, reconnection), text, observations, audio, QrScanner port
├── voice/        @nestor-home/satellite/voice: browserVoice (getUserMedia, an <audio> element), W3cPeer over
│                 any RTCPeerConnection, SpokenCode (the bundled voice), webAudioSpeaker, browserSpeech
├── video/        @nestor-home/satellite/video: browserCamera (getUserMedia), patternCamera (a canvas),
│                 browsers only; stills as JPEG through a canvas
├── node/         @nestor-home/satellite/node: nodeVoice (@roamhq/wrtc), PCM audio (and sinkSpeaker),
│                 FileTokenStore, env.ts (NESTOR_PAIRING_URI, NESTOR_PAIRING_CODE, LANG), the CLI
└── qr/           @nestor-home/satellite/qr: cameraQrScanner, browsers only (zxing-wasm, optional peer)
schemas/          JSON Schemas copied from the server (do not edit by hand)
voice/            the bundled voice's clips, copied from nestor-satellite-python (do not edit by hand)
examples/browser/ a tab as a satellite (Vite)
scripts/          browser-satellite.mjs (a headless Chromium tab as a satellite, for conformance)
test/             behaviour tests against a fake core (local HTTP and WebSocket, in-process WebRTC)
```

## Rules

1. **The main entry point stays platform-free and needs no WebRTC.** Nothing it loads imports
   `node:*`, `src/node/`, `src/voice/`, `src/qr/` or a WebRTC library (`test/independence.test.ts`
   walks its imports); its one dependency is `@fluent/bundle`, which runs anywhere. The link uses the
   platform's standard `WebSocket`; audio sits behind the `Voice` port. `@roamhq/wrtc` stays an
   optional peer dependency, loaded by `nodeVoice` only. The media sessions (`media.ts`) are loaded
   with a dynamic import once welcomed, only by a satellite with a camera or a voice.
2. **The server owns the protocol.** `schemas/` is a copy of
   the schemas of the `nestor-home` release in `.nestor-version`. To refresh:
   `uvx --from nestor-home=="$(cat .nestor-version)" nestor satellites schemas --out schemas/`, then adapt
   `wire.ts`/`protocol.ts` until the tests pass. Every message the SDK sends is validated against
   these schemas (ajv).
3. **Be lenient in what you read, strict in what you send.** An unknown message type from a newer
   core is ignored; a malformed known one is logged and dropped; what the SDK sends is checked first.
4. **Conformance is the contract.** `pnpm conformance` runs the server's
   `nestor satellites conformance` on the built CLI (a speaker that writes: `--input none --output none
   --text --token-file {state}/token.json`) and on the browser example in headless Chromium, aloud and
   in writing only (`--no-voice`), and filming with Chromium's fake camera (`--camera`), once per
   scenario; the enrollment scenarios set `NESTOR_PAIRING_URI`, which `scripts/browser-satellite.mjs` passes to the page as `?pairing_uri=`.
   A change to the link, pairing, text, audio or media is done when it passes. The standard it checks:
   https://nestorhome.dev/docs/satellites/protocol/ (rules N1, P1-P8, I1-I3, L1-L5, T1-T4, U1-U3, A1-A4,
   M1-M7).
   See [Conformance](#conformance).
5. **The network loop never waits for the device.** `Body` methods return at once; a failing body is
   logged, never allowed to break the link. Physical safety lives in the driver.
6. **Capabilities are honest.** `text.*` and `audio.*` follow from what the driver provides (a
   `text.display` callback, `text.input`, a `voice` with a microphone or a speaker, an `updater` for
   `device.update`); declaring one without it throws. Typed text and observations need their capability declared and allowed. The
   microphone opens only for an audio connection, once welcomed with audio allowed: pairing and the
   link never wait for it, and a voice that fails is offered again while the link is up.
   `enrollment.qr` needs a `scanner` that really decodes camera frames: Node has none, so it never
   declares it. A `camera` declares `video.capture`, `onMedia` declares `media.indicator`.
7. **Secrets:** the token file is mode 600; a refused token is forgotten. No secret in the repo.
8. **Pairing never fails silently.** The device code always reaches the log (at warning level, so the
   default logger shows it); a refused enrollment code is said, translated, and never sent again,
   even after a restart (its SHA-256 hash, never the code, is kept in the `TokenStore`, in the Python
   SDK's JSON format); a `429` is waited out; a core that will never pair the device rejects `run`
   with a `PairingError`. Pairing methods are derived from the outputs a driver provides, never
   declared by hand: a speaker without a screen says the code with the bundled voice.
9. **People read translated sentences.** Anything shown, said or logged for a person goes through
   `Messages` (`src/locales.ts`, Fluent): add every message to every locale (`test/i18n.test.ts`),
   short and natural, no em-dash. The core's `detail` is English for logs, never shown to people.
10. **The bundled voice is shared.** `voice/` is a copy of
    `../nestor-satellite-python/src/nestor_satellite/voice/` (refresh with
    `cp -R ../nestor-satellite-python/src/nestor_satellite/voice/. voice/`). The
    sentence is `device-code-speech`; cutting it into clips follows the Python SDK's algorithm
    exactly. Changing that sentence means recording its clips again (`scripts/voice.py` there).
11. **Media sessions keep M1 to M6 in the SDK** (`media.ts`): a connection only for an
    `intent.media.open` of the link and what `welcome` allowed, an end at `close`, `max_s` and when the
    link drops (camera and microphone released), `onMedia` before anything is offered, the voice hung up
    during a call, no listening port. A driver cannot bypass them. The voice is offered only when
    `welcome.voice` is true.

## Conformance

The suite is the published server's `nestor satellites conformance` command, run through `uvx`; the
server's version is pinned in `.nestor-version`, the one place to bump it (deliberately, after
reading the server's changelog). `pnpm conformance` builds, then runs `test/conformance/`, one file
per satellite (CI runs each in its own job), which checks the exit status (0), that no line starts
with `FAIL`, and a few named checks. By hand:

```bash
pnpm build
uvx --from "nestor-home[voice,media]==$(cat .nestor-version)" nestor satellites conformance --deadline 20 -- \
  node dist/node/bin.js run --core '{url}' --room salon --input none --output none --text --token-file '{state}/token.json'
uvx --from "nestor-home[voice,media]==$(cat .nestor-version)" nestor satellites conformance --deadline 20 -- \
  node scripts/browser-satellite.mjs --core '{url}' [--no-voice] [--camera]
```

Against a local checkout of the server, replace the `--from` argument by `'../nestor[voice,media]'` (or set
`NESTOR_CONFORMANCE_FROM` for `pnpm conformance`).

## Code conventions

- TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM with `.js`
  import suffixes, no `any` (Biome enforces it), no DOM or Node types in the core's public API.
- Biome formats and lints, line width 120. English only.
- Async: explicit timeouts, `AbortSignal` for cancellation, resources released in `close`.
- Keep the repository lean: no new Markdown files.

## Tests

- Test behaviour, not implementation: one behaviour per test, named as a sentence.
- Hardware and network are replaced by doubles (`FakeCore` over real HTTP and WebSocket,
  `FakeVoice`, a scripted wrtc); one test runs the real `@roamhq/wrtc` in loopback.
- Cover the happy path, an unavailable core, a cancellation and a missing optional capability.
