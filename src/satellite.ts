/**
 * A satellite's life: pair once, then stay connected to the core, reconnecting when the link drops.
 *
 *     const satellite = new Satellite({ core: "http://nestor.local:7860", manifest, tokens, webrtc, body });
 *     await satellite.run(signal); // until the signal aborts
 *
 * Pairing (`./pairing.ts`) uses the enrollment code it was configured with, else presents its device
 * code on the outputs it was given (`pairing.display`, `pairing.speak`) and in its log. A device with a
 * speaker and no screen says its code with the bundled voice (`./voice.ts`). While it waits, a
 * `pairing.scanner` reads enrollment codes from QR codes. The manifest's `pairing_methods` follow
 * from all this: `enrollment.provisioning` always, the others when the device can.
 *
 * Each connection is a WebRTC peer connection, offered to `POST /satellites/{device_id}/offer` with
 * the token: an audio track each way and the `nestor` data channel for `hello`/`welcome`, intents
 * (acknowledged) and observations. A refused token is forgotten and the device pairs again.
 */

import type { Body } from "./body.js";
import { readEnrollment } from "./codes.js";
import { Dispatcher } from "./dispatch.js";
import { Messages } from "./i18n.js";
import { describe, type Logger, quietLogger } from "./log.js";
import {
  type EnrollOutcome,
  type Fetch,
  HttpError,
  Pairing,
  PairingError,
  type PairingOutputs,
  sleep,
} from "./pairing.js";
import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  type EnrollmentMethod,
  IDENTIFY,
  type Manifest,
  PAIRING_METHODS,
  type PairingMethod,
  PERSON_DETECTION,
  ProtocolError,
  SPEECH_ACTIVITY,
} from "./protocol.js";
import type { TokenStore } from "./tokens.js";
import { SpokenCode } from "./voice.js";
import type { Peer, SessionDescription, WebRtc } from "./webrtc.js";
import { hello, personDetected, type SatelliteMessage, speechActivity, type Welcome } from "./wire.js";

/** An observation the device did not declare, or the household did not allow. */
export class CapabilityNotAllowed extends ProtocolError {
  override name = "CapabilityNotAllowed";
}

/** The core does not know this token any more: pair again. */
class Refused extends Error {}

/**
 * Reads QR codes with the device's camera (`cameraQrScanner` in `@nestor-home/satellite/qr`):
 * declares `enrollment.qr`. The satellite runs it only while it waits to be paired.
 */
export interface QrScanner {
  /** Open the camera and call `found` with the text of each QR code seen, until `signal` aborts. Rejects when the camera cannot open. */
  scan(found: (text: string) => void, signal: AbortSignal): Promise<void>;
}

/** How this device pairs. Every field is optional: a device with none logs its device code. */
export interface PairingSetup extends Omit<PairingOutputs, "voice"> {
  /**
   * An enrollment code (`K7QF-2M9X`) or a pairing URI (`nestor+http://…/?code=…`) a person gave the
   * device: sent with the first request, so it pairs with no code to type.
   */
  readonly enrollment?: string | undefined;
  /** How `enrollment` reached the device; `enrollment.provisioning` (configuration) by default. */
  readonly method?: EnrollmentMethod;
  /**
   * The ways a person can hand the device an enrollment code while it waits, through `enroll`: typed
   * on it (`enrollment.input`). Declared in the manifest. A scanned one (`enrollment.qr`) needs a
   * camera that reads QR codes: give a `scanner`.
   */
  readonly accepts?: readonly "enrollment.input"[];
  /** The camera that reads pairing URIs from QR codes while the device waits: declares `enrollment.qr`. */
  readonly scanner?: QrScanner | undefined;
  /**
   * Say the device code with the bundled voice, on the speaker the core's voice plays on (needs
   * `audio.playback` and a `WebRtc` with a `speaker`). By default, when the device has a speaker and
   * no `display`; never when `speak` is given.
   */
  readonly voice?: boolean;
  /** Delay between polls while waiting for a proof (about a second). */
  readonly pollMs?: number;
}

export interface SatelliteOptions {
  /** The core's voice server, e.g. `http://nestor.local:7860`. */
  readonly core: string;
  /** What the device is and can do; its `pairing_methods` are set from `pairing`. */
  readonly manifest: Manifest;
  readonly tokens: TokenStore;
  readonly webrtc: WebRtc;
  readonly body?: Body;
  readonly pairing?: PairingSetup;
  /** The language of what the device says to people (`fr`, `en-GB`…); by default the platform's. */
  readonly locale?: string | readonly string[];
  /** STUN/TURN URLs, only needed beyond the local network. */
  readonly iceServers?: readonly string[];
  /** First and longest delay between connection attempts. */
  readonly backoffMs?: readonly [number, number];
  /** A connection not welcomed within this delay is dropped and tried again. */
  readonly welcomeTimeoutMs?: number;
  readonly fetch?: Fetch;
  readonly logger?: Logger;
}

/** The pairing methods a driver supports, from what it provides; `voiced`: the bundled voice says the code. */
export function pairingMethods(setup: PairingSetup = {}, voiced = false): PairingMethod[] {
  const accepts: readonly string[] = setup.accepts ?? [];
  if (accepts.some((method) => method !== "enrollment.input")) {
    throw new ProtocolError("pairing.accepts takes enrollment.input; a scanned code needs pairing.scanner");
  }
  const provided = new Set<PairingMethod>(["enrollment.provisioning", ...(setup.accepts ?? [])]);
  if (setup.display) provided.add("device_code.display");
  if (setup.speak || voiced) provided.add("device_code.speech");
  if (setup.scanner) provided.add("enrollment.qr");
  return PAIRING_METHODS.filter((method) => provided.has(method));
}

export class Satellite {
  readonly core: string;
  /** The manifest sent: the one given, with the pairing methods this satellite supports. */
  readonly manifest: Manifest;
  readonly messages: Messages;
  /** The last welcome: what the household allowed this device to do. */
  welcome: Welcome | null = null;
  /** Connections made since `run` started (answered offers). */
  connections = 0;

  private readonly options: SatelliteOptions;
  private readonly body: Body;
  private readonly logger: Logger;
  private readonly http: Fetch;
  private readonly pairing: Pairing;
  private peer: Peer | null = null;
  private running = false;
  private paired = false;

  constructor(options: SatelliteOptions) {
    this.options = options;
    this.core = options.core.replace(/\/+$/, "");
    const setup = options.pairing ?? {};
    this.body = options.body ?? {};
    this.logger = options.logger ?? quietLogger;
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.messages = new Messages(options.locale);
    const voice = this.voice(setup);
    this.manifest = options.manifest.withPairingMethods(pairingMethods(setup, voice !== undefined));
    const identify = this.body.identify?.bind(this.body);
    if (this.manifest.has(IDENTIFY) && identify === undefined) {
      throw new ProtocolError(`${IDENTIFY} is declared but the body has no identify()`);
    }
    if (identify !== undefined && !this.manifest.has(IDENTIFY)) {
      this.logger.warn(`the body can identify the device: declare ${IDENTIFY} so that the core asks it to`);
    }
    this.pairing = new Pairing({
      core: this.core,
      manifest: this.manifest,
      outputs: { display: setup.display, speak: setup.speak, voice },
      identify: this.manifest.has(IDENTIFY) ? identify : undefined,
      enrollment: setup.enrollment,
      messages: this.messages,
      store: options.tokens,
      fetch: this.http,
      logger: this.logger,
      ...(setup.method === undefined ? {} : { method: setup.method }),
      ...(setup.pollMs === undefined ? {} : { pollMs: setup.pollMs }),
    });
  }

  /** The bundled voice, when it says the device code: a speaker, and neither `speak` nor (by default) a screen. */
  private voice(setup: PairingSetup): SpokenCode | undefined {
    const { manifest, webrtc } = this.options;
    const speaker = manifest.has(AUDIO_PLAYBACK) ? webrtc.speaker : undefined;
    if (setup.voice === true && speaker === undefined) {
      throw new ProtocolError(`pairing.voice needs ${AUDIO_PLAYBACK} declared and a speaker`);
    }
    const wanted = setup.speak === undefined && (setup.voice ?? setup.display === undefined);
    return wanted && speaker !== undefined
      ? new SpokenCode(speaker, this.messages, { logger: this.logger })
      : undefined;
  }

  /** Whether the satellite waits for a person to pair it (its device code was presented). */
  get pending(): boolean {
    return this.pairing.pending;
  }

  /**
   * Hand in an enrollment code or a pairing URI a person typed (`enrollment.input`, declared in
   * `pairing.accepts`) or scanned (`enrollment.qr`). While the satellite waits to be paired, it is
   * sent at once; before `run`, with the first request. Resolves with what the core made of it.
   */
  enroll(text: string, method: EnrollmentMethod = "enrollment.input"): Promise<EnrollOutcome> {
    if (!this.manifest.pairingMethods.includes(method)) {
      const how = method === "enrollment.qr" ? "give a pairing.scanner" : "list it in pairing.accepts";
      throw new ProtocolError(`${method} is not declared: ${how}`);
    }
    if (this.paired && !this.pairing.running) {
      this.logger.info(this.messages.format("enrollment-not-pending"));
      return Promise.resolve({ status: "not_pending" });
    }
    return this.pairing.enroll(text, method);
  }

  /** Whether a connection is up and welcomed. */
  get connected(): boolean {
    return this.peer !== null && this.welcome !== null;
  }

  /**
   * Run until `signal` aborts: pair when needed, connect, and reconnect with a growing delay.
   * Rejects only when the audio devices cannot open (a declared microphone that is missing), or with
   * a `PairingError` when the core will never pair it (another protocol version).
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
          if (error instanceof PairingError) throw error;
          if (error instanceof Refused) {
            this.logger.warn(this.messages.format("token-refused"));
            this.paired = false;
            await this.options.tokens.forget();
            continue;
          }
          this.logger.warn(this.messages.format("link-failed", { error: describe(error) }));
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
    const { tokens } = this.options;
    const device = this.manifest.device.id;
    const saved = await tokens.load(this.core, device);
    if (saved === null) {
      const scanning = this.scan();
      try {
        const { token } = await this.pairing.run(signal);
        await tokens.save(this.core, device, token);
        this.paired = true;
        return token;
      } finally {
        scanning?.abort();
      }
    }
    this.paired = true;
    this.pairing.discard();
    return saved;
  }

  /** Read QR codes while pairing, if the device can: each new enrollment code is handed in. */
  private scan(): AbortController | null {
    const scanner = this.options.pairing?.scanner;
    if (scanner === undefined) return null;
    const stop = new AbortController();
    let last: string | null = null;
    const found = (text: string) => {
      const read = readEnrollment(text);
      if (read === null) {
        this.logger.debug("a QR code that holds no enrollment code");
        return;
      }
      if (read.code === last) return; // the camera sees it in every frame
      last = read.code;
      this.pairing.enroll(text, "enrollment.qr").then(
        (outcome) => this.logger.debug(`scanned enrollment code: ${outcome.status}`),
        (error: unknown) => this.logger.warn(`a scanned enrollment code failed: ${describe(error)}`),
      );
    };
    scanner.scan(found, stop.signal).catch((error: unknown) => {
      if (!stop.signal.aborted) this.logger.warn(this.messages.format("camera-failed", { error: describe(error) }));
    });
    return stop;
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
