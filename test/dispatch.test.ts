import { describe, expect, it, vi } from "vitest";
import { type Body, Dispatcher, type Logger, type TextDisplay, type wire } from "../src/index.js";

const message = (type: string, payload: Record<string, unknown>, id = "m-1") => ({
  type,
  id,
  at: "2026-10-30T12:00:00.000000+00:00",
  payload,
});

function setup(body: Body = {}, display?: TextDisplay) {
  const replies: wire.AckMessage[] = [];
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const dispatcher = new Dispatcher(body, (reply) => replies.push(reply), logger, display);
  const handle = (data: unknown) => dispatcher.handle(typeof data === "string" ? data : JSON.stringify(data));
  return { dispatcher, replies, logger, handle };
}

describe("the dispatcher", () => {
  it("hands each intent to the body and acknowledges it by id", () => {
    const calls: unknown[] = [];
    const { handle, replies } = setup({
      behavior: (b) => calls.push(["behavior", b]),
      expression: (e, i) => calls.push(["expression", e, i]),
      beat: () => calls.push(["beat"]),
      identify: () => calls.push(["identify"]),
    });
    handle(message("intent.behavior", { behavior: "listening" }, "i-1"));
    handle(message("intent.expression", { expression: "excited", intensity: 0.7 }, "i-2"));
    handle(message("intent.beat", {}, "i-3"));
    handle(message("intent.identify", {}, "i-4"));
    expect(calls).toEqual([["behavior", "listening"], ["expression", "excited", 0.7], ["beat"], ["identify"]]);
    expect(replies.map((r) => r.payload.of)).toEqual(["i-1", "i-2", "i-3", "i-4"]);
  });

  it("acknowledges intents a body does not implement: received is all an ack means", () => {
    const { handle, replies } = setup({});
    expect(handle(message("intent.beat", {}, "i-1"))).toBe("nothing");
    expect(replies).toHaveLength(1);
  });

  it("keeps the welcome and does not acknowledge it", () => {
    const { handle, dispatcher, replies } = setup();
    const outcome = handle(message("welcome", { device_id: "a", room: "salon", capabilities: ["audio.capture"] }));
    expect(outcome).toBe("welcomed");
    expect(dispatcher.welcome?.capabilities).toEqual(new Set(["audio.capture"]));
    expect(replies).toEqual([]);
  });

  it("shows the assistant's words on the text display, and acknowledges them, even with no display", () => {
    const shown: [string, boolean][] = [];
    const { handle, replies } = setup({}, (text, final) => shown.push([text, final]));
    handle(message("intent.text", { text: "Je regarde.", final: false }, "t-1"));
    handle(message("intent.text", { text: "Il est midi." }, "t-2"));
    expect(shown).toEqual([
      ["Je regarde.", false],
      ["Il est midi.", true],
    ]);
    expect(replies.map((r) => r.payload.of)).toEqual(["t-1", "t-2"]);
    const blind = setup();
    blind.handle(message("intent.text", { text: "Bonjour." }, "t-3"));
    expect(blind.replies.map((r) => r.payload.of)).toEqual(["t-3"]);
  });

  it("logs and drops what is off-contract, without acknowledging it", () => {
    const heartbeat = vi.fn();
    const { handle, replies, logger } = setup({ heartbeat });
    expect(handle("{not json")).toBe("nothing");
    expect(handle(message("intent.behavior", { behavior: "dancing" }))).toBe("nothing");
    expect(replies).toEqual([]);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("counts any valid message as a heartbeat, even one of a newer type it does not acknowledge", () => {
    const heartbeat = vi.fn();
    const { handle, replies } = setup({ heartbeat });
    handle(message("intent.dance", {}));
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(replies).toEqual([]);
  });

  it("survives a failing body and still acknowledges", () => {
    const { handle, replies, logger } = setup({
      behavior: () => {
        throw new Error("servo jammed");
      },
    });
    handle(message("intent.behavior", { behavior: "idle" }, "i-1"));
    expect(replies.map((r) => r.payload.of)).toEqual(["i-1"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("servo jammed"));
  });
});
