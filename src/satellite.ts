/**
 * A satellite's life: pair once, then stay connected to the core, reconnecting when the link drops.
 *
 *     const satellite = new Satellite({ core: "http://nestor.local:7860", manifest, tokens, webrtc, body });
 *     await satellite.run(signal); // until the signal aborts
 *
 * Each connection is a WebRTC peer connection, offered to `POST /satellites/{device_id}/offer` with
 * the token: an audio track each way and the `nestor` data channel for `hello`/`welcome`, intents
 * (acknowledged) and observations. A refused token is forgotten and the device pairs again.
 */

import type { Body } from "./body.js";
import { Dispatcher } from "./dispatch.js";
import { describe, type Logger, quietLogger } from "./log.js";
import { type Fetch, HttpError, pair, showCode, sleep } from "./pairing.js";
import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  type Manifest,
  PERSON_DETECTION,
  ProtocolError,
  SPEECH_ACTIVITY,
} from "./protocol.js";
import type { TokenStore } from "./tokens.js";
import type { Peer, SessionDescription, WebRtc } from "./webrtc.js";
import { hello, personDetected, type SatelliteMessage, speechActivity, type Welcome } from "./wire.js";

/** An observation the device did not declare, or the household did not allow. */
export class CapabilityNotAllowed extends ProtocolError {
  override name = "CapabilityNotAllowed";
}

/** The core does not know this token any more: pair again. */
class Refused extends Error {}

export interface SatelliteOptions {
  /** The core's voice server, e.g. `http://nestor.local:7860`. */
  readonly core: string;
  readonly manifest: Manifest;
  readonly tokens: TokenStore;
  readonly webrtc: WebRtc;
  readonly body?: Body;
  /** Show the pairing code (default: printed on the console). */
  readonly onCode?: (code: string) => void;
  /** STUN/TURN URLs, only needed beyond the local network. */
  readonly iceServers?: readonly string[];
  readonly pollMs?: number;
  /** First and longest delay between connection attempts. */
  readonly backoffMs?: readonly [number, number];
  /** A connection not welcomed within this delay is dropped and tried again. */
  readonly welcomeTimeoutMs?: number;
  readonly fetch?: Fetch;
  readonly logger?: Logger;
}

export class Satellite {
  readonly core: string;
  readonly manifest: Manifest;
  /** The last welcome: what the household allowed this device to do. */
  welcome: Welcome | null = null;
  /** Connections made since `run` started (answered offers). */
  connections = 0;

  private readonly options: SatelliteOptions;
  private readonly body: Body;
  private readonly logger: Logger;
  private readonly http: Fetch;
  private peer: Peer | null = null;
  private running = false;

  constructor(options: SatelliteOptions) {
    this.options = options;
    this.core = options.core.replace(/\/+$/, "");
    this.manifest = options.manifest;
    this.body = options.body ?? {};
    this.logger = options.logger ?? quietLogger;
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Whether a connection is up and welcomed. */
  get connected(): boolean {
    return this.peer !== null && this.welcome !== null;
  }

  /**
   * Run until `signal` aborts: pair when needed, connect, and reconnect with a growing delay.
   * Rejects only when the audio devices cannot open (a declared microphone that is missing).
   */
  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("this satellite is already running");
    this.running = true;
    const { webrtc, backoffMs = [500, 30_000] } = this.options;
    try {
      await webrtc.open?.({ capture: this.manifest.has(AUDIO_CAPTURE), playback: this.manifest.has(AUDIO_PLAYBACK) });
      let delay = backoffMs[0];
      while (!signal?.aborted) {
        let welcomed = false;
        try {
          welcomed = await this.connectOnce(await this.token(signal), signal);
        } catch (error) {
          if (signal?.aborted) break;
          if (error instanceof Refused) {
            this.logger.warn("the core refused this satellite's token: pairing again");
            await this.options.tokens.forget();
            continue;
          }
          this.logger.warn(`satellite link failed (${describe(error)}), retrying`);
        }
        delay = welcomed ? backoffMs[0] : Math.min(delay * 2, backoffMs[1]);
        try {
          await sleep(delay, signal);
        } catch {
          break;
        }
      }
    } finally {
      this.running = false;
      await webrtc.close?.();
    }
  }

  /** Report people seen now; `false` when not connected (observations are not queued). */
  personDetected(count: number, confidence: number): boolean {
    return this.observe(PERSON_DETECTION, () => personDetected(count, confidence));
  }

  /** Report that voice activity started or stopped on the device. */
  speechActivity(active: boolean): boolean {
    return this.observe(SPEECH_ACTIVITY, () => speechActivity(active));
  }

  private observe(capability: string, build: () => SatelliteMessage): boolean {
    const allowed = this.welcome?.capabilities ?? this.manifest.names;
    if (!this.manifest.has(capability) || !allowed.has(capability)) {
      throw new CapabilityNotAllowed(`this observation needs the ${capability} capability, declared and allowed`);
    }
    const message = build();
    return this.peer?.send(JSON.stringify(message)) ?? false;
  }

  private async token(signal: AbortSignal | undefined): Promise<string> {
    const { tokens, onCode = showCode, pollMs } = this.options;
    const device = this.manifest.device.id;
    const saved = await tokens.load(this.core, device);
    if (saved !== null) return saved;
    const token = await pair({
      core: this.core,
      manifest: this.manifest,
      onCode,
      fetch: this.http,
      logger: this.logger,
      ...(pollMs === undefined ? {} : { pollMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    await tokens.save(this.core, device, token);
    return token;
  }

  /** One connection, until the core hangs up or the link fails; whether it was welcomed. */
  private async connectOnce(token: string, signal: AbortSignal | undefined): Promise<boolean> {
    const { webrtc, iceServers = [], welcomeTimeoutMs = 15_000 } = this.options;
    let end: (reason: string) => void = () => {};
    const ended = new Promise<string>((resolve) => {
      end = resolve;
    });
    let welcomed = false;
    let peer: Peer | null = null;
    const send = (message: SatelliteMessage) => peer?.send(JSON.stringify(message)) ?? false;
    const dispatcher = new Dispatcher(this.body, send, this.logger);
    peer = await webrtc.createPeer({
      iceServers,
      events: {
        onOpen: () => send(hello(this.manifest)),
        onMessage: (text) => {
          const outcome = dispatcher.handle(text);
          if (outcome === "welcomed") {
            this.welcome = dispatcher.welcome;
            if (!welcomed) {
              welcomed = true;
              this.logger.info(`welcomed in ${this.welcome?.room ?? "?"}`);
              this.body.connected?.(true);
            }
          } else if (outcome === "hung-up") {
            end("the core hung up");
          }
        },
        onClosed: end,
        onAudio: () => this.body.heartbeat?.(),
      },
    });
    const stop = () => end("stopped");
    signal?.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await this.offer(await peer.offer(), token, signal);
      await peer.accept(answer);
      this.peer = peer;
      this.connections += 1;
      timer = setTimeout(() => welcomed || end(`not welcomed within ${welcomeTimeoutMs} ms`), welcomeTimeoutMs);
      this.logger.info(`link ended: ${await ended}`);
      return welcomed;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      this.peer = null;
      if (welcomed) this.body.connected?.(false);
      await peer.close();
    }
  }

  private async offer(
    offer: SessionDescription,
    token: string,
    signal: AbortSignal | undefined,
  ): Promise<SessionDescription> {
    const response = await this.http(`${this.core}/satellites/${encodeURIComponent(this.manifest.device.id)}/offer`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401) throw new Refused("token refused");
    if (!response.ok) throw new HttpError(response.status, `offer: HTTP ${response.status}`);
    const answer: unknown = await response.json();
    if (
      typeof answer !== "object" ||
      answer === null ||
      !("sdp" in answer) ||
      typeof answer.sdp !== "string" ||
      !("type" in answer) ||
      answer.type !== "answer"
    ) {
      throw new HttpError(502, "offer: the core did not answer with an SDP answer");
    }
    return { sdp: answer.sdp, type: "answer" };
  }
}
