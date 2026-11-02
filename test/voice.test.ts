/**
 * The device code said with the bundled voice: which clips, in which order, in real time, cut when
 * asked.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LOCALES, Messages } from "../src/index.js";
import { AHEAD_MS, announcement, decodeWav, SpokenCode, type Step, type VoiceIndex } from "../src/voice/index.js";
import { FakeClock, RecordingSpeaker } from "./support/voice.js";

const COPY = new URL("../voice/", import.meta.url);
const INDEX = JSON.parse(readFileSync(new URL("index.json", COPY), "utf8")) as VoiceIndex;

const clip = (text: string): Step => ({ clip: text });
const pause = (pauseMs: number): Step => ({ pauseMs });
const digits = (code: string, last: number) =>
  [...code].flatMap((digit, i) => [clip(digit), pause(i === code.length - 1 ? last : 350)]);

describe("the sentence, as clips", () => {
  it("says the code twice in English, with a pause after each piece of text and each digit", () => {
    expect(announcement(new Messages("en"), "042137", INDEX)).toEqual([
      clip("Pairing code"),
      pause(250),
      ...digits("042137", 800),
      clip("I repeat"),
      pause(250),
      ...digits("042137", 350).slice(0, -1),
    ]);
  });

  it("says it in French with the French clips", () => {
    const steps = announcement(new Messages("fr-FR"), "905318", INDEX);
    expect(steps.filter((step) => "clip" in step)).toEqual(
      ["Code d'appairage", ..."905318", "Je répète", ..."905318"].map(clip),
    );
  });

  it("has a clip for every piece of every language's sentence", () => {
    for (const locale of LOCALES) {
      const clips = INDEX.languages[locale] ?? {};
      for (const step of announcement(new Messages(locale), "0123456789", INDEX)) {
        if ("clip" in step) expect(clips[step.clip], `${locale}: ${step.clip}`).toBeDefined();
      }
    }
  });

  it("falls back to English for a language without clips", () => {
    const { fr: _, ...languages } = INDEX.languages;
    const steps = announcement(new Messages("fr"), "042137", { ...INDEX, languages });
    expect(steps[0]).toEqual(clip("Pairing code"));
  });
});

describe("the clips", () => {
  it("are 16 kHz mono PCM, each saying something", () => {
    for (const language of Object.values(INDEX.languages)) {
      for (const path of Object.values(language)) {
        const wav = decodeWav(readFileSync(new URL(path, COPY)));
        expect(wav.sampleRate, path).toBe(INDEX.sample_rate);
        expect(wav.samples.length, path).toBeGreaterThan(INDEX.sample_rate / 10);
        expect(Math.max(...wav.samples.map(Math.abs)), path).toBeGreaterThan(1000);
      }
    }
  });

  it("refuse what is not a WAV", () => {
    expect(() => decodeWav(new TextEncoder().encode("not a clip at all"))).toThrow(/WAV/);
  });
});

describe("the bundled voice", () => {
  /** The audio a code should make: the clips and silences of its announcement, at `rate`. */
  function expected(code: string, locale: string, rate: number): number {
    const clips = INDEX.languages[locale] ?? {};
    return announcement(new Messages(locale), code, INDEX).reduce((total, step) => {
      if ("pauseMs" in step) return total + Math.round((rate * step.pauseMs) / 1000);
      const { samples } = decodeWav(readFileSync(new URL(clips[step.clip] ?? "", COPY)));
      return total + Math.round((samples.length * rate) / INDEX.sample_rate);
    }, 0);
  }

  it("plays every clip and pause in real time, never more than 100 ms ahead of the clock", async () => {
    const clock = new FakeClock();
    const speaker = new RecordingSpeaker(48_000, clock);
    const voice = new SpokenCode(speaker, new Messages("fr"), { clock });
    voice.say("042137");
    expect(voice.speaking).toBe(true);
    await voice.finished();
    expect(voice.speaking).toBe(false);
    expect(speaker.samples).toBe(expected("042137", "fr", 48_000));
    let played = 0;
    speaker.written.forEach((chunk, i) => {
      expect((played / 48_000) * 1000 - (speaker.times[i] ?? 0)).toBeLessThanOrEqual(AHEAD_MS);
      played += chunk.length;
    });
    // About ten seconds of speech for six digits said twice.
    expect(clock.time).toBeGreaterThan(8000);
  });

  it("says the same code the same way every time", async () => {
    const clock = new FakeClock();
    const once = new RecordingSpeaker(16_000, clock);
    const twice = new RecordingSpeaker(16_000, clock);
    for (const speaker of [once, twice]) {
      const voice = new SpokenCode(speaker, new Messages("en"), { clock });
      voice.say("905318");
      await voice.finished();
    }
    expect(twice.audio()).toEqual(once.audio());
  });

  it("stops at once when asked, and a new code replaces the one being said", async () => {
    const clock = new FakeClock();
    const speaker = new RecordingSpeaker(16_000, clock);
    const voice = new SpokenCode(speaker, new Messages("en"), { clock });
    voice.say("111111");
    await vi.waitUntil(() => clock.time > 1000);
    voice.say("222222");
    expect(speaker.flushes).toBe(1);
    await vi.waitUntil(() => clock.time > 2000);
    voice.stop();
    expect(speaker.flushes).toBe(2);
    const written = speaker.samples;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(speaker.samples).toBe(written);
    expect(voice.speaking).toBe(false);
    expect(written).toBeLessThan(expected("111111", "en", 16_000));
  });

  it("logs a clip it cannot load, and says nothing", async () => {
    const warn = vi.fn();
    const missing = async () => {
      throw new Error("ENOENT");
    };
    const speaker = new RecordingSpeaker(16_000, undefined, missing);
    const voice = new SpokenCode(speaker, new Messages("en"), { logger: { debug() {}, info() {}, warn } });
    voice.say("042137");
    await voice.finished();
    expect(speaker.samples).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
  });
});
