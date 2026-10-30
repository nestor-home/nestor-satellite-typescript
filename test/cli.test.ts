import { describe, expect, it, vi } from "vitest";
import { build, DEFAULT_INPUT, DEFAULT_OUTPUT, defaultId, main, parse, UsageError } from "../src/node/cli.js";

describe("nestor-satellite run", () => {
  it("needs a core and a room, and fills in the rest", () => {
    const args = parse(["run", "--core", "http://nestor.local:7860", "--room", "salon"]);
    expect(args).toMatchObject({
      core: "http://nestor.local:7860",
      room: "salon",
      id: defaultId(),
      model: "node-satellite",
      input: DEFAULT_INPUT,
      output: DEFAULT_OUTPUT,
      ice: [],
      verbose: false,
    });
    expect(args).toHaveProperty("tokenFile", `~/.config/nestor-satellite/${defaultId()}.json`);
  });

  it("takes the device, audio commands and ICE servers it is given", () => {
    const argv = ["run", "--core", "http://c", "--room", "cuisine", "--id", "radio", "--brand", "acme"];
    const args = parse([...argv, "--input", "none", "--output", "aplay -", "--ice", "stun:a", "--ice", "stun:b", "-v"]);
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
    expect(() => parse(["run", "--core", "http://c"])).toThrow(UsageError);
    expect(() => parse(["start", "--core", "http://c", "--room", "salon"])).toThrow(UsageError);
    expect(() => parse(["run", "--colour", "blue"])).toThrow();
  });

  it("derives a valid device id from the host name", () => {
    expect(defaultId()).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  });

  it("declares a microphone and a speaker, and refuses an invalid room before running", () => {
    const quiet = { debug() {}, info() {}, warn() {} };
    const satellite = build(
      parse(["run", "--core", "http://c/", "--room", "salon", "--input", "none"]) as never,
      quiet,
    );
    expect([...satellite.manifest.names]).toEqual(["audio.capture", "audio.playback"]);
    expect(satellite.core).toBe("http://c");
    expect(() => build(parse(["run", "--core", "http://c", "--room", "Le Salon"]) as never, quiet)).toThrow(/room/);
  });

  it("answers help and version, and exits 2 on misuse", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--help"])).toBe(0);
    expect(await main(["--version"])).toBe(0);
    expect(await main(["run"])).toBe(2);
    expect(await main(["run", "--core", "http://c", "--room", "Le Salon"])).toBe(2);
    expect(log).toHaveBeenCalledWith("0.0.1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--core and --room are required"));
    log.mockRestore();
    error.mockRestore();
  });
});
