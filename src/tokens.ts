/**
 * Where a device keeps its state for one core: its token, its only credential, and the enrollment
 * codes the core refused (P5), as SHA-256 hashes, so that a restarted device never sends one again.
 * A saved state for another core or device is useless and reads as none. The token is forgotten
 * when the core refuses it (revoked, or paired again elsewhere); the refused codes stay.
 *
 * `LocalStorageTokenStore` serves browsers; `FileTokenStore` (in `@nestor-home/satellite/node`)
 * serves Node with a file only its owner can read. All keep the same JSON as the Python SDK's file:
 * `{"core": …, "device_id": …, "token": … (once paired), "refused": {"<sha256 hex>": "<reason>"}}`.
 */

import { REFUSAL_REASONS, type RefusalReason } from "./wire.js";

export type MaybePromise<T> = T | Promise<T>;

/** The refused enrollment codes of a device, by the SHA-256 hash (hex) of their canonical form. */
export type RefusedCodes = Readonly<Record<string, RefusalReason>>;

export interface TokenStore {
  load(core: string, deviceId: string): MaybePromise<string | null>;
  save(core: string, deviceId: string, token: string): MaybePromise<void>;
  /** Forget the token; the refused codes stay. */
  forget(): MaybePromise<void>;
  /** The enrollment codes the core refused to this device. */
  refused(core: string, deviceId: string): MaybePromise<RefusedCodes>;
  /** Remember that the core refused the enrollment code whose hash is `hash`. */
  refuse(core: string, deviceId: string, hash: string, reason: RefusalReason): MaybePromise<void>;
}

/** What a store keeps for one core and one device. */
export interface DeviceState {
  readonly token: string | null;
  readonly refused: RefusedCodes;
}

const EMPTY: DeviceState = Object.freeze({ token: null, refused: Object.freeze({}) });
const HASH = /^[0-9a-f]{64}$/;

/** The saved JSON's state; empty when unreadable, or for another core or device. */
export function readState(text: string | null, core: string, deviceId: string): DeviceState {
  if (text === null) return EMPTY;
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return EMPTY;
  }
  if (!isRecord(saved) || saved.core !== core || saved.device_id !== deviceId) return EMPTY;
  const token = typeof saved.token === "string" && saved.token.length > 0 ? saved.token : null;
  const refused: Record<string, RefusalReason> = {};
  if (isRecord(saved.refused)) {
    for (const [hash, reason] of Object.entries(saved.refused)) {
      if (!HASH.test(hash)) continue;
      refused[hash] = REFUSAL_REASONS.includes(reason as RefusalReason) ? (reason as RefusalReason) : "unknown";
    }
  }
  return { token, refused };
}

/** The JSON to save; `null` when there is nothing to keep. */
export function writeState(core: string, deviceId: string, state: DeviceState): string | null {
  if (state.token === null && Object.keys(state.refused).length === 0) return null;
  return JSON.stringify({
    core,
    device_id: deviceId,
    ...(state.token === null ? {} : { token: state.token }),
    refused: state.refused,
  });
}

/** The SHA-256 hash (hex) of an enrollment code's canonical form, as stores keep refused codes. */
export async function hashEnrollmentCode(code: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The state a store keeps after a change, as text (`null`: remove it). */
function changed(
  text: string | null,
  core: string,
  deviceId: string,
  change: (state: DeviceState) => DeviceState,
): string | null {
  return writeState(core, deviceId, change(readState(text, core, deviceId)));
}

/** Kept in memory: pairs again at every start. For tests and ephemeral devices. */
export class MemoryTokenStore implements TokenStore {
  private saved: string | null = null;

  load(core: string, deviceId: string): string | null {
    return readState(this.saved, core, deviceId).token;
  }

  save(core: string, deviceId: string, token: string): void {
    this.saved = changed(this.saved, core, deviceId, (state) => ({ ...state, token }));
  }

  forget(): void {
    this.saved = forgotten(this.saved);
  }

  refused(core: string, deviceId: string): RefusedCodes {
    return readState(this.saved, core, deviceId).refused;
  }

  refuse(core: string, deviceId: string, hash: string, reason: RefusalReason): void {
    this.saved = changed(this.saved, core, deviceId, (state) => ({
      ...state,
      refused: { ...state.refused, [hash]: reason },
    }));
  }
}

/** The part of the Web Storage API this store uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * In the browser's `localStorage`, under `key`. Storage may be missing or refuse access (private
 * windows, blocked site data, quota): reads then find nothing and writes are lost, so the device
 * pairs again at the next start rather than failing.
 *
 * Any script of the page's origin can read it: serve a satellite page from an origin of its own.
 */
export class LocalStorageTokenStore implements TokenStore {
  constructor(
    private readonly key = "nestor-satellite",
    private readonly storage: () => StorageLike | undefined = defaultStorage,
  ) {}

  load(core: string, deviceId: string): string | null {
    return readState(this.read(), core, deviceId).token;
  }

  save(core: string, deviceId: string, token: string): void {
    this.write(changed(this.read(), core, deviceId, (state) => ({ ...state, token })));
  }

  forget(): void {
    this.write(forgotten(this.read()));
  }

  refused(core: string, deviceId: string): RefusedCodes {
    return readState(this.read(), core, deviceId).refused;
  }

  refuse(core: string, deviceId: string, hash: string, reason: RefusalReason): void {
    this.write(
      changed(this.read(), core, deviceId, (state) => ({ ...state, refused: { ...state.refused, [hash]: reason } })),
    );
  }

  private read(): string | null {
    try {
      return this.storage()?.getItem(this.key) ?? null;
    } catch {
      return null;
    }
  }

  private write(text: string | null): void {
    try {
      if (text === null) this.storage()?.removeItem(this.key);
      else this.storage()?.setItem(this.key, text);
    } catch {
      // not kept: the device will pair again next time
    }
  }
}

/** The saved JSON without its token: the refused codes stay; `null` when nothing is left. */
export function forgotten(text: string | null): string | null {
  if (text === null) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(saved) || typeof saved.core !== "string" || typeof saved.device_id !== "string") return null;
  return changed(text, saved.core, saved.device_id, (state) => ({ ...state, token: null }));
}

function defaultStorage(): StorageLike | undefined {
  return (globalThis as { localStorage?: StorageLike }).localStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
