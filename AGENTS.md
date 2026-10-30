# AGENTS.md

`@nestor-home/satellite` is the TypeScript SDK for Nestor satellite drivers, in browsers and in
Node. This file is for coding agents: read it before changing anything.

## Commands

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test   # all three must pass; CI runs them on Node 22 and 24
pnpm package:check                          # build, publint, attw
pnpm conformance                            # build, then the server's suite (needs ../nestor/.venv)
pnpm format                                 # Biome writes the fixes
```

Dependencies are pinned to exact versions (`pnpm add -E`); commit `pnpm-lock.yaml`.

## Layout

```text
src/              the core: runs anywhere, imports no platform API
├── protocol.ts   values of nestor.satellite/2: Device, Capability, Manifest, pairing methods, Behavior…
├── codes.ts      enrollment codes (Crockford base32) and pairing URIs (nestor+http://…/?code=…)
├── wire.ts       the JSON envelope and the pairing bodies: what the satellite sends, strict parsing of the core's
├── dispatch.ts   intents to the Body (identify included), acks, welcome, hang-up
├── body.ts       Body: what a driver implements to carry out intents
├── pairing.ts    Pairing: enrollment code or device code, enroll while pending, refusals, 429 (fetch)
├── i18n.ts       Messages: every sentence for people, through Fluent; locales.ts holds en and fr
├── tokens.ts     TokenStore, MemoryTokenStore, LocalStorageTokenStore
├── webrtc.ts     the WebRtc / Peer port
├── w3c.ts        W3cPeer: a Peer over any standard RTCPeerConnection
├── browser.ts    browserWebRtc: getUserMedia and an <audio> element
├── satellite.ts  Satellite: pairing, connection, hello/welcome, observations, reconnection
└── node/         @nestor-home/satellite/node: @roamhq/wrtc, PCM audio, FileTokenStore, env.ts
                  (NESTOR_PAIRING_URI, NESTOR_PAIRING_CODE, LANG), the CLI
schemas/          JSON Schemas copied from the server (do not edit by hand)
examples/browser/ a tab as a satellite (Vite)
scripts/          conformance.py (the server's suite on any command), browser-satellite.mjs
test/             behaviour tests against a fake core (local HTTP, in-process WebRTC)
```

## Rules

1. **The main entry point stays platform-free.** Nothing under `src/*.ts` imports `node:*`,
   `src/node/` or a WebRTC library (`test/independence.test.ts`); its one dependency is
   `@fluent/bundle`, which runs anywhere. Platform code sits behind the `WebRtc` port.
   `@roamhq/wrtc` stays an optional peer dependency, loaded by `nodeWebRtc` only.
2. **The server owns the protocol.** `schemas/` is a copy of
   `../nestor/src/nestor/modules/satellites/schemas/`; `test/schemas.test.ts` fails when they drift.
   To refresh: `cp ../nestor/src/nestor/modules/satellites/schemas/*.json schemas/`, then adapt
   `wire.ts`/`protocol.ts` until the tests pass. Every message the SDK sends is validated against
   these schemas (ajv).
3. **Be lenient in what you read, strict in what you send.** An unknown message type from a newer
   core is ignored; a malformed known one is logged and dropped; what the SDK sends is checked first.
4. **Conformance is the contract.** `pnpm conformance` runs nestor's `check_satellite` on the built
   CLI (speaker profile: `--input none --output none --token-file {state}/token.json`) and on the
   browser example in headless Chromium, once per scenario; the enrollment scenarios set
   `NESTOR_PAIRING_URI`, which `scripts/browser-satellite.mjs` passes to the page as `?pairing_uri=`.
   A change to connection, pairing or audio is done when it passes. The standard it checks:
   `../nestor/docs/satellite-protocol.md` (rules N1, P1-P8, I1-I3, W1-W4).
5. **The network loop never waits for the device.** `Body` methods return at once; a failing body is
   logged, never allowed to break the link. Physical safety lives in the driver.
6. **Capabilities are honest.** A declared capability whose device cannot open fails clearly at
   `run`; observations need their capability declared and allowed.
7. **Secrets:** the token file is mode 600; a refused token is forgotten. No secret in the repo.
8. **Pairing never fails silently.** The device code always reaches the log (at warning level, so the
   default logger shows it); a refused enrollment code is said, translated, and never sent again; a
   `429` is waited out; a core that will never pair the device rejects `run` with a `PairingError`.
   Pairing methods are derived from the outputs a driver provides, never declared by hand.
9. **People read translated sentences.** Anything shown, said or logged for a person goes through
   `Messages` (`src/locales.ts`, Fluent): add every message to every locale (`test/i18n.test.ts`),
   short and natural, no em-dash. The core's `detail` is English for logs, never shown to people.

## Code conventions

- TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM with `.js`
  import suffixes, no `any` (Biome enforces it), no DOM or Node types in the core's public API.
- Biome formats and lints, line width 120. English only.
- Async: explicit timeouts, `AbortSignal` for cancellation, resources released in `close`.
- Keep the repository lean: no new Markdown files.

## Tests

- Test behaviour, not implementation: one behaviour per test, named as a sentence.
- Hardware and network are replaced by doubles (`FakeCore`, `FakeWebRtc`, a scripted wrtc); one
  test runs the real `@roamhq/wrtc` in loopback.
- Cover the happy path, an unavailable core, a cancellation and a missing optional capability.
