import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { type DeviceState, forgotten, type RefusedCodes, readState, type TokenStore, writeState } from "../tokens.js";
import type { RefusalReason } from "../wire.js";

/**
 * One device's state for one core (its token, the enrollment codes refused to it, hashed), in a
 * JSON file readable by its owner only (mode 600), the same format as the Python SDK's.
 */
export class FileTokenStore implements TokenStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);
  }

  async load(core: string, deviceId: string): Promise<string | null> {
    return readState(await this.read(), core, deviceId).token;
  }

  async save(core: string, deviceId: string, token: string): Promise<void> {
    await this.change(core, deviceId, (state) => ({ ...state, token }));
  }

  async forget(): Promise<void> {
    await this.write(forgotten(await this.read()));
  }

  async refused(core: string, deviceId: string): Promise<RefusedCodes> {
    return readState(await this.read(), core, deviceId).refused;
  }

  async refuse(core: string, deviceId: string, hash: string, reason: RefusalReason): Promise<void> {
    await this.change(core, deviceId, (state) => ({ ...state, refused: { ...state.refused, [hash]: reason } }));
  }

  private async change(core: string, deviceId: string, change: (state: DeviceState) => DeviceState): Promise<void> {
    await this.write(writeState(core, deviceId, change(readState(await this.read(), core, deviceId))));
  }

  private async read(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf8");
    } catch {
      return null;
    }
  }

  private async write(text: string | null): Promise<void> {
    if (text === null) {
      await rm(this.path, { force: true });
      return;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, text, { mode: 0o600 });
    await chmod(this.path, 0o600); // an older file may have been more open
  }
}
