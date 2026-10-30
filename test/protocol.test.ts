import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUDIO_CAPTURE,
  AUDIO_PLAYBACK,
  capability,
  Device,
  Manifest,
  PERSON_DETECTION,
  ProtocolError,
  SDK_NAME,
  SDK_VERSION,
} from "../src/index.js";

const SALON = { id: "enceinte-salon", model: "raspberry-pi-4", room: "salon" };

describe("a manifest", () => {
  it("says what the device is, what it can do and which SDK it runs", () => {
    const manifest = new Manifest({ ...SALON, brand: "raspberry" }, [
      capability(AUDIO_CAPTURE, { formats: ["opus/48000"] }),
      AUDIO_PLAYBACK,
    ]);
    expect(manifest.toJSON()).toEqual({
      protocol: "nestor.satellite/2",
      device: { id: "enceinte-salon", model: "raspberry-pi-4", room: "salon", brand: "raspberry" },
      capabilities: [{ name: "audio.capture", formats: ["opus/48000"] }, { name: "audio.playback" }],
      pairing_methods: ["enrollment.provisioning"],
      sdk: { name: "@nestor-home/satellite", version: SDK_VERSION },
    });
  });

  it("leaves out the optional brand and, when asked, the SDK", () => {
    const json = new Manifest(SALON, [], { sdk: null }).toJSON();
    expect(json.device).toEqual(SALON);
    expect("sdk" in json).toBe(false);
  });

  it("knows the capabilities it declares", () => {
    const manifest = Manifest.of(SALON, AUDIO_CAPTURE, PERSON_DETECTION);
    expect(manifest.has(PERSON_DETECTION)).toBe(true);
    expect(manifest.has(AUDIO_PLAYBACK)).toBe(false);
    expect([...manifest.names]).toEqual([AUDIO_CAPTURE, PERSON_DETECTION]);
  });

  it.each([
    [{ ...SALON, id: "Salon Speaker" }, /id/],
    [{ ...SALON, room: "" }, /room/],
    [{ ...SALON, model: "" }, /model/],
    [{ ...SALON, model: "x".repeat(65) }, /model/],
    [{ ...SALON, brand: "Pollen Robotics" }, /brand/],
  ])("refuses a device that would not pass the core's checks (%o)", (device, error) => {
    expect(() => new Device(device)).toThrow(error);
  });

  it("refuses an invalid, duplicated or excessive capability list", () => {
    expect(() => capability("microphone")).toThrow(ProtocolError);
    expect(() => capability(AUDIO_CAPTURE, { name: "other" })).toThrow(ProtocolError);
    expect(() => Manifest.of(SALON, AUDIO_CAPTURE, AUDIO_CAPTURE)).toThrow(/twice/);
    const many = Array.from({ length: 33 }, (_, i) => `family.feature_${i}`);
    expect(() => Manifest.of(SALON, ...many)).toThrow(/at most 32/);
    expect(() => new Manifest(SALON, [], { sdk: { name: "", version: "1" } })).toThrow(/sdk/);
  });
});

describe("pairing methods", () => {
  it("are listed in the manifest, configuration alone by default", () => {
    const manifest = Manifest.of(SALON).withPairingMethods(["device_code.speech", "enrollment.provisioning"]);
    expect(manifest.toJSON().pairing_methods).toEqual(["device_code.speech", "enrollment.provisioning"]);
    expect(Manifest.of(SALON).pairingMethods).toEqual(["enrollment.provisioning"]);
  });

  it("are at least one, each once, all known", () => {
    expect(() => new Manifest(SALON, [], { pairingMethods: [] })).toThrow(ProtocolError);
    expect(() => Manifest.of(SALON).withPairingMethods(["enrollment.qr", "enrollment.qr"])).toThrow(ProtocolError);
    expect(() => Manifest.of(SALON).withPairingMethods(["telepathy" as never])).toThrow(/telepathy/);
  });
});

it("names itself with the package's name and version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, string>;
  expect([SDK_NAME, SDK_VERSION]).toEqual([pkg.name, pkg.version]);
});
