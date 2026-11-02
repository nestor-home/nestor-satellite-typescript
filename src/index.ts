/**
 * Write a Nestor satellite in TypeScript: pair with the core, hold its link, talk with the assistant
 * in writing, carry out its intents and report observations, following the `nestor.satellite/1`
 * protocol.
 *
 * This entry point runs anywhere (browsers, Node, workers) and needs no WebRTC: the link is the
 * platform's `WebSocket`. A satellite that talks aloud adds a voice: `browserVoice` in
 * `@nestor-home/satellite/voice`, `nodeVoice` (with the audio and token file) in
 * `@nestor-home/satellite/node`.
 */

export type { MediaNeeds, Peer, PeerEvents, PeerOptions, SessionDescription, Voice } from "./audio.js";
export type { Body } from "./body.js";
export {
  DEVICE_CODE,
  ENROLLMENT_ALPHABET,
  ENROLLMENT_LENGTH,
  groupEnrollmentCode,
  normalizeEnrollmentCode,
  type PairingUri,
  parsePairingUri,
  readEnrollment,
} from "./codes.js";
export { Dispatcher, type Outcome, type TextDisplay } from "./dispatch.js";
export { LOCALES, type Locale, type MessageArgs, type MessageId, Messages, negotiateLocale } from "./i18n.js";
export {
  LINK_CLOSE,
  linkUrl,
  type WebSocketConstructor,
  type WebSocketLike,
} from "./link.js";
export { type Logger, quietLogger } from "./log.js";
export {
  type CodeVoice,
  type EnrollOutcome,
  type Fetch,
  HttpError,
  type Paired,
  Pairing,
  PairingError,
  type PairingOptions,
  type PairingOutputs,
} from "./pairing.js";
export {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  BEHAVIORS,
  type Behavior,
  type Capability,
  capability,
  Device,
  type DeviceInit,
  ENROLLMENT_METHODS,
  type EnrollmentMethod,
  EXPRESSION,
  EXPRESSIONS,
  type Expression,
  HEAD_MOTION,
  IDENTIFY,
  type JsonValue,
  MAX_CAPABILITIES,
  Manifest,
  type ManifestJson,
  type ManifestOptions,
  PAIRING_METHODS,
  type PairingMethod,
  PERSON_DETECTION,
  PROTOCOL,
  ProtocolError,
  SDK,
  type Sdk,
  SPEECH_ACTIVITY,
  TEXT_DISPLAY,
  TEXT_INPUT,
} from "./protocol.js";
export {
  CapabilityNotAllowed,
  LinkReplaced,
  type PairingSetup,
  pairingMethods,
  providedCapabilities,
  type QrScanner,
  Satellite,
  type SatelliteOptions,
  type TextSetup,
} from "./satellite.js";
export {
  type DeviceState,
  hashEnrollmentCode,
  LocalStorageTokenStore,
  type MaybePromise,
  MemoryTokenStore,
  type RefusedCodes,
  type StorageLike,
  type TokenStore,
} from "./tokens.js";
export { SDK_NAME, SDK_VERSION } from "./version.js";
export * as wire from "./wire.js";
