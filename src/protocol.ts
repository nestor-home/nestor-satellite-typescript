/**
 * The values of the satellite protocol `nestor.satellite/1`: a device, what it can do, how it can
 * be paired, and the intents it receives. They mirror the JSON Schemas shipped in `schemas/`,
 * published by the server.
 */

import { SDK_NAME, SDK_VERSION } from "./version.js";

export const PROTOCOL = "nestor.satellite/1";

// Capabilities the core knows today; a driver may declare others (`family.feature`).
export const AUDIO_CAPTURE = "audio.capture";
export const AUDIO_PLAYBACK = "audio.playback";
export const EXPRESSION = "expression.emotion";
export const HEAD_MOTION = "motion.head";
/** The device can make itself noticed (blink, wiggle, chime) so a person tells it apart. */
export const IDENTIFY = "device.identify";
export const PERSON_DETECTION = "vision.person_detection";
export const SPEECH_ACTIVITY = "audio.speech_activity";
/**
 * The device can install a newer version of its own software, on a person's request
 * (`update.status`, `intent.update`). Declared by giving the satellite an `Updater`.
 */
export const UPDATE = "device.update";
/** The device sends what a person typed (`input.text`). */
export const TEXT_INPUT = "text.input";
/** The device shows the assistant's words (`intent.text`). */
export const TEXT_DISPLAY = "text.display";

export const MAX_CAPABILITIES = 32;
const MAX_SOFTWARE = 64;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CAPABILITY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** The assistant's attitude, shown until the next one. */
export const BEHAVIORS = ["idle", "listening", "thinking", "speaking"] as const;
export type Behavior = (typeof BEHAVIORS)[number];

/** Expressions the core may ask for, as the matching audio is played. */
export const EXPRESSIONS = ["joy", "sigh", "thoughtful", "whisper", "excited", "ahem"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/**
 * How a person can pair a device: it shows or says a device code that the person types in the admin
 * (`device_code.*`), or it receives an enrollment code made in the admin (`enrollment.*`): typed on
 * the device, set in its configuration, or scanned as a QR code.
 */
export const PAIRING_METHODS = [
  "device_code.display",
  "device_code.speech",
  "enrollment.input",
  "enrollment.provisioning",
  "enrollment.qr",
] as const;
export type PairingMethod = (typeof PAIRING_METHODS)[number];

/** The methods that bring an enrollment code to the device. */
export const ENROLLMENT_METHODS = ["enrollment.input", "enrollment.provisioning", "enrollment.qr"] as const;
export type EnrollmentMethod = (typeof ENROLLMENT_METHODS)[number];

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

/**
 * The software a device runs, as its package is named where it is installed from
 * (`@nestor-home/satellite` `0.5.0`, or the driver's own package). A device that updates itself
 * installs newer versions of this package.
 */
export interface Software {
  readonly name: string;
  readonly version: string;
}

/** This SDK: the software a device declares unless its driver names its own. */
export const SOFTWARE: Software = Object.freeze({ name: SDK_NAME, version: SDK_VERSION });

export interface ManifestJson {
  readonly protocol: typeof PROTOCOL;
  readonly device: { readonly id: string; readonly model: string; readonly room: string; readonly brand?: string };
  readonly capabilities: readonly { readonly name: string; readonly [param: string]: JsonValue }[];
  readonly pairing_methods: readonly PairingMethod[];
  readonly software: Software;
}

export interface ManifestOptions {
  /** What the device runs: this SDK by default; a driver published as its own package names it. */
  readonly software?: Software;
  /**
   * How a person can pair it (`enrollment.provisioning` by default). A `Satellite` sets them from
   * what its driver provides.
   */
  readonly pairingMethods?: readonly PairingMethod[];
}

/** What a device says about itself when it pairs and when it connects. */
export class Manifest {
  readonly device: Device;
  readonly capabilities: readonly Capability[];
  readonly software: Software;
  readonly pairingMethods: readonly PairingMethod[];

  constructor(
    device: Device | DeviceInit,
    capabilities: readonly (Capability | string)[] = [],
    options: ManifestOptions = {},
  ) {
    const { software = SOFTWARE, pairingMethods = ["enrollment.provisioning"] } = options;
    this.device = device instanceof Device ? device : new Device(device);
    this.capabilities = Object.freeze(capabilities.map((c) => (typeof c === "string" ? capability(c) : c)));
    if (this.capabilities.length > MAX_CAPABILITIES) {
      throw new ProtocolError(`at most ${MAX_CAPABILITIES} capabilities`);
    }
    if (new Set(this.capabilities.map((c) => c.name)).size !== this.capabilities.length) {
      throw new ProtocolError("a capability is declared twice");
    }
    for (const value of [software.name, software.version]) {
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOFTWARE) {
        throw new ProtocolError(`software name and version must be 1 to ${MAX_SOFTWARE} characters`);
      }
    }
    this.software = Object.freeze({ name: software.name, version: software.version });
    if (pairingMethods.length === 0 || new Set(pairingMethods).size !== pairingMethods.length) {
      throw new ProtocolError("a device supports at least one pairing method, each listed once");
    }
    for (const method of pairingMethods) {
      if (!PAIRING_METHODS.includes(method)) {
        throw new ProtocolError(
          `unknown pairing method ${JSON.stringify(method)}: one of ${PAIRING_METHODS.join(", ")}`,
        );
      }
    }
    this.pairingMethods = Object.freeze([...pairingMethods]);
  }

  static of(device: Device | DeviceInit, ...names: string[]): Manifest {
    return new Manifest(device, names);
  }

  /** The same manifest with other pairing methods. */
  withPairingMethods(methods: readonly PairingMethod[]): Manifest {
    return new Manifest(this.device, this.capabilities, { software: this.software, pairingMethods: methods });
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
      pairing_methods: [...this.pairingMethods],
      software: { name: this.software.name, version: this.software.version },
    };
  }
}
