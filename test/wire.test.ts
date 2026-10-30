import { describe, expect, it } from "vitest";
import { Manifest, ProtocolError, wire } from "../src/index.js";

const AT = "2026-10-30T12:00:00.123456+00:00";
const of = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  type,
  id: "m-1",
  at: AT,
  payload,
  ...extra,
});

describe("what a satellite sends", () => {
  it("is an envelope with a fresh id and the current time", () => {
    const first = wire.ack("intent-1");
    const second = wire.ack("intent-1");
    expect(first).toMatchObject({ type: "ack", payload: { of: "intent-1" } });
    expect(first.id).toMatch(/^[0-9a-f]{32}$/);
    expect(first.id).not.toBe(second.id);
    expect(Math.abs(Date.parse(first.at) - Date.now())).toBeLessThan(1000);
  });

  it("carries the manifest in hello", () => {
    const manifest = Manifest.of({ id: "a", model: "m", room: "r" }, "audio.capture");
    expect(wire.hello(manifest).payload.manifest).toEqual(manifest.toJSON());
  });

  it("refuses observations that the core would reject", () => {
    expect(() => wire.personDetected(-1, 0.5)).toThrow(ProtocolError);
    expect(() => wire.personDetected(1.5, 0.5)).toThrow(ProtocolError);
    expect(() => wire.personDetected(1, 1.2)).toThrow(ProtocolError);
    expect(() => wire.personDetected(1, Number.NaN)).toThrow(ProtocolError);
    expect(wire.personDetected(0, 0).payload).toEqual({ count: 0, confidence: 0 });
  });
});

describe("reading the core", () => {
  it("reads a welcome and each intent", () => {
    expect(wire.parse(of("welcome", { device_id: "a", room: "salon", capabilities: ["audio.capture"] }))).toEqual({
      id: "m-1",
      message: { type: "welcome", deviceId: "a", room: "salon", capabilities: new Set(["audio.capture"]) },
    });
    expect(wire.parse(of("intent.behavior", { behavior: "thinking" })).message).toEqual({
      type: "intent.behavior",
      behavior: "thinking",
    });
    expect(wire.parse(of("intent.expression", { expression: "sigh", intensity: 0.4 })).message).toEqual({
      type: "intent.expression",
      expression: "sigh",
      intensity: 0.4,
    });
    expect(wire.parse(of("intent.beat", {})).message).toEqual({ type: "intent.beat" });
    expect(wire.parse(of("intent.identify", {})).message).toEqual({ type: "intent.identify" });
  });

  it("gives an expression its full intensity when the core does not say", () => {
    expect(wire.parse(of("intent.expression", { expression: "joy" })).message).toMatchObject({ intensity: 1 });
  });

  it("ignores a message type it does not know, so that a newer core does not break it", () => {
    expect(wire.parse(of("intent.dance", { style: "waltz" }))).toEqual({ id: "m-1", message: null });
  });

  it.each([
    ["not an object", "hello"],
    ["no payload", { type: "intent.beat", id: "m-1", at: AT }],
    ["an extra envelope field", of("intent.beat", {}, { extra: 1 })],
    ["an empty id", { ...of("intent.beat", {}), id: "" }],
    ["a long id", { ...of("intent.beat", {}), id: "x".repeat(65) }],
    ["a time that is not ISO 8601", { ...of("intent.beat", {}), at: "yesterday" }],
    ["a payload that is a list", of("intent.beat", [])],
    ["an unknown behavior", of("intent.behavior", { behavior: "dancing" })],
    ["a missing behavior", of("intent.behavior", {})],
    ["an extra payload field", of("intent.behavior", { behavior: "idle", speed: 2 })],
    ["an intensity out of range", of("intent.expression", { expression: "joy", intensity: 2 })],
    ["an intensity that is a string", of("intent.expression", { expression: "joy", intensity: "1" })],
    ["capabilities that are not strings", of("welcome", { device_id: "a", room: "r", capabilities: [1] })],
    ["a welcome without its room", of("welcome", { device_id: "a", capabilities: [] })],
    ["an identify with a payload", of("intent.identify", { seconds: 3 })],
  ])("refuses a known message with %s", (_case, data) => {
    expect(() => wire.parse(data)).toThrow(ProtocolError);
  });

  it("tells the transport's messages apart, and notices the core leaving", () => {
    expect(wire.signalling({ type: "signalling", message: { type: "peerLeft" } })).toEqual({ hungUp: true });
    expect(wire.signalling({ type: "signalling", message: { type: "renegotiate" } })).toEqual({ hungUp: false });
    expect(wire.signalling(of("intent.beat", {}))).toBeNull();
  });
});

describe("reading the pairing endpoints", () => {
  it("reads a ticket, with the device code when pending", () => {
    const ticket = { pairing_id: "p-1", status: "pending", expires_at: AT, device_code: "042917" };
    expect(wire.parseTicket(ticket)).toEqual({
      pairingId: "p-1",
      status: "pending",
      expiresAt: AT,
      deviceCode: "042917",
    });
    expect(wire.parseTicket({ ...ticket, status: "approved", device_code: undefined }).deviceCode).toBeNull();
  });

  it("reads a state, its token and whether to identify", () => {
    expect(wire.parseState({ status: "pending", identify: true })).toMatchObject({ status: "pending", identify: true });
    expect(
      wire.parseState({ status: "approved", token: "nst2_x", device_id: "a", room: "r", capabilities: [] }),
    ).toEqual({
      status: "approved",
      token: "nst2_x",
      deviceId: "a",
      room: "r",
      capabilities: new Set(),
      identify: false,
    });
  });

  it.each([
    ["a ticket without its id", () => wire.parseTicket({ status: "pending", expires_at: AT })],
    [
      "a device code of 5 digits",
      () => wire.parseTicket({ pairing_id: "p", status: "pending", expires_at: AT, device_code: "04291" }),
    ],
    ["an unknown status", () => wire.parseState({ status: "lost" })],
    ["identify false", () => wire.parseState({ status: "pending", identify: false })],
    ["an empty token", () => wire.parseState({ status: "approved", token: "" })],
  ])("refuses %s", (_case, read) => {
    expect(read).toThrow(ProtocolError);
  });

  it("reads an error answer, and tells a stranger's page apart", () => {
    expect(wire.parseError({ error: "enrollment_refused", detail: "no", reason: "expired" })).toEqual({
      error: "enrollment_refused",
      detail: "no",
      reason: "expired",
      retryAfterS: null,
    });
    expect(wire.parseError({ detail: "Bad Gateway" })).toBeNull();
    expect(wire.parseError("<html>")).toBeNull();
  });
});
