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
├── protocol.ts   values of nestor.satellite/1: Device, Capability, Manifest, Behavior, Expression
├── wire.ts       the JSON envelope: messages the satellite sends, strict parsing of the core's
├── dispatch.ts   intents to the Body, acks, welcome, hang-up
├── body.ts       Body: what a driver implements to carry out intents
├── pairing.ts    pair with a code (fetch)
├── tokens.ts     TokenStore, MemoryTokenStore, LocalStorageTokenStore
├── webrtc.ts     the WebRtc / Peer port
├── w3c.ts        W3cPeer: a Peer over any standard RTCPeerConnection
├── browser.ts    browserWebRtc: getUserMedia and an <audio> element
├── satellite.ts  Satellite: pairing, connection, hello/welcome, observations, reconnection
└── node/         @nestor-home/satellite/node: @roamhq/wrtc, PCM audio, FileTokenStore, the CLI
schemas/          JSON Schemas copied from the server (do not edit by hand)
examples/browser/ a tab as a satellite (Vite)
scripts/          conformance.py (the server's suite on any command), browser-satellite.mjs
test/             behaviour tests against a fake core (local HTTP, in-process WebRTC)
```

## Rules

1. **The main entry point stays platform-free.** Nothing under `src/*.ts` imports `node:*`,
   `src/node/` or a WebRTC library (`test/independence.test.ts`); platform code sits behind the
   `WebRtc` port. `@roamhq/wrtc` stays an optional peer dependency, loaded by `nodeWebRtc` only.
2. **The server owns the protocol.** `schemas/` is a copy of
   `../nestor/src/nestor/modules/satellites/schemas/`; `test/schemas.test.ts` fails when they drift.
   To refresh: `cp ../nestor/src/nestor/modules/satellites/schemas/*.json schemas/`, then adapt
   `wire.ts`/`protocol.ts` until the tests pass. Every message the SDK sends is validated against
   these schemas (ajv).
3. **Be lenient in what you read, strict in what you send.** An unknown message type from a newer
   core is ignored; a malformed known one is logged and dropped; what the SDK sends is checked first.
4. **Conformance is the contract.** `pnpm conformance` runs nestor's `check_satellite` on the built
   CLI (speaker profile: `--input none --output none`) and on the browser example in headless
   Chromium. A change to connection, pairing or audio is done when it passes.
5. **The network loop never waits for the device.** `Body` methods return at once; a failing body is
   logged, never allowed to break the link. Physical safety lives in the driver.
6. **Capabilities are honest.** A declared capability whose device cannot open fails clearly at
   `run`; observations need their capability declared and allowed.
7. **Secrets:** the token file is mode 600; a refused token is forgotten. No secret in the repo.

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
