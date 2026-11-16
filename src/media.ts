/**
 * The sessions a person opens in Nestor to watch through the device's camera or call through it,
 * and the still pictures they ask for. The rules of `nestor.satellite/1` are kept here, whatever the
 * driver does:
 *
 * - M1. A connection only for an `intent.media.open` received on the link, and only for what the
 *   device was given and `welcome` allowed: video with a `camera` and `video.capture`, a call with a
 *   voice that has a microphone and a speaker, and both `audio.capture` and `audio.playback`. A
 *   session asking for more is refused whole: acknowledged, logged, nothing offered.
 * - M2. It ends on `intent.media.close`, at `max_s` by the device's own clock, and when the link
 *   closes; the camera and the microphone are released after.
 * - M3. `onMedia(true)` before anything is offered, `onMedia(false)` once nothing is filmed or heard
 *   (sessions and still pictures).
 * - M4. The device only connects out to the core: the SDK listens on no port.
 * - M5. During a call, the voice with the assistant steps aside: it hangs up before the call
 *   connects, and is offered again after.
 * - M6. `intent.media.snapshot` is answered with `media.snapshot {of, jpeg}`.
 *
 * The camera is a port (`browserCamera`, `patternCamera` in `@nestor-home/satellite/video`): this
 * module touches no platform API and no WebRTC. The satellite loads it once welcomed, and only when
 * it has a camera or a voice: a satellite in writing never does.
 */

import type { Peer, PeerEvents, SessionDescription, Voice, VoiceHold } from "./audio.js";
import { callBody } from "./body.js";
import type { Messages } from "./i18n.js";
import { describe, type Logger } from "./log.js";
import { AUDIO_CAPTURE, AUDIO_PLAYBACK, VIDEO_CAPTURE } from "./protocol.js";
import { type MediaIntent, type MediaOpenIntent, mediaSnapshot, type SatelliteMessage } from "./wire.js";

/**
 * A camera: declares `video.capture`. The SDK opens it for each session that films and each still
 * picture, and closes it after the last: it is on only while something is sent.
 */
export interface Camera {
  /** Switch the camera on; resolves once it films. Rejects when it cannot. */
  open(): Promise<void>;
  /** Switch it off. */
  close(): Promise<void>;
  /** What it films now, as a JPEG (the camera is open). */
  still(): Promise<Uint8Array>;
  /**
   * One connection for one session, carrying the open camera's video; for a call, `call` is the
   * voice, opened both ways, whose microphone and speaker the connection also carries.
   */
  createPeer(events: PeerEvents, call: Voice | null): Peer | Promise<Peer>;
}

/** Shows that something is filmed or heard (a light, a screen); returns at once. Declares `media.indicator`. */
export type MediaIndicator = (active: boolean) => void;

/** One camera for every session that films and every still picture. */
class CameraUse {
  private users = 0;
  private changing: Promise<void> = Promise.resolve();

  constructor(readonly camera: Camera) {}

  /** One more user; the first switches the camera on. Rejects (and counts nothing) when it cannot. */
  acquire(): Promise<void> {
    return this.serial(async () => {
      if (this.users === 0) await this.camera.open();
      this.users += 1;
    });
  }

  /** A user is done; the last switches the camera off. */
  release(): Promise<void> {
    return this.serial(async () => {
      this.users -= 1;
      if (this.users === 0) await this.camera.close();
    });
  }

  private serial(step: () => Promise<void>): Promise<void> {
    const next = this.changing.then(step);
    this.changing = next.catch(() => {});
    return next;
  }
}

export interface MediaSetup {
  /** What the welcome allowed. */
  readonly allowed: ReadonlySet<string>;
  readonly camera: Camera | undefined;
  readonly voice: Voice | undefined;
  /** `POST /satellites/{device_id}/media` with the session and the offer: the core's answer. */
  readonly offer: (session: string, offer: SessionDescription, signal: AbortSignal) => Promise<SessionDescription>;
  readonly send: (message: SatelliteMessage) => boolean;
  /** The voice with the assistant, which steps aside during a call. */
  readonly voiceHold: VoiceHold;
  readonly onMedia: MediaIndicator | undefined;
  readonly messages: Messages;
  readonly logger: Logger;
}

/** The sessions of one welcomed link. */
export class MediaSessions {
  private readonly camera: CameraUse | null;
  private readonly calls: boolean;
  private readonly live = new Map<string, AbortController>();
  private readonly running = new Set<Promise<void>>();
  private pictures = 0;
  private calling = false;
  private shown = false;
  private closed = false;

  constructor(private readonly setup: MediaSetup) {
    const { allowed, camera, voice } = setup;
    this.camera = camera !== undefined && allowed.has(VIDEO_CAPTURE) ? new CameraUse(camera) : null;
    this.calls = voice?.capture === true && voice.playback && allowed.has(AUDIO_CAPTURE) && allowed.has(AUDIO_PLAYBACK);
  }

  /** Whether something is filmed or heard now. */
  get active(): boolean {
    return this.live.size > 0 || this.pictures > 0;
  }

  /** An intent of the link (`id`: its id): open or end a session, or take a picture. Returns at once. */
  handle(id: string, intent: MediaIntent): void {
    if (this.closed) return;
    switch (intent.type) {
      case "intent.media.open":
        this.open(intent);
        break;
      case "intent.media.close":
        this.live.get(intent.session)?.abort();
        break;
      case "intent.media.snapshot":
        this.snapshot(id);
        break;
    }
  }

  /** The link closed: everything ends (M2). Resolves once the camera and the microphone are released. */
  async close(): Promise<void> {
    this.closed = true;
    for (const stop of this.live.values()) stop.abort();
    await Promise.all(this.running);
  }

  private open(intent: MediaOpenIntent): void {
    if (this.live.has(intent.session)) return;
    const wanted = intent.video || intent.audio;
    if (!wanted || (intent.video && this.camera === null) || (intent.audio && (!this.calls || this.calling))) {
      this.setup.logger.warn(this.setup.messages.format("media-refused"));
      return;
    }
    const stop = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, intent.maxS * 1000); // from the moment it was asked, by the device's own clock
    if (intent.audio) this.calling = true;
    this.live.set(intent.session, stop);
    this.indicate(); // before anything is offered (M3)
    this.track(
      this.carry(intent, stop.signal)
        .catch((error: unknown) => {
          if (!stop.signal.aborted) {
            this.setup.logger.warn(this.setup.messages.format("media-failed", { error: describe(error) }));
          }
        })
        .finally(() => {
          clearTimeout(timer);
          if (timedOut) this.setup.logger.info(this.setup.messages.format("media-timed-out", { seconds: intent.maxS }));
          this.live.delete(intent.session);
          if (intent.audio) {
            this.calling = false;
            this.setup.voiceHold.start(); // offered again after the call (M5)
          }
          this.indicate();
        }),
    );
  }

  /** Connect for one session and carry it until it ends; releases what it opened. */
  private async carry(intent: MediaOpenIntent, signal: AbortSignal): Promise<void> {
    const voice = intent.audio ? this.setup.voice : undefined;
    const camera = intent.video ? this.camera : null;
    let finish: (reason: string) => void = () => {};
    const over = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const ended = () => finish("ended");
    signal.addEventListener("abort", ended, { once: true });
    let peer: Peer | null = null;
    let filming = false;
    try {
      if (voice !== undefined) await this.setup.voiceHold.hold(); // nothing of the room on the voice (M5)
      signal.throwIfAborted();
      if (camera !== null) {
        await camera.acquire();
        filming = true;
      }
      signal.throwIfAborted();
      if (voice !== undefined) await voice.open({ capture: true, playback: true });
      signal.throwIfAborted();
      const events: PeerEvents = { onClosed: (reason) => finish(reason), onAudio: () => {} };
      if (camera !== null) peer = await camera.camera.createPeer(events, voice ?? null);
      else if (voice !== undefined) peer = await voice.createPeer(events);
      if (peer === null) return;
      await peer.accept(await this.setup.offer(intent.session, await peer.offer(), signal));
      const reason = await over;
      if (!signal.aborted) this.setup.logger.info(`media session ${intent.session} ended: ${reason}`);
    } finally {
      signal.removeEventListener("abort", ended);
      await peer?.close();
      if (voice !== undefined) await voice.close().catch((error: unknown) => this.debug("the voice", error));
      if (filming) await camera?.release().catch((error: unknown) => this.debug("the camera", error));
    }
  }

  private snapshot(id: string): void {
    const camera = this.camera;
    if (camera === null) {
      this.setup.logger.warn(this.setup.messages.format("media-refused"));
      return;
    }
    this.pictures += 1;
    this.indicate();
    const take = async () => {
      await camera.acquire();
      let jpeg: Uint8Array;
      try {
        jpeg = await camera.camera.still();
      } finally {
        await camera.release().catch((error: unknown) => this.debug("the camera", error));
      }
      this.setup.send(mediaSnapshot(id, jpeg));
    };
    this.track(
      take()
        .catch((error: unknown) => {
          this.setup.logger.warn(this.setup.messages.format("media-failed", { error: describe(error) }));
        })
        .finally(() => {
          this.pictures -= 1;
          this.indicate();
        }),
    );
  }

  private track(work: Promise<void>): void {
    this.running.add(work);
    void work.finally(() => this.running.delete(work));
  }

  /** Tell the driver when something starts or stops being filmed or heard (M3). */
  private indicate(): void {
    const { onMedia, logger } = this.setup;
    if (onMedia === undefined || this.active === this.shown) return;
    this.shown = this.active;
    const shown = this.shown;
    callBody(logger, () => onMedia(shown));
  }

  private debug(what: string, error: unknown): void {
    this.setup.logger.debug(`releasing ${what}: ${describe(error)}`);
  }
}
