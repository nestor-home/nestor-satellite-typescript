/**
 * The WebRTC a satellite runs on, as a port: the SDK's core never touches a browser or Node API.
 *
 * - `browserWebRtc()` (this package): the browser's `RTCPeerConnection` and `getUserMedia`;
 * - `nodeWebRtc()` (`@nestor-home/satellite/node`): `@roamhq/wrtc`, with PCM audio sources and sinks;
 * - tests plug a fake that plays the core.
 *
 * One `Peer` is one connection to the core: an audio track each way and the `nestor` data channel.
 */

export interface SessionDescription {
  readonly sdp: string;
  readonly type: "offer" | "answer";
}

/** What the satellite needs from the device's audio for this run. */
export interface MediaNeeds {
  /** `audio.capture` was declared: the microphone must open (fails clearly otherwise). */
  readonly capture: boolean;
  /** `audio.playback` was declared: the core's voice must be played. */
  readonly playback: boolean;
}

export interface PeerEvents {
  /** The `nestor` data channel is open: messages can be sent. */
  onOpen(): void;
  onMessage(text: string): void;
  /** The data channel closed or the connection failed: this peer is over. */
  onClosed(reason: string): void;
  /** Audio from the core arrived (a heartbeat). */
  onAudio(): void;
}

export interface PeerOptions {
  /** STUN/TURN URLs (`stun:stun.l.google.com:19302`); only needed beyond the local network. */
  readonly iceServers: readonly string[];
  readonly events: PeerEvents;
}

export interface Peer {
  /** Create the offer, with its ICE candidates gathered (no trickle). */
  offer(): Promise<SessionDescription>;
  accept(answer: SessionDescription): Promise<void>;
  /** Send on the data channel; `false` when it is not open. */
  send(text: string): boolean;
  close(): void | Promise<void>;
}

export interface WebRtc {
  /** Open the audio devices, once per `Satellite.run`. */
  open?(needs: MediaNeeds): Promise<void>;
  createPeer(options: PeerOptions): Peer | Promise<Peer>;
  /** Release the audio devices. */
  close?(): Promise<void>;
}
