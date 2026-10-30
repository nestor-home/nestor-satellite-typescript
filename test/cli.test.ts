import { describe, expect, it, vi } from "vitest";
import {
  type Arguments,
  build,
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  defaultId,
  main,
  parse,
  UsageError,
} from "../src/node/cli.js";
import { languagesFromEnv, provisioningFromEnv } from "../src/node/index.js";

const NO_ENV = {};
const URI = "nestor+http://nestor.local:7860/?code=K7QF2M9X";
const quiet = { debug() {}, info() {}, warn() {} };

describe("nestor-satellite run", () => {
  it("needs a core and a room, and fills in the rest", () => {
    const args = parse(["run", "--core", "http://nestor.local:7860", "--room", "salon"], NO_ENV);
    expect(args).toMatchObject({
      core: "http://nestor.local:7860",
      room: "salon",
      id: defaultId(),
      model: "node-satellite",
      input: DEFAULT_INPUT,
      output: DEFAULT_OUTPUT,
      ice: [],
      enrollment: undefined,
      locale: [],
      verbose: false,
    });
    expect(args).toHaveProperty("tokenFile", `~/.config/nestor-satellite/${defaultId()}.json`);
  });

  it("takes the device, audio commands and ICE servers it is given", () => {
    const argv = ["run", "--core", "http://c", "--room", "cuisine", "--id", "radio", "--brand", "acme"];
    const args = parse(
      [...argv, "--input", "none", "--output", "aplay -", "--ice", "stun:a", "--ice", "stun:b", "-v"],
      NO_ENV,
    );
    expect(args).toMatchObject({
      id: "radio",
      brand: "acme",
      input: "none",
      output: "aplay -",
      ice: ["stun:a", "stun:b"],
    });
    expect(args).toHaveProperty("tokenFile", "~/.config/nestor-satellite/radio.json");
  });

  it("refuses a wrong command line", () => {
    expect(() => parse(["run", "--core", "http://c"], NO_ENV)).toThrow(UsageError);
    expect(() => parse(["run", "--room", "salon"], NO_ENV)).toThrow(/--core is required/);
    expect(() => parse(["start", "--core", "http://c", "--room", "salon"], NO_ENV)).toThrow(UsageError);
    expect(() => parse(["run", "--colour", "blue"], NO_ENV)).toThrow();
  });

  it("derives a valid device id from the host name", () => {
    expect(defaultId()).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  });

  it("declares a microphone and a speaker, and refuses an invalid room before running", () => {
    const satellite = build(
      parse(["run", "--core", "http://c/", "--room", "salon", "--input", "none"], NO_ENV) as never,
      quiet,
    );
    expect([...satellite.manifest.names]).toEqual(["audio.capture", "audio.playback"]);
    // A speaker and no screen: the device code is said with the bundled voice.
    expect(satellite.manifest.pairingMethods).toEqual(["device_code.speech", "enrollment.provisioning"]);
    expect(satellite.core).toBe("http://c");
    expect(() => build(parse(["run", "--core", "http://c", "--room", "Le Salon"], NO_ENV) as never, quiet)).toThrow(
      /room/,
    );
  });

  it("answers help and version, and exits 2 on misuse", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--help"])).toBe(0);
    expect(await main(["--version"])).toBe(0);
    expect(await main(["run"])).toBe(2);
    expect(await main(["run", "--core", "http://c", "--room", "Le Salon"])).toBe(2);
    expect(log).toHaveBeenCalledWith("0.0.1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--room is required"));
    log.mockRestore();
    error.mockRestore();
  });
});

describe("pairing from the command line or the environment", () => {
  const run = (argv: string[], env: Record<string, string> = {}) =>
    parse(["run", "--room", "salon", ...argv], env) as Arguments;

  it("takes the core and the enrollment code from a pairing URI", () => {
    expect(run(["--pairing-uri", URI])).toMatchObject({ core: "http://nestor.local:7860", enrollment: "K7QF2M9X" });
    expect(run([], { NESTOR_PAIRING_URI: URI })).toMatchObject({
      core: "http://nestor.local:7860",
      enrollment: "K7QF2M9X",
    });
  });

  it("takes an enrollment code with the core given apart", () => {
    expect(run(["--core", "http://c", "--pairing-code", "k7qf-2m9x"])).toMatchObject({
      core: "http://c",
      enrollment: "K7QF2M9X",
    });
    expect(run(["--core", "http://c"], { NESTOR_PAIRING_CODE: "K7QF 2M9X" })).toMatchObject({ enrollment: "K7QF2M9X" });
    expect(() => run(["--pairing-code", "K7QF2M9X"])).toThrow(/--core is required/);
  });

  it("prefers a flag to the environment, and the explicit core to the URI's", () => {
    const env = { NESTOR_PAIRING_URI: "nestor+http://other:1/?code=AAAAAAAA" };
    expect(run(["--pairing-uri", URI], env)).toMatchObject({ enrollment: "K7QF2M9X" });
    expect(run(["--core", "http://proxy", "--pairing-uri", URI])).toMatchObject({ core: "http://proxy" });
  });

  it("refuses a malformed code or URI, or both at once", () => {
    expect(() => run(["--pairing-uri", "http://nestor.local/?code=K7QF2M9X"])).toThrow(UsageError);
    expect(() => run(["--core", "http://c", "--pairing-code", "K7QF"])).toThrow(/K7QF-2M9X/);
    expect(() => run([], { NESTOR_PAIRING_URI: URI, NESTOR_PAIRING_CODE: "K7QF2M9X" })).toThrow(/not both/);
  });

  it("sends the configured code with its first request", () => {
    const satellite = build(run(["--pairing-uri", URI, "--input", "none", "--output", "none"]), quiet);
    expect(satellite.core).toBe("http://nestor.local:7860");
    // No speaker: nothing to say the device code with, should the enrollment code be refused.
    expect(satellite.manifest.pairingMethods).toEqual(["enrollment.provisioning"]);
  });

  it("reads the same variables for drivers of its own", () => {
    expect(provisioningFromEnv({ NESTOR_PAIRING_URI: URI })).toEqual({
      core: "http://nestor.local:7860",
      enrollment: "K7QF2M9X",
    });
    expect(provisioningFromEnv({ NESTOR_PAIRING_URI: "" })).toBeNull();
  });
});

describe("the language", () => {
  it("comes from --locale, else LC_ALL, LC_MESSAGES and LANG", () => {
    expect(parse(["run", "--core", "http://c", "--room", "salon", "--locale", "fr"], NO_ENV)).toMatchObject({
      locale: ["fr"],
    });
    expect(languagesFromEnv({ LANG: "fr_FR.UTF-8", LC_ALL: "C" })).toEqual(["fr_FR.UTF-8"]);
    const satellite = build(
      parse(["run", "--core", "http://c", "--room", "salon", "--input", "none"], { LANG: "fr_FR.UTF-8" }) as never,
      quiet,
    );
    expect(satellite.messages.locale).toBe("fr");
  });
});
