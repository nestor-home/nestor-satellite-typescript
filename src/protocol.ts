/**
 * The values of the satellite protocol `nestor.satellite/1`: a device, what it can do, and the
 * intents it receives. They mirror the JSON Schemas shipped in `schemas/`, published by the server.
 */

import { SDK_NAME, SDK_VERSION } from "./version.js";

export const PROTOCOL = "nestor.satellite/1";

// Capabilities the core knows today; a driver may declare others (`family.feature`).
export const AUDIO_CAPTURE = "audio.capture";
export const AUDIO_PLAYBACK = "audio.playback";
export const EXPRESSION = "expression.emotion";
export const HEAD_MOTION = "motion.head";
export const PERSON_DETECTION = "vision.person_detection";
export const SPEECH_ACTIVITY = "audio.speech_activity";

export const MAX_CAPABILITIES = 32;
const MAX_SDK = 64;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CAPABILITY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** The assistant's attitude, shown until the next one. */
export const BEHAVIORS = ["idle", "listening", "thinking", "speaking"] as const;
export type Behavior = (typeof BEHAVIORS)[number];

/** Expressions the core may ask for, as the matching audio is played. */
export const EXPRESSIONS = ["joy", "sigh", "thoughtful", "whisper", "excited", "ahem"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/** Something that does not follow `nestor.satellite/1`. */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface DeviceInit {
  /** A lowercase slug (a-z, 0-9, `-`, `_`): it ends up in addresses. */
  readonly id: string;
  /** Free text, 1 to 64 characters (`raspberry-pi-4`, `Reachy Mini`). */
  readonly model: string;
  /** A lowercase slug: `salon`, `cuisine`… */
  readonly room: string;
  /** Its maker, as a slug (`pollen-robotics`); optional. */
  readonly brand?: string | undefined;
}

export class Device implements DeviceInit {
  readonly id: string;
  readonly model: string;
  readonly room: string;
  readonly brand: string | undefined;

  constructor(init: DeviceInit) {
    for (const [name, value] of [
      ["id", init.id],
      ["room", init.room],
    ] as const) {
      if (typeof value !== "string" || !SLUG.test(value)) {
        throw new ProtocolError(`device ${name} ${JSON.stringify(value)} must be a lowercase slug (a-z, 0-9, - and _)`);
      }
    }
    if (typeof init.model !== "string" || init.model.length === 0 || init.model.length > 64) {
      throw new ProtocolError("device model must be 1 to 64 characters");
    }
    if (init.brand !== undefined && (typeof init.brand !== "string" || !SLUG.test(init.brand))) {
      throw new ProtocolError(`device brand ${JSON.stringify(init.brand)} must be a lowercase slug`);
    }
    this.id = init.id;
    this.model = init.model;
    this.room = init.room;
    this.brand = init.brand;
  }
}

/** A capability the device claims, with its own parameters (`{formats: ["opus/48000"]}`). */
export interface Capability {
  readonly name: string;
  readonly params: Readonly<Record<string, JsonValue>>;
}

export function capability(name: string, params: Readonly<Record<string, JsonValue>> = {}): Capability {
  if (typeof name !== "string" || !CAPABILITY.test(name) || "name" in params) {
    throw new ProtocolError(`invalid capability ${JSON.stringify(name)}: expected 'family.feature'`);
  }
  return Object.freeze({ name, params: Object.freeze({ ...params }) });
}

/** The software a device runs, as it names it. */
export interface Sdk {
  readonly name: string;
  readonly version: string;
}

export const SDK: Sdk = Object.freeze({ name: SDK_NAME, version: SDK_VERSION });

export interface ManifestJson {
  readonly protocol: typeof PROTOCOL;
  readonly device: { readonly id: string; readonly model: string; readonly room: string; readonly brand?: string };
  readonly capabilities: readonly { readonly name: string; readonly [param: string]: JsonValue }[];
  readonly sdk?: Sdk;
}

/** What a device says about itself when it pairs and when it connects. */
export class Manifest {
  readonly device: Device;
  readonly capabilities: readonly Capability[];
  /** This SDK by default; `null` to say nothing. */
  readonly sdk: Sdk | null;

  constructor(device: Device | DeviceInit, capabilities: readonly (Capability | string)[] = [], sdk: Sdk | null = SDK) {
    this.device = device instanceof Device ? device : new Device(device);
    this.capabilities = Object.freeze(capabilities.map((c) => (typeof c === "string" ? capability(c) : c)));
    if (this.capabilities.length > MAX_CAPABILITIES) {
      throw new ProtocolError(`at most ${MAX_CAPABILITIES} capabilities`);
    }
    if (new Set(this.capabilities.map((c) => c.name)).size !== this.capabilities.length) {
      throw new ProtocolError("a capability is declared twice");
    }
    if (sdk !== null) {
      for (const value of [sdk.name, sdk.version]) {
        if (typeof value !== "string" || value.length === 0 || value.length > MAX_SDK) {
          throw new ProtocolError(`sdk name and version must be 1 to ${MAX_SDK} characters`);
        }
      }
    }
    this.sdk = sdk;
  }

  static of(device: Device | DeviceInit, ...names: string[]): Manifest {
    return new Manifest(device, names);
  }

  /** The declared capability names. */
  get names(): ReadonlySet<string> {
    return new Set(this.capabilities.map((c) => c.name));
  }

  has(name: string): boolean {
    return this.capabilities.some((c) => c.name === name);
  }

  toJSON(): ManifestJson {
    const { id, model, room, brand } = this.device;
    return {
      protocol: PROTOCOL,
      device: brand === undefined ? { id, model, room } : { id, model, room, brand },
      capabilities: this.capabilities.map((c) => ({ name: c.name, ...c.params })),
      ...(this.sdk === null ? {} : { sdk: { name: this.sdk.name, version: this.sdk.version } }),
    };
  }
}
