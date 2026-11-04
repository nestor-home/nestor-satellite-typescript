/**
 * A device that updates its own software (`device.update`), on a person's request.
 *
 * The SDK never installs anything itself and never fetches from where the core says: the driver's
 * `Updater` finds newer versions at the software's own source and installs them. The satellite
 * reports what it found at each welcome (U1), checks again at most once a day, and on
 * `intent.update` installs only the newer version it found itself, never another (U2): it reports
 * `installing`, installs, then asks the updater to start again on it (U3).
 *
 * Going back when the new version does not start is the updater's part (or its launcher's): a broken
 * version may never run this code. It keeps the previous version until `welcomed()` is called, goes
 * back to it when that does not happen within `UPDATE_TRIAL_MS`, and says so once through `failed()`.
 */

import type { Messages } from "./i18n.js";
import { describe, type Logger } from "./log.js";
import { type SatelliteMessage, updateStatus } from "./wire.js";

/** How long a newly installed version has to be welcomed before its updater goes back (U3). */
export const UPDATE_TRIAL_MS = 60_000;
/** How often a device checks for a newer version while its link stays up (U1). */
export const UPDATE_CHECK_MS = 24 * 3600_000;

export interface Updater {
  /**
   * The newest version of this device's software at its own source, when newer than the one it runs
   * (`manifest.software`); `null` otherwise. Rejects when the source cannot be read.
   */
  newer(): Promise<string | null>;
  /** Install `version`, so that the next start runs it. Rejects when it cannot. */
  install(version: string): Promise<void>;
  /** Start again on the installed version: reload the page, or exit for a supervisor to start it. */
  restart(): void;
  /** This start was welcomed: keep the version it runs (it was on trial since installed). */
  welcomed?(): Promise<void>;
  /** A version installed earlier that did not start and was rolled back, to report once; else `null`. */
  failed?(): Promise<string | null>;
}

export class SoftwareUpdates {
  /** The version found at the last check, and when; `null` before any. */
  private found: { readonly version: string | null; readonly at: number } | null = null;
  private installing = false;

  constructor(
    private readonly updater: Updater,
    private readonly messages: Messages,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Once welcomed: keep this version, then say where the software stands (a rolled back version first). */
  async welcomed(send: (message: SatelliteMessage) => boolean): Promise<void> {
    try {
      await this.updater.welcomed?.();
      const failed = (await this.updater.failed?.()) ?? null;
      if (failed !== null) {
        send(updateStatus("failed", failed));
        return;
      }
    } catch (error) {
      this.logger.warn(this.messages.format("update-check-failed", { error: describe(error) }));
    }
    await this.report(send);
  }

  /** Say where the software stands, checking its source again when the last check is a day old. */
  async report(send: (message: SatelliteMessage) => boolean): Promise<void> {
    if (this.installing) return;
    if (this.found === null || this.now() - this.found.at >= UPDATE_CHECK_MS) {
      try {
        this.found = { version: await this.updater.newer(), at: this.now() };
      } catch (error) {
        this.logger.warn(this.messages.format("update-check-failed", { error: describe(error) }));
        return;
      }
    }
    const { version } = this.found;
    send(version === null ? updateStatus("current") : updateStatus("available", version));
  }

  /** `intent.update`: install `version` if it is the newer one found here, else say again what was found. */
  async install(version: string, send: (message: SatelliteMessage) => boolean): Promise<void> {
    if (this.installing) return;
    if (this.found?.version !== version) {
      this.logger.warn(`asked to install ${version}, which this device did not find: ignored`);
      if (this.found !== null) await this.report(send);
      return;
    }
    this.installing = true;
    this.logger.info(this.messages.format("update-installing", { version }));
    send(updateStatus("installing", version));
    try {
      await this.updater.install(version);
    } catch (error) {
      this.installing = false;
      this.logger.warn(this.messages.format("update-failed", { version, error: describe(error) }));
      send(updateStatus("failed", version));
      return;
    }
    this.updater.restart();
  }
}
