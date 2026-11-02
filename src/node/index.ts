/**
 * Node side of `@nestor-home/satellite`: a voice over WebRTC through `@roamhq/wrtc` (an optional
 * peer dependency), PCM audio sources and sinks (which also say the device code with the bundled
 * voice), and a token file only its owner can read.
 */

export {
  type AudioSink,
  type AudioSource,
  type CommandOptions,
  CommandSink,
  CommandSource,
  DiscardSink,
  FRAME_MS,
  RecordingSink,
  SilenceSource,
} from "./audio.js";
export {
  type Environment,
  languagesFromEnv,
  PAIRING_CODE_ENV,
  PAIRING_URI_ENV,
  type Provisioning,
  provisioningFromEnv,
  readProvisioning,
} from "./env.js";
export { FileTokenStore } from "./tokens.js";
export { sinkSpeaker, voiceFile } from "./voice.js";
export {
  loadWrtc,
  type NodeVoiceOptions,
  nodeVoice,
  type RTCAudioData,
  toMono,
  type WrtcModule,
} from "./webrtc.js";
