/**
 * Node side of `@nestor-home/satellite`: WebRTC through `@roamhq/wrtc` (an optional peer
 * dependency), PCM audio sources and sinks, and a token file only its owner can read.
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
export {
  loadWrtc,
  type NodeWebRtcOptions,
  nodeWebRtc,
  type RTCAudioData,
  toMono,
  type WrtcModule,
} from "./webrtc.js";
