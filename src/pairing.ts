/**
 * Pairing (`nestor.satellite/1`, rules P1 to P7): get a token from the core with either proof.
 *
 *     POST /satellites/pairings                         manifest [+ enrollment code] → ticket
 *     POST /satellites/pairings/{pairing_id}/enrollment enrollment code              → state
 *     GET  /satellites/pairings/{pairing_id}                                         → state
 *
 * With an enrollment code (configured, typed or scanned), the device sends it with its request and is
 * approved at once. Without one, it presents the device code the core gives it, on every output it
 * has (screen, voice) and always in its log, then polls until a person types that code in the admin.
 * While it waits it still takes an enrollment code at any time: whichever proof the core accepts
 * first wins. A refused enrollment code is never presented again, even after a restart (its hash is
 * kept in the device's `TokenStore`); the device falls back to a device code. On `429` it waits as
 * long as the core asks.
 */

import { groupEnrollmentCode, readEnrollment } from "./codes.js";
import { Messages } from "./i18n.js";
import { describe, type Logger, quietLogger } from "./log.js";
import { type EnrollmentMethod, type Manifest, ProtocolError } from "./protocol.js";
import { hashEnrollmentCode, type TokenStore } from "./tokens.js";
import {
  enrollmentProof,
  type PairingErrorBody,
  type PairingTicket,
  pairingRequest,
  parseError,
  parseState,
  parseTicket,
  type RefusalReason,
} from "./wire.js";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The core answered with an unexpected HTTP status, or could not be read: worth trying again later. */
export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Pairing cannot go on, and trying again would not help (the core speaks another protocol version,
 * or refuses the request as malformed). The message is translated, for people; `detail` is the
 * core's English explanation, for logs.
 */
export class PairingError extends Error {
  override name = "PairingError";
  constructor(
    readonly code: "protocol_unsupported" | "invalid_request",
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/** Where a device presents its device code. Each output declares a pairing method. */
export interface PairingOutputs {
  /**
   * Show `text` on the device's screen, with the device code when there is one (`null`: a message
   * alone, such as "Paired with Nestor." once the code is no longer needed). Declares
   * `device_code.display`.
   */
  readonly display?: ((code: string | null, text: string) => void) | undefined;
  /** Say `text` aloud, in the device's voice. Declares `device_code.speech`. */
  readonly speak?: ((text: string) => void) | undefined;
  /**
   * Say the device code with the bundled voice (`SpokenCode`), when there is no `speak`: a new code
   * replaces the one being said, and it stops once pairing ends. Declares `device_code.speech`.
   */
  readonly voice?: CodeVoice | undefined;
}

/** What says a device code aloud by itself (`SpokenCode`). */
export interface CodeVoice {
  say(code: string): void;
  stop(): void;
}

/** What the core said when it handed out the token. */
export interface Paired {
  readonly token: string;
  readonly deviceId: string | null;
  readonly room: string | null;
  readonly capabilities: ReadonlySet<string> | null;
}

/** What became of an enrollment code handed in with `enroll`. */
export type EnrollOutcome =
  /** The core accepted it: the token follows. */
  | { readonly status: "approved" }
  /** The core refused it, or refused it earlier: it is never presented again. */
  | { readonly status: "refused"; readonly reason: RefusalReason }
  /** The device no longer waits for a proof (paired already, or its device code won). */
  | { readonly status: "not_pending" }
  /** Not an enrollment code (nor a pairing URI): nothing was sent. */
  | { readonly status: "invalid" };

export interface PairingOptions {
  /** The core's base URL, e.g. `http://nestor.local:8471`. */
  readonly core: string;
  /** Sent with each request; its `pairing_methods` must match what this pairing can do. */
  readonly manifest: Manifest;
  readonly outputs?: PairingOutputs;
  /** Make the device noticed for a few seconds (needs `device.identify` declared). */
  readonly identify?: (() => void) | undefined;
  /** An enrollment code or pairing URI a person configured: sent with the first request. */
  readonly enrollment?: string | undefined;
  /** How `enrollment` reached the device; `enrollment.provisioning` by default. */
  readonly method?: EnrollmentMethod;
  readonly messages?: Messages;
  /** Where the refused enrollment codes are kept (hashed), so a restarted device never sends one again. */
  readonly store?: Pick<TokenStore, "refused" | "refuse"> | undefined;
  /** Delay between polls of a pending pairing (about a second). */
  readonly pollMs?: number;
  /** Each HTTP request fails after this delay. */
  readonly requestTimeoutMs?: number;
  readonly fetch?: Fetch;
  readonly logger?: Logger;
}

interface Proof {
  readonly code: string;
  /** Its SHA-256 hash, once computed: how refused codes are known. */
  hash: string | null;
  readonly method: EnrollmentMethod;
  /** The `enroll` call waiting for its outcome, if any. */
  readonly settle: ((outcome: EnrollOutcome) => void) | null;
  /** Not sent before this time (ms since the epoch): the core asked to wait. */
  notBefore: number;
}

type Answer =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: PairingErrorBody; readonly waitS: number };

/** The shortest wait after a `429`, whatever the core says, and the wait when it does not say. */
const MIN_WAIT_S = 1;
const DEFAULT_WAIT_S = 5;
const WAITS = { too_many_attempts: "too-many-attempts", too_many_pending: "too-many-pending" } as const;

/**
 * One device's pairing with one core. `run` resolves with the token; `enroll` hands in an
 * enrollment code at any time. Refused codes are remembered in the `store`, else for the life of this object.
 */
export class Pairing {
  readonly core: string;
  readonly manifest: Manifest;
  readonly messages: Messages;
  private readonly options: PairingOptions;
  private readonly logger: Logger;
  private readonly http: Fetch;
  private readonly proofs: Proof[] = [];
  /** Refused enrollment codes, by hash. */
  private readonly refused = new Map<string, RefusalReason>();
  private loaded: Promise<void> | null = null;
  private pendingId: string | null = null;
  private shown: string | null = null;
  private wake: (() => void) | null = null;
  /** An enrollment code was handed in since the last pause: the next one ends at once. */
  private handedIn = false;
  private active = false;

  constructor(options: PairingOptions) {
    this.options = options;
    this.core = options.core.replace(/\/+$/, "");
    this.manifest = options.manifest;
    this.messages = options.messages ?? new Messages();
    this.logger = options.logger ?? quietLogger;
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (options.enrollment !== undefined) {
      const read = readEnrollment(options.enrollment);
      if (read === null) throw new ProtocolError(this.messages.format("enrollment-invalid"));
      this.proofs.push({
        code: read.code,
        hash: null,
        method: options.method ?? "enrollment.provisioning",
        settle: null,
        notBefore: 0,
      });
    }
  }

  /** Whether `run` is under way. */
  get running(): boolean {
    return this.active;
  }

  /** Whether the core gave a device code and waits for a proof. */
  get pending(): boolean {
    return this.pendingId !== null;
  }

  /**
   * Hand in an enrollment code or a pairing URI a person typed (`enrollment.input`) or scanned
   * (`enrollment.qr`). Pending, it is sent at once; otherwise with the next request. Resolves
   * with what the core made of it.
   */
  enroll(text: string, method: EnrollmentMethod = "enrollment.input"): Promise<EnrollOutcome> {
    const read = readEnrollment(text);
    if (read === null) {
      this.logger.warn(this.messages.format("enrollment-invalid"));
      return Promise.resolve({ status: "invalid" });
    }
    if (read.core !== null && read.core !== this.core) {
      this.logger.debug(`the pairing URI names ${read.core}; sending its code to ${this.core}`);
    }
    return new Promise((settle) => {
      const proof: Proof = { code: read.code, hash: null, method, settle, notBefore: 0 };
      this.proofs.push(proof);
      this.handedIn = true;
      this.wake?.();
      void this.refusedBefore(proof); // settled at once when refused before, even with no pairing running
    });
  }

  /**
   * The device needs no pairing now (it has a token): the codes handed in with `enroll` are settled
   * as `not_pending`. A configured enrollment code is kept, for a pairing to come.
   */
  discard(): void {
    for (const proof of this.proofs.filter((p) => p.settle !== null)) {
      this.drop(proof);
      proof.settle?.({ status: "not_pending" });
    }
  }

  /** Pair until the core hands out a token. Rejects when `signal` aborts, or with a `PairingError`. */
  async run(signal?: AbortSignal): Promise<Paired> {
    if (this.active) throw new Error("this pairing is already running");
    this.active = true;
    try {
      await this.load();
      for (;;) {
        signal?.throwIfAborted();
        const proof = await this.nextProof(false);
        if (proof !== null) {
          this.logger.info(this.messages.format("enrollment-sent", { code: groupEnrollmentCode(proof.code) }));
        }
        const body = pairingRequest(this.manifest, proof === null ? null : enrollmentProof(proof.code, proof.method));
        const answer = await this.call("POST", "/satellites/pairings", body, signal);
        if (!answer.ok) {
          await this.refusedRequest(answer, proof, signal);
          continue;
        }
        if (proof !== null) this.drop(proof);
        const ticket = parseTicket(answer.data);
        if (ticket.status === "approved") proof?.settle?.({ status: "approved" });
        const paired = await this.wait(ticket, signal);
        if (paired !== null) {
          this.done();
          return paired;
        }
      }
    } finally {
      this.active = false;
      this.pendingId = null;
      this.options.outputs?.voice?.stop();
    }
  }

  /** A request the core turned down: wait, fall back, or give up. */
  private async refusedRequest(
    answer: Extract<Answer, { ok: false }>,
    proof: Proof | null,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const { error, waitS } = answer;
    switch (error.error) {
      case "too_many_attempts":
      case "too_many_pending":
        this.logger.warn(this.messages.format(WAITS[error.error], { seconds: waitS }));
        await sleep(waitS * 1000, signal); // the proof stays first in line
        return;
      case "enrollment_refused":
        if (proof === null) throw new HttpError(403, `pairing request: ${error.detail}`);
        await this.refuse(proof, error.reason ?? "unknown");
        return;
      default:
        throw this.fatal(error);
    }
  }

  /** Present the device code, if any, and poll until the token comes; `null` when the pairing ended without one. */
  private async wait(ticket: PairingTicket, signal: AbortSignal | undefined): Promise<Paired | null> {
    this.pendingId = ticket.status === "pending" ? ticket.pairingId : null;
    if (ticket.deviceCode !== null) this.present(ticket.deviceCode);
    try {
      for (;;) {
        if (this.pendingId !== null) await this.sendProofs(this.pendingId, signal);
        const answer = await this.call(
          "GET",
          `/satellites/pairings/${encodeURIComponent(ticket.pairingId)}`,
          null,
          signal,
        );
        if (!answer.ok) throw new HttpError(502, `pairing poll: ${answer.error.detail}`);
        const state = parseState(answer.data);
        if (state.identify) this.identify();
        if (state.status === "approved") {
          if (state.token === null) throw new HttpError(502, "the core approved the pairing without a token");
          return { token: state.token, deviceId: state.deviceId, room: state.room, capabilities: state.capabilities };
        }
        if (state.status !== "pending") {
          this.logger.info(this.messages.format("pairing-expired"));
          return null;
        }
        await this.pause(this.options.pollMs ?? 1000, signal);
      }
    } finally {
      this.pendingId = null;
    }
  }

  /** Send the enrollment codes handed in while pending, in order, until one is accepted. */
  private async sendProofs(pairingId: string, signal: AbortSignal | undefined): Promise<void> {
    for (let proof = await this.nextProof(true); proof !== null; proof = await this.nextProof(true)) {
      this.logger.info(this.messages.format("enrollment-sent", { code: groupEnrollmentCode(proof.code) }));
      const path = `/satellites/pairings/${encodeURIComponent(pairingId)}/enrollment`;
      const answer = await this.call("POST", path, enrollmentProof(proof.code, proof.method), signal);
      if (answer.ok) {
        this.drop(proof);
        proof.settle?.({ status: "approved" });
        return; // the next poll brings the token
      }
      const { error, waitS } = answer;
      switch (error.error) {
        case "too_many_attempts":
        case "too_many_pending":
          this.logger.warn(this.messages.format(WAITS[error.error], { seconds: waitS }));
          proof.notBefore = Date.now() + waitS * 1000; // keep polling meanwhile: the device code may win
          return;
        case "enrollment_refused":
          await this.refuse(proof, error.reason ?? "unknown");
          break;
        case "not_pending":
          // The device code won, or the pairing expired: the code is not spent, keep it for the next request.
          this.drop(proof);
          this.logger.info(this.messages.format("enrollment-not-pending"));
          proof.settle?.({ status: "not_pending" });
          this.proofs.push({ ...proof, settle: null, notBefore: 0 });
          return;
        default:
          throw this.fatal(error);
      }
    }
  }

  /** The first enrollment code to send (and that may be sent now, when `due`); refused ones are settled on the way. */
  private async nextProof(due: boolean): Promise<Proof | null> {
    for (const proof of [...this.proofs]) {
      if (await this.refusedBefore(proof)) continue;
      if (!this.proofs.includes(proof)) continue;
      if (due && proof.notBefore > Date.now()) return null;
      return proof;
    }
    return null;
  }

  private drop(proof: Proof): void {
    const index = this.proofs.indexOf(proof);
    if (index >= 0) this.proofs.splice(index, 1);
  }

  /** An enrollment code the core refused: never again, even after a restart; say so, then fall back to the device code. */
  private async refuse(proof: Proof, reason: RefusalReason): Promise<void> {
    this.drop(proof);
    const hash = proof.hash ?? (await hashEnrollmentCode(proof.code));
    this.refused.set(hash, reason);
    try {
      await this.options.store?.refuse(this.core, this.manifest.device.id, hash, reason);
    } catch (error) {
      this.logger.warn(`the refused enrollment code could not be saved: ${describe(error)}`);
    }
    this.tell(this.messages.format("enrollment-refused", { reason, code: groupEnrollmentCode(proof.code) }));
    proof.settle?.({ status: "refused", reason });
  }

  /** A refused enrollment code, in the log and on the outputs, with what the device does instead. */
  private tell(refusal: string): void {
    this.logger.warn(`${refusal} ${this.messages.format("enrollment-fallback")}`);
    const { display, speak } = this.options.outputs ?? {};
    if (display) {
      const text = this.shown === null ? refusal : `${refusal} ${this.messages.format("device-code-display")}`;
      this.output(() => display(this.shown, text));
    }
    if (speak) this.output(() => speak(refusal));
  }

  /**
   * Whether `proof` was refused before (by now, or before the device restarted): it is then dropped
   * and settled, and the device says so (P5); a configured one falls back to the device code.
   */
  private async refusedBefore(proof: Proof): Promise<boolean> {
    proof.hash ??= await hashEnrollmentCode(proof.code);
    await this.load();
    const reason = this.refused.get(proof.hash);
    if (reason === undefined) return false;
    if (!this.proofs.includes(proof)) return true; // settled already
    this.drop(proof);
    const text = this.messages.format("enrollment-already-refused", { code: groupEnrollmentCode(proof.code) });
    if (proof.settle === null) this.tell(text);
    else this.logger.warn(text);
    proof.settle?.({ status: "refused", reason });
    return true;
  }

  /** The refused codes kept in the store, once. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const kept = await this.options.store?.refused(this.core, this.manifest.device.id);
        for (const [hash, reason] of Object.entries(kept ?? {})) this.refused.set(hash, reason);
      } catch (error) {
        this.logger.warn(`the refused enrollment codes could not be read: ${describe(error)}`);
      }
    })();
    return this.loaded;
  }

  /** P2: on every output the device has, and always in its log. */
  private present(code: string): void {
    const { display, speak, voice } = this.options.outputs ?? {};
    this.shown = code;
    this.logger.warn(this.messages.format("device-code-log", { code }));
    if (display) this.output(() => display(code, this.messages.format("device-code-display")));
    if (speak) this.output(() => speak(this.messages.format("device-code-speech", { digits: [...code].join(", ") })));
    else if (voice) this.output(() => voice.say(code));
    if (!display && !speak && !voice) this.logger.warn(this.messages.format("headless-hint"));
  }

  /** Paired: stop presenting the code; settle the codes handed in too late. */
  private done(): void {
    const { display } = this.options.outputs ?? {};
    const text = this.messages.format("paired");
    this.logger.info(text);
    if (display && this.shown !== null) this.output(() => display(null, text));
    this.shown = null;
    for (const proof of this.proofs.splice(0)) proof.settle?.({ status: "not_pending" });
  }

  private identify(): void {
    this.logger.info(this.messages.format("identify"));
    this.output(() => this.options.identify?.());
  }

  /** An output is the driver's: a failing one is logged, never allowed to stop the pairing. */
  private output(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.logger.warn(`a pairing output failed: ${describe(error)}`);
    }
  }

  private fatal(error: PairingErrorBody): Error {
    if (error.error === "protocol_unsupported" || error.error === "invalid_request") {
      const id = error.error === "protocol_unsupported" ? "protocol-unsupported" : "invalid-request";
      this.logger.debug(`the core says: ${error.detail}`);
      return new PairingError(error.error, this.messages.format(id), error.detail);
    }
    return new HttpError(502, `unexpected pairing answer ${error.error}: ${error.detail}`);
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Answer> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000);
    const response = await this.http(`${this.core}${path}`, {
      method,
      ...(body === null ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // not JSON: judged by its status below
    }
    if (response.ok) return { ok: true, data };
    const error = parseError(data);
    if (response.status === 429) {
      const header = Number.parseFloat(response.headers.get("retry-after") ?? "");
      const said = [header, error?.retryAfterS ?? Number.NaN].filter(Number.isFinite);
      const waitS = Math.max(MIN_WAIT_S, ...(said.length > 0 ? said : [DEFAULT_WAIT_S]));
      const code = error?.error === "too_many_pending" ? "too_many_pending" : "too_many_attempts";
      return { ok: false, error: error ?? { error: code, detail: "", reason: null, retryAfterS: null }, waitS };
    }
    if (error === null) {
      const detail = isRecord(data) && typeof data.detail === "string" ? ` ${data.detail}` : "";
      throw new HttpError(response.status, `${method} ${path}: HTTP ${response.status}${detail}`);
    }
    return { ok: false, error, waitS: 0 };
  }

  /** Wait between polls; an enrollment code handed in (even during the poll before) ends the wait at once. */
  private pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (this.handedIn) {
        this.handedIn = false;
        resolve();
        return;
      }
      const finish = (then: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.wake = null;
        this.handedIn = false;
        then();
      };
      const aborted = () => finish(() => reject(signal?.reason));
      const timer = setTimeout(() => finish(resolve), ms);
      this.wake = () => finish(resolve);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Waits `ms`; rejects with the signal's reason when it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
