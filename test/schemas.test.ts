/** What the SDK sends and reads, against its copy of the protocol schemas. */

import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  AUDIO_CAPTURE,
  BEHAVIORS,
  capability,
  EXPRESSIONS,
  IDENTIFY,
  Manifest,
  PAIRING_METHODS,
  PERSON_DETECTION,
  wire,
} from "../src/index.js";

const COPY = new URL("../schemas/", import.meta.url);

type Schema = Record<string, unknown> & { $id: string };

function load(folder: URL): Record<string, Schema> {
  const names = readdirSync(folder).filter((n) => n.endsWith(".json"));
  return Object.fromEntries(names.map((n) => [n, JSON.parse(readFileSync(new URL(n, folder), "utf8")) as Schema]));
}

const schemas = load(COPY);
const ajv = new Ajv2020({ strict: true, strictTuples: false, allErrors: true });
ajv.addKeyword("x-protocol").addKeyword("x-direction");
addFormats.default(ajv);
for (const schema of Object.values(schemas)) ajv.addSchema(schema);

function validate(data: unknown, name: string): void {
  const schema = schemas[name];
  if (schema === undefined) throw new Error(`no schema ${name}`);
  const check = ajv.getSchema(schema.$id);
  if (check === undefined) throw new Error(`schema ${name} did not compile`);
  expect(check(JSON.parse(JSON.stringify(data))), ajv.errorsText(check.errors)).toBe(true);
}

const MANIFEST = new Manifest({ id: "enceinte-salon", model: "Raspberry Pi 4", room: "salon", brand: "raspberry" }, [
  capability(AUDIO_CAPTURE, { formats: ["opus/48000"] }),
  capability(PERSON_DETECTION, { rate_hz: 10 }),
  IDENTIFY,
]).withPairingMethods(["device_code.display", "enrollment.input", "enrollment.provisioning"]);

it("knows every value the core may send", () => {
  const field = (name: string, key: string) => {
    const envelope = schemas[name]?.properties as Record<string, { properties: Record<string, unknown> }> | undefined;
    return envelope?.payload?.properties[key];
  };
  expect(field("intent.behavior.json", "behavior")).toEqual({ enum: [...BEHAVIORS] });
  expect(field("intent.expression.json", "expression")).toEqual({ enum: [...EXPRESSIONS] });
  const manifest = schemas["manifest.json"]?.properties as Record<string, { items: unknown }> | undefined;
  expect(manifest?.pairing_methods?.items).toEqual({ enum: [...PAIRING_METHODS] });
  const error = schemas["pairing.error.json"]?.properties as Record<string, unknown> | undefined;
  expect(error?.error).toEqual({ enum: [...wire.PAIRING_ERRORS] });
  expect(error?.reason).toEqual({ enum: [...wire.REFUSAL_REASONS] });
  expect(field("update.status.json", "state")).toEqual({ enum: [...wire.UPDATE_STATES] });
});

it("knows every message type of the protocol", () => {
  expect(Object.keys(schemas).sort()).toEqual([
    "ack.json",
    "hello.json",
    "input.text.json",
    "intent.beat.json",
    "intent.behavior.json",
    "intent.expression.json",
    "intent.identify.json",
    "intent.text.json",
    "intent.update.json",
    "manifest.json",
    "observation.person.detected.json",
    "observation.speech.activity.json",
    "pairing.enrollment.json",
    "pairing.error.json",
    "pairing.request.json",
    "pairing.state.json",
    "pairing.ticket.json",
    "update.status.json",
    "welcome.json",
  ]);
});

describe("what the SDK sends follows the schema", () => {
  it.each([
    ["hello", wire.hello(MANIFEST, "nst1_token")],
    [
      "hello without brand, a driver's own software",
      wire.hello(
        new Manifest({ id: "a", model: "m", room: "r" }, [], { software: { name: "my-satellite", version: "1.0.0" } }),
        "nst1_token",
      ),
    ],
    ["input.text", wire.textInput("Allume la lumière du salon")],
    ["ack", wire.ack("intent-1")],
    ["observation.person.detected", wire.personDetected(2, 0.75)],
    ["observation.speech.activity", wire.speechActivity(true)],
    ["update.status current", wire.updateStatus("current")],
    ["update.status available", wire.updateStatus("available", "0.6.0")],
    ["update.status failed", wire.updateStatus("failed", "0.6.0")],
  ])("%s", (_name, message) => {
    validate(message, `${message.type}.json`);
  });

  it.each([
    ["pairing.request.json", wire.pairingRequest(MANIFEST)],
    [
      "pairing.request.json",
      wire.pairingRequest(MANIFEST, wire.enrollmentProof("K7QF2M9X", "enrollment.provisioning")),
    ],
    ["pairing.enrollment.json", wire.enrollmentProof("K7QF2M9X", "enrollment.qr")],
  ])("%s", (name, body) => {
    validate(body, name);
  });
});

describe("what the schema allows the core to send, the SDK reads", () => {
  const at = "2026-10-30T12:00:00.123456+00:00";
  it.each([
    { type: "welcome", id: "m-1", at, payload: { device_id: "a", room: "salon", capabilities: ["audio.capture"] } },
    { type: "intent.behavior", id: "m-2", at, payload: { behavior: "speaking" } },
    { type: "intent.expression", id: "m-3", at, payload: { expression: "ahem", intensity: 0 } },
    { type: "intent.expression", id: "m-4", at: "2026-10-30T12:00:00Z", payload: { expression: "whisper" } },
    { type: "intent.beat", id: "m-5", at, payload: {} },
    { type: "intent.identify", id: "m-6", at, payload: {} },
    { type: "intent.text", id: "m-7", at, payload: { text: "Il est midi.", final: true } },
    { type: "intent.text", id: "m-8", at, payload: { text: "Je regarde." } },
    { type: "intent.update", id: "m-9", at, payload: { version: "0.6.0" } },
  ])("$type ($id)", (message) => {
    validate(message, `${message.type}.json`);
    expect(wire.parse(message).message?.type).toBe(message.type);
  });

  const expires_at = "2026-10-30T12:10:00+00:00";
  it.each([
    [
      "pairing.ticket.json",
      { pairing_id: "p-1", status: "pending", expires_at, device_code: "042917" },
      wire.parseTicket,
    ],
    ["pairing.ticket.json", { pairing_id: "p-1", status: "approved", expires_at }, wire.parseTicket],
    ["pairing.state.json", { status: "pending", identify: true }, wire.parseState],
    [
      "pairing.state.json",
      { status: "approved", token: "nst1_x", device_id: "a", room: "salon", capabilities: ["device.identify"] },
      wire.parseState,
    ],
    ["pairing.state.json", { status: "expired" }, wire.parseState],
    ["pairing.error.json", { error: "enrollment_refused", detail: "no", reason: "used" }, wire.parseError],
    ["pairing.error.json", { error: "too_many_attempts", detail: "wait", retry_after_s: 3 }, wire.parseError],
  ] as const)("%s %j", (name, body, read) => {
    validate(body, name);
    expect(read(body)).not.toBeNull();
  });
});
