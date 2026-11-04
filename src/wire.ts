/**
 * What a satellite and the core say to each other.
 *
 * Messages on the link, a WebSocket: one JSON envelope `{type, id, at, payload}` per text frame.
 *
 * The satellite sends `hello` (its manifest and token) first, then `ack`s, observations, typed text
 * and `update.status`; the core sends `welcome` and `intent.*`. Reading is strict about the messages this SDK knows (a malformed one is a
 * `ProtocolError`) and lenient about the ones it does not: an unknown type from a newer core is
 * returned as `null`, so it never breaks an older driver.
 *
 * Bodies of the pairing endpoints (`pairing.*` schemas): requests and proofs the satellite sends,
 * tickets, states and errors it reads. And the core's answer to an audio offer.
 */

import {
  BEHAVIORS,
  type Behavior,
  type EnrollmentMethod,
  EXPRESSIONS,
  type Expression,
  type Manifest,
  type ManifestJson,
  ProtocolError,
} from "./protocol.js";

const MAX_ID = 64;
const MAX_VERSION = 64;
/** `input.text`: what a person typed, 1 to 4,000 characters. */
export const MAX_INPUT_TEXT = 4000;
/** `intent.text`: the assistant's words, up to 16,000 characters. */
export const MAX_SHOWN_TEXT = 16_000;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

export interface Envelope<Type extends string, Payload> {
  readonly type: Type;
  readonly id: string;
  readonly at: string;
  readonly payload: Payload;
}

export type HelloMessage = Envelope<"hello", { readonly manifest: ManifestJson; readonly token: string }>;
export type AckMessage = Envelope<"ack", { readonly of: string }>;
export type PersonDetectedMessage = Envelope<
  "observation.person.detected",
  { readonly count: number; readonly confidence: number }
>;
export type SpeechActivityMessage = Envelope<"observation.speech.activity", { readonly active: boolean }>;
export type TextInputMessage = Envelope<"input.text", { readonly text: string }>;
/** Where the device's own software stands: `version` goes with every state but `current`. */
export const UPDATE_STATES = ["current", "available", "installing", "failed"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];
export type UpdateStatusMessage = Envelope<
  "update.status",
  { readonly state: "current" } | { readonly state: Exclude<UpdateState, "current">; readonly version: string }
>;
/** Everything a satellite sends. */
export type SatelliteMessage =
  | HelloMessage
  | AckMessage
  | PersonDetectedMessage
  | SpeechActivityMessage
  | TextInputMessage
  | UpdateStatusMessage;

/** A fresh message id: 32 hex characters (works outside secure contexts, unlike `randomUUID`). */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function envelope<Type extends string, Payload>(type: Type, payload: Payload): Envelope<Type, Payload> {
  return { type, id: newId(), at: new Date().toISOString(), payload };
}

/** The first message of a link: the manifest, and the token that proves the device was paired. */
export function hello(manifest: Manifest, token: string): HelloMessage {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) {
    throw new ProtocolError("a token is 1 to 128 characters");
  }
  return envelope("hello", { manifest: manifest.toJSON(), token });
}

export function ack(intentId: string): AckMessage {
  return envelope("ack", { of: intentId });
}

export function personDetected(count: number, confidence: number): PersonDetectedMessage {
  if (!Number.isInteger(count) || count < 0) {
    throw new ProtocolError(`a person count is a non-negative integer, not ${String(count)}`);
  }
  return envelope("observation.person.detected", { count, confidence: unit(confidence, "confidence") });
}

export function speechActivity(active: boolean): SpeechActivityMessage {
  if (typeof active !== "boolean") throw new ProtocolError("speech activity is true or false");
  return envelope("observation.speech.activity", { active });
}

/** What a person typed on the device: a turn of its room's conversation. */
export function textInput(text: string): TextInputMessage {
  const length = typeof text === "string" ? characters(text) : 0;
  if (length === 0 || length > MAX_INPUT_TEXT) {
    throw new ProtocolError(`typed text is 1 to ${MAX_INPUT_TEXT} characters, not ${length}`);
  }
  return envelope("input.text", { text });
}

/** Where the device's software stands (`device.update`): nothing newer, or `version` found, installing or failed. */
export function updateStatus(state: UpdateState, version?: string): UpdateStatusMessage {
  if (state === "current") {
    if (version !== undefined) throw new ProtocolError("update.status: no version goes with current");
    return envelope("update.status", { state });
  }
  if (!UPDATE_STATES.includes(state)) throw new ProtocolError(`update.status: unknown state ${JSON.stringify(state)}`);
  return envelope("update.status", { state, version: softwareVersion(version, `update.status.version`) });
}

function softwareVersion(version: unknown, where: string): string {
  if (typeof version !== "string" || version.length === 0 || version.length > MAX_VERSION) {
    throw new ProtocolError(`${where} must be 1 to ${MAX_VERSION} characters`);
  }
  return version;
}

/** Characters as JSON Schema counts them (code points), not UTF-16 units. */
function characters(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Answer to `hello`: where the device is and what the household allowed it to do. */
export interface Welcome {
  readonly type: "welcome";
  readonly deviceId: string;
  readonly room: string;
  readonly capabilities: ReadonlySet<string>;
}

export interface BehaviorIntent {
  readonly type: "intent.behavior";
  readonly behavior: Behavior;
}

export interface ExpressionIntent {
  readonly type: "intent.expression";
  readonly expression: Expression;
  /** 0 to 1; 1 when the core does not say. */
  readonly intensity: number;
}

export interface BeatIntent {
  readonly type: "intent.beat";
}

/** Make the device noticed for a few seconds, so a person tells it apart. Needs `device.identify`. */
export interface IdentifyIntent {
  readonly type: "intent.identify";
}

/** The assistant's words, to show. `final`: the last message of a turn. Needs `text.display`. */
export interface TextIntent {
  readonly type: "intent.text";
  readonly text: string;
  /** `true` when the core does not say. */
  readonly final: boolean;
}

/**
 * A person asks the device to install `version` of its software, and start again on it. Needs
 * `device.update`; the device installs it only when it is the newer version it found itself.
 */
export interface UpdateIntent {
  readonly type: "intent.update";
  readonly version: string;
}

export type Intent = BehaviorIntent | ExpressionIntent | BeatIntent | IdentifyIntent | TextIntent | UpdateIntent;
export type CoreMessage = Welcome | Intent;

export interface Received {
  readonly id: string;
  /** `null`: a message type this SDK does not know (sent by a newer core). */
  readonly message: CoreMessage | null;
}

/** Read a message from the core (already parsed from JSON). */
export function parse(data: unknown): Received {
  if (!isRecord(data)) throw new ProtocolError("a message is a JSON object");
  exactKeys(data, ["type", "id", "at", "payload"], ["type", "id", "at", "payload"], "message");
  const { type, id, at, payload } = data;
  if (typeof type !== "string") throw new ProtocolError("message type must be a string");
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID) {
    throw new ProtocolError(`message id must be 1 to ${MAX_ID} characters`);
  }
  if (typeof at !== "string" || !DATE_TIME.test(at) || Number.isNaN(Date.parse(at))) {
    throw new ProtocolError(`message time ${JSON.stringify(at)} is not an ISO 8601 date-time`);
  }
  if (!isRecord(payload)) throw new ProtocolError(`${type}: payload must be an object`);
  return { id, message: read(type, payload) };
}

function read(type: string, payload: Record<string, unknown>): CoreMessage | null {
  switch (type) {
    case "welcome": {
      exactKeys(payload, ["device_id", "room", "capabilities"], ["device_id", "room", "capabilities"], type);
      const { device_id, room, capabilities } = payload;
      if (typeof device_id !== "string" || typeof room !== "string") {
        throw new ProtocolError("welcome: device_id and room must be strings");
      }
      if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === "string")) {
        throw new ProtocolError("welcome: capabilities must be a list of strings");
      }
      return { type, deviceId: device_id, room, capabilities: new Set(capabilities) };
    }
    case "intent.behavior": {
      exactKeys(payload, ["behavior"], ["behavior"], type);
      return { type, behavior: member(BEHAVIORS, payload.behavior, `${type}.behavior`) };
    }
    case "intent.expression": {
      exactKeys(payload, ["expression", "intensity"], ["expression"], type);
      const expression = member(EXPRESSIONS, payload.expression, `${type}.expression`);
      const intensity = payload.intensity === undefined ? 1 : unit(payload.intensity, `${type}.intensity`);
      return { type, expression, intensity };
    }
    case "intent.text": {
      exactKeys(payload, ["text", "final"], ["text"], type);
      const { text, final } = payload;
      if (typeof text !== "string" || characters(text) === 0 || characters(text) > MAX_SHOWN_TEXT) {
        throw new ProtocolError(`${type}.text must be 1 to ${MAX_SHOWN_TEXT} characters`);
      }
      if (final !== undefined && typeof final !== "boolean") throw new ProtocolError(`${type}.final must be a boolean`);
      return { type, text, final: final ?? true };
    }
    case "intent.update":
      exactKeys(payload, ["version"], ["version"], type);
      return { type, version: softwareVersion(payload.version, `${type}.version`) };
    case "intent.beat":
    case "intent.identify":
      exactKeys(payload, [], [], type);
      return { type };
    default:
      return null;
  }
}

/** The core's answer to an audio offer (`POST /satellites/{device_id}/audio`); other fields are ignored. */
export function parseAudioAnswer(data: unknown): { readonly sdp: string; readonly type: "answer" } {
  const body = record(data, "audio answer");
  if (typeof body.sdp !== "string" || body.type !== "answer") {
    throw new ProtocolError("audio answer: the core did not answer with an SDP answer");
  }
  return { sdp: body.sdp, type: "answer" };
}

// Pairing bodies.

export const PAIRING_STATUSES = ["pending", "approved", "claimed", "expired"] as const;
export type PairingStatus = (typeof PAIRING_STATUSES)[number];
export const PAIRING_ERRORS = [
  "invalid_request",
  "protocol_unsupported",
  "too_many_pending",
  "too_many_attempts",
  "enrollment_refused",
  "not_pending",
] as const;
export type PairingErrorCode = (typeof PAIRING_ERRORS)[number];
/** Why an enrollment code pairs nothing. */
export const REFUSAL_REASONS = ["unknown", "expired", "used", "cancelled"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface EnrollmentProof {
  readonly enrollment_code: string;
  readonly method: EnrollmentMethod;
}

/** `POST /satellites/pairings`: the manifest, with the enrollment code the device was given, if any. */
export interface PairingRequest {
  readonly manifest: ManifestJson;
  readonly enrollment_code?: string;
  readonly method?: EnrollmentMethod;
}

export function pairingRequest(manifest: Manifest, proof: EnrollmentProof | null = null): PairingRequest {
  return proof === null ? { manifest: manifest.toJSON() } : { manifest: manifest.toJSON(), ...proof };
}

/** `POST /satellites/pairings/{pairing_id}/enrollment`: a pending device's enrollment code. */
export function enrollmentProof(code: string, method: EnrollmentMethod): EnrollmentProof {
  return { enrollment_code: code, method };
}

/** The answer to a pairing request. */
export interface PairingTicket {
  readonly pairingId: string;
  readonly status: PairingStatus;
  readonly expiresAt: string;
  /** The 6 digits to present, when the device is pending without a proof. */
  readonly deviceCode: string | null;
}

/** Where a pairing stands. */
export interface PairingState {
  readonly status: PairingStatus;
  /** Handed out once, with the first `approved` answer. */
  readonly token: string | null;
  readonly deviceId: string | null;
  readonly room: string | null;
  readonly capabilities: ReadonlySet<string> | null;
  /** A person asks the pending device to make itself noticed. */
  readonly identify: boolean;
}

/** An error answer of the pairing endpoints. `detail` is English, for logs only. */
export interface PairingErrorBody {
  readonly error: PairingErrorCode;
  readonly detail: string;
  readonly reason: RefusalReason | null;
  readonly retryAfterS: number | null;
}

export function parseTicket(data: unknown): PairingTicket {
  const body = record(data, "pairing.ticket");
  exactKeys(
    body,
    ["pairing_id", "status", "expires_at", "device_code"],
    ["pairing_id", "status", "expires_at"],
    "pairing.ticket",
  );
  const { pairing_id, status, expires_at, device_code } = body;
  if (typeof pairing_id !== "string" || pairing_id.length === 0) {
    throw new ProtocolError("pairing.ticket: pairing_id must be a string");
  }
  if (typeof expires_at !== "string" || Number.isNaN(Date.parse(expires_at))) {
    throw new ProtocolError("pairing.ticket: expires_at must be a date-time");
  }
  if (device_code !== undefined && (typeof device_code !== "string" || !/^\d{6}$/.test(device_code))) {
    throw new ProtocolError("pairing.ticket: device_code must be 6 digits");
  }
  return {
    pairingId: pairing_id,
    status: member(PAIRING_STATUSES, status, "pairing.ticket.status"),
    expiresAt: expires_at,
    deviceCode: device_code ?? null,
  };
}

export function parseState(data: unknown): PairingState {
  const body = record(data, "pairing.state");
  exactKeys(body, ["status", "token", "device_id", "room", "capabilities", "identify"], ["status"], "pairing.state");
  const { status, token, device_id, room, capabilities, identify } = body;
  if (token !== undefined && (typeof token !== "string" || token.length === 0)) {
    throw new ProtocolError("pairing.state: token must be a non-empty string");
  }
  for (const [name, value] of [
    ["device_id", device_id],
    ["room", room],
  ] as const) {
    if (value !== undefined && typeof value !== "string")
      throw new ProtocolError(`pairing.state: ${name} must be a string`);
  }
  if (
    capabilities !== undefined &&
    (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === "string"))
  ) {
    throw new ProtocolError("pairing.state: capabilities must be a list of strings");
  }
  if (identify !== undefined && identify !== true) throw new ProtocolError("pairing.state: identify is only ever true");
  return {
    status: member(PAIRING_STATUSES, status, "pairing.state.status"),
    token: (token as string | undefined) ?? null,
    deviceId: (device_id as string | undefined) ?? null,
    room: (room as string | undefined) ?? null,
    capabilities: capabilities === undefined ? null : new Set(capabilities as string[]),
    identify: identify === true,
  };
}

/** An error answer; `null` when the body is not one (a proxy's page, a crash). */
export function parseError(data: unknown): PairingErrorBody | null {
  try {
    const body = record(data, "pairing.error");
    exactKeys(body, ["error", "detail", "reason", "retry_after_s"], ["error", "detail"], "pairing.error");
    const { error, detail, reason, retry_after_s } = body;
    if (typeof detail !== "string") return null;
    if (retry_after_s !== undefined && (!Number.isInteger(retry_after_s) || (retry_after_s as number) < 0)) return null;
    return {
      error: member(PAIRING_ERRORS, error, "pairing.error.error"),
      detail,
      reason: reason === undefined ? null : member(REFUSAL_REASONS, reason, "pairing.error.reason"),
      retryAfterS: (retry_after_s as number | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

function record(data: unknown, where: string): Record<string, unknown> {
  if (!isRecord(data)) throw new ProtocolError(`${where}: expected a JSON object`);
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  where: string,
): void {
  const unexpected = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unexpected.length > 0) throw new ProtocolError(`${where}: unexpected ${unexpected.join(", ")}`);
  const missing = required.filter((k) => !(k in value));
  if (missing.length > 0) throw new ProtocolError(`${where}: missing ${missing.join(", ")}`);
}

function member<T extends string>(values: readonly T[], value: unknown, where: string): T {
  const found = values.find((v) => v === value);
  if (found === undefined) throw new ProtocolError(`${where}: ${JSON.stringify(value)} is not one of ${values}`);
  return found;
}

function unit(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProtocolError(`${where}: expected a number between 0 and 1, not ${JSON.stringify(value)}`);
  }
  return value;
}
