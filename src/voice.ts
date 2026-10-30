/**
 * The device code said aloud by the SDK itself (`device_code.speech`), offline: short recorded clips
 * played one after another through the device's speaker.
 *
 * The sentence is the catalogue's `device-code-speech`. Formatted with a placeholder for the digits,
 * it splits into pieces of text and digit slots; each piece of text, and each digit, has a clip in
 * the package's `voice/` folder, listed with the pauses in `voice/index.json`. The Python and Rust
 * SDKs ship the same clips (recorded by nestor-satellite-python's `scripts/voice.py`) and read them
 * the same way. A language without clips is said in English.
 *
 * The clips reach the speaker through the `Speaker` port: `nodeWebRtc` writes them to its
 * `AudioSink`, `browserWebRtc` plays them with Web Audio.
 */

import { Messages } from "./i18n.js";
import { describe, type Logger, quietLogger } from "./log.js";

/** Where the SDK plays what it says itself: the device's speaker, and the bundled clips. */
export interface Speaker {
  /** The rate `write` takes, in Hz. */
  readonly sampleRate: number;
  /** A file of the package's `voice/` folder (`index.json`, `en/0.wav`…), as bytes. */
  load(path: string): Promise<Uint8Array>;
  /** Play 16-bit mono PCM right after what was written before; returns at once. */
  write(pcm: Int16Array): void;
  /** Silence what was written and not heard yet, if the speaker can. */
  flush?(): void;
}

/** `voice/index.json`: the clips of each language, by the text they say, and the pauses. */
export interface VoiceIndex {
  readonly sample_rate: number;
  readonly pauses_ms: { readonly after_text: number; readonly between_digits: number; readonly after_digits: number };
  readonly languages: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** A clip of the index (a digit, or a piece of the sentence), or silence. */
export type Step = { readonly clip: string } | { readonly pauseMs: number };

const MESSAGE = "device-code-speech";
/** Where the digits go, when the sentence is cut into clips. */
const SLOT = "\u0000";
/** Around a piece of text: punctuation and Fluent's isolation marks. */
const STRIP = ".,;:!?…⁨⁩";
/** How much audio the speaker holds ahead of real time: a stop is heard at once. */
export const AHEAD_MS = 100;
const CHUNK_MS = 20;

/** A piece of the sentence as the index names its clip: without the spaces and punctuation around it. */
export function clipKey(text: string): string {
  let key = text.trim();
  let start = 0;
  let end = key.length;
  while (start < end && STRIP.includes(key.charAt(start))) start++;
  while (end > start && STRIP.includes(key.charAt(end - 1))) end--;
  key = key.slice(start, end);
  return key.trim();
}

/** The messages the code is said in: these when the index has their language, else English. */
export function voiceMessages(messages: Messages, index: VoiceIndex): Messages {
  return messages.locale in index.languages ? messages : new Messages("en");
}

/** What to play to say `code` in the messages' language: clips (keys of the index) and the pauses between them. */
export function announcement(messages: Messages, code: string, index: VoiceIndex): Step[] {
  const pauses = index.pauses_ms;
  const steps: Step[] = [];
  const parts = voiceMessages(messages, index).format(MESSAGE, { digits: SLOT }).split(SLOT);
  parts.forEach((part, position) => {
    const key = clipKey(part);
    if (key !== "") steps.push({ clip: key }, { pauseMs: pauses.after_text });
    if (position < parts.length - 1) {
      for (const digit of code) steps.push({ clip: digit }, { pauseMs: pauses.between_digits });
      steps[steps.length - 1] = { pauseMs: pauses.after_digits };
    }
  });
  while (steps.length > 0 && "pauseMs" in (steps[steps.length - 1] as Step)) steps.pop();
  return steps;
}

/** A WAV file's 16-bit mono PCM; throws on anything else. */
export function decodeWav(bytes: Uint8Array): { readonly sampleRate: number; readonly samples: Int16Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let format: { channels: number; rate: number; bits: number; encoding: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag(at) === "fmt " && size >= 16) {
      format = {
        encoding: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (tag(at) === "data") {
      if (format === null) throw new Error("a WAV file without its format");
      if (format.encoding !== 1 || format.channels !== 1 || format.bits !== 16) {
        throw new Error("a clip must be 16-bit mono PCM");
      }
      const length = Math.floor(Math.min(size, bytes.length - body) / 2);
      const samples = new Int16Array(length);
      for (let i = 0; i < length; i++) samples[i] = view.getInt16(body + i * 2, true);
      return { sampleRate: format.rate, samples };
    }
    at = body + size + (size % 2); // chunks are padded to an even size
  }
  throw new Error("a WAV file without audio");
}

/** `samples` at `from` Hz, resampled linearly to `to` Hz. */
export function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples;
  const out = new Int16Array(Math.round((samples.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const at = i * step;
    const left = Math.floor(at);
    const a = samples[left] ?? 0;
    const b = samples[left + 1] ?? a;
    out[i] = Math.round(a + (b - a) * (at - left));
  }
  return out;
}

/** Time, for pacing; tests pass a fake one. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", aborted);
        resolve();
      }, ms);
      const aborted = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", aborted, { once: true });
    }),
};

export interface SpokenCodeOptions {
  readonly logger?: Logger;
  readonly clock?: Clock;
}

/**
 * Says a device code through a `Speaker`, in real time, in the background: at most `AHEAD_MS` of
 * audio waits in the speaker, so a new code or `stop` cuts it at once.
 */
export class SpokenCode {
  private readonly logger: Logger;
  private readonly clock: Clock;
  private index: Promise<VoiceIndex> | null = null;
  private readonly clips = new Map<string, Promise<Int16Array>>();
  private current: { readonly stop: AbortController; readonly done: Promise<void> } | null = null;

  constructor(
    readonly speaker: Speaker,
    readonly messages: Messages,
    options: SpokenCodeOptions = {},
  ) {
    this.logger = options.logger ?? quietLogger;
    this.clock = options.clock ?? realClock;
  }

  /** Whether a code is being said. */
  get speaking(): boolean {
    return this.current !== null;
  }

  /** Say `code`, instead of the code being said. */
  say(code: string): void {
    this.stop();
    const stop = new AbortController();
    const done = this.play(code, stop.signal).then(
      () => {},
      (error: unknown) => {
        if (!stop.signal.aborted) this.logger.warn(`the device code could not be said: ${describe(error)}`);
      },
    );
    const current = { stop, done };
    this.current = current;
    void done.then(() => {
      if (this.current === current) this.current = null;
    });
  }

  /** Stop saying the code, at once. */
  stop(): void {
    const current = this.current;
    if (current === null) return;
    this.current = null;
    current.stop.abort();
    this.speaker.flush?.();
  }

  /** Resolves once the code has been said, or cut. */
  async finished(): Promise<void> {
    await this.current?.done;
  }

  private async play(code: string, signal: AbortSignal): Promise<void> {
    const index = await this.loadIndex();
    const clips = index.languages[voiceMessages(this.messages, index).locale] ?? {};
    const rate = this.speaker.sampleRate;
    const steps = await Promise.all(
      announcement(this.messages, code, index).map((step) => {
        if ("pauseMs" in step) return new Int16Array(Math.round((rate * step.pauseMs) / 1000));
        const path = clips[step.clip];
        if (path === undefined) throw new Error(`no clip says ${JSON.stringify(step.clip)}`);
        return this.clip(path);
      }),
    );
    signal.throwIfAborted();
    const chunk = Math.round((rate * CHUNK_MS) / 1000);
    const started = this.clock.now();
    let played = 0;
    for (const pcm of steps) {
      for (let start = 0; start < pcm.length; start += chunk) {
        const ahead = started + (played / rate) * 1000 - this.clock.now();
        if (ahead > AHEAD_MS) await this.clock.sleep(ahead - AHEAD_MS, signal);
        signal.throwIfAborted();
        const piece = pcm.subarray(start, start + chunk);
        this.speaker.write(piece);
        played += piece.length;
      }
    }
  }

  private loadIndex(): Promise<VoiceIndex> {
    this.index ??= this.speaker.load("index.json").then((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
    this.index.catch(() => {
      this.index = null; // try again with the next code
    });
    return this.index;
  }

  private clip(path: string): Promise<Int16Array> {
    let clip = this.clips.get(path);
    if (clip === undefined) {
      clip = this.speaker.load(path).then((bytes) => {
        const { sampleRate, samples } = decodeWav(bytes);
        return resample(samples, sampleRate, this.speaker.sampleRate);
      });
      clip.catch(() => this.clips.delete(path));
      this.clips.set(path, clip);
    }
    return clip;
  }
}
