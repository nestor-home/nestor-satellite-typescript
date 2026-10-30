/**
 * Write a Nestor satellite in TypeScript: pair with the core, stream audio over WebRTC, carry out
 * its intents and report observations, following the `nestor.satellite/1` protocol.
 */

export type { Body } from "./body.js";
export { Dispatcher, type Outcome } from "./dispatch.js";
export { type Logger, quietLogger } from "./log.js";
export { type Fetch, HttpError, type PairOptions, pair, showCode } from "./pairing.js";
export {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  BEHAVIORS,
  type Behavior,
  type Capability,
  capability,
  Device,
  type DeviceInit,
  EXPRESSION,
  EXPRESSIONS,
  type Expression,
  HEAD_MOTION,
  type JsonValue,
  MAX_CAPABILITIES,
  Manifest,
  type ManifestJson,
  PERSON_DETECTION,
  PROTOCOL,
  ProtocolError,
  SDK,
  type Sdk,
  SPEECH_ACTIVITY,
} from "./protocol.js";
export {
  LocalStorageTokenStore,
  type MaybePromise,
  MemoryTokenStore,
  type StorageLike,
  type TokenStore,
} from "./tokens.js";
export { SDK_NAME, SDK_VERSION } from "./version.js";
export * as wire from "./wire.js";
