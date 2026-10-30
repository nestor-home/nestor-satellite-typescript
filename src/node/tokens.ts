import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { readSaved, type TokenStore, writeSaved } from "../tokens.js";

/**
 * One device's token for one core, in a JSON file readable by its owner only (mode 600), the
 * same format as the Python SDK's (`{core, device_id, token}`).
 */
export class FileTokenStore implements TokenStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);
  }

  async load(core: string, deviceId: string): Promise<string | null> {
    try {
      return readSaved(await readFile(this.path, "utf8"), core, deviceId);
    } catch {
      return null;
    }
  }

  async save(core: string, deviceId: string, token: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, writeSaved(core, deviceId, token), { mode: 0o600 });
    await chmod(this.path, 0o600); // an older file may have been more open
  }

  async forget(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
