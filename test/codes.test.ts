import { describe, expect, it } from "vitest";
import {
  groupEnrollmentCode,
  normalizeEnrollmentCode,
  ProtocolError,
  parsePairingUri,
  readEnrollment,
} from "../src/index.js";

describe("an enrollment code", () => {
  it.each([
    ["K7QF2M9X", "K7QF2M9X"],
    ["k7qf-2m9x", "K7QF2M9X"],
    [" K7QF 2M9X ", "K7QF2M9X"],
    ["oiL0-1234", "01101234"],
  ])("reads %j as %s, forgiving case, dashes, spaces and look-alike letters", (typed, canonical) => {
    expect(normalizeEnrollmentCode(typed)).toBe(canonical);
  });

  it.each(["K7QF2M9", "K7QF2M9XY", "K7QF2M9U", "K7QF_2M9X", ""])("refuses %j", (typed) => {
    expect(normalizeEnrollmentCode(typed)).toBeNull();
  });

  it("is shown grouped by four", () => {
    expect(groupEnrollmentCode("K7QF2M9X")).toBe("K7QF-2M9X");
  });
});

describe("a pairing URI", () => {
  it.each([
    ["nestor+http://nestor.local:7860/?code=K7QF2M9X", "http://nestor.local:7860"],
    [
      "nestor+https://nestor.example.org/satellites-proxy/?code=k7qf-2m9x",
      "https://nestor.example.org/satellites-proxy",
    ],
    ["NESTOR+HTTP://127.0.0.1:7860?code=K7QF2M9X", "http://127.0.0.1:7860"],
  ])("%s gives the core's base URL and the code", (uri, core) => {
    expect(parsePairingUri(uri)).toEqual({ core, code: "K7QF2M9X" });
  });

  it.each([
    "http://nestor.local:7860/?code=K7QF2M9X",
    "nestor+ftp://nestor.local/?code=K7QF2M9X",
    "nestor+http://nestor.local:7860/",
    "nestor+http://nestor.local:7860/?code=K7QF2M9X&code=K7QF2M9X",
    "nestor+http://nestor.local:7860/?code=nope",
    "nestor+http:///?code=K7QF2M9X",
  ])("refuses %s", (uri) => {
    expect(() => parsePairingUri(uri)).toThrow(ProtocolError);
  });

  it("or a bare code: what a person hands a device", () => {
    expect(readEnrollment("nestor+http://c:1/?code=K7QF2M9X")).toEqual({ core: "http://c:1", code: "K7QF2M9X" });
    expect(readEnrollment("k7qf-2m9x")).toEqual({ core: null, code: "K7QF2M9X" });
    expect(readEnrollment("nestor+http://c:1/")).toBeNull();
    expect(readEnrollment("hello")).toBeNull();
  });
});
