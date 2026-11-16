/**
 * `@nestor-home/satellite/video`: a satellite that films, in the sessions a person opens in Nestor,
 * and takes still pictures when asked. The browser's camera (`browserCamera`), or a test pattern
 * drawn on a canvas (`patternCamera`). A satellite without a camera never loads any of it.
 *
 *     const satellite = new Satellite({ core, manifest, tokens, camera: browserCamera(), onMedia: light });
 *
 * The SDK keeps the protocol's rules itself (M1 to M6): it films only when its link asks, for what it
 * was allowed, ends when told, at the session's limit or when the link drops, and listens on no port.
 */

export {
  type BrowserCameraOptions,
  browserCamera,
  type CanvasContextLike,
  type CanvasLike,
  type PatternCameraOptions,
  patternCamera,
} from "./browser.js";
