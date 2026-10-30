/**
 * What a driver implements to carry out the core's intents. Every method is optional: implement
 * what the device can do.
 *
 * Calls come from the network loop and must return at once: keep the state, animate elsewhere.
 * Physical safety (limits, watchdogs) belongs to the driver and never depends on the link.
 */

import type { Behavior, Expression } from "./protocol.js";

export interface Body {
  /** The assistant's attitude changed (idle, listening, thinking, speaking): show it until the next. */
  behavior?(behavior: Behavior): void;
  /** Perform an expression now: it arrives as the matching audio is played. Needs `expression.emotion`. */
  expression?(expression: Expression, intensity: number): void;
  /** A word is being played: a light speech accent. Needs `motion.head`. */
  beat?(): void;
  /**
   * Make the device noticed for a few seconds (blink, wiggle, chime, flash the screen), so a person
   * tells it apart from others: asked while it waits to be paired, and once paired
   * (`intent.identify`). A driver that implements it declares `device.identify`.
   */
  identify?(): void;
  /** The core was just heard from (a message or audio). A watchdog can rest the device when heartbeats stop. */
  heartbeat?(): void;
  /** The link to the core came up (welcomed) or went down. */
  connected?(up: boolean): void;
}
