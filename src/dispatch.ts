/**
 * What the satellite does with each message from the core: hand intents to the body and
 * acknowledge them, take note of the welcome, notice the core hanging up. The connection reports
 * the link up to the body once it is welcomed.
 */

import type { Body } from "./body.js";
import { describe, type Logger, quietLogger } from "./log.js";
import { type AckMessage, ack, parse, signalling, type Welcome } from "./wire.js";

export type Outcome = "nothing" | "welcomed" | "hung-up";

export class Dispatcher {
  welcome: Welcome | null = null;

  constructor(
    private readonly body: Body,
    private readonly reply: (message: AckMessage) => void,
    private readonly logger: Logger = quietLogger,
  ) {}

  handle(raw: string): Outcome {
    let data: unknown;
    let received: ReturnType<typeof parse>;
    try {
      data = JSON.parse(raw);
      const transport = signalling(data);
      if (transport !== null) return transport.hungUp ? "hung-up" : "nothing";
      received = parse(data);
    } catch (error) {
      this.logger.warn(`ignoring an off-contract message from the core: ${describe(error)}`);
      return "nothing";
    }
    this.call(() => this.body.heartbeat?.());
    const message = received.message;
    if (message === null) return "nothing"; // a newer message type: nothing to acknowledge
    if (message.type === "welcome") {
      this.welcome = message;
      return "welcomed";
    }
    switch (message.type) {
      case "intent.behavior":
        this.call(() => this.body.behavior?.(message.behavior));
        break;
      case "intent.expression":
        this.call(() => this.body.expression?.(message.expression, message.intensity));
        break;
      case "intent.beat":
        this.call(() => this.body.beat?.());
        break;
      case "intent.identify":
        this.call(() => this.body.identify?.());
        break;
    }
    this.reply(ack(received.id)); // received, whatever the body made of it
    return "nothing";
  }

  /** A failing body is the driver's bug: it is logged, never allowed to break the link. */
  private call(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.logger.warn(`the body failed: ${describe(error)}`);
    }
  }
}
