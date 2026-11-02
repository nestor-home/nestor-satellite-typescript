/**
 * What the satellite does with each message from the core: hand intents to the body (and the
 * assistant's words to the text display) and acknowledge them, take note of the welcome. The link
 * reports itself up to the body once it is welcomed.
 */

import type { Body } from "./body.js";
import { describe, type Logger, quietLogger } from "./log.js";
import { type AckMessage, ack, parse, type Welcome } from "./wire.js";

export type Outcome = "nothing" | "welcomed";

/** Shows the assistant's words; `final`: the last message of a turn. */
export type TextDisplay = (text: string, final: boolean) => void;

export class Dispatcher {
  welcome: Welcome | null = null;

  constructor(
    private readonly body: Body,
    private readonly reply: (message: AckMessage) => void,
    private readonly logger: Logger = quietLogger,
    private readonly display?: TextDisplay,
  ) {}

  handle(raw: string): Outcome {
    let received: ReturnType<typeof parse>;
    try {
      received = parse(JSON.parse(raw));
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
      case "intent.text":
        this.call(() => this.display?.(message.text, message.final));
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
