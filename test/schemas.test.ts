/**
 * The SDK's copy of the protocol schemas, and what the SDK sends and reads, against them. When the
 * server's schemas are next to this repository (`../nestor`), the copy must be identical.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { AUDIO_CAPTURE, BEHAVIORS, capability, EXPRESSIONS, Manifest, PERSON_DETECTION, wire } from "../src/index.js";

const COPY = new URL("../schemas/", import.meta.url);
const SERVER = new URL("../../nestor/src/nestor/modules/satellites/schemas/", import.meta.url);

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
]);

it.skipIf(!existsSync(SERVER))("the copied schemas are the server's (refresh them as AGENTS.md says)", () => {
  expect(schemas).toEqual(load(SERVER));
});

it("knows every value the core may send", () => {
  const field = (name: string, key: string) => {
    const envelope = schemas[name]?.properties as Record<string, { properties: Record<string, unknown> }> | undefined;
    return envelope?.payload?.properties[key];
  };
  expect(field("intent.behavior.json", "behavior")).toEqual({ enum: [...BEHAVIORS] });
  expect(field("intent.expression.json", "expression")).toEqual({ enum: [...EXPRESSIONS] });
});

it("knows every message type of the protocol", () => {
  expect(Object.keys(schemas).sort()).toEqual([
    "ack.json",
    "hello.json",
    "intent.beat.json",
    "intent.behavior.json",
    "intent.expression.json",
    "manifest.json",
    "observation.person.detected.json",
    "observation.speech.activity.json",
    "welcome.json",
  ]);
});

describe("what the SDK sends follows the schema", () => {
  it.each([
    ["hello", wire.hello(MANIFEST)],
    ["hello without brand nor sdk", wire.hello(new Manifest({ id: "a", model: "m", room: "r" }, [], null))],
    ["ack", wire.ack("intent-1")],
    ["observation.person.detected", wire.personDetected(2, 0.75)],
    ["observation.speech.activity", wire.speechActivity(true)],
  ])("%s", (_name, message) => {
    validate(message, `${message.type}.json`);
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
  ])("$type ($id)", (message) => {
    validate(message, `${message.type}.json`);
    expect(wire.parse(message).message?.type).toBe(message.type);
  });
});
