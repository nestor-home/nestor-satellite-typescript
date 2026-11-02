/**
 * A satellite's life: pair once, then hold its link to the core, reconnecting when it drops.
 *
 *     const satellite = new Satellite({ core: "http://nestor.local:8471", manifest, tokens, text, voice, body });
 *     await satellite.run(signal); // until the signal aborts
 *
 * Pairing (`./pairing.ts`) uses the enrollment code it was configured with, else presents its device
 * code on the outputs it was given (`pairing.display`, `pairing.speak`) and in its log. A device with
 * a voice that has a speaker and no screen says its code with the bundled voice. While it waits, a
 * `pairing.scanner` reads enrollment codes from QR codes. The manifest's `pairing_methods` follow
 * from all this: `enrollment.provisioning` always, the others when the device can.
 *
 * The link is a WebSocket (`./link.ts`): `hello` with the manifest and the token, `welcome` back, then
 * intents (acknowledged), the assistant's words, typed text and observations. A refused token (4401)
 * is forgotten and the device pairs again; a link replaced by a newer one (4409) stops the satellite;
 * any other end reconnects, waiting longer each time.
 *
 * The capabilities follow from what the driver provides: a `text.display` callback declares
 * `text.display`, `text.input` declares `text.input`, a `voice` declares `audio.capture` and
 * `audio.playback` as it can. Only once welcomed with audio allowed does the voice open the
 * microphone and offer WebRTC (`POST /satellites/{device_id}/audio`); pairing and the link never wait
 * for it, and failed audio is offered again while the link is up.
 */

import type { MediaNeeds, Peer, SessionDescription, Voice } from "./audio.js";
import type { Body } from "./body.js";
import { readEnrollment } from "./codes.js";
import { Dispatcher, type TextDisplay } from "./dispatch.js";
import { Messages } from "./i18n.js";
import { LINK_CLOSE, linkUrl, OPEN, platformWebSocket, type WebSocketConstructor } from "./link.js";
import { describe, type Logger, quietLogger } from "./log.js";
import {
  type CodeVoice,
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
  capability,
  type EnrollmentMethod,
  IDENTIFY,
  Manifest,
  PAIRING_METHODS,
  type PairingMethod,
  PERSON_DETECTION,
  ProtocolError,
  SPEECH_ACTIVITY,
  TEXT_DISPLAY,
  TEXT_INPUT,
} from "./protocol.js";
import type { TokenStore } from "./tokens.js";
import { hello, personDetected, type SatelliteMessage, speechActivity, textInput, type Welcome } from "./wire.js";

/** An observation the device did not declare, or the household did not allow. */
export class CapabilityNotAllowed extends ProtocolError {
  override name = "CapabilityNotAllowed";
}

/** A newer link of this device replaced this one (closed with 4409): the other one is current. */
export class LinkReplaced extends Error {
  override name = "LinkReplaced";
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
   * Say the device code with the bundled voice, on the speaker the core's voice plays on (needs a
   * `voice` with a speaker). By default, when the device has a speaker and no `display`; never when
   * `speak` is given.
   */
  readonly voice?: boolean;
  /** Delay between polls while waiting for a proof (about a second). */
  readonly pollMs?: number;
}

/** How the device talks with the assistant in writing. */
export interface TextSetup {
  /** Shows the assistant's words, in order; `final` marks the last message of a turn. Declares `text.display`. */
  readonly display?: TextDisplay | undefined;
  /** A person can type to the assistant on the device, through `sendText`. Declares `text.input`. */
  readonly input?: boolean;
}

export interface SatelliteOptions {
  /** The core's device server, e.g. `http://nestor.local:8471`. */
  readonly core: string;
  /**
   * What the device is and can do. Its `pairing_methods` are set from `pairing`, its `text.*` and
   * `audio.*` capabilities from `text` and `voice`.
   */
  readonly manifest: Manifest;
  readonly tokens: TokenStore;
  readonly body?: Body;
  readonly pairing?: PairingSetup;
  /** Writing: the assistant's words shown, text typed. */
  readonly text?: TextSetup;
  /** Talking aloud: `browserVoice()` (`@nestor-home/satellite/voice`) or `nodeVoice()` (`/node`). */
  readonly voice?: Voice;
  /** The language of what the device says to people (`fr`, `en-GB`…); by default the platform's. */
  readonly locale?: string | readonly string[];
  /** First and longest delay between attempts (link and audio). */
  readonly backoffMs?: readonly [number, number];
  /** A link not welcomed within this delay is closed and tried again. */
  readonly welcomeTimeoutMs?: number;
  readonly fetch?: Fetch;
  /** The link's WebSocket; the platform's by default (browsers, Node 22 and later). */
  readonly webSocket?: WebSocketConstructor;
  readonly logger?: Logger;
}

/** The capabilities what the driver provides stands for, and what each needs. */
const PROVIDED = [
  [TEXT_INPUT, "text.input: true"],
  [TEXT_DISPLAY, "a text.display callback"],
  [AUDIO_CAPTURE, "a voice with a microphone"],
  [AUDIO_PLAYBACK, "a voice with a speaker"],
] as const;

/** The manifest with the `text.*` and `audio.*` capabilities the driver provides; one it does not is refused. */
export function providedCapabilities(manifest: Manifest, text: TextSetup = {}, voice?: Voice): Manifest {
  const has: Record<(typeof PROVIDED)[number][0], boolean> = {
    [TEXT_INPUT]: text.input === true,
    [TEXT_DISPLAY]: text.display !== undefined,
    [AUDIO_CAPTURE]: voice?.capture === true,
    [AUDIO_PLAYBACK]: voice?.playback === true,
  };
  const added = [];
  for (const [name, needs] of PROVIDED) {
    if (manifest.has(name) && !has[name]) throw new ProtocolError(`${name} is declared: it needs ${needs}`);
    if (has[name] && !manifest.has(name)) added.push(capability(name));
  }
  if (added.length === 0) return manifest;
  return new Manifest(manifest.device, [...manifest.capabilities, ...added], {
    sdk: manifest.sdk,
    pairingMethods: manifest.pairingMethods,
  });
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
  /** The manifest sent: the one given, with the capabilities and pairing methods the driver provides. */
  readonly manifest: Manifest;
  readonly messages: Messages;
  /** The last welcome: what the household allowed this device to do. */
  welcome: Welcome | null = null;
  /** Links opened since `run` started. */
  connections = 0;
  /** Audio connections answered since `run` started. */
  audioConnections = 0;

  private readonly options: SatelliteOptions;
  private readonly body: Body;
  private readonly logger: Logger;
  private readonly http: Fetch;
  private readonly pairing: Pairing;
  private readonly backoff: readonly [number, number];
  /** Sends on the welcomed link; `null` while there is none. */
  private sender: ((message: SatelliteMessage) => boolean) | null = null;
  private running = false;
  private paired = false;

  constructor(options: SatelliteOptions) {
    this.options = options;
    this.core = options.core.replace(/\/+$/, "");
    const setup = options.pairing ?? {};
    this.body = options.body ?? {};
    this.logger = options.logger ?? quietLogger;
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.backoff = options.backoffMs ?? [500, 30_000];
    this.messages = new Messages(options.locale);
    const manifest = providedCapabilities(options.manifest, options.text, options.voice);
    const voice = this.codeVoice(setup);
    this.manifest = manifest.withPairingMethods(pairingMethods(setup, voice !== undefined));
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
  private codeVoice(setup: PairingSetup): CodeVoice | undefined {
    const { voice } = this.options;
    const wanted = setup.speak === undefined && (setup.voice ?? setup.display === undefined);
    const spoken = wanted && voice?.playback ? voice.codeVoice?.(this.messages, this.logger) : undefined;
    if (setup.voice === true && spoken === undefined) {
      throw new ProtocolError("pairing.voice needs a voice with a speaker");
    }
    return spoken;
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

  /** Whether the link is up and welcomed. */
  get connected(): boolean {
    return this.sender !== null && this.welcome !== null;
  }

  /**
   * Run until `signal` aborts: pair when needed, hold the link, and reconnect with a growing delay.
   * Rejects with a `PairingError` when the core will never pair the device (another protocol
   * version), and with `LinkReplaced` when a newer link of this device took over.
   */
  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("this satellite is already running");
    this.running = true;
    const [first, longest] = this.backoff;
    try {
      let delay = first;
      while (!signal?.aborted) {
        let welcomed = false;
        try {
          const closed = await this.linkOnce(await this.token(signal), signal);
          welcomed = closed.welcomed;
          if (signal?.aborted) break;
          if (closed.code === LINK_CLOSE.tokenRefused) {
            this.logger.warn(this.messages.format("token-refused"));
            this.paired = false;
            await this.options.tokens.forget();
            continue;
          }
          if (closed.code === LINK_CLOSE.replaced) throw new LinkReplaced(this.messages.format("link-replaced"));
          const why = `closed with ${closed.code}${closed.reason ? `: ${closed.reason}` : ""}`;
          if (closed.code === LINK_CLOSE.stopping) this.logger.info(`link ${why}, reconnecting`);
          else this.logger.warn(this.messages.format("link-failed", { error: why }));
        } catch (error) {
          if (signal?.aborted) break;
          if (error instanceof PairingError || error instanceof LinkReplaced) throw error;
          this.logger.warn(this.messages.format("link-failed", { error: describe(error) }));
        }
        delay = welcomed ? first : Math.min(delay * 2, longest);
        try {
          await sleep(delay, signal);
        } catch {
          break;
        }
      }
    } finally {
      this.running = false;
      await this.options.voice
        ?.close()
        .catch((error: unknown) => this.logger.debug(`closing the voice: ${describe(error)}`));
    }
  }

  /**
   * Send what a person typed on the device (`text.input`, declared and allowed): a turn of the
   * conversation of its room. `false` when the link is down (text is not queued).
   */
  sendText(text: string): boolean {
    this.allowed(TEXT_INPUT, "typed text");
    const message = textInput(text);
    return this.sender?.(message) ?? false;
  }

  /** Report people seen now; `false` when not connected (observations are not queued). */
  personDetected(count: number, confidence: number): boolean {
    this.allowed(PERSON_DETECTION, "this observation");
    const message = personDetected(count, confidence);
    return this.sender?.(message) ?? false;
  }

  /** Report that voice activity started or stopped on the device. */
  speechActivity(active: boolean): boolean {
    this.allowed(SPEECH_ACTIVITY, "this observation");
    const message = speechActivity(active);
    return this.sender?.(message) ?? false;
  }

  private allowed(capability: string, what: string): void {
    const allowed = this.welcome?.capabilities ?? this.manifest.names;
    if (!this.manifest.has(capability) || !allowed.has(capability)) {
      throw new CapabilityNotAllowed(`${what} needs the ${capability} capability, declared and allowed`);
    }
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

  /** One link, until it closes: its close code, and whether it was welcomed. */
  private async linkOnce(
    token: string,
    signal: AbortSignal | undefined,
  ): Promise<{ code: number; reason: string; welcomed: boolean }> {
    const Socket = this.options.webSocket ?? platformWebSocket();
    if (Socket === undefined) throw new Error("this platform has no WebSocket");
    const { welcomeTimeoutMs = 15_000 } = this.options;
    let end: (code: number, reason: string) => void = () => {};
    const ended = new Promise<{ code: number; reason: string }>((resolve) => {
      end = (code, reason) => resolve({ code, reason });
    });
    let welcomed = false;
    const audio = new AbortController();
    let audioDone: Promise<void> = Promise.resolve();
    const socket = new Socket(linkUrl(this.core, this.manifest.device.id));
    const send = (message: SatelliteMessage) => {
      if (socket.readyState !== OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    };
    const dispatcher = new Dispatcher(this.body, send, this.logger, this.options.text?.display);
    socket.onopen = () => {
      this.connections += 1;
      send(hello(this.manifest, token));
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        this.logger.warn("ignoring a binary message on the link");
        return;
      }
      if (dispatcher.handle(event.data) !== "welcomed") return;
      this.welcome = dispatcher.welcome;
      if (welcomed) return;
      welcomed = true;
      this.sender = send;
      this.logger.info(`welcomed in ${this.welcome?.room ?? "?"}`);
      this.call(() => this.body.connected?.(true));
      const needs = this.audioNeeds();
      if (needs !== null) {
        audioDone = this.audio(token, needs, audio.signal, () => {
          end(LINK_CLOSE.tokenRefused, "the audio offer's token was refused");
        });
      }
    };
    socket.onclose = (event) => end(event.code, event.reason);
    socket.onerror = () => {}; // the close that follows says why
    const stop = () => end(1000, "stopped");
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => welcomed || end(0, `not welcomed within ${welcomeTimeoutMs} ms`), welcomeTimeoutMs);
    try {
      const closed = await ended;
      return { ...closed, welcomed };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      socket.onopen = socket.onmessage = socket.onclose = null;
      if (socket.readyState <= OPEN) socket.close(1000);
      this.sender = null;
      audio.abort();
      await audioDone;
      if (welcomed) this.call(() => this.body.connected?.(false));
    }
  }

  /** What the voice opens, from what the welcome allowed; `null` for no audio at all (A1). */
  private audioNeeds(): MediaNeeds | null {
    const { voice } = this.options;
    const allowed = this.welcome?.capabilities;
    if (voice === undefined || allowed === undefined) return null;
    const needs = {
      capture: voice.capture && allowed.has(AUDIO_CAPTURE),
      playback: voice.playback && allowed.has(AUDIO_PLAYBACK),
    };
    return needs.capture || needs.playback ? needs : null;
  }

  /** Audio while the link is up: offered, and offered again with a growing delay when it fails (A3). */
  private async audio(token: string, needs: MediaNeeds, stop: AbortSignal, refused: () => void): Promise<void> {
    const voice = this.options.voice as Voice;
    const [first, longest] = this.backoff;
    let delay = first;
    while (!stop.aborted) {
      let peer: Peer | null = null;
      let finish: (reason: string) => void = () => {};
      const over = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const linkEnded = () => finish("the link ended");
      stop.addEventListener("abort", linkEnded, { once: true });
      try {
        await voice.open(needs);
        stop.throwIfAborted();
        peer = await voice.createPeer({
          events: { onClosed: (reason) => finish(reason), onAudio: () => this.call(() => this.body.heartbeat?.()) },
        });
        await peer.accept(await this.offerAudio(await peer.offer(), token, stop));
        this.audioConnections += 1;
        delay = first;
        this.logger.info("audio connected");
        const reason = await over;
        if (!stop.aborted) this.logger.warn(this.messages.format("audio-failed", { error: reason }));
      } catch (error) {
        if (stop.aborted) break;
        if (error instanceof Refused) {
          refused();
          break;
        }
        this.logger.warn(this.messages.format("audio-failed", { error: describe(error) }));
      } finally {
        stop.removeEventListener("abort", linkEnded);
        await peer?.close();
        await voice.close().catch((error: unknown) => this.logger.debug(`closing the voice: ${describe(error)}`));
      }
      try {
        await sleep(delay, stop);
      } catch {
        break;
      }
      delay = Math.min(delay * 2, longest);
    }
  }

  private async offerAudio(offer: SessionDescription, token: string, signal: AbortSignal): Promise<SessionDescription> {
    const response = await this.http(`${this.core}/satellites/${encodeURIComponent(this.manifest.device.id)}/audio`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
      signal,
    });
    if (response.status === 401) throw new Refused("token refused");
    if (!response.ok) throw new HttpError(response.status, `audio offer: HTTP ${response.status}`);
    const answer: unknown = await response.json();
    if (
      typeof answer !== "object" ||
      answer === null ||
      !("sdp" in answer) ||
      typeof answer.sdp !== "string" ||
      !("type" in answer) ||
      answer.type !== "answer"
    ) {
      throw new HttpError(502, "audio offer: the core did not answer with an SDP answer");
    }
    return { sdp: answer.sdp, type: "answer" };
  }

  /** A failing body is the driver's bug: it is logged, never allowed to break the link. */
  private call(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.logger.warn(`the body failed: ${describe(error)}`);
    }
  }
}
