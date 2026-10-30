/**
 * Write a Nestor satellite in TypeScript: pair with the core, stream audio over WebRTC, carry out
 * its intents and report observations, following the `nestor.satellite/1` protocol.
 *
 * This entry point runs anywhere (browsers, Node, workers): it touches no platform API until a
 * `WebRtc` adapter does. Node's adapter, audio and token file live in `@nestor-home/satellite/node`.
 */

export type { Body } from "./body.js";
export { type AudioElementLike, type BrowserWebRtcOptions, browserWebRtc } from "./browser.js";
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
export { CapabilityNotAllowed, Satellite, type SatelliteOptions } from "./satellite.js";
export {
  LocalStorageTokenStore,
  type MaybePromise,
  MemoryTokenStore,
  type StorageLike,
  type TokenStore,
} from "./tokens.js";
export { SDK_NAME, SDK_VERSION } from "./version.js";
export type {
  AudioBridge,
  W3cDataChannel,
  W3cPeerConnection,
  W3cPeerConnectionConstructor,
  W3cTrack,
  W3cTrackEvent,
} from "./w3c.js";
export { W3cPeer } from "./w3c.js";
export type { MediaNeeds, Peer, PeerEvents, PeerOptions, SessionDescription, WebRtc } from "./webrtc.js";
export * as wire from "./wire.js";
