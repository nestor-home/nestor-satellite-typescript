/**
 * `@nestor-home/satellite/voice`: a satellite that talks aloud. WebRTC audio with the core (the
 * browser's `browserVoice`; Node's `nodeVoice` is in `@nestor-home/satellite/node`), the device code
 * said with the bundled voice, and the browser's own speech. A satellite without a voice (a screen and
 * a keyboard, a sensor) never loads any of it.
 *
 *     const satellite = new Satellite({ core, manifest, tokens, voice: browserVoice() });
 */

export {
  type AudioContextLike,
  type AudioElementLike,
  type BrowserVoiceOptions,
  browserSpeech,
  browserVoice,
  type SpeechSynthesisLike,
  webAudioSpeaker,
} from "./browser.js";
export {
  AHEAD_MS,
  announcement,
  type Clock,
  clipKey,
  decodeWav,
  resample,
  type Speaker,
  SpokenCode,
  type SpokenCodeOptions,
  type Step,
  type VoiceIndex,
  voiceMessages,
} from "./spoken.js";
export type {
  AudioBridge,
  W3cPeerConnection,
  W3cPeerConnectionConstructor,
  W3cTrack,
  W3cTrackEvent,
} from "./w3c.js";
export { W3cPeer } from "./w3c.js";
