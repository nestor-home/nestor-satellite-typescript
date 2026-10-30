/**
 * Messages on the `nestor` data channel: one JSON envelope `{type, id, at, payload}`.
 *
 * The satellite sends `hello` first, then `ack`s and observations; the core sends `welcome` and
 * `intent.*`. Reading is strict about the messages this SDK knows (a malformed one is a
 * `ProtocolError`) and lenient about the ones it does not: an unknown type from a newer core is
 * returned as `null`, so it never breaks an older driver.
 */

import {
  BEHAVIORS,
  type Behavior,
  EXPRESSIONS,
  type Expression,
  type Manifest,
  type ManifestJson,
  ProtocolError,
} from "./protocol.js";

/** The WebRTC transport's own messages (peer left, renegotiation): not Nestor's. */
export const SIGNALLING = "signalling";

const MAX_ID = 64;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

export interface Envelope<Type extends string, Payload> {
  readonly type: Type;
  readonly id: string;
  readonly at: string;
  readonly payload: Payload;
}

export type HelloMessage = Envelope<"hello", { readonly manifest: ManifestJson }>;
export type AckMessage = Envelope<"ack", { readonly of: string }>;
export type PersonDetectedMessage = Envelope<
  "observation.person.detected",
  { readonly count: number; readonly confidence: number }
>;
export type SpeechActivityMessage = Envelope<"observation.speech.activity", { readonly active: boolean }>;
/** Everything a satellite sends. */
export type SatelliteMessage = HelloMessage | AckMessage | PersonDetectedMessage | SpeechActivityMessage;

/** A fresh message id: 32 hex characters (works outside secure contexts, unlike `randomUUID`). */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function envelope<Type extends string, Payload>(type: Type, payload: Payload): Envelope<Type, Payload> {
  return { type, id: newId(), at: new Date().toISOString(), payload };
}

export function hello(manifest: Manifest): HelloMessage {
  return envelope("hello", { manifest: manifest.toJSON() });
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

export type Intent = BehaviorIntent | ExpressionIntent | BeatIntent;
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
    case "intent.beat":
      exactKeys(payload, [], [], type);
      return { type };
    default:
      return null;
  }
}

/** Whether a received JSON value is one of the transport's own messages, and whether it says the core left. */
export function signalling(data: unknown): { hungUp: boolean } | null {
  if (!isRecord(data) || data.type !== SIGNALLING) return null;
  const message = data.message;
  return { hungUp: isRecord(message) && message.type === "peerLeft" };
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
