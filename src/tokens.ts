/**
 * Where a device keeps its token, its only credential. A token is bound to one core and one
 * device: a saved token for another core or device is useless and reads as none. It is forgotten
 * when the core refuses it (revoked, or paired again elsewhere).
 *
 * `LocalStorageTokenStore` serves browsers; `FileTokenStore` (in `@nestor-home/satellite/node`)
 * serves Node with a file only its owner can read.
 */

export type MaybePromise<T> = T | Promise<T>;

export interface TokenStore {
  load(core: string, deviceId: string): MaybePromise<string | null>;
  save(core: string, deviceId: string, token: string): MaybePromise<void>;
  forget(): MaybePromise<void>;
}

export interface SavedToken {
  readonly core: string;
  readonly device_id: string;
  readonly token: string;
}

/** The saved form, as JSON (same as the Python SDK's file); `null` when unreadable or for another core or device. */
export function readSaved(text: string | null, core: string, deviceId: string): string | null {
  if (text === null) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof saved !== "object" || saved === null) return null;
  const { core: savedCore, device_id, token } = saved as Partial<Record<keyof SavedToken, unknown>>;
  if (savedCore !== core || device_id !== deviceId || typeof token !== "string" || token.length === 0) return null;
  return token;
}

export function writeSaved(core: string, deviceId: string, token: string): string {
  const saved: SavedToken = { core, device_id: deviceId, token };
  return JSON.stringify(saved);
}

/** Kept in memory: pairs again at every start. For tests and ephemeral devices. */
export class MemoryTokenStore implements TokenStore {
  private saved: string | null = null;

  load(core: string, deviceId: string): string | null {
    return readSaved(this.saved, core, deviceId);
  }

  save(core: string, deviceId: string, token: string): void {
    this.saved = writeSaved(core, deviceId, token);
  }

  forget(): void {
    this.saved = null;
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
    try {
      return readSaved(this.storage()?.getItem(this.key) ?? null, core, deviceId);
    } catch {
      return null;
    }
  }

  save(core: string, deviceId: string, token: string): void {
    try {
      this.storage()?.setItem(this.key, writeSaved(core, deviceId, token));
    } catch {
      // not kept: the device will pair again next time
    }
  }

  forget(): void {
    try {
      this.storage()?.removeItem(this.key);
    } catch {
      // nothing was kept
    }
  }
}

function defaultStorage(): StorageLike | undefined {
  return (globalThis as { localStorage?: StorageLike }).localStorage;
}
