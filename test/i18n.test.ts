import { FluentResource } from "@fluent/bundle";
import { describe, expect, it } from "vitest";
import { LOCALES, Messages, negotiateLocale } from "../src/index.js";
import { en, fr } from "../src/locales.js";

const ARGS = {
  code: "042137",
  digits: "0, 4, 2, 1, 3, 7",
  reason: "used",
  seconds: 3,
  error: "HTTP 503",
  version: "0.6.0",
};

const catalogues = { en, fr };

function ids(locale: (typeof LOCALES)[number]): string[] {
  return new FluentResource(catalogues[locale]).body.map((entry) => entry.id).sort();
}

describe("the catalogues", () => {
  it("have every message in every language", () => {
    for (const locale of LOCALES) expect(ids(locale), locale).toEqual(ids("en"));
  });

  it("format every message with its arguments, with no em-dash nor placeholder left", () => {
    for (const locale of LOCALES) {
      const messages = new Messages(locale);
      for (const id of ids(locale)) {
        const text = messages.format(id as never, ARGS);
        expect(text, `${locale} ${id}`).not.toMatch(/[—{}]|\$/);
        expect(text.length, `${locale} ${id}`).toBeGreaterThan(5);
      }
    }
  });
});

describe("the language", () => {
  it.each([
    [["fr-FR"], "fr"],
    [["fr_FR.UTF-8"], "fr"],
    [["de-DE", "fr"], "fr"],
    [["en-GB"], "en"],
    [["de"], "en"],
    [[], "en"],
  ])("from %j is %s", (requested, locale) => {
    expect(negotiateLocale(requested)).toBe(locale);
  });

  it("is the one asked for, else the platform's", () => {
    expect(new Messages("fr").locale).toBe("fr");
    expect(new Messages(["es", "fr-CA"]).locale).toBe("fr");
    expect(LOCALES).toContain(new Messages().locale);
  });

  it("changes the words, not the facts", () => {
    expect(new Messages("en").format("enrollment-refused", { reason: "expired", code: "K7QF-2M9X" })).toBe(
      "The enrollment code K7QF-2M9X has expired.",
    );
    expect(new Messages("fr").format("enrollment-refused", { reason: "expired", code: "K7QF-2M9X" })).toBe(
      "Le code d'enrôlement K7QF-2M9X a expiré.",
    );
  });
});
